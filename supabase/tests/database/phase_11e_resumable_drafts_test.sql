begin;

select plan(32);

select ok(
  to_regclass('app_private.writing_drafts') is not null
    and to_regclass('app_private.practice_drafts') is not null,
  'private writing and practice draft stores exist'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.writing_drafts'::regclass)
    and (select relrowsecurity from pg_class where oid = 'app_private.practice_drafts'::regclass)
    and not has_table_privilege('authenticated', 'app_private.writing_drafts', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.practice_drafts', 'SELECT'),
  'draft tables are RLS-protected and never directly exposed'
);
select ok(
  has_function_privilege(
    'authenticated',
    'api.save_writing_draft(uuid,uuid,text,uuid,text,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.submit_writing_draft(uuid,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.save_practice_draft(uuid,jsonb,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.save_writing_draft(uuid,uuid,text,uuid,text,integer)',
      'EXECUTE'
    ),
  'only authenticated callers receive the narrow draft API'
);

-- This test shares staging with real recovery evidence. It deliberately leaves
-- every pre-existing queue message and async job untouched; all assertions
-- below are scoped to the submission created by this transaction.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11e-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11E Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11e-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11E Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1333333-3333-4333-8333-333333333333',
  'Phase 11E Workspace',
  'phase-11e-workspace',
  'e1111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'e1333333-3333-4333-8333-333333333333',
  'e1111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'e1333333-3333-4333-8333-333333333333',
  'e1222222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'e1444444-4444-4444-8444-444444444444',
  'e1333333-3333-4333-8333-333333333333',
  'Phase 11E A2',
  'A2',
  true,
  'immediate'
);

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values (
  'e1555555-5555-4555-8555-555555555555',
  'e1444444-4444-4444-8444-444444444444',
  'e1222222-2222-4222-8222-222222222222',
  'e1333333-3333-4333-8333-333333333333'
);

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type, is_active
)
values (
  'e1666666-6666-4666-8666-666666666666',
  'e1333333-3333-4333-8333-333333333333',
  'Phase 11E writing',
  'Schreibe zwei kurze Sätze über deinen Tag.',
  'A2',
  'Alltag',
  'writing',
  true
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'e1777777-7777-4777-8777-777777777777',
  'phase-11e-articles',
  'Phase 11E Articles',
  'A2',
  'A reset-safe draft test topic.'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title,
  description, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'e1888888-8888-4888-8888-888888888888',
  'e1333333-3333-4333-8333-333333333333',
  'e1777777-7777-4777-8777-777777777777',
  'A2', 'easy', 'Phase 11E worksheet', 'One objective item.',
  true, 'workspace', 'e1111111-1111-4111-8111-111111111111',
  'manual_import', 'approved'
);

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values (
  'e1999999-9999-4999-8999-999999999999',
  'e1888888-8888-4888-8888-888888888888',
  1, 'multiple_choice', 'local_exact',
  'Welcher Artikel passt: Ich sehe ___ Hund?',
  '["den","dem","der"]'::jsonb,
  'den', '["den"]'::jsonb, null, 1,
  'The direct masculine object uses den.'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status
)
values (
  'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'e1333333-3333-4333-8333-333333333333',
  'e1222222-2222-4222-8222-222222222222',
  'e1777777-7777-4777-8777-777777777777',
  'e1888888-8888-4888-8888-888888888888',
  'manual', 'unlocked', 'e1111111-1111-4111-8111-111111111111', 'ready'
);

create temporary table phase_11e_state (
  writing_draft_id uuid,
  writing_revision integer,
  submission_id uuid,
  practice_revision integer,
  practice_result jsonb
) on commit drop;
insert into phase_11e_state default values;
grant select, update on phase_11e_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'e1222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    E'  Erste Zeile.\nZweite Zeile.  ',
    0
  )
)
update pg_temp.phase_11e_state state
set writing_draft_id = saved.saved_draft_id,
    writing_revision = saved.saved_revision
from saved;

select ok(
  (select writing_draft_id is not null and writing_revision = 1 from phase_11e_state),
  'a first writing autosave creates revision one'
);
select is(
  (
    select "text"
    from api.get_writing_draft((select writing_draft_id from phase_11e_state))
  ),
  E'  Erste Zeile.\nZweite Zeile.  ',
  'writing autosave round-trips leading, trailing, and paragraph whitespace exactly'
);

with saved as (
  select *
  from api.save_writing_draft(
    (select writing_draft_id from pg_temp.phase_11e_state),
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    E'  Aktualisiert.\nMit Abstand.  ',
    1
  )
)
update pg_temp.phase_11e_state state
set writing_revision = saved.saved_revision
from saved;

select is(
  (select writing_revision from phase_11e_state),
  2,
  'a matching expected revision advances the writing draft exactly once'
);

with saved as (
  select *
  from api.save_writing_draft(
    (select writing_draft_id from pg_temp.phase_11e_state),
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    '',
    2
  )
)
update pg_temp.phase_11e_state state
set writing_revision = saved.saved_revision
from saved;

select is(
  (select writing_revision from phase_11e_state),
  3,
  'clearing a writing draft is persisted as a new revision'
);
select is(
  (
    select "text"
    from api.get_writing_draft((select writing_draft_id from phase_11e_state))
  ),
  '',
  'refresh does not resurrect stale writing after a complete clear'
);

with saved as (
  select *
  from api.save_writing_draft(
    (select writing_draft_id from pg_temp.phase_11e_state),
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    E'  Aktualisiert.\nMit Abstand.  ',
    3
  )
)
update pg_temp.phase_11e_state state
set writing_revision = saved.saved_revision
from saved;
select throws_ok(
  format(
    'select * from api.save_writing_draft(%L,%L,%L,%L,%L,1)',
    (select writing_draft_id from phase_11e_state),
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    'stale overwrite'
  ),
  'PT412',
  'draft_revision_conflict',
  'the writing autosave API returns a non-retryable precondition conflict'
);
select throws_ok(
  format(
    'select * from public.save_writing_draft_internal(%L,%L,%L,%L,%L,1)',
    (select writing_draft_id from phase_11e_state),
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    'stale internal overwrite'
  ),
  '40001',
  'draft_revision_conflict',
  'the writing autosave implementation preserves internal serialization semantics'
);
select throws_ok(
  format(
    'select * from api.submit_writing_draft(%L,3)',
    (select writing_draft_id from phase_11e_state)
  ),
  'PT412',
  'draft_revision_conflict',
  'the writing submit API returns a non-retryable precondition conflict'
);
select throws_ok(
  format(
    'select * from public.submit_writing_draft_internal(%L,3)',
    (select writing_draft_id from phase_11e_state)
  ),
  '40001',
  'draft_revision_conflict',
  'the writing submit implementation preserves internal serialization semantics'
);

with submitted as (
  select *
  from api.submit_writing_draft(
    (select writing_draft_id from pg_temp.phase_11e_state),
    4
  )
)
update pg_temp.phase_11e_state state
set submission_id = submitted.submission_id
from submitted;

select ok(
  (select submission_id is not null from phase_11e_state),
  'submitting a current writing draft returns a durable submission'
);
select is(
  (
    select submission.original_text
    from public.submissions submission
    where submission.id = (select submission_id from phase_11e_state)
  ),
  E'  Aktualisiert.\nMit Abstand.  ',
  'draft submission preserves the exact saved text'
);

-- The browser role must never read private draft/job tables directly. Switch
-- back to the transaction owner only for these two server-side postconditions.
reset role;

select ok(
  not exists (
    select 1
    from app_private.writing_drafts draft
    where draft.id = (select writing_draft_id from phase_11e_state)
  ),
  'the writing draft is removed only after submission succeeds'
);
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join pgmq.q_writing_evaluation queue on queue.msg_id = job.queue_message_id
    where job.entity_id = (select submission_id from phase_11e_state)
      and job.job_kind = 'writing_evaluation'
      and job.status = 'queued'
      and queue.message::text not like '%Aktualisiert%'
  ),
  'draft submission and content-free writing queue message commit together'
);

set local role authenticated;

with saved as (
  select *
  from api.save_practice_draft(
    'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[]'::jsonb,
    0
  )
)
update pg_temp.phase_11e_state state
set practice_revision = saved.saved_revision
from saved;

select is(
  (select practice_revision from phase_11e_state),
  1,
  'an empty partial worksheet autosave is valid at revision one'
);
select is(
  (
    select assignment.status
    from public.student_practice_assignments assignment
    where assignment.id = 'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'in_progress',
  'the first worksheet autosave starts the assignment'
);

with saved as (
  select *
  from api.save_practice_draft(
    'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{"question_id":"e1999999-9999-4999-8999-999999999999","answer":"den"}]'::jsonb,
    1
  )
)
update pg_temp.phase_11e_state state
set practice_revision = saved.saved_revision
from saved;

select is(
  (select practice_revision from phase_11e_state),
  2,
  'a worksheet autosave with an answer advances its revision'
);
select is(
  (
    select answers
    from api.get_practice_draft('e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ),
  '[{"question_id":"e1999999-9999-4999-8999-999999999999","answer":"den"}]'::jsonb,
  'refresh restores every saved worksheet answer'
);
select throws_ok(
  $$
    select *
    from api.save_practice_draft(
      'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"question_id":"e1999999-9999-4999-8999-999999999999","answer":"dem"}]'::jsonb,
      1
    )
  $$,
  'PT412',
  'draft_revision_conflict',
  'the practice autosave API returns a non-retryable precondition conflict'
);
select throws_ok(
  $$
    select *
    from public.save_practice_draft_internal(
      'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"question_id":"e1999999-9999-4999-8999-999999999999","answer":"dem"}]'::jsonb,
      1
    )
  $$,
  '40001',
  'draft_revision_conflict',
  'the practice autosave implementation preserves internal serialization semantics'
);
select throws_ok(
  $$
    select *
    from api.save_practice_draft(
      'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"question_id":"e1bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","answer":"den"}]'::jsonb,
      2
    )
  $$,
  '22023',
  'practice_answers_invalid',
  'autosave rejects answers for a question outside the assigned worksheet'
);
select throws_ok(
  $$
    select api.submit_practice_attempt(
      'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1
    )
  $$,
  'PT412',
  'draft_revision_conflict',
  'the practice submit API returns a non-retryable precondition conflict'
);
select throws_ok(
  $$
    select public.submit_practice_draft_internal(
      'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1
    )
  $$,
  '40001',
  'draft_revision_conflict',
  'the practice submit implementation preserves internal serialization semantics'
);

update pg_temp.phase_11e_state state
set practice_result = api.submit_practice_attempt(
  'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  2
);

select ok(
  (select practice_result ->> 'latest_attempt_id' is not null from phase_11e_state),
  'submitting the locked worksheet draft returns the attempt result'
);

-- Verify private cleanup as the transaction owner; authenticated callers
-- intentionally have no direct visibility into the draft store.
reset role;

select ok(
  not exists (
    select 1
    from app_private.practice_drafts draft
    where draft.assignment_id = 'e1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'worksheet draft deletion is atomic with successful attempt submission'
);

set local role authenticated;

select is(
  (
    select attempt.answers
    from public.practice_test_attempts attempt
    where attempt.id = (
      select (practice_result ->> 'latest_attempt_id')::uuid
      from phase_11e_state
    )
  ),
  '[{"question_id":"e1999999-9999-4999-8999-999999999999","answer":"den"}]'::jsonb,
  'the submitted attempt uses the exact revision-locked answer set'
);

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'e1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'e1666666-6666-4666-8666-666666666666',
    'Dieser Entwurf gehört nur zur aktuellen Klasse.',
    0
  )
)
update pg_temp.phase_11e_state state
set writing_draft_id = saved.saved_draft_id,
    writing_revision = saved.saved_revision
from saved;

reset role;
delete from public.batch_students enrollment
where enrollment.batch_id = 'e1444444-4444-4444-8444-444444444444'
  and enrollment.student_id = 'e1222222-2222-4222-8222-222222222222';
set local role authenticated;

select is_empty(
  format(
    'select * from api.get_writing_draft(%L::uuid)',
    (select writing_draft_id from pg_temp.phase_11e_state)
  ),
  'removal from one batch revokes a known draft id even while workspace membership remains'
);
select is_empty(
  $$
    select *
    from api.list_my_writing_drafts(
      'e1333333-3333-4333-8333-333333333333',
      25
    )
  $$,
  'the draft list excludes drafts from a batch the student no longer attends'
);

reset role;
select ok(
  exists (
    select 1
    from app_private.writing_drafts draft
    where draft.id = (select writing_draft_id from pg_temp.phase_11e_state)
  ),
  'batch removal preserves the private draft for audit and possible restoration'
);

reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select is_empty(
  $$select * from api.get_writing_draft('e1cccccc-cccc-4ccc-8ccc-cccccccccccc')$$,
  'anonymous draft reads return no private content'
);

select * from finish();
rollback;
