-- Phase 12N: every newly generated worksheet is reviewed by both the pinned
-- DeepSeek Flash critic and the pinned OpenAI critic. The durable completion
-- boundary recomputes the exact candidate/verdict hashes before any generated
-- worksheet can become visible or be recorded as independently approved.

create or replace function app_private.canonical_jsonb_text(
  target_value jsonb
)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  canonical_text text;
begin
  case jsonb_typeof(target_value)
    when 'object' then
      select '{' || coalesce(
        string_agg(
          to_jsonb(entry.key)::text || ':' ||
            app_private.canonical_jsonb_text(entry.value),
          ',' order by entry.key collate "C"
        ),
        ''
      ) || '}'
      into canonical_text
      from jsonb_each(target_value) entry;
    when 'array' then
      select '[' || coalesce(
        string_agg(
          app_private.canonical_jsonb_text(entry.value),
          ',' order by entry.ordinality
        ),
        ''
      ) || ']'
      into canonical_text
      from jsonb_array_elements(target_value)
        with ordinality entry(value, ordinality);
    else
      canonical_text := target_value::text;
  end case;

  return canonical_text;
end;
$$;

revoke all on function app_private.canonical_jsonb_text(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.canonical_jsonb_text(jsonb)
to service_role;

create or replace function app_private.worksheet_candidate_sha256(
  worksheet jsonb
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select encode(
    sha256(
      convert_to(
        app_private.canonical_jsonb_text(worksheet - 'validation'),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function app_private.worksheet_candidate_sha256(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.worksheet_candidate_sha256(jsonb)
to service_role;

create or replace function app_private.worksheet_critic_verdict_sha256(
  critic jsonb
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select encode(
    sha256(
      convert_to(
        app_private.canonical_jsonb_text(critic - 'verdict_sha256'),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function app_private.worksheet_critic_verdict_sha256(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.worksheet_critic_verdict_sha256(jsonb)
to service_role;

create or replace function app_private.assert_worksheet_critic_verdict(
  critic jsonb,
  expected_provider text,
  expected_model text,
  expected_candidate_sha256 text
)
returns void
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  check_name text;
  all_checks_pass boolean := true;
  approved boolean;
begin
  if jsonb_typeof(critic) <> 'object'
    or not (critic ?& array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'rejection_reasons',
      'verdict_sha256'
    ])
    or critic - array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'rejection_reasons',
      'verdict_sha256'
    ]::text[] <> '{}'::jsonb
    or critic ->> 'provider' <> expected_provider
    or critic ->> 'model' <> expected_model
    or critic ->> 'candidate_sha256' <> expected_candidate_sha256
    or jsonb_typeof(critic -> 'approved') <> 'boolean'
    or jsonb_typeof(critic -> 'checks') <> 'object'
    or jsonb_typeof(critic -> 'rejection_reasons') <> 'array'
    or coalesce(critic ->> 'verdict_sha256', '') !~ '^[a-f0-9]{64}$'
    or critic ->> 'verdict_sha256' <>
      app_private.worksheet_critic_verdict_sha256(critic)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
  end if;

  if (select count(*) from jsonb_object_keys(critic -> 'checks')) <> 7
    or exists (
      select 1
      from jsonb_each(critic -> 'checks') check_entry(key, value)
      where check_entry.key not in (
        'ambiguity_free',
        'no_answer_leakage',
        'duplicate_free',
        'level_fit',
        'topic_fit',
        'type_balance',
        'scoring_safe'
      )
        or jsonb_typeof(check_entry.value) <> 'boolean'
    )
    or jsonb_array_length(critic -> 'rejection_reasons') > 4
    or exists (
      select 1
      from jsonb_array_elements(critic -> 'rejection_reasons') reason(value)
      where jsonb_typeof(reason.value) <> 'string'
        or length(btrim(reason.value #>> '{}')) not between 1 and 240
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
  end if;

  foreach check_name in array array[
    'ambiguity_free',
    'no_answer_leakage',
    'duplicate_free',
    'level_fit',
    'topic_fit',
    'type_balance',
    'scoring_safe'
  ]
  loop
    all_checks_pass := all_checks_pass and
      (critic #>> array['checks', check_name])::boolean;
  end loop;

  approved := (critic ->> 'approved')::boolean;
  if approved is distinct from all_checks_pass
    or (approved and jsonb_array_length(critic -> 'rejection_reasons') <> 0)
    or (
      not approved
      and jsonb_array_length(critic -> 'rejection_reasons') = 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_worksheet_critic_verdict(
  jsonb, text, text, text
)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_worksheet_critic_verdict(
  jsonb, text, text, text
)
to service_role;

create or replace function app_private.assert_dual_worksheet_critics(
  worksheet jsonb
)
returns void
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  validation_metadata jsonb := worksheet -> 'validation';
  critics jsonb;
  deepseek_critic jsonb;
  openai_critic jsonb;
  candidate_sha256 text;
  check_name text;
  expected_check boolean;
  expected_approved boolean;
begin
  if worksheet ->> 'mode' <> 'generated'
    or jsonb_typeof(validation_metadata) <> 'object'
    or not (validation_metadata ?& array[
      'deterministic',
      'independent_model',
      'critic_model',
      'candidate_sha256',
      'critics',
      'attempt_count',
      'checks',
      'rejection_reasons'
    ])
    or validation_metadata - array[
      'deterministic',
      'independent_model',
      'critic_model',
      'candidate_sha256',
      'critics',
      'attempt_count',
      'checks',
      'rejection_reasons'
    ]::text[] <> '{}'::jsonb
    or validation_metadata ->> 'deterministic' <> 'true'
    or jsonb_typeof(validation_metadata -> 'independent_model') <> 'boolean'
    or validation_metadata ->> 'critic_model' <> 'deepseek-v4-flash'
    or coalesce(validation_metadata ->> 'candidate_sha256', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(validation_metadata ->> 'attempt_count', '') not in ('1', '2')
    or jsonb_typeof(validation_metadata -> 'critics') <> 'object'
    or jsonb_typeof(validation_metadata -> 'checks') <> 'object'
    or jsonb_typeof(validation_metadata -> 'rejection_reasons') <> 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  candidate_sha256 := validation_metadata ->> 'candidate_sha256';
  if candidate_sha256 <>
    app_private.worksheet_candidate_sha256(worksheet)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_candidate_hash_mismatch';
  end if;

  critics := validation_metadata -> 'critics';
  if not (critics ?& array['deepseek', 'openai'])
    or critics - array['deepseek', 'openai']::text[] <> '{}'::jsonb
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  deepseek_critic := critics -> 'deepseek';
  openai_critic := critics -> 'openai';
  perform app_private.assert_worksheet_critic_verdict(
    deepseek_critic,
    'deepseek',
    'deepseek-v4-flash',
    candidate_sha256
  );
  perform app_private.assert_worksheet_critic_verdict(
    openai_critic,
    'openai',
    'gpt-5.4-2026-03-05',
    candidate_sha256
  );

  if (select count(*) from jsonb_object_keys(validation_metadata -> 'checks'))
      <> 7
    or exists (
      select 1
      from jsonb_each(validation_metadata -> 'checks') check_entry(key, value)
      where check_entry.key not in (
        'ambiguity_free',
        'no_answer_leakage',
        'duplicate_free',
        'level_fit',
        'topic_fit',
        'type_balance',
        'scoring_safe'
      )
        or jsonb_typeof(check_entry.value) <> 'boolean'
    )
    or validation_metadata -> 'rejection_reasons' is distinct from (
      (deepseek_critic -> 'rejection_reasons') ||
      (openai_critic -> 'rejection_reasons')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  foreach check_name in array array[
    'ambiguity_free',
    'no_answer_leakage',
    'duplicate_free',
    'level_fit',
    'topic_fit',
    'type_balance',
    'scoring_safe'
  ]
  loop
    expected_check :=
      (deepseek_critic #>> array['checks', check_name])::boolean and
      (openai_critic #>> array['checks', check_name])::boolean;
    if validation_metadata #> array['checks', check_name]
      is distinct from to_jsonb(expected_check)
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_dual_critic_validation_invalid';
    end if;
  end loop;

  expected_approved :=
    (deepseek_critic ->> 'approved')::boolean and
    (openai_critic ->> 'approved')::boolean;
  if (validation_metadata ->> 'independent_model')::boolean
      is distinct from expected_approved
    or (
      expected_approved
      and jsonb_array_length(validation_metadata -> 'rejection_reasons') <> 0
    )
    or (
      not expected_approved
      and jsonb_array_length(validation_metadata -> 'rejection_reasons') = 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_dual_worksheet_critics(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_dual_worksheet_critics(jsonb)
to service_role;

alter table app_private.worksheet_generation_completions
  add column if not exists dual_critic_version smallint not null default 0,
  add column if not exists candidate_sha256 text,
  add column if not exists deepseek_critic_model text,
  add column if not exists deepseek_verdict_sha256 text,
  add column if not exists openai_critic_model text,
  add column if not exists openai_verdict_sha256 text;

alter table app_private.worksheet_generation_completions
  drop constraint if exists worksheet_generation_completions_provider_shape_check,
  drop constraint if exists worksheet_generation_completions_dual_critic_check,
  add constraint worksheet_generation_completions_provider_shape_check check (
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
  ),
  add constraint worksheet_generation_completions_dual_critic_check check (
    (
      dual_critic_version = 0
      and candidate_sha256 is null
      and deepseek_critic_model is null
      and deepseek_verdict_sha256 is null
      and openai_critic_model is null
      and openai_verdict_sha256 is null
    )
    or (
      completion_mode = 'generated'
      and dual_critic_version = 1
      and candidate_sha256 ~ '^[a-f0-9]{64}$'
      and deepseek_critic_model = 'deepseek-v4-flash'
      and deepseek_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and openai_critic_model = 'gpt-5.4-2026-03-05'
      and openai_verdict_sha256 ~ '^[a-f0-9]{64}$'
    )
  );

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

  perform app_private.assert_dual_worksheet_critics(worksheet);

  source_name := coalesce(worksheet ->> 'generation_source', '');
  generator_model := coalesce(worksheet ->> 'generator_model', '');
  source_mix := worksheet -> 'source_mix';
  validation_metadata := worksheet -> 'validation';
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
as $$
declare
  expected_completion_mode text;
  expected_provider_source text;
  expected_generator_model text;
  expected_critic_model text;
  expected_provider_metadata jsonb;
  expected_payload_sha256 text;
  expected_dual_critic_version smallint := 0;
  expected_candidate_sha256 text;
  expected_deepseek_critic_model text;
  expected_deepseek_verdict_sha256 text;
  expected_openai_critic_model text;
  expected_openai_verdict_sha256 text;
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
    perform app_private.assert_dual_worksheet_critics(worksheet);
    expected_provider_source := worksheet ->> 'generation_source';
    expected_generator_model := worksheet ->> 'generator_model';
    expected_critic_model := worksheet #>> '{validation,critic_model}';
    expected_provider_metadata := jsonb_build_object(
      'schema_version', 1,
      'source_mix', worksheet -> 'source_mix',
      'validation', worksheet -> 'validation'
    );
    expected_dual_critic_version := 1;
    expected_candidate_sha256 := worksheet #>> '{validation,candidate_sha256}';
    expected_deepseek_critic_model :=
      worksheet #>> '{validation,critics,deepseek,model}';
    expected_deepseek_verdict_sha256 :=
      worksheet #>> '{validation,critics,deepseek,verdict_sha256}';
    expected_openai_critic_model :=
      worksheet #>> '{validation,critics,openai,model}';
    expected_openai_verdict_sha256 :=
      worksheet #>> '{validation,critics,openai,verdict_sha256}';
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
  from public.practice_tests test
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
  from app_private.worksheet_generation_completions completion
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
      or recorded.dual_critic_version is distinct from
        expected_dual_critic_version
      or recorded.candidate_sha256 is distinct from expected_candidate_sha256
      or recorded.deepseek_critic_model is distinct from
        expected_deepseek_critic_model
      or recorded.deepseek_verdict_sha256 is distinct from
        expected_deepseek_verdict_sha256
      or recorded.openai_critic_model is distinct from
        expected_openai_critic_model
      or recorded.openai_verdict_sha256 is distinct from
        expected_openai_verdict_sha256
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
    content_sha256,
    dual_critic_version,
    candidate_sha256,
    deepseek_critic_model,
    deepseek_verdict_sha256,
    openai_critic_model,
    openai_verdict_sha256
  ) values (
    target_job_id,
    target_practice_test_id,
    expected_completion_mode,
    expected_provider_source,
    expected_generator_model,
    expected_critic_model,
    expected_provider_metadata,
    expected_payload_sha256,
    current_content_sha256,
    expected_dual_critic_version,
    expected_candidate_sha256,
    expected_deepseek_critic_model,
    expected_deepseek_verdict_sha256,
    expected_openai_critic_model,
    expected_openai_verdict_sha256
  );
end;
$$;

revoke all on function app_private.assert_or_record_worksheet_generation_completion(
  uuid, uuid, jsonb, boolean
)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_or_record_worksheet_generation_completion(
  uuid, uuid, jsonb, boolean
)
to service_role;

-- The Phase 9A implementation remains the transactional insertion engine, but
-- it must never be a directly callable worker surface: doing so would bypass
-- the Phase 12E/12N provenance normalizer and immutable evidence ledger. The
-- only service-role entry point is the path-pinned gated adapter below, whose
-- owner invokes the legacy engine internally after all provenance checks pass.
revoke all on function public.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;

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
security definer
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
  perform app_private.assert_service_role();

  if worksheet ->> 'mode' = 'certified_bank' then
    return query
    select result.assignment_id, result.practice_test_id,
      result.generation_status, result.quality_status
    from app_private.complete_certified_worksheet_bank_fallback(
      target_job_id,
      target_queue_message_id,
      worker_id,
      worksheet
    ) result;
    return;
  end if;

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

revoke all on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;
grant execute on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
to service_role;

comment on function app_private.canonical_jsonb_text(jsonb) is
  'Stable UTF-8 canonical JSON used identically by Edge candidate/verdict hashing and the completion boundary.';
comment on function app_private.assert_dual_worksheet_critics(jsonb) is
  'Rejects generated worksheet provenance unless both pinned critics evaluated the exact database-recomputed candidate hash with coherent verdicts.';
comment on table app_private.worksheet_generation_completions is
  'Immutable generated/reuse completion ledger; Phase 12N generated rows bind both critic models and verdict hashes to the exact candidate and persisted content.';
comment on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) is
  'Sole service-role worksheet completion boundary; validates certified-bank or exact dual-critic provenance before invoking the non-executable legacy transaction engine.';

notify pgrst, 'reload schema';
