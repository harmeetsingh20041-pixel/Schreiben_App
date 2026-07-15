-- Resumable worksheet generation stages.
--
-- Provider calls remain outside Postgres, but every completed provider stage
-- is durably checkpointed before the worker advances. Queue messages continue
-- to contain opaque job/entity identifiers and a version only; candidates and
-- critic evidence stay in private tables that browser roles cannot access.

create table app_private.worksheet_generation_checkpoints (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete cascade,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete cascade,
  entity_version integer not null check (entity_version > 0),
  stage text not null check (stage in (
    'primary_fallback_generation',
    'primary_critique',
    'repair_generation',
    'repair_critique',
    'completion'
  )),
  candidate_attempt smallint not null check (candidate_attempt in (1, 2)),
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload_sha256 text,
  completion_payload jsonb,
  fallback_primary_queue_message_id bigint,
  fallback_primary_worker_id uuid,
  fallback_failure_code text,
  fallback_queue_message_id bigint,
  fallback_available_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worksheet_generation_checkpoints_provider_model_check check (
    candidate_provider is null
    or (
      candidate_provider = 'deepseek'
      and candidate_model = 'deepseek-v4-pro'
    )
    or (
      candidate_provider = 'gemini'
      and candidate_model = 'gemini-3.5-flash'
    )
  ),
  constraint worksheet_generation_checkpoints_candidate_hash_check check (
    candidate_sha256 is null
    or candidate_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint worksheet_generation_checkpoints_completion_hash_check check (
    completion_payload_sha256 is null
    or completion_payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint worksheet_generation_checkpoints_candidate_size_check check (
    candidate is null
    or (
      jsonb_typeof(candidate) = 'object'
      and octet_length(candidate::text) <= 131072
    )
  ),
  constraint worksheet_generation_checkpoints_completion_size_check check (
    completion_payload is null
    or (
      jsonb_typeof(completion_payload) = 'object'
      and octet_length(completion_payload::text) <= 131072
    )
  ),
  constraint worksheet_generation_checkpoints_fallback_shape_check check (
    (
      fallback_primary_queue_message_id is null
      and fallback_primary_worker_id is null
      and fallback_failure_code is null
      and fallback_queue_message_id is null
      and fallback_available_at is null
    )
    or (
      fallback_primary_queue_message_id is not null
      and fallback_primary_worker_id is not null
      and fallback_failure_code in (
        'worksheet_provider_timeout',
        'worksheet_provider_unavailable',
        'worksheet_provider_output_truncated',
        'worksheet_provider_response_too_large',
        'worksheet_provider_response_invalid',
        'worksheet_provider_invalid_json',
        'worksheet_invalid_shape',
        'worksheet_invalid_text',
        'worksheet_invalid_array',
        'worksheet_invalid_rubric',
        'worksheet_invalid_mini_lesson',
        'worksheet_invalid_question_type',
        'worksheet_invalid_prompt',
        'worksheet_invalid_answer',
        'worksheet_ambiguous_answer',
        'worksheet_invalid_explanation',
        'worksheet_invalid_accepted_answers',
        'worksheet_ambiguous_fill_blank',
        'worksheet_invalid_options',
        'worksheet_duplicate_options',
        'worksheet_answer_not_in_options',
        'worksheet_unexpected_options',
        'worksheet_level_mismatch',
        'worksheet_difficulty_mismatch',
        'worksheet_context_mismatch',
        'worksheet_invalid_title',
        'worksheet_generic_title',
        'worksheet_invalid_questions',
        'worksheet_question_count',
        'worksheet_duplicate_questions',
        'worksheet_unsafe_question_mix'
      )
      and fallback_queue_message_id is not null
      and fallback_available_at is not null
    )
  ),
  constraint worksheet_generation_checkpoints_stage_shape_check check (
    (
      stage = 'primary_fallback_generation'
      and candidate_attempt = 1
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is null
      and completion_payload is null
      and fallback_primary_queue_message_id is not null
    )
    or (
      stage = 'primary_critique'
      and candidate_attempt = 1
      and candidate_provider is not null
      and candidate_model is not null
      and candidate_sha256 is not null
      and candidate is not null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'repair_generation'
      and candidate_attempt = 2
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'repair_critique'
      and candidate_attempt = 2
      and candidate_provider = 'gemini'
      and candidate_model = 'gemini-3.5-flash'
      and candidate_sha256 is not null
      and candidate is not null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'completion'
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is not null
      and completion_payload is not null
    )
  )
);

create index worksheet_generation_checkpoints_assignment_version_idx
on app_private.worksheet_generation_checkpoints (
  assignment_id,
  entity_version
);

-- The ordinary delivery budget remains three attempts. Worksheet generation
-- can then consume at most one durable provider-fallback continuation and one
-- durable semantic-repair continuation without resetting its attempt history.
-- Five is therefore a deliberate hard ceiling, not an open-ended retry budget.
alter table app_private.async_jobs
  drop constraint if exists async_jobs_attempt_count_check;
alter table app_private.async_jobs
  add constraint async_jobs_attempt_count_check
  check (attempt_count between 0 and 5);

alter table app_private.worksheet_generation_checkpoints
  enable row level security;

revoke all on table app_private.worksheet_generation_checkpoints
from public, anon, authenticated, service_role;

-- The first rejected candidate must survive active-checkpoint cleanup so a
-- repaired completion remains auditable and can be placed into the existing
-- private quarantine/bank-fallback contract without another provider call.
create table app_private.worksheet_generation_stage_evidence (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete cascade,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete cascade,
  entity_version integer not null check (entity_version > 0),
  candidate_attempt smallint not null check (candidate_attempt = 1),
  primary_queue_message_id bigint not null,
  primary_worker_id uuid not null,
  repair_queue_message_id bigint not null unique,
  repair_available_at timestamptz not null,
  candidate_provider text not null,
  candidate_model text not null,
  candidate_sha256 text not null check (
    candidate_sha256 ~ '^[a-f0-9]{64}$'
  ),
  rejected_candidate jsonb not null check (
    jsonb_typeof(rejected_candidate) = 'object'
    and octet_length(rejected_candidate::text) <= 131072
  ),
  rejection_payload_sha256 text not null check (
    rejection_payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  deepseek_critic_model text not null check (
    deepseek_critic_model = 'deepseek-v4-flash'
  ),
  deepseek_verdict_sha256 text not null check (
    deepseek_verdict_sha256 ~ '^[a-f0-9]{64}$'
  ),
  gemini_critic_model text not null check (
    gemini_critic_model in ('gemini-2.5-flash', 'gemini-3.5-flash')
  ),
  gemini_verdict_sha256 text not null check (
    gemini_verdict_sha256 ~ '^[a-f0-9]{64}$'
  ),
  rejection_reasons jsonb not null check (
    jsonb_typeof(rejection_reasons) = 'array'
    and jsonb_array_length(rejection_reasons) between 1 and 8
  ),
  created_at timestamptz not null default now(),
  constraint worksheet_generation_stage_evidence_provider_model_check check (
    (
      candidate_provider = 'deepseek'
      and candidate_model = 'deepseek-v4-pro'
    )
    or (
      candidate_provider = 'gemini'
      and candidate_model = 'gemini-3.5-flash'
    )
  )
);

-- PostgreSQL does not create indexes for the referencing side of foreign keys.
-- Assignment retention deletion and workspace cascades must not scan the full
-- evidence table while holding the parent assignment lock.
create index worksheet_generation_stage_evidence_assignment_id_idx
on app_private.worksheet_generation_stage_evidence (assignment_id);

alter table app_private.worksheet_generation_stage_evidence
  enable row level security;

revoke all on table app_private.worksheet_generation_stage_evidence
from public, anon, authenticated, service_role;

create trigger worksheet_generation_stage_evidence_immutable
before update
on app_private.worksheet_generation_stage_evidence
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger worksheet_generation_checkpoints_set_updated_at
before update on app_private.worksheet_generation_checkpoints
for each row execute function public.set_updated_at();

-- Validate the exact pre-critic candidate contract. This is intentionally
-- stricter than a generic JSON/object check: a checkpoint cannot smuggle
-- critic evidence, claim an unpinned model, change level, or exceed the V1
-- candidate-size bound.
create or replace function app_private.assert_worksheet_checkpoint_candidate(
  candidate jsonb,
  expected_attempt smallint,
  expected_level text,
  expected_sha256 text
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  source_name text;
  generator_model text;
  source_mix jsonb;
  validation_metadata jsonb;
  question_count integer;
begin
  if expected_attempt not in (1, 2)
    or expected_level not in ('A1', 'A2', 'B1', 'B2')
    or coalesce(expected_sha256, '') !~ '^[a-f0-9]{64}$'
    or candidate is null
    or jsonb_typeof(candidate) <> 'object'
    or octet_length(candidate::text) > 131072
    or not (candidate ?& array[
      'schema_version',
      'mode',
      'generation_source',
      'generator_model',
      'title',
      'level',
      'difficulty',
      'description',
      'mini_lesson',
      'questions',
      'source_mix',
      'validation'
    ])
    or candidate - array[
      'schema_version',
      'mode',
      'generation_source',
      'generator_model',
      'title',
      'level',
      'difficulty',
      'description',
      'mini_lesson',
      'questions',
      'source_mix',
      'validation'
    ]::text[] <> '{}'::jsonb
    or candidate ->> 'schema_version' is distinct from '1'
    or candidate ->> 'mode' is distinct from 'generated'
    or candidate ->> 'level' is distinct from expected_level
    or candidate ->> 'difficulty' not in ('easy', 'medium', 'hard')
    or length(btrim(coalesce(candidate ->> 'title', ''))) not between 1 and 120
    or length(btrim(coalesce(candidate ->> 'description', ''))) not between 1 and 1000
    or jsonb_typeof(candidate -> 'mini_lesson') <> 'object'
    or jsonb_typeof(candidate -> 'questions') <> 'array'
    or jsonb_typeof(candidate -> 'source_mix') <> 'object'
    or jsonb_typeof(candidate -> 'validation') <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_invalid';
  end if;

  source_name := candidate ->> 'generation_source';
  generator_model := candidate ->> 'generator_model';
  if not (
    (
      source_name = 'deepseek'
      and generator_model = 'deepseek-v4-pro'
    )
    or (
      source_name = 'gemini'
      and generator_model = 'gemini-3.5-flash'
    )
  ) or (
    expected_attempt = 2
    and (
      source_name <> 'gemini'
      or generator_model <> 'gemini-3.5-flash'
    )
  ) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_provenance_invalid';
  end if;

  source_mix := candidate -> 'source_mix';
  question_count := jsonb_array_length(candidate -> 'questions');
  if not (source_mix ?& array['mode', 'deepseek_count', 'gemini_count'])
    or source_mix - array[
      'mode', 'deepseek_count', 'gemini_count'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(source_mix -> 'deepseek_count') <> 'number'
    or jsonb_typeof(source_mix -> 'gemini_count') <> 'number'
    or coalesce(source_mix ->> 'deepseek_count', '') !~ '^(0|[1-9][0-9]{0,2})$'
    or coalesce(source_mix ->> 'gemini_count', '') !~ '^(0|[1-9][0-9]{0,2})$'
    or source_mix ->> 'mode' is distinct from source_name
    or question_count <> (
      case when expected_level = 'A2' then 9 else 8 end
    )
    or (
      source_name = 'deepseek'
      and (
        (source_mix ->> 'deepseek_count')::integer <> question_count
        or (source_mix ->> 'gemini_count')::integer <> 0
      )
    )
    or (
      source_name = 'gemini'
      and (
        (source_mix ->> 'deepseek_count')::integer <> 0
        or (source_mix ->> 'gemini_count')::integer <> question_count
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_provenance_invalid';
  end if;

  if not ((candidate -> 'mini_lesson') ?& array[
      'short_explanation',
      'key_rule',
      'correct_examples',
      'common_mistake_warning',
      'what_to_revise'
    ])
    or (candidate -> 'mini_lesson') - array[
      'short_explanation',
      'key_rule',
      'correct_examples',
      'common_mistake_warning',
      'what_to_revise'
    ]::text[] <> '{}'::jsonb
    or length(btrim(coalesce(
      candidate #>> '{mini_lesson,short_explanation}', ''
    ))) not between 1 and 500
    or length(btrim(coalesce(
      candidate #>> '{mini_lesson,key_rule}', ''
    ))) not between 1 and 400
    or length(btrim(coalesce(
      candidate #>> '{mini_lesson,common_mistake_warning}', ''
    ))) not between 1 and 300
    or length(btrim(coalesce(
      candidate #>> '{mini_lesson,what_to_revise}', ''
    ))) not between 1 and 300
    or jsonb_typeof(candidate #> '{mini_lesson,correct_examples}') <> 'array'
    or jsonb_array_length(candidate #> '{mini_lesson,correct_examples}') <> 2
    or exists (
      select 1
      from jsonb_array_elements(
        candidate #> '{mini_lesson,correct_examples}'
      ) example(item)
      where jsonb_typeof(example.item) <> 'string'
        or length(btrim(example.item #>> '{}')) not between 1 and 300
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_content_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(candidate -> 'questions')
      with ordinality question(item, ordinal)
    where jsonb_typeof(question.item) <> 'object'
      or not (question.item ?& array[
        'question_number',
        'question_type',
        'evaluation_mode',
        'prompt',
        'options',
        'correct_answer',
        'accepted_answers',
        'rubric',
        'explanation'
      ])
      or question.item - array[
        'question_number',
        'question_type',
        'evaluation_mode',
        'prompt',
        'options',
        'correct_answer',
        'accepted_answers',
        'rubric',
        'explanation'
      ]::text[] <> '{}'::jsonb
      or coalesce(question.item ->> 'question_number', '') !~ '^[1-9][0-9]*$'
      or (question.item ->> 'question_number')::integer <> question.ordinal
      or question.item ->> 'question_type' not in (
        'multiple_choice',
        'fill_blank',
        'sentence_correction',
        'word_order',
        'transformation',
        'rewrite_sentence'
      )
      or question.item ->> 'evaluation_mode' not in (
        'local_exact', 'open_evaluation'
      )
      or jsonb_typeof(question.item -> 'prompt') <> 'string'
      or length(btrim(question.item ->> 'prompt')) not between 12 and 800
      or jsonb_typeof(question.item -> 'options') <> 'array'
      or jsonb_typeof(question.item -> 'correct_answer') <> 'string'
      or length(btrim(question.item ->> 'correct_answer')) not between 1 and 500
      or jsonb_typeof(question.item -> 'accepted_answers') <> 'array'
      or jsonb_typeof(question.item -> 'rubric') not in ('object', 'null')
      or jsonb_typeof(question.item -> 'explanation') <> 'string'
      or length(btrim(question.item ->> 'explanation')) not between 1 and 600
  ) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_content_invalid';
  end if;

  validation_metadata := candidate -> 'validation';
  if not (validation_metadata ?& array[
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
    or validation_metadata -> 'deterministic' is distinct from 'true'::jsonb
    or validation_metadata -> 'independent_model' is distinct from 'false'::jsonb
    or validation_metadata -> 'critic_model' is distinct from 'null'::jsonb
    or validation_metadata -> 'candidate_sha256' is distinct from 'null'::jsonb
    or validation_metadata -> 'checks' is distinct from 'null'::jsonb
    or validation_metadata -> 'attempt_count'
      is distinct from to_jsonb(expected_attempt)
    or validation_metadata -> 'rejection_reasons' is distinct from '[]'::jsonb
    or validation_metadata -> 'critics' is distinct from jsonb_build_object(
      'deepseek', null,
      'gemini', null
    )
    or app_private.worksheet_candidate_sha256(candidate)
      is distinct from expected_sha256
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_candidate_validation_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_worksheet_checkpoint_candidate(
  jsonb, smallint, text, text
) from public, anon, authenticated, service_role;

-- Lock acquisition for every worker checkpoint path starts here. Holding the
-- job row first serializes queue/stage changes; holding the assignment second
-- makes the assignment cleanup trigger safe; checkpoint/evidence rows are
-- acquired only by the caller after this function returns.
create or replace function app_private.lock_worksheet_generation_context(
  target_job_id uuid,
  expected_entity_version integer
)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or expected_entity_version is null
    or expected_entity_version < 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_lease_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
    and job.queue_name = 'worksheet_generation'
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = '02000',
      message = 'worksheet_generation_job_not_found';
  end if;

  if selected_job.entity_version <> expected_entity_version then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_lease_stale';
  end if;

  perform assignment.id
  from public.student_practice_assignments assignment
  where assignment.id = selected_job.entity_id
    and assignment.generation_version = selected_job.entity_version
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_lease_stale';
  end if;

  return selected_job;
end;
$$;

revoke all on function app_private.lock_worksheet_generation_context(
  uuid, integer
) from public, anon, authenticated, service_role;

-- Ordinary jobs still receive exactly three delivery attempts. The exact
-- first message created by a durable worksheet fallback/repair transition is
-- different: it represents a new bounded provider stage and must receive one
-- fresh claim even when the ordinary budget ended at attempt three. The
-- exception is ID-bound, stage-bound, queued/retry-only, and therefore cannot
-- be reused by a generic retry or an expired processing lease.
create or replace function public.claim_async_jobs(
  target_queue_name text,
  worker_id uuid,
  batch_size integer default 1,
  visibility_timeout_seconds integer default 180
)
returns table (
  job_id uuid,
  queue_message_id bigint,
  entity_id uuid,
  entity_version integer,
  attempt_number integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_message record;
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  payload_job_id uuid;
  payload_kind text;
  payload_entity_id uuid;
  payload_entity_version integer;
  selected_worker_id uuid := worker_id;
  claim_limit integer := greatest(1, least(coalesce(batch_size, 1), 10));
  visibility_seconds integer := greatest(
    30,
    least(coalesce(visibility_timeout_seconds, 180), 600)
  );
  exact_continuation_claim boolean;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  if target_queue_name is null or target_queue_name not in (
    'writing_evaluation',
    'worksheet_generation',
    'worksheet_answer_evaluation'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported queue.';
  end if;

  for queue_message in
    select * from pgmq.read(target_queue_name, visibility_seconds, claim_limit)
  loop
    begin
      exact_continuation_claim := false;
      selected_assignment := null;

      if jsonb_typeof(queue_message.message) <> 'object'
        or exists (
          select 1
          from jsonb_object_keys(queue_message.message) payload_key
          where payload_key not in (
            'job_id', 'job_kind', 'entity_id', 'entity_version'
          )
        )
      then
        raise exception 'invalid payload';
      end if;

      payload_job_id := (queue_message.message ->> 'job_id')::uuid;
      payload_kind := queue_message.message ->> 'job_kind';
      payload_entity_id := (queue_message.message ->> 'entity_id')::uuid;
      payload_entity_version :=
        (queue_message.message ->> 'entity_version')::integer;
    exception when others then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end;

    select job.*
    into selected_job
    from app_private.async_jobs job
    where job.id = payload_job_id
      and job.queue_name = target_queue_name
      and job.queue_message_id = queue_message.msg_id
      and job.job_kind = payload_kind
      and job.entity_id = payload_entity_id
      and job.entity_version = payload_entity_version
    for update;

    if selected_job.id is null then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if selected_job.status in ('succeeded', 'dead') then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if selected_job.job_kind = 'worksheet_generation' then
      -- Job -> assignment -> checkpoint/evidence is the only worker lock order.
      select assignment.*
      into selected_assignment
      from public.student_practice_assignments assignment
      where assignment.id = selected_job.entity_id
        and assignment.generation_version = selected_job.entity_version
      for update;
    end if;

    if (
      selected_job.job_kind = 'writing_evaluation'
      and not exists (
        select 1
        from public.submissions submission
        where submission.id = selected_job.entity_id
          and submission.evaluation_version = selected_job.entity_version
      )
    ) or (
      selected_job.job_kind = 'worksheet_generation'
      and selected_assignment.id is null
    ) or (
      selected_job.job_kind = 'worksheet_answer_evaluation'
      and not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.id = selected_job.entity_id
          and attempt.evaluation_version = selected_job.entity_version
      )
    ) then
      update app_private.async_jobs job
      set
        status = 'dead',
        worker_id = null,
        lease_expires_at = null,
        dead_at = now(),
        last_error_code = 'superseded_version'
      where job.id = selected_job.id;
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if selected_job.job_kind = 'worksheet_generation'
      and selected_job.status in ('queued', 'retry')
      and selected_job.attempt_count >= 3
    then
      select coalesce(
        (
          checkpoint.assignment_id = selected_job.entity_id
          and checkpoint.entity_version = selected_job.entity_version
          and (
            (
              checkpoint.stage = 'primary_fallback_generation'
              and checkpoint.fallback_queue_message_id = queue_message.msg_id
              and selected_job.attempt_count = 3
            )
            or (
              checkpoint.stage = 'repair_generation'
              and evidence.repair_queue_message_id = queue_message.msg_id
              and selected_job.attempt_count between 3 and 4
            )
          )
        ),
        false
      )
      into exact_continuation_claim
      from app_private.worksheet_generation_checkpoints checkpoint
      left join app_private.worksheet_generation_stage_evidence evidence
        on evidence.job_id = checkpoint.job_id
       and evidence.assignment_id = checkpoint.assignment_id
       and evidence.entity_version = checkpoint.entity_version
      where checkpoint.job_id = selected_job.id;

      exact_continuation_claim := coalesce(exact_continuation_claim, false);
    end if;

    if selected_job.attempt_count >= 3
      and not exact_continuation_claim
    then
      update app_private.async_jobs job
      set
        status = 'dead',
        worker_id = null,
        lease_expires_at = null,
        dead_at = now(),
        last_error_code = coalesce(
          job.last_error_code,
          'attempts_exhausted'
        )
      where job.id = selected_job.id;

      perform app_private.set_job_entity_state(
        selected_job.job_kind,
        selected_job.entity_id,
        selected_job.entity_version,
        'failed',
        coalesce(selected_job.last_error_code, 'attempts_exhausted')
      );
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    update app_private.async_jobs job
    set
      status = 'processing',
      attempt_count = job.attempt_count + 1,
      worker_id = selected_worker_id,
      lease_expires_at = now() + make_interval(secs => visibility_seconds),
      first_started_at = coalesce(job.first_started_at, now()),
      last_started_at = now(),
      last_error_code = null
    where job.id = selected_job.id
      and job.available_at <= now()
      and (
        job.status in ('queued', 'retry')
        or (
          job.status = 'processing'
          and job.lease_expires_at <= now()
        )
      )
      and (
        job.attempt_count < 3
        or (
          exact_continuation_claim
          and job.status in ('queued', 'retry')
          and job.attempt_count between 3 and 4
        )
      )
    returning job.* into selected_job;

    if selected_job.id is null then
      continue;
    end if;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'processing',
      null
    );

    job_id := selected_job.id;
    queue_message_id := selected_job.queue_message_id;
    entity_id := selected_job.entity_id;
    entity_version := selected_job.entity_version;
    attempt_number := selected_job.attempt_count;
    lease_expires_at := selected_job.lease_expires_at;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_async_jobs(text, uuid, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_async_jobs(text, uuid, integer, integer)
to service_role;

-- Every mutating/reading checkpoint RPC revalidates this exact lease. An
-- expired lease is rejected even if no newer worker has claimed the message.
create or replace function app_private.assert_active_worksheet_generation_lease(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  expected_entity_version integer
)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or target_worker_id is null
    or expected_entity_version is null
    or expected_entity_version < 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_lease_invalid';
  end if;

  selected_job := app_private.lock_worksheet_generation_context(
    target_job_id,
    expected_entity_version
  );

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> target_worker_id
    or selected_job.lease_expires_at is null
    or selected_job.lease_expires_at <= clock_timestamp()
    or not exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id = selected_job.entity_id
        and assignment.generation_version = selected_job.entity_version
        and assignment.status in ('unlocked', 'in_progress')
        and assignment.practice_test_id is null
        and assignment.generation_status in ('queued', 'generating')
        and assignment.class_context_version = 1
        and assignment.class_context_integrity in (
          'writing_snapshot', 'teacher_verified'
        )
        and assignment.batch_id is not null
        and assignment.worksheet_level in ('A1', 'A2', 'B1', 'B2')
        and exists (
          select 1
          from public.workspace_members membership
          where membership.workspace_id = assignment.workspace_id
            and membership.user_id = assignment.student_id
            and membership.role = 'student'
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_lease_stale';
  end if;

  return selected_job;
end;
$$;

revoke all on function app_private.assert_active_worksheet_generation_lease(
  uuid, bigint, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.assert_active_worksheet_generation_lease(
  uuid, bigint, uuid, integer
) to service_role;

create or replace function app_private.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  primary_rejection jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  return query
  select
    checkpoint.job_id,
    checkpoint.assignment_id,
    checkpoint.entity_version,
    checkpoint.stage,
    checkpoint.candidate_attempt,
    checkpoint.candidate_provider,
    checkpoint.candidate_model,
    checkpoint.candidate_sha256,
    checkpoint.candidate,
    checkpoint.completion_payload,
    case
      when evidence.job_id is null then null
      else jsonb_build_object(
        'attempt_number', evidence.candidate_attempt,
        'provider', evidence.candidate_provider,
        'model', evidence.candidate_model,
        'rejection_reasons', evidence.rejection_reasons,
        'candidate', evidence.rejected_candidate
      )
    end
  from app_private.worksheet_generation_checkpoints checkpoint
  left join app_private.worksheet_generation_stage_evidence evidence
    on evidence.job_id = checkpoint.job_id
   and evidence.assignment_id = checkpoint.assignment_id
   and evidence.entity_version = checkpoint.entity_version
  where checkpoint.job_id = selected_job.id
    and checkpoint.assignment_id = selected_job.entity_id
    and checkpoint.entity_version = selected_job.entity_version;
end;
$$;

revoke all on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

create or replace function api.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  primary_rejection jsonb
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.get_worksheet_generation_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );
$$;

revoke all on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated;
grant execute on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

create or replace function app_private.save_worksheet_generation_candidate(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_candidate_attempt smallint,
  target_candidate_sha256 text,
  candidate_payload jsonb
)
returns table (
  stage text,
  candidate_attempt smallint,
  candidate_sha256 text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_checkpoint app_private.worksheet_generation_checkpoints%rowtype;
  next_stage text;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  select assignment.*
  into strict selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_job.entity_id
  for update;

  perform app_private.assert_worksheet_checkpoint_candidate(
    candidate_payload,
    target_candidate_attempt,
    selected_assignment.worksheet_level,
    target_candidate_sha256
  );

  select checkpoint.*
  into selected_checkpoint
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
  for update;

  if selected_checkpoint.job_id is not null
    and selected_checkpoint.candidate_attempt = target_candidate_attempt
    and selected_checkpoint.candidate_sha256 = target_candidate_sha256
    and selected_checkpoint.candidate is not distinct from candidate_payload
    and selected_checkpoint.stage = (
      case
        when target_candidate_attempt = 1 then 'primary_critique'
        else 'repair_critique'
      end
    )
  then
    return query select
      selected_checkpoint.stage,
      selected_checkpoint.candidate_attempt,
      selected_checkpoint.candidate_sha256,
      false;
    return;
  end if;

  if target_candidate_attempt = 1 then
    if selected_checkpoint.job_id is null then
      if candidate_payload ->> 'generation_source' <> 'deepseek'
        or candidate_payload ->> 'generator_model' <> 'deepseek-v4-pro'
      then
        raise exception using
          errcode = '55000',
          message = 'worksheet_checkpoint_primary_fallback_required';
      end if;
      next_stage := 'primary_critique';
      insert into app_private.worksheet_generation_checkpoints (
        job_id,
        assignment_id,
        entity_version,
        stage,
        candidate_attempt,
        candidate_provider,
        candidate_model,
        candidate_sha256,
        candidate
      ) values (
        selected_job.id,
        selected_job.entity_id,
        selected_job.entity_version,
        next_stage,
        1,
        candidate_payload ->> 'generation_source',
        candidate_payload ->> 'generator_model',
        target_candidate_sha256,
        candidate_payload
      );
    elsif selected_checkpoint.stage = 'primary_fallback_generation'
      and selected_checkpoint.candidate_attempt = 1
    then
      if candidate_payload ->> 'generation_source' <> 'gemini'
        or candidate_payload ->> 'generator_model' <> 'gemini-3.5-flash'
      then
        raise exception using
          errcode = '55000',
          message = 'worksheet_checkpoint_fallback_provider_invalid';
      end if;
      next_stage := 'primary_critique';
      update app_private.worksheet_generation_checkpoints checkpoint
      set
        stage = next_stage,
        candidate_provider = candidate_payload ->> 'generation_source',
        candidate_model = candidate_payload ->> 'generator_model',
        candidate_sha256 = target_candidate_sha256,
        candidate = candidate_payload,
        completion_payload_sha256 = null,
        completion_payload = null
      where checkpoint.job_id = selected_job.id;
    else
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_stage_conflict';
    end if;
  else
    if selected_checkpoint.job_id is null
      or selected_checkpoint.stage <> 'repair_generation'
      or selected_checkpoint.candidate_attempt <> 2
      or not exists (
        select 1
        from app_private.worksheet_generation_stage_evidence evidence
        where evidence.job_id = selected_job.id
          and evidence.assignment_id = selected_job.entity_id
          and evidence.entity_version = selected_job.entity_version
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_stage_conflict';
    end if;
    next_stage := 'repair_critique';
    update app_private.worksheet_generation_checkpoints checkpoint
    set
      stage = next_stage,
      candidate_provider = candidate_payload ->> 'generation_source',
      candidate_model = candidate_payload ->> 'generator_model',
      candidate_sha256 = target_candidate_sha256,
      candidate = candidate_payload,
      completion_payload_sha256 = null,
      completion_payload = null
    where checkpoint.job_id = selected_job.id;
  end if;

  return query select
    next_stage,
    target_candidate_attempt,
    target_candidate_sha256,
    true;
end;
$$;

revoke all on function app_private.save_worksheet_generation_candidate(
  uuid, bigint, uuid, integer, smallint, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.save_worksheet_generation_candidate(
  uuid, bigint, uuid, integer, smallint, text, jsonb
) to service_role;

create or replace function api.save_worksheet_generation_candidate(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_candidate_attempt smallint,
  target_candidate_sha256 text,
  candidate_payload jsonb
)
returns table (
  stage text,
  candidate_attempt smallint,
  candidate_sha256 text,
  created boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.save_worksheet_generation_candidate(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version,
    target_candidate_attempt,
    target_candidate_sha256,
    candidate_payload
  );
$$;

revoke all on function api.save_worksheet_generation_candidate(
  uuid, bigint, uuid, integer, smallint, text, jsonb
) from public, anon, authenticated;
grant execute on function api.save_worksheet_generation_candidate(
  uuid, bigint, uuid, integer, smallint, text, jsonb
) to service_role;

-- An eligible primary-generator failure (transient transport failure or
-- bounded invalid/oversized output) is a completed delivery stage, not a
-- semantic candidate rejection. Move it to an immediately durable Gemini
-- fallback message so the secondary generator receives a fresh runtime budget
-- without inventing rejection evidence or consuming a second candidate slot.
create or replace function app_private.advance_worksheet_generation_fallback(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  primary_failure_code text
)
returns table (
  job_id uuid,
  next_queue_message_id bigint,
  stage text,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_checkpoint app_private.worksheet_generation_checkpoints%rowtype;
  next_message_id bigint;
  archived_message boolean;
  transition_at timestamptz := now();
begin
  perform app_private.assert_service_role();

  if primary_failure_code not in (
    'worksheet_provider_timeout',
    'worksheet_provider_unavailable',
    'worksheet_provider_output_truncated',
    'worksheet_provider_response_too_large',
    'worksheet_provider_response_invalid',
    'worksheet_provider_invalid_json',
    'worksheet_invalid_shape',
    'worksheet_invalid_text',
    'worksheet_invalid_array',
    'worksheet_invalid_rubric',
    'worksheet_invalid_mini_lesson',
    'worksheet_invalid_question_type',
    'worksheet_invalid_prompt',
    'worksheet_invalid_answer',
    'worksheet_ambiguous_answer',
    'worksheet_invalid_explanation',
    'worksheet_invalid_accepted_answers',
    'worksheet_ambiguous_fill_blank',
    'worksheet_invalid_options',
    'worksheet_duplicate_options',
    'worksheet_answer_not_in_options',
    'worksheet_unexpected_options',
    'worksheet_level_mismatch',
    'worksheet_difficulty_mismatch',
    'worksheet_context_mismatch',
    'worksheet_invalid_title',
    'worksheet_generic_title',
    'worksheet_invalid_questions',
    'worksheet_question_count',
    'worksheet_duplicate_questions',
    'worksheet_unsafe_question_mix'
  ) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_primary_failure_invalid';
  end if;

  if target_job_id is null
    or target_queue_message_id is null
    or worker_id is null
    or expected_entity_version is null
    or expected_entity_version < 1
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_lease_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'worksheet-generation-fallback:' || target_job_id::text,
    0
  ));

  selected_job := app_private.lock_worksheet_generation_context(
    target_job_id,
    expected_entity_version
  );

  select checkpoint.*
  into selected_checkpoint
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = target_job_id
  for update;

  if selected_checkpoint.job_id is not null
    and selected_checkpoint.fallback_primary_queue_message_id is not null
  then
    if selected_checkpoint.assignment_id <> selected_job.entity_id
      or selected_checkpoint.entity_version <> expected_entity_version
      or selected_checkpoint.fallback_primary_queue_message_id
        <> target_queue_message_id
      or selected_checkpoint.fallback_primary_worker_id <> worker_id
      or selected_checkpoint.fallback_failure_code <> primary_failure_code
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_fallback_replay_mismatch';
    end if;

    return query select
      selected_job.id,
      selected_checkpoint.fallback_queue_message_id,
      selected_checkpoint.stage,
      selected_job.status,
      selected_job.attempt_count,
      case
        when selected_job.status = 'retry' then selected_job.available_at
        else selected_checkpoint.fallback_available_at
      end,
      true;
    return;
  elsif selected_checkpoint.job_id is not null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_stage_conflict';
  end if;

  -- Revalidate the exact active lease after locking job -> assignment ->
  -- checkpoint. This preserves replay support without allowing a stale worker
  -- to create the first fallback transition.
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  select sent.message_id
  into next_message_id
  from pgmq.send(
    selected_job.queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    0
  ) as sent(message_id);

  if next_message_id is null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_fallback_enqueue_failed';
  end if;

  select pgmq.archive(
    selected_job.queue_name,
    selected_job.queue_message_id
  ) into archived_message;

  if not coalesce(archived_message, false) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_fallback_archive_failed';
  end if;

  insert into app_private.worksheet_generation_checkpoints (
    job_id,
    assignment_id,
    entity_version,
    stage,
    candidate_attempt,
    fallback_primary_queue_message_id,
    fallback_primary_worker_id,
    fallback_failure_code,
    fallback_queue_message_id,
    fallback_available_at
  ) values (
    selected_job.id,
    selected_job.entity_id,
    selected_job.entity_version,
    'primary_fallback_generation',
    1,
    selected_job.queue_message_id,
    worker_id,
    primary_failure_code,
    next_message_id,
    transition_at
  );

  update app_private.async_jobs job
  set
    status = 'retry',
    queue_message_id = next_message_id,
    worker_id = null,
    lease_expires_at = null,
    available_at = transition_at,
    last_error_code = primary_failure_code
  where job.id = selected_job.id
  returning job.* into selected_job;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'queued',
    null
  );

  return query select
    selected_job.id,
    next_message_id,
    'primary_fallback_generation'::text,
    selected_job.status,
    selected_job.attempt_count,
    selected_job.available_at,
    false;
end;
$$;

revoke all on function app_private.advance_worksheet_generation_fallback(
  uuid, bigint, uuid, integer, text
) from public, anon, authenticated, service_role;
grant execute on function app_private.advance_worksheet_generation_fallback(
  uuid, bigint, uuid, integer, text
) to service_role;

create or replace function api.advance_worksheet_generation_fallback(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  primary_failure_code text
)
returns table (
  job_id uuid,
  next_queue_message_id bigint,
  stage text,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.advance_worksheet_generation_fallback(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version,
    primary_failure_code
  );
$$;

revoke all on function api.advance_worksheet_generation_fallback(
  uuid, bigint, uuid, integer, text
) from public, anon, authenticated;
grant execute on function api.advance_worksheet_generation_fallback(
  uuid, bigint, uuid, integer, text
) to service_role;

create or replace function app_private.advance_worksheet_generation_repair(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  rejected_candidate_payload jsonb
)
returns table (
  job_id uuid,
  next_queue_message_id bigint,
  stage text,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_checkpoint app_private.worksheet_generation_checkpoints%rowtype;
  recorded_evidence app_private.worksheet_generation_stage_evidence%rowtype;
  next_message_id bigint;
  rejection_sha256 text;
  archived_message boolean;
  rejection_reasons jsonb;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or worker_id is null
    or expected_entity_version is null
    or expected_entity_version < 1
    or rejected_candidate_payload is null
    or jsonb_typeof(rejected_candidate_payload) <> 'object'
    or octet_length(rejected_candidate_payload::text) > 131072
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_rejection_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'worksheet-generation-repair:' || target_job_id::text,
    0
  ));

  rejection_sha256 := encode(
    sha256(convert_to(
      app_private.canonical_jsonb_text(rejected_candidate_payload),
      'UTF8'
    )),
    'hex'
  );

  selected_job := app_private.lock_worksheet_generation_context(
    target_job_id,
    expected_entity_version
  );

  select checkpoint.*
  into selected_checkpoint
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
  for update;

  -- A client may retry after the committed transition response was lost. The
  -- immutable message/worker/payload tuple proves this is the exact replay.
  -- Evidence is deliberately locked after job, assignment, and checkpoint.
  select evidence.*
  into recorded_evidence
  from app_private.worksheet_generation_stage_evidence evidence
  where evidence.job_id = target_job_id
  for share;

  if recorded_evidence.job_id is not null then
    if recorded_evidence.primary_queue_message_id <> target_queue_message_id
      or recorded_evidence.primary_worker_id <> worker_id
      or recorded_evidence.entity_version <> expected_entity_version
      or recorded_evidence.assignment_id <> selected_job.entity_id
      or selected_checkpoint.job_id is null
      or selected_checkpoint.assignment_id <> selected_job.entity_id
      or selected_checkpoint.entity_version <> expected_entity_version
      or recorded_evidence.rejection_payload_sha256 <> rejection_sha256
      or recorded_evidence.rejected_candidate
        is distinct from rejected_candidate_payload
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_repair_replay_mismatch';
    end if;

    return query select
      selected_job.id,
      recorded_evidence.repair_queue_message_id,
      selected_checkpoint.stage,
      selected_job.status,
      selected_job.attempt_count,
      case
        when selected_job.status = 'retry' then selected_job.available_at
        else recorded_evidence.repair_available_at
      end,
      true;
    return;
  end if;

  -- Revalidate the active lease only after establishing the shared lock order.
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  if selected_checkpoint.job_id is null
    or selected_checkpoint.stage <> 'primary_critique'
    or selected_checkpoint.candidate_attempt <> 1
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_stage_conflict';
  end if;

  perform app_private.assert_worksheet_critics_v2(
    rejected_candidate_payload
  );
  perform 1
  from app_private.normalize_worksheet_generation_provenance_v2(
    rejected_candidate_payload
  );

  rejection_reasons :=
    rejected_candidate_payload #> '{validation,rejection_reasons}';
  if rejected_candidate_payload #>> '{validation,attempt_count}'
      is distinct from '1'
    or rejected_candidate_payload #>> '{validation,independent_model}'
      is distinct from 'false'
    or rejected_candidate_payload #>> '{validation,candidate_sha256}'
      is distinct from selected_checkpoint.candidate_sha256
    or app_private.worksheet_candidate_sha256(rejected_candidate_payload)
      is distinct from selected_checkpoint.candidate_sha256
    or rejected_candidate_payload - 'validation'
      is distinct from selected_checkpoint.candidate - 'validation'
    or rejected_candidate_payload ->> 'generation_source'
      is distinct from selected_checkpoint.candidate_provider
    or rejected_candidate_payload ->> 'generator_model'
      is distinct from selected_checkpoint.candidate_model
    or jsonb_typeof(rejection_reasons) <> 'array'
    or jsonb_array_length(rejection_reasons) not between 1 and 8
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_rejection_invalid';
  end if;

  select sent.message_id
  into next_message_id
  from pgmq.send(
    selected_job.queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    0
  ) as sent(message_id);

  if next_message_id is null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_repair_enqueue_failed';
  end if;

  select pgmq.archive(
    selected_job.queue_name,
    selected_job.queue_message_id
  ) into archived_message;

  if not coalesce(archived_message, false) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_repair_archive_failed';
  end if;

  insert into app_private.worksheet_generation_stage_evidence (
    job_id,
    assignment_id,
    entity_version,
    candidate_attempt,
    primary_queue_message_id,
    primary_worker_id,
    repair_queue_message_id,
    repair_available_at,
    candidate_provider,
    candidate_model,
    candidate_sha256,
    rejected_candidate,
    rejection_payload_sha256,
    deepseek_critic_model,
    deepseek_verdict_sha256,
    gemini_critic_model,
    gemini_verdict_sha256,
    rejection_reasons
  ) values (
    selected_job.id,
    selected_job.entity_id,
    selected_job.entity_version,
    1,
    selected_job.queue_message_id,
    worker_id,
    next_message_id,
    clock_timestamp(),
    selected_checkpoint.candidate_provider,
    selected_checkpoint.candidate_model,
    selected_checkpoint.candidate_sha256,
    rejected_candidate_payload,
    rejection_sha256,
    rejected_candidate_payload #>> '{validation,critics,deepseek,model}',
    rejected_candidate_payload #>> '{validation,critics,deepseek,verdict_sha256}',
    rejected_candidate_payload #>> '{validation,critics,gemini,model}',
    rejected_candidate_payload #>> '{validation,critics,gemini,verdict_sha256}',
    rejection_reasons
  );

  update app_private.worksheet_generation_checkpoints checkpoint
  set
    stage = 'repair_generation',
    candidate_attempt = 2,
    candidate_provider = null,
    candidate_model = null,
    candidate_sha256 = null,
    candidate = null,
    completion_payload_sha256 = null,
    completion_payload = null
  where checkpoint.job_id = selected_job.id;

  update app_private.async_jobs job
  set
    status = 'retry',
    queue_message_id = next_message_id,
    worker_id = null,
    lease_expires_at = null,
    available_at = now(),
    last_error_code = 'worksheet_repair_required'
  where job.id = selected_job.id
  returning job.* into selected_job;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'queued',
    null
  );

  return query select
    selected_job.id,
    next_message_id,
    'repair_generation'::text,
    selected_job.status,
    selected_job.attempt_count,
    selected_job.available_at,
    false;
end;
$$;

revoke all on function app_private.advance_worksheet_generation_repair(
  uuid, bigint, uuid, integer, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.advance_worksheet_generation_repair(
  uuid, bigint, uuid, integer, jsonb
) to service_role;

create or replace function api.advance_worksheet_generation_repair(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  rejected_candidate_payload jsonb
)
returns table (
  job_id uuid,
  next_queue_message_id bigint,
  stage text,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.advance_worksheet_generation_repair(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version,
    rejected_candidate_payload
  );
$$;

revoke all on function api.advance_worksheet_generation_repair(
  uuid, bigint, uuid, integer, jsonb
) from public, anon, authenticated;
grant execute on function api.advance_worksheet_generation_repair(
  uuid, bigint, uuid, integer, jsonb
) to service_role;

create or replace function app_private.save_worksheet_generation_completion(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_completion_payload jsonb
)
returns table (
  stage text,
  completion_sha256 text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_checkpoint app_private.worksheet_generation_checkpoints%rowtype;
  payload_sha256 text;
  expected_attempt smallint;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  if target_completion_payload is null
    or jsonb_typeof(target_completion_payload) <> 'object'
    or octet_length(target_completion_payload::text) > 131072
    or target_completion_payload ->> 'mode' is distinct from 'generated'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_completion_invalid';
  end if;

  payload_sha256 := encode(
    sha256(convert_to(
      app_private.canonical_jsonb_text(target_completion_payload),
      'UTF8'
    )),
    'hex'
  );

  select checkpoint.*
  into selected_checkpoint
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
  for update;

  if selected_checkpoint.job_id is null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_stage_conflict';
  end if;

  if selected_checkpoint.stage = 'completion' then
    if selected_checkpoint.completion_payload_sha256 <> payload_sha256
      or selected_checkpoint.completion_payload
        is distinct from target_completion_payload
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_completion_replay_mismatch';
    end if;

    return query select
      'completion'::text,
      selected_checkpoint.completion_payload_sha256,
      true;
    return;
  end if;

  if selected_checkpoint.stage not in (
    'primary_critique', 'repair_critique'
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_stage_conflict';
  end if;

  expected_attempt := case
    when selected_checkpoint.stage = 'primary_critique' then 1
    else 2
  end;

  perform app_private.assert_worksheet_critics_v2(target_completion_payload);
  perform 1
  from app_private.normalize_worksheet_generation_provenance_v2(
    target_completion_payload
  );

  if target_completion_payload #>> '{validation,attempt_count}'
      is distinct from expected_attempt::text
    or target_completion_payload #>> '{validation,candidate_sha256}'
      is distinct from selected_checkpoint.candidate_sha256
    or app_private.worksheet_candidate_sha256(target_completion_payload)
      is distinct from selected_checkpoint.candidate_sha256
    or target_completion_payload - 'validation'
      is distinct from selected_checkpoint.candidate - 'validation'
    or (
      expected_attempt = 1
      and target_completion_payload #>> '{validation,independent_model}'
        is distinct from 'true'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_completion_invalid';
  end if;

  update app_private.worksheet_generation_checkpoints checkpoint
  set
    stage = 'completion',
    candidate_provider = null,
    candidate_model = null,
    candidate_sha256 = null,
    candidate = null,
    completion_payload_sha256 = payload_sha256,
    completion_payload = target_completion_payload
  where checkpoint.job_id = selected_job.id;

  return query select 'completion'::text, payload_sha256, false;
end;
$$;

revoke all on function app_private.save_worksheet_generation_completion(
  uuid, bigint, uuid, integer, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.save_worksheet_generation_completion(
  uuid, bigint, uuid, integer, jsonb
) to service_role;

create or replace function api.save_worksheet_generation_completion(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_completion_payload jsonb
)
returns table (
  stage text,
  completion_sha256 text,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.save_worksheet_generation_completion(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version,
    target_completion_payload
  );
$$;

revoke all on function api.save_worksheet_generation_completion(
  uuid, bigint, uuid, integer, jsonb
) from public, anon, authenticated;
grant execute on function api.save_worksheet_generation_completion(
  uuid, bigint, uuid, integer, jsonb
) to service_role;

-- Explicit cleanup is safe only after the job or assignment has already left
-- the active generation state. Live work cannot be erased through this RPC.
create or replace function app_private.clear_worksheet_generation_checkpoint(
  target_job_id uuid,
  expected_entity_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  deleted_count integer;
begin
  perform app_private.assert_service_role();

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
  for update;

  if selected_job.id is null then
    return false;
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_job.entity_id
  for update;

  if selected_job.entity_version = expected_entity_version
    and selected_job.status not in ('succeeded', 'dead')
    and selected_assignment.id is not null
    and selected_assignment.generation_version = expected_entity_version
    and selected_assignment.status in ('unlocked', 'in_progress')
    and selected_assignment.practice_test_id is null
    and selected_assignment.generation_status in ('queued', 'generating')
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_still_active';
  end if;

  delete from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
    and checkpoint.entity_version = expected_entity_version;
  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

revoke all on function app_private.clear_worksheet_generation_checkpoint(
  uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.clear_worksheet_generation_checkpoint(
  uuid, integer
) to service_role;

create or replace function api.clear_worksheet_generation_checkpoint(
  target_job_id uuid,
  expected_entity_version integer
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select app_private.clear_worksheet_generation_checkpoint(
    target_job_id,
    expected_entity_version
  );
$$;

revoke all on function api.clear_worksheet_generation_checkpoint(
  uuid, integer
) from public, anon, authenticated;
grant execute on function api.clear_worksheet_generation_checkpoint(
  uuid, integer
) to service_role;

create or replace function app_private.cleanup_worksheet_generation_checkpoint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'async_jobs' then
    if new.job_kind = 'worksheet_generation'
      and new.status in ('succeeded', 'dead')
      and old.status is distinct from new.status
    then
      -- The firing UPDATE already holds the job row. Lock the assignment next
      -- so terminal cleanup follows the same job -> assignment -> checkpoint
      -- order as every live worker transition.
      perform assignment.id
      from public.student_practice_assignments assignment
      where assignment.id = new.entity_id
        and assignment.generation_version = new.entity_version
      for update;

      delete from app_private.worksheet_generation_checkpoints checkpoint
      where checkpoint.job_id = new.id;
    end if;
  elsif tg_table_name = 'student_practice_assignments' then
    if new.generation_version is distinct from old.generation_version
      or new.status not in ('unlocked', 'in_progress')
      or new.practice_test_id is not null
      or new.generation_status not in ('queued', 'generating')
    then
      delete from app_private.worksheet_generation_checkpoints checkpoint
      where checkpoint.assignment_id = new.id
        and (
          checkpoint.entity_version <> new.generation_version
          or new.status not in ('unlocked', 'in_progress')
          or new.practice_test_id is not null
          or new.generation_status not in ('queued', 'generating')
        );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.cleanup_worksheet_generation_checkpoint()
from public, anon, authenticated, service_role;

create trigger async_jobs_cleanup_worksheet_generation_checkpoint
after update of status on app_private.async_jobs
for each row execute function app_private.cleanup_worksheet_generation_checkpoint();

create trigger practice_assignments_cleanup_worksheet_generation_checkpoint
after update of generation_version, generation_status, status, practice_test_id
on public.student_practice_assignments
for each row execute function app_private.cleanup_worksheet_generation_checkpoint();

comment on table app_private.worksheet_generation_checkpoints is
  'Private resumable worksheet stage state. Candidate content never enters PGMQ or browser-readable schemas and is deleted after terminal/cancelled/superseded work.';
comment on table app_private.worksheet_generation_stage_evidence is
  'Private update-immutable first-rejection evidence retained after repair for audit, with lifecycle deletion inherited from its parent job or assignment for retention/privacy cleanup.';
comment on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) is
  'Service-only exact-lease loader. No returned row means primary_generation; persisted stages resume without repeating completed provider work.';
comment on function api.advance_worksheet_generation_repair(
  uuid, bigint, uuid, integer, jsonb
) is
  'Atomically records a valid first dual-critic rejection, archives the current ID-only queue message, and enqueues an immediately claimable ID-only repair stage.';
comment on function api.advance_worksheet_generation_fallback(
  uuid, bigint, uuid, integer, text
) is
  'Atomically converts one pinned eligible DeepSeek primary failure (transient transport or bounded invalid/oversized output) into an immediately claimable ID-only Gemini fallback stage without recording semantic rejection evidence.';

notify pgrst, 'reload schema';
