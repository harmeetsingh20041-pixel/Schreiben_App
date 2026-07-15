begin;

select plan(21);

select is(
  (
    select jsonb_build_array(
      max_submissions_per_student_workspace_day,
      max_submissions_per_student_workspace_month
    )
    from app_private.writing_security_limits
    where singleton
  ),
  '[3,40]'::jsonb,
  'three remains the class/day default and the historical month value remains telemetry'
);

select is(
  (
    select jsonb_build_array(
      max_writing_jobs_per_student_workspace_day,
      max_writing_jobs_per_student_workspace_month
    )
    from app_private.ai_paid_work_limits
    where singleton
  ),
  '[40,50]'::jsonb,
  'historical paid-writing day/month values remain available for telemetry'
);

select is(
  (
    select jsonb_build_array(
      monthly_limit_microusd,
      default_workspace_monthly_limit_microusd,
      revision
    )
    from app_private.ai_spend_global_policy
    where singleton
  ),
  '[225000000,100000000,2]'::jsonb,
  'the audited global cap is USD 225 while the pilot workspace default remains USD 100'
);

select ok(
  exists (
    select 1
    from app_private.ai_budget_change_audit audit
    where audit.scope = 'global'
      and audit.old_monthly_limit_microusd = 500000000
      and audit.new_monthly_limit_microusd = 225000000
      and audit.old_default_workspace_limit_microusd = 100000000
      and audit.new_default_workspace_limit_microusd = 100000000
      and audit.new_revision = 2
  ),
  'the forward cap change has immutable old/new audit evidence'
);

select has_table(
  'app_private',
  'writing_submission_monthly_usage',
  'evaluated-writing monthly usage has a private counter'
);

select has_table(
  'app_private',
  'ai_student_monthly_usage',
  'paid writing monthly usage has a private counter'
);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'app_private.writing_submission_monthly_usage'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.ai_student_monthly_usage'::regclass)
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_submission_monthly_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.ai_student_monthly_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'monthly counters are RLS protected and hidden from browser roles'
);

select is(
  (
    select array_agg(
      app_private.provider_outage_retry_delay_seconds(retry_number)
      order by retry_number
    )
    from generate_series(1, 4) retry_number
  ),
  array[60, 300, 900, 1800],
  'dual-provider outage recovery has exactly four delayed dispatches'
);

select is(
  app_private.provider_outage_retry_delay_seconds(5),
  null::integer,
  'a fifth outage dispatch has no schedule'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1211111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12t-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12T Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12t-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12T Student"}'::jsonb, now(), now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values (
  'e1211111-1111-4111-8111-111111111111'::uuid,
  true,
  1,
  1,
  null,
  'Phase 12T active teacher fixture.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1233333-3333-4333-8333-333333333333',
  'Phase 12T Workspace',
  'phase-12t-workspace',
  'e1211111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'e1233333-3333-4333-8333-333333333333',
    'e1211111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'e1233333-3333-4333-8333-333333333333',
    'e1222222-2222-4222-8222-222222222222',
    'student'
  )
on conflict (workspace_id, user_id) do update set role = excluded.role;

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'e1244444-4444-4444-8444-444444444444',
  'e1233333-3333-4333-8333-333333333333',
  'Phase 12T A2', 'A2', true, 'immediate'
);

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values (
  'e1255555-5555-4555-8555-555555555555',
  'e1244444-4444-4444-8444-444444444444',
  'e1222222-2222-4222-8222-222222222222',
  'e1233333-3333-4333-8333-333333333333'
);

create temporary table phase_12t_state (
  singleton boolean primary key default true check (singleton),
  question_id uuid
) on commit drop;
insert into phase_12t_state default values;
grant select, update on phase_12t_state to authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"e1211111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  'e1211111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$select * from api.create_workspace_question(
    'e1233333-3333-4333-8333-333333333333',
    'Oversized task', repeat('x', 4001), 'A2', 'Alltag', 'writing',
    40, 80, 20, true
  )$$,
  '22023',
  'teacher_task_prompt_too_long',
  'teacher task creation rejects the 4,001st character with a stable error'
);

select lives_ok(
  $$with created as (
    select * from api.create_workspace_question(
      'e1233333-3333-4333-8333-333333333333',
      'Exact task', repeat('x', 4000), 'A2', 'Alltag', 'writing',
      40, 80, 20, true
    )
  )
  update pg_temp.phase_12t_state state
  set question_id = created.question_id
  from created
  where state.singleton$$,
  'teacher task creation accepts exactly 4,000 characters'
);

select throws_ok(
  $$select * from api.update_workspace_question(
    'e1233333-3333-4333-8333-333333333333',
    (select question_id from pg_temp.phase_12t_state where singleton),
    'Exact task', repeat('y', 4001), 'A2', 'Alltag', 'writing',
    40, 80, 20, true
  )$$,
  '22023',
  'teacher_task_prompt_too_long',
  'teacher task update uses the same stable 4,000-character boundary'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"e1222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  'e1222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$do $phase_12t_three_writings$
  begin
    perform 1 from api.submit_writing(
      'e1244444-4444-4444-8444-444444444444',
      'free_text', null, 'Text eins.'
    );
    perform 1 from api.submit_writing(
      'e1244444-4444-4444-8444-444444444444',
      'free_text', null, 'Text zwei.'
    );
    perform 1 from api.submit_writing(
      'e1244444-4444-4444-8444-444444444444',
      'free_text', null, 'Text drei.'
    );
  end;
  $phase_12t_three_writings$;$$,
  'three evaluated writings are accepted in one India-local day'
);

select throws_ok(
  $$select * from api.submit_writing(
    'e1244444-4444-4444-8444-444444444444', 'free_text', null, 'Text vier.'
  )$$,
  'PT429',
  'writing_daily_quota_exceeded',
  'the fourth evaluated writing returns a browser rate-limit response atomically'
);

reset role;
select is(
  (
    select jsonb_build_array(daily.submission_count, monthly.submission_count)
    from app_private.writing_submission_batch_daily_usage daily
    join app_private.writing_submission_monthly_usage monthly
      on monthly.workspace_id = daily.workspace_id
     and monthly.student_id = daily.student_id
    where daily.workspace_id = 'e1233333-3333-4333-8333-333333333333'
      and daily.batch_id = 'e1244444-4444-4444-8444-444444444444'
      and daily.student_id = 'e1222222-2222-4222-8222-222222222222'
      and daily.usage_day = app_private.india_writing_usage_day(now())
      and monthly.usage_month =
        date_trunc('month', now() at time zone 'UTC')::date
  ),
  '[3,3]'::jsonb,
  'daily rejection leaves both committed writing counters at three'
);

delete from app_private.writing_submission_batch_daily_usage
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and batch_id = 'e1244444-4444-4444-8444-444444444444'
  and student_id = 'e1222222-2222-4222-8222-222222222222';
update app_private.writing_submission_monthly_usage
set submission_count = 39
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and student_id = 'e1222222-2222-4222-8222-222222222222'
  and usage_month = date_trunc('month', now() at time zone 'UTC')::date;

set local role authenticated;
select lives_ok(
  $$select * from api.submit_writing(
    'e1244444-4444-4444-8444-444444444444', 'free_text', null, 'Monat vierzig.'
  )$$,
  'the fortieth evaluated writing is accepted'
);

select lives_ok(
  $$select * from api.submit_writing(
    'e1244444-4444-4444-8444-444444444444', 'free_text', null, 'Monat einundvierzig.'
  )$$,
  'the forty-first evaluated writing succeeds below the class daily allowance'
);

reset role;
select ok(
  (select submission_count = 2
   from app_private.writing_submission_batch_daily_usage
   where workspace_id = 'e1233333-3333-4333-8333-333333333333'
     and batch_id = 'e1244444-4444-4444-8444-444444444444'
     and student_id = 'e1222222-2222-4222-8222-222222222222'
     and usage_day = app_private.india_writing_usage_day(now()))
    and (select submission_count = 41
         from app_private.writing_submission_monthly_usage
         where workspace_id = 'e1233333-3333-4333-8333-333333333333'
           and student_id = 'e1222222-2222-4222-8222-222222222222'
           and usage_month = date_trunc('month', now() at time zone 'UTC')::date),
  'crossing the historical month value increments daily and monthly telemetry'
);

delete from app_private.writing_submission_batch_daily_usage
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and batch_id = 'e1244444-4444-4444-8444-444444444444'
  and student_id = 'e1222222-2222-4222-8222-222222222222';
update app_private.writing_submission_monthly_usage
set submission_count = 0
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and student_id = 'e1222222-2222-4222-8222-222222222222';
delete from app_private.ai_student_daily_usage
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and student_id = 'e1222222-2222-4222-8222-222222222222';
delete from app_private.ai_workspace_daily_usage
where workspace_id = 'e1233333-3333-4333-8333-333333333333';
update app_private.ai_student_monthly_usage
set writing_job_count = 49
where workspace_id = 'e1233333-3333-4333-8333-333333333333'
  and student_id = 'e1222222-2222-4222-8222-222222222222'
  and usage_month = date_trunc('month', now() at time zone 'UTC')::date;

set local role authenticated;
select lives_ok(
  $$select * from api.submit_writing(
    'e1244444-4444-4444-8444-444444444444', 'free_text', null, 'Job fuenfzig.'
  )$$,
  'the fiftieth paid writing job is accepted'
);

select lives_ok(
  $$select * from api.submit_writing(
    'e1244444-4444-4444-8444-444444444444', 'free_text', null, 'Job einundfuenfzig.'
  )$$,
  'the fifty-first paid writing job succeeds below the class daily allowance'
);

reset role;
select ok(
  (select writing_job_count = 2
   from app_private.ai_student_daily_usage
   where workspace_id = 'e1233333-3333-4333-8333-333333333333'
     and student_id = 'e1222222-2222-4222-8222-222222222222'
     and usage_day = (now() at time zone 'UTC')::date)
    and (select writing_job_count = 51
         from app_private.ai_student_monthly_usage
         where workspace_id = 'e1233333-3333-4333-8333-333333333333'
           and student_id = 'e1222222-2222-4222-8222-222222222222'
           and usage_month = date_trunc('month', now() at time zone 'UTC')::date)
    and (select submission_count = 2
         from app_private.writing_submission_batch_daily_usage
         where workspace_id = 'e1233333-3333-4333-8333-333333333333'
           and batch_id = 'e1244444-4444-4444-8444-444444444444'
           and student_id = 'e1222222-2222-4222-8222-222222222222'
           and usage_day = app_private.india_writing_usage_day(now())),
  'paid writing month values continue as telemetry without blocking the class allowance'
);

select * from finish(true);
rollback;
