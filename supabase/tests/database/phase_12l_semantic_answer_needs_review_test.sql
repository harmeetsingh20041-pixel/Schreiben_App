begin;

-- Shared-staging-safe rollback test. It uses isolated identifiers and queue
-- message ids that cannot collide with live sequences; every write rolls back.
select plan(53);

select has_table(
  'app_private',
  'practice_semantic_review_holds',
  'semantic answer holds are private durable records'
);

select has_table(
  'app_private',
  'worksheet_answer_adjudication_evidence',
  'dual-provider semantic adjudication evidence is private and durable'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.practice_test_attempts'::regclass
      and constraint_row.conname = 'practice_test_attempts_evaluation_status_check'
      and pg_get_constraintdef(constraint_row.oid) like '%needs_review%'
  )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'public.practice_attempt_question_reviews'::regclass
        and constraint_row.conname =
          'practice_attempt_question_reviews_evaluator_source_check'
        and pg_get_constraintdef(constraint_row.oid) like '%system%'
    ),
  'attempt status and review source constraints include private review and truthful system provenance'
);

select ok(
  (
    select jsonb_object_agg(
      attribute.attname,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
      order by attribute.attnum
    )
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'api.practice_test_attempts'::regclass
      and attribute.attname in (
        'score', 'max_score', 'score_percent', 'passed',
        'score_points', 'max_score_points', 'scoring_version',
        'evaluation_error'
      )
      and not attribute.attisdropped
  ) = '{"score":"integer","max_score":"integer","score_percent":"numeric(5,2)","passed":"boolean","score_points":"numeric(6,2)","max_score_points":"numeric(6,2)","scoring_version":"text","evaluation_error":"text"}'::jsonb
    and exists (
      select 1
      from information_schema.columns score_percent
      join information_schema.columns score_points
        on score_points.table_schema = score_percent.table_schema
       and score_points.table_name = score_percent.table_name
       and score_points.column_name = 'score_points'
      join information_schema.columns max_score_points
        on max_score_points.table_schema = score_percent.table_schema
       and max_score_points.table_name = score_percent.table_name
       and max_score_points.column_name = 'max_score_points'
      where score_percent.table_schema = 'api'
        and score_percent.table_name = 'practice_test_attempts'
        and score_percent.column_name = 'score_percent'
        and score_percent.numeric_precision = 5
        and score_percent.numeric_scale = 2
        and score_points.numeric_precision = 6
        and score_points.numeric_scale = 2
        and max_score_points.numeric_precision = 6
        and max_score_points.numeric_scale = 2
    ),
  'masked grade columns preserve the existing API view types and numeric typmods'
);

select ok(
  (
    select bool_and(relation.relrowsecurity)
    from pg_class relation
    where relation.oid in (
      'app_private.practice_semantic_review_holds'::regclass,
      'app_private.worksheet_answer_adjudication_evidence'::regclass
    )
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_semantic_review_holds',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.worksheet_answer_adjudication_evidence',
      'SELECT'
    ),
  'both ledgers have RLS defense and no Data API read grants'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.hold_worksheet_answer_for_review(uuid,bigint,uuid,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.hold_worksheet_answer_for_review(uuid,bigint,uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.get_practice_semantic_review_draft(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.finalize_practice_semantic_review(uuid,uuid,integer,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_with_provenance(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'only the adjudicated worker facade remains executable and teacher capabilities stay separated'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.finalize_practice_semantic_review(uuid,uuid,integer,text,jsonb)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.get_practice_semantic_review_draft(uuid)'::regprocedure
    )
    and (
      select bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
      from pg_proc routine
      where routine.oid in (
        'api.finalize_practice_semantic_review(uuid,uuid,integer,text,jsonb)'::regprocedure,
        'api.get_practice_semantic_review_draft(uuid)'::regprocedure,
        'public.finalize_practice_semantic_review_internal(uuid,uuid,integer,text,jsonb)'::regprocedure,
        'public.get_practice_semantic_review_draft_internal(uuid)'::regprocedure
      )
    ),
  'teacher wrappers are invoker boundaries and every implementation pins an empty search path'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.practice_test_attempts'::regclass
      and trigger_row.tgname = 'practice_attempt_answers_immutable'
      and not trigger_row.tgisinternal
  )
    and (
      select count(*) = 2
      from pg_trigger trigger_row
      where trigger_row.tgname in (
        'practice_semantic_review_holds_immutable',
        'worksheet_answer_adjudication_evidence_immutable'
      )
        and not trigger_row.tgisinternal
    ),
  'submitted answers and both semantic audit ledgers have immutable triggers'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b1211111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12l-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12l-student-one@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Student One"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1233333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12l-student-two@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Student Two"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1244444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase12l-student-three@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Student Three"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1261111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12l-student-four@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Student Four"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1262222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12l-student-five@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Student Five"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1255555-5555-4555-8555-555555555555',
    'authenticated', 'authenticated', 'phase12l-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12L Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  ('b1211111-1111-4111-8111-111111111111', 'Phase 12L Teacher', 'phase12l-teacher@example.test', 'student'),
  ('b1222222-2222-4222-8222-222222222222', 'Phase 12L Student One', 'phase12l-student-one@example.test', 'student'),
  ('b1233333-3333-4333-8333-333333333333', 'Phase 12L Student Two', 'phase12l-student-two@example.test', 'student'),
  ('b1244444-4444-4444-8444-444444444444', 'Phase 12L Student Three', 'phase12l-student-three@example.test', 'student'),
  ('b1261111-1111-4111-8111-111111111111', 'Phase 12L Student Four', 'phase12l-student-four@example.test', 'student'),
  ('b1262222-2222-4222-8222-222222222222', 'Phase 12L Student Five', 'phase12l-student-five@example.test', 'student'),
  ('b1255555-5555-4555-8555-555555555555', 'Phase 12L Outsider', 'phase12l-outsider@example.test', 'student')
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'b1266666-6666-4666-8666-666666666666',
  'Phase 12L Workspace',
  'phase-12l-workspace',
  'b1211111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1211111-1111-4111-8111-111111111111', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'b1266666-6666-4666-8666-666666666666',
  'b1211111-1111-4111-8111-111111111111',
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('b1266666-6666-4666-8666-666666666666', 'b1222222-2222-4222-8222-222222222222', 'student'),
  ('b1266666-6666-4666-8666-666666666666', 'b1233333-3333-4333-8333-333333333333', 'student'),
  ('b1266666-6666-4666-8666-666666666666', 'b1244444-4444-4444-8444-444444444444', 'student'),
  ('b1266666-6666-4666-8666-666666666666', 'b1261111-1111-4111-8111-111111111111', 'student'),
  ('b1266666-6666-4666-8666-666666666666', 'b1262222-2222-4222-8222-222222222222', 'student');

insert into public.batches (
  id, workspace_id, name, level, feedback_mode, is_active, created_by
)
values (
  'b1277777-7777-4777-8777-777777777777',
  'b1266666-6666-4666-8666-666666666666',
  'Phase 12L A2 Class', 'A2', 'immediate', true,
  'b1211111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  ('b1266666-6666-4666-8666-666666666666', 'b1277777-7777-4777-8777-777777777777', 'b1222222-2222-4222-8222-222222222222'),
  ('b1266666-6666-4666-8666-666666666666', 'b1277777-7777-4777-8777-777777777777', 'b1233333-3333-4333-8333-333333333333'),
  ('b1266666-6666-4666-8666-666666666666', 'b1277777-7777-4777-8777-777777777777', 'b1244444-4444-4444-8444-444444444444'),
  ('b1266666-6666-4666-8666-666666666666', 'b1277777-7777-4777-8777-777777777777', 'b1261111-1111-4111-8111-111111111111'),
  ('b1266666-6666-4666-8666-666666666666', 'b1277777-7777-4777-8777-777777777777', 'b1262222-2222-4222-8222-222222222222');

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b1288888-8888-4888-8888-888888888888',
  'phase-12l-dative', 'Phase 12L Dative', 'A2',
  'Semantic answer review fixture.'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'b1299999-9999-4999-8999-999999999999',
  'b1266666-6666-4666-8666-666666666666',
  'b1288888-8888-4888-8888-888888888888',
  'A2', 'medium', 'Phase 12L mixed worksheet',
  'One local and one flexible question.', false, true, 'workspace',
  'b1211111-1111-4111-8111-111111111111', 'manual_import', 'approved'
);

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'b12a1111-1111-4111-8111-111111111111',
    'b1299999-9999-4999-8999-999999999999',
    1, 'multiple_choice', 'local_exact',
    'Welcher Artikel passt: Ich helfe ___ Mann?',
    '["dem","den","der"]'::jsonb, 'dem', '["dem"]'::jsonb,
    null, 1, 'Helfen takes a dative object.'
  ),
  (
    'b12b2222-2222-4222-8222-222222222222',
    'b1299999-9999-4999-8999-999999999999',
    2, 'transformation', 'open_evaluation',
    'Formuliere einen Satz mit helfen.', null,
    'Ich helfe dem Mann.', '[]'::jsonb,
    '{"criteria":["Use helfen with a correct dative object."],"sample_answer":"Ich helfe dem Mann."}'::jsonb,
    1, 'Use the dative after helfen.'
  );

-- Exercise the real student draft/submit path. The immutability trigger must
-- allow exactly this in-progress -> submitted transition, then reject every
-- later answer mutation while an exact lost-response replay remains safe.
insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, generation_status
)
values (
  'b12c4444-4444-4444-8444-444444444444',
  'b1266666-6666-4666-8666-666666666666',
  'b1261111-1111-4111-8111-111111111111',
  'b1288888-8888-4888-8888-888888888888',
  'b1299999-9999-4999-8999-999999999999',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1, 'teacher_verified',
  'manual', 'unlocked', 'b1211111-1111-4111-8111-111111111111',
  now(), 'ready'
);

create temporary table phase_12l_submit_results (
  name text primary key,
  payload jsonb not null
) on commit drop;
grant select, insert on phase_12l_submit_results to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1261111-1111-4111-8111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$
    insert into phase_12l_submit_results (name, payload)
    select 'draft', to_jsonb(saved)
    from api.save_practice_draft(
      'b12c4444-4444-4444-8444-444444444444',
      '[{"question_id":"b12a1111-1111-4111-8111-111111111111","answer":"dem"},{"question_id":"b12b2222-2222-4222-8222-222222222222","answer":"Ich helfe dem Mann."}]'::jsonb,
      0
    ) saved
  $$,
  'a student can autosave a complete worksheet draft'
);

select lives_ok(
  $$
    insert into phase_12l_submit_results (name, payload)
    values (
      'submit',
      api.submit_practice_attempt(
        'b12c4444-4444-4444-8444-444444444444',
        1
      )
    )
  $$,
  'the standard draft submission atomically persists answers and queues evaluation'
);

select is(
  api.submit_practice_attempt(
    'b12c4444-4444-4444-8444-444444444444',
    1
  ),
  (select payload from phase_12l_submit_results where name = 'submit'),
  'an exact lost-response submission replay returns the original safe read model'
);

reset role;

select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
    join app_private.async_jobs job
      on job.entity_id = attempt.id
     and job.job_kind = 'worksheet_answer_evaluation'
     and job.entity_version = attempt.evaluation_version
    where assignment.id = 'b12c4444-4444-4444-8444-444444444444'
      and attempt.answers =
        '[{"question_id":"b12a1111-1111-4111-8111-111111111111","answer":"dem"},{"question_id":"b12b2222-2222-4222-8222-222222222222","answer":"Ich helfe dem Mann."}]'::jsonb
      and attempt.status = 'submitted'
      and attempt.evaluation_status = 'queued'
      and attempt.submit_draft_revision = 1
      and job.status = 'queued'
  )
    and not exists (
      select 1
      from app_private.practice_drafts draft
      where draft.assignment_id = 'b12c4444-4444-4444-8444-444444444444'
    )
    and exists (
      select 1
      from phase_12l_submit_results submitted
      where submitted.name = 'submit'
        and submitted.payload ?& array[
          'id', 'workspace_id', 'student_id', 'practice_test_id',
          'latest_attempt_id', 'latest_attempt_status', 'evaluation_status',
          'score', 'score_points', 'score_percent', 'passed',
          'generation_status', 'student_name', 'student_email'
        ]
        and submitted.payload ->> 'id' =
          'b12c4444-4444-4444-8444-444444444444'
        and submitted.payload ->> 'evaluation_status' = 'queued'
        and submitted.payload -> 'score' = 'null'::jsonb
    ),
  'normal submission preserves exact answers, receipt, durable job, full safe read model, and consumes the draft'
);

select throws_ok(
  $$
    update public.practice_test_attempts
    set answers = '[]'::jsonb
    where assignment_id = 'b12c4444-4444-4444-8444-444444444444'
  $$,
  '55000',
  'submitted_practice_answers_immutable',
  'the normally submitted answers are immutable after the one-time transition'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, completed_at, generation_status
)
values (
  'b12c1111-1111-4111-8111-111111111111',
  'b1266666-6666-4666-8666-666666666666',
  'b1222222-2222-4222-8222-222222222222',
  'b1288888-8888-4888-8888-888888888888',
  'b1299999-9999-4999-8999-999999999999',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1, 'teacher_verified',
  'manual', 'completed', 'b1211111-1111-4111-8111-111111111111',
  now(), now(), 'ready'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
)
values (
  'b12d1111-1111-4111-8111-111111111111',
  'b1299999-9999-4999-8999-999999999999',
  'b1222222-2222-4222-8222-222222222222',
  'b1266666-6666-4666-8666-666666666666',
  'b12c1111-1111-4111-8111-111111111111',
  '[{"question_id":"b12a1111-1111-4111-8111-111111111111","answer":"dem"},{"question_id":"b12b2222-2222-4222-8222-222222222222","answer":"Ich helfe dem Mann."}]'::jsonb,
  1, 1, 1, 1, 100, null, 'phase_12l_provisional',
  'evaluating', 1, now(), 'submitted', now(), now(), now()
);

update public.student_practice_assignments
set latest_attempt_id = 'b12d1111-1111-4111-8111-111111111111'
where id = 'b12c1111-1111-4111-8111-111111111111';

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at,
  provider_outage_epoch, provider_outage_recovery_count,
  provider_outage_started_at, provider_outage_deadline_at,
  provider_outage_last_reason
)
values (
  'b12e1111-1111-4111-8111-111111111111',
  'worksheet_answer_evaluation', 'worksheet_answer_evaluation',
  'b12d1111-1111-4111-8111-111111111111', 1,
  'phase12l:hold:attempt-one', 'processing', 3,
  9223372036854775001, 'b12f1111-1111-4111-8111-111111111111', now(),
  now() + interval '10 minutes', now(), now(),
  1, 2, '2026-07-11 08:00:00+00', '2026-07-12 08:00:00+00',
  'dual_provider_outage_unavailable'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select ok(
  exists (
    select 1
    from api.practice_test_attempts attempt
    where attempt.id = 'b12d1111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'evaluating'
      and attempt.score is null
      and attempt.max_score is null
      and attempt.score_points is null
      and attempt.score_percent is null
      and attempt.passed is null
  ),
  'the direct student API view masks a provisional local subtotal'
);

reset role;

select throws_ok(
  $$
    update public.practice_test_attempts
    set answers = '[]'::jsonb
    where id = 'b12d1111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'submitted_practice_answers_immutable',
  'submitted worksheet answers cannot be rewritten'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

select lives_ok(
  $$
    select api.hold_worksheet_answer_for_review(
      'b12e1111-1111-4111-8111-111111111111',
      9223372036854775001,
      'b12f1111-1111-4111-8111-111111111111',
      'semantic_adjudication_disagreement'
    )
  $$,
  'an active leased answer job transitions atomically to private needs_review'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.practice_semantic_review_holds hold
    where hold.job_id = 'b12e1111-1111-4111-8111-111111111111'
      and hold.attempt_id = 'b12d1111-1111-4111-8111-111111111111'
      and hold.reason_code = 'semantic_adjudication_disagreement'
      and hold.ordinary_attempt_count = 3
      and hold.provider_outage_epoch = 1
      and hold.provider_outage_recovery_count = 2
  )
    and (
      select answers #>> '{1,answer}' = 'Ich helfe dem Mann.'
      from public.practice_test_attempts
      where id = 'b12d1111-1111-4111-8111-111111111111'
    ),
  'the private hold records reason-only recovery context and preserves the exact answer'
);

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = 'b12e1111-1111-4111-8111-111111111111'
      and job.status = 'dead'
      and job.last_error_code = 'semantic_adjudication_disagreement'
      and job.provider_outage_epoch = 1
      and job.provider_outage_recovery_count = 2
      and job.provider_outage_last_reason = 'dual_provider_outage_unavailable'
  ),
  'hold terminalization preserves the Phase 12J outage epoch instead of relabelling it'
);

select ok(
  exists (
    select 1
    from app_private.provider_outage_recovery_events event
    where event.job_id = 'b12e1111-1111-4111-8111-111111111111'
      and event.event_kind = 'terminated_non_outage'
      and event.reason_code = 'provider_outage_terminated_non_outage'
  ),
  'Phase 12J records that a recovered outage epoch ended for a non-outage reason'
);

select ok(
  not exists (
    select 1
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'b12d1111-1111-4111-8111-111111111111'
  )
    and not exists (
      select 1
      from app_private.worksheet_answer_completion_provenance provenance
      where provenance.job_id = 'b12e1111-1111-4111-8111-111111111111'
    ),
  'held work persists neither partial reviews nor false completion provenance'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select ok(
  exists (
    select 1
    from api.practice_test_attempts attempt
    where attempt.id = 'b12d1111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'needs_review'
      and attempt.evaluation_error = 'review_required'
      and attempt.score is null
      and attempt.max_score is null
      and attempt.score_points is null
      and attempt.max_score_points is null
      and attempt.score_percent is null
      and attempt.passed is null
  ),
  'needs_review remains score-masked and exposes only a stable student-safe status'
);

select throws_ok(
  $$ select api.get_practice_semantic_review_draft('b12c1111-1111-4111-8111-111111111111') $$,
  '42501',
  'permission_denied',
  'the student cannot read the teacher semantic review draft'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1211111-1111-4111-8111-111111111111', true);
set local role authenticated;

select ok(
  (
    api.get_practice_semantic_review_draft(
      'b12c1111-1111-4111-8111-111111111111'
    ) #>> '{questions,0,student_answer}'
  ) = 'Ich helfe dem Mann.'
    and (
      api.get_practice_semantic_review_draft(
        'b12c1111-1111-4111-8111-111111111111'
      ) #>> '{questions,0,rubric,criteria,0}'
    ) = 'Use helfen with a correct dative object.'
    and (
      api.get_practice_semantic_review_draft(
        'b12c1111-1111-4111-8111-111111111111'
      ) ->> 'current_action_revision'
    ) = '0',
  'the teacher receives the exact answer and rubric with the optimistic revision'
);

select ok(
  (
    api.list_practice_review_queue_page(
      'b1266666-6666-4666-8666-666666666666',
      'semantic_review_required', 25, null, null
    ) #>> '{items,0,action_kind}'
  ) = 'semantic_review_required'
    and api.list_practice_review_queue_page(
      'b1266666-6666-4666-8666-666666666666',
      'semantic_review_required', 25, null, null
    )::text not like '%Ich helfe dem Mann.%',
  'the teacher queue is actionable without leaking student answers in list metadata'
);

select throws_ok(
  $$
    select api.finalize_practice_semantic_review(
      'b12c1111-1111-4111-8111-111111111111',
      'b1200000-0000-4000-8000-000000000009',
      1,
      'Stale optimistic revision should fail.',
      '[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"feedback_text":"Der Satz erfüllt die Regel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."}]'::jsonb
    )
  $$,
  '40001',
  'teacher_action_revision_conflict',
  'teacher finalization rejects a stale optimistic action revision'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1255555-5555-4555-8555-555555555555', true);
set local role authenticated;

select throws_ok(
  $$
    select api.finalize_practice_semantic_review(
      'b12c1111-1111-4111-8111-111111111111',
      'b1200000-0000-4000-8000-000000000008',
      0,
      'Outsider attempt must fail.',
      '[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"feedback_text":"Der Satz erfüllt die Regel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."}]'::jsonb
    )
  $$,
  '42501',
  'permission_denied',
  'an outsider cannot finalize another workspace answer'
);

reset role;

create temporary table phase_12l_results (
  name text primary key,
  payload jsonb not null
) on commit drop;
grant select, insert on phase_12l_results to authenticated, service_role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1211111-1111-4111-8111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$
    insert into phase_12l_results (name, payload)
    select 'teacher', api.finalize_practice_semantic_review(
      'b12c1111-1111-4111-8111-111111111111',
      'b1200000-0000-4000-8000-000000000001',
      0,
      'Reviewed against the saved rubric after automatic disagreement.',
      '[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"feedback_text":"Der Satz erfüllt die Dativregel vollständig.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Helfen steht mit einem korrekten Dativobjekt."}]'::jsonb
    )
  $$,
  'the teacher can atomically finalize every flexible question'
);

reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = 'b12d1111-1111-4111-8111-111111111111'
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'completed'
      and attempt.score_points = 2
      and attempt.max_score_points = 2
      and attempt.score_percent = 100
      and attempt.passed
      and assignment.status = 'passed'
  ),
  'teacher finalization commits one coherent terminal score and assignment state'
);

select ok(
  exists (
    select 1
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'b12d1111-1111-4111-8111-111111111111'
      and review.question_id = 'b12b2222-2222-4222-8222-222222222222'
      and review.evaluator_source = 'teacher'
      and review.review_status = 'correct'
      and review.points_awarded = 1
  ),
  'teacher decisions persist with truthful human provenance'
);

select ok(
  (
    select answers #>> '{1,answer}' = 'Ich helfe dem Mann.'
    from public.practice_test_attempts
    where id = 'b12d1111-1111-4111-8111-111111111111'
  )
    and exists (
      select 1
      from app_private.practice_teacher_actions action
      where action.id = 'b1200000-0000-4000-8000-000000000001'
        and action.action_type = 'semantic_review_finalized'
        and action.action_revision = 1
        and action.attempt_id = 'b12d1111-1111-4111-8111-111111111111'
        and action.after_state ? 'request_sha256'
  ),
  'teacher finalization preserves the answer and records one immutable audit revision'
);

select ok(
  not exists (
    select 1
    from app_private.worksheet_answer_completion_provenance provenance
    where provenance.job_id = 'b12e1111-1111-4111-8111-111111111111'
  )
    and not exists (
      select 1
      from app_private.worksheet_answer_adjudication_evidence evidence
      where evidence.job_id = 'b12e1111-1111-4111-8111-111111111111'
    ),
  'human recovery never manufactures AI completion or adjudication evidence'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1211111-1111-4111-8111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$
    insert into phase_12l_results (name, payload)
    select 'teacher_replay', api.finalize_practice_semantic_review(
      'b12c1111-1111-4111-8111-111111111111',
      'b1200000-0000-4000-8000-000000000001',
      0,
      'Reviewed against the saved rubric after automatic disagreement.',
      '[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"feedback_text":"Der Satz erfüllt die Dativregel vollständig.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Helfen steht mit einem korrekten Dativobjekt."}]'::jsonb
    )
  $$,
  'an exact lost-response teacher command replay is idempotent'
);

select is(
  (select payload from phase_12l_results where name = 'teacher_replay'),
  (select payload from phase_12l_results where name = 'teacher'),
  'the exact teacher replay returns the original result without a second action'
);

select throws_ok(
  $$
    select api.finalize_practice_semantic_review(
      'b12c1111-1111-4111-8111-111111111111',
      'b1200000-0000-4000-8000-000000000001',
      0,
      'Changed replay content must be rejected.',
      '[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"feedback_text":"Der Satz erfüllt die Dativregel vollständig.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Helfen steht mit einem korrekten Dativobjekt."}]'::jsonb
    )
  $$,
  '55000',
  'teacher_command_replay_mismatch',
  'a changed payload cannot reuse a teacher command id'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select ok(
  exists (
    select 1
    from api.practice_test_attempts attempt
    where attempt.id = 'b12d1111-1111-4111-8111-111111111111'
      and attempt.score_points = 2
      and attempt.max_score_points = 2
      and attempt.score_percent = 100
      and attempt.passed
      and attempt.evaluation_error is null
  ),
  'the student sees the score only after coherent teacher finalization'
);

reset role;

-- Independent automatic agreement for a second student.
insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, completed_at, generation_status
)
values (
  'b12c2222-2222-4222-8222-222222222222',
  'b1266666-6666-4666-8666-666666666666',
  'b1233333-3333-4333-8333-333333333333',
  'b1288888-8888-4888-8888-888888888888',
  'b1299999-9999-4999-8999-999999999999',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1, 'teacher_verified',
  'manual', 'completed', 'b1211111-1111-4111-8111-111111111111',
  now(), now(), 'ready'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
)
values (
  'b12d2222-2222-4222-8222-222222222222',
  'b1299999-9999-4999-8999-999999999999',
  'b1233333-3333-4333-8333-333333333333',
  'b1266666-6666-4666-8666-666666666666',
  'b12c2222-2222-4222-8222-222222222222',
  '[{"question_id":"b12a1111-1111-4111-8111-111111111111","answer":"dem"},{"question_id":"b12b2222-2222-4222-8222-222222222222","answer":"Ich helfe dem Mann."}]'::jsonb,
  1, 1, 1, 1, 100, null, 'phase_12l_provisional',
  'evaluating', 1, now(), 'submitted', now(), now(), now()
);

update public.student_practice_assignments
set latest_attempt_id = 'b12d2222-2222-4222-8222-222222222222'
where id = 'b12c2222-2222-4222-8222-222222222222';

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at
)
values (
  'b12e2222-2222-4222-8222-222222222222',
  'worksheet_answer_evaluation', 'worksheet_answer_evaluation',
  'b12d2222-2222-4222-8222-222222222222', 1,
  'phase12l:auto:attempt-two', 'processing', 1,
  9223372036854775002, 'b12f2222-2222-4222-8222-222222222222', now(),
  now() + interval '10 minutes', now(), now()
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

select lives_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e2222-2222-4222-8222-222222222222',
      9223372036854775002,
      'b12f2222-2222-4222-8222-222222222222',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash","reviews":[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"deepseek","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."}]}'::jsonb,
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'deepseek-v4-flash',
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'agreement',
        'selected_provider_source', 'deepseek',
        'selected_question_sources', jsonb_build_array(jsonb_build_object(
          'question_id', 'b12b2222-2222-4222-8222-222222222222',
          'provider_source', 'deepseek'
        )),
        'deepseek_result_sha256', repeat('a', 64),
        'gemini_result_sha256', repeat('b', 64),
        'pro_model', null,
        'pro_result_sha256', null
      )
    )
  $$,
  'independent agreement completes atomically through the adjudication API'
);

reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = 'b12d2222-2222-4222-8222-222222222222'
      and attempt.evaluation_status = 'completed'
      and attempt.scoring_version = 'phase_12l_dual_semantic_adjudication_v1'
      and attempt.score_percent = 100
      and assignment.status = 'passed'
  )
    and exists (
      select 1
      from app_private.worksheet_answer_completion_provenance_v2 provenance
      where provenance.job_id = 'b12e2222-2222-4222-8222-222222222222'
        and provenance.provider_source = 'deepseek'
        and provenance.evaluator_model = 'deepseek-v4-flash'
    ),
  'automatic completion reaches one coherent score and preserves Phase 12I provenance'
);

select ok(
  exists (
    select 1
    from app_private.worksheet_answer_adjudication_evidence_v2 evidence
    where evidence.job_id = 'b12e2222-2222-4222-8222-222222222222'
      and evidence.attempt_id = 'b12d2222-2222-4222-8222-222222222222'
      and evidence.adjudication_mode = 'agreement'
      and evidence.selected_provider_source = 'deepseek'
      and evidence.selected_question_sources =
        '[{"question_id":"b12b2222-2222-4222-8222-222222222222","provider_source":"deepseek"}]'::jsonb
      and evidence.deepseek_model = 'deepseek-v4-flash'
      and evidence.gemini_model = 'gemini-3.1-flash-lite'
      and evidence.deepseek_result_sha256 = repeat('a', 64)
      and evidence.gemini_result_sha256 = repeat('b', 64)
      and evidence.pro_model is null
  ),
  'automatic completion records both pinned evaluator hashes without answer text'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e2222-2222-4222-8222-222222222222',
      9223372036854775002,
      'b12f2222-2222-4222-8222-222222222222',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash","reviews":[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"deepseek","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."}]}'::jsonb,
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'deepseek-v4-flash',
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'agreement',
        'selected_provider_source', 'deepseek',
        'selected_question_sources', jsonb_build_array(jsonb_build_object(
          'question_id', 'b12b2222-2222-4222-8222-222222222222',
          'provider_source', 'deepseek'
        )),
        'deepseek_result_sha256', repeat('a', 64),
        'gemini_result_sha256', repeat('b', 64),
        'pro_model', null,
        'pro_result_sha256', null
      )
    )
  $$,
  'an exact automatic completion replay is idempotent'
);

select throws_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e2222-2222-4222-8222-222222222222',
      9223372036854775002,
      'b12f2222-2222-4222-8222-222222222222',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash","reviews":[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"deepseek","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."}]}'::jsonb,
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'deepseek-v4-flash',
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'agreement',
        'selected_provider_source', 'deepseek',
        'selected_question_sources', jsonb_build_array(jsonb_build_object(
          'question_id', 'b12b2222-2222-4222-8222-222222222222',
          'provider_source', 'deepseek'
        )),
        'deepseek_result_sha256', repeat('c', 64),
        'gemini_result_sha256', repeat('b', 64),
        'pro_model', null,
        'pro_result_sha256', null
      )
    )
  $$,
  '55000',
  'semantic_adjudication_replay_mismatch',
  'changed independent evidence cannot relabel a succeeded completion'
);

reset role;

-- Deterministic blank semantic answer for a third student.
insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, completed_at, generation_status
)
values (
  'b12c3333-3333-4333-8333-333333333333',
  'b1266666-6666-4666-8666-666666666666',
  'b1244444-4444-4444-8444-444444444444',
  'b1288888-8888-4888-8888-888888888888',
  'b1299999-9999-4999-8999-999999999999',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1, 'teacher_verified',
  'manual', 'completed', 'b1211111-1111-4111-8111-111111111111',
  now(), now(), 'ready'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
)
values (
  'b12d3333-3333-4333-8333-333333333333',
  'b1299999-9999-4999-8999-999999999999',
  'b1244444-4444-4444-8444-444444444444',
  'b1266666-6666-4666-8666-666666666666',
  'b12c3333-3333-4333-8333-333333333333',
  '[{"question_id":"b12a1111-1111-4111-8111-111111111111","answer":"dem"},{"question_id":"b12b2222-2222-4222-8222-222222222222","answer":""}]'::jsonb,
  1, 1, 1, 1, 100, null, 'phase_12l_provisional',
  'evaluating', 1, now(), 'submitted', now(), now(), now()
);

update public.student_practice_assignments
set latest_attempt_id = 'b12d3333-3333-4333-8333-333333333333'
where id = 'b12c3333-3333-4333-8333-333333333333';

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at
)
values (
  'b12e3333-3333-4333-8333-333333333333',
  'worksheet_answer_evaluation', 'worksheet_answer_evaluation',
  'b12d3333-3333-4333-8333-333333333333', 1,
  'phase12l:blank:attempt-three', 'processing', 1,
  9223372036854775003, 'b12f3333-3333-4333-8333-333333333333', now(),
  now() + interval '10 minutes', now(), now()
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e3333-3333-4333-8333-333333333333',
      9223372036854775003,
      'b12f3333-3333-4333-8333-333333333333',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":null,"reviews":[{"question_id":"b12b2222-2222-4222-8222-222222222222","review_status":"incorrect","points_awarded":0,"max_points":1,"evaluator_source":"system","feedback_text":"Für diese Aufgabe wurde keine Antwort abgegeben.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Keine Antwort abgegeben."}]}'::jsonb,
      null
    )
  $$,
  'a blank semantic answer completes deterministically without a provider claim'
);

reset role;

select ok(
  exists (
    select 1
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'b12d3333-3333-4333-8333-333333333333'
      and review.evaluator_source = 'system'
      and review.review_status = 'incorrect'
      and review.points_awarded = 0
  )
    and not exists (
      select 1
      from app_private.worksheet_answer_adjudication_evidence_v2 evidence
      where evidence.job_id = 'b12e3333-3333-4333-8333-333333333333'
    )
    and exists (
      select 1
      from app_private.worksheet_answer_completion_provenance_v2 provenance
      where provenance.job_id = 'b12e3333-3333-4333-8333-333333333333'
        and provenance.provider_source is null
        and provenance.evaluator_model is null
    ),
  'blank review provenance is truthful system/local work and never fake manual or AI evidence'
);

-- A Pro adjudication may select one provider per disputed question. The
-- database must preserve that mixed truth while the legacy scorer sees only a
-- transaction-local compatibility envelope.
insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'b129aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b1266666-6666-4666-8666-666666666666',
  'b1288888-8888-4888-8888-888888888888',
  'A2', 'medium', 'Phase 12L mixed provider worksheet',
  'Two independently adjudicated flexible questions.', false, true, 'workspace',
  'b1211111-1111-4111-8111-111111111111', 'manual_import', 'approved'
);

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'b12b3333-3333-4333-8333-333333333333',
    'b129aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 'transformation', 'open_evaluation',
    'Formuliere einen Satz mit helfen.', null,
    'Ich helfe dem Mann.', '[]'::jsonb,
    '{"criteria":["Use helfen with a correct dative object."],"sample_answer":"Ich helfe dem Mann."}'::jsonb,
    1, 'Use the dative after helfen.'
  ),
  (
    'b12b4444-4444-4444-8444-444444444444',
    'b129aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    2, 'transformation', 'open_evaluation',
    'Formuliere einen Satz mit danken.', null,
    'Wir danken der Lehrerin.', '[]'::jsonb,
    '{"criteria":["Use danken with a correct dative object."],"sample_answer":"Wir danken der Lehrerin."}'::jsonb,
    1, 'Use the dative after danken.'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, completed_at, generation_status
)
values (
  'b12c5555-5555-4555-8555-555555555555',
  'b1266666-6666-4666-8666-666666666666',
  'b1262222-2222-4222-8222-222222222222',
  'b1288888-8888-4888-8888-888888888888',
  'b129aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1, 'teacher_verified',
  'manual', 'completed', 'b1211111-1111-4111-8111-111111111111',
  now(), now(), 'ready'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
)
values (
  'b12d5555-5555-4555-8555-555555555555',
  'b129aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b1262222-2222-4222-8222-222222222222',
  'b1266666-6666-4666-8666-666666666666',
  'b12c5555-5555-4555-8555-555555555555',
  '[{"question_id":"b12b3333-3333-4333-8333-333333333333","answer":"Ich helfe dem Mann."},{"question_id":"b12b4444-4444-4444-8444-444444444444","answer":"Wir danken der Lehrerin."}]'::jsonb,
  0, 0, 0, 0, 0, null, 'phase_12l_provisional',
  'evaluating', 1, now(), 'submitted', now(), now(), now()
);

update public.student_practice_assignments
set latest_attempt_id = 'b12d5555-5555-4555-8555-555555555555'
where id = 'b12c5555-5555-4555-8555-555555555555';

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at
)
values (
  'b12e5555-5555-4555-8555-555555555555',
  'worksheet_answer_evaluation', 'worksheet_answer_evaluation',
  'b12d5555-5555-4555-8555-555555555555', 1,
  'phase12l:mixed:attempt-five', 'processing', 1,
  9223372036854775005, 'b12f5555-5555-4555-8555-555555555555', now(),
  now() + interval '10 minutes', now(), now()
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$
    select * from api.complete_worksheet_answer_evaluation(
      'b12e5555-5555-4555-8555-555555555555',
      9223372036854775005,
      'b12f5555-5555-4555-8555-555555555555',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash","reviews":[]}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function complete_worksheet_answer_evaluation',
  'a stale single-provider worker cannot call the superseded completion facade'
);

select lives_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e5555-5555-4555-8555-555555555555',
      9223372036854775005,
      'b12f5555-5555-4555-8555-555555555555',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash+gemini-3.1-flash-lite","reviews":[{"question_id":"b12b3333-3333-4333-8333-333333333333","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"gemini","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."},{"question_id":"b12b4444-4444-4444-8444-444444444444","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"deepseek","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Wir danken der Lehrerin.","short_reason":"Das Dativobjekt ist korrekt."}]}'::jsonb,
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'deepseek-v4-flash',
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'pro_resolved',
        'selected_provider_source', 'mixed',
        'selected_question_sources', jsonb_build_array(
          jsonb_build_object(
            'question_id', 'b12b3333-3333-4333-8333-333333333333',
            'provider_source', 'gemini'
          ),
          jsonb_build_object(
            'question_id', 'b12b4444-4444-4444-8444-444444444444',
            'provider_source', 'deepseek'
          )
        ),
        'deepseek_result_sha256', repeat('d', 64),
        'gemini_result_sha256', repeat('e', 64),
        'pro_model', 'deepseek-v4-pro',
        'pro_result_sha256', repeat('f', 64)
      )
    )
  $$,
  'a mixed per-question Pro resolution completes atomically'
);

reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.id = 'b12d5555-5555-4555-8555-555555555555'
      and attempt.evaluation_status = 'completed'
      and attempt.evaluation_model =
        'deepseek-v4-flash+gemini-3.1-flash-lite'
      and attempt.score_points = 2
      and attempt.max_score_points = 2
      and attempt.score_percent = 100
  )
    and exists (
      select 1
      from public.practice_attempt_question_reviews review
      where review.attempt_id = 'b12d5555-5555-4555-8555-555555555555'
      group by review.attempt_id
      having count(*) filter (
        where review.question_id = 'b12b3333-3333-4333-8333-333333333333'
          and review.evaluator_source = 'gemini'
      ) = 1
        and count(*) filter (
          where review.question_id = 'b12b4444-4444-4444-8444-444444444444'
            and review.evaluator_source = 'deepseek'
        ) = 1
    )
    and exists (
      select 1
      from app_private.worksheet_answer_completion_provenance_v2 provenance
      where provenance.job_id = 'b12e5555-5555-4555-8555-555555555555'
        and provenance.provider_source = 'mixed'
        and provenance.evaluator_model =
          'deepseek-v4-flash+gemini-3.1-flash-lite'
    )
    and exists (
      select 1
      from app_private.worksheet_answer_adjudication_evidence_v2 evidence
      where evidence.job_id = 'b12e5555-5555-4555-8555-555555555555'
        and evidence.selected_provider_source = 'mixed'
        and evidence.adjudication_mode = 'pro_resolved'
        and evidence.selected_question_sources =
          '[{"question_id":"b12b3333-3333-4333-8333-333333333333","provider_source":"gemini"},{"question_id":"b12b4444-4444-4444-8444-444444444444","provider_source":"deepseek"}]'::jsonb
        and evidence.pro_result_sha256 = repeat('f', 64)
    ),
  'mixed completion preserves per-question sources, composite model, score, and immutable evidence'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select * from api.complete_worksheet_answer_adjudication(
      'b12e5555-5555-4555-8555-555555555555',
      9223372036854775005,
      'b12f5555-5555-4555-8555-555555555555',
      '{"schema_version":1,"mode":"evaluated","evaluator_model":"deepseek-v4-flash+gemini-3.1-flash-lite","reviews":[{"question_id":"b12b3333-3333-4333-8333-333333333333","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"gemini","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Ich helfe dem Mann.","short_reason":"Das Dativobjekt ist korrekt."},{"question_id":"b12b4444-4444-4444-8444-444444444444","review_status":"correct","points_awarded":1,"max_points":1,"evaluator_source":"deepseek","feedback_text":"Der Satz erfüllt die Dativregel.","corrected_answer":null,"model_answer":"Wir danken der Lehrerin.","short_reason":"Das Dativobjekt ist korrekt."}]}'::jsonb,
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'deepseek-v4-flash',
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'pro_resolved',
        'selected_provider_source', 'mixed',
        'selected_question_sources', jsonb_build_array(
          jsonb_build_object('question_id', 'b12b3333-3333-4333-8333-333333333333', 'provider_source', 'gemini'),
          jsonb_build_object('question_id', 'b12b4444-4444-4444-8444-444444444444', 'provider_source', 'deepseek')
        ),
        'deepseek_result_sha256', repeat('d', 64),
        'gemini_result_sha256', repeat('e', 64),
        'pro_model', 'deepseek-v4-pro',
        'pro_result_sha256', repeat('f', 64)
      )
    )
  $$,
  'an exact mixed completion replay is idempotent'
);

reset role;

select throws_ok(
  $$
    update app_private.practice_semantic_review_holds
    set reason_code = 'semantic_provider_output_invalid'
    where job_id = 'b12e1111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'semantic_review_audit_immutable',
  'semantic hold evidence cannot be rewritten'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'b1262222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'b12d5555-5555-4555-8555-555555555555'
  ),
  2,
  'complete terminal semantic coverage exposes every stored review row to its student'
);

reset role;

-- Reproduce the historical corruption that motivated Phase 13L: a terminal
-- mixed worksheet retained a coherent numeric score but lost one of its
-- semantic review rows. Every student-facing read surface must fail closed.
set local session_replication_role = replica;
delete from public.practice_attempt_question_reviews review
where review.attempt_id = 'b12d5555-5555-4555-8555-555555555555'
  and review.question_id = 'b12b4444-4444-4444-8444-444444444444';
set local session_replication_role = origin;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'b1262222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select is(
  public.practice_attempt_semantic_review_coverage_internal(
    'b12d5555-5555-4555-8555-555555555555'
  ),
  -1,
  'partial semantic evidence is never accepted as terminal review coverage'
);

select is(
  (
    select count(*)::integer
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'b12d5555-5555-4555-8555-555555555555'
  ),
  0,
  'incomplete historical semantic coverage exposes no stored review rows to the student'
);

select ok(
  (
    select
      summary.payload -> 'score' = 'null'::jsonb
      and summary.payload -> 'score_points' = 'null'::jsonb
      and summary.payload -> 'score_percent' = 'null'::jsonb
      and summary.payload -> 'passed' = 'null'::jsonb
    from (
      select api.get_practice_assignment_summary(
        'b12c5555-5555-4555-8555-555555555555'
      ) as payload
    ) summary
  ),
  'the student assignment summary masks a score with incomplete semantic reviews'
);

select ok(
  (
    select
      bool_and(
        review.row -> 'score' = 'null'::jsonb
        and review.row -> 'passed' = 'null'::jsonb
      )
      and count(*) filter (
        where review.row ->> 'question_id' =
            'b12b4444-4444-4444-8444-444444444444'
          and review.row ->> 'review_status' = 'submitted_for_review'
          and review.row -> 'points_awarded' = 'null'::jsonb
          and review.row -> 'feedback_text' = 'null'::jsonb
      ) = 1
    from jsonb_array_elements(api.get_practice_assignment_review(
      'b12c5555-5555-4555-8555-555555555555'
    )) review(row)
  ),
  'the detailed review exposes neither a terminal grade nor invented feedback for the missing question'
);

select ok(
  (
    select
      attempt.score is null
      and attempt.score_points is null
      and attempt.score_percent is null
      and attempt.passed is null
    from api.practice_test_attempts attempt
    where attempt.id = 'b12d5555-5555-4555-8555-555555555555'
  ),
  'the direct API view also masks the incomplete historical terminal result'
);

reset role;

select * from finish(true);
rollback;
