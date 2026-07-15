-- Phase 12I: truthful, replay-safe OpenAI provenance for semantic worksheet
-- answer evaluation.
--
-- The legacy public completion routine remains the single transactional owner
-- of scoring, adaptive-state changes, job terminalization, and queue archive.
-- This service-only adapter pins provider/model pairs, translates OpenAI rows
-- only inside the transaction for the legacy validator, then restores the
-- truthful source before commit. A canonical result hash prevents a succeeded
-- DeepSeek job from being relabelled by a late or changed OpenAI replay.

alter table public.practice_attempt_question_reviews
drop constraint if exists practice_attempt_question_reviews_evaluator_source_check;

alter table public.practice_attempt_question_reviews
add constraint practice_attempt_question_reviews_evaluator_source_check
check (evaluator_source in ('deepseek', 'openai', 'teacher', 'manual'))
not valid;

alter table public.practice_attempt_question_reviews
validate constraint practice_attempt_question_reviews_evaluator_source_check;

create table if not exists app_private.worksheet_answer_completion_provenance (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete restrict,
  provider_source text,
  evaluator_model text,
  result_sha256 text not null,
  completed_at timestamptz not null default now(),
  check (provider_source in ('deepseek', 'openai') or provider_source is null),
  check (coalesce((
    (provider_source = 'deepseek' and evaluator_model = 'deepseek-v4-flash')
    or (
      provider_source = 'openai'
      and evaluator_model = 'gpt-5.4-mini-2026-03-17'
    )
    or (provider_source is null and evaluator_model is null)
  ), false)),
  check (result_sha256 ~ '^[0-9a-f]{64}$')
);

alter table app_private.worksheet_answer_completion_provenance
enable row level security;

revoke all on table app_private.worksheet_answer_completion_provenance
from public, anon, authenticated, service_role;

create or replace function app_private.reject_worksheet_answer_completion_mutation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Worksheet answer completion evidence is immutable.';
end;
$$;

revoke all on function app_private.reject_worksheet_answer_completion_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists worksheet_answer_completion_provenance_immutable
on app_private.worksheet_answer_completion_provenance;
create trigger worksheet_answer_completion_provenance_immutable
before update or delete
on app_private.worksheet_answer_completion_provenance
for each row execute function
  app_private.reject_worksheet_answer_completion_mutation();

create or replace function app_private.normalize_worksheet_answer_provenance(
  result jsonb
)
returns table (
  legacy_result jsonb,
  provider_source text,
  evaluator_model text,
  provider_question_ids uuid[]
)
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  deepseek_count integer := 0;
  openai_count integer := 0;
  normalized_reviews jsonb;
begin
  if result is null
    or jsonb_typeof(result) <> 'object'
    or jsonb_typeof(result -> 'reviews') <> 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'Worksheet answer completion payload is invalid.';
  end if;

  select
    count(*) filter (where review ->> 'evaluator_source' = 'deepseek'),
    count(*) filter (where review ->> 'evaluator_source' = 'openai')
  into deepseek_count, openai_count
  from jsonb_array_elements(result -> 'reviews') review;

  if deepseek_count > 0 and openai_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Worksheet answer evaluator provenance is invalid.';
  end if;

  if openai_count > 0 then
    if result -> 'evaluator_model'
        is distinct from to_jsonb('gpt-5.4-mini-2026-03-17'::text)
      or exists (
        select 1
        from jsonb_array_elements(result -> 'reviews') review
        where review ->> 'evaluator_source' = 'openai'
          and coalesce(review ->> 'question_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'Worksheet answer evaluator provenance is invalid.';
    end if;

    select
      jsonb_agg(
        case
          when review ->> 'evaluator_source' = 'openai'
            then jsonb_set(
              review,
              '{evaluator_source}',
              to_jsonb('deepseek'::text)
            )
          else review
        end
        order by ordinal
      ),
      array_agg(
        (review ->> 'question_id')::uuid
        order by ordinal
      ) filter (where review ->> 'evaluator_source' = 'openai')
    into normalized_reviews, provider_question_ids
    from jsonb_array_elements(result -> 'reviews')
      with ordinality as reviewed(review, ordinal);

    return query
    select
      jsonb_set(
        jsonb_set(
          result,
          '{evaluator_model}',
          to_jsonb('deepseek-v4-flash'::text)
        ),
        '{reviews}',
        normalized_reviews
      ),
      'openai'::text,
      'gpt-5.4-mini-2026-03-17'::text,
      provider_question_ids;
    return;
  end if;

  if deepseek_count > 0 then
    if result -> 'evaluator_model'
        is distinct from to_jsonb('deepseek-v4-flash'::text)
      or exists (
        select 1
        from jsonb_array_elements(result -> 'reviews') review
        where review ->> 'evaluator_source' = 'deepseek'
          and coalesce(review ->> 'question_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'Worksheet answer evaluator provenance is invalid.';
    end if;

    select array_agg(
      (review ->> 'question_id')::uuid
      order by ordinal
    )
    into provider_question_ids
    from jsonb_array_elements(result -> 'reviews')
      with ordinality as reviewed(review, ordinal)
    where review ->> 'evaluator_source' = 'deepseek';

    return query
    select
      result,
      'deepseek'::text,
      'deepseek-v4-flash'::text,
      provider_question_ids;
    return;
  end if;

  if result -> 'evaluator_model' is distinct from 'null'::jsonb then
    raise exception using
      errcode = '22023',
      message = 'Worksheet answer evaluator provenance is invalid.';
  end if;

  return query select result, null::text, null::text, array[]::uuid[];
end;
$$;

revoke all on function app_private.normalize_worksheet_answer_provenance(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.complete_worksheet_answer_with_provenance(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized record;
  selected_job_status text;
  selected_attempt_id uuid;
  canonical_result_sha256 text;
  recorded_provenance record;
  completed_attempt_id uuid;
  completed_assignment_id uuid;
  completed_evaluation_status text;
  completed_attempt_status text;
  completed_assignment_status text;
  completed_score_points numeric;
  completed_max_score_points numeric;
  completed_score_percent numeric;
  completed_passed boolean;
  changed_row_count integer;
begin
  perform app_private.assert_service_role();

  select *
  into strict normalized
  from app_private.normalize_worksheet_answer_provenance(result);

  canonical_result_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(result::text, 'UTF8')
    ),
    'hex'
  );

  select job.status, job.entity_id
  into selected_job_status, selected_attempt_id
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation'
  for update;

  if not found then
    raise exception using
      errcode = '02000',
      message = 'Worksheet answer evaluation job not found.';
  end if;

  if selected_job_status = 'succeeded' then
    select provenance.*
    into recorded_provenance
    from app_private.worksheet_answer_completion_provenance provenance
    where provenance.job_id = target_job_id;

    if not found
      or recorded_provenance.attempt_id <> selected_attempt_id
      or recorded_provenance.provider_source
        is distinct from normalized.provider_source
      or recorded_provenance.evaluator_model
        is distinct from normalized.evaluator_model
      or recorded_provenance.result_sha256 <> canonical_result_sha256
    then
      raise exception using
        errcode = '55000',
        message = 'Worksheet answer completion replay does not match.';
    end if;

    if normalized.provider_source is not null and (
      not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.id = selected_attempt_id
          and attempt.evaluation_model = normalized.evaluator_model
      )
      or (
        select count(*)
        from public.practice_attempt_question_reviews review
        where review.attempt_id = selected_attempt_id
          and review.question_id = any(normalized.provider_question_ids)
          and review.evaluator_source = normalized.provider_source
      ) <> cardinality(normalized.provider_question_ids)
    ) then
      raise exception using
        errcode = '55000',
        message = 'Worksheet answer completion provenance changed.';
    end if;
  end if;

  select
    completed.attempt_id,
    completed.assignment_id,
    completed.evaluation_status,
    completed.attempt_status,
    completed.assignment_status,
    completed.score_points,
    completed.max_score_points,
    completed.score_percent,
    completed.passed
  into strict
    completed_attempt_id,
    completed_assignment_id,
    completed_evaluation_status,
    completed_attempt_status,
    completed_assignment_status,
    completed_score_points,
    completed_max_score_points,
    completed_score_percent,
    completed_passed
  from public.complete_worksheet_answer_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    normalized.legacy_result
  ) completed;

  if completed_attempt_id is distinct from selected_attempt_id then
    raise exception using
      errcode = '55000',
      message = 'Worksheet answer completion context changed.';
  end if;

  if selected_job_status <> 'succeeded' then
    if normalized.provider_source = 'openai' then
      update public.practice_attempt_question_reviews review
      set evaluator_source = 'openai'
      where review.attempt_id = completed_attempt_id
        and review.question_id = any(normalized.provider_question_ids)
        and review.evaluator_source = 'deepseek';

      get diagnostics changed_row_count = row_count;
      if changed_row_count <> cardinality(normalized.provider_question_ids) then
        raise exception using
          errcode = '55000',
          message = 'Worksheet answer evaluator provenance was not persisted.';
      end if;

      update public.practice_test_attempts attempt
      set evaluation_model = normalized.evaluator_model
      where attempt.id = completed_attempt_id
        and attempt.evaluation_model = 'deepseek-v4-flash';

      if not found then
        raise exception using
          errcode = '55000',
          message = 'Worksheet answer evaluator model was not persisted.';
      end if;
    end if;

    insert into app_private.worksheet_answer_completion_provenance (
      job_id,
      attempt_id,
      provider_source,
      evaluator_model,
      result_sha256
    )
    values (
      target_job_id,
      completed_attempt_id,
      normalized.provider_source,
      normalized.evaluator_model,
      canonical_result_sha256
    );
  end if;

  return query
  select
    completed_attempt_id,
    completed_assignment_id,
    completed_evaluation_status,
    completed_attempt_status,
    completed_assignment_status,
    completed_score_points,
    completed_max_score_points,
    completed_score_percent,
    completed_passed;
end;
$$;

revoke all on function app_private.complete_worksheet_answer_with_provenance(
  uuid,
  bigint,
  uuid,
  jsonb
) from public, anon, authenticated, service_role;

grant execute on function app_private.complete_worksheet_answer_with_provenance(
  uuid,
  bigint,
  uuid,
  jsonb
) to service_role;

create or replace function api.complete_worksheet_answer_evaluation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.complete_worksheet_answer_with_provenance(
    target_job_id,
    target_queue_message_id,
    worker_id,
    result
  );
$$;

revoke all on function api.complete_worksheet_answer_evaluation(
  uuid,
  bigint,
  uuid,
  jsonb
) from public, anon, authenticated;

grant execute on function api.complete_worksheet_answer_evaluation(
  uuid,
  bigint,
  uuid,
  jsonb
) to service_role;

comment on function app_private.normalize_worksheet_answer_provenance(jsonb)
is 'Pins semantic worksheet-answer evaluator source/model provenance and creates a transaction-local legacy completion envelope.';

comment on table app_private.worksheet_answer_completion_provenance
is 'Private immutable canonical result fingerprints for exact semantic worksheet-answer completion redelivery.';

comment on function app_private.reject_worksheet_answer_completion_mutation()
is 'Rejects updates and deletes so committed worksheet-answer completion provenance cannot be rewritten.';

comment on function app_private.complete_worksheet_answer_with_provenance(
  uuid,
  bigint,
  uuid,
  jsonb
)
is 'Completes worksheet-answer jobs atomically, persists truthful provider provenance, and rejects changed succeeded-job replays by canonical result hash.';
