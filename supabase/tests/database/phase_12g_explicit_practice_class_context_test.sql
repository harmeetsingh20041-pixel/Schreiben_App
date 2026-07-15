begin;

select plan(24);

select ok(
  to_regprocedure('api.get_worksheet_generation_context(uuid)') is not null
    and to_regprocedure('api.list_practice_class_context_options(uuid)') is not null
    and to_regprocedure(
      'api.resolve_practice_assignment_class_context(uuid,uuid)'
    ) is not null,
  'the worker snapshot and teacher recovery APIs exist'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and routine.proname in (
        'get_worksheet_generation_context',
        'list_practice_class_context_options',
        'resolve_practice_assignment_class_context'
      )
      and routine.prosecdef
  ),
  'all exposed class-context APIs are security invoker'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.get_worksheet_generation_context(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.get_worksheet_generation_context(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.resolve_practice_assignment_class_context(uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.resolve_practice_assignment_class_context(uuid,uuid)',
      'EXECUTE'
    ),
  'worker and teacher entry points have separate least-privilege grants'
);

select ok(
  exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'student_practice_assignments'
      and column_info.column_name = 'batch_id'
  )
    and exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'student_practice_assignments'
        and column_info.column_name = 'worksheet_level'
    )
    and exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'app_private'
        and column_info.table_name = 'practice_resolution_cycles'
        and column_info.column_name = 'batch_id'
    )
    and (
      select lower(pg_get_constraintdef(constraint_info.oid))
        like '%worksheet_level is not null%'
      from pg_constraint constraint_info
      where constraint_info.conrelid =
        'public.student_practice_assignments'::regclass
        and constraint_info.conname =
          'student_practice_assignments_class_context_check'
    )
    and (
      select lower(pg_get_constraintdef(constraint_info.oid))
        like '%worksheet_level is not null%'
      from pg_constraint constraint_info
      where constraint_info.conrelid =
        'app_private.practice_resolution_cycles'::regclass
        and constraint_info.conname =
          'practice_resolution_cycles_class_context_check'
    )
    and (
      select lower(pg_get_constraintdef(constraint_info.oid))
        like '%evidence_level is not null%'
      from pg_constraint constraint_info
      where constraint_info.conrelid =
        'app_private.practice_weakness_evidence'::regclass
        and constraint_info.conname =
          'practice_weakness_evidence_class_context_check'
    ),
  'class context columns and non-null version-one constraints are explicit'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1211111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12g-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12G Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12g-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12G Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1233333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12g-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12G Outsider"}'::jsonb,
    now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'a1244444-4444-4444-8444-444444444444',
  'Phase 12G Workspace',
  'phase-12g-class-context',
  'a1211111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a1211111-1111-4111-8111-111111111111', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1244444-4444-4444-8444-444444444444',
  'a1211111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1244444-4444-4444-8444-444444444444',
  'a1222222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values
  (
    'a1251111-1111-4111-8111-111111111111',
    'a1244444-4444-4444-8444-444444444444',
    'Phase 12G A1 Class',
    'A1', true,
    'a1211111-1111-4111-8111-111111111111'
  ),
  (
    'a1252222-2222-4222-8222-222222222222',
    'a1244444-4444-4444-8444-444444444444',
    'Phase 12G B2 Class',
    'B2', true,
    'a1211111-1111-4111-8111-111111111111'
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'a1244444-4444-4444-8444-444444444444',
    'a1251111-1111-4111-8111-111111111111',
    'a1222222-2222-4222-8222-222222222222'
  ),
  (
    'a1244444-4444-4444-8444-444444444444',
    'a1252222-2222-4222-8222-222222222222',
    'a1222222-2222-4222-8222-222222222222'
  );

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    'a1261111-1111-4111-8111-111111111111',
    'phase-12g-shared-word-order',
    'Phase 12G Shared Word Order',
    'A1_A2',
    'A shared topic whose level must come from released class evidence.'
  ),
  (
    'a1262222-2222-4222-8222-222222222222',
    'phase-12g-legacy-context',
    'Phase 12G Legacy Context',
    'A1_A2',
    'A legacy assignment fixture for explicit teacher recovery.'
  ),
  (
    'a1263333-3333-4333-8333-333333333333',
    'phase-12g-historical-result',
    'Phase 12G Historical Result',
    'A1_A2',
    'A used historical worksheet whose result must never be mutated by recovery.'
  );

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values
  (
    'a1271111-1111-4111-8111-111111111111',
    'a1244444-4444-4444-8444-444444444444',
    'a1261111-1111-4111-8111-111111111111',
    'A1', 'easy', 'Phase 12G A1 Worksheet', 'A1 class snapshot fixture.',
    false, true, 'workspace', 'a1211111-1111-4111-8111-111111111111',
    'manual_import', 'approved'
  ),
  (
    'a1272222-2222-4222-8222-222222222222',
    'a1244444-4444-4444-8444-444444444444',
    'a1261111-1111-4111-8111-111111111111',
    'B2', 'medium', 'Phase 12G B2 Worksheet', 'B2 class snapshot fixture.',
    false, true, 'workspace', 'a1211111-1111-4111-8111-111111111111',
    'manual_import', 'approved'
  ),
  (
    'a1273333-3333-4333-8333-333333333333',
    'a1244444-4444-4444-8444-444444444444',
    'a1263333-3333-4333-8333-333333333333',
    'B2', 'medium', 'Phase 12G Historical Worksheet',
    'A historical result visibility fixture.',
    false, true, 'workspace', 'a1211111-1111-4111-8111-111111111111',
    'manual_import', 'approved'
  );

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'a1281111-1111-4111-8111-111111111111',
    'a1271111-1111-4111-8111-111111111111',
    1, 'multiple_choice', 'local_exact',
    'Welche Satzstellung ist für die A1-Aufgabe richtig?',
    '["Heute lerne ich Deutsch.","Heute ich lerne Deutsch."]'::jsonb,
    'Heute lerne ich Deutsch.',
    '["Heute lerne ich Deutsch."]'::jsonb,
    null, 1, 'The finite verb is in position two.'
  ),
  (
    'a1282222-2222-4222-8222-222222222222',
    'a1272222-2222-4222-8222-222222222222',
    1, 'multiple_choice', 'local_exact',
    'Welche Satzstellung ist für die B2-Aufgabe stilistisch korrekt?',
    '["Obwohl es regnete, gingen wir hinaus.","Obwohl es regnete, wir gingen hinaus."]'::jsonb,
    'Obwohl es regnete, gingen wir hinaus.',
    '["Obwohl es regnete, gingen wir hinaus."]'::jsonb,
    null, 1, 'The subordinate clause is followed by the finite verb.'
  ),
  (
    'a1283333-3333-4333-8333-333333333333',
    'a1273333-3333-4333-8333-333333333333',
    1, 'multiple_choice', 'local_exact',
    'Welche historische Antwort ist richtig?',
    '["Richtig","Falsch","Unklar"]'::jsonb,
    'Richtig',
    '["Richtig"]'::jsonb,
    null, 1, 'The stored historical answer contract remains unchanged.'
  );

insert into public.submissions (
  id, workspace_id, student_id, batch_id, question_source, mode, original_text,
  corrected_text, overall_summary, level_detected, status, feedback_mode,
  evaluation_status, release_status, checked_at
)
values
  (
    'a1291111-1111-4111-8111-111111111111',
    'a1244444-4444-4444-8444-444444444444',
    'a1222222-2222-4222-8222-222222222222',
    'a1251111-1111-4111-8111-111111111111',
    'free_text',
    'free_text',
    'Heute ich lerne Deutsch, weil ich die Wortstellung üben möchte.',
    'Heute lerne ich Deutsch, weil ich die Wortstellung üben möchte.',
    'Released A1 evidence.', 'A1', 'checked', 'immediate', 'ready', 'released', now()
  ),
  (
    'a1292222-2222-4222-8222-222222222222',
    'a1244444-4444-4444-8444-444444444444',
    'a1222222-2222-4222-8222-222222222222',
    'a1252222-2222-4222-8222-222222222222',
    'free_text',
    'free_text',
    'Obwohl es regnete, wir gingen hinaus und diskutierten den Plan.',
    'Obwohl es regnete, gingen wir hinaus und diskutierten den Plan.',
    'Released B2 evidence.', 'B2', 'checked', 'immediate', 'ready', 'released', now()
  );

-- Phase 12K requires released-writing evidence to carry the immutable class
-- snapshot captured at submission time. Build that exact contract here so the
-- Phase 12G level-selection assertions exercise current production behavior.
with source_context as (
  select
    submission.*,
    batch.level as cefr_level,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(submission.original_text, 'UTF8')
      ),
      'hex'
    ) as original_text_sha256
  from public.submissions submission
  join public.batches batch
    on batch.id = submission.batch_id
   and batch.workspace_id = submission.workspace_id
  where submission.id in (
    'a1291111-1111-4111-8111-111111111111',
    'a1292222-2222-4222-8222-222222222222'
  )
)
insert into app_private.writing_evaluation_contexts (
  submission_id,
  context_version,
  workspace_id,
  student_id,
  batch_id,
  cefr_level,
  source_type,
  source_id,
  submission_mode,
  question_metadata,
  original_text_sha256,
  context_sha256
)
select
  context.id,
  1,
  context.workspace_id,
  context.student_id,
  context.batch_id,
  context.cefr_level,
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.id,
    1::smallint,
    context.workspace_id,
    context.student_id,
    context.batch_id,
    context.cefr_level,
    'free_text',
    null,
    'free_text',
    '{}'::jsonb,
    context.original_text_sha256
  )
from source_context context;

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  content,
  provider_model,
  approved_at,
  approved_by,
  released_at,
  released_by
)
select
  submission.id,
  submission.id,
  1,
  'released',
  jsonb_build_object(
    'overall_summary', 'Released class-context fixture feedback.',
    'level_detected', batch.level,
    'corrected_text', submission.original_text,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', char_length(submission.original_text),
      'original_line', submission.original_text,
      'corrected_line', submission.original_text,
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb,
    'score_summary', '{}'::jsonb
  ),
  'phase_12g_fixture',
  now(),
  'a1211111-1111-4111-8111-111111111111',
  now(),
  'a1211111-1111-4111-8111-111111111111'
from public.submissions submission
join public.batches batch
  on batch.id = submission.batch_id
 and batch.workspace_id = submission.workspace_id
where submission.id in (
  'a1291111-1111-4111-8111-111111111111',
  'a1292222-2222-4222-8222-222222222222'
);

create temporary table phase_12g_state (
  first_assignment_id uuid,
  second_assignment_id uuid,
  legacy_assignment_id uuid,
  historical_assignment_id uuid
) on commit drop;
insert into phase_12g_state default values;
grant select, update on phase_12g_state to authenticated, service_role;

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'a1291111-1111-4111-8111-111111111111',
  'a1291111-1111-4111-8111-111111111111',
  'a1291111-1111-4111-8111-111111111111',
  'a1244444-4444-4444-8444-444444444444',
  'a1222222-2222-4222-8222-222222222222',
  'a1261111-1111-4111-8111-111111111111',
  0, 1, now()
);

update phase_12g_state state
set first_assignment_id = assignment.id
from public.student_practice_assignments assignment
where assignment.workspace_id = 'a1244444-4444-4444-8444-444444444444'
  and assignment.student_id = 'a1222222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'a1261111-1111-4111-8111-111111111111'
  and assignment.status = 'unlocked';

select ok(
  (
    select assignment.batch_id = 'a1251111-1111-4111-8111-111111111111'
      and assignment.worksheet_level = 'A1'
      and assignment.class_context_version = 1
      and assignment.practice_test_id = 'a1271111-1111-4111-8111-111111111111'
    from public.student_practice_assignments assignment
    where assignment.id = (select first_assignment_id from phase_12g_state)
  ),
  'the first shared-topic cycle freezes its A1 writing class and worksheet level'
);

-- Mirror the PostgREST request contract used by the Edge worker. A Supabase
-- secret key selects the service_role database role and supplies the matching
-- request claim; SET ROLE alone is not a complete service request simulation.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select context.worksheet_level
    from api.get_worksheet_generation_context(
      (select first_assignment_id from phase_12g_state)
    ) context
  ),
  'A1'::text,
  'the worker receives A1 despite the student also belonging to a B2 class'
);

select is(
  (
    select context.batch_id
    from api.get_worksheet_generation_context(
      (select first_assignment_id from phase_12g_state)
    ) context
  ),
  'a1251111-1111-4111-8111-111111111111'::uuid,
  'the worker receives the exact frozen A1 class id'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.role', '', true);

select is(
  app_private.select_practice_test_for_cycle(
    'a1244444-4444-4444-8444-444444444444',
    'a1222222-2222-4222-8222-222222222222',
    'a1261111-1111-4111-8111-111111111111'
  ),
  null::uuid,
  'the frozen-level selector never reuses a worksheet already disclosed to this student'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'a12a1111-1111-4111-8111-111111111111',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  1, 1, 1, 1, 100, true,
  'phase_12g_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (select first_assignment_id from phase_12g_state);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'a12a1111-1111-4111-8111-111111111111',
  status = 'passed',
  completed_at = now()
where assignment.id = (select first_assignment_id from phase_12g_state);

select ok(
  exists (
    select 1
    from phase_12g_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.first_assignment_id
    join app_private.practice_assignment_cycle_transition_jobs transition_job
      on transition_job.assignment_id = assignment.id
     and transition_job.status_revision = assignment.status_revision
    where transition_job.previous_status = 'unlocked'
      and transition_job.target_status = 'passed'
      and transition_job.processed_at is null
      and transition_job.failure_count = 0
  ),
  'passing the A1 worksheet durably records its unresolved cycle transition'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'a1292222-2222-4222-8222-222222222222',
  'a1292222-2222-4222-8222-222222222222',
  'a1292222-2222-4222-8222-222222222222',
  'a1244444-4444-4444-8444-444444444444',
  'a1222222-2222-4222-8222-222222222222',
  'a1261111-1111-4111-8111-111111111111',
  0, 1, now()
);

-- A later writing release may race ahead of the recovery worker. The evidence
-- is durable, but it cannot open a second topic cycle until the earlier pass is
-- applied. Recovery resolves A1 and then reconciles the already-stored B2
-- evidence in the canonical advisory -> cycle -> assignment lock order.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select set_config(
  'phase_12g.transition_result',
  api.process_practice_cycle_transition_jobs(10)::text,
  true
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.role', '', true);

select ok(
  (current_setting('phase_12g.transition_result')::jsonb ->> 'succeeded')::integer = 1
    and (current_setting('phase_12g.transition_result')::jsonb ->> 'failed')::integer = 0
    and not exists (
      select 1
      from phase_12g_state state
      join app_private.practice_assignment_cycle_transition_jobs transition_job
        on transition_job.assignment_id = state.first_assignment_id
      where transition_job.processed_at is null
    ),
  'service recovery resolves A1 and reconciles the pending B2 recurrence once'
);

update phase_12g_state state
set second_assignment_id = assignment.id
from public.student_practice_assignments assignment
where assignment.workspace_id = 'a1244444-4444-4444-8444-444444444444'
  and assignment.student_id = 'a1222222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'a1261111-1111-4111-8111-111111111111'
  and assignment.status = 'unlocked';

select ok(
  (
    select assignment.batch_id = 'a1252222-2222-4222-8222-222222222222'
      and assignment.worksheet_level = 'B2'
      and assignment.class_context_version = 1
      and assignment.practice_test_id = 'a1272222-2222-4222-8222-222222222222'
    from public.student_practice_assignments assignment
    where assignment.id = (select second_assignment_id from phase_12g_state)
  ),
  'later B2 evidence opens a new cycle with a B2 snapshot instead of mutating A1'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'a1244444-4444-4444-8444-444444444444'
      and assignment.student_id = 'a1222222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'a1261111-1111-4111-8111-111111111111'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1,
  'the A1-to-B2 recurrence still has exactly one active worksheet'
);

select throws_ok(
  format(
    'update public.student_practice_assignments set worksheet_level = %L where id = %L',
    'A2',
    (select second_assignment_id from phase_12g_state)
  ),
  '55000',
  'Practice assignment class context is immutable.',
  'an assignment snapshot cannot be changed after creation'
);

with inserted as (
  insert into public.student_practice_assignments (
    workspace_id, student_id, grammar_topic_id, practice_test_id,
    source, status, generation_status, class_context_version,
    completed_at
  ) values (
    'a1244444-4444-4444-8444-444444444444',
    'a1222222-2222-4222-8222-222222222222',
    'a1263333-3333-4333-8333-333333333333',
    'a1273333-3333-4333-8333-333333333333',
    'manual', 'completed', 'ready', 0, now()
  ) returning id
)
update phase_12g_state state
set historical_assignment_id = inserted.id
from inserted;

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, evaluation_completed_at, status,
  started_at, submitted_at, completed_at
)
select
  'a12a3333-3333-4333-8333-333333333333',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  1, 1, 1, 1,
  100, true, 'phase_12g_incoherent_fixture', 'not_needed',
  0, now(), 'checked', now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (select historical_assignment_id from phase_12g_state);

update public.student_practice_assignments assignment
set latest_attempt_id = 'a12a3333-3333-4333-8333-333333333333'
where assignment.id = (select historical_assignment_id from phase_12g_state);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a1222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  (
    api.get_practice_assignment_summary(
      (select historical_assignment_id from phase_12g_state)
    ) ->> 'score_percent'
  ) is null
    and (
      api.get_practice_assignment_summary(
        (select historical_assignment_id from phase_12g_state)
      ) ->> 'passed'
    ) is null,
  'Phase 12F still masks an incoherent provisional result after Phase 12G'
);

reset role;

with inserted as (
  insert into public.student_practice_assignments (
    workspace_id, student_id, grammar_topic_id, source, status,
    generation_status, generation_error, class_context_version
  ) values (
    'a1244444-4444-4444-8444-444444444444',
    'a1222222-2222-4222-8222-222222222222',
    'a1262222-2222-4222-8222-222222222222',
    'manual', 'unlocked', 'failed', 'worksheet_class_context_required', 0
  ) returning id
)
update phase_12g_state state
set legacy_assignment_id = inserted.id
from inserted;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1211111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a1211111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    api.get_practice_assignment_summary(
      (select historical_assignment_id from phase_12g_state)
    ) ->> 'score_percent'
  )::numeric,
  100::numeric,
  'a teacher can still inspect the persisted historical provisional score'
);

select throws_ok(
  format(
    'select api.resolve_practice_assignment_class_context(%L::uuid,%L::uuid)',
    (select historical_assignment_id from phase_12g_state),
    'a1252222-2222-4222-8222-222222222222'
  ),
  '55000',
  'practice_assignment_inactive',
  'class recovery cannot mutate a completed or already used worksheet'
);

select ok(
  (
    select assignment.status = 'completed'
      and assignment.practice_test_id = 'a1273333-3333-4333-8333-333333333333'
      and assignment.latest_attempt_id = 'a12a3333-3333-4333-8333-333333333333'
      and assignment.generation_status = 'ready'
      and assignment.generation_error is null
      and assignment.class_context_version = 0
    from public.student_practice_assignments assignment
    where assignment.id = (select historical_assignment_id from phase_12g_state)
  ),
  'completed or used historical assignments retain their worksheet result and are never converted into generation failures'
);

select is(
  jsonb_array_length(
    api.list_practice_class_context_options(
      (select legacy_assignment_id from phase_12g_state)
    ) -> 'items'
  ),
  2,
  'the teacher sees only the student current active class choices'
);

select throws_ok(
  format(
    'select * from api.request_practice_worksheet(%L::uuid)',
    (select legacy_assignment_id from phase_12g_state)
  ),
  '55000',
  'Practice assignment class context is required.',
  'a missing snapshot is rejected before any generation job is queued'
);

select is(
  (
    api.resolve_practice_assignment_class_context(
      (select legacy_assignment_id from phase_12g_state),
      'a1252222-2222-4222-8222-222222222222'
    ) ->> 'worksheet_level'
  ),
  'B2'::text,
  'the teacher can recover an ambiguous historical assignment explicitly'
);

select ok(
  (
    api.get_practice_assignment_summary(
      (select legacy_assignment_id from phase_12g_state)
    ) ->> 'batch_name'
  ) = 'Phase 12G B2 Class'
    and (
      api.get_practice_assignment_summary(
        (select legacy_assignment_id from phase_12g_state)
      ) ->> 'worksheet_level'
    ) = 'B2',
  'teacher and student read models carry the frozen class name and level'
);

select throws_ok(
  format(
    'select api.resolve_practice_assignment_class_context(%L::uuid,%L::uuid)',
    (select legacy_assignment_id from phase_12g_state),
    'a1251111-1111-4111-8111-111111111111'
  ),
  '55000',
  'practice_class_context_immutable',
  'the recovery command cannot switch a resolved assignment to another class'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1233333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a1233333-3333-4333-8333-333333333333', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  format(
    'select api.list_practice_class_context_options(%L::uuid)',
    (select legacy_assignment_id from phase_12g_state)
  ),
  'P0002',
  'practice_assignment_not_found',
  'an unrelated authenticated user cannot enumerate or probe class options'
);

reset role;

select ok(
  (
    select position('selected_assignment.worksheet_level' in routine.prosrc) > 0
      and position('count(distinct b.level)' in routine.prosrc) = 0
    from pg_proc routine
    where routine.oid =
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
  ),
  'transactional completion consumes the assignment snapshot and never active class levels'
);

select * from finish(true);
rollback;
