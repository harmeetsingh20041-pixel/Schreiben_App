-- Resume worksheet-answer evaluation after one independent provider succeeds.
--
-- The checkpoint is deliberately narrower than the final adjudication record:
-- it stores only a job/version-bound hash of the exact normalized evaluation
-- evidence and the already validated verdict of DeepSeek or Gemini. It also
-- stores the validated DeepSeek Pro resolution when the two first-pass
-- evaluators disagree. Explicit evaluator and prompt contract versions make a
-- checkpoint ineligible for replay after either contract changes. The
-- verdict can contain student-answer-derived correction text, so the table is
-- private, has no direct grants, and is deleted as soon as the job reaches a
-- terminal state. Queue messages continue to contain identifiers only.
-- A validated verdict and its provider invoice are committed by the same RPC,
-- so neither can survive without the other.

create table app_private.worksheet_answer_provider_checkpoints (
  job_id uuid not null
    references app_private.async_jobs(id) on delete cascade,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete cascade,
  entity_version integer not null check (entity_version > 0),
  checkpoint_role text not null check (
    checkpoint_role in ('evaluation', 'adjudication')
  ),
  evaluator_contract_version integer not null check (
    evaluator_contract_version = 1
  ),
  prompt_contract_version integer not null check (
    prompt_contract_version = 1
  ),
  evidence_sha256 text not null check (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  provider_name text not null check (
    provider_name in ('deepseek', 'gemini')
  ),
  provider_model text not null,
  verdict_sha256 text not null check (
    verdict_sha256 ~ '^[a-f0-9]{64}$'
  ),
  normalized_verdict jsonb not null check (
    octet_length(normalized_verdict::text) <= 16384
    and (
      (
        checkpoint_role = 'evaluation'
        and jsonb_typeof(normalized_verdict) = 'array'
        and jsonb_array_length(normalized_verdict) between 1 and 3
      )
      or (
        checkpoint_role = 'adjudication'
        and jsonb_typeof(normalized_verdict) = 'object'
        and normalized_verdict ?& array[
          'deepseek_result_sha256',
          'gemini_result_sha256',
          'resolutions'
        ]
        and normalized_verdict - array[
          'deepseek_result_sha256',
          'gemini_result_sha256',
          'resolutions'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(normalized_verdict -> 'resolutions') = 'array'
        and jsonb_array_length(normalized_verdict -> 'resolutions')
          between 1 and 3
      )
    )
  ),
  created_at timestamptz not null default now(),
  primary key (job_id, checkpoint_role, provider_name),
  unique (
    job_id,
    attempt_id,
    entity_version,
    checkpoint_role,
    provider_name
  ),
  constraint worksheet_answer_provider_checkpoint_model_check check (
    (
      checkpoint_role = 'evaluation'
      and provider_name = 'deepseek'
      and provider_model = 'deepseek-v4-flash'
    )
    or (
      checkpoint_role = 'evaluation'
      and provider_name = 'gemini'
      and provider_model = 'gemini-3.1-flash-lite'
    )
    or (
      checkpoint_role = 'adjudication'
      and provider_name = 'deepseek'
      and provider_model = 'deepseek-v4-pro'
    )
  ),
  constraint worksheet_answer_provider_checkpoint_verdict_hash_check check (
    verdict_sha256 =
      app_private.canonical_jsonb_sha256(normalized_verdict)
  )
);

create index worksheet_answer_provider_checkpoints_attempt_version_idx
on app_private.worksheet_answer_provider_checkpoints (
  attempt_id,
  entity_version
);

alter table app_private.worksheet_answer_provider_checkpoints
  enable row level security;

revoke all on table app_private.worksheet_answer_provider_checkpoints
from public, anon, authenticated, service_role;

create or replace function app_private.reject_worksheet_answer_checkpoint_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'worksheet_answer_checkpoint_immutable';
end;
$$;

revoke all on function
  app_private.reject_worksheet_answer_checkpoint_update()
from public, anon, authenticated, service_role;

create trigger worksheet_answer_provider_checkpoints_immutable
before update on app_private.worksheet_answer_provider_checkpoints
for each row execute function
  app_private.reject_worksheet_answer_checkpoint_update();

-- A checkpoint row is useful only while its exact job lease is active. Job is
-- always locked before attempt/checkpoint, matching the queue worker lock
-- order and preventing an expired worker from persisting or reading evidence.
create or replace function app_private.assert_active_worksheet_answer_checkpoint_lease(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer
)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or target_worker_id is null
    or target_attempt_id is null
    or expected_entity_version is null
    or expected_entity_version < 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_checkpoint_lease_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation'
    and job.queue_name = 'worksheet_answer_evaluation'
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = '02000',
      message = 'worksheet_answer_checkpoint_job_missing';
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = selected_job.entity_id
    and attempt.id = target_attempt_id
    and attempt.evaluation_version = selected_job.entity_version
    and attempt.evaluation_version = expected_entity_version
  for update;

  if selected_attempt.id is null
    or selected_job.status <> 'processing'
    or selected_job.entity_id <> target_attempt_id
    or selected_job.entity_version <> expected_entity_version
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> target_worker_id
    or selected_job.lease_expires_at is null
    or selected_job.lease_expires_at <= clock_timestamp()
    or selected_attempt.evaluation_status <> 'evaluating'
    or selected_attempt.status not in ('submitted', 'checked')
    or selected_attempt.assignment_id is null
    or not exists (
      select 1
      from public.student_practice_assignments assignment
      join public.workspace_members membership
        on membership.workspace_id = selected_attempt.workspace_id
       and membership.user_id = selected_attempt.student_id
       and membership.role = 'student'
      where assignment.id = selected_attempt.assignment_id
        and assignment.workspace_id = selected_attempt.workspace_id
        and assignment.student_id = selected_attempt.student_id
        and assignment.practice_test_id = selected_attempt.practice_test_id
        and assignment.latest_attempt_id = selected_attempt.id
        and assignment.status in ('completed', 'passed', 'failed')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_lease_stale';
  end if;

  return selected_job;
end;
$$;

revoke all on function
  app_private.assert_active_worksheet_answer_checkpoint_lease(
    uuid, bigint, uuid, uuid, integer
  )
from public, anon, authenticated, service_role;

-- The normalized provider verdict is the exact in-memory object used by the
-- adjudicator on resume. SQL independently enforces its closed shape, source,
-- bounded cardinality, status/points consistency, and normalized text.
create or replace function app_private.assert_worksheet_answer_checkpoint_verdict(
  provider_name text,
  normalized_verdict jsonb
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if provider_name not in ('deepseek', 'gemini')
    or normalized_verdict is null
    or jsonb_typeof(normalized_verdict) <> 'array'
    or jsonb_array_length(normalized_verdict) not between 1 and 3
    or octet_length(normalized_verdict::text) > 16384
    or (
      select count(*) <> count(distinct verdict ->> 'question_id')
      from jsonb_array_elements(normalized_verdict) verdict
    )
    or exists (
      select 1
      from jsonb_array_elements(normalized_verdict) verdict
      where jsonb_typeof(verdict) <> 'object'
        or not (verdict ?& array[
          'question_id',
          'review_status',
          'points_awarded',
          'max_points',
          'evaluator_source',
          'feedback_text',
          'corrected_answer',
          'model_answer',
          'short_reason'
        ])
        or verdict - array[
          'question_id',
          'review_status',
          'points_awarded',
          'max_points',
          'evaluator_source',
          'feedback_text',
          'corrected_answer',
          'model_answer',
          'short_reason'
        ]::text[] <> '{}'::jsonb
        or coalesce(verdict ->> 'question_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or verdict ->> 'evaluator_source' is distinct from provider_name
        or coalesce(verdict ->> 'review_status', '') not in (
          'correct',
          'partially_correct',
          'capitalization_issue',
          'minor_punctuation',
          'incorrect'
        )
        or verdict -> 'max_points' is distinct from '1'::jsonb
        or verdict -> 'points_awarded' is distinct from case
          when verdict ->> 'review_status' in ('correct', 'minor_punctuation')
            then '1'::jsonb
          when verdict ->> 'review_status' in (
            'partially_correct', 'capitalization_issue'
          ) then '0.5'::jsonb
          else '0'::jsonb
        end
        or jsonb_typeof(verdict -> 'feedback_text') <> 'string'
        or length(verdict ->> 'feedback_text') not between 1 and 500
        or verdict ->> 'feedback_text' is distinct from btrim(
          regexp_replace(verdict ->> 'feedback_text', '[[:space:]]+', ' ', 'g')
        )
        or jsonb_typeof(verdict -> 'short_reason') <> 'string'
        or length(verdict ->> 'short_reason') not between 1 and 240
        or verdict ->> 'short_reason' is distinct from btrim(
          regexp_replace(verdict ->> 'short_reason', '[[:space:]]+', ' ', 'g')
        )
        or (
          verdict -> 'corrected_answer' <> 'null'::jsonb
          and (
            jsonb_typeof(verdict -> 'corrected_answer') <> 'string'
            or length(verdict ->> 'corrected_answer') not between 1 and 500
            or verdict ->> 'corrected_answer' is distinct from btrim(
              regexp_replace(
                verdict ->> 'corrected_answer', '[[:space:]]+', ' ', 'g'
              )
            )
          )
        )
        or (
          verdict -> 'model_answer' <> 'null'::jsonb
          and (
            jsonb_typeof(verdict -> 'model_answer') <> 'string'
            or length(verdict ->> 'model_answer') not between 1 and 500
            or verdict ->> 'model_answer' is distinct from btrim(
              regexp_replace(
                verdict ->> 'model_answer', '[[:space:]]+', ' ', 'g'
              )
            )
          )
        )
        or (
          verdict ->> 'review_status' = 'correct'
          and verdict -> 'corrected_answer' <> 'null'::jsonb
        )
        or (
          verdict ->> 'review_status' <> 'correct'
          and verdict -> 'corrected_answer' = 'null'::jsonb
        )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_checkpoint_verdict_invalid';
  end if;
end;
$$;

revoke all on function
  app_private.assert_worksheet_answer_checkpoint_verdict(text, jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.get_worksheet_answer_provider_checkpoints(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  expected_evidence_sha256 text,
  expected_deepseek_model text,
  expected_gemini_model text,
  expected_evaluator_contract_version integer,
  expected_prompt_contract_version integer
)
returns table (
  job_id uuid,
  attempt_id uuid,
  entity_version integer,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  provider_name text,
  provider_model text,
  verdict_sha256 text,
  normalized_verdict jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  selected_job := app_private.assert_active_worksheet_answer_checkpoint_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version
  );

  if coalesce(expected_evidence_sha256, '') !~ '^[a-f0-9]{64}$'
    or expected_deepseek_model is distinct from 'deepseek-v4-flash'
    or expected_gemini_model is distinct from 'gemini-3.1-flash-lite'
    or expected_evaluator_contract_version is distinct from 1
    or expected_prompt_contract_version is distinct from 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_checkpoint_expectation_invalid';
  end if;

  if exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = selected_job.id
      and checkpoint.checkpoint_role = 'evaluation'
      and (
        checkpoint.attempt_id <> selected_job.entity_id
        or checkpoint.entity_version <> selected_job.entity_version
        or checkpoint.evidence_sha256 <> expected_evidence_sha256
        or checkpoint.evaluator_contract_version <>
          expected_evaluator_contract_version
        or checkpoint.prompt_contract_version <>
          expected_prompt_contract_version
        or checkpoint.verdict_sha256 <>
          app_private.canonical_jsonb_sha256(checkpoint.normalized_verdict)
        or checkpoint.provider_model <> case checkpoint.provider_name
          when 'deepseek' then expected_deepseek_model
          when 'gemini' then expected_gemini_model
          else null
        end
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  return query
  select
    checkpoint.job_id,
    checkpoint.attempt_id,
    checkpoint.entity_version,
    checkpoint.evaluator_contract_version,
    checkpoint.prompt_contract_version,
    checkpoint.evidence_sha256,
    checkpoint.provider_name,
    checkpoint.provider_model,
    checkpoint.verdict_sha256,
    checkpoint.normalized_verdict
  from app_private.worksheet_answer_provider_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
    and checkpoint.checkpoint_role = 'evaluation'
    and checkpoint.attempt_id = selected_job.entity_id
    and checkpoint.entity_version = selected_job.entity_version
    and checkpoint.evidence_sha256 = expected_evidence_sha256
  order by checkpoint.provider_name;
end;
$$;

revoke all on function
  app_private.get_worksheet_answer_provider_checkpoints(
    uuid, bigint, uuid, uuid, integer, text, text, text, integer, integer
  )
from public, anon, authenticated, service_role;

create or replace function api.get_worksheet_answer_provider_checkpoints(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  expected_evidence_sha256 text,
  expected_deepseek_model text,
  expected_gemini_model text,
  expected_evaluator_contract_version integer,
  expected_prompt_contract_version integer
)
returns table (
  job_id uuid,
  attempt_id uuid,
  entity_version integer,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  provider_name text,
  provider_model text,
  verdict_sha256 text,
  normalized_verdict jsonb
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.get_worksheet_answer_provider_checkpoints(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version,
    expected_evidence_sha256,
    expected_deepseek_model,
    expected_gemini_model,
    expected_evaluator_contract_version,
    expected_prompt_contract_version
  );
$$;

revoke all on function api.get_worksheet_answer_provider_checkpoints(
  uuid, bigint, uuid, uuid, integer, text, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function api.get_worksheet_answer_provider_checkpoints(
  uuid, bigint, uuid, uuid, integer, text, text, text, integer, integer
) to service_role;

create or replace function app_private.save_worksheet_answer_provider_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  target_evidence_sha256 text,
  target_provider_name text,
  target_provider_model text,
  target_verdict_sha256 text,
  target_normalized_verdict jsonb,
  target_call_key text,
  target_provider_model_version text,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint,
  target_evaluator_contract_version integer,
  target_prompt_contract_version integer
)
returns table (
  provider_name text,
  provider_model text,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  verdict_sha256 text,
  normalized_verdict jsonb,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  recorded app_private.worksheet_answer_provider_checkpoints%rowtype;
  spend_reservation app_private.ai_spend_reservations%rowtype;
  inserted_count integer := 0;
begin
  selected_job := app_private.assert_active_worksheet_answer_checkpoint_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version
  );

  if coalesce(target_evidence_sha256, '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_verdict_sha256, '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_call_key, '') !~ '^[a-z0-9][a-z0-9._:-]{0,104}$'
    or target_provider_model_version is distinct from target_provider_model
    or target_evaluator_contract_version is distinct from 1
    or target_prompt_contract_version is distinct from 1
    or target_billed_input_tokens is null
    or target_billed_input_tokens not between 1 and 10000000
    or target_billed_output_tokens is null
    or target_billed_output_tokens not between 1 and 10000000
    or (
      (target_billed_cached_input_tokens is null) <>
      (target_billed_uncached_input_tokens is null)
    )
    or (
      target_billed_cached_input_tokens is not null
      and (
        target_billed_cached_input_tokens not between 0 and 10000000
        or target_billed_uncached_input_tokens not between 0 and 10000000
        or target_billed_cached_input_tokens +
          target_billed_uncached_input_tokens <> target_billed_input_tokens
      )
    )
    or not (
      (
        target_provider_name = 'deepseek'
        and target_provider_model = 'deepseek-v4-flash'
      )
      or (
        target_provider_name = 'gemini'
        and target_provider_model = 'gemini-3.1-flash-lite'
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_checkpoint_expectation_invalid';
  end if;

  perform app_private.assert_worksheet_answer_checkpoint_verdict(
    target_provider_name,
    target_normalized_verdict
  );

  if target_verdict_sha256 is distinct from
    app_private.canonical_jsonb_sha256(target_normalized_verdict)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_checkpoint_verdict_hash_invalid';
  end if;

  if exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = selected_job.id
      and checkpoint.checkpoint_role = 'evaluation'
      and (
        checkpoint.attempt_id <> selected_job.entity_id
        or checkpoint.entity_version <> selected_job.entity_version
        or checkpoint.evidence_sha256 <> target_evidence_sha256
        or checkpoint.evaluator_contract_version <>
          target_evaluator_contract_version
        or checkpoint.prompt_contract_version <>
          target_prompt_contract_version
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  -- Provider usage and its normalized verdict cross one database commit. A
  -- crash after this transaction can therefore replay the checkpoint without
  -- dispatching the same evaluator again, while a rejected checkpoint cannot
  -- leave a falsely finalized invoice behind.
  select reservation.*
  into spend_reservation
  from app_private.ai_spend_reservations reservation
  where reservation.job_id = selected_job.id
    and reservation.entity_version = selected_job.entity_version
    and reservation.call_key =
      'attempt_' || selected_job.attempt_count::text || ':' || target_call_key
  for update;

  if spend_reservation.id is null
    or spend_reservation.provider_name <> target_provider_name
    or spend_reservation.model_name <> target_provider_model
    or spend_reservation.call_purpose <> 'worksheet_answer_evaluation'
    or spend_reservation.state = 'released'
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_spend_mismatch';
  end if;

  insert into app_private.worksheet_answer_provider_checkpoints (
    job_id,
    attempt_id,
    entity_version,
    checkpoint_role,
    evaluator_contract_version,
    prompt_contract_version,
    evidence_sha256,
    provider_name,
    provider_model,
    verdict_sha256,
    normalized_verdict
  ) values (
    selected_job.id,
    selected_job.entity_id,
    selected_job.entity_version,
    'evaluation',
    target_evaluator_contract_version,
    target_prompt_contract_version,
    target_evidence_sha256,
    target_provider_name,
    target_provider_model,
    target_verdict_sha256,
    target_normalized_verdict
  ) on conflict (job_id, checkpoint_role, provider_name) do nothing;

  get diagnostics inserted_count = row_count;

  select checkpoint.*
  into strict recorded
  from app_private.worksheet_answer_provider_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
    and checkpoint.checkpoint_role = 'evaluation'
    and checkpoint.provider_name = target_provider_name;

  if recorded.attempt_id <> selected_job.entity_id
    or recorded.entity_version <> selected_job.entity_version
    or recorded.evaluator_contract_version <>
      target_evaluator_contract_version
    or recorded.prompt_contract_version <>
      target_prompt_contract_version
    or recorded.evidence_sha256 <> target_evidence_sha256
    or recorded.provider_model <> target_provider_model
    or recorded.verdict_sha256 <> target_verdict_sha256
    or recorded.normalized_verdict is distinct from target_normalized_verdict
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  perform app_private.finalize_ai_spend_reservation(
    spend_reservation.id,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens
  );

  return query select
    recorded.provider_name,
    recorded.provider_model,
    recorded.evaluator_contract_version,
    recorded.prompt_contract_version,
    recorded.evidence_sha256,
    recorded.verdict_sha256,
    recorded.normalized_verdict,
    inserted_count = 1;
end;
$$;

revoke all on function
  app_private.save_worksheet_answer_provider_checkpoint(
    uuid, bigint, uuid, uuid, integer, text, text, text, text, jsonb,
    text, text, bigint, bigint, bigint, bigint, integer, integer
  )
from public, anon, authenticated, service_role;

create or replace function api.save_worksheet_answer_provider_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  target_evidence_sha256 text,
  target_provider_name text,
  target_provider_model text,
  target_verdict_sha256 text,
  target_normalized_verdict jsonb,
  target_call_key text,
  target_provider_model_version text,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint,
  target_evaluator_contract_version integer,
  target_prompt_contract_version integer
)
returns table (
  provider_name text,
  provider_model text,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  verdict_sha256 text,
  normalized_verdict jsonb,
  created boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.save_worksheet_answer_provider_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version,
    target_evidence_sha256,
    target_provider_name,
    target_provider_model,
    target_verdict_sha256,
    target_normalized_verdict,
    target_call_key,
    target_provider_model_version,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens,
    target_evaluator_contract_version,
    target_prompt_contract_version
  );
$$;

revoke all on function api.save_worksheet_answer_provider_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function api.save_worksheet_answer_provider_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint, integer, integer
) to service_role;

-- The Pro payload is deliberately content-minimal: it contains only the two
-- canonical first-pass hashes and a bounded resolution for each disputed
-- question reference. SQL re-validates the exact closed shape before any
-- invoice can be finalized.
create or replace function
  app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(
    normalized_verdict jsonb
  )
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if normalized_verdict is null
    or jsonb_typeof(normalized_verdict) <> 'object'
    or not (normalized_verdict ?& array[
      'deepseek_result_sha256',
      'gemini_result_sha256',
      'resolutions'
    ])
    or normalized_verdict - array[
      'deepseek_result_sha256',
      'gemini_result_sha256',
      'resolutions'
    ]::text[] <> '{}'::jsonb
    or coalesce(normalized_verdict ->> 'deepseek_result_sha256', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(normalized_verdict ->> 'gemini_result_sha256', '')
      !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(normalized_verdict -> 'resolutions') <> 'array'
    or jsonb_array_length(normalized_verdict -> 'resolutions')
      not between 1 and 3
    or octet_length(normalized_verdict::text) > 16384
    or (
      select count(*) <> count(distinct resolution ->> 'question_ref')
      from jsonb_array_elements(
        normalized_verdict -> 'resolutions'
      ) resolution
    )
    or exists (
      select 1
      from jsonb_array_elements(
        normalized_verdict -> 'resolutions'
      ) resolution
      where jsonb_typeof(resolution) <> 'object'
        or not (resolution ?& array[
          'question_ref',
          'resolution_status',
          'selected_evidence',
          'short_reason'
        ])
        or resolution - array[
          'question_ref',
          'resolution_status',
          'selected_evidence',
          'short_reason'
        ]::text[] <> '{}'::jsonb
        or coalesce(resolution ->> 'question_ref', '') !~ '^q[1-3]$'
        or coalesce(resolution ->> 'resolution_status', '') not in (
          'resolved', 'uncertain'
        )
        or jsonb_typeof(resolution -> 'short_reason') <> 'string'
        or length(resolution ->> 'short_reason') not between 1 and 240
        or resolution ->> 'short_reason' is distinct from btrim(
          regexp_replace(
            resolution ->> 'short_reason', '[[:space:]]+', ' ', 'g'
          )
        )
        or (
          resolution ->> 'resolution_status' = 'resolved'
          and (
            jsonb_typeof(resolution -> 'selected_evidence') <> 'string'
            or resolution ->> 'selected_evidence' not in (
              'deepseek', 'gemini'
            )
          )
        )
        or (
          resolution ->> 'resolution_status' = 'uncertain'
          and resolution -> 'selected_evidence' <> 'null'::jsonb
        )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_adjudication_checkpoint_verdict_invalid';
  end if;
end;
$$;

revoke all on function
  app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(jsonb)
from public, anon, authenticated, service_role;

create or replace function
  app_private.get_worksheet_answer_adjudication_checkpoint(
    target_job_id uuid,
    target_queue_message_id bigint,
    worker_id uuid,
    target_attempt_id uuid,
    expected_entity_version integer,
    expected_evidence_sha256 text,
    expected_provider_model text,
    expected_evaluator_contract_version integer,
    expected_prompt_contract_version integer
  )
returns table (
  job_id uuid,
  attempt_id uuid,
  entity_version integer,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  provider_name text,
  provider_model text,
  verdict_sha256 text,
  normalized_verdict jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  selected_job := app_private.assert_active_worksheet_answer_checkpoint_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version
  );

  if coalesce(expected_evidence_sha256, '') !~ '^[a-f0-9]{64}$'
    or expected_provider_model is distinct from 'deepseek-v4-pro'
    or expected_evaluator_contract_version is distinct from 1
    or expected_prompt_contract_version is distinct from 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_adjudication_checkpoint_expectation_invalid';
  end if;

  if not exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints deepseek
    join app_private.worksheet_answer_provider_checkpoints gemini
      on gemini.job_id = deepseek.job_id
     and gemini.checkpoint_role = 'evaluation'
     and gemini.provider_name = 'gemini'
     and gemini.attempt_id = deepseek.attempt_id
     and gemini.entity_version = deepseek.entity_version
     and gemini.evaluator_contract_version =
       deepseek.evaluator_contract_version
     and gemini.prompt_contract_version = deepseek.prompt_contract_version
     and gemini.evidence_sha256 = deepseek.evidence_sha256
    where deepseek.job_id = selected_job.id
      and deepseek.checkpoint_role = 'evaluation'
      and deepseek.provider_name = 'deepseek'
      and deepseek.attempt_id = selected_job.entity_id
      and deepseek.entity_version = selected_job.entity_version
      and deepseek.evaluator_contract_version =
        expected_evaluator_contract_version
      and deepseek.prompt_contract_version = expected_prompt_contract_version
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  if exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints adjudication
    where adjudication.job_id = selected_job.id
      and adjudication.checkpoint_role = 'adjudication'
      and not exists (
        select 1
        from app_private.worksheet_answer_provider_checkpoints deepseek
        join app_private.worksheet_answer_provider_checkpoints gemini
          on gemini.job_id = deepseek.job_id
         and gemini.checkpoint_role = 'evaluation'
         and gemini.provider_name = 'gemini'
         and gemini.attempt_id = deepseek.attempt_id
         and gemini.entity_version = deepseek.entity_version
         and gemini.evaluator_contract_version =
           deepseek.evaluator_contract_version
         and gemini.prompt_contract_version =
           deepseek.prompt_contract_version
         and gemini.evidence_sha256 = deepseek.evidence_sha256
        where deepseek.job_id = adjudication.job_id
          and deepseek.checkpoint_role = 'evaluation'
          and deepseek.provider_name = 'deepseek'
          and deepseek.verdict_sha256 =
            adjudication.normalized_verdict ->> 'deepseek_result_sha256'
          and gemini.verdict_sha256 =
            adjudication.normalized_verdict ->> 'gemini_result_sha256'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  if exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = selected_job.id
      and checkpoint.checkpoint_role = 'adjudication'
      and (
        checkpoint.attempt_id <> selected_job.entity_id
        or checkpoint.entity_version <> selected_job.entity_version
        or checkpoint.evidence_sha256 <> expected_evidence_sha256
        or checkpoint.evaluator_contract_version <>
          expected_evaluator_contract_version
        or checkpoint.prompt_contract_version <>
          expected_prompt_contract_version
        or checkpoint.provider_name <> 'deepseek'
        or checkpoint.provider_model <> expected_provider_model
        or checkpoint.verdict_sha256 <>
          app_private.canonical_jsonb_sha256(checkpoint.normalized_verdict)
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  return query
  select
    checkpoint.job_id,
    checkpoint.attempt_id,
    checkpoint.entity_version,
    checkpoint.evaluator_contract_version,
    checkpoint.prompt_contract_version,
    checkpoint.evidence_sha256,
    checkpoint.provider_name,
    checkpoint.provider_model,
    checkpoint.verdict_sha256,
    checkpoint.normalized_verdict
  from app_private.worksheet_answer_provider_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
    and checkpoint.checkpoint_role = 'adjudication'
    and checkpoint.attempt_id = selected_job.entity_id
    and checkpoint.entity_version = selected_job.entity_version
    and checkpoint.evidence_sha256 = expected_evidence_sha256
    and checkpoint.provider_name = 'deepseek';
end;
$$;

revoke all on function
  app_private.get_worksheet_answer_adjudication_checkpoint(
    uuid, bigint, uuid, uuid, integer, text, text, integer, integer
  )
from public, anon, authenticated, service_role;

create or replace function api.get_worksheet_answer_adjudication_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  expected_evidence_sha256 text,
  expected_provider_model text,
  expected_evaluator_contract_version integer,
  expected_prompt_contract_version integer
)
returns table (
  job_id uuid,
  attempt_id uuid,
  entity_version integer,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  provider_name text,
  provider_model text,
  verdict_sha256 text,
  normalized_verdict jsonb
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.get_worksheet_answer_adjudication_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version,
    expected_evidence_sha256,
    expected_provider_model,
    expected_evaluator_contract_version,
    expected_prompt_contract_version
  );
$$;

revoke all on function api.get_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function api.get_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, integer, integer
) to service_role;

create or replace function
  app_private.save_worksheet_answer_adjudication_checkpoint(
    target_job_id uuid,
    target_queue_message_id bigint,
    worker_id uuid,
    target_attempt_id uuid,
    expected_entity_version integer,
    target_evidence_sha256 text,
    target_provider_model text,
    target_verdict_sha256 text,
    target_normalized_verdict jsonb,
    target_call_key text,
    target_provider_model_version text,
    target_billed_input_tokens bigint,
    target_billed_output_tokens bigint,
    target_billed_cached_input_tokens bigint,
    target_billed_uncached_input_tokens bigint,
    target_evaluator_contract_version integer,
    target_prompt_contract_version integer
  )
returns table (
  provider_name text,
  provider_model text,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  verdict_sha256 text,
  normalized_verdict jsonb,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  recorded app_private.worksheet_answer_provider_checkpoints%rowtype;
  spend_reservation app_private.ai_spend_reservations%rowtype;
  inserted_count integer := 0;
begin
  selected_job := app_private.assert_active_worksheet_answer_checkpoint_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version
  );

  if coalesce(target_evidence_sha256, '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_verdict_sha256, '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_call_key, '') !~ '^[a-z0-9][a-z0-9._:-]{0,104}$'
    or target_provider_model is distinct from 'deepseek-v4-pro'
    or target_provider_model_version is distinct from target_provider_model
    or target_evaluator_contract_version is distinct from 1
    or target_prompt_contract_version is distinct from 1
    or target_billed_input_tokens is null
    or target_billed_input_tokens not between 1 and 10000000
    or target_billed_output_tokens is null
    or target_billed_output_tokens not between 1 and 10000000
    or (
      (target_billed_cached_input_tokens is null) <>
      (target_billed_uncached_input_tokens is null)
    )
    or (
      target_billed_cached_input_tokens is not null
      and (
        target_billed_cached_input_tokens not between 0 and 10000000
        or target_billed_uncached_input_tokens not between 0 and 10000000
        or target_billed_cached_input_tokens +
          target_billed_uncached_input_tokens <> target_billed_input_tokens
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_adjudication_checkpoint_expectation_invalid';
  end if;

  perform
    app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(
      target_normalized_verdict
    );

  if target_verdict_sha256 is distinct from
    app_private.canonical_jsonb_sha256(target_normalized_verdict)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_answer_adjudication_checkpoint_hash_invalid';
  end if;

  if not exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints deepseek
    join app_private.worksheet_answer_provider_checkpoints gemini
      on gemini.job_id = deepseek.job_id
     and gemini.checkpoint_role = 'evaluation'
     and gemini.provider_name = 'gemini'
     and gemini.attempt_id = deepseek.attempt_id
     and gemini.entity_version = deepseek.entity_version
     and gemini.evaluator_contract_version =
       deepseek.evaluator_contract_version
     and gemini.prompt_contract_version = deepseek.prompt_contract_version
     and gemini.evidence_sha256 = deepseek.evidence_sha256
    where deepseek.job_id = selected_job.id
      and deepseek.checkpoint_role = 'evaluation'
      and deepseek.provider_name = 'deepseek'
      and deepseek.attempt_id = selected_job.entity_id
      and deepseek.entity_version = selected_job.entity_version
      and deepseek.evaluator_contract_version =
        target_evaluator_contract_version
      and deepseek.prompt_contract_version = target_prompt_contract_version
      and deepseek.verdict_sha256 =
        target_normalized_verdict ->> 'deepseek_result_sha256'
      and gemini.verdict_sha256 =
        target_normalized_verdict ->> 'gemini_result_sha256'
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  if exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = selected_job.id
      and checkpoint.checkpoint_role = 'adjudication'
      and (
        checkpoint.attempt_id <> selected_job.entity_id
        or checkpoint.entity_version <> selected_job.entity_version
        or checkpoint.evidence_sha256 <> target_evidence_sha256
        or checkpoint.evaluator_contract_version <>
          target_evaluator_contract_version
        or checkpoint.prompt_contract_version <>
          target_prompt_contract_version
        or checkpoint.provider_name <> 'deepseek'
        or checkpoint.provider_model <> target_provider_model
        or checkpoint.verdict_sha256 <>
          app_private.canonical_jsonb_sha256(checkpoint.normalized_verdict)
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  -- Preserve the established job -> attempt -> spend-reservation lock order.
  select reservation.*
  into spend_reservation
  from app_private.ai_spend_reservations reservation
  where reservation.job_id = selected_job.id
    and reservation.entity_version = selected_job.entity_version
    and reservation.call_key =
      'attempt_' || selected_job.attempt_count::text || ':' || target_call_key
  for update;

  if spend_reservation.id is null
    or spend_reservation.provider_name <> 'deepseek'
    or spend_reservation.model_name <> target_provider_model
    or spend_reservation.call_purpose <> 'worksheet_answer_adjudication'
    or spend_reservation.state = 'released'
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_spend_mismatch';
  end if;

  insert into app_private.worksheet_answer_provider_checkpoints (
    job_id,
    attempt_id,
    entity_version,
    checkpoint_role,
    evaluator_contract_version,
    prompt_contract_version,
    evidence_sha256,
    provider_name,
    provider_model,
    verdict_sha256,
    normalized_verdict
  ) values (
    selected_job.id,
    selected_job.entity_id,
    selected_job.entity_version,
    'adjudication',
    target_evaluator_contract_version,
    target_prompt_contract_version,
    target_evidence_sha256,
    'deepseek',
    target_provider_model,
    target_verdict_sha256,
    target_normalized_verdict
  ) on conflict (job_id, checkpoint_role, provider_name) do nothing;

  get diagnostics inserted_count = row_count;

  select checkpoint.*
  into strict recorded
  from app_private.worksheet_answer_provider_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
    and checkpoint.checkpoint_role = 'adjudication'
    and checkpoint.provider_name = 'deepseek';

  if recorded.attempt_id <> selected_job.entity_id
    or recorded.entity_version <> selected_job.entity_version
    or recorded.evaluator_contract_version <>
      target_evaluator_contract_version
    or recorded.prompt_contract_version <>
      target_prompt_contract_version
    or recorded.evidence_sha256 <> target_evidence_sha256
    or recorded.provider_model <> target_provider_model
    or recorded.verdict_sha256 <> target_verdict_sha256
    or recorded.normalized_verdict is distinct from target_normalized_verdict
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_answer_checkpoint_replay_mismatch';
  end if;

  perform app_private.finalize_ai_spend_reservation(
    spend_reservation.id,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens
  );

  return query select
    recorded.provider_name,
    recorded.provider_model,
    recorded.evaluator_contract_version,
    recorded.prompt_contract_version,
    recorded.evidence_sha256,
    recorded.verdict_sha256,
    recorded.normalized_verdict,
    inserted_count = 1;
end;
$$;

revoke all on function
  app_private.save_worksheet_answer_adjudication_checkpoint(
    uuid, bigint, uuid, uuid, integer, text, text, text, jsonb, text, text,
    bigint, bigint, bigint, bigint, integer, integer
  )
from public, anon, authenticated, service_role;

create or replace function api.save_worksheet_answer_adjudication_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  target_attempt_id uuid,
  expected_entity_version integer,
  target_evidence_sha256 text,
  target_provider_model text,
  target_verdict_sha256 text,
  target_normalized_verdict jsonb,
  target_call_key text,
  target_provider_model_version text,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint,
  target_evaluator_contract_version integer,
  target_prompt_contract_version integer
)
returns table (
  provider_name text,
  provider_model text,
  evaluator_contract_version integer,
  prompt_contract_version integer,
  evidence_sha256 text,
  verdict_sha256 text,
  normalized_verdict jsonb,
  created boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.save_worksheet_answer_adjudication_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    target_attempt_id,
    expected_entity_version,
    target_evidence_sha256,
    target_provider_model,
    target_verdict_sha256,
    target_normalized_verdict,
    target_call_key,
    target_provider_model_version,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens,
    target_evaluator_contract_version,
    target_prompt_contract_version
  );
$$;

revoke all on function api.save_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, jsonb, text, text,
  bigint, bigint, bigint, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function api.save_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, jsonb, text, text,
  bigint, bigint, bigint, bigint, integer, integer
) to service_role;

-- Completion, needs-review holding, retry exhaustion, and Cron reconciliation
-- all terminalize the same async job row. One trigger therefore guarantees
-- that private answer-derived checkpoint evidence never outlives the job.
-- A bounded provider-outage deferral uses status retry, so a successful first
-- evaluator remains available while only the missing evaluator is redelivered.
create or replace function app_private.delete_terminal_worksheet_answer_checkpoints()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.job_kind = 'worksheet_answer_evaluation'
    and new.status in ('succeeded', 'dead')
    and old.status is distinct from new.status
  then
    delete from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.delete_terminal_worksheet_answer_checkpoints()
from public, anon, authenticated, service_role;

create trigger async_jobs_delete_terminal_worksheet_answer_checkpoints
after update of status on app_private.async_jobs
for each row execute function
  app_private.delete_terminal_worksheet_answer_checkpoints();

comment on table app_private.worksheet_answer_provider_checkpoints is
  'Private transient answer-derived Flash evaluator and Pro adjudication checkpoints. Exact job/entity/evidence/contract binding permits only missing stages to run after recovery; terminal jobs delete all rows.';
comment on function api.get_worksheet_answer_provider_checkpoints(
  uuid, bigint, uuid, uuid, integer, text, text, text, integer, integer
) is
  'Service-only active-lease read of exact entity/evidence/contract-bound worksheet-answer Flash evaluator verdicts.';
comment on function api.save_worksheet_answer_provider_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint, integer, integer
) is
  'Service-only atomic spend finalization and idempotent persistence of one validated independent worksheet-answer evaluator verdict.';
comment on function api.get_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, integer, integer
) is
  'Service-only active-lease read of the exact entity/evidence/contract-bound DeepSeek Pro worksheet-answer adjudication verdict.';
comment on function api.save_worksheet_answer_adjudication_checkpoint(
  uuid, bigint, uuid, uuid, integer, text, text, text, jsonb, text, text,
  bigint, bigint, bigint, bigint, integer, integer
) is
  'Service-only atomic spend finalization and idempotent persistence of one validated DeepSeek Pro worksheet-answer adjudication verdict.';
