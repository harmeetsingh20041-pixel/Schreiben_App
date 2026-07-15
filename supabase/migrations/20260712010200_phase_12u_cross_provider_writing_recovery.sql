-- Phase 12U: one-way cross-provider writing recovery.
--
-- A Gemini strong candidate may be released only after both pinned DeepSeek
-- generators failed deterministic validation and a fresh DeepSeek Pro critic
-- approved the exact candidate/release hashes. Gemini may never approve a
-- Gemini-generated recovery candidate. Existing Phase 12R evidence remains
-- valid and immutable.

alter table app_private.writing_feedback_adjudications_v2
  drop constraint if exists writing_feedback_adjudications_v2_reason_code_check,
  drop constraint if exists writing_feedback_adjudications_v2_critic_provider_check,
  drop constraint if exists writing_feedback_adjudications_v2_accepted_provider_check,
  drop constraint if exists writing_feedback_adjudications_v2_critic_shape_check,
  drop constraint if exists writing_feedback_adjudications_v2_decision_shape_check;

alter table app_private.writing_feedback_adjudications_v2
  add constraint writing_feedback_adjudications_v2_reason_code_check check (
    reason_code in (
      'critic_approved',
      'final_critic_approved',
      'recovery_critic_approved',
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
    )
  ),
  add constraint writing_feedback_adjudications_v2_critic_provider_check check (
    critic_provider is null or critic_provider in ('gemini', 'deepseek')
  ),
  add constraint writing_feedback_adjudications_v2_accepted_provider_check check (
    accepted_provider is null or accepted_provider in ('deepseek', 'gemini')
  ),
  add constraint writing_feedback_adjudications_v2_critic_shape_check check (
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
      or (
        critic_provider = 'deepseek'
        and critic_model = 'deepseek-v4-pro'
      )
    ), false)
  ),
  add constraint writing_feedback_adjudications_v2_decision_shape_check check (
    coalesce((
      (
        decision = 'system_hold'
        and reason_code not in (
          'critic_approved',
          'final_critic_approved',
          'recovery_critic_approved'
        )
        and accepted_provider is null
        and accepted_model is null
      )
      or (
        decision = 'accepted_model_feedback'
        and candidate_feedback_sha256 is not null
        and candidate_release_sha256 is not null
        and (
          (
            reason_code = 'critic_approved'
            and generator_provider = 'deepseek'
            and accepted_provider = 'deepseek'
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
            and accepted_provider = 'deepseek'
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
          or (
            reason_code = 'recovery_critic_approved'
            and generator_provider = 'gemini'
            and generator_model = 'gemini-3.5-flash'
            and accepted_provider = 'gemini'
            and accepted_model = 'gemini-3.5-flash'
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'deepseek'
            and critic_model = 'deepseek-v4-pro'
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
        )
      )
    ), false)
  );

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
      or evidence ->> 'accepted_provider' not in ('deepseek', 'gemini')
      or evidence ->> 'accepted_provider'
        is distinct from evidence ->> 'generator_provider'
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
      or v2_evidence.accepted_provider not in ('deepseek', 'gemini')
      or v2_evidence.accepted_provider is distinct from
        v2_evidence.generator_provider
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

comment on table app_private.writing_feedback_adjudications_v2 is
  'Immutable writing release evidence. Gemini recovery requires exact-hash approval from fresh DeepSeek Pro; same-provider approval is forbidden.';

comment on function app_private.record_or_assert_writing_adjudication_v2(
  uuid, bigint, uuid, jsonb
) is
  'Validates and records immutable schema-v2 writing evidence, including one-way Gemini generation with DeepSeek Pro recovery criticism.';
