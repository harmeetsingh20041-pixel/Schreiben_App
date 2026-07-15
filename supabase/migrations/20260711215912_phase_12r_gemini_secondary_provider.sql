-- Phase 12R: Gemini secondary-provider provenance and bounded AI spend.
--
-- New provider evidence is schema-versioned and pinned to the launch models:
--   * Gemini 3.1 Flash-Lite for semantic worksheet answers;
--   * Gemini 2.5 Flash for routine independent criticism; and
--   * Gemini 3.5 Flash for strong/final/fallback work.
--
-- Phase 12E/12I/12L/12M/12N OpenAI evidence remains immutable historical
-- data. The Phase 12R facades permit it only for exact redelivery of a job
-- that already succeeded before this migration. No new OpenAI evidence can
-- cross a completion boundary.

-- Truthful public provenance values retain historical OpenAI rows while
-- admitting Gemini rows created only through the service-only facades below.
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
    'gemini',
    'fixture',
    'system_fallback',
    'certified_bank'
  )) not valid;

alter table public.practice_tests
  validate constraint practice_tests_generation_source_check;

alter table public.practice_attempt_question_reviews
  drop constraint if exists practice_attempt_question_reviews_evaluator_source_check;

alter table public.practice_attempt_question_reviews
  add constraint practice_attempt_question_reviews_evaluator_source_check
  check (
    evaluator_source in (
      'deepseek', 'openai', 'gemini', 'teacher', 'manual', 'system'
    )
  ) not valid;

alter table public.practice_attempt_question_reviews
  validate constraint practice_attempt_question_reviews_evaluator_source_check;

alter table app_private.worksheet_generation_rejections
  drop constraint if exists worksheet_generation_rejections_provider_check;

alter table app_private.worksheet_generation_rejections
  add constraint worksheet_generation_rejections_provider_check
  check (provider in ('deepseek', 'openai', 'gemini')) not valid;

alter table app_private.worksheet_generation_rejections
  validate constraint worksheet_generation_rejections_provider_check;

create or replace function app_private.populate_practice_test_approval_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.worksheet_template_revision_id is not null then
    if new.generation_source <> 'certified_bank'
      or not new.teacher_reviewed
      or new.created_by_ai
      or new.quality_status <> 'approved'
    then
      raise exception using
        errcode = '23514',
        message = 'certified_template_approval_source_invalid';
    end if;
    new.approval_source := 'certified_template_bank';
  elsif new.quality_status = 'approved' and new.teacher_reviewed then
    new.approval_source := 'workspace_human_review';
  elsif new.quality_status = 'approved'
    and new.created_by_ai
    and new.generation_source in ('deepseek', 'openai', 'gemini')
  then
    new.approval_source := 'independent_model_validation';
  else
    new.approval_source := null;
  end if;

  return new;
end;
$$;

revoke all on function app_private.populate_practice_test_approval_source()
from public, anon, authenticated, service_role;

alter table public.practice_tests
  drop constraint if exists practice_tests_approval_source_truth_check;

alter table public.practice_tests
  add constraint practice_tests_approval_source_truth_check
  check (
    approval_source is null
    or (
      approval_source = 'workspace_human_review'
      and teacher_reviewed
      and quality_status = 'approved'
      and worksheet_template_revision_id is null
    )
    or (
      approval_source = 'independent_model_validation'
      and created_by_ai
      and not teacher_reviewed
      and generation_source in ('deepseek', 'openai', 'gemini')
      and quality_status = 'approved'
      and worksheet_template_revision_id is null
    )
    or approval_source = 'certified_template_bank'
  ) not valid;

alter table public.practice_tests
  validate constraint practice_tests_approval_source_truth_check;

-- ---------------------------------------------------------------------------
-- Writing adjudication v2. The Phase 12M table remains untouched for exact
-- historical replay; all new Gemini evidence is written to this v2 ledger.
-- ---------------------------------------------------------------------------

create table app_private.writing_feedback_adjudications_v2 (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  submission_id uuid not null
    references public.submissions(id) on delete restrict,
  evaluation_version integer not null check (evaluation_version > 0),
  feedback_version integer not null check (feedback_version > 0),
  schema_version smallint not null check (schema_version = 2),
  decision text not null check (
    decision in ('accepted_model_feedback', 'system_hold')
  ),
  reason_code text not null check (reason_code in (
    'critic_approved',
    'final_critic_approved',
    'generator_not_configured',
    'generator_authentication_failed',
    'generator_not_primary',
    'generator_invalid',
    'critic_not_configured',
    'critic_authentication_failed',
    'critic_invalid',
    'critic_hash_mismatch',
    'critic_disagreed',
    'critic_uncertain',
    'adjudicator_not_configured',
    'adjudicator_authentication_failed',
    'adjudicator_invalid',
    'adjudicator_hash_mismatch',
    'adjudicator_unresolved',
    'final_critic_not_configured',
    'final_critic_authentication_failed',
    'final_critic_invalid',
    'final_critic_hash_mismatch',
    'final_critic_disagreed',
    'final_critic_uncertain'
  )),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  original_text_sha256 text not null
    check (original_text_sha256 ~ '^[0-9a-f]{64}$'),
  final_feedback_sha256 text not null
    check (final_feedback_sha256 ~ '^[0-9a-f]{64}$'),
  generator_provider text not null
    check (generator_provider in ('deepseek', 'gemini')),
  generator_model text not null,
  candidate_feedback_sha256 text check (
    candidate_feedback_sha256 is null
    or candidate_feedback_sha256 ~ '^[0-9a-f]{64}$'
  ),
  candidate_release_sha256 text check (
    candidate_release_sha256 is null
    or candidate_release_sha256 ~ '^[0-9a-f]{64}$'
  ),
  critic_provider text check (
    critic_provider is null or critic_provider = 'gemini'
  ),
  critic_model text,
  critic_verdict text check (
    critic_verdict is null
    or critic_verdict in ('approved', 'disagreed', 'uncertain')
  ),
  critic_decision_sha256 text check (
    critic_decision_sha256 is null
    or critic_decision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  adjudicator_provider text check (
    adjudicator_provider is null or adjudicator_provider = 'deepseek'
  ),
  adjudicator_model text,
  adjudicator_verdict text check (
    adjudicator_verdict is null
    or adjudicator_verdict in ('resolved', 'system_hold')
  ),
  adjudicator_decision_sha256 text check (
    adjudicator_decision_sha256 is null
    or adjudicator_decision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  resolved_feedback_sha256 text check (
    resolved_feedback_sha256 is null
    or resolved_feedback_sha256 ~ '^[0-9a-f]{64}$'
  ),
  final_critic_provider text check (
    final_critic_provider is null or final_critic_provider = 'gemini'
  ),
  final_critic_model text,
  final_critic_verdict text check (
    final_critic_verdict is null
    or final_critic_verdict in ('approved', 'disagreed', 'uncertain')
  ),
  final_critic_decision_sha256 text check (
    final_critic_decision_sha256 is null
    or final_critic_decision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  accepted_provider text check (
    accepted_provider is null or accepted_provider = 'deepseek'
  ),
  accepted_model text,
  created_at timestamptz not null default now(),
  unique (submission_id, evaluation_version),
  constraint writing_feedback_adjudications_v2_versions_match check (
    evaluation_version = feedback_version
  ),
  constraint writing_feedback_adjudications_v2_generator_model_check check (
    (
      generator_provider = 'deepseek'
      and generator_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
    )
    or (
      generator_provider = 'gemini'
      and generator_model = 'gemini-3.5-flash'
    )
  ),
  constraint writing_feedback_adjudications_v2_critic_shape_check check (
    coalesce((
      (
        critic_provider is null
        and critic_model is null
        and critic_verdict is null
        and critic_decision_sha256 is null
      )
      or (
        critic_provider = 'gemini'
        and critic_model = 'gemini-2.5-flash'
      )
    ), false)
  ),
  constraint writing_feedback_adjudications_v2_adjudicator_shape_check check (
    coalesce((
      (
        adjudicator_provider is null
        and adjudicator_model is null
        and adjudicator_verdict is null
        and adjudicator_decision_sha256 is null
      )
      or (
        adjudicator_provider = 'deepseek'
        and adjudicator_model = 'deepseek-v4-pro'
      )
    ), false)
  ),
  constraint writing_feedback_adjudications_v2_final_critic_shape_check check (
    coalesce((
      (
        final_critic_provider is null
        and final_critic_model is null
        and final_critic_verdict is null
        and final_critic_decision_sha256 is null
      )
      or (
        final_critic_provider = 'gemini'
        and final_critic_model = 'gemini-3.5-flash'
      )
    ), false)
  ),
  constraint writing_feedback_adjudications_v2_decision_shape_check check (
    coalesce((
      (
        decision = 'system_hold'
        and reason_code not in ('critic_approved', 'final_critic_approved')
        and accepted_provider is null
        and accepted_model is null
      )
      or (
        decision = 'accepted_model_feedback'
        and accepted_provider = 'deepseek'
        and candidate_feedback_sha256 is not null
        and candidate_release_sha256 is not null
        and (
          (
            reason_code = 'critic_approved'
            and generator_provider = 'deepseek'
            and accepted_model = generator_model
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'gemini'
            and critic_model = 'gemini-2.5-flash'
            and critic_verdict = 'approved'
            and critic_decision_sha256 is not null
            and adjudicator_provider is null
            and adjudicator_model is null
            and adjudicator_verdict is null
            and adjudicator_decision_sha256 is null
            and resolved_feedback_sha256 is null
            and final_critic_provider is null
            and final_critic_model is null
            and final_critic_verdict is null
            and final_critic_decision_sha256 is null
          )
          or (
            reason_code = 'final_critic_approved'
            and generator_provider = 'deepseek'
            and generator_model = 'deepseek-v4-flash'
            and accepted_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
            and critic_provider = 'gemini'
            and critic_model = 'gemini-2.5-flash'
            and critic_verdict in ('disagreed', 'uncertain')
            and critic_decision_sha256 is not null
            and adjudicator_provider = 'deepseek'
            and adjudicator_model = 'deepseek-v4-pro'
            and adjudicator_verdict = 'resolved'
            and adjudicator_decision_sha256 is not null
            and resolved_feedback_sha256 is not null
            and final_critic_provider = 'gemini'
            and final_critic_model = 'gemini-3.5-flash'
            and final_critic_verdict = 'approved'
            and final_critic_decision_sha256 is not null
            and (
              (
                accepted_model = 'deepseek-v4-flash'
                and resolved_feedback_sha256 = candidate_feedback_sha256
                and final_feedback_sha256 = candidate_release_sha256
              )
              or (
                accepted_model = 'deepseek-v4-pro'
                and resolved_feedback_sha256 <> candidate_feedback_sha256
                and final_feedback_sha256 <> candidate_release_sha256
              )
            )
          )
        )
      )
    ), false)
  )
);

alter table app_private.writing_feedback_adjudications_v2
  enable row level security;

revoke all on table app_private.writing_feedback_adjudications_v2
from public, anon, authenticated, service_role;

create trigger writing_feedback_adjudications_v2_immutable
before update or delete on app_private.writing_feedback_adjudications_v2
for each row execute function app_private.reject_writing_adjudication_mutation();

create or replace function app_private.record_or_assert_writing_adjudication_v2(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  feedback jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_submission public.submissions%rowtype;
  selected_context app_private.writing_evaluation_contexts%rowtype;
  selected_evidence app_private.writing_feedback_adjudications_v2%rowtype;
  evidence jsonb;
  evidence_key_count integer;
  computed_final_sha256 text;
begin
  perform app_private.assert_service_role();

  if feedback is null
    or coalesce(jsonb_typeof(feedback) <> 'object', true)
    or coalesce(jsonb_typeof(feedback -> 'evaluation_evidence') <> 'object', true)
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  evidence := feedback -> 'evaluation_evidence';
  select count(*)::integer
  into evidence_key_count
  from jsonb_object_keys(evidence) evidence_key(value);

  if evidence_key_count <> 25
    or exists (
      select 1
      from jsonb_object_keys(evidence) evidence_key(value)
      where evidence_key.value not in (
        'schema_version', 'decision', 'reason_code', 'context_sha256',
        'original_text_sha256', 'final_feedback_sha256',
        'generator_provider', 'generator_model',
        'candidate_feedback_sha256', 'candidate_release_sha256',
        'critic_provider', 'critic_model', 'critic_verdict',
        'critic_decision_sha256', 'adjudicator_provider',
        'adjudicator_model', 'adjudicator_verdict',
        'adjudicator_decision_sha256', 'resolved_feedback_sha256',
        'final_critic_provider', 'final_critic_model',
        'final_critic_verdict', 'final_critic_decision_sha256',
        'accepted_provider', 'accepted_model'
      )
    )
    or evidence -> 'schema_version' is distinct from '2'::jsonb
    or coalesce(evidence ->> 'context_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(evidence ->> 'original_text_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(evidence ->> 'final_feedback_sha256', '') !~ '^[0-9a-f]{64}$'
    or (
      evidence ->> 'candidate_feedback_sha256' is not null
      and evidence ->> 'candidate_feedback_sha256' !~ '^[0-9a-f]{64}$'
    )
    or (
      evidence ->> 'candidate_release_sha256' is not null
      and evidence ->> 'candidate_release_sha256' !~ '^[0-9a-f]{64}$'
    )
    or (
      evidence ->> 'critic_decision_sha256' is not null
      and evidence ->> 'critic_decision_sha256' !~ '^[0-9a-f]{64}$'
    )
    or (
      evidence ->> 'adjudicator_decision_sha256' is not null
      and evidence ->> 'adjudicator_decision_sha256' !~ '^[0-9a-f]{64}$'
    )
    or (
      evidence ->> 'resolved_feedback_sha256' is not null
      and evidence ->> 'resolved_feedback_sha256' !~ '^[0-9a-f]{64}$'
    )
    or (
      evidence ->> 'final_critic_decision_sha256' is not null
      and evidence ->> 'final_critic_decision_sha256' !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.job_kind <> 'writing_evaluation'
  then
    raise exception using
      errcode = '02000',
      message = 'Writing evaluation job not found.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = selected_job.entity_id
  for update;

  if selected_submission.id is null then
    raise exception using errcode = '02000', message = 'Submission not found.';
  end if;

  if selected_job.status not in ('processing', 'succeeded')
    or selected_job.queue_message_id is distinct from target_queue_message_id
    or selected_job.entity_version <> selected_submission.evaluation_version
    or (
      selected_job.status = 'processing'
      and selected_job.worker_id is distinct from target_worker_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Job lease is no longer active.';
  end if;

  select adjudication.*
  into selected_evidence
  from app_private.writing_feedback_adjudications_v2 adjudication
  where adjudication.job_id = selected_job.id;

  if selected_job.status = 'succeeded'
    and selected_evidence.job_id is null
  then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_missing_on_replay';
  end if;

  select context.*
  into selected_context
  from app_private.writing_evaluation_contexts context
  where context.submission_id = selected_submission.id
    and context.workspace_id = selected_submission.workspace_id
    and context.student_id = selected_submission.student_id
    and context.batch_id = selected_submission.batch_id
    and context.source_type = selected_submission.question_source
    and context.submission_mode = selected_submission.mode
    and context.source_id is not distinct from case
      when context.source_type = 'workspace_question'
        then selected_submission.question_id
      when context.source_type = 'global_question'
        then selected_submission.global_question_id
      else null
    end
    and context.original_text_sha256 = encode(
      sha256(convert_to(selected_submission.original_text, 'UTF8')),
      'hex'
    )
    and context.context_sha256 =
      app_private.writing_evaluation_context_sha256(
        context.submission_id,
        context.context_version,
        context.workspace_id,
        context.student_id,
        context.batch_id,
        context.cefr_level,
        context.source_type,
        context.source_id,
        context.submission_mode,
        context.question_metadata,
        context.original_text_sha256
      );

  if selected_context.submission_id is null
    or evidence ->> 'context_sha256'
      is distinct from selected_context.context_sha256
    or evidence ->> 'original_text_sha256' is distinct from
      selected_context.original_text_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_context_mismatch';
  end if;

  computed_final_sha256 := app_private.canonical_jsonb_sha256(
    feedback - 'evaluation_evidence'
  );
  if evidence ->> 'final_feedback_sha256'
    is distinct from computed_final_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_feedback_hash_mismatch';
  end if;

  if evidence ->> 'decision' = 'system_hold' then
    if feedback ->> 'ai_model' is distinct from 'system_hold'
      or evidence ->> 'accepted_provider' is not null
      or evidence ->> 'accepted_model' is not null
      or exists (
        select 1
        from jsonb_array_elements(coalesce(feedback -> 'lines', '[]'::jsonb)) line
        where line ->> 'status' is distinct from 'unclear'
          or line ->> 'corrected_line' is distinct from line ->> 'original_line'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'writing_adjudication_evidence_invalid';
    end if;
  elsif evidence ->> 'decision' = 'accepted_model_feedback' then
    if feedback ->> 'ai_model' is distinct from evidence ->> 'accepted_model'
      or evidence ->> 'accepted_provider' is distinct from 'deepseek'
      or exists (
        select 1
        from jsonb_array_elements(coalesce(feedback -> 'lines', '[]'::jsonb)) line
        where line ->> 'status' = 'unclear'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'writing_adjudication_evidence_invalid';
    end if;
  else
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  if selected_evidence.job_id is null then
    begin
      insert into app_private.writing_feedback_adjudications_v2 (
        job_id, submission_id, evaluation_version, feedback_version,
        schema_version, decision, reason_code, context_sha256,
        original_text_sha256, final_feedback_sha256, generator_provider,
        generator_model, candidate_feedback_sha256,
        candidate_release_sha256, critic_provider, critic_model,
        critic_verdict, critic_decision_sha256, adjudicator_provider,
        adjudicator_model, adjudicator_verdict,
        adjudicator_decision_sha256, resolved_feedback_sha256,
        final_critic_provider, final_critic_model, final_critic_verdict,
        final_critic_decision_sha256, accepted_provider, accepted_model
      ) values (
        selected_job.id,
        selected_submission.id,
        selected_job.entity_version,
        selected_job.entity_version,
        (evidence ->> 'schema_version')::smallint,
        evidence ->> 'decision',
        evidence ->> 'reason_code',
        evidence ->> 'context_sha256',
        evidence ->> 'original_text_sha256',
        evidence ->> 'final_feedback_sha256',
        evidence ->> 'generator_provider',
        evidence ->> 'generator_model',
        evidence ->> 'candidate_feedback_sha256',
        evidence ->> 'candidate_release_sha256',
        evidence ->> 'critic_provider',
        evidence ->> 'critic_model',
        evidence ->> 'critic_verdict',
        evidence ->> 'critic_decision_sha256',
        evidence ->> 'adjudicator_provider',
        evidence ->> 'adjudicator_model',
        evidence ->> 'adjudicator_verdict',
        evidence ->> 'adjudicator_decision_sha256',
        evidence ->> 'resolved_feedback_sha256',
        evidence ->> 'final_critic_provider',
        evidence ->> 'final_critic_model',
        evidence ->> 'final_critic_verdict',
        evidence ->> 'final_critic_decision_sha256',
        evidence ->> 'accepted_provider',
        evidence ->> 'accepted_model'
      ) returning * into selected_evidence;
    exception when integrity_constraint_violation then
      raise exception using
        errcode = '22023',
        message = 'writing_adjudication_evidence_invalid';
    end;
  end if;

  if (
    to_jsonb(selected_evidence)
      - array[
        'job_id', 'submission_id', 'evaluation_version',
        'feedback_version', 'created_at'
      ]::text[]
  ) is distinct from evidence then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_replay_mismatch';
  end if;
end;
$$;

revoke all on function app_private.record_or_assert_writing_adjudication_v2(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.require_independent_writing_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v2_evidence app_private.writing_feedback_adjudications_v2%rowtype;
  legacy_evidence app_private.writing_feedback_adjudications%rowtype;
begin
  if new.state <> 'released' or new.released_by is not null then
    return new;
  end if;

  select adjudication.*
  into v2_evidence
  from app_private.writing_feedback_adjudications_v2 adjudication
  where adjudication.submission_id = new.submission_id
    and adjudication.feedback_version = new.version
    and adjudication.decision = 'accepted_model_feedback';

  if v2_evidence.job_id is not null then
    if v2_evidence.final_feedback_sha256 <>
        app_private.canonical_jsonb_sha256(new.content)
      or v2_evidence.accepted_provider is distinct from 'deepseek'
      or v2_evidence.accepted_model is distinct from new.provider_model
      or new.content ->> 'ai_model' is distinct from v2_evidence.accepted_model
    then
      raise exception using
        errcode = '55000',
        message = 'writing_independent_evidence_required';
    end if;
    return new;
  end if;

  select adjudication.*
  into legacy_evidence
  from app_private.writing_feedback_adjudications adjudication
  where adjudication.submission_id = new.submission_id
    and adjudication.feedback_version = new.version
    and adjudication.decision = 'accepted_model_feedback';

  if legacy_evidence.job_id is null
    or legacy_evidence.final_feedback_sha256 <>
      app_private.canonical_jsonb_sha256(new.content)
    or legacy_evidence.accepted_provider is distinct from 'deepseek'
    or legacy_evidence.accepted_model is distinct from new.provider_model
    or new.content ->> 'ai_model' is distinct from legacy_evidence.accepted_model
  then
    raise exception using
      errcode = '55000',
      message = 'writing_independent_evidence_required';
  end if;

  return new;
end;
$$;

revoke all on function app_private.require_independent_writing_release()
from public, anon, authenticated, service_role;

create or replace function public.complete_writing_evaluation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  feedback jsonb
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  evidence_schema text := feedback #>> '{evaluation_evidence,schema_version}';
  selected_job_status text;
begin
  perform app_private.assert_service_role();

  select job.status
  into selected_job_status
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'writing_evaluation';

  if evidence_schema = '2' then
    perform app_private.record_or_assert_writing_adjudication_v2(
      target_job_id,
      target_queue_message_id,
      worker_id,
      feedback
    );
  elsif evidence_schema = '1' then
    if selected_job_status is distinct from 'succeeded'
      or not exists (
        select 1
        from app_private.writing_feedback_adjudications evidence
        where evidence.job_id = target_job_id
      )
    then
      raise exception using
        errcode = '55000',
        message = 'legacy_openai_provenance_forbidden';
    end if;
    perform app_private.record_or_assert_writing_adjudication(
      target_job_id,
      target_queue_message_id,
      worker_id,
      feedback
    );
  else
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  return query
  select *
  from public.complete_writing_evaluation_legacy_internal(
    target_job_id,
    target_queue_message_id,
    worker_id,
    feedback - 'evaluation_evidence'
  );
end;
$$;

revoke all on function public.complete_writing_evaluation(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_writing_evaluation(
  uuid, bigint, uuid, jsonb
) to service_role;

comment on table app_private.writing_feedback_adjudications_v2 is
  'Immutable, raw-content-free schema-v2 Gemini/DeepSeek writing adjudication evidence.';
comment on function app_private.record_or_assert_writing_adjudication_v2(
  uuid, bigint, uuid, jsonb
) is
  'Records only pinned Gemini/DeepSeek schema-v2 evidence and enforces exact replay, context, and feedback hashes.';

-- ---------------------------------------------------------------------------
-- Generated worksheet provenance v2.
-- ---------------------------------------------------------------------------

create or replace function app_private.assert_worksheet_critics_v2(
  worksheet jsonb
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  validation_metadata jsonb;
  critics jsonb;
  deepseek_critic jsonb;
  gemini_critic jsonb;
  candidate_sha256 text;
  expected_check boolean;
  expected_approved boolean;
  check_name text;
begin
  if worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or worksheet ->> 'mode' is distinct from 'generated'
    or jsonb_typeof(worksheet -> 'validation') <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  validation_metadata := worksheet -> 'validation';
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
    or jsonb_typeof(validation_metadata -> 'independent_model') <> 'boolean'
    or validation_metadata ->> 'critic_model'
      is distinct from 'deepseek-v4-flash'
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
  if candidate_sha256 <> app_private.worksheet_candidate_sha256(worksheet) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_candidate_hash_mismatch';
  end if;

  critics := validation_metadata -> 'critics';
  if not (critics ?& array['deepseek', 'gemini'])
    or critics - array['deepseek', 'gemini']::text[] <> '{}'::jsonb
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  deepseek_critic := critics -> 'deepseek';
  gemini_critic := critics -> 'gemini';
  perform app_private.assert_worksheet_critic_verdict(
    deepseek_critic,
    'deepseek',
    'deepseek-v4-flash',
    candidate_sha256
  );
  perform app_private.assert_worksheet_critic_verdict(
    gemini_critic,
    'gemini',
    'gemini-2.5-flash',
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
      (gemini_critic -> 'rejection_reasons')
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
      (gemini_critic #>> array['checks', check_name])::boolean;
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
    (gemini_critic ->> 'approved')::boolean;
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

revoke all on function app_private.assert_worksheet_critics_v2(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_worksheet_critics_v2(jsonb)
to service_role;

create or replace function app_private.normalize_worksheet_generation_provenance_v2(
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
  question_count integer;
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
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet provenance is invalid.';
  end if;

  perform app_private.assert_worksheet_critics_v2(worksheet);
  source_name := coalesce(worksheet ->> 'generation_source', '');
  generator_model := coalesce(worksheet ->> 'generator_model', '');
  source_mix := worksheet -> 'source_mix';
  question_count := jsonb_array_length(worksheet -> 'questions');

  if not (source_mix ?& array['mode', 'deepseek_count', 'gemini_count'])
    or source_mix - array[
      'mode', 'deepseek_count', 'gemini_count'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(source_mix -> 'deepseek_count') <> 'number'
    or jsonb_typeof(source_mix -> 'gemini_count') <> 'number'
    or coalesce(source_mix ->> 'deepseek_count', '')
      !~ '^(0|[1-9][0-9]{0,3})$'
    or coalesce(source_mix ->> 'gemini_count', '')
      !~ '^(0|[1-9][0-9]{0,3})$'
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet provenance is invalid.';
  end if;

  if source_name = 'deepseek' then
    if generator_model <> 'deepseek-v4-pro'
      or source_mix ->> 'mode' is distinct from 'deepseek'
      or (source_mix ->> 'deepseek_count')::integer <> question_count
      or (source_mix ->> 'gemini_count')::integer <> 0
    then
      raise exception using
        errcode = '22023',
        message = 'Generated worksheet provenance is invalid.';
    end if;
  elsif source_name = 'gemini' then
    if generator_model <> 'gemini-3.5-flash'
      or source_mix ->> 'mode' is distinct from 'gemini'
      or (source_mix ->> 'deepseek_count')::integer <> 0
      or (source_mix ->> 'gemini_count')::integer <> question_count
    then
      raise exception using
        errcode = '22023',
        message = 'Generated worksheet provenance is invalid.';
    end if;
  else
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet provenance is invalid.';
  end if;

  return query
  select
    worksheet || jsonb_build_object(
      'generation_source', 'deepseek',
      'generator_model', 'deepseek-v4-pro',
      'source_mix', jsonb_build_object(
        'mode', 'deepseek',
        'deepseek_count', question_count,
        'fallback_count', 0
      )
    ),
    source_name,
    jsonb_build_object(
      'schema_version', 2,
      'source_mix', source_mix,
      'validation', worksheet -> 'validation'
    );
end;
$$;

revoke all on function app_private.normalize_worksheet_generation_provenance_v2(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.normalize_worksheet_generation_provenance_v2(jsonb)
to service_role;

create table app_private.worksheet_generation_completions_v2 (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  completion_mode text not null check (completion_mode in ('generated', 'reuse')),
  evidence_version smallint not null check (evidence_version = 2),
  provider_source text check (
    provider_source is null or provider_source in ('deepseek', 'gemini')
  ),
  generator_model text,
  primary_critic_provider text,
  primary_critic_model text,
  primary_verdict_sha256 text,
  secondary_critic_provider text,
  secondary_critic_model text,
  secondary_verdict_sha256 text,
  candidate_sha256 text,
  provider_metadata jsonb check (
    provider_metadata is null or jsonb_typeof(provider_metadata) = 'object'
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz not null default now(),
  constraint worksheet_generation_completions_v2_shape_check check (
    (
      completion_mode = 'reuse'
      and provider_source is null
      and generator_model is null
      and primary_critic_provider is null
      and primary_critic_model is null
      and primary_verdict_sha256 is null
      and secondary_critic_provider is null
      and secondary_critic_model is null
      and secondary_verdict_sha256 is null
      and candidate_sha256 is null
      and provider_metadata is null
    )
    or (
      completion_mode = 'generated'
      and (
        (provider_source = 'deepseek' and generator_model = 'deepseek-v4-pro')
        or (
          provider_source = 'gemini'
          and generator_model = 'gemini-3.5-flash'
        )
      )
      and primary_critic_provider = 'deepseek'
      and primary_critic_model = 'deepseek-v4-flash'
      and primary_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and secondary_critic_provider = 'gemini'
      and secondary_critic_model = 'gemini-2.5-flash'
      and secondary_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and candidate_sha256 ~ '^[a-f0-9]{64}$'
      and provider_metadata is not null
    )
  )
);

alter table app_private.worksheet_generation_completions_v2
  enable row level security;

revoke all on table app_private.worksheet_generation_completions_v2
from public, anon, authenticated, service_role;

create trigger worksheet_generation_completions_v2_immutable
before update or delete on app_private.worksheet_generation_completions_v2
for each row execute function
  app_private.reject_worksheet_generation_completion_mutation();

create or replace function app_private.assert_or_record_worksheet_generation_completion_v2(
  target_job_id uuid,
  target_practice_test_id uuid,
  worksheet jsonb,
  completion_was_succeeded boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_mode text;
  expected_source text;
  expected_generator_model text;
  expected_metadata jsonb;
  expected_payload_sha256 text;
  current_content_sha256 text;
  recorded app_private.worksheet_generation_completions_v2%rowtype;
begin
  perform app_private.assert_service_role();
  expected_mode := worksheet ->> 'mode';

  if worksheet is null
    or coalesce(expected_mode, '') not in ('generated', 'reuse')
    or target_practice_test_id is null
    or completion_was_succeeded is null
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet completion fingerprint is invalid.';
  end if;

  if expected_mode = 'generated' then
    perform app_private.assert_worksheet_critics_v2(worksheet);
    expected_source := worksheet ->> 'generation_source';
    expected_generator_model := worksheet ->> 'generator_model';
    expected_metadata := jsonb_build_object(
      'schema_version', 2,
      'source_mix', worksheet -> 'source_mix',
      'validation', worksheet -> 'validation'
    );
  end if;

  expected_payload_sha256 :=
    app_private.worksheet_generation_payload_sha256(worksheet);

  select app_private.practice_test_content_sha256(test.id)
  into current_content_sha256
  from public.practice_tests test
  where test.id = target_practice_test_id
    and (
      expected_mode <> 'generated'
      or (
        test.generation_job_id = target_job_id
        and test.generation_source = expected_source
        and test.generator_model = expected_generator_model
        and test.generation_metadata = expected_metadata
      )
    )
  for share;

  if not found or current_content_sha256 is null then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion replay does not match persisted result.';
  end if;

  select completion.*
  into recorded
  from app_private.worksheet_generation_completions_v2 completion
  where completion.job_id = target_job_id
  for update;

  if completion_was_succeeded then
    if recorded.job_id is null
      or recorded.practice_test_id <> target_practice_test_id
      or recorded.completion_mode <> expected_mode
      or recorded.provider_source is distinct from expected_source
      or recorded.generator_model is distinct from expected_generator_model
      or recorded.provider_metadata is distinct from expected_metadata
      or recorded.payload_sha256 <> expected_payload_sha256
      or recorded.content_sha256 <> current_content_sha256
      or recorded.primary_critic_provider is distinct from (case
        when expected_mode = 'generated' then 'deepseek' else null end)
      or recorded.primary_critic_model is distinct from (case
        when expected_mode = 'generated' then 'deepseek-v4-flash' else null end)
      or recorded.primary_verdict_sha256 is distinct from
        worksheet #>> '{validation,critics,deepseek,verdict_sha256}'
      or recorded.secondary_critic_provider is distinct from (case
        when expected_mode = 'generated' then 'gemini' else null end)
      or recorded.secondary_critic_model is distinct from (case
        when expected_mode = 'generated' then 'gemini-2.5-flash' else null end)
      or recorded.secondary_verdict_sha256 is distinct from
        worksheet #>> '{validation,critics,gemini,verdict_sha256}'
      or recorded.candidate_sha256 is distinct from
        worksheet #>> '{validation,candidate_sha256}'
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

  insert into app_private.worksheet_generation_completions_v2 (
    job_id, practice_test_id, completion_mode, evidence_version,
    provider_source, generator_model, primary_critic_provider,
    primary_critic_model, primary_verdict_sha256,
    secondary_critic_provider, secondary_critic_model,
    secondary_verdict_sha256, candidate_sha256, provider_metadata,
    payload_sha256, content_sha256
  ) values (
    target_job_id,
    target_practice_test_id,
    expected_mode,
    2,
    expected_source,
    expected_generator_model,
    case when expected_mode = 'generated' then 'deepseek' else null end,
    case when expected_mode = 'generated' then 'deepseek-v4-flash' else null end,
    worksheet #>> '{validation,critics,deepseek,verdict_sha256}',
    case when expected_mode = 'generated' then 'gemini' else null end,
    case when expected_mode = 'generated' then 'gemini-2.5-flash' else null end,
    worksheet #>> '{validation,critics,gemini,verdict_sha256}',
    worksheet #>> '{validation,candidate_sha256}',
    expected_metadata,
    expected_payload_sha256,
    current_content_sha256
  );
end;
$$;

revoke all on function
  app_private.assert_or_record_worksheet_generation_completion_v2(
    uuid, uuid, jsonb, boolean
  ) from public, anon, authenticated, service_role;
grant execute on function
  app_private.assert_or_record_worksheet_generation_completion_v2(
    uuid, uuid, jsonb, boolean
  ) to service_role;

alter function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
  rename to complete_worksheet_generation_openai_legacy;

revoke all on function api.complete_worksheet_generation_openai_legacy(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;

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
  selected_job_status text;
begin
  perform app_private.assert_service_role();

  select job.status
  into selected_job_status
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation';

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

  if selected_job_status = 'succeeded'
    and exists (
      select 1
      from app_private.worksheet_generation_completions completion
      where completion.job_id = target_job_id
    )
    and not exists (
      select 1
      from app_private.worksheet_generation_completions_v2 completion
      where completion.job_id = target_job_id
    )
  then
    return query
    select *
    from api.complete_worksheet_generation_openai_legacy(
      target_job_id,
      target_queue_message_id,
      worker_id,
      worksheet
    );
    return;
  end if;

  if worksheet ->> 'generation_source' = 'openai' then
    raise exception using
      errcode = '55000',
      message = 'legacy_openai_provenance_forbidden';
  end if;

  select *
  into strict normalized
  from app_private.normalize_worksheet_generation_provenance_v2(worksheet);

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

  if worksheet ->> 'mode' = 'generated' and not completion_was_succeeded then
    update public.practice_tests test
    set
      generation_source = normalized.provider_source,
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

  perform app_private.assert_or_record_worksheet_generation_completion_v2(
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
) from public, anon, authenticated;
grant execute on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) to service_role;

comment on function app_private.assert_worksheet_critics_v2(jsonb) is
  'Pins DeepSeek Flash plus Gemini 2.5 Flash verdicts to the exact candidate hash and combines every quality check fail-closed.';
comment on table app_private.worksheet_generation_completions_v2 is
  'Immutable provider-neutral schema-v2 worksheet completion evidence with truthful Gemini provenance and no educational content.';

-- The certified-bank fallback persists rejected candidates. Supersede its
-- Phase 12H OpenAI-only candidate contract while preserving exact historical
-- succeeded-job replay.
create or replace function app_private.complete_certified_worksheet_bank_fallback(
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
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  recorded_event app_private.worksheet_bank_fallback_events%rowtype;
  selected_worker_id uuid := worker_id;
  selected_revision_id uuid;
  eligible_revision_id uuid;
  cloned_test_id uuid;
  fallback_reason text;
  rejected_candidates jsonb;
  rejected_candidate jsonb;
  candidate_attempt integer;
  seen_attempts integer[] := array[]::integer[];
  rejection_count integer;
  payload_sha256 text;
  contains_legacy_provider_evidence boolean := false;
begin
  perform app_private.assert_service_role();

  if worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or not (worksheet ?& array[
      'schema_version', 'mode', 'template_revision_id',
      'fallback_reason', 'rejected_candidates'
    ])
    or worksheet - array[
      'schema_version', 'mode', 'template_revision_id',
      'fallback_reason', 'rejected_candidates'
    ]::text[] <> '{}'::jsonb
    or worksheet ->> 'schema_version' is distinct from '1'
    or worksheet ->> 'mode' is distinct from 'certified_bank'
    or coalesce(worksheet ->> 'template_revision_id', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(worksheet ->> 'fallback_reason', '') not in (
      'approved_bank_preferred',
      'provider_unavailable',
      'provider_exhausted',
      'candidates_rejected'
    )
    or jsonb_typeof(worksheet -> 'rejected_candidates') <> 'array'
    or jsonb_array_length(worksheet -> 'rejected_candidates') > 2
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_completion_payload_invalid';
  end if;

  selected_revision_id := (worksheet ->> 'template_revision_id')::uuid;
  fallback_reason := worksheet ->> 'fallback_reason';
  rejected_candidates := worksheet -> 'rejected_candidates';
  rejection_count := jsonb_array_length(rejected_candidates);
  payload_sha256 := encode(
    sha256(convert_to(worksheet::text, 'UTF8')),
    'hex'
  );

  if (fallback_reason = 'approved_bank_preferred' and rejection_count <> 0)
    or (fallback_reason = 'candidates_rejected' and rejection_count = 0)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_completion_reason_invalid';
  end if;

  for rejected_candidate in
    select candidate.item
    from jsonb_array_elements(rejected_candidates) candidate(item)
  loop
    if jsonb_typeof(rejected_candidate) <> 'object'
      or not (rejected_candidate ?& array[
        'attempt_number', 'provider', 'model',
        'rejection_reasons', 'candidate'
      ])
      or rejected_candidate - array[
        'attempt_number', 'provider', 'model',
        'rejection_reasons', 'candidate'
      ]::text[] <> '{}'::jsonb
      or coalesce(rejected_candidate ->> 'attempt_number', '') !~ '^[12]$'
      or coalesce(rejected_candidate ->> 'provider', '')
        not in ('deepseek', 'openai', 'gemini')
      or coalesce(rejected_candidate ->> 'model', '')
        !~ '^[a-zA-Z0-9._:/-]{1,100}$'
      or jsonb_typeof(rejected_candidate -> 'rejection_reasons') <> 'array'
      or jsonb_typeof(rejected_candidate -> 'candidate') <> 'object'
      or octet_length((rejected_candidate -> 'candidate')::text) > 131072
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_bank_rejected_candidate_invalid';
    end if;

    candidate_attempt := (rejected_candidate ->> 'attempt_number')::integer;
    if candidate_attempt = any(seen_attempts)
      or jsonb_array_length(rejected_candidate -> 'rejection_reasons')
        not between 1 and 8
      or exists (
        select 1
        from jsonb_array_elements(
          rejected_candidate -> 'rejection_reasons'
        ) reason(item)
        where jsonb_typeof(reason.item) <> 'string'
          or length(btrim(reason.item #>> '{}')) not between 1 and 240
      )
      or rejected_candidate #>> '{candidate,schema_version}'
        is distinct from '1'
      or rejected_candidate #>> '{candidate,mode}' is distinct from 'generated'
      or rejected_candidate #>> '{candidate,generation_source}'
        is distinct from rejected_candidate ->> 'provider'
      or rejected_candidate #>> '{candidate,generator_model}'
        is distinct from rejected_candidate ->> 'model'
      or rejected_candidate #>> '{candidate,validation,independent_model}'
        is distinct from 'false'
      or rejected_candidate #> '{candidate,validation,rejection_reasons}'
        is distinct from rejected_candidate -> 'rejection_reasons'
      or not (
        (
          rejected_candidate ->> 'provider' = 'deepseek'
          and rejected_candidate ->> 'model' = 'deepseek-v4-pro'
        )
        or (
          rejected_candidate ->> 'provider' = 'gemini'
          and rejected_candidate ->> 'model' = 'gemini-3.5-flash'
        )
        or (
          rejected_candidate ->> 'provider' = 'openai'
          and rejected_candidate ->> 'model' = 'gpt-5.4-mini-2026-03-17'
        )
      )
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_bank_rejected_candidate_invalid';
    end if;

    if rejected_candidate ->> 'provider' = 'openai'
      or (rejected_candidate #> '{candidate,source_mix}') ? 'fallback_count'
      or (rejected_candidate #> '{candidate,validation,critics}') ? 'openai'
    then
      contains_legacy_provider_evidence := true;
      perform 1
      from app_private.normalize_worksheet_generation_provenance(
        rejected_candidate -> 'candidate'
      );
    else
      perform 1
      from app_private.normalize_worksheet_generation_provenance_v2(
        rejected_candidate -> 'candidate'
      );
    end if;
    seen_attempts := array_append(seen_attempts, candidate_attempt);
  end loop;

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = '02000',
      message = 'Worksheet generation job not found.';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_job.entity_id
  for update;

  if selected_assignment.id is null then
    raise exception using
      errcode = '02000',
      message = 'Practice assignment not found.';
  end if;

  if selected_job.status = 'succeeded' then
    select event.*
    into recorded_event
    from app_private.worksheet_bank_fallback_events event
    where event.job_id = selected_job.id;

    if recorded_event.id is null
      or recorded_event.assignment_id <> selected_assignment.id
      or recorded_event.template_revision_id <> selected_revision_id
      or recorded_event.completion_payload_sha256 <> payload_sha256
      or recorded_event.rejection_count <> rejection_count
      or selected_assignment.practice_test_id
        is distinct from recorded_event.cloned_practice_test_id
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_completion_replay_mismatch';
    end if;

    return query select
      selected_assignment.id,
      recorded_event.cloned_practice_test_id,
      selected_assignment.generation_status,
      'approved'::text;
    return;
  end if;

  if contains_legacy_provider_evidence then
    raise exception using
      errcode = '55000',
      message = 'legacy_openai_provenance_forbidden';
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
    or selected_job.entity_version <> selected_assignment.generation_version
  then
    raise exception using
      errcode = '55000',
      message = 'Job lease is no longer active.';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
    or selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or selected_assignment.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = selected_assignment.workspace_id
        and membership.user_id = selected_assignment.student_id
        and membership.role = 'student'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Practice assignment is not active.';
  end if;

  eligible_revision_id := public.select_released_worksheet_template_internal(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level
  );
  if eligible_revision_id is distinct from selected_revision_id then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_revision_not_eligible';
  end if;

  cloned_test_id := app_private.clone_released_worksheet_template(
    selected_assignment.workspace_id,
    selected_revision_id
  );

  perform set_config('app.worksheet_bank_fallback_insert', 'on', true);
  insert into app_private.worksheet_bank_fallback_events (
    job_id, assignment_id, workspace_id, template_revision_id,
    cloned_practice_test_id, fallback_reason, rejection_count,
    completion_payload_sha256
  ) values (
    selected_job.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_revision_id,
    cloned_test_id,
    fallback_reason,
    rejection_count,
    payload_sha256
  ) returning * into recorded_event;

  insert into app_private.worksheet_generation_rejections (
    fallback_event_id, attempt_number, provider, model,
    rejection_reasons, candidate, candidate_sha256
  )
  select
    recorded_event.id,
    (candidate.item ->> 'attempt_number')::smallint,
    candidate.item ->> 'provider',
    candidate.item ->> 'model',
    candidate.item -> 'rejection_reasons',
    candidate.item -> 'candidate',
    repeat('0', 64)
  from jsonb_array_elements(rejected_candidates) candidate(item);
  perform set_config('app.worksheet_bank_fallback_insert', 'off', true);

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  update app_private.async_jobs job
  set
    status = 'succeeded',
    worker_id = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = null
  where job.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  return query select
    selected_assignment.id,
    cloned_test_id,
    'ready'::text,
    'approved'::text;
end;
$$;

revoke all on function app_private.complete_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.complete_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Semantic worksheet-answer provenance v2.
-- ---------------------------------------------------------------------------

create or replace function app_private.valid_worksheet_answer_source_map_v2(
  selected_sources jsonb,
  expected_question_ids uuid[]
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  source_row jsonb;
  source_question_id uuid;
  seen_question_ids uuid[] := array[]::uuid[];
  normalized_seen uuid[];
  normalized_expected uuid[];
begin
  if selected_sources is null
    or jsonb_typeof(selected_sources) <> 'array'
    or jsonb_array_length(selected_sources) not between 1 and 3
    or jsonb_array_length(selected_sources) <>
      coalesce(cardinality(expected_question_ids), 0)
  then
    return false;
  end if;

  for source_row in
    select value from jsonb_array_elements(selected_sources)
  loop
    if jsonb_typeof(source_row) <> 'object'
      or not (source_row ?& array['question_id', 'provider_source'])
      or source_row - array['question_id', 'provider_source']::text[] <>
        '{}'::jsonb
      or coalesce(source_row ->> 'question_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(source_row ->> 'provider_source', '')
        not in ('deepseek', 'gemini')
    then
      return false;
    end if;

    source_question_id := (source_row ->> 'question_id')::uuid;
    if source_question_id = any(seen_question_ids) then
      return false;
    end if;
    seen_question_ids := array_append(seen_question_ids, source_question_id);
  end loop;

  select coalesce(array_agg(value order by value), array[]::uuid[])
  into normalized_seen
  from unnest(seen_question_ids) value;

  select coalesce(array_agg(value order by value), array[]::uuid[])
  into normalized_expected
  from unnest(coalesce(expected_question_ids, array[]::uuid[])) value;

  return normalized_seen = normalized_expected;
end;
$$;

revoke all on function app_private.valid_worksheet_answer_source_map_v2(
  jsonb, uuid[]
) from public, anon, authenticated, service_role;

create table app_private.worksheet_answer_completion_provenance_v2 (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete restrict,
  evidence_version smallint not null check (evidence_version = 2),
  provider_source text check (
    provider_source is null
    or provider_source in ('deepseek', 'gemini', 'mixed')
  ),
  evaluator_model text,
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null default now(),
  constraint worksheet_answer_completion_provenance_v2_model_check check (
    coalesce((
      (
        provider_source = 'deepseek'
        and evaluator_model = 'deepseek-v4-flash'
      )
      or (
        provider_source = 'gemini'
        and evaluator_model = 'gemini-3.1-flash-lite'
      )
      or (
        provider_source = 'mixed'
        and evaluator_model =
          'deepseek-v4-flash+gemini-3.1-flash-lite'
      )
      or (provider_source is null and evaluator_model is null)
    ), false)
  )
);

create table app_private.worksheet_answer_adjudication_evidence_v2 (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete restrict,
  evidence_version smallint not null check (evidence_version = 2),
  deepseek_model text not null check (deepseek_model = 'deepseek-v4-flash'),
  gemini_model text not null check (gemini_model = 'gemini-3.1-flash-lite'),
  adjudication_mode text not null
    check (adjudication_mode in ('agreement', 'pro_resolved')),
  selected_provider_source text not null
    check (selected_provider_source in ('deepseek', 'gemini', 'mixed')),
  question_ids uuid[] not null
    check (cardinality(question_ids) between 1 and 3),
  selected_question_sources jsonb not null,
  deepseek_result_sha256 text not null
    check (deepseek_result_sha256 ~ '^[0-9a-f]{64}$'),
  gemini_result_sha256 text not null
    check (gemini_result_sha256 ~ '^[0-9a-f]{64}$'),
  pro_model text check (pro_model is null or pro_model = 'deepseek-v4-pro'),
  pro_result_sha256 text check (
    pro_result_sha256 is null or pro_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  final_result_sha256 text not null
    check (final_result_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null default now(),
  constraint worksheet_answer_selected_source_map_v2_check check (
    app_private.valid_worksheet_answer_source_map_v2(
      selected_question_sources,
      question_ids
    )
  ),
  constraint worksheet_answer_adjudication_mode_v2_shape_check check (
    (
      adjudication_mode = 'agreement'
      and selected_provider_source = 'deepseek'
      and pro_model is null
      and pro_result_sha256 is null
    )
    or (
      adjudication_mode = 'pro_resolved'
      and pro_model = 'deepseek-v4-pro'
      and pro_result_sha256 is not null
    )
  )
);

alter table app_private.worksheet_answer_completion_provenance_v2
  enable row level security;
alter table app_private.worksheet_answer_adjudication_evidence_v2
  enable row level security;

revoke all on table app_private.worksheet_answer_completion_provenance_v2
from public, anon, authenticated, service_role;
revoke all on table app_private.worksheet_answer_adjudication_evidence_v2
from public, anon, authenticated, service_role;

create trigger worksheet_answer_completion_provenance_v2_immutable
before update or delete
on app_private.worksheet_answer_completion_provenance_v2
for each row execute function
  app_private.reject_worksheet_answer_completion_mutation();

create trigger worksheet_answer_adjudication_evidence_v2_immutable
before update or delete
on app_private.worksheet_answer_adjudication_evidence_v2
for each row execute function
  app_private.reject_semantic_review_audit_mutation();

create or replace function app_private.complete_worksheet_answer_with_adjudication_v2(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb,
  adjudication jsonb
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
  translated_result jsonb;
  translated_reviews jsonb;
  normalized_selected_sources jsonb := '[]'::jsonb;
  provider_question_ids uuid[] := array[]::uuid[];
  system_question_ids uuid[] := array[]::uuid[];
  provider_review_count integer := 0;
  system_review_count integer := 0;
  selected_provider_source text;
  expected_evaluator_model text;
  selected_job_status text;
  selected_job_attempt_id uuid;
  canonical_result_sha256 text;
  recorded_provenance
    app_private.worksheet_answer_completion_provenance_v2%rowtype;
  recorded_evidence
    app_private.worksheet_answer_adjudication_evidence_v2%rowtype;
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

  if result is null
    or jsonb_typeof(result) <> 'object'
    or not (result ?& array[
      'schema_version', 'mode', 'evaluator_model', 'reviews'
    ])
    or result - array[
      'schema_version', 'mode', 'evaluator_model', 'reviews'
    ]::text[] <> '{}'::jsonb
    or result -> 'schema_version' is distinct from '1'::jsonb
    or coalesce(result ->> 'mode', '') not in ('not_needed', 'evaluated')
    or jsonb_typeof(result -> 'reviews') <> 'array'
  then
    raise exception using errcode = '22023', message = 'semantic_completion_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review
    where jsonb_typeof(review) <> 'object'
      or coalesce(review ->> 'evaluator_source', '')
        not in ('deepseek', 'gemini', 'system')
      or coalesce(review ->> 'question_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception using
      errcode = '22023',
      message = 'semantic_completion_source_invalid';
  end if;

  if (
    select count(*) <> count(distinct (review ->> 'question_id')::uuid)
    from jsonb_array_elements(result -> 'reviews') review
  ) then
    raise exception using
      errcode = '22023',
      message = 'semantic_completion_duplicates';
  end if;

  select
    count(*) filter (
      where review ->> 'evaluator_source' in ('deepseek', 'gemini')
    ),
    count(*) filter (where review ->> 'evaluator_source' = 'system'),
    coalesce(array_agg(
      (review ->> 'question_id')::uuid
      order by (review ->> 'question_id')::uuid
    ) filter (
      where review ->> 'evaluator_source' in ('deepseek', 'gemini')
    ), array[]::uuid[]),
    coalesce(array_agg(
      (review ->> 'question_id')::uuid
      order by (review ->> 'question_id')::uuid
    ) filter (
      where review ->> 'evaluator_source' = 'system'
    ), array[]::uuid[])
  into provider_review_count, system_review_count,
    provider_question_ids, system_question_ids
  from jsonb_array_elements(result -> 'reviews') review;

  if provider_review_count > 3
    or system_review_count > 3
    or provider_review_count + system_review_count > 3
  then
    raise exception using
      errcode = '22023',
      message = 'semantic_completion_count_invalid';
  end if;

  if provider_review_count > 0 then
    select case
      when count(*) filter (
        where review ->> 'evaluator_source' = 'deepseek'
      ) > 0
        and count(*) filter (
          where review ->> 'evaluator_source' = 'gemini'
        ) > 0
        then 'mixed'
      when count(*) filter (
        where review ->> 'evaluator_source' = 'gemini'
      ) > 0
        then 'gemini'
      else 'deepseek'
    end
    into selected_provider_source
    from jsonb_array_elements(result -> 'reviews') review
    where review ->> 'evaluator_source' in ('deepseek', 'gemini');

    expected_evaluator_model := case selected_provider_source
      when 'deepseek' then 'deepseek-v4-flash'
      when 'gemini' then 'gemini-3.1-flash-lite'
      when 'mixed' then 'deepseek-v4-flash+gemini-3.1-flash-lite'
      else null
    end;
  end if;

  if provider_review_count > 0 then
    if (result ->> 'evaluator_model') is distinct from expected_evaluator_model
      or adjudication is null
      or jsonb_typeof(adjudication) <> 'object'
      or not (adjudication ?& array[
        'schema_version', 'deepseek_model', 'gemini_model',
        'adjudication_mode', 'selected_provider_source',
        'selected_question_sources', 'deepseek_result_sha256',
        'gemini_result_sha256', 'pro_model', 'pro_result_sha256'
      ])
      or adjudication - array[
        'schema_version', 'deepseek_model', 'gemini_model',
        'adjudication_mode', 'selected_provider_source',
        'selected_question_sources', 'deepseek_result_sha256',
        'gemini_result_sha256', 'pro_model', 'pro_result_sha256'
      ]::text[] <> '{}'::jsonb
      or adjudication -> 'schema_version' is distinct from '2'::jsonb
      or adjudication ->> 'deepseek_model'
        is distinct from 'deepseek-v4-flash'
      or adjudication ->> 'gemini_model'
        is distinct from 'gemini-3.1-flash-lite'
      or adjudication ->> 'selected_provider_source'
        is distinct from selected_provider_source
      or not app_private.valid_worksheet_answer_source_map_v2(
        adjudication -> 'selected_question_sources',
        provider_question_ids
      )
      or exists (
        select 1
        from jsonb_array_elements(result -> 'reviews') review
        left join jsonb_array_elements(
          adjudication -> 'selected_question_sources'
        ) source_map
          on source_map ->> 'question_id' = review ->> 'question_id'
        where review ->> 'evaluator_source' in ('deepseek', 'gemini')
          and source_map ->> 'provider_source'
            is distinct from review ->> 'evaluator_source'
      )
      or coalesce(adjudication ->> 'adjudication_mode', '')
        not in ('agreement', 'pro_resolved')
      or coalesce(adjudication ->> 'deepseek_result_sha256', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(adjudication ->> 'gemini_result_sha256', '')
        !~ '^[0-9a-f]{64}$'
      or (
        adjudication ->> 'adjudication_mode' = 'agreement'
        and (
          selected_provider_source <> 'deepseek'
          or exists (
            select 1
            from jsonb_array_elements(
              adjudication -> 'selected_question_sources'
            ) source_map
            where source_map ->> 'provider_source' is distinct from 'deepseek'
          )
          or adjudication -> 'pro_model' is distinct from 'null'::jsonb
          or adjudication -> 'pro_result_sha256' is distinct from 'null'::jsonb
        )
      )
      or (
        adjudication ->> 'adjudication_mode' = 'pro_resolved'
        and (
          adjudication ->> 'pro_model' is distinct from 'deepseek-v4-pro'
          or coalesce(adjudication ->> 'pro_result_sha256', '')
            !~ '^[0-9a-f]{64}$'
        )
      )
    then
      raise exception using
        errcode = '22023',
        message = 'semantic_adjudication_invalid';
    end if;

    select jsonb_agg(
      jsonb_build_object(
        'question_id', source_map ->> 'question_id',
        'provider_source', source_map ->> 'provider_source'
      ) order by (source_map ->> 'question_id')::uuid
    )
    into normalized_selected_sources
    from jsonb_array_elements(
      adjudication -> 'selected_question_sources'
    ) source_map;
  elsif adjudication is not null and adjudication <> 'null'::jsonb then
    raise exception using
      errcode = '22023',
      message = 'semantic_adjudication_unexpected';
  elsif result -> 'evaluator_model' is distinct from 'null'::jsonb then
    raise exception using
      errcode = '22023',
      message = 'semantic_completion_model_invalid';
  end if;

  if system_review_count > 0 and exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review
    where review ->> 'evaluator_source' = 'system'
      and (
        review ->> 'review_status' is distinct from 'incorrect'
        or review -> 'points_awarded' is distinct from '0'::jsonb
        or review -> 'max_points' is distinct from '1'::jsonb
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'system_blank_review_invalid';
  end if;

  select coalesce(jsonb_agg(
    case
      when review ->> 'evaluator_source' = 'system' then
        jsonb_set(review, '{evaluator_source}', to_jsonb('manual'::text))
      else
        jsonb_set(review, '{evaluator_source}', to_jsonb('deepseek'::text))
    end
    order by ordinal
  ), '[]'::jsonb)
  into translated_reviews
  from jsonb_array_elements(result -> 'reviews')
    with ordinality as reviewed(review, ordinal);

  translated_result := jsonb_set(
    jsonb_set(result, '{reviews}', translated_reviews),
    '{evaluator_model}',
    case
      when provider_review_count > 0
        then to_jsonb('deepseek-v4-flash'::text)
      else 'null'::jsonb
    end
  );
  canonical_result_sha256 := encode(
    sha256(convert_to(result::text, 'UTF8')),
    'hex'
  );

  select job.status, job.entity_id
  into selected_job_status, selected_job_attempt_id
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation'
  for update;

  if not found then
    raise exception using errcode = '02000', message = 'semantic_job_missing';
  end if;

  if selected_job_status = 'succeeded' then
    select provenance.*
    into recorded_provenance
    from app_private.worksheet_answer_completion_provenance_v2 provenance
    where provenance.job_id = target_job_id;

    if not found
      or recorded_provenance.attempt_id <> selected_job_attempt_id
      or recorded_provenance.provider_source
        is distinct from selected_provider_source
      or recorded_provenance.evaluator_model
        is distinct from expected_evaluator_model
      or recorded_provenance.result_sha256 <> canonical_result_sha256
      or not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.id = selected_job_attempt_id
          and attempt.evaluation_model is not distinct from expected_evaluator_model
      )
      or exists (
        select 1
        from jsonb_array_elements(normalized_selected_sources) source_map
        left join public.practice_attempt_question_reviews review
          on review.attempt_id = selected_job_attempt_id
         and review.question_id = (source_map ->> 'question_id')::uuid
        where review.evaluator_source
          is distinct from source_map ->> 'provider_source'
      )
      or (
        select count(*)
        from public.practice_attempt_question_reviews review
        where review.attempt_id = selected_job_attempt_id
          and review.question_id = any(system_question_ids)
          and review.evaluator_source = 'system'
      ) <> system_review_count
    then
      raise exception using
        errcode = '55000',
        message = 'semantic_completion_replay_mismatch';
    end if;
  end if;

  select
    completed.attempt_id, completed.assignment_id,
    completed.evaluation_status, completed.attempt_status,
    completed.assignment_status, completed.score_points,
    completed.max_score_points, completed.score_percent, completed.passed
  into strict
    completed_attempt_id, completed_assignment_id,
    completed_evaluation_status, completed_attempt_status,
    completed_assignment_status, completed_score_points,
    completed_max_score_points, completed_score_percent, completed_passed
  from public.complete_worksheet_answer_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    translated_result
  ) completed;

  if completed_attempt_id is distinct from selected_job_attempt_id then
    raise exception using
      errcode = '55000',
      message = 'semantic_completion_context_changed';
  end if;

  if selected_job_status <> 'succeeded' and system_review_count > 0 then
    update public.practice_attempt_question_reviews review
    set evaluator_source = 'system'
    where review.attempt_id = completed_attempt_id
      and review.question_id = any(system_question_ids)
      and review.evaluator_source = 'manual';

    if (
      select count(*)
      from public.practice_attempt_question_reviews review
      where review.attempt_id = completed_attempt_id
        and review.question_id = any(system_question_ids)
        and review.evaluator_source = 'system'
    ) <> system_review_count then
      raise exception using
        errcode = '55000',
        message = 'system_provenance_not_persisted';
    end if;
  end if;

  if selected_job_status <> 'succeeded' and provider_review_count > 0 then
    update public.practice_attempt_question_reviews review
    set evaluator_source = source_map ->> 'provider_source'
    from jsonb_array_elements(normalized_selected_sources) source_map
    where review.attempt_id = completed_attempt_id
      and review.question_id = (source_map ->> 'question_id')::uuid
      and review.evaluator_source = 'deepseek';

    get diagnostics changed_row_count = row_count;
    if changed_row_count <> provider_review_count then
      raise exception using
        errcode = '55000',
        message = 'semantic_provider_provenance_not_persisted';
    end if;
  end if;

  if selected_job_status <> 'succeeded' then
    update public.practice_test_attempts attempt
    set evaluation_model = expected_evaluator_model
    where attempt.id = completed_attempt_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'semantic_evaluator_model_not_persisted';
    end if;

    insert into app_private.worksheet_answer_completion_provenance_v2 (
      job_id, attempt_id, evidence_version, provider_source,
      evaluator_model, result_sha256
    ) values (
      target_job_id,
      completed_attempt_id,
      2,
      selected_provider_source,
      expected_evaluator_model,
      canonical_result_sha256
    );
  end if;

  if provider_review_count > 0 then
    insert into app_private.worksheet_answer_adjudication_evidence_v2 (
      job_id, attempt_id, evidence_version, deepseek_model, gemini_model,
      adjudication_mode, selected_provider_source, question_ids,
      selected_question_sources, deepseek_result_sha256,
      gemini_result_sha256, pro_model, pro_result_sha256,
      final_result_sha256
    ) values (
      target_job_id,
      completed_attempt_id,
      2,
      adjudication ->> 'deepseek_model',
      adjudication ->> 'gemini_model',
      adjudication ->> 'adjudication_mode',
      adjudication ->> 'selected_provider_source',
      provider_question_ids,
      normalized_selected_sources,
      adjudication ->> 'deepseek_result_sha256',
      adjudication ->> 'gemini_result_sha256',
      adjudication ->> 'pro_model',
      adjudication ->> 'pro_result_sha256',
      canonical_result_sha256
    ) on conflict (job_id) do nothing;

    select evidence.*
    into strict recorded_evidence
    from app_private.worksheet_answer_adjudication_evidence_v2 evidence
    where evidence.job_id = target_job_id;

    if recorded_evidence.attempt_id is distinct from completed_attempt_id
      or recorded_evidence.deepseek_model
        is distinct from adjudication ->> 'deepseek_model'
      or recorded_evidence.gemini_model
        is distinct from adjudication ->> 'gemini_model'
      or recorded_evidence.adjudication_mode is distinct from
        adjudication ->> 'adjudication_mode'
      or recorded_evidence.selected_provider_source is distinct from
        adjudication ->> 'selected_provider_source'
      or recorded_evidence.question_ids is distinct from provider_question_ids
      or recorded_evidence.selected_question_sources is distinct from
        normalized_selected_sources
      or recorded_evidence.deepseek_result_sha256 is distinct from
        adjudication ->> 'deepseek_result_sha256'
      or recorded_evidence.gemini_result_sha256 is distinct from
        adjudication ->> 'gemini_result_sha256'
      or recorded_evidence.pro_model is distinct from
        adjudication ->> 'pro_model'
      or recorded_evidence.pro_result_sha256 is distinct from
        adjudication ->> 'pro_result_sha256'
      or recorded_evidence.final_result_sha256
        is distinct from canonical_result_sha256
    then
      raise exception using
        errcode = '55000',
        message = 'semantic_adjudication_replay_mismatch';
    end if;
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

revoke all on function
  app_private.complete_worksheet_answer_with_adjudication_v2(
    uuid, bigint, uuid, jsonb, jsonb
  ) from public, anon, authenticated, service_role;
grant execute on function
  app_private.complete_worksheet_answer_with_adjudication_v2(
    uuid, bigint, uuid, jsonb, jsonb
  ) to service_role;

alter function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) rename to complete_worksheet_answer_adjudication_openai_legacy;

revoke all on function api.complete_worksheet_answer_adjudication_openai_legacy(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;

revoke all on function app_private.complete_worksheet_answer_with_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.complete_worksheet_answer_phase_12r(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb,
  adjudication jsonb
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
  selected_job_status text;
begin
  perform app_private.assert_service_role();

  select job.status
  into selected_job_status
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation';

  if adjudication ->> 'schema_version' = '1'
    or (
      (adjudication is null or adjudication = 'null'::jsonb)
      and selected_job_status = 'succeeded'
      and exists (
        select 1
        from app_private.worksheet_answer_completion_provenance provenance
        where provenance.job_id = target_job_id
      )
      and not exists (
        select 1
        from app_private.worksheet_answer_completion_provenance_v2 provenance
        where provenance.job_id = target_job_id
      )
    )
  then
    if selected_job_status is distinct from 'succeeded'
      or not exists (
        select 1
        from app_private.worksheet_answer_completion_provenance provenance
        where provenance.job_id = target_job_id
      )
    then
      raise exception using
        errcode = '55000',
        message = 'legacy_openai_provenance_forbidden';
    end if;

    return query
    select *
    from api.complete_worksheet_answer_adjudication_openai_legacy(
      target_job_id,
      target_queue_message_id,
      worker_id,
      result,
      adjudication
    );
    return;
  end if;

  if adjudication is not null
    and adjudication <> 'null'::jsonb
    and adjudication ->> 'schema_version' is distinct from '2'
  then
    raise exception using
      errcode = '22023',
      message = 'semantic_adjudication_invalid';
  end if;

  return query
  select *
  from app_private.complete_worksheet_answer_with_adjudication_v2(
    target_job_id,
    target_queue_message_id,
    worker_id,
    result,
    adjudication
  );
end;
$$;

revoke all on function app_private.complete_worksheet_answer_phase_12r(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.complete_worksheet_answer_phase_12r(
  uuid, bigint, uuid, jsonb, jsonb
) to service_role;

create or replace function api.complete_worksheet_answer_adjudication(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb,
  adjudication jsonb
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
  from app_private.complete_worksheet_answer_phase_12r(
    target_job_id,
    target_queue_message_id,
    worker_id,
    result,
    adjudication
  );
$$;

revoke all on function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) to service_role;

comment on table app_private.worksheet_answer_adjudication_evidence_v2 is
  'Immutable answer-free schema-v2 hashes proving DeepSeek/Gemini evaluation and optional DeepSeek Pro adjudication.';
comment on function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) is
  'Invoker-only semantic answer boundary; accepts Gemini schema-v2 evidence or exact historical succeeded OpenAI replay.';

-- ---------------------------------------------------------------------------
-- Private, job-scoped AI spend reservations.
--
-- Rates deliberately use standard/cache-miss prices. Discounted cache usage
-- therefore creates headroom rather than weakening the cap. Reservations
-- contain identifiers, bounded token counts, and money only: never student
-- text, prompts, provider responses, or worksheet content.
-- ---------------------------------------------------------------------------

create table app_private.ai_model_cost_policies (
  provider_name text not null,
  model_name text not null,
  call_purpose text not null,
  input_rate_microusd_per_million bigint not null check (
    input_rate_microusd_per_million between 1 and 100000000
  ),
  output_rate_microusd_per_million bigint not null check (
    output_rate_microusd_per_million between 1 and 100000000
  ),
  maximum_reservation_microusd bigint not null check (
    maximum_reservation_microusd between 1 and 1000000
  ),
  created_at timestamptz not null default now(),
  primary key (provider_name, model_name, call_purpose),
  constraint ai_model_cost_policies_provider_check check (
    provider_name in ('deepseek', 'gemini')
  ),
  constraint ai_model_cost_policies_purpose_check check (
    call_purpose in (
      'writing_generation',
      'writing_critique',
      'writing_adjudication',
      'writing_final_critique',
      'worksheet_generation',
      'worksheet_critique',
      'worksheet_answer_evaluation',
      'worksheet_answer_adjudication'
    )
  )
);

insert into app_private.ai_model_cost_policies (
  provider_name,
  model_name,
  call_purpose,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  maximum_reservation_microusd
)
values
  ('deepseek', 'deepseek-v4-flash', 'writing_generation',
    140000, 280000, 75000),
  ('deepseek', 'deepseek-v4-flash', 'worksheet_critique',
    140000, 280000, 50000),
  ('deepseek', 'deepseek-v4-flash', 'worksheet_answer_evaluation',
    140000, 280000, 50000),
  ('deepseek', 'deepseek-v4-pro', 'writing_generation',
    435000, 870000, 100000),
  ('deepseek', 'deepseek-v4-pro', 'writing_adjudication',
    435000, 870000, 75000),
  ('deepseek', 'deepseek-v4-pro', 'worksheet_generation',
    435000, 870000, 100000),
  ('deepseek', 'deepseek-v4-pro', 'worksheet_answer_adjudication',
    435000, 870000, 50000),
  ('gemini', 'gemini-2.5-flash', 'writing_critique',
    300000, 2500000, 75000),
  ('gemini', 'gemini-2.5-flash', 'worksheet_critique',
    300000, 2500000, 75000),
  ('gemini', 'gemini-3.1-flash-lite', 'worksheet_answer_evaluation',
    250000, 1500000, 50000),
  ('gemini', 'gemini-3.5-flash', 'writing_generation',
    1500000, 9000000, 300000),
  ('gemini', 'gemini-3.5-flash', 'writing_final_critique',
    1500000, 9000000, 150000),
  ('gemini', 'gemini-3.5-flash', 'worksheet_generation',
    1500000, 9000000, 200000);

create table app_private.ai_spend_global_policy (
  singleton boolean primary key default true check (singleton),
  monthly_limit_microusd bigint not null default 500000000 check (
    monthly_limit_microusd between 1000000 and 10000000000
  ),
  default_workspace_monthly_limit_microusd bigint not null
    default 100000000 check (
      default_workspace_monthly_limit_microusd between 1000000 and 10000000000
    ),
  emergency_stop boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

insert into app_private.ai_spend_global_policy (
  singleton,
  monthly_limit_microusd,
  default_workspace_monthly_limit_microusd,
  emergency_stop
) values (true, 500000000, 100000000, false);

create table app_private.ai_workspace_monthly_budgets (
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  billing_month date not null,
  monthly_limit_microusd bigint not null check (
    monthly_limit_microusd between 1000000 and 10000000000
  ),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, billing_month),
  constraint ai_workspace_budget_month_start_check check (
    billing_month = date_trunc('month', billing_month)::date
  )
);

create table app_private.ai_budget_change_audit (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('global', 'workspace')),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  billing_month date,
  old_monthly_limit_microusd bigint,
  new_monthly_limit_microusd bigint,
  old_default_workspace_limit_microusd bigint,
  new_default_workspace_limit_microusd bigint,
  old_emergency_stop boolean,
  new_emergency_stop boolean,
  new_revision integer not null check (new_revision > 0),
  changed_by_user_id uuid,
  changed_by_database_role text not null,
  changed_at timestamptz not null default now(),
  constraint ai_budget_change_audit_scope_shape_check check (
    (
      scope = 'global'
      and workspace_id is null
      and billing_month is null
    )
    or (
      scope = 'workspace'
      and workspace_id is not null
      and billing_month is not null
      and old_default_workspace_limit_microusd is null
      and new_default_workspace_limit_microusd is null
      and old_emergency_stop is null
      and new_emergency_stop is null
    )
  )
);

create table app_private.ai_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null
    references app_private.async_jobs(id) on delete restrict,
  entity_version integer not null check (entity_version > 0),
  call_key text not null check (
    call_key ~ '^[a-z][a-z0-9._:-]{0,119}$'
  ),
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  billing_month date not null,
  provider_name text not null,
  model_name text not null,
  call_purpose text not null,
  input_rate_microusd_per_million bigint not null check (
    input_rate_microusd_per_million > 0
  ),
  output_rate_microusd_per_million bigint not null check (
    output_rate_microusd_per_million > 0
  ),
  reserved_microusd bigint not null check (reserved_microusd > 0),
  state text not null default 'reserved' check (
    state in ('reserved', 'finalized', 'released')
  ),
  actual_microusd bigint check (
    actual_microusd is null or actual_microusd >= 0
  ),
  billed_input_tokens bigint check (
    billed_input_tokens is null or billed_input_tokens >= 0
  ),
  billed_output_tokens bigint check (
    billed_output_tokens is null or billed_output_tokens >= 0
  ),
  release_reason text check (
    release_reason is null or release_reason in (
      'provider_not_called',
      'request_failed_unbilled',
      'superseded',
      'job_cancelled'
    )
  ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  released_at timestamptz,
  unique (job_id, entity_version, call_key),
  constraint ai_spend_reservation_state_shape_check check (
    (
      state = 'reserved'
      and actual_microusd is null
      and billed_input_tokens is null
      and billed_output_tokens is null
      and release_reason is null
      and finalized_at is null
      and released_at is null
    )
    or (
      state = 'finalized'
      and actual_microusd is not null
      and actual_microusd <= reserved_microusd
      and billed_input_tokens is not null
      and billed_output_tokens is not null
      and release_reason is null
      and finalized_at is not null
      and released_at is null
    )
    or (
      state = 'released'
      and actual_microusd is null
      and billed_input_tokens is null
      and billed_output_tokens is null
      and release_reason is not null
      and finalized_at is null
      and released_at is not null
    )
  )
);

create index ai_spend_reservations_workspace_month_idx
on app_private.ai_spend_reservations (
  workspace_id, billing_month, state, created_at, id
);

create index ai_spend_reservations_global_month_idx
on app_private.ai_spend_reservations (billing_month, state, created_at, id);

create or replace function app_private.ai_spend_cost_microusd(
  input_tokens bigint,
  output_tokens bigint,
  input_rate_microusd_per_million bigint,
  output_rate_microusd_per_million bigint
)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select
    ceil(
      (input_tokens::numeric * input_rate_microusd_per_million::numeric) /
        1000000
    )::bigint +
    ceil(
      (output_tokens::numeric * output_rate_microusd_per_million::numeric) /
        1000000
    )::bigint;
$$;

revoke all on function app_private.ai_spend_cost_microusd(
  bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;

alter table app_private.ai_model_cost_policies enable row level security;
alter table app_private.ai_spend_global_policy enable row level security;
alter table app_private.ai_workspace_monthly_budgets enable row level security;
alter table app_private.ai_budget_change_audit enable row level security;
alter table app_private.ai_spend_reservations enable row level security;

revoke all on table app_private.ai_model_cost_policies
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_spend_global_policy
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_workspace_monthly_budgets
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_budget_change_audit
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_spend_reservations
from public, anon, authenticated, service_role;

create or replace function app_private.reject_ai_spend_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table_name in ('ai_spend_reservations', 'ai_budget_change_audit')
    and current_setting('app.ai_spend_transition', true) = 'on'
  then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception using
    errcode = '55000',
    message = 'ai_spend_evidence_immutable';
end;
$$;

revoke all on function app_private.reject_ai_spend_evidence_mutation()
from public, anon, authenticated, service_role;

create trigger ai_model_cost_policies_immutable
before insert or update or delete on app_private.ai_model_cost_policies
for each row execute function app_private.reject_ai_spend_evidence_mutation();

create trigger ai_budget_change_audit_immutable
before insert or update or delete on app_private.ai_budget_change_audit
for each row execute function app_private.reject_ai_spend_evidence_mutation();

create trigger ai_spend_reservations_guard
before insert or update or delete on app_private.ai_spend_reservations
for each row execute function app_private.reject_ai_spend_evidence_mutation();

create or replace function app_private.prepare_ai_budget_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'ai_budget_delete_forbidden';
  end if;

  if tg_op = 'UPDATE' then
    if tg_table_name = 'ai_spend_global_policy'
      and new.singleton is distinct from old.singleton
    then
      raise exception using errcode = '55000', message = 'ai_budget_key_immutable';
    elsif tg_table_name = 'ai_workspace_monthly_budgets'
      and (
        new.workspace_id is distinct from old.workspace_id
        or new.billing_month is distinct from old.billing_month
      )
    then
      raise exception using errcode = '55000', message = 'ai_budget_key_immutable';
    end if;
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function app_private.prepare_ai_budget_change()
from public, anon, authenticated, service_role;

create or replace function app_private.audit_ai_budget_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.ai_spend_transition', 'on', true);
  if tg_table_name = 'ai_spend_global_policy' then
    insert into app_private.ai_budget_change_audit (
      scope,
      old_monthly_limit_microusd,
      new_monthly_limit_microusd,
      old_default_workspace_limit_microusd,
      new_default_workspace_limit_microusd,
      old_emergency_stop,
      new_emergency_stop,
      new_revision,
      changed_by_user_id,
      changed_by_database_role
    ) values (
      'global',
      case when tg_op = 'UPDATE' then old.monthly_limit_microusd else null end,
      new.monthly_limit_microusd,
      case when tg_op = 'UPDATE'
        then old.default_workspace_monthly_limit_microusd else null end,
      new.default_workspace_monthly_limit_microusd,
      case when tg_op = 'UPDATE' then old.emergency_stop else null end,
      new.emergency_stop,
      new.revision,
      (select auth.uid()),
      session_user
    );
  else
    insert into app_private.ai_budget_change_audit (
      scope,
      workspace_id,
      billing_month,
      old_monthly_limit_microusd,
      new_monthly_limit_microusd,
      new_revision,
      changed_by_user_id,
      changed_by_database_role
    ) values (
      'workspace',
      new.workspace_id,
      new.billing_month,
      case when tg_op = 'UPDATE' then old.monthly_limit_microusd else null end,
      new.monthly_limit_microusd,
      new.revision,
      (select auth.uid()),
      session_user
    );
  end if;
  perform set_config('app.ai_spend_transition', 'off', true);
  return new;
end;
$$;

revoke all on function app_private.audit_ai_budget_change()
from public, anon, authenticated, service_role;

create trigger ai_spend_global_policy_prepare
before update or delete on app_private.ai_spend_global_policy
for each row execute function app_private.prepare_ai_budget_change();
create trigger ai_workspace_monthly_budgets_prepare
before update or delete on app_private.ai_workspace_monthly_budgets
for each row execute function app_private.prepare_ai_budget_change();

create trigger ai_spend_global_policy_audit
after insert or update on app_private.ai_spend_global_policy
for each row execute function app_private.audit_ai_budget_change();
create trigger ai_workspace_monthly_budgets_audit
after insert or update on app_private.ai_workspace_monthly_budgets
for each row execute function app_private.audit_ai_budget_change();

create or replace function app_private.reserve_ai_spend(
  target_job_id uuid,
  target_entity_version integer,
  call_key text,
  provider_name text,
  model_name text,
  call_purpose text,
  maximum_cost_microusd bigint,
  reservation_ttl_seconds integer default 900
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  workspace_remaining_microusd bigint,
  global_remaining_microusd bigint,
  expires_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_policy app_private.ai_model_cost_policies%rowtype;
  global_policy app_private.ai_spend_global_policy%rowtype;
  workspace_budget app_private.ai_workspace_monthly_budgets%rowtype;
  recorded app_private.ai_spend_reservations%rowtype;
  selected_workspace_id uuid;
  selected_billing_month date :=
    date_trunc('month', timezone('UTC', now()))::date;
  workspace_committed bigint := 0;
  global_committed bigint := 0;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_entity_version is null
    or target_entity_version <= 0
    or coalesce(call_key, '') !~ '^[a-z][a-z0-9._:-]{0,119}$'
    or coalesce(provider_name, '') not in ('deepseek', 'gemini')
    or coalesce(model_name, '') = ''
    or coalesce(call_purpose, '') = ''
    or maximum_cost_microusd is null
    or maximum_cost_microusd <= 0
    or reservation_ttl_seconds is null
    or reservation_ttl_seconds not between 60 and 7200
  then
    raise exception using errcode = '22023', message = 'ai_spend_contract_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;
  if selected_job.entity_version <> target_entity_version then
    raise exception using
      errcode = '55000',
      message = 'ai_spend_job_version_mismatch';
  end if;
  if not (
    (selected_job.job_kind = 'writing_evaluation'
      and call_purpose in (
        'writing_generation', 'writing_critique',
        'writing_adjudication', 'writing_final_critique'
      ))
    or (selected_job.job_kind = 'worksheet_generation'
      and call_purpose in ('worksheet_generation', 'worksheet_critique'))
    or (selected_job.job_kind = 'worksheet_answer_evaluation'
      and call_purpose in (
        'worksheet_answer_evaluation', 'worksheet_answer_adjudication'
      ))
  ) then
    raise exception using errcode = '22023', message = 'ai_spend_model_not_allowed';
  end if;

  select policy.*
  into selected_policy
  from app_private.ai_model_cost_policies policy
  where policy.provider_name = reserve_ai_spend.provider_name
    and policy.model_name = reserve_ai_spend.model_name
    and policy.call_purpose = reserve_ai_spend.call_purpose;

  if selected_policy.provider_name is null
    or maximum_cost_microusd <>
      selected_policy.maximum_reservation_microusd
  then
    raise exception using errcode = '22023', message = 'ai_spend_model_not_allowed';
  end if;

  if selected_job.job_kind = 'writing_evaluation' then
    select submission.workspace_id
    into selected_workspace_id
    from public.submissions submission
    where submission.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_generation' then
    select assignment.workspace_id
    into selected_workspace_id
    from public.student_practice_assignments assignment
    where assignment.id = selected_job.entity_id;
  else
    select assignment.workspace_id
    into selected_workspace_id
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = selected_job.entity_id;
  end if;

  if selected_workspace_id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;

  select reservation.*
  into recorded
  from app_private.ai_spend_reservations reservation
  where reservation.job_id = target_job_id
    and reservation.entity_version = target_entity_version
    and reservation.call_key = reserve_ai_spend.call_key
  for update;

  -- A job can legitimately cross a UTC month boundary during bounded outage
  -- recovery. Exact replay remains attached to its original billing month.
  if recorded.id is not null then
    selected_billing_month := recorded.billing_month;
  end if;

  select policy.*
  into strict global_policy
  from app_private.ai_spend_global_policy policy
  where policy.singleton
  for update;

  insert into app_private.ai_workspace_monthly_budgets (
    workspace_id,
    billing_month,
    monthly_limit_microusd
  ) values (
    selected_workspace_id,
    selected_billing_month,
    global_policy.default_workspace_monthly_limit_microusd
  ) on conflict (workspace_id, billing_month) do nothing;

  select budget.*
  into strict workspace_budget
  from app_private.ai_workspace_monthly_budgets budget
  where budget.workspace_id = selected_workspace_id
    and budget.billing_month = selected_billing_month
  for update;

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into workspace_committed
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = selected_workspace_id
    and reservation.billing_month = selected_billing_month;

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into global_committed
  from app_private.ai_spend_reservations reservation
  where reservation.billing_month = selected_billing_month;

  if recorded.id is not null then
    if recorded.workspace_id <> selected_workspace_id
      or recorded.billing_month <> selected_billing_month
      or recorded.provider_name <> reserve_ai_spend.provider_name
      or recorded.model_name <> reserve_ai_spend.model_name
      or recorded.call_purpose <> reserve_ai_spend.call_purpose
      or recorded.reserved_microusd <> maximum_cost_microusd
    then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_conflict';
    end if;
    if recorded.state = 'reserved' and recorded.expires_at <= now() then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_expired';
    end if;
    if recorded.state = 'reserved' and selected_job.status <> 'processing' then
      raise exception using errcode = '55000', message = 'ai_spend_job_not_active';
    end if;
    if recorded.state = 'reserved' and global_policy.emergency_stop then
      raise exception using errcode = '53000', message = 'ai_spend_emergency_stop';
    end if;

    return query select
      recorded.id,
      recorded.state,
      recorded.reserved_microusd,
      greatest(workspace_budget.monthly_limit_microusd - workspace_committed, 0),
      greatest(global_policy.monthly_limit_microusd - global_committed, 0),
      recorded.expires_at,
      true;
    return;
  end if;

  if selected_job.status <> 'processing' then
    raise exception using errcode = '55000', message = 'ai_spend_job_not_active';
  end if;

  if global_policy.emergency_stop then
    raise exception using errcode = '53000', message = 'ai_spend_emergency_stop';
  end if;
  if workspace_committed + maximum_cost_microusd >
      workspace_budget.monthly_limit_microusd
  then
    raise exception using
      errcode = '53000',
      message = 'ai_spend_workspace_budget_exceeded';
  end if;
  if global_committed + maximum_cost_microusd >
      global_policy.monthly_limit_microusd
  then
    raise exception using
      errcode = '53000',
      message = 'ai_spend_global_budget_exceeded';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  insert into app_private.ai_spend_reservations (
    job_id,
    entity_version,
    call_key,
    workspace_id,
    billing_month,
    provider_name,
    model_name,
    call_purpose,
    input_rate_microusd_per_million,
    output_rate_microusd_per_million,
    reserved_microusd,
    expires_at
  ) values (
    target_job_id,
    target_entity_version,
    reserve_ai_spend.call_key,
    selected_workspace_id,
    selected_billing_month,
    reserve_ai_spend.provider_name,
    reserve_ai_spend.model_name,
    reserve_ai_spend.call_purpose,
    selected_policy.input_rate_microusd_per_million,
    selected_policy.output_rate_microusd_per_million,
    maximum_cost_microusd,
    now() + make_interval(secs => reservation_ttl_seconds)
  ) returning * into recorded;
  perform set_config('app.ai_spend_transition', 'off', true);

  return query select
    recorded.id,
    recorded.state,
    recorded.reserved_microusd,
    workspace_budget.monthly_limit_microusd -
      workspace_committed - recorded.reserved_microusd,
    global_policy.monthly_limit_microusd -
      global_committed - recorded.reserved_microusd,
    recorded.expires_at,
    false;
end;
$$;

revoke all on function app_private.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) to service_role;

create or replace function app_private.finalize_ai_spend_reservation(
  target_reservation_id uuid,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  finalized_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recorded app_private.ai_spend_reservations%rowtype;
  computed_actual_microusd bigint;
begin
  perform app_private.assert_service_role();
  if target_reservation_id is null
    or target_billed_input_tokens is null
    or target_billed_output_tokens is null
    or target_billed_input_tokens not between 0 and 10000000
    or target_billed_output_tokens not between 0 and 10000000
  then
    raise exception using errcode = '22023', message = 'ai_spend_contract_invalid';
  end if;

  select reservation.*
  into recorded
  from app_private.ai_spend_reservations reservation
  where reservation.id = target_reservation_id
  for update;

  if recorded.id is null then
    raise exception using
      errcode = '02000',
      message = 'ai_spend_reservation_missing';
  end if;
  if recorded.state = 'released' then
    raise exception using
      errcode = '55000',
      message = 'ai_spend_reservation_conflict';
  end if;

  computed_actual_microusd := app_private.ai_spend_cost_microusd(
    target_billed_input_tokens,
    target_billed_output_tokens,
    recorded.input_rate_microusd_per_million,
    recorded.output_rate_microusd_per_million
  );

  if recorded.state = 'finalized' then
    if recorded.billed_input_tokens <>
        target_billed_input_tokens
      or recorded.billed_output_tokens <>
        target_billed_output_tokens
      or recorded.actual_microusd <> computed_actual_microusd
    then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_conflict';
    end if;

    return query select
      recorded.id,
      recorded.state,
      recorded.reserved_microusd,
      recorded.actual_microusd,
      recorded.billed_input_tokens,
      recorded.billed_output_tokens,
      recorded.finalized_at,
      true;
    return;
  end if;

  if computed_actual_microusd > recorded.reserved_microusd then
    raise exception using
      errcode = '55000',
      message = 'ai_spend_actual_exceeds_reserved';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  update app_private.ai_spend_reservations reservation
  set
    state = 'finalized',
    actual_microusd = computed_actual_microusd,
    billed_input_tokens = target_billed_input_tokens,
    billed_output_tokens = target_billed_output_tokens,
    finalized_at = now()
  where reservation.id = recorded.id
  returning * into recorded;
  perform set_config('app.ai_spend_transition', 'off', true);

  return query select
    recorded.id,
    recorded.state,
    recorded.reserved_microusd,
    recorded.actual_microusd,
    recorded.billed_input_tokens,
    recorded.billed_output_tokens,
    recorded.finalized_at,
    false;
end;
$$;

revoke all on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint
) from public, anon, authenticated, service_role;
grant execute on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint
) to service_role;

create or replace function app_private.release_ai_spend_reservation(
  target_reservation_id uuid,
  release_reason text
)
returns table (
  reservation_id uuid,
  state text,
  released_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recorded app_private.ai_spend_reservations%rowtype;
begin
  perform app_private.assert_service_role();
  if target_reservation_id is null
    or coalesce(release_ai_spend_reservation.release_reason, '') not in (
      'provider_not_called',
      'request_failed_unbilled',
      'superseded',
      'job_cancelled'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'ai_spend_release_reason_invalid';
  end if;

  select reservation.*
  into recorded
  from app_private.ai_spend_reservations reservation
  where reservation.id = target_reservation_id
  for update;

  if recorded.id is null then
    raise exception using
      errcode = '02000',
      message = 'ai_spend_reservation_missing';
  end if;
  if recorded.state = 'finalized' then
    raise exception using
      errcode = '55000',
      message = 'ai_spend_reservation_conflict';
  end if;
  if recorded.state = 'released' then
    if recorded.release_reason <>
      release_ai_spend_reservation.release_reason
    then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_conflict';
    end if;
    return query select recorded.id, recorded.state, recorded.released_at, true;
    return;
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  update app_private.ai_spend_reservations reservation
  set
    state = 'released',
    release_reason = release_ai_spend_reservation.release_reason,
    released_at = now()
  where reservation.id = recorded.id
  returning * into recorded;
  perform set_config('app.ai_spend_transition', 'off', true);

  return query select recorded.id, recorded.state, recorded.released_at, false;
end;
$$;

revoke all on function app_private.release_ai_spend_reservation(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function app_private.release_ai_spend_reservation(uuid, text)
to service_role;

create or replace function api.reserve_ai_spend(
  target_job_id uuid,
  target_entity_version integer,
  call_key text,
  provider_name text,
  model_name text,
  call_purpose text,
  maximum_cost_microusd bigint,
  reservation_ttl_seconds integer default 900
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  workspace_remaining_microusd bigint,
  global_remaining_microusd bigint,
  expires_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.reserve_ai_spend(
    target_job_id,
    target_entity_version,
    call_key,
    provider_name,
    model_name,
    call_purpose,
    maximum_cost_microusd,
    reservation_ttl_seconds
  );
$$;

create or replace function api.finalize_ai_spend_reservation(
  target_reservation_id uuid,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  finalized_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.finalize_ai_spend_reservation(
    target_reservation_id,
    target_billed_input_tokens,
    target_billed_output_tokens
  );
$$;

create or replace function api.release_ai_spend_reservation(
  target_reservation_id uuid,
  release_reason text
)
returns table (
  reservation_id uuid,
  state text,
  released_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.release_ai_spend_reservation(
    target_reservation_id,
    release_reason
  );
$$;

revoke all on function api.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) from public, anon, authenticated;
grant execute on function api.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) to service_role;

revoke all on function api.finalize_ai_spend_reservation(uuid, bigint, bigint)
from public, anon, authenticated;
grant execute on function api.finalize_ai_spend_reservation(uuid, bigint, bigint)
to service_role;

revoke all on function api.release_ai_spend_reservation(uuid, text)
from public, anon, authenticated;
grant execute on function api.release_ai_spend_reservation(uuid, text)
to service_role;

create or replace function app_private.get_ai_spend_health(
  target_workspace_id uuid default null
)
returns table (
  billing_month date,
  workspace_id uuid,
  finalized_actual_microusd bigint,
  reserved_committed_microusd bigint,
  active_reserved_count bigint,
  released_count bigint,
  oldest_reserved_age_seconds bigint,
  global_monthly_limit_microusd bigint,
  global_remaining_microusd bigint,
  workspace_monthly_limit_microusd bigint,
  workspace_remaining_microusd bigint,
  emergency_stop boolean,
  provider_model_purpose_totals jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  selected_month date := date_trunc(
    'month', timezone('UTC', now())
  )::date;
  global_policy app_private.ai_spend_global_policy%rowtype;
  selected_workspace_limit bigint;
  scope_actual bigint := 0;
  scope_reserved bigint := 0;
  scope_reserved_count bigint := 0;
  scope_released_count bigint := 0;
  scope_oldest_reserved_age bigint;
  global_committed bigint := 0;
  workspace_committed bigint;
  aggregate_totals jsonb := '[]'::jsonb;
begin
  perform app_private.assert_service_role();

  if target_workspace_id is not null
    and not exists (
      select 1
      from public.workspaces workspace
      where workspace.id = target_workspace_id
    )
  then
    raise exception using errcode = '02000', message = 'ai_spend_workspace_missing';
  end if;

  select policy.*
  into strict global_policy
  from app_private.ai_spend_global_policy policy
  where policy.singleton;

  select
    coalesce(sum(reservation.actual_microusd)
      filter (where reservation.state = 'finalized'), 0)::bigint,
    coalesce(sum(reservation.reserved_microusd)
      filter (where reservation.state = 'reserved'), 0)::bigint,
    count(*) filter (where reservation.state = 'reserved'),
    count(*) filter (where reservation.state = 'released'),
    extract(epoch from (
      now() - min(reservation.created_at)
        filter (where reservation.state = 'reserved')
    ))::bigint
  into
    scope_actual,
    scope_reserved,
    scope_reserved_count,
    scope_released_count,
    scope_oldest_reserved_age
  from app_private.ai_spend_reservations reservation
  where reservation.billing_month = selected_month
    and (
      target_workspace_id is null
      or reservation.workspace_id = target_workspace_id
    );

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into global_committed
  from app_private.ai_spend_reservations reservation
  where reservation.billing_month = selected_month;

  if target_workspace_id is not null then
    select coalesce(
      (
        select budget.monthly_limit_microusd
        from app_private.ai_workspace_monthly_budgets budget
        where budget.workspace_id = target_workspace_id
          and budget.billing_month = selected_month
      ),
      global_policy.default_workspace_monthly_limit_microusd
    )
    into selected_workspace_limit;

    select coalesce(sum(case
      when reservation.state = 'finalized' then reservation.actual_microusd
      when reservation.state = 'reserved' then reservation.reserved_microusd
      else 0
    end), 0)::bigint
    into workspace_committed
    from app_private.ai_spend_reservations reservation
    where reservation.billing_month = selected_month
      and reservation.workspace_id = target_workspace_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_name', grouped.provider_name,
    'model_name', grouped.model_name,
    'call_purpose', grouped.call_purpose,
    'finalized_call_count', grouped.finalized_call_count,
    'finalized_input_tokens', grouped.finalized_input_tokens,
    'finalized_output_tokens', grouped.finalized_output_tokens,
    'finalized_actual_microusd', grouped.finalized_actual_microusd,
    'reserved_call_count', grouped.reserved_call_count,
    'reserved_microusd', grouped.reserved_microusd,
    'released_call_count', grouped.released_call_count
  ) order by grouped.provider_name, grouped.model_name, grouped.call_purpose),
  '[]'::jsonb)
  into aggregate_totals
  from (
    select
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose,
      count(*) filter (where reservation.state = 'finalized')
        as finalized_call_count,
      coalesce(sum(reservation.billed_input_tokens)
        filter (where reservation.state = 'finalized'), 0)::bigint
        as finalized_input_tokens,
      coalesce(sum(reservation.billed_output_tokens)
        filter (where reservation.state = 'finalized'), 0)::bigint
        as finalized_output_tokens,
      coalesce(sum(reservation.actual_microusd)
        filter (where reservation.state = 'finalized'), 0)::bigint
        as finalized_actual_microusd,
      count(*) filter (where reservation.state = 'reserved')
        as reserved_call_count,
      coalesce(sum(reservation.reserved_microusd)
        filter (where reservation.state = 'reserved'), 0)::bigint
        as reserved_microusd,
      count(*) filter (where reservation.state = 'released')
        as released_call_count
    from app_private.ai_spend_reservations reservation
    where reservation.billing_month = selected_month
      and (
        target_workspace_id is null
        or reservation.workspace_id = target_workspace_id
      )
    group by
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose
  ) grouped;

  return query select
    selected_month,
    target_workspace_id,
    scope_actual,
    scope_reserved,
    scope_reserved_count,
    scope_released_count,
    scope_oldest_reserved_age,
    global_policy.monthly_limit_microusd,
    greatest(global_policy.monthly_limit_microusd - global_committed, 0),
    selected_workspace_limit,
    case when selected_workspace_limit is null then null::bigint
      else greatest(selected_workspace_limit - workspace_committed, 0)
    end,
    global_policy.emergency_stop,
    aggregate_totals;
end;
$$;

revoke all on function app_private.get_ai_spend_health(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.get_ai_spend_health(uuid)
to service_role;

create or replace function api.get_ai_spend_health(
  target_workspace_id uuid default null
)
returns table (
  billing_month date,
  workspace_id uuid,
  finalized_actual_microusd bigint,
  reserved_committed_microusd bigint,
  active_reserved_count bigint,
  released_count bigint,
  oldest_reserved_age_seconds bigint,
  global_monthly_limit_microusd bigint,
  global_remaining_microusd bigint,
  workspace_monthly_limit_microusd bigint,
  workspace_remaining_microusd bigint,
  emergency_stop boolean,
  provider_model_purpose_totals jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.get_ai_spend_health(target_workspace_id);
$$;

revoke all on function api.get_ai_spend_health(uuid)
from public, anon, authenticated;
grant execute on function api.get_ai_spend_health(uuid)
to service_role;

comment on function api.get_ai_spend_health(uuid) is
  'Service-only content-free monthly spend health. Workspace identity is returned only when the caller explicitly supplies that workspace.';

comment on table app_private.ai_spend_reservations is
  'Private job/version/call-scoped AI cost reservations; never student text or provider payloads. Unresolved billing stays charged against both hard caps.';
comment on table app_private.ai_workspace_monthly_budgets is
  'Operator-only monthly workspace AI cap. New months default to USD 100; larger contracted cohorts require an audited database-owner override.';
comment on table app_private.ai_spend_global_policy is
  'Singleton USD 500 monthly hard cap and emergency stop. No browser or service role may mutate it directly.';
comment on function api.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) is
  'Service-only idempotent provider-call reservation. No student content is accepted or stored.';

-- Keep the exposed worksheet facade as an invoker-only boundary. Its private
-- definer owns the minimum transactional privileges needed to call the sealed
-- Phase 9A materializer.
alter function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
  set schema app_private;
alter function app_private.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) rename to complete_worksheet_generation_phase_12r;

revoke all on function app_private.complete_worksheet_generation_phase_12r(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.complete_worksheet_generation_phase_12r(
  uuid, bigint, uuid, jsonb
) to service_role;

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
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.complete_worksheet_generation_phase_12r(
    target_job_id,
    target_queue_message_id,
    worker_id,
    worksheet
  );
$$;

revoke all on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated;
grant execute on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) to service_role;

comment on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) is
  'Invoker-only worksheet completion boundary; private implementation permits Gemini v2 or exact historical succeeded OpenAI replay.';

notify pgrst, 'reload schema';
