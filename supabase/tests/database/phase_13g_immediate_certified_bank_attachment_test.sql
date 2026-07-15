begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

create or replace function pg_temp.phase_13g_worksheet_payload()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', 'A2 Direct Certified Bank Practice',
    'description', 'A deterministic transaction-only direct bank fixture.',
    'level', 'A2',
    'grammar_topic', jsonb_build_object(
      'slug', 'phase-direct-bank',
      'name', 'Phase Direct Bank'
    ),
    'difficulty', 'easy',
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13G pgTAP fixture',
    'tags', jsonb_build_array('A2', 'direct-bank'),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'A fixed phrase keeps its required preposition.',
      'key_rule', 'Learn the verb and its preposition together.',
      'correct_examples', jsonb_build_array(
        'Ich warte auf den Bus.',
        'Wir fahren mit dem Zug.'
      ),
      'common_mistake_warning', 'Do not translate fixed phrases word for word.',
      'what_to_revise', 'Review common verb-preposition pairs.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'prompt', 'Wähle die richtige Form: Ich warte ___ den Bus.',
        'options', jsonb_build_array('auf', 'mit', 'bei'),
        'correct_answer', 'auf',
        'accepted_answers', jsonb_build_array('auf'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The fixed phrase is auf den Bus warten.',
        'evaluation_mode', 'local_exact'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'fill_blank',
        'prompt', 'Nutze die Wortbank [mit, bei, für]: Wir fahren ___ dem Zug.',
        'options', jsonb_build_array(),
        'correct_answer', 'mit',
        'accepted_answers', jsonb_build_array('mit'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'Use mit for this means of transport.',
        'evaluation_mode', 'local_exact'
      )
    )
  );
$$;

select ok(
  to_regclass('app_private.worksheet_bank_direct_attachment_events') is not null
    and to_regprocedure('api.request_practice_worksheet(uuid)') is not null
    and has_function_privilege(
      'authenticated',
      'api.request_practice_worksheet(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.request_practice_worksheet(uuid)',
      'EXECUTE'
    ),
  'the immediate certified-bank facade exists only for authenticated callers'
);

select ok(
  (
    select table_row.relrowsecurity
    from pg_class table_row
    where table_row.oid =
      'app_private.worksheet_bank_direct_attachment_events'::regclass
  )
    and not has_table_privilege(
      'anon',
      'app_private.worksheet_bank_direct_attachment_events',
      'SELECT'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_bank_direct_attachment_events',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.worksheet_bank_direct_attachment_events',
      'SELECT'
    ),
  'browser and service roles cannot read the private direct-attachment audit'
);

select ok(
  (
    select position(
      'request_practice_worksheet_before_model_cache'
      in pg_get_functiondef(entrypoint.oid)
    ) > 0
      and (
        select position(
          'into selected_job'
          in pg_get_functiondef(request_boundary.oid)
        ) > 0
          and position(
            'into selected_job'
            in pg_get_functiondef(request_boundary.oid)
          ) < position(
            'into selected_assignment'
            in pg_get_functiondef(request_boundary.oid)
          )
        from pg_proc request_boundary
        where request_boundary.oid =
          'public.request_practice_worksheet_before_model_cache(uuid)'::regprocedure
      )
    from pg_proc entrypoint
    where entrypoint.oid =
      'public.request_practice_worksheet(uuid)'::regprocedure
  ),
  'the request boundary locks an async job before its assignment, matching worker completion order'
);

select ok(
  (
    select position(
      'concat(''worksheet-bank:'', target_template_key)'
      in pg_get_functiondef(procedure.oid)
    ) > 0
      and position(
        'concat(''worksheet-bank:'', target_template_key, '':'', expected_content_hash)'
        in pg_get_functiondef(procedure.oid)
      ) = 0
    from pg_proc procedure
    where procedure.oid =
      'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)'::regprocedure
  ),
  'first publication serializes every content revision by template key before idempotency checks'
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
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13g-teacher-certifier')::uuid,
    'authenticated',
    'authenticated',
    'phase-13g-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13G Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13g-releaser')::uuid,
    'authenticated',
    'authenticated',
    'phase-13g-releaser@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13G Releaser"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13g-student')::uuid,
    'authenticated',
    'authenticated',
    'phase-13g-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13G Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13g-outsider')::uuid,
    'authenticated',
    'authenticated',
    'phase-13g-outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13G Outsider"}'::jsonb,
    now(),
    now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    md5('phase-13g-teacher-certifier')::uuid,
    'Phase 13G Teacher',
    'phase-13g-teacher@example.test',
    'student'
  ),
  (
    md5('phase-13g-releaser')::uuid,
    'Phase 13G Releaser',
    'phase-13g-releaser@example.test',
    'student'
  ),
  (
    md5('phase-13g-student')::uuid,
    'Phase 13G Student',
    'phase-13g-student@example.test',
    'student'
  ),
  (
    md5('phase-13g-outsider')::uuid,
    'Phase 13G Outsider',
    'phase-13g-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13g-workspace')::uuid,
  'Phase 13G Workspace',
  'phase-13g-immediate-certified-bank',
  md5('phase-13g-teacher-certifier')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13g-teacher-certifier')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13g-workspace')::uuid,
  md5('phase-13g-teacher-certifier')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13g-workspace')::uuid,
  md5('phase-13g-student')::uuid,
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  is_active,
  created_by
)
values
  (
    md5('phase-13g-active-batch')::uuid,
    md5('phase-13g-workspace')::uuid,
    'Phase 13G Active A2',
    'A2',
    true,
    md5('phase-13g-teacher-certifier')::uuid
  ),
  (
    md5('phase-13g-inactive-batch')::uuid,
    md5('phase-13g-workspace')::uuid,
    'Phase 13G Inactive A2',
    'A2',
    true,
    md5('phase-13g-teacher-certifier')::uuid
  ),
  (
    md5('phase-13g-unjoined-batch')::uuid,
    md5('phase-13g-workspace')::uuid,
    'Phase 13G Unjoined A2',
    'A2',
    true,
    md5('phase-13g-teacher-certifier')::uuid
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-active-batch')::uuid,
    md5('phase-13g-student')::uuid
  ),
  (
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-inactive-batch')::uuid,
    md5('phase-13g-student')::uuid
  ),
  (
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-unjoined-batch')::uuid,
    md5('phase-13g-student')::uuid
  );

insert into app_private.grammar_topic_contracts (slug, display_name)
values
  ('phase-direct-bank', 'Phase Direct Bank'),
  ('phase-missing-bank', 'Phase Missing Bank');

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    md5('phase-13g-topic-direct')::uuid,
    'phase-direct-bank',
    'Phase Direct Bank',
    'A1_A2',
    'Transaction-only exact certified-bank topic.'
  ),
  (
    md5('phase-13g-topic-missing')::uuid,
    'phase-missing-bank',
    'Phase Missing Bank',
    'A1_A2',
    'Transaction-only provider fallback topic.'
  ),
  (
    md5('phase-13g-topic-inactive')::uuid,
    'phase-inactive-bank',
    'Phase Inactive Bank',
    'A1_A2',
    'Transaction-only inactive class topic.'
  ),
  (
    md5('phase-13g-topic-unjoined')::uuid,
    'phase-unjoined-bank',
    'Phase Unjoined Bank',
    'A1_A2',
    'Transaction-only missing enrollment topic.'
  ),
  (
    md5('phase-13g-topic-no-context')::uuid,
    'phase-no-class-context',
    'Phase No Class Context',
    'A1_A2',
    'Transaction-only missing class snapshot topic.'
  );

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by
)
values
  (
    md5('phase-13g-teacher-certifier')::uuid,
    'Qualified German-language worksheet reviewer',
    true,
    false,
    md5('phase-13g-teacher-certifier')::uuid
  ),
  (
    md5('phase-13g-releaser')::uuid,
    'Qualified educational worksheet release controller',
    false,
    true,
    md5('phase-13g-teacher-certifier')::uuid
  );

create temporary table phase_13g_state (
  revision_id uuid,
  direct_job_id uuid,
  direct_generation_status text,
  direct_clone_id uuid,
  replay_job_id uuid,
  replay_generation_status text,
  expired_processing_job_id uuid,
  expired_processing_message_id bigint,
  expired_processing_returned_job_id uuid,
  expired_processing_returned_status text,
  active_processing_job_id uuid,
  active_processing_message_id bigint,
  active_processing_returned_job_id uuid,
  active_processing_returned_status text,
  missing_job_id uuid,
  missing_generation_status text,
  missing_queue_message_id bigint,
  missing_revision_id uuid,
  missing_clone_id uuid,
  late_bank_job_id uuid,
  late_bank_generation_status text,
  late_bank_replay_job_id uuid,
  late_bank_replay_generation_status text,
  late_workspace_generation_before integer not null default 0,
  late_student_generation_before integer not null default 0,
  late_spend_count_before bigint not null default 0,
  workspace_generation_before integer not null default 0,
  student_generation_before integer not null default 0
) on commit drop;

insert into phase_13g_state default values;
grant select, update on phase_13g_state to authenticated;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13g.a2.direct-bank',
    pg_temp.phase_13g_worksheet_payload(),
    md5('phase-13g-teacher-certifier')::uuid,
    md5('phase-13g-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13G transaction review.',
    'Qualified Phase 13G transaction release.'
  )
)
update phase_13g_state state
set revision_id = published.revision_id
from published;

select ok(
  exists (
    select 1
    from phase_13g_state state
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = state.revision_id
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join app_private.practice_worksheet_template_reviews review
      on review.revision_id = revision.id
     and review.decision = 'approved'
    join app_private.practice_worksheet_template_releases release
      on release.revision_id = revision.id
     and release.review_id = review.id
    where revision.state = 'released'
      and template.grammar_topic_id = md5('phase-13g-topic-direct')::uuid
      and template.level = 'A2'
  ),
  'the fixture is an exact A2 qualified, independently released bank revision'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  assigned_by,
  generation_status,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values
  (
    md5('phase-13g-assignment-direct')::uuid,
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-student')::uuid,
    md5('phase-13g-topic-direct')::uuid,
    'manual',
    'unlocked',
    md5('phase-13g-teacher-certifier')::uuid,
    'idle',
    md5('phase-13g-active-batch')::uuid,
    'A2',
    1,
    'teacher_verified'
  ),
  (
    md5('phase-13g-assignment-missing')::uuid,
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-student')::uuid,
    md5('phase-13g-topic-missing')::uuid,
    'manual',
    'unlocked',
    md5('phase-13g-teacher-certifier')::uuid,
    'idle',
    md5('phase-13g-active-batch')::uuid,
    'A2',
    1,
    'teacher_verified'
  ),
  (
    md5('phase-13g-assignment-inactive')::uuid,
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-student')::uuid,
    md5('phase-13g-topic-inactive')::uuid,
    'manual',
    'unlocked',
    md5('phase-13g-teacher-certifier')::uuid,
    'idle',
    md5('phase-13g-inactive-batch')::uuid,
    'A2',
    1,
    'teacher_verified'
  ),
  (
    md5('phase-13g-assignment-unjoined')::uuid,
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-student')::uuid,
    md5('phase-13g-topic-unjoined')::uuid,
    'manual',
    'unlocked',
    md5('phase-13g-teacher-certifier')::uuid,
    'idle',
    md5('phase-13g-unjoined-batch')::uuid,
    'A2',
    1,
    'teacher_verified'
  ),
  (
    md5('phase-13g-assignment-no-context')::uuid,
    md5('phase-13g-workspace')::uuid,
    md5('phase-13g-student')::uuid,
    md5('phase-13g-topic-no-context')::uuid,
    'manual',
    'unlocked',
    md5('phase-13g-teacher-certifier')::uuid,
    'idle',
    null,
    null,
    0,
    'legacy_unverified'
  );

-- Preserve deliberately stale manual fixtures so the request boundary itself
-- proves it refuses inactive or no-longer-enrolled class contexts.
update public.batches
set is_active = false
where id = md5('phase-13g-inactive-batch')::uuid;

delete from public.batch_students
where workspace_id = md5('phase-13g-workspace')::uuid
  and batch_id = md5('phase-13g-unjoined-batch')::uuid
  and student_id = md5('phase-13g-student')::uuid;

update phase_13g_state state
set
  workspace_generation_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = md5('phase-13g-workspace')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  student_generation_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = md5('phase-13g-workspace')::uuid
      and usage.student_id = md5('phase-13g-student')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13g-student')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13g-student')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-direct')::uuid
  )
)
update pg_temp.phase_13g_state state
set direct_job_id = requested.job_id,
    direct_generation_status = requested.generation_status
from requested;

reset role;

update phase_13g_state state
set direct_clone_id = assignment.practice_test_id
from public.student_practice_assignments assignment
where assignment.id = md5('phase-13g-assignment-direct')::uuid;

select ok(
  (
    select state.direct_job_id is null
      and state.direct_generation_status = 'ready'
    from phase_13g_state state
  ),
  'the exact bank request returns ready with a null job synchronously'
);

select ok(
  exists (
    select 1
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-direct')::uuid
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    where assignment.generation_status = 'ready'
      and assignment.generation_completed_at is not null
      and assignment.practice_test_id = state.direct_clone_id
      and worksheet.worksheet_template_revision_id = state.revision_id
      and worksheet.created_by_ai = false
      and worksheet.generation_source = 'certified_bank'
      and worksheet.approval_source = 'certified_template_bank'
  ),
  'the assignment attaches the exact released revision as a non-AI immutable clone'
);

select ok(
  (
    select count(*) = 1
    from app_private.worksheet_bank_direct_attachment_events event
    cross join phase_13g_state state
    where event.assignment_id = md5('phase-13g-assignment-direct')::uuid
      and event.workspace_id = md5('phase-13g-workspace')::uuid
      and event.student_id = md5('phase-13g-student')::uuid
      and event.template_revision_id = state.revision_id
      and event.cloned_practice_test_id = state.direct_clone_id
      and event.requested_by = md5('phase-13g-student')::uuid
      and event.attachment_source = 'certified_bank_direct'
  ),
  'the synchronous attachment creates exactly one content-free audit event'
);

select ok(
  not exists (
    select 1
    from app_private.async_jobs job
    where job.entity_id = md5('phase-13g-assignment-direct')::uuid
  )
    and (
      select coalesce((
        select usage.generation_job_count
        from app_private.ai_workspace_daily_usage usage
        where usage.workspace_id = md5('phase-13g-workspace')::uuid
          and usage.usage_day = (now() at time zone 'UTC')::date
      ), 0) = state.workspace_generation_before
        and coalesce((
          select usage.generation_job_count
          from app_private.ai_student_daily_usage usage
          where usage.workspace_id = md5('phase-13g-workspace')::uuid
            and usage.student_id = md5('phase-13g-student')::uuid
            and usage.usage_day = (now() at time zone 'UTC')::date
        ), 0) = state.student_generation_before
      from phase_13g_state state
    )
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where job.entity_id = md5('phase-13g-assignment-direct')::uuid
    ),
  'direct bank attachment creates no queue job, paid-work usage, or AI reservation'
);

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-direct')::uuid
  )
)
update pg_temp.phase_13g_state state
set replay_job_id = requested.job_id,
    replay_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  (
    select state.replay_job_id is null
      and state.replay_generation_status = 'ready'
    from phase_13g_state state
  ),
  'a lost-response replay returns the same synchronous ready state'
);

select ok(
  (
    select count(*) = 1
    from app_private.worksheet_bank_direct_attachment_events event
    where event.assignment_id = md5('phase-13g-assignment-direct')::uuid
  )
    and (
      select assignment.practice_test_id = state.direct_clone_id
      from public.student_practice_assignments assignment
      cross join phase_13g_state state
      where assignment.id = md5('phase-13g-assignment-direct')::uuid
    )
    and not exists (
      select 1
      from app_private.async_jobs job
      where job.entity_id = md5('phase-13g-assignment-direct')::uuid
    ),
  'replay is idempotent: it neither reclones, reaudits, nor queues paid work'
);

select throws_ok(
  $$
    update app_private.worksheet_bank_direct_attachment_events
    set requested_by = md5('phase-13g-teacher-certifier')::uuid
    where assignment_id = md5('phase-13g-assignment-direct')::uuid
  $$,
  '55000',
  'worksheet_bank_history_immutable',
  'direct-attachment audit events cannot be updated'
);

select throws_ok(
  $$
    delete from app_private.worksheet_bank_direct_attachment_events
    where assignment_id = md5('phase-13g-assignment-direct')::uuid
  $$,
  '55000',
  'worksheet_bank_history_immutable',
  'direct-attachment audit events cannot be deleted'
);

update public.student_practice_assignments assignment
set
  practice_test_id = null,
  generation_version = assignment.generation_version + 1,
  generation_status = 'queued',
  generation_started_at = null,
  generation_completed_at = null,
  generation_error = null
where assignment.id = md5('phase-13g-assignment-direct')::uuid;

with assignment_context as (
  select assignment.id, assignment.generation_version
  from public.student_practice_assignments assignment
  where assignment.id = md5('phase-13g-assignment-direct')::uuid
), enqueued as (
  select queued.*
  from assignment_context context
  cross join lateral app_private.enqueue_async_job(
    'worksheet_generation',
    context.id,
    context.generation_version,
    format('phase-13g-expired-processing:%s', context.generation_version),
    md5('phase-13g-student')::uuid,
    0
  ) queued
)
update phase_13g_state state
set expired_processing_job_id = enqueued.job_id
from enqueued;

update phase_13g_state state
set expired_processing_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.expired_processing_job_id;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = job.attempt_count + 1,
  worker_id = md5('phase-13g-expired-worker')::uuid,
  lease_expires_at = now() - interval '1 second',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now()
where job.id = (select expired_processing_job_id from phase_13g_state);

update public.student_practice_assignments assignment
set
  generation_status = 'generating',
  generation_started_at = now()
where assignment.id = md5('phase-13g-assignment-direct')::uuid;

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-direct')::uuid
  )
)
update pg_temp.phase_13g_state state
set expired_processing_returned_job_id = requested.job_id,
    expired_processing_returned_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-direct')::uuid
    join app_private.async_jobs job on job.id = state.expired_processing_job_id
    join pgmq.a_worksheet_generation archived
      on archived.msg_id = state.expired_processing_message_id
    where state.expired_processing_returned_job_id is null
      and state.expired_processing_returned_status = 'ready'
      and assignment.practice_test_id = state.direct_clone_id
      and assignment.generation_status = 'ready'
      and job.status = 'dead'
      and job.last_error_code = 'certified_bank_attached'
      and not exists (
        select 1
        from pgmq.q_worksheet_generation live
        where live.msg_id = state.expired_processing_message_id
      )
      and (
        select count(*) = 2
        from app_private.worksheet_bank_direct_attachment_events event
        where event.assignment_id = assignment.id
      )
  ),
  'an expired processing lease cannot hide immediately available certified material'
);

update public.student_practice_assignments assignment
set
  practice_test_id = null,
  generation_version = assignment.generation_version + 1,
  generation_status = 'queued',
  generation_started_at = null,
  generation_completed_at = null,
  generation_error = null
where assignment.id = md5('phase-13g-assignment-direct')::uuid;

with assignment_context as (
  select assignment.id, assignment.generation_version
  from public.student_practice_assignments assignment
  where assignment.id = md5('phase-13g-assignment-direct')::uuid
), enqueued as (
  select queued.*
  from assignment_context context
  cross join lateral app_private.enqueue_async_job(
    'worksheet_generation',
    context.id,
    context.generation_version,
    format('phase-13g-active-processing:%s', context.generation_version),
    md5('phase-13g-student')::uuid,
    0
  ) queued
)
update phase_13g_state state
set active_processing_job_id = enqueued.job_id
from enqueued;

update phase_13g_state state
set active_processing_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.active_processing_job_id;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = job.attempt_count + 1,
  worker_id = md5('phase-13g-active-worker')::uuid,
  lease_expires_at = now() + interval '5 minutes',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now()
where job.id = (select active_processing_job_id from phase_13g_state);

update public.student_practice_assignments assignment
set
  generation_status = 'generating',
  generation_started_at = now()
where assignment.id = md5('phase-13g-assignment-direct')::uuid;

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-direct')::uuid
  )
)
update pg_temp.phase_13g_state state
set active_processing_returned_job_id = requested.job_id,
    active_processing_returned_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-direct')::uuid
    join app_private.async_jobs job on job.id = state.active_processing_job_id
    join pgmq.q_worksheet_generation live
      on live.msg_id = state.active_processing_message_id
    where state.active_processing_returned_job_id = state.active_processing_job_id
      and state.active_processing_returned_status = 'generating'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and job.status = 'processing'
      and job.lease_expires_at > now()
      and not exists (
        select 1
        from pgmq.a_worksheet_generation archived
        where archived.msg_id = state.active_processing_message_id
      )
      and (
        select count(*) = 2
        from app_private.worksheet_bank_direct_attachment_events event
        where event.assignment_id = assignment.id
      )
  ),
  'an active future processing lease remains untouched and cannot race a direct attachment'
);

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-missing')::uuid
  )
)
update pg_temp.phase_13g_state state
set missing_job_id = requested.job_id,
    missing_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-missing')::uuid
    join app_private.async_jobs job on job.id = state.missing_job_id
    where state.missing_generation_status = 'queued'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'queued'
      and job.job_kind = 'worksheet_generation'
      and job.entity_id = assignment.id
      and job.status = 'queued'
      and job.queue_message_id is not null
  ),
  'an exact context without bank material falls back to one durable queued job'
);

update phase_13g_state state
set
  missing_queue_message_id = job.queue_message_id,
  late_workspace_generation_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = md5('phase-13g-workspace')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  late_student_generation_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = md5('phase-13g-workspace')::uuid
      and usage.student_id = md5('phase-13g-student')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  late_spend_count_before = (
    select count(*)
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs reserved_job on reserved_job.id = reservation.job_id
    where reserved_job.entity_id = md5('phase-13g-assignment-missing')::uuid
  )
from app_private.async_jobs job
where job.id = state.missing_job_id;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13g.a2.missing-bank',
    jsonb_set(
      jsonb_set(
        pg_temp.phase_13g_worksheet_payload(),
        '{grammar_topic,slug}',
        '"phase-missing-bank"'
      ),
      '{grammar_topic,name}',
      '"Phase Missing Bank"'
    ),
    md5('phase-13g-teacher-certifier')::uuid,
    md5('phase-13g-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13G late-bank transaction review.',
    'Qualified Phase 13G late-bank transaction release.'
  )
)
update phase_13g_state state
set missing_revision_id = published.revision_id
from published;

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-missing')::uuid
  )
)
update pg_temp.phase_13g_state state
set late_bank_job_id = requested.job_id,
    late_bank_generation_status = requested.generation_status
from requested;

reset role;

update phase_13g_state state
set missing_clone_id = assignment.practice_test_id
from public.student_practice_assignments assignment
where assignment.id = md5('phase-13g-assignment-missing')::uuid;

select ok(
  exists (
    select 1
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-missing')::uuid
    join public.practice_tests worksheet on worksheet.id = state.missing_clone_id
    where state.late_bank_job_id is null
      and state.late_bank_generation_status = 'ready'
      and assignment.practice_test_id = state.missing_clone_id
      and assignment.generation_status = 'ready'
      and worksheet.worksheet_template_revision_id = state.missing_revision_id
      and (
        select count(*) = 1
        from app_private.worksheet_bank_direct_attachment_events event
        where event.assignment_id = assignment.id
          and event.cloned_practice_test_id = state.missing_clone_id
          and event.template_revision_id = state.missing_revision_id
      )
  ),
  'a release published after queueing attaches synchronously with one exact audit event'
);

select ok(
  exists (
    select 1
    from phase_13g_state state
    join app_private.async_jobs job on job.id = state.missing_job_id
    join pgmq.a_worksheet_generation archived
      on archived.msg_id = state.missing_queue_message_id
    where job.status = 'dead'
      and job.last_error_code = 'certified_bank_attached'
      and job.dead_at is not null
      and not exists (
        select 1
        from pgmq.q_worksheet_generation live
        where live.msg_id = state.missing_queue_message_id
      )
  ),
  'late bank attachment terminalizes the unleased job and archives its queue message'
);

select ok(
  (
    select coalesce((
      select usage.generation_job_count
      from app_private.ai_workspace_daily_usage usage
      where usage.workspace_id = md5('phase-13g-workspace')::uuid
        and usage.usage_day = (now() at time zone 'UTC')::date
    ), 0) = state.late_workspace_generation_before
      and coalesce((
        select usage.generation_job_count
        from app_private.ai_student_daily_usage usage
        where usage.workspace_id = md5('phase-13g-workspace')::uuid
          and usage.student_id = md5('phase-13g-student')::uuid
          and usage.usage_day = (now() at time zone 'UTC')::date
      ), 0) = state.late_student_generation_before
      and (
        select count(*)
        from app_private.ai_spend_reservations reservation
        join app_private.async_jobs job on job.id = reservation.job_id
        where job.entity_id = md5('phase-13g-assignment-missing')::uuid
      ) = state.late_spend_count_before
    from phase_13g_state state
  ),
  'late bank attachment adds no paid quota or spend and preserves prior accounting'
);

set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13g-assignment-missing')::uuid
  )
)
update pg_temp.phase_13g_state state
set late_bank_replay_job_id = requested.job_id,
    late_bank_replay_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  (
    select state.late_bank_replay_job_id is null
      and state.late_bank_replay_generation_status = 'ready'
      and assignment.practice_test_id = state.missing_clone_id
      and (
        select count(*) = 1
        from app_private.worksheet_bank_direct_attachment_events event
        where event.assignment_id = assignment.id
      )
      and not exists (
        select 1
        from app_private.async_jobs job
        where job.entity_id = assignment.id
          and job.status in ('queued', 'retry', 'processing')
      )
    from phase_13g_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13g-assignment-missing')::uuid
  ),
  'a late-bank replay preserves the same clone without reauditing or reviving paid work'
);

set local role authenticated;

select throws_ok(
  $$
    select *
    from api.request_practice_worksheet(
      md5('phase-13g-assignment-inactive')::uuid
    )
  $$,
  '42501',
  'active_class_membership_required',
  'an inactive frozen batch is rejected before bank selection or paid work'
);

select throws_ok(
  $$
    select *
    from api.request_practice_worksheet(
      md5('phase-13g-assignment-unjoined')::uuid
    )
  $$,
  '42501',
  'active_class_membership_required',
  'a missing exact batch enrollment is rejected before bank selection or paid work'
);

select throws_ok(
  $$
    select *
    from api.request_practice_worksheet(
      md5('phase-13g-assignment-no-context')::uuid
    )
  $$,
  '55000',
  'Practice assignment class context is required.',
  'a missing frozen batch snapshot cannot use the bank or queue provider work'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13g-outsider')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13g-outsider')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.request_practice_worksheet(
      md5('phase-13g-assignment-direct')::uuid
    )
  $$,
  'P0002',
  'practice_assignment_not_found',
  'an outsider receives the non-enumerating denial boundary'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.async_jobs job
    where job.entity_id in (
      md5('phase-13g-assignment-inactive')::uuid,
      md5('phase-13g-assignment-unjoined')::uuid,
      md5('phase-13g-assignment-no-context')::uuid
    )
    )
    and not exists (
      select 1
      from app_private.worksheet_bank_direct_attachment_events event
      where event.assignment_id in (
        md5('phase-13g-assignment-inactive')::uuid,
        md5('phase-13g-assignment-unjoined')::uuid,
        md5('phase-13g-assignment-no-context')::uuid
      )
    )
    and (
      select count(*) = 3
      from app_private.worksheet_bank_direct_attachment_events event
      where event.workspace_id = md5('phase-13g-workspace')::uuid
    ),
  'blocked and unauthorized requests create neither jobs nor audit side effects'
);

select * from finish();
rollback;
