begin;

select plan(28);

-- WRITE-002 / WRITE-005 / WRITE-006 / WRITE-007 regression closure.
--
-- This file is exact-fixture and rollback-only. Queue messages are re-keyed to
-- transaction-unique negative IDs before any claim, so the shared linked
-- staging queue cannot be consumed. The late materialization fault is an
-- uncommitted trigger over one fixture student only; its pg_temp function is
-- revoked from every Data API role and disappears with the final rollback.

select ok(
  exists (
    select 1
    from public.grammar_topics topic
    where topic.slug = 'dativ'
      and topic.level = 'A1_A2'
  ),
  'the closed writing topic used by the atomicity fixture exists'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '12a00000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'phase12x-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12X Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12a00000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'phase12x-held-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12X Held Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12a00000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'phase12x-atomic-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12X Atomic Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '12b00000-0000-4000-8000-000000000001',
  'Phase 12X Writing Atomicity',
  'phase-12x-writing-atomicity',
  '12a00000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12a00000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12a00000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '12b00000-0000-4000-8000-000000000001',
    '12a00000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '12b00000-0000-4000-8000-000000000001',
    '12a00000-0000-4000-8000-000000000002',
    'student'
  ),
  (
    '12b00000-0000-4000-8000-000000000001',
    '12a00000-0000-4000-8000-000000000003',
    'student'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values
  (
    '12c00000-0000-4000-8000-000000000001',
    '12b00000-0000-4000-8000-000000000001',
    'Phase 12X Teacher Review',
    'A2',
    '12a00000-0000-4000-8000-000000000001',
    true,
    true,
    true,
    'teacher_review_only',
    0,
    0
  ),
  (
    '12c00000-0000-4000-8000-000000000002',
    '12b00000-0000-4000-8000-000000000001',
    'Phase 12X Immediate',
    'A2',
    '12a00000-0000-4000-8000-000000000001',
    true,
    true,
    true,
    'immediate',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    '12b00000-0000-4000-8000-000000000001',
    '12c00000-0000-4000-8000-000000000001',
    '12a00000-0000-4000-8000-000000000002'
  ),
  (
    '12b00000-0000-4000-8000-000000000001',
    '12c00000-0000-4000-8000-000000000002',
    '12a00000-0000-4000-8000-000000000003'
  );

create temporary table phase_12x_state (
  singleton boolean primary key default true check (singleton),
  held_submission_id uuid,
  held_job_id uuid,
  held_message_id bigint,
  atomic_submission_id uuid,
  atomic_job_id uuid,
  atomic_message_id bigint,
  atomic_feedback jsonb,
  attempt_number integer,
  worker_id uuid
) on commit drop;

insert into phase_12x_state default values;
grant select, update on table phase_12x_state to authenticated, service_role;

create function pg_temp.phase_12x_fixture_message_id(slot integer)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  select -8800000000000000000::bigint
    + ((txid_current() % 1000000000)::bigint * 1000)
    + slot::bigint;
$$;

revoke all on function pg_temp.phase_12x_fixture_message_id(integer)
from public, anon, authenticated, service_role;

create function pg_temp.phase_12x_rekey_fixture_message(
  target_job_id uuid,
  target_message_id bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  updated_count integer;
begin
  if target_message_id >= 0 then
    raise exception 'Fixture queue IDs must be negative.';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.job_kind <> 'writing_evaluation'
    or selected_job.queue_name <> 'writing_evaluation'
    or selected_job.queue_message_id is null
  then
    raise exception 'Fixture writing job is not queue-backed.';
  end if;

  execute pg_catalog.format(
    'with removed as (
       delete from pgmq.%1$I
       where msg_id = $2
         and message ->> ''job_id'' = $3
         and message ->> ''job_kind'' = ''writing_evaluation''
         and message ->> ''entity_id'' = $4
         and message ->> ''entity_version'' = $5
       returning read_ct, enqueued_at, vt, message, headers
     )
     insert into pgmq.%1$I (
       msg_id, read_ct, enqueued_at, vt, message, headers
     ) overriding system value
     select $1, read_ct, enqueued_at, vt, message, headers
     from removed',
    'q_writing_evaluation'
  )
  using
    target_message_id,
    selected_job.queue_message_id,
    selected_job.id::text,
    selected_job.entity_id::text,
    selected_job.entity_version::text;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Fixture queue message was not re-keyed exactly once.';
  end if;

  update app_private.async_jobs job
  set queue_message_id = target_message_id
  where job.id = selected_job.id
    and job.queue_message_id = selected_job.queue_message_id;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Fixture job message ID was not updated exactly once.';
  end if;
end;
$$;

revoke all on function pg_temp.phase_12x_rekey_fixture_message(uuid, bigint)
from public, anon, authenticated, service_role;

create function pg_temp.phase_12x_accept_writing_feedback(
  target_submission_id uuid,
  target_feedback jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select target_feedback || jsonb_build_object(
    'evaluation_evidence', jsonb_build_object(
      'schema_version', 2,
      'decision', 'accepted_model_feedback',
      'reason_code', 'critic_approved',
      'context_sha256', context.context_sha256,
      'original_text_sha256', context.original_text_sha256,
      'final_feedback_sha256',
        app_private.canonical_jsonb_sha256(target_feedback),
      'generator_provider', 'deepseek',
      'generator_model', 'deepseek-v4-flash',
      'candidate_feedback_sha256', repeat('d', 64),
      'candidate_release_sha256',
        app_private.canonical_jsonb_sha256(target_feedback),
      'critic_provider', 'gemini',
      'critic_model', 'gemini-3.1-flash-lite',
      'critic_verdict', 'approved',
      'critic_decision_sha256', repeat('e', 64),
      'adjudicator_provider', null,
      'adjudicator_model', null,
      'adjudicator_verdict', null,
      'adjudicator_decision_sha256', null,
      'resolved_feedback_sha256', null,
      'final_critic_provider', null,
      'final_critic_model', null,
      'final_critic_verdict', null,
      'final_critic_decision_sha256', null,
      'accepted_provider', 'deepseek',
      'accepted_model', 'deepseek-v4-flash'
    )
  )
  from app_private.writing_evaluation_contexts context
  where context.submission_id = target_submission_id;
$$;

revoke all on function pg_temp.phase_12x_accept_writing_feedback(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function pg_temp.phase_12x_accept_writing_feedback(uuid, jsonb)
to service_role;

create function pg_temp.phase_12x_valid_feedback(target_submission_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_temp.phase_12x_accept_writing_feedback(
    target_submission_id,
    jsonb_build_object(
      'overall_summary', 'Use the dative after helfen.',
      'level_detected', 'A2',
      'corrected_text', '🙂 Ich helfe meinem Bruder.',
      'ai_model', 'deepseek-v4-flash',
      'score_summary', jsonb_build_object(
        'correct_lines', 0,
        'acceptable_lines', 0,
        'minor_issues', 1,
        'major_issues', 0,
        'needs_review', 0
      ),
      'lines', jsonb_build_array(
        jsonb_build_object(
          'line_number', 1,
          'source_start', 0,
          'source_end', 26,
          'original_line', '🙂 Ich helfe meinen Bruder.',
          'corrected_line', '🙂 Ich helfe meinem Bruder.',
          'status', 'minor_issue',
          'changed_parts', jsonb_build_array(jsonb_build_object(
            'from', 'meinen',
            'to', 'meinem',
            'reason', 'Helfen takes the dative case.',
            'source_start', 12,
            'source_end', 18,
            'corrected_start', 12,
            'corrected_end', 18
          )),
          'short_explanation', 'Use the dative case.',
          'detailed_explanation', '',
          'grammar_topic', 'dativ'
        )
      ),
      'grammar_topics', jsonb_build_array(jsonb_build_object(
        'topic', 'dativ',
        'count', 1,
        'severity', 'minor',
        'simple_explanation', 'Use the dative case.'
      ))
    )
  );
$$;

revoke all on function pg_temp.phase_12x_valid_feedback(uuid)
from public, anon, authenticated, service_role;
grant execute on function pg_temp.phase_12x_valid_feedback(uuid)
to service_role;

-- A teacher-review result contains a real issue but remains private.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12a00000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12a00000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    '12c00000-0000-4000-8000-000000000001',
    'free_text',
    null,
    '🙂 Ich helfe meinen Bruder.'
  )
)
update pg_temp.phase_12x_state state
set held_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
update phase_12x_state state
set held_job_id = job.id,
    held_message_id = job.queue_message_id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.held_submission_id;

select pg_temp.phase_12x_rekey_fixture_message(
  (select held_job_id from phase_12x_state),
  pg_temp.phase_12x_fixture_message_id(1)
);
update phase_12x_state
set held_message_id = pg_temp.phase_12x_fixture_message_id(1)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '12d00000-0000-4000-8000-000000000001',
    1,
    180
  )
)
update pg_temp.phase_12x_state state
set held_job_id = claimed.job_id,
    held_message_id = claimed.queue_message_id,
    attempt_number = claimed.attempt_number
from claimed
where state.singleton;

select is(
  (select attempt_number from pg_temp.phase_12x_state),
  1,
  'the held writing fixture is claimed exactly once'
);

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from pg_temp.phase_12x_state),
      (select held_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000001',
      pg_temp.phase_12x_valid_feedback(
        (select held_submission_id from pg_temp.phase_12x_state)
      )
    )
  $$,
  'validated teacher-review feedback completes into a held private draft'
);

reset role;
select ok(
  (
    select submission.evaluation_status = 'ready'
      and submission.release_status = 'held'
      and submission.corrected_text is null
      and submission.overall_summary is null
      and draft.state = 'draft'
      and draft.content #>> '{grammar_topics,0,topic}' = 'dativ'
    from public.submissions submission
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
    where submission.id = (
      select held_submission_id from phase_12x_state
    )
  ),
  'held feedback keeps its correction and weakness only in the private draft'
);

select is(
  (
    select count(*)::integer
    from (
      select line.id
      from public.submission_lines line
      where line.submission_id = (
        select held_submission_id from phase_12x_state
      )
      union all
      select topic.id
      from public.submission_grammar_topics topic
      where topic.submission_id = (
        select held_submission_id from phase_12x_state
      )
    ) public_fragments
  ),
  0,
  'held feedback materializes neither public lines nor public topics'
);

select is(
  (
    select count(*)::integer
    from (
      select evidence.source_release_id
      from app_private.practice_weakness_evidence evidence
      where evidence.submission_id = (
        select held_submission_id from phase_12x_state
      )
      union all
      select stats.id
      from public.student_grammar_stats stats
      where stats.workspace_id = '12b00000-0000-4000-8000-000000000001'
        and stats.student_id = '12a00000-0000-4000-8000-000000000002'
    ) weakness_rows
  ),
  0,
  'a held issue creates no weakness evidence or student statistics'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from public.refresh_student_grammar_stats(
      '12b00000-0000-4000-8000-000000000001',
      '12a00000-0000-4000-8000-000000000002'
    )
  $$,
  'an explicit weakness refresh safely ignores the held private draft'
);

reset role;
select is(
  (
    select count(*)::integer
    from (
      select evidence.source_release_id
      from app_private.practice_weakness_evidence evidence
      where evidence.submission_id = (
        select held_submission_id from phase_12x_state
      )
      union all
      select stats.id
      from public.student_grammar_stats stats
      where stats.workspace_id = '12b00000-0000-4000-8000-000000000001'
        and stats.student_id = '12a00000-0000-4000-8000-000000000002'
    ) weakness_rows
  ),
  0,
  'held feedback remains excluded after a direct statistics refresh'
);

-- One immediate job exercises timeout retry, stale-lease recovery, a late
-- materialization fault, successful exact release, and idempotent replay.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12a00000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12a00000-0000-4000-8000-000000000003',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    '12c00000-0000-4000-8000-000000000002',
    'free_text',
    null,
    '🙂 Ich helfe meinen Bruder.'
  )
)
update pg_temp.phase_12x_state state
set atomic_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
update phase_12x_state state
set atomic_job_id = job.id,
    atomic_message_id = job.queue_message_id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.atomic_submission_id;

update phase_12x_state state
set atomic_feedback = pg_temp.phase_12x_valid_feedback(
  state.atomic_submission_id
)
where state.singleton;

select pg_temp.phase_12x_rekey_fixture_message(
  (select atomic_job_id from phase_12x_state),
  pg_temp.phase_12x_fixture_message_id(20)
);
update phase_12x_state
set atomic_message_id = pg_temp.phase_12x_fixture_message_id(20)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '12d00000-0000-4000-8000-000000000002',
    1,
    180
  )
)
update pg_temp.phase_12x_state state
set atomic_job_id = claimed.job_id,
    atomic_message_id = claimed.queue_message_id,
    attempt_number = claimed.attempt_number,
    worker_id = '12d00000-0000-4000-8000-000000000002'
from claimed
where state.singleton;

select is(
  (select attempt_number from pg_temp.phase_12x_state),
  1,
  'the timeout fixture begins on attempt one'
);

select lives_ok(
  $$
    select *
    from public.fail_async_job(
      (select atomic_job_id from pg_temp.phase_12x_state),
      (select atomic_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000002',
      'provider_timeout',
      true
    )
  $$,
  'a provider timeout durably schedules a bounded retry'
);

reset role;
select ok(
  (
    select job.status = 'retry'
      and job.attempt_count = 1
      and submission.evaluation_status = 'queued'
      and submission.release_status = 'held'
      and submission.corrected_text is null
      and submission.overall_summary is null
    from app_private.async_jobs job
    join public.submissions submission on submission.id = job.entity_id
    where job.id = (select atomic_job_id from phase_12x_state)
  ),
  'timeout retry preserves a clean queued parent with no summary fragments'
);

select is(
  (
    select count(*)::integer
    from (
      select line.id
      from public.submission_lines line
      where line.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select topic.id
      from public.submission_grammar_topics topic
      where topic.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select draft.id
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select evidence.source_release_id
      from app_private.practice_weakness_evidence evidence
      where evidence.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
    ) partial_rows
  ),
  0,
  'timeout retry leaves no public lines, topics, private draft, or weakness evidence'
);

select ok(
  (
    select job.queue_message_id <> pg_temp.phase_12x_fixture_message_id(20)
      and (
        select count(*)
        from pgmq.a_writing_evaluation archive
        where archive.msg_id = pg_temp.phase_12x_fixture_message_id(20)
      ) = 1
      and app_private.queue_message_exists(
        job.queue_name,
        job.queue_message_id
      )
    from app_private.async_jobs job
    where job.id = (select atomic_job_id from phase_12x_state)
  ),
  'timeout retry archives only attempt one and links one live replacement message'
);

update phase_12x_state state
set atomic_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.atomic_job_id;

select pg_temp.phase_12x_rekey_fixture_message(
  (select atomic_job_id from phase_12x_state),
  pg_temp.phase_12x_fixture_message_id(21)
);
update phase_12x_state
set atomic_message_id = pg_temp.phase_12x_fixture_message_id(21)
where singleton;

update app_private.async_jobs
set available_at = now() - interval '1 second'
where id = (select atomic_job_id from phase_12x_state);
update pgmq.q_writing_evaluation
set vt = now() - interval '1 second'
where msg_id = (select atomic_message_id from phase_12x_state);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '12d00000-0000-4000-8000-000000000003',
    1,
    180
  )
)
update pg_temp.phase_12x_state state
set atomic_message_id = claimed.queue_message_id,
    attempt_number = claimed.attempt_number,
    worker_id = '12d00000-0000-4000-8000-000000000003'
from claimed
where state.singleton;

select is(
  (select attempt_number from pg_temp.phase_12x_state),
  2,
  'the timeout replacement is claimed as attempt two'
);

reset role;
update app_private.async_jobs
set lease_expires_at = now() - interval '1 second'
where id = (select atomic_job_id from phase_12x_state);
update pgmq.q_writing_evaluation
set vt = now() - interval '1 second'
where msg_id = (select atomic_message_id from phase_12x_state);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '12d00000-0000-4000-8000-000000000004',
    1,
    180
  )
)
update pg_temp.phase_12x_state state
set atomic_message_id = claimed.queue_message_id,
    attempt_number = claimed.attempt_number,
    worker_id = '12d00000-0000-4000-8000-000000000004'
from claimed
where state.singleton;

-- The Data API worker role intentionally has no direct async_jobs access.
-- Inspect the exact fixture only as the rollback-only test owner.
reset role;
select ok(
  (
    select state.attempt_number = 3
      and job.worker_id = '12d00000-0000-4000-8000-000000000004'::uuid
      and job.lease_expires_at > now()
    from pg_temp.phase_12x_state state
    join app_private.async_jobs job on job.id = state.atomic_job_id
  ),
  'an expired writing lease is reclaimed as attempt three by one fresh worker'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select atomic_job_id from pg_temp.phase_12x_state),
      (select atomic_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000003',
      (select atomic_feedback from pg_temp.phase_12x_state)
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'the stale attempt-two worker cannot publish after lease recovery'
);

reset role;
select is(
  (
    select count(*)::integer
    from (
      select line.id
      from public.submission_lines line
      where line.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select topic.id
      from public.submission_grammar_topics topic
      where topic.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select draft.id
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select evidence.job_id
      from app_private.writing_feedback_adjudications_v2 evidence
      where evidence.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
    ) stale_output
  ),
  0,
  'a stale completion attempt leaves no public or private feedback output'
);

-- The failure hook is deliberately test-only: pg_temp, revoked from every API
-- role, uncommitted, and narrowed by trigger WHEN to one fixture student.
create function pg_temp.phase_12x_fail_late_materialization()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'phase12x_injected_late_materialization_failure';
end;
$$;

revoke all on function pg_temp.phase_12x_fail_late_materialization()
from public, anon, authenticated, service_role;

create trigger phase_12x_injected_late_materialization_failure
before insert or update on public.student_grammar_stats
for each row
when (
  new.workspace_id = '12b00000-0000-4000-8000-000000000001'::uuid
  and new.student_id = '12a00000-0000-4000-8000-000000000003'::uuid
)
execute function pg_temp.phase_12x_fail_late_materialization();

select ok(
  not has_function_privilege(
    'anon',
    'pg_temp.phase_12x_fail_late_materialization()'::regprocedure,
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'pg_temp.phase_12x_fail_late_materialization()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'pg_temp.phase_12x_fail_late_materialization()'::regprocedure,
      'EXECUTE'
    )
    and to_regprocedure(
      'app_private.phase_12x_fail_late_materialization()'
    ) is null
    and to_regprocedure(
      'api.phase_12x_fail_late_materialization()'
    ) is null,
  'the transaction-local failure hook is impossible to call through browser or worker roles'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select atomic_job_id from pg_temp.phase_12x_state),
      (select atomic_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000004',
      (select atomic_feedback from pg_temp.phase_12x_state)
    )
  $$,
  'P0001',
  'phase12x_injected_late_materialization_failure',
  'an injected late statistics failure aborts the complete materialization call'
);

reset role;
select ok(
  (
    select job.status = 'processing'
      and job.attempt_count = 3
      and job.worker_id = '12d00000-0000-4000-8000-000000000004'::uuid
      and submission.status = 'checking'
      and submission.evaluation_status = 'processing'
      and submission.release_status = 'held'
      and submission.corrected_text is null
      and submission.overall_summary is null
    from app_private.async_jobs job
    join public.submissions submission on submission.id = job.entity_id
    where job.id = (select atomic_job_id from phase_12x_state)
  ),
  'late failure rolls the job and parent back to the exact active-lease state'
);

select is(
  (
    select count(*)::integer
    from (
      select line.id
      from public.submission_lines line
      where line.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select topic.id
      from public.submission_grammar_topics topic
      where topic.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
    ) public_feedback
  ),
  0,
  'late failure rolls back every materialized line and topic'
);

select is(
  (
    select count(*)::integer
    from (
      select draft.id
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select evidence.job_id
      from app_private.writing_feedback_adjudications_v2 evidence
      where evidence.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
    ) private_feedback
  ),
  0,
  'late failure rolls back the private draft and immutable adjudication row'
);

select is(
  (
    select count(*)::integer
    from (
      select evidence.source_release_id
      from app_private.practice_weakness_evidence evidence
      where evidence.submission_id = (
        select atomic_submission_id from phase_12x_state
      )
      union all
      select stats.id
      from public.student_grammar_stats stats
      where stats.workspace_id = '12b00000-0000-4000-8000-000000000001'
        and stats.student_id = '12a00000-0000-4000-8000-000000000003'
    ) weakness_state
  ),
  0,
  'late failure rolls back weakness evidence and derived statistics'
);

select ok(
  app_private.queue_message_exists(
    'writing_evaluation',
    (select atomic_message_id from phase_12x_state)
  )
    and (
      select count(*)
      from pgmq.a_writing_evaluation archive
      where archive.msg_id = (
        select atomic_message_id from phase_12x_state
      )
    ) = 0,
  'late failure leaves the current queue delivery unarchived for an exact retry'
);

drop trigger phase_12x_injected_late_materialization_failure
on public.student_grammar_stats;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select atomic_job_id from pg_temp.phase_12x_state),
      (select atomic_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000004',
      (select atomic_feedback from pg_temp.phase_12x_state)
    )
  $$,
  'the exact active delivery succeeds after the injected fault is removed'
);

reset role;
select ok(
  (
    select job.status = 'succeeded'
      and job.attempt_count = 3
      and submission.status = 'checked'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.corrected_text = '🙂 Ich helfe meinem Bruder.'
      and submission.overall_summary = 'Use the dative after helfen.'
      and draft.state = 'released'
      and (
        select count(*)
        from public.submission_lines line
        where line.submission_id = submission.id
      ) = 1
      and (
        select count(*)
        from public.submission_grammar_topics topic
        where topic.submission_id = submission.id
          and topic.count = 1
          and topic.severity = 'minor'
      ) = 1
      and (
        select count(*)
        from app_private.practice_weakness_evidence evidence
        where evidence.submission_id = submission.id
          and evidence.minor_issue_count = 1
      ) = 1
      and (
        select count(*)
        from public.student_grammar_stats stats
        where stats.workspace_id = submission.workspace_id
          and stats.student_id = submission.student_id
          and stats.total_minor_issues = 1
          and stats.total_major_issues = 0
      ) = 1
      and not app_private.queue_message_exists(
        job.queue_name,
        job.queue_message_id
      )
      and (
        select count(*)
        from pgmq.a_writing_evaluation archive
        where archive.msg_id = job.queue_message_id
      ) = 1
    from app_private.async_jobs job
    join public.submissions submission on submission.id = job.entity_id
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
     and draft.version = job.entity_version
    where job.id = (select atomic_job_id from phase_12x_state)
  ),
  'one transaction releases the parent, line, topic, draft, weakness state, and queue archive'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select atomic_job_id from pg_temp.phase_12x_state),
      (select atomic_message_id from pg_temp.phase_12x_state),
      '12d00000-0000-4000-8000-000000000004',
      (select atomic_feedback from pg_temp.phase_12x_state)
    )
  $$,
  'exact completion redelivery is accepted idempotently'
);

reset role;
select ok(
  (
    select (
        select count(*)
        from app_private.feedback_drafts draft
        where draft.submission_id = state.atomic_submission_id
      ) = 1
      and (
        select count(*)
        from public.submission_lines line
        where line.submission_id = state.atomic_submission_id
      ) = 1
      and (
        select count(*)
        from public.submission_grammar_topics topic
        where topic.submission_id = state.atomic_submission_id
      ) = 1
      and (
        select count(*)
        from app_private.practice_weakness_evidence evidence
        where evidence.submission_id = state.atomic_submission_id
      ) = 1
      and (
        select count(*)
        from app_private.writing_feedback_adjudications_v2 evidence
        where evidence.submission_id = state.atomic_submission_id
      ) = 1
      and (
        select count(*)
        from public.student_grammar_stats stats
        where stats.workspace_id = '12b00000-0000-4000-8000-000000000001'
          and stats.student_id = '12a00000-0000-4000-8000-000000000003'
      ) = 1
      and (
        select count(*)
        from pgmq.a_writing_evaluation archive
        where archive.msg_id = state.atomic_message_id
      ) = 1
    from phase_12x_state state
    where state.singleton
  ),
  'stale recovery plus exact replay leaves one public result, one statistic, and one archive row'
);

select * from finish();
rollback;
