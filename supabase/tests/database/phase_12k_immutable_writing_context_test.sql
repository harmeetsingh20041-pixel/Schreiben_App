begin;

-- Fixture-scoped and rollback-only. This test never claims, purges, or reads
-- another tenant's queue messages.
select plan(29);

select ok(
  to_regclass('app_private.writing_evaluation_contexts') is not null
    and to_regclass('app_private.writing_evaluation_context_holds') is not null,
  'private immutable context and legacy-hold ledgers exist'
);

select ok(
  to_regprocedure('app_private.capture_writing_evaluation_context(uuid)') is not null
    and to_regprocedure('api.get_writing_evaluation_context(uuid)') is not null,
  'submission capture and service-only loading routines exist'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'app_private.writing_evaluation_contexts',
    'SELECT'
  )
    and not has_table_privilege(
      'anon',
      'app_private.writing_evaluation_contexts',
      'SELECT'
    )
    and has_table_privilege(
      'service_role',
      'app_private.writing_evaluation_contexts',
      'SELECT'
    ),
  'only the service worker can read the private snapshot table'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.get_writing_evaluation_context(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.get_writing_evaluation_context(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_writing_evaluation_context(uuid)',
      'EXECUTE'
    ),
  'the evaluator loader is not callable by browser roles'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'app_private'
      and column_info.table_name = 'writing_evaluation_contexts'
      and column_info.column_name in ('original_text', 'writing_text', 'answer_text')
  )
    and exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'app_private'
        and column_info.table_name = 'writing_evaluation_contexts'
        and column_info.column_name = 'original_text_sha256'
    ),
  'the immutable context binds but never duplicates raw student writing'
);

select ok(
  pg_get_functiondef(
    'api.get_writing_evaluation_context(uuid)'::regprocedure
  ) not like '%public.batches%'
    and pg_get_functiondef(
      'api.get_writing_evaluation_context(uuid)'::regprocedure
    ) not like '%public.questions%'
    and pg_get_functiondef(
      'api.get_writing_evaluation_context(uuid)'::regprocedure
    ) not like '%public.global_questions%',
  'the worker loader cannot fall back to mutable class or question tables'
);

select ok(
  position(
    'lock_writing_submission_source_context' in pg_get_functiondef(
      'public.create_writing_submission(text,uuid,uuid,text,boolean)'::regprocedure
    )
  ) > 0
    and position(
      'lock_writing_submission_source_context' in pg_get_functiondef(
        'public.create_writing_submission(text,uuid,uuid,text,boolean)'::regprocedure
      )
    ) < position(
      'create_writing_submission_internal' in pg_get_functiondef(
        'public.create_writing_submission(text,uuid,uuid,text,boolean)'::regprocedure
      )
    )
    and lower(pg_get_functiondef(
      'app_private.lock_writing_submission_source_context(uuid,text,uuid)'::regprocedure
    )) like '%for share%'
    and pg_get_functiondef(
      'public.create_writing_submission(text,uuid,uuid,text,boolean)'::regprocedure
    ) like '%capture_writing_evaluation_context%'
    and pg_get_functiondef(
      'public.create_writing_submission(text,uuid,uuid,text,boolean)'::regprocedure
    ) like '%enqueue_async_job%',
  'one transaction locks source rows, captures context, and enqueues both submit paths'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_info
    where trigger_info.tgrelid = 'app_private.async_jobs'::regclass
      and trigger_info.tgname = 'async_jobs_guard_writing_context'
      and not trigger_info.tgisinternal
  )
    and pg_get_functiondef(
      'app_private.guard_writing_job_context()'::regprocedure
    ) like '%class_context_integrity%'
    and pg_get_functiondef(
      'public.request_practice_worksheet(uuid)'::regprocedure
    ) like '%class_context_integrity%'
    and pg_get_functiondef(
      'api.get_worksheet_generation_context(uuid)'::regprocedure
    ) like '%app_private.get_worksheet_generation_context_phase_13g%'
    and pg_get_functiondef(
      'app_private.get_worksheet_generation_context_phase_13g(uuid)'::regprocedure
    ) like '%class_context_integrity%'
    and not has_function_privilege(
      'service_role',
      'app_private.get_worksheet_generation_context_before_phase_13g(uuid)',
      'EXECUTE'
    ),
  'writing and worksheet jobs reject missing or legacy immutable context'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'c2111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12k-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12K Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12k-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12K Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c2333333-3333-4333-8333-333333333333',
  'Phase 12K Workspace', 'phase-12k-workspace',
  'c2111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'c2333333-3333-4333-8333-333333333333',
    'c2111111-1111-4111-8111-111111111111', 'teacher'
  ),
  (
    'c2333333-3333-4333-8333-333333333333',
    'c2222222-2222-4222-8222-222222222222', 'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values
  (
    'c2444444-4444-4444-8444-444444444444',
    'c2333333-3333-4333-8333-333333333333',
    'Phase 12K original A2', 'A2', true, 'immediate'
  ),
  (
    'c2455555-5555-4555-8555-555555555555',
    'c2333333-3333-4333-8333-333333333333',
    'Phase 12K other B1', 'B1', true, 'immediate'
  );

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values
  (
    'c2555555-5555-4555-8555-555555555555',
    'c2444444-4444-4444-8444-444444444444',
    'c2222222-2222-4222-8222-222222222222',
    'c2333333-3333-4333-8333-333333333333'
  ),
  (
    'c2566666-6666-4666-8666-666666666666',
    'c2455555-5555-4555-8555-555555555555',
    'c2222222-2222-4222-8222-222222222222',
    'c2333333-3333-4333-8333-333333333333'
  );

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type,
  expected_word_min, expected_word_max, estimated_minutes, is_active
)
values (
  'c2666666-6666-4666-8666-666666666666',
  'c2333333-3333-4333-8333-333333333333',
  'Mein Alltag', 'Beschreibe deinen Alltag.', 'A2', 'Alltag', 'description',
  40, 80, 15, true
);

create temporary table phase_12k_state (
  singleton boolean primary key default true check (singleton),
  submission_id uuid,
  simple_submission_id uuid
) on commit drop;
insert into phase_12k_state default values;
grant select, update on phase_12k_state to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'c2444444-4444-4444-8444-444444444444',
    'workspace_question',
    'c2666666-6666-4666-8666-666666666666',
    E'  Mein Alltag.\n\nIch lerne Deutsch.  '
  )
)
update pg_temp.phase_12k_state state
set submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

select ok(
  (select submission_id is not null from phase_12k_state)
    and (
      select count(*) = 1
      from app_private.writing_evaluation_contexts context
      where context.submission_id = (
        select submission_id from phase_12k_state where singleton
      )
    ),
  'an accepted writing atomically receives exactly one context snapshot'
);

select ok(
  exists (
    select 1
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
        select submission_id from phase_12k_state where singleton
      )
      and context.workspace_id = 'c2333333-3333-4333-8333-333333333333'
      and context.student_id = 'c2222222-2222-4222-8222-222222222222'
      and context.batch_id = 'c2444444-4444-4444-8444-444444444444'
      and context.cefr_level = 'A2'
      and context.source_type = 'workspace_question'
      and context.source_id = 'c2666666-6666-4666-8666-666666666666'
      and context.submission_mode = 'predefined_question'
  ),
  'workspace, student, class, CEFR, source, and mode are frozen exactly'
);

select ok(
  exists (
    select 1
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
        select submission_id from phase_12k_state where singleton
      )
      and context.question_metadata = jsonb_build_object(
        'title', 'Mein Alltag',
        'prompt', 'Beschreibe deinen Alltag.',
        'level', 'A2',
        'topic', 'Alltag',
        'task_type', 'description',
        'expected_word_min', 40,
        'expected_word_max', 80,
        'estimated_minutes', 15
      )
  ),
  'all evaluator-relevant prompt metadata is captured at submission time'
);

select ok(
  exists (
    select 1
    from app_private.writing_evaluation_contexts context
    join public.submissions submission on submission.id = context.submission_id
    where context.submission_id = (
        select submission_id from phase_12k_state where singleton
      )
      and submission.original_text = E'  Mein Alltag.\n\nIch lerne Deutsch.  '
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
        )
  ),
  'the exact original text remains separate and both hashes verify'
);

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join pgmq.q_writing_evaluation queue
      on queue.msg_id = job.queue_message_id
    where job.entity_id = (
        select submission_id from phase_12k_state where singleton
      )
      and job.entity_version = 1
      and queue.message ->> 'entity_id' = job.entity_id::text
      and queue.message ->> 'entity_version' = '1'
      and (
        select count(*) = 4
        from jsonb_object_keys(queue.message)
      )
      and queue.message::text not like '%Mein Alltag%'
      and queue.message::text not like '%Beschreibe%'
      and queue.message::text not like '%Deutsch%'
  ),
  'the durable queue contains ids and version only, never writing or prompt data'
);

select throws_ok(
  format(
    'update public.submissions set original_text = %L where id = %L',
    'Changed after submit',
    (select submission_id from phase_12k_state where singleton)
  ),
  '55000',
  'writing_submission_context_immutable',
  'the exact original writing cannot change after snapshot capture'
);

select throws_ok(
  format(
    'update app_private.writing_evaluation_contexts set cefr_level = %L where submission_id = %L',
    'B1',
    (select submission_id from phase_12k_state where singleton)
  ),
  '55000',
  'writing_evaluation_context_immutable',
  'a captured evaluator context cannot be updated'
);

select throws_ok(
  format(
    'delete from app_private.writing_evaluation_contexts where submission_id = %L',
    (select submission_id from phase_12k_state where singleton)
  ),
  '55000',
  'writing_evaluation_context_immutable',
  'a captured evaluator context cannot be deleted'
);

update public.batches
set level = 'B1', name = 'Phase 12K changed after submit'
where id = 'c2444444-4444-4444-8444-444444444444';

update public.questions
set
  title = 'Changed title',
  prompt = 'Changed prompt',
  level = 'B1',
  topic = 'Changed topic'
where id = 'c2666666-6666-4666-8666-666666666666';

set local role service_role;

select ok(
  exists (
    select 1
    from api.get_writing_evaluation_context(
      (select submission_id from phase_12k_state where singleton)
    ) context
    where context.workspace_id = 'c2333333-3333-4333-8333-333333333333'
      and context.batch_level = 'A2'
      and context.question_title = 'Mein Alltag'
      and context.question_prompt = 'Beschreibe deinen Alltag.'
      and context.question_level = 'A2'
      and context.question_topic = 'Alltag'
      and context.original_text = E'  Mein Alltag.\n\nIch lerne Deutsch.  '
  ),
  'worker retries retain original A2 class and question after live rows change'
);

reset role;

set local role authenticated;

select ok(
  (
    select detail #>> '{submission,question_title}' = 'Mein Alltag'
      and detail #>> '{submission,question_prompt}' = 'Beschreibe deinen Alltag.'
      and detail #>> '{submission,question_level}' = 'A2'
      and detail #>> '{submission,question_topic}' = 'Alltag'
      and detail #>> '{submission,batch_level}' = 'A2'
    from api.get_submission_detail(
      (select submission_id from phase_12k_state where singleton)
    ) detail
  ),
  'student and teacher detail shows the same frozen task as the evaluator'
);

select ok(
  (
    select (detail -> 'submission') ? 'automatic_retry_at'
      and (detail -> 'submission') ? 'automatic_retry_exhausted_at'
    from api.get_submission_detail(
      (select submission_id from phase_12k_state where singleton)
    ) detail
  ),
  'snapshot display preserves both Phase 12J provider-recovery fields'
);

reset role;

insert into public.submissions (
  id, workspace_id, student_id, batch_id, question_source, mode,
  original_text, status, evaluation_status, release_status, feedback_mode
)
values (
  'c2777777-7777-4777-8777-777777777777',
  'c2333333-3333-4333-8333-333333333333',
  'c2222222-2222-4222-8222-222222222222',
  'c2455555-5555-4555-8555-555555555555',
  'free_text', 'free_text', 'Historical text without a snapshot.',
  'failed', 'failed', 'held', 'teacher_review_only'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c2111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.retry_writing_evaluation(
      'c2777777-7777-4777-8777-777777777777'
    )
  $$,
  '55000',
  'writing_evaluation_context_missing',
  'a historical writing cannot be retried using current multi-class membership'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = 'c2777777-7777-4777-8777-777777777777'
      and submission.evaluation_status = 'failed'
      and submission.evaluation_version = 1
  )
    and not exists (
      select 1
      from app_private.async_jobs job
      where job.entity_id = 'c2777777-7777-4777-8777-777777777777'
    ),
  'the rejected historical retry rolls back status, version, job, and message'
);

select throws_ok(
  $$
    insert into app_private.async_jobs (
      id, queue_name, job_kind, entity_id, entity_version,
      idempotency_key, status
    ) values (
      'c2888888-8888-4888-8888-888888888888',
      'writing_evaluation', 'writing_evaluation',
      'c2777777-7777-4777-8777-777777777777', 1,
      'phase12k:missing-context', 'queued'
    )
  $$,
  '55000',
  'writing_evaluation_context_missing',
  'even a privileged direct job insert cannot bypass the context guard'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c2222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'c2455555-5555-4555-8555-555555555555',
    'free_text', null, 'Ich lerne Deutsch.'
  )
)
update pg_temp.phase_12k_state state
set simple_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

select is(
  (
    select context.cefr_level
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
      select simple_submission_id from phase_12k_state where singleton
    )
  ),
  'B1',
  'a second explicit class selection freezes its own level without membership guessing'
);

update public.batches
set level = 'A1', name = 'Phase 12K second class changed after submit'
where id = 'c2455555-5555-4555-8555-555555555555';

insert into public.grammar_topics (
  id, slug, name, level, description
)
values
  (
    'c2999999-9999-4999-8999-999999999999',
    'phase12k-snapshot-topic', 'Phase 12K Snapshot Topic', 'B1',
    'Snapshot evidence test'
  ),
  (
    'c29aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'phase12k-legacy-topic', 'Phase 12K Legacy Topic', 'B1',
    'Legacy evidence test'
  );

insert into app_private.feedback_drafts (
  id, submission_id, version, state, content, provider_model
)
values (
  'c2abbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (select simple_submission_id from phase_12k_state where singleton),
  1, 'draft',
  jsonb_build_object(
    'overall_summary', 'Der Text ist korrekt.',
    'level_detected', 'B1',
    'corrected_text', 'Ich lerne Deutsch.',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 18,
      'original_line', 'Ich lerne Deutsch.',
      'corrected_line', 'Ich lerne Deutsch.',
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb,
    'score_summary', '{}'::jsonb
  ),
  'phase12k-test-model'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id, grammar_topic_id,
  batch_id, evidence_level, writing_context_version, writing_context_sha256,
  minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'c2abbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'c2abbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (select simple_submission_id from phase_12k_state where singleton),
  'c2333333-3333-4333-8333-333333333333',
  'c2222222-2222-4222-8222-222222222222',
  'c2999999-9999-4999-8999-999999999999',
  'c2444444-4444-4444-8444-444444444444',
  'A1', 0, null, 0, 1, now()
);

select ok(
  exists (
    select 1
    from app_private.practice_weakness_evidence evidence
    join app_private.writing_evaluation_contexts context
      on context.submission_id = evidence.submission_id
    where evidence.source_release_id = 'c2abbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      and evidence.batch_id = context.batch_id
      and evidence.evidence_level = context.cefr_level
      and evidence.writing_context_version = 1
      and evidence.writing_context_sha256 = context.context_sha256
      and evidence.class_context_integrity = 'writing_snapshot'
  ),
  'writing weakness evidence overwrites caller values with the frozen snapshot'
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'c2333333-3333-4333-8333-333333333333'
      and cycle.student_id = 'c2222222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'c2999999-9999-4999-8999-999999999999'
      and cycle.batch_id = 'c2455555-5555-4555-8555-555555555555'
      and cycle.worksheet_level = 'B1'
      and cycle.class_context_version = 1
      and cycle.class_context_integrity = 'writing_snapshot'
  ),
  'adaptive cycle creation inherits snapshot-backed class and level only'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id, grammar_topic_id,
  batch_id, evidence_level,
  minor_issue_count, major_issue_count, released_at
)
values (
  'legacy_release',
  'c2777777-7777-4777-8777-777777777777',
  null,
  'c2777777-7777-4777-8777-777777777777',
  'c2333333-3333-4333-8333-333333333333',
  'c2222222-2222-4222-8222-222222222222',
  'c29aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'c2455555-5555-4555-8555-555555555555',
  'B1', 0, 1, now()
);

select ok(
  exists (
    select 1
    from app_private.practice_weakness_evidence evidence
    where evidence.source_kind = 'legacy_release'
      and evidence.source_release_id = 'c2777777-7777-4777-8777-777777777777'
      and evidence.batch_id is null
      and evidence.evidence_level is null
      and evidence.writing_context_version = 0
      and evidence.writing_context_sha256 is null
      and evidence.class_context_integrity = 'legacy_unverified'
  ),
  'legacy evidence is explicitly unverified instead of inferred from a live class'
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'c2333333-3333-4333-8333-333333333333'
      and cycle.student_id = 'c2222222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'c29aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and cycle.batch_id is null
      and cycle.worksheet_level is null
      and cycle.class_context_version = 0
      and cycle.class_context_integrity = 'legacy_unverified'
  ),
  'legacy weakness creates only a held version-zero cycle for teacher recovery'
);

select throws_ok(
  $$
    update public.student_practice_assignments assignment
    set class_context_integrity = 'teacher_verified'
    where assignment.workspace_id = 'c2333333-3333-4333-8333-333333333333'
      and assignment.student_id = 'c2222222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'c29aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '55000',
  'Practice assignment class context is immutable.',
  'an integrity-only legacy relabel cannot bypass audited teacher recovery'
);

select ok(
  not exists (
    select 1
    from app_private.writing_evaluation_context_holds hold
    join app_private.writing_evaluation_contexts context
      on context.submission_id = hold.submission_id
  ),
  'a submission can never be both snapshot-backed and legacy-held'
);

select * from finish();
rollback;
