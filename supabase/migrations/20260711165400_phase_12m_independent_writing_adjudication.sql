-- Phase 12M: no automatic writing release may rest on one model's opinion.
--
-- The worker records only immutable hashes, bounded verdicts, and pinned model
-- provenance. Student writing, provider prompts, responses, and feedback bodies
-- remain outside this ledger. Automatic release is allowed only for evidence
-- accepted by the independent critic/adjudicator contract. A teacher release
-- remains a separate human decision and is intentionally permitted.

create or replace function app_private.canonical_jsonb_text(target_value jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  result text;
begin
  case pg_catalog.jsonb_typeof(target_value)
    when 'object' then
      select '{' || coalesce(pg_catalog.string_agg(
        pg_catalog.to_jsonb(entry.key)::text || ':' ||
          app_private.canonical_jsonb_text(entry.value),
        ',' order by entry.key
      ), '') || '}'
      into result
      from pg_catalog.jsonb_each(target_value) entry;
      return result;
    when 'array' then
      select '[' || coalesce(pg_catalog.string_agg(
        app_private.canonical_jsonb_text(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      into result
      from pg_catalog.jsonb_array_elements(target_value)
        with ordinality as entry(value, ordinality);
      return result;
    else
      return target_value::text;
  end case;
end;
$$;

create or replace function app_private.canonical_jsonb_sha256(target_value jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        app_private.canonical_jsonb_text(target_value),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function app_private.canonical_jsonb_text(jsonb)
from public, anon, authenticated, service_role;
revoke all on function app_private.canonical_jsonb_sha256(jsonb)
from public, anon, authenticated, service_role;

create table app_private.writing_feedback_adjudications (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  submission_id uuid not null
    references public.submissions(id) on delete restrict,
  evaluation_version integer not null check (evaluation_version > 0),
  feedback_version integer not null check (feedback_version > 0),
  schema_version smallint not null check (schema_version = 1),
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
  context_sha256 text not null
    check (context_sha256 ~ '^[0-9a-f]{64}$'),
  original_text_sha256 text not null
    check (original_text_sha256 ~ '^[0-9a-f]{64}$'),
  final_feedback_sha256 text not null
    check (final_feedback_sha256 ~ '^[0-9a-f]{64}$'),
  generator_provider text not null
    check (generator_provider in ('deepseek', 'openai')),
  generator_model text not null,
  candidate_feedback_sha256 text
    check (
      candidate_feedback_sha256 is null
      or candidate_feedback_sha256 ~ '^[0-9a-f]{64}$'
    ),
  candidate_release_sha256 text
    check (
      candidate_release_sha256 is null
      or candidate_release_sha256 ~ '^[0-9a-f]{64}$'
    ),
  critic_provider text check (critic_provider is null or critic_provider = 'openai'),
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
    final_critic_provider is null or final_critic_provider = 'openai'
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
  constraint writing_feedback_adjudications_versions_match check (
    evaluation_version = feedback_version
  ),
  constraint writing_feedback_adjudications_generator_model_check check (
    (
      generator_provider = 'deepseek'
      and generator_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
    )
    or (
      generator_provider = 'openai'
      and generator_model = 'gpt-5.4-mini-2026-03-17'
    )
  ),
  constraint writing_feedback_adjudications_critic_shape_check check (
    coalesce((
      (
      critic_provider is null
      and critic_model is null
      and critic_verdict is null
      and critic_decision_sha256 is null
      )
      or (
        critic_provider = 'openai'
        and critic_model = 'gpt-5.4-2026-03-05'
      )
    ), false)
  ),
  constraint writing_feedback_adjudications_adjudicator_shape_check check (
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
  constraint writing_feedback_adjudications_final_critic_shape_check check (
    coalesce((
      (
        final_critic_provider is null
        and final_critic_model is null
        and final_critic_verdict is null
        and final_critic_decision_sha256 is null
      )
      or (
        final_critic_provider = 'openai'
        and final_critic_model = 'gpt-5.4-2026-03-05'
      )
    ), false)
  ),
  constraint writing_feedback_adjudications_decision_shape_check check (
    coalesce((
      (
      decision = 'system_hold'
      and reason_code not in (
        'critic_approved', 'final_critic_approved'
      )
      and accepted_provider is null
      and accepted_model is null
      )
      or (
        decision = 'accepted_model_feedback'
        and accepted_provider = 'deepseek'
        and (
          (
            reason_code = 'critic_approved'
            and accepted_model = generator_model
            and generator_provider = 'deepseek'
            and candidate_feedback_sha256 is not null
            and candidate_release_sha256 is not null
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'openai'
            and critic_model = 'gpt-5.4-2026-03-05'
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
            and candidate_feedback_sha256 is not null
            and candidate_release_sha256 is not null
            and critic_provider = 'openai'
            and critic_model = 'gpt-5.4-2026-03-05'
            and critic_verdict in ('disagreed', 'uncertain')
            and critic_decision_sha256 is not null
            and adjudicator_provider = 'deepseek'
            and adjudicator_model = 'deepseek-v4-pro'
            and adjudicator_verdict = 'resolved'
            and adjudicator_decision_sha256 is not null
            and resolved_feedback_sha256 is not null
            and final_critic_provider = 'openai'
            and final_critic_model = 'gpt-5.4-2026-03-05'
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

alter table app_private.writing_feedback_adjudications enable row level security;
revoke all on table app_private.writing_feedback_adjudications
from public, anon, authenticated, service_role;

create or replace function app_private.reject_writing_adjudication_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'writing_adjudication_immutable';
end;
$$;

revoke all on function app_private.reject_writing_adjudication_mutation()
from public, anon, authenticated, service_role;

create trigger writing_feedback_adjudications_immutable
before update or delete on app_private.writing_feedback_adjudications
for each row execute function app_private.reject_writing_adjudication_mutation();

-- The existing raw-context loader remains unchanged. This service-only loader
-- adds only the immutable version and hashes needed by the adjudication step.
create or replace function api.get_writing_adjudication_context(
  target_submission_id uuid
)
returns table (
  submission_id uuid,
  context_version smallint,
  context_sha256 text,
  original_text_sha256 text
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  select
    context.submission_id,
    context.context_version,
    context.context_sha256,
    context.original_text_sha256
  from app_private.writing_evaluation_contexts context
  join public.submissions submission
    on submission.id = context.submission_id
   and submission.workspace_id = context.workspace_id
   and submission.student_id = context.student_id
   and submission.batch_id = context.batch_id
   and submission.question_source = context.source_type
   and submission.mode = context.submission_mode
  where context.submission_id = target_submission_id
    and context.source_id is not distinct from case
      when context.source_type = 'workspace_question' then submission.question_id
      when context.source_type = 'global_question' then submission.global_question_id
      else null
    end
    and context.original_text_sha256 = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(submission.original_text, 'UTF8')
      ),
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
end;
$$;

revoke all on function api.get_writing_adjudication_context(uuid)
from public, anon, authenticated;
grant execute on function api.get_writing_adjudication_context(uuid)
to service_role;

create or replace function app_private.record_or_assert_writing_adjudication(
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
  selected_evidence app_private.writing_feedback_adjudications%rowtype;
  evidence jsonb;
  evidence_key_count integer;
  computed_final_sha256 text;
begin
  perform app_private.assert_service_role();

  if feedback is null
    or coalesce(pg_catalog.jsonb_typeof(feedback) <> 'object', true)
    or coalesce(pg_catalog.jsonb_typeof(feedback -> 'evaluation_evidence') <> 'object', true)
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  evidence := feedback -> 'evaluation_evidence';
  select pg_catalog.count(*)::integer
  into evidence_key_count
  from pg_catalog.jsonb_object_keys(evidence) as evidence_key(value);

  if evidence_key_count <> 25
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(evidence) as evidence_key(value)
      where evidence_key.value not in (
        'schema_version',
        'decision',
        'reason_code',
        'context_sha256',
        'original_text_sha256',
        'final_feedback_sha256',
        'generator_provider',
        'generator_model',
        'candidate_feedback_sha256',
        'candidate_release_sha256',
        'critic_provider',
        'critic_model',
        'critic_verdict',
        'critic_decision_sha256',
        'adjudicator_provider',
        'adjudicator_model',
        'adjudicator_verdict',
        'adjudicator_decision_sha256',
        'resolved_feedback_sha256',
        'final_critic_provider',
        'final_critic_model',
        'final_critic_verdict',
        'final_critic_decision_sha256',
        'accepted_provider',
        'accepted_model'
      )
    )
    or evidence -> 'schema_version' <> '1'::jsonb
    or coalesce(evidence ->> 'decision', '') not in (
      'accepted_model_feedback', 'system_hold'
    )
    or coalesce(evidence ->> 'reason_code', '') not in (
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
    )
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
    or not coalesce((
      (
        evidence ->> 'generator_provider' = 'deepseek'
        and evidence ->> 'generator_model' in (
          'deepseek-v4-flash', 'deepseek-v4-pro'
        )
      )
      or (
        evidence ->> 'generator_provider' = 'openai'
        and evidence ->> 'generator_model' = 'gpt-5.4-mini-2026-03-17'
      )
    ), false)
    or not coalesce((
      (
        evidence ->> 'critic_provider' is null
        and evidence ->> 'critic_model' is null
        and evidence ->> 'critic_verdict' is null
        and evidence ->> 'critic_decision_sha256' is null
      )
      or (
        evidence ->> 'critic_provider' = 'openai'
        and evidence ->> 'critic_model' = 'gpt-5.4-2026-03-05'
        and (
          evidence ->> 'critic_verdict' is null
          or evidence ->> 'critic_verdict' in (
            'approved', 'disagreed', 'uncertain'
          )
        )
      )
    ), false)
    or not coalesce((
      (
        evidence ->> 'adjudicator_provider' is null
        and evidence ->> 'adjudicator_model' is null
        and evidence ->> 'adjudicator_verdict' is null
        and evidence ->> 'adjudicator_decision_sha256' is null
      )
      or (
        evidence ->> 'adjudicator_provider' = 'deepseek'
        and evidence ->> 'adjudicator_model' = 'deepseek-v4-pro'
        and (
          evidence ->> 'adjudicator_verdict' is null
          or evidence ->> 'adjudicator_verdict' in ('resolved', 'system_hold')
        )
      )
    ), false)
    or not coalesce((
      (
        evidence ->> 'final_critic_provider' is null
        and evidence ->> 'final_critic_model' is null
        and evidence ->> 'final_critic_verdict' is null
        and evidence ->> 'final_critic_decision_sha256' is null
      )
      or (
        evidence ->> 'final_critic_provider' = 'openai'
        and evidence ->> 'final_critic_model' = 'gpt-5.4-2026-03-05'
        and (
          evidence ->> 'final_critic_verdict' is null
          or evidence ->> 'final_critic_verdict' in (
            'approved', 'disagreed', 'uncertain'
          )
        )
      )
    ), false)
    or not coalesce((
      (
        evidence ->> 'decision' = 'system_hold'
        and evidence ->> 'reason_code' not in (
          'critic_approved', 'final_critic_approved'
        )
        and evidence ->> 'accepted_provider' is null
        and evidence ->> 'accepted_model' is null
      )
      or (
        evidence ->> 'decision' = 'accepted_model_feedback'
        and evidence ->> 'accepted_provider' = 'deepseek'
        and evidence ->> 'candidate_feedback_sha256' is not null
        and (
          (
            evidence ->> 'reason_code' = 'critic_approved'
            and evidence ->> 'accepted_model' =
              evidence ->> 'generator_model'
            and evidence ->> 'generator_provider' = 'deepseek'
            and evidence ->> 'candidate_release_sha256' is not null
            and evidence ->> 'candidate_release_sha256' =
              evidence ->> 'final_feedback_sha256'
            and evidence ->> 'critic_provider' = 'openai'
            and evidence ->> 'critic_model' = 'gpt-5.4-2026-03-05'
            and evidence ->> 'critic_verdict' = 'approved'
            and evidence ->> 'critic_decision_sha256' is not null
            and evidence ->> 'adjudicator_provider' is null
            and evidence ->> 'adjudicator_model' is null
            and evidence ->> 'adjudicator_verdict' is null
            and evidence ->> 'adjudicator_decision_sha256' is null
            and evidence ->> 'resolved_feedback_sha256' is null
            and evidence ->> 'final_critic_provider' is null
            and evidence ->> 'final_critic_model' is null
            and evidence ->> 'final_critic_verdict' is null
            and evidence ->> 'final_critic_decision_sha256' is null
          )
          or (
            evidence ->> 'reason_code' = 'final_critic_approved'
            and evidence ->> 'generator_provider' = 'deepseek'
            and evidence ->> 'generator_model' = 'deepseek-v4-flash'
            and evidence ->> 'accepted_model' in (
              'deepseek-v4-flash', 'deepseek-v4-pro'
            )
            and evidence ->> 'critic_provider' = 'openai'
            and evidence ->> 'critic_model' = 'gpt-5.4-2026-03-05'
            and evidence ->> 'critic_verdict' in ('disagreed', 'uncertain')
            and evidence ->> 'critic_decision_sha256' is not null
            and evidence ->> 'adjudicator_provider' = 'deepseek'
            and evidence ->> 'adjudicator_model' = 'deepseek-v4-pro'
            and evidence ->> 'adjudicator_verdict' = 'resolved'
            and evidence ->> 'adjudicator_decision_sha256' is not null
            and evidence ->> 'resolved_feedback_sha256' is not null
            and evidence ->> 'final_critic_provider' = 'openai'
            and evidence ->> 'final_critic_model' = 'gpt-5.4-2026-03-05'
            and evidence ->> 'final_critic_verdict' = 'approved'
            and evidence ->> 'final_critic_decision_sha256' is not null
            and (
              (
                evidence ->> 'accepted_model' = 'deepseek-v4-flash'
                and evidence ->> 'resolved_feedback_sha256' =
                  evidence ->> 'candidate_feedback_sha256'
                and evidence ->> 'final_feedback_sha256' =
                  evidence ->> 'candidate_release_sha256'
              )
              or (
                evidence ->> 'accepted_model' = 'deepseek-v4-pro'
                and evidence ->> 'resolved_feedback_sha256' <>
                  evidence ->> 'candidate_feedback_sha256'
                and evidence ->> 'final_feedback_sha256' <>
                  evidence ->> 'candidate_release_sha256'
              )
            )
          )
        )
      )
    ), false)
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

  if selected_job.id is null or selected_job.job_kind <> 'writing_evaluation' then
    raise exception using
      errcode = '02000',
      message = 'Writing evaluation job not found.';
  end if;

  select adjudication.*
  into selected_evidence
  from app_private.writing_feedback_adjudications adjudication
  where adjudication.job_id = selected_job.id;

  if selected_job.status = 'succeeded'
    and selected_evidence.job_id is null
  then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_missing_on_replay';
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
      when context.source_type = 'workspace_question' then selected_submission.question_id
      when context.source_type = 'global_question' then selected_submission.global_question_id
      else null
    end
    and context.original_text_sha256 = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(selected_submission.original_text, 'UTF8')
      ),
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
    or selected_job.entity_version <> selected_submission.evaluation_version
    or evidence ->> 'context_sha256' <> selected_context.context_sha256
    or evidence ->> 'original_text_sha256' <> selected_context.original_text_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_context_mismatch';
  end if;

  computed_final_sha256 := app_private.canonical_jsonb_sha256(
    feedback - 'evaluation_evidence'
  );
  if evidence ->> 'final_feedback_sha256' <> computed_final_sha256 then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_feedback_hash_mismatch';
  end if;

  if evidence ->> 'decision' = 'system_hold' then
    if feedback ->> 'ai_model' <> 'system_hold'
      or evidence ->> 'accepted_provider' is not null
      or evidence ->> 'accepted_model' is not null
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(feedback -> 'lines', '[]'::jsonb)
        ) line
        where line ->> 'status' <> 'unclear'
          or line ->> 'corrected_line' is distinct from line ->> 'original_line'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'writing_adjudication_evidence_invalid';
    end if;
  elsif feedback ->> 'ai_model' <> evidence ->> 'accepted_model'
    or evidence ->> 'accepted_provider' <> 'deepseek'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        coalesce(feedback -> 'lines', '[]'::jsonb)
      ) line
      where line ->> 'status' = 'unclear'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_evidence_invalid';
  end if;

  if selected_evidence.job_id is null then
    insert into app_private.writing_feedback_adjudications (
      job_id,
      submission_id,
      evaluation_version,
      feedback_version,
      schema_version,
      decision,
      reason_code,
      context_sha256,
      original_text_sha256,
      final_feedback_sha256,
      generator_provider,
      generator_model,
      candidate_feedback_sha256,
      candidate_release_sha256,
      critic_provider,
      critic_model,
      critic_verdict,
      critic_decision_sha256,
      adjudicator_provider,
      adjudicator_model,
      adjudicator_verdict,
      adjudicator_decision_sha256,
      resolved_feedback_sha256,
      final_critic_provider,
      final_critic_model,
      final_critic_verdict,
      final_critic_decision_sha256,
      accepted_provider,
      accepted_model
    ) values (
      selected_job.id,
      selected_submission.id,
      selected_job.entity_version,
      selected_job.entity_version,
      1,
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
    )
    returning * into selected_evidence;
  end if;

  if (
    pg_catalog.to_jsonb(selected_evidence)
      - array[
        'job_id',
        'submission_id',
        'evaluation_version',
        'feedback_version',
        'created_at'
      ]::text[]
  ) is distinct from evidence then
    raise exception using
      errcode = '55000',
      message = 'writing_adjudication_replay_mismatch';
  end if;
end;
$$;

revoke all on function app_private.record_or_assert_writing_adjudication(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.require_independent_writing_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_evidence app_private.writing_feedback_adjudications%rowtype;
begin
  if new.state <> 'released' or new.released_by is not null then
    return new;
  end if;

  select adjudication.*
  into selected_evidence
  from app_private.writing_feedback_adjudications adjudication
  where adjudication.submission_id = new.submission_id
    and adjudication.feedback_version = new.version
    and adjudication.decision = 'accepted_model_feedback';

  if selected_evidence.job_id is null
    or selected_evidence.final_feedback_sha256 <>
      app_private.canonical_jsonb_sha256(new.content)
    or selected_evidence.accepted_provider is distinct from 'deepseek'
    or selected_evidence.accepted_model is distinct from new.provider_model
    or new.content ->> 'ai_model' is distinct from selected_evidence.accepted_model
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

create trigger feedback_drafts_zz_independent_release_gate
before insert or update on app_private.feedback_drafts
for each row execute function app_private.require_independent_writing_release();

-- Preserve the Phase 9A materializer under a non-callable internal name, then
-- replace its original signature with the evidence gate. Stale workers that
-- still call public.complete_writing_evaluation therefore fail closed rather
-- than bypassing the new contract.
alter function public.complete_writing_evaluation(
  uuid, bigint, uuid, jsonb
) rename to complete_writing_evaluation_legacy_internal;

revoke all on function public.complete_writing_evaluation_legacy_internal(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role;

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
begin
  perform app_private.record_or_assert_writing_adjudication(
    target_job_id,
    target_queue_message_id,
    worker_id,
    feedback
  );

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

create or replace function api.complete_writing_evaluation(
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
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.complete_writing_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    feedback
  );
$$;

revoke all on function api.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated;
grant execute on function api.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
to service_role;

comment on table app_private.writing_feedback_adjudications is
  'Immutable, raw-content-free provenance for independent writing adjudication.';
comment on function api.get_writing_adjudication_context(uuid) is
  'Service-only immutable writing context hashes for independent adjudication.';
comment on function api.complete_writing_evaluation(uuid, bigint, uuid, jsonb) is
  'Completes writing only after immutable independent evidence is recorded or replayed exactly.';
