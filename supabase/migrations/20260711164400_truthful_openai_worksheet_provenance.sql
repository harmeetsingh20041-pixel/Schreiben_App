-- Truthful optional OpenAI worksheet provenance.
--
-- The legacy public completion function intentionally remains the single
-- transactional implementation for job completion, question insertion, and
-- queue archival. The api adapter validates exact provider/model provenance,
-- transforms only a local copy into the legacy DeepSeek envelope, calls that
-- implementation, then restores the actual source and original diagnostics in
-- the same transaction. Any failure rolls the entire completion back.

alter table public.practice_tests
drop constraint if exists practice_tests_generation_source_check;

alter table public.practice_tests
add constraint practice_tests_generation_source_check
check (generation_source in (
  'manual',
  'manual_import',
  'teacher_created',
  'deepseek',
  'openai',
  'fixture',
  'system_fallback'
)) not valid;

alter table public.practice_tests
validate constraint practice_tests_generation_source_check;

-- Keep completion fingerprints private. A succeeded delivery is accepted only
-- when both the original canonical provider payload and the currently persisted
-- educational content still match the first committed completion exactly.
create table if not exists app_private.worksheet_generation_completions (
  job_id uuid primary key,
  practice_test_id uuid not null,
  completion_mode text not null
    check (completion_mode in ('generated', 'reuse')),
  provider_source text
    check (provider_source is null or provider_source in ('deepseek', 'openai')),
  generator_model text,
  critic_model text,
  provider_metadata jsonb
    check (
      provider_metadata is null
      or jsonb_typeof(provider_metadata) = 'object'
    ),
  payload_sha256 text not null
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text not null
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null default now(),
  constraint worksheet_generation_completions_provider_shape_check check (
    (
      completion_mode = 'generated'
      and provider_source is not null
      and generator_model is not null
      and critic_model is not null
      and provider_metadata is not null
    )
    or (
      completion_mode = 'reuse'
      and provider_source is null
      and generator_model is null
      and critic_model is null
      and provider_metadata is null
    )
  )
);

alter table app_private.worksheet_generation_completions
drop constraint if exists worksheet_generation_completions_job_id_fkey,
drop constraint if exists worksheet_generation_completions_practice_test_id_fkey,
drop constraint if exists worksheet_generation_completions_practice_test_id_key;

alter table app_private.worksheet_generation_completions
add constraint worksheet_generation_completions_job_id_fkey
foreign key (job_id) references app_private.async_jobs(id) on delete restrict,
add constraint worksheet_generation_completions_practice_test_id_fkey
foreign key (practice_test_id) references public.practice_tests(id) on delete restrict;

alter table app_private.worksheet_generation_completions enable row level security;

revoke all on table app_private.worksheet_generation_completions
from public, anon, authenticated, service_role;

create or replace function app_private.reject_worksheet_generation_completion_mutation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'Worksheet generation completion evidence is immutable.';
end;
$function$;

revoke all on function app_private.reject_worksheet_generation_completion_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists worksheet_generation_completions_immutable
on app_private.worksheet_generation_completions;
create trigger worksheet_generation_completions_immutable
before update or delete on app_private.worksheet_generation_completions
for each row execute function
  app_private.reject_worksheet_generation_completion_mutation();

create or replace function app_private.worksheet_generation_payload_sha256(
  worksheet jsonb
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(worksheet::text, 'UTF8')
    ),
    'hex'
  );
$function$;

revoke all on function app_private.worksheet_generation_payload_sha256(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.worksheet_generation_payload_sha256(jsonb)
to service_role;

create or replace function app_private.lock_worksheet_generation_completion(
  target_job_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  selected_status text;
begin
  perform app_private.assert_service_role();

  select job.status
  into selected_status
  from app_private.async_jobs as job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
  for update;

  if not found then
    raise exception using
      errcode = '02000',
      message = 'Worksheet generation job not found.';
  end if;

  return selected_status = 'succeeded';
end;
$function$;

revoke all on function app_private.lock_worksheet_generation_completion(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.lock_worksheet_generation_completion(uuid)
to service_role;

create or replace function app_private.assert_or_record_worksheet_generation_completion(
  target_job_id uuid,
  target_practice_test_id uuid,
  worksheet jsonb,
  completion_was_succeeded boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_completion_mode text;
  expected_provider_source text;
  expected_generator_model text;
  expected_critic_model text;
  expected_provider_metadata jsonb;
  expected_payload_sha256 text;
  current_content_sha256 text;
  persisted_generation_source text;
  persisted_generator_model text;
  persisted_generation_metadata jsonb;
  persisted_generation_job_id uuid;
  recorded app_private.worksheet_generation_completions%rowtype;
begin
  perform app_private.assert_service_role();

  expected_completion_mode := worksheet ->> 'mode';
  if worksheet is null
    or expected_completion_mode not in ('generated', 'reuse')
    or target_practice_test_id is null
    or completion_was_succeeded is null
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet completion fingerprint is invalid.';
  end if;

  if expected_completion_mode = 'generated' then
    expected_provider_source := worksheet ->> 'generation_source';
    expected_generator_model := worksheet ->> 'generator_model';
    expected_critic_model := worksheet #>> '{validation,critic_model}';
    expected_provider_metadata := pg_catalog.jsonb_build_object(
      'schema_version', 1,
      'source_mix', worksheet -> 'source_mix',
      'validation', worksheet -> 'validation'
    );
  end if;
  expected_payload_sha256 :=
    app_private.worksheet_generation_payload_sha256(worksheet);

  select
    test.generation_source,
    test.generator_model,
    test.generation_metadata,
    test.generation_job_id,
    app_private.practice_test_content_sha256(test.id)
  into
    persisted_generation_source,
    persisted_generator_model,
    persisted_generation_metadata,
    persisted_generation_job_id,
    current_content_sha256
  from public.practice_tests as test
  where test.id = target_practice_test_id
  for share;

  if not found
    or current_content_sha256 is null
    or (
      expected_completion_mode = 'generated'
      and (
        persisted_generation_job_id is distinct from target_job_id
        or persisted_generation_source is distinct from expected_provider_source
        or persisted_generator_model is distinct from expected_generator_model
        or persisted_generation_metadata is distinct from expected_provider_metadata
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion replay does not match persisted result.';
  end if;

  select completion.*
  into recorded
  from app_private.worksheet_generation_completions as completion
  where completion.job_id = target_job_id
  for update;

  if completion_was_succeeded then
    if recorded.job_id is null
      or recorded.practice_test_id is distinct from target_practice_test_id
      or recorded.completion_mode is distinct from expected_completion_mode
      or recorded.provider_source is distinct from expected_provider_source
      or recorded.generator_model is distinct from expected_generator_model
      or recorded.critic_model is distinct from expected_critic_model
      or recorded.provider_metadata is distinct from expected_provider_metadata
      or recorded.payload_sha256 is distinct from expected_payload_sha256
      or recorded.content_sha256 is distinct from current_content_sha256
    then
      raise exception using
        errcode = '55000',
        message = 'Worksheet completion replay does not match persisted result.';
    end if;

    return;
  end if;

  if recorded.job_id is not null then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion replay does not match persisted result.';
  end if;

  insert into app_private.worksheet_generation_completions (
    job_id,
    practice_test_id,
    completion_mode,
    provider_source,
    generator_model,
    critic_model,
    provider_metadata,
    payload_sha256,
    content_sha256
  ) values (
    target_job_id,
    target_practice_test_id,
    expected_completion_mode,
    expected_provider_source,
    expected_generator_model,
    expected_critic_model,
    expected_provider_metadata,
    expected_payload_sha256,
    current_content_sha256
  );
end;
$function$;

revoke all on function app_private.assert_or_record_worksheet_generation_completion(
  uuid, uuid, jsonb, boolean
)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_or_record_worksheet_generation_completion(
  uuid, uuid, jsonb, boolean
)
to service_role;

create or replace function app_private.normalize_worksheet_generation_provenance(
  worksheet jsonb
)
returns table (
  legacy_worksheet jsonb,
  provider_source text,
  provider_metadata jsonb
)
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  completion_mode text;
  source_name text;
  generator_model text;
  critic_model text;
  source_mix jsonb;
  validation_metadata jsonb;
  question_count integer;
  source_key_count integer;
begin
  if worksheet is null or jsonb_typeof(worksheet) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Worksheet completion payload is invalid.';
  end if;

  completion_mode := coalesce(worksheet ->> 'mode', '');
  if completion_mode <> 'generated' then
    return query select worksheet, null::text, null::jsonb;
    return;
  end if;

  if jsonb_typeof(worksheet -> 'questions') <> 'array'
    or jsonb_typeof(worksheet -> 'source_mix') <> 'object'
    or jsonb_typeof(worksheet -> 'validation') <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet provenance is invalid.';
  end if;

  source_name := coalesce(worksheet ->> 'generation_source', '');
  generator_model := coalesce(worksheet ->> 'generator_model', '');
  source_mix := worksheet -> 'source_mix';
  validation_metadata := worksheet -> 'validation';
  critic_model := coalesce(validation_metadata ->> 'critic_model', '');
  question_count := jsonb_array_length(worksheet -> 'questions');

  select count(*)
  into source_key_count
  from jsonb_object_keys(source_mix) source_key
  where source_key in ('mode', 'deepseek_count', 'fallback_count');

  if source_key_count <> 3
    or (select count(*) from jsonb_object_keys(source_mix)) <> 3
    or jsonb_typeof(source_mix -> 'deepseek_count') <> 'number'
    or jsonb_typeof(source_mix -> 'fallback_count') <> 'number'
    or coalesce(source_mix ->> 'deepseek_count', '') !~ '^(0|[1-9][0-9]*)$'
    or coalesce(source_mix ->> 'fallback_count', '') !~ '^(0|[1-9][0-9]*)$'
    or critic_model not in (
      'deepseek-v4-flash',
      'gpt-5.4-2026-03-05'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet provenance is invalid.';
  end if;

  if source_name = 'deepseek' then
    if generator_model <> 'deepseek-v4-pro'
      or source_mix ->> 'mode' <> 'deepseek'
      or (source_mix ->> 'deepseek_count')::integer <> question_count
      or (source_mix ->> 'fallback_count')::integer <> 0
    then
      raise exception using
        errcode = '22023',
        message = 'Generated worksheet provenance is invalid.';
    end if;

    return query
    select
      worksheet,
      source_name,
      jsonb_build_object(
        'schema_version', 1,
        'source_mix', source_mix,
        'validation', validation_metadata
      );
    return;
  end if;

  if source_name = 'openai' then
    if generator_model <> 'gpt-5.4-mini-2026-03-17'
      or source_mix ->> 'mode' <> 'openai'
      or (source_mix ->> 'deepseek_count')::integer <> 0
      or (source_mix ->> 'fallback_count')::integer <> question_count
    then
      raise exception using
        errcode = '22023',
        message = 'Generated worksheet provenance is invalid.';
    end if;

    return query
    select
      worksheet || jsonb_build_object(
        'generation_source', 'deepseek',
        'source_mix', jsonb_build_object(
          'mode', 'deepseek',
          'deepseek_count', question_count,
          'fallback_count', 0
        )
      ),
      source_name,
      jsonb_build_object(
        'schema_version', 1,
        'source_mix', source_mix,
        'validation', validation_metadata
      );
    return;
  end if;

  raise exception using
    errcode = '22023',
    message = 'Generated worksheet provenance is invalid.';
end;
$$;

revoke all on function app_private.normalize_worksheet_generation_provenance(jsonb)
from public, anon, authenticated;
grant execute on function app_private.normalize_worksheet_generation_provenance(jsonb)
to service_role;

create or replace function api.complete_worksheet_generation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized record;
  completed_assignment_id uuid;
  completed_practice_test_id uuid;
  completed_generation_status text;
  completed_quality_status text;
  completion_was_succeeded boolean := false;
begin
  select *
  into strict normalized
  from app_private.normalize_worksheet_generation_provenance(worksheet);

  completion_was_succeeded :=
    app_private.lock_worksheet_generation_completion(target_job_id);

  select
    result.assignment_id,
    result.practice_test_id,
    result.generation_status,
    result.quality_status
  into strict
    completed_assignment_id,
    completed_practice_test_id,
    completed_generation_status,
    completed_quality_status
  from public.complete_worksheet_generation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    normalized.legacy_worksheet
  ) result;

  if normalized.provider_source = 'openai' and not completion_was_succeeded then
    update public.practice_tests test
    set
      generation_source = 'openai',
      generator_model = worksheet ->> 'generator_model',
      generation_metadata = normalized.provider_metadata
    where test.id = completed_practice_test_id
      and test.generation_job_id = target_job_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'Generated worksheet provenance could not be persisted.';
    end if;
  end if;

  perform app_private.assert_or_record_worksheet_generation_completion(
    target_job_id,
    completed_practice_test_id,
    worksheet,
    completion_was_succeeded
  );

  return query
  select
    completed_assignment_id,
    completed_practice_test_id,
    completed_generation_status,
    completed_quality_status;
end;
$$;

revoke all on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated;
grant execute on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
to service_role;

comment on function app_private.normalize_worksheet_generation_provenance(jsonb)
is 'Validates pinned DeepSeek/OpenAI worksheet provenance and creates a transaction-local legacy completion envelope.';

comment on table app_private.worksheet_generation_completions
is 'Private canonical payload and persisted-content fingerprints for exact, read-only worksheet completion redelivery.';

comment on function app_private.reject_worksheet_generation_completion_mutation()
is 'Rejects updates and deletes so committed worksheet completion provenance evidence cannot be rewritten or cascaded away.';

comment on function app_private.worksheet_generation_payload_sha256(jsonb)
is 'Returns a database-computed SHA-256 digest of one canonical JSONB worksheet completion payload.';

comment on function app_private.lock_worksheet_generation_completion(uuid)
is 'Service-only transaction lock that reports whether a worksheet generation job was already completed.';

comment on function app_private.assert_or_record_worksheet_generation_completion(
  uuid, uuid, jsonb, boolean
)
is 'Records the first worksheet completion fingerprints or rejects any non-identical succeeded redelivery without mutation.';

comment on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
is 'Completes worksheet jobs transactionally while preserving truthful pinned provider and critic provenance.';
