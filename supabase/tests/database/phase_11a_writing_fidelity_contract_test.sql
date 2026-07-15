begin;

select plan(27);

select is(
  (select count(*) from app_private.grammar_topic_contracts),
  36::bigint,
  'the closed writing-feedback topic contract contains the 36 launch slugs'
);

select is(
  app_private.canonical_grammar_topic_slug('Dative'),
  'dativ',
  'English topic aliases resolve to a canonical slug'
);

select is(
  app_private.canonical_grammar_topic_slug('Präpositionen'),
  'prepositions',
  'German topic aliases resolve to a canonical slug'
);

select is(
  app_private.canonical_grammar_topic_slug('not-a-real-topic'),
  null,
  'topics outside the closed set fail closed'
);

select is(
  app_private.writing_feedback_unit_count(
    'Ich stehe um 7.30 Uhr auf. Danach besuche ich Dr. Müller, z.B. am Dienstag.'
  ),
  2,
  'enqueue-side unit counting preserves German decimals and abbreviations'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.grammar_topic_contracts'::regclass)
    and (select relrowsecurity from pg_class where oid = 'app_private.grammar_topic_aliases'::regclass)
    and not has_table_privilege('anon', 'app_private.grammar_topic_contracts', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.grammar_topic_contracts', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.grammar_topic_contracts', 'SELECT'),
  'closed topic internals are private with RLS defense in depth'
);

select ok(
  app_private.feedback_change_spans_match(
    'ich ich gehe heute',
    'ich gehe heute',
    12,
    '[{"from":"ich ","to":"","source_start":16,"source_end":20,"corrected_start":4,"corrected_end":4}]'::jsonb
  ),
  'the span contract accepts the deterministic repeated-word deletion'
);

select ok(
  not app_private.feedback_change_spans_match(
    'ich ich gehe heute',
    'ich gehe heute',
    12,
    '[{"from":"ich ","to":"","source_start":12,"source_end":16,"corrected_start":4,"corrected_end":4}]'::jsonb
  ),
  'the span contract rejects a repeated word pointing at the wrong occurrence'
);

select ok(
  not app_private.feedback_change_spans_match(
    'Ich gehe Schule.',
    'Ich gehe zur Schule.',
    0,
    '[]'::jsonb
  ),
  'the span contract rejects an unexplained rewrite outside all spans'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'submission_lines'
      and column_name = 'source_start'
      and data_type = 'integer'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'submission_lines'
      and column_name = 'source_end'
      and data_type = 'integer'
  ),
  'materialized feedback lines store absolute Unicode source offsets'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.submission_lines'::regclass
      and conname = 'submission_lines_source_offsets_check'
  ),
  'submission line source offsets have a database check constraint'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'app_private.feedback_drafts'::regclass
      and tgname = 'feedback_drafts_validate_content'
      and not tgisinternal
  ),
  'private feedback drafts are validated before persistence'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.submission_lines'::regclass
      and tgname = 'submission_lines_validate_fidelity'
      and not tgisinternal
  ),
  'released feedback rows are independently validated before persistence'
);

select ok(
  'security_invoker=true' = any(
    coalesce((select reloptions from pg_class where oid = 'api.submission_lines'::regclass), array[]::text[])
  )
    and 'security_barrier=true' = any(
      coalesce((select reloptions from pg_class where oid = 'api.submission_lines'::regclass), array[]::text[])
    ),
  'the feedback-line API view is a security-invoker security barrier'
);

select ok(
  position(
    'release_status = ''released''' in pg_get_viewdef('api.submission_lines'::regclass, true)
  ) > 0,
  'the feedback-line API view requires release for non-teacher reads'
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
    'a1111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11a-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11A Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11A Student"}'::jsonb,
    now(),
    now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values (
  'a1111111-1111-4111-8111-111111111111',
  true,
  1,
  'Phase 11A rollback-only teacher entitlement.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'a3333333-3333-4333-8333-333333333333',
  'Phase 11A Workspace',
  'phase-11a-workspace',
  'a1111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'a1111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a3333333-3333-4333-8333-333333333333',
  'a1111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a3333333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

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
values (
  'a6666666-6666-4666-8666-666666666666',
  'a3333333-3333-4333-8333-333333333333',
  'Phase 11A Immediate',
  'A2',
  'a1111111-1111-4111-8111-111111111111',
  true,
  true,
  true,
  'immediate',
  0,
  0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'a3333333-3333-4333-8333-333333333333',
  'a6666666-6666-4666-8666-666666666666',
  'a2222222-2222-4222-8222-222222222222'
);

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  mode,
  original_text,
  status,
  evaluation_status,
  release_status
)
values (
  'a4444444-4444-4444-8444-444444444444',
  'a3333333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222',
  'free_text',
  '🙂 Ich helfe meinen Bruder.  Danach lerne ich.',
  'submitted',
  'processing',
  'held'
);

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  provider_model,
  content
)
values (
  'a5555555-5555-4555-8555-555555555555',
  'a4444444-4444-4444-8444-444444444444',
  1,
  'draft',
  'test-model',
  jsonb_build_object(
    'overall_summary', 'One case correction.',
    'level_detected', 'A2',
    'corrected_text', '🙂 Ich helfe meinem Bruder.  Danach lerne ich.',
    'ai_model', 'test-model',
    'score_summary', jsonb_build_object(
      'correct_lines', 99,
      'acceptable_lines', 99,
      'minor_issues', 99,
      'major_issues', 99,
      'needs_review', 99
    ),
    'grammar_topics', jsonb_build_array(
      jsonb_build_object('topic', 'Dative', 'count', 99, 'severity', 'major')
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
        'grammar_topic', 'Dative'
      ),
      jsonb_build_object(
        'line_number', 2,
        'source_start', 28,
        'source_end', 45,
        'original_line', 'Danach lerne ich.',
        'corrected_line', 'Danach lerne ich.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )
    )
  )
);

select is(
  (
    select content -> 'lines' -> 0 ->> 'grammar_topic'
    from app_private.feedback_drafts
    where id = 'a5555555-5555-4555-8555-555555555555'
  ),
  'dativ',
  'draft persistence canonicalizes a topic alias'
);

select is(
  (
    select content -> 'score_summary'
    from app_private.feedback_drafts
    where id = 'a5555555-5555-4555-8555-555555555555'
  ),
  '{"correct_lines":1,"acceptable_lines":0,"minor_issues":1,"major_issues":0,"needs_review":0}'::jsonb,
  'draft persistence derives score counts from validated line states'
);

select is(
  (
    select content -> 'grammar_topics'
    from app_private.feedback_drafts
    where id = 'a5555555-5555-4555-8555-555555555555'
  ),
  '[{"topic":"dativ","count":1,"severity":"minor","simple_explanation":"Use the dative case."}]'::jsonb,
  'draft persistence deduplicates and derives topic counts and severity'
);

insert into public.submission_lines (
  submission_id,
  line_number,
  original_line,
  corrected_line,
  status,
  changed_parts,
  short_explanation,
  grammar_topic_id
)
values
  (
    'a4444444-4444-4444-8444-444444444444',
    1,
    '🙂 Ich helfe meinen Bruder.',
    '🙂 Ich helfe meinem Bruder.',
    'minor_issue',
    '[{"from":"meinen","to":"meinem","reason":"Use dative.","source_start":12,"source_end":18,"corrected_start":12,"corrected_end":18}]'::jsonb,
    'Use the dative case.',
    (select id from public.grammar_topics where slug = 'dativ' and level = 'A1_A2')
  ),
  (
    'a4444444-4444-4444-8444-444444444444',
    2,
    'Danach lerne ich.',
    'Danach lerne ich.',
    'correct',
    '[]'::jsonb,
    null,
    null
  );

select is(
  (
    select array_agg(array[source_start, source_end] order by line_number)
    from public.submission_lines
    where submission_id = 'a4444444-4444-4444-8444-444444444444'
  ),
  array[array[0, 26], array[28, 45]],
  'materialization fills exact Unicode offsets from the validated private draft'
);

select throws_ok(
  $$
    update public.submission_lines
    set corrected_line = 'Danach lerne ich gut.'
    where submission_id = 'a4444444-4444-4444-8444-444444444444'
      and line_number = 2
  $$,
  '22023',
  'Positive feedback cannot rewrite or assign a weakness.',
  'a positive materialized line cannot carry a rewrite'
);

select throws_ok(
  $$
    update app_private.feedback_drafts
    set content = jsonb_set(content, '{lines}', content -> 'lines' -> 0, true)
    where id = 'a5555555-5555-4555-8555-555555555555'
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'draft validation rejects a non-array line replacement'
);

select set_config('request.jwt.claim.sub', 'a1111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  jsonb_array_length(coalesce(
    api.get_submission_detail(
      'a4444444-4444-4444-8444-444444444444'
    ) #> '{feedback,lines}',
    '[]'::jsonb
  )),
  2,
  'the teacher can inspect held feedback for review'
);

reset role;
select set_config('request.jwt.claim.sub', 'a2222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  jsonb_array_length(coalesce(
    api.get_submission_detail(
      'a4444444-4444-4444-8444-444444444444'
    ) #> '{feedback,lines}',
    '[]'::jsonb
  )),
  0,
  'the student cannot read held feedback lines'
);

reset role;
update public.submissions
set release_status = 'released',
    evaluation_status = 'ready',
    status = 'checked'
where id = 'a4444444-4444-4444-8444-444444444444';

select set_config('request.jwt.claim.sub', 'a2222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  jsonb_array_length(coalesce(
    api.get_submission_detail(
      'a4444444-4444-4444-8444-444444444444'
    ) #> '{feedback,lines}',
    '[]'::jsonb
  )),
  2,
  'the student can read all feedback lines only after atomic release'
);

reset role;

create temporary table phase_11a_exact_submission as
select submission_id
from api.submit_writing(
  'a6666666-6666-4666-8666-666666666666',
  'free_text',
  null,
  E'  Original spacing.\r\n\r\nTrailing spacing.  '
);

select is(
  (
    select submission.original_text
    from public.submissions submission
    where submission.id = (
      select submission_id from phase_11a_exact_submission
    )
  ),
  E'  Original spacing.\r\n\r\nTrailing spacing.  ',
  'submit_writing stores leading, trailing, and paragraph whitespace byte-for-byte'
);

create temporary table phase_11a_job_before_reconcile as
select
  job.id as job_id,
  job.queue_message_id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = (
    select submission_id from phase_11a_exact_submission
  );

delete from pgmq.q_writing_evaluation queue
where queue.msg_id = (
  select queue_message_id from phase_11a_job_before_reconcile
);

create temporary table phase_11a_job_after_reconcile as
select reconciled.*
from app_private.reconcile_async_job(
  (select job_id from phase_11a_job_before_reconcile)
) reconciled;

select ok(
  (
    select
      reconciled.status = 'retry'
      and reconciled.queue_message_id is not null
      and reconciled.queue_message_id <> before_reconcile.queue_message_id
      and app_private.queue_message_exists(
        reconciled.queue_name,
        reconciled.queue_message_id
      )
    from phase_11a_job_after_reconcile reconciled
    cross join phase_11a_job_before_reconcile before_reconcile
  ),
  'a missing writing queue message is transactionally replaced with a live retry message'
);

select throws_ok(
  format(
    $sql$
      select *
      from api.submit_writing(
        'a6666666-6666-4666-8666-666666666666',
        'free_text',
        null,
        %L
      )
    $sql$,
    (
      select string_agg(
        format('Heute lerne ich Wort Nummer %s gut.', sentence_number),
        ' '
        order by sentence_number
      )
      from generate_series(1, 41) as generated(sentence_number)
    )
  ),
  '22023',
  'writing_too_many_units',
  'a 41-unit writing is rejected before a durable job can be enqueued'
);

select * from finish();
rollback;
