-- Rollback-only shared-staging safety: every fixture is selected by its exact
-- submission/job/message identifiers, and this suite never calls a queue-wide
-- claim RPC that could lease another user's job. The enclosing transaction
-- rolls back fixture rows, job leases, queue archives, and all feedback writes.
begin;

select plan(15);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid) like
        '%recovery_critic_approved%'
      and pg_get_constraintdef(constraint_row.oid) like '%gemini-3.5-flash%'
      and pg_get_constraintdef(constraint_row.oid)
        like '%gemini-3.1-flash-lite%'
      and pg_get_constraintdef(constraint_row.oid) like '%deepseek-v4-pro%'
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and constraint_row.conname =
        'writing_feedback_adjudications_v2_decision_shape_check'
  ),
  'the v2 decision constraint contains the one-way recovery contract'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'app_private.feedback_drafts'::regclass
      and trigger_row.tgname =
        'feedback_drafts_zz_independent_release_gate'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgfoid =
        'app_private.require_independent_writing_release()'::regprocedure
      and trigger_row.tgtype = 23
  ),
  'automatic feedback release still crosses the independent evidence gate'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12u-teacher@example.test', '',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12U Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12u-student@example.test', '',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12U Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1333333-3333-4333-8333-333333333333',
  'Phase 12U Workspace', 'phase-12u-workspace',
  'e1111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'e1333333-3333-4333-8333-333333333333',
    'e1111111-1111-4111-8111-111111111111', 'teacher'
  ),
  (
    'e1333333-3333-4333-8333-333333333333',
    'e1222222-2222-4222-8222-222222222222', 'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'e1444444-4444-4444-8444-444444444444',
  'e1333333-3333-4333-8333-333333333333',
  'Phase 12U Immediate A2', 'A2', true, 'immediate'
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'e1555555-5555-4555-8555-555555555555',
  'e1444444-4444-4444-8444-444444444444',
  'e1222222-2222-4222-8222-222222222222',
  'e1333333-3333-4333-8333-333333333333'
);

create temporary table phase_12u_state (
  singleton boolean primary key default true check (singleton),
  accepted_submission_id uuid,
  accepted_job_id uuid,
  accepted_message_id bigint,
  held_submission_id uuid,
  held_job_id uuid,
  held_message_id bigint
) on commit drop;

insert into phase_12u_state default values;
grant select, update on phase_12u_state to authenticated, service_role;

create function pg_temp.phase_12u_recovery_payload(
  evidence_overrides jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with base_feedback as (
    select jsonb_build_object(
      'overall_summary', 'Der Text ist korrekt.',
      'level_detected', 'A2',
      'corrected_text', 'Das ist richtig.',
      'ai_model', 'gemini-3.1-flash-lite',
      'score_summary', jsonb_build_object(
        'correct_lines', 1,
        'acceptable_lines', 0,
        'minor_issues', 0,
        'major_issues', 0,
        'needs_review', 0
      ),
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 16,
        'original_line', 'Das ist richtig.',
        'corrected_line', 'Das ist richtig.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb
    ) as value
  ), context_row as (
    select context.*
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
      select accepted_submission_id
      from pg_temp.phase_12u_state
      where singleton
    )
  )
  select base_feedback.value || jsonb_build_object(
    'evaluation_evidence',
    jsonb_build_object(
      'schema_version', 2,
      'decision', 'accepted_model_feedback',
      'reason_code', 'recovery_critic_approved',
      'context_sha256', context_row.context_sha256,
      'original_text_sha256', context_row.original_text_sha256,
      'final_feedback_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'generator_provider', 'gemini',
      'generator_model', 'gemini-3.1-flash-lite',
      'candidate_feedback_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'candidate_release_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'critic_provider', 'deepseek',
      'critic_model', 'deepseek-v4-pro',
      'critic_verdict', 'approved',
      'critic_decision_sha256', repeat('b', 64),
      'adjudicator_provider', null,
      'adjudicator_model', null,
      'adjudicator_verdict', null,
      'adjudicator_decision_sha256', null,
      'resolved_feedback_sha256', null,
      'final_critic_provider', null,
      'final_critic_model', null,
      'final_critic_verdict', null,
      'final_critic_decision_sha256', null,
      'accepted_provider', 'gemini',
      'accepted_model', 'gemini-3.1-flash-lite'
    ) || coalesce(evidence_overrides, '{}'::jsonb)
  )
  from base_feedback, context_row;
$$;

create function pg_temp.phase_12u_hold_payload()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with base_feedback as (
    select jsonb_build_object(
      'overall_summary', 'Independent verification was not completed.',
      'level_detected', 'A2',
      'corrected_text', 'Heute lerne ich.',
      'ai_model', 'system_hold',
      'score_summary', jsonb_build_object(
        'correct_lines', 0,
        'acceptable_lines', 0,
        'minor_issues', 0,
        'major_issues', 0,
        'needs_review', 1
      ),
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 16,
        'original_line', 'Heute lerne ich.',
        'corrected_line', 'Heute lerne ich.',
        'status', 'unclear',
        'changed_parts', '[]'::jsonb,
        'short_explanation', 'Independent verification was not completed.',
        'detailed_explanation', 'A teacher may review this private result.',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb
    ) as value
  ), context_row as (
    select context.*
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
      select held_submission_id
      from pg_temp.phase_12u_state
      where singleton
    )
  )
  select base_feedback.value || jsonb_build_object(
    'evaluation_evidence', jsonb_build_object(
      'schema_version', 2,
      'decision', 'system_hold',
      'reason_code', 'generator_invalid',
      'context_sha256', context_row.context_sha256,
      'original_text_sha256', context_row.original_text_sha256,
      'final_feedback_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'generator_provider', 'gemini',
      'generator_model', 'gemini-3.1-flash-lite',
      'candidate_feedback_sha256', null,
      'candidate_release_sha256', null,
      'critic_provider', null,
      'critic_model', null,
      'critic_verdict', null,
      'critic_decision_sha256', null,
      'adjudicator_provider', null,
      'adjudicator_model', null,
      'adjudicator_verdict', null,
      'adjudicator_decision_sha256', null,
      'resolved_feedback_sha256', null,
      'final_critic_provider', null,
      'final_critic_model', null,
      'final_critic_verdict', null,
      'final_critic_decision_sha256', null,
      'accepted_provider', null,
      'accepted_model', null
    )
  )
  from base_feedback, context_row;
$$;

revoke all on function pg_temp.phase_12u_recovery_payload(jsonb)
from public, anon, authenticated, service_role;
revoke all on function pg_temp.phase_12u_hold_payload()
from public, anon, authenticated, service_role;
grant execute on function pg_temp.phase_12u_recovery_payload(jsonb)
to service_role;
grant execute on function pg_temp.phase_12u_hold_payload()
to service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'e1222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'e1444444-4444-4444-8444-444444444444',
    'free_text', null, 'Das ist richtig.'
  )
)
update pg_temp.phase_12u_state state
set accepted_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

with fixture_job as (
  select job.id, job.queue_message_id
  from app_private.async_jobs job
  join public.submissions submission
    on submission.id = job.entity_id
    and submission.evaluation_version = job.entity_version
  where job.queue_name = 'writing_evaluation'
    and job.job_kind = 'writing_evaluation'
    and job.entity_id = (
      select accepted_submission_id
      from pg_temp.phase_12u_state
      where singleton
    )
)
update pg_temp.phase_12u_state state
set
  accepted_job_id = fixture_job.id,
  accepted_message_id = fixture_job.queue_message_id
from fixture_job
where state.singleton;

-- Simulate only this fixture's leased state. This is the exact async-job and
-- submission transition performed by claim_async_jobs, without reading the
-- shared queue or changing any unrelated message visibility.
update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = job.attempt_count + 1,
  worker_id = 'e1666666-6666-4666-8666-666666666666',
  lease_expires_at = now() + interval '5 minutes',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now(),
  last_error_code = null
where job.id = (
    select accepted_job_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.entity_id = (
    select accepted_submission_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.queue_message_id = (
    select accepted_message_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.status in ('queued', 'retry')
  and job.available_at <= now();

update public.submissions submission
set
  evaluation_status = 'processing',
  status = 'checking',
  feedback_started_at = coalesce(submission.feedback_started_at, now()),
  feedback_error = null
where submission.id = (
    select accepted_submission_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and submission.evaluation_version = (
    select job.entity_version
    from app_private.async_jobs job
    where job.id = (
      select accepted_job_id
      from pg_temp.phase_12u_state
      where singleton
    )
  );

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      pg_temp.phase_12u_recovery_payload(jsonb_build_object(
        'critic_provider', 'gemini',
        'critic_model', 'gemini-3.1-flash-lite'
      ))
    )
  $sql$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'Gemini recovery cannot be approved by a Gemini-family critic'
);

select throws_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      pg_temp.phase_12u_recovery_payload(jsonb_build_object(
        'critic_model', 'deepseek-v4-flash'
      ))
    )
  $sql$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'recovery requires the pinned DeepSeek Pro critic'
);

select throws_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      pg_temp.phase_12u_recovery_payload(jsonb_build_object(
        'critic_decision_sha256', null
      ))
    )
  $sql$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'recovery cannot omit the critic decision hash'
);

select throws_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      pg_temp.phase_12u_recovery_payload(jsonb_build_object(
        'candidate_release_sha256', repeat('c', 64)
      ))
    )
  $sql$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'approved recovery binds its release hash to final feedback'
);

select throws_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      jsonb_set(
        pg_temp.phase_12u_recovery_payload(),
        '{overall_summary}',
        to_jsonb('Tampered after approval.'::text)
      )
    )
  $sql$,
  '55000',
  'writing_adjudication_feedback_hash_mismatch',
  'visible feedback cannot change after exact-hash criticism'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.writing_feedback_adjudications_v2 evidence
    where evidence.job_id = (
      select accepted_job_id from phase_12u_state where singleton
    )
  )
    and not exists (
      select 1
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select accepted_submission_id from phase_12u_state where singleton
      )
    )
    and exists (
      select 1
      from app_private.async_jobs job
      where job.id = (
        select accepted_job_id from phase_12u_state where singleton
      )
        and job.status = 'processing'
    ),
  'rejected recovery attempts leave no partial ledger, draft, or job transition'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12u_state where singleton),
      (select accepted_message_id from phase_12u_state where singleton),
      'e1666666-6666-4666-8666-666666666666',
      pg_temp.phase_12u_recovery_payload()
    )
  $sql$,
  'Gemini recovery with fresh DeepSeek Pro approval completes'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select accepted_submission_id from phase_12u_state where singleton
    )
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.ai_model = 'gemini-3.1-flash-lite'
      and submission.corrected_text = 'Das ist richtig.'
  ),
  'approved cross-provider recovery releases immediately'
);

select ok(
  (
    select count(*) = 1
      and bool_and(
        evidence.schema_version = 2
        and evidence.reason_code = 'recovery_critic_approved'
        and evidence.generator_provider = 'gemini'
        and evidence.generator_model = 'gemini-3.1-flash-lite'
        and evidence.critic_provider = 'deepseek'
        and evidence.critic_model = 'deepseek-v4-pro'
        and evidence.critic_verdict = 'approved'
        and evidence.critic_decision_sha256 = repeat('b', 64)
        and evidence.accepted_provider = 'gemini'
        and evidence.accepted_model = 'gemini-3.1-flash-lite'
        and evidence.candidate_release_sha256 =
          evidence.final_feedback_sha256
        and evidence.adjudicator_provider is null
        and evidence.final_critic_provider is null
      )
    from app_private.writing_feedback_adjudications_v2 evidence
    where evidence.job_id = (
      select accepted_job_id from phase_12u_state where singleton
    )
  ),
  'ledger records the exact one-way provider and hash contract'
);

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    join app_private.writing_feedback_adjudications_v2 evidence
      on evidence.submission_id = draft.submission_id
      and evidence.feedback_version = draft.version
    where draft.submission_id = (
      select accepted_submission_id from phase_12u_state where singleton
    )
      and draft.state = 'released'
      and draft.released_by is null
      and draft.provider_model = 'gemini-3.1-flash-lite'
      and not (draft.content ? 'evaluation_evidence')
      and app_private.canonical_jsonb_sha256(draft.content) =
        evidence.final_feedback_sha256
  ),
  'automatic draft release passes only with exact Gemini recovery evidence'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'e1222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'e1444444-4444-4444-8444-444444444444',
    'free_text', null, 'Heute lerne ich.'
  )
)
update pg_temp.phase_12u_state state
set held_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

with fixture_job as (
  select job.id, job.queue_message_id
  from app_private.async_jobs job
  join public.submissions submission
    on submission.id = job.entity_id
    and submission.evaluation_version = job.entity_version
  where job.queue_name = 'writing_evaluation'
    and job.job_kind = 'writing_evaluation'
    and job.entity_id = (
      select held_submission_id
      from pg_temp.phase_12u_state
      where singleton
    )
)
update pg_temp.phase_12u_state state
set
  held_job_id = fixture_job.id,
  held_message_id = fixture_job.queue_message_id
from fixture_job
where state.singleton;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = job.attempt_count + 1,
  worker_id = 'e1777777-7777-4777-8777-777777777777',
  lease_expires_at = now() + interval '5 minutes',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now(),
  last_error_code = null
where job.id = (
    select held_job_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.entity_id = (
    select held_submission_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.queue_message_id = (
    select held_message_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and job.status in ('queued', 'retry')
  and job.available_at <= now();

update public.submissions submission
set
  evaluation_status = 'processing',
  status = 'checking',
  feedback_started_at = coalesce(submission.feedback_started_at, now()),
  feedback_error = null
where submission.id = (
    select held_submission_id
    from pg_temp.phase_12u_state
    where singleton
  )
  and submission.evaluation_version = (
    select job.entity_version
    from app_private.async_jobs job
    where job.id = (
      select held_job_id
      from pg_temp.phase_12u_state
      where singleton
    )
  );

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12u_state where singleton),
      (select held_message_id from phase_12u_state where singleton),
      'e1777777-7777-4777-8777-777777777777',
      pg_temp.phase_12u_hold_payload()
    )
  $sql$,
  'a schema-v2 recovery hold completes without exposing feedback'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select held_submission_id from phase_12u_state where singleton
    )
      and submission.evaluation_status = 'needs_review'
      and submission.release_status = 'held'
      and submission.ai_model is null
      and submission.corrected_text is null
  )
    and exists (
      select 1
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select held_submission_id from phase_12u_state where singleton
      )
        and draft.state = 'needs_review'
        and draft.provider_model = 'system_hold'
        and draft.content ->> 'ai_model' = 'system_hold'
    ),
  'uncertain recovery remains private and truthful'
);

update app_private.feedback_drafts draft
set state = 'draft'
where draft.submission_id = (
  select held_submission_id from phase_12u_state where singleton
);

select throws_ok(
  $sql$
    select app_private.materialize_feedback_draft(
      (select held_submission_id from phase_12u_state where singleton),
      (
        select draft.id
        from app_private.feedback_drafts draft
        where draft.submission_id = (
          select held_submission_id from phase_12u_state where singleton
        )
      ),
      null
    )
  $sql$,
  '55000',
  'writing_independent_evidence_required',
  'a system hold cannot cross the automatic release trigger'
);

select * from finish(true);
rollback;
