begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(44);

create or replace function pg_temp.phase_14f_set_actor(
  target_user_id uuid,
  target_session_id uuid,
  target_aal text,
  target_amr jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  claims jsonb := jsonb_build_object(
    'sub', target_user_id::text,
    'role', 'authenticated',
    'aal', target_aal,
    'amr', coalesce(target_amr, '[]'::jsonb)
  );
begin
  if target_session_id is not null then
    claims := claims || jsonb_build_object(
      'session_id', target_session_id::text
    );
  end if;

  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.aal', target_aal, true);
  perform set_config(
    'request.jwt.claim.session_id',
    coalesce(target_session_id::text, ''),
    true
  );
  perform set_config(
    'request.jwt.claim.amr',
    coalesce(target_amr, '[]'::jsonb)::text,
    true
  );
end;
$$;

select ok(
  to_regprocedure(
    'api.request_batch_writing_limit(uuid,integer,integer)'
  ) is not null
    and to_regprocedure(
      'api.list_batch_writing_limit_requests(text,integer,timestamptz,uuid)'
    ) is not null
    and to_regprocedure(
      'api.decide_batch_writing_limit(uuid,text,integer)'
    ) is not null
    and to_regprocedure(
      'app_private.consume_writing_submission_quota(uuid,uuid,uuid)'
    ) is not null
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.request_batch_writing_limit(uuid,integer,integer)'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.decide_batch_writing_limit(uuid,text,integer)'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.list_batch_writing_limit_requests(text,integer,timestamptz,uuid)'::regprocedure
    )
    and (
      select procedure.provolatile = 'v'
      from pg_proc procedure
      where procedure.oid =
        'api.list_batch_writing_limit_requests(text,integer,timestamptz,uuid)'::regprocedure
    )
    and has_schema_privilege('authenticated', 'api', 'USAGE')
    and has_function_privilege(
      'authenticated',
      'api.request_batch_writing_limit(uuid,integer,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.list_batch_writing_limit_requests(text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.decide_batch_writing_limit(uuid,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.request_batch_writing_limit(uuid,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_batch_writing_limit_requests(text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.decide_batch_writing_limit(uuid,text,integer)',
      'EXECUTE'
    )
    and position(
      'on conflict on constraint batch_writing_limits_pkey'
      in lower(pg_get_functiondef(
        'public.decide_batch_writing_limit_internal(uuid,text,integer)'::regprocedure
      ))
    ) > 0
    and position(
      'writing_monthly_quota_exceeded'
      in pg_get_functiondef(
        'app_private.consume_writing_submission_quota(uuid,uuid,uuid)'::regprocedure
      )
    ) = 0
    and position(
      'student_ai_monthly_budget_exceeded'
      in pg_get_functiondef(
        'app_private.consume_ai_paid_work_budget(text,uuid)'::regprocedure
      )
    ) = 0
    and position(
      'workspace_ai_daily_budget_exceeded'
      in pg_get_functiondef(
        'app_private.consume_ai_paid_work_budget(text,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'ai_spend_student_fair_share_exceeded'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) = 0
    and position(
      'new.student_id := selected_student_id'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) > 0,
  'the exact API facade and approved-class writing authority remain private, atomic, and free of retired student cost denials'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'function_name', procedure.proname,
        'input_names', to_jsonb(
          procedure.proargnames[1:procedure.pronargs]
        ),
        'input_modes', coalesce(
          to_jsonb(procedure.proargmodes[1:procedure.pronargs]),
          to_jsonb(array_fill('i'::"char", array[procedure.pronargs]))
        )
      )
      order by procedure.proname
    )
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'api'
      and procedure.proname in (
        'request_batch_writing_limit',
        'list_batch_writing_limit_requests',
        'decide_batch_writing_limit'
      )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'function_name', 'decide_batch_writing_limit',
      'input_names', jsonb_build_array(
        'request_id', 'decision', 'expected_revision'
      ),
      'input_modes', jsonb_build_array('b', 'i', 'i')
    ),
    jsonb_build_object(
      'function_name', 'list_batch_writing_limit_requests',
      'input_names', jsonb_build_array(
        'status', 'page_size', 'cursor_updated_at', 'cursor_id'
      ),
      'input_modes', jsonb_build_array('i', 'i', 'i', 'i')
    ),
    jsonb_build_object(
      'function_name', 'request_batch_writing_limit',
      'input_names', jsonb_build_array(
        'batch_id', 'requested_limit', 'expected_revision'
      ),
      'input_modes', jsonb_build_array('b', 'i', 'i')
    )
  ),
  'all writing-limit RPCs expose the exact browser named-argument contract to PostgREST'
);

select ok(
  (select relrowsecurity from pg_class
   where oid = 'app_private.batch_writing_limits'::regclass)
    and (select relrowsecurity from pg_class
         where oid = 'app_private.batch_writing_limit_requests'::regclass)
    and (select relrowsecurity from pg_class
         where oid = 'app_private.batch_writing_limit_audit'::regclass)
    and (select relrowsecurity from pg_class
         where oid =
           'app_private.writing_submission_batch_daily_usage'::regclass)
    and not has_table_privilege(
      'authenticated', 'app_private.batch_writing_limits',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated', 'app_private.batch_writing_limit_requests',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated', 'app_private.batch_writing_limit_audit',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_submission_batch_daily_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'current state, pending requests, audit, and usage are private RLS tables'
);

select is(
  (
    select jsonb_build_array(
      writing.max_submissions_per_student_workspace_day,
      writing.max_submissions_per_student_workspace_month,
      paid.max_writing_jobs_per_student_workspace_day,
      paid.max_writing_jobs_per_student_workspace_month,
      paid.max_writing_jobs_per_workspace_day,
      paid.max_generation_jobs_per_student_workspace_day,
      paid.max_generation_jobs_per_workspace_day,
      paid.max_semantic_jobs_per_student_workspace_day,
      paid.max_semantic_jobs_per_workspace_day
    )
    from app_private.writing_security_limits writing
    cross join app_private.ai_paid_work_limits paid
    where writing.singleton and paid.singleton
  ),
  '[3,40,40,50,10000,8,300,12,600]'::jsonb,
  'class writing limits are authoritative while historical counters remain telemetry and Practice limits stay unchanged'
);

select is(
  jsonb_build_array(
    app_private.india_writing_usage_day(
      '2026-01-01 18:29:59+00'::timestamptz
    ),
    app_private.india_writing_usage_day(
      '2026-01-01 18:30:00+00'::timestamptz
    )
  ),
  '["2026-01-01","2026-01-02"]'::jsonb,
  'the writing day rolls over at India midnight (18:30 UTC)'
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
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'a1411111-1111-4111-8111-111111111111'::uuid,
    'authenticated', 'authenticated', 'phase14f-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14F Admin"}'::jsonb,
    false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'a1422222-2222-4222-8222-222222222222'::uuid,
    'authenticated', 'authenticated', 'phase14f-teacher-one@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14F Teacher One"}'::jsonb,
    false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'a1433333-3333-4333-8333-333333333333'::uuid,
    'authenticated', 'authenticated', 'phase14f-teacher-two@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14F Teacher Two"}'::jsonb,
    false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'a1444444-4444-4444-8444-444444444444'::uuid,
    'authenticated', 'authenticated', 'phase14f-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14F Student"}'::jsonb,
    false, now(), now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values (
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'a1411111-1111-4111-8111-111111111111'::uuid,
  now(), now(), now() + interval '1 day'
);

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at,
  secret
)
values
  (
    'a1481111-1111-4111-8111-111111111111'::uuid,
    'a1411111-1111-4111-8111-111111111111'::uuid,
    'Phase 14F primary TOTP', 'totp', 'verified', now(), now(),
    'JBSWY3DPEHPK3PXP'
  ),
  (
    'a1482222-2222-4222-8222-222222222222'::uuid,
    'a1411111-1111-4111-8111-111111111111'::uuid,
    'Phase 14F backup TOTP', 'totp', 'verified', now(), now(),
    'KRSXG5DSNFXGOIDB'
  );

delete from public.profiles
where id = 'a1411111-1111-4111-8111-111111111111'::uuid;

insert into public.profiles (id, full_name, email, global_role)
values (
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'Phase 14F Admin',
  'phase14f-admin@example.test',
  'platform_admin'
);

-- Current workspace authorization requires both a workspace role and effective
-- server-managed teacher access. Keep the rollback-only fixture faithful to
-- the real approved-teacher path rather than bypassing has_workspace_role.
insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values
  (
    'a1422222-2222-4222-8222-222222222222'::uuid,
    true,
    1,
    1,
    null,
    'Phase 14F active owner entitlement.'
  ),
  (
    'a1433333-3333-4333-8333-333333333333'::uuid,
    true,
    1,
    1,
    null,
    'Phase 14F active teacher entitlement.'
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'a1466666-6666-4666-8666-666666666666'::uuid,
  'Phase 14F Workspace',
  'phase-14f-workspace',
  'a1422222-2222-4222-8222-222222222222'::uuid
);

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'a1422222-2222-4222-8222-222222222222'::uuid,
    'owner'
  ),
  (
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'a1433333-3333-4333-8333-333333333333'::uuid,
    'teacher'
  ),
  (
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'a1444444-4444-4444-8444-444444444444'::uuid,
    'student'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by, feedback_mode
)
values
  (
    'a1471111-1111-4111-8111-111111111111'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'Phase 14F Approved Ten', 'A1', true,
    'a1422222-2222-4222-8222-222222222222'::uuid, 'immediate'
  ),
  (
    'a1472222-2222-4222-8222-222222222222'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'Phase 14F Default Three', 'A2', true,
    'a1422222-2222-4222-8222-222222222222'::uuid, 'immediate'
  ),
  (
    'a1473333-3333-4333-8333-333333333333'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'Phase 14F Monthly Boundary', 'B1', true,
    'a1422222-2222-4222-8222-222222222222'::uuid, 'immediate'
  ),
  (
    'a1474444-4444-4444-8444-444444444444'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'Phase 14F Inactive', 'B2', false,
    'a1422222-2222-4222-8222-222222222222'::uuid, 'immediate'
  );

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values
  (
    'a1451111-1111-4111-8111-111111111111'::uuid,
    'a1471111-1111-4111-8111-111111111111'::uuid,
    'a1444444-4444-4444-8444-444444444444'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid
  ),
  (
    'a1452222-2222-4222-8222-222222222222'::uuid,
    'a1472222-2222-4222-8222-222222222222'::uuid,
    'a1444444-4444-4444-8444-444444444444'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid
  ),
  (
    'a1453333-3333-4333-8333-333333333333'::uuid,
    'a1473333-3333-4333-8333-333333333333'::uuid,
    'a1444444-4444-4444-8444-444444444444'::uuid,
    'a1466666-6666-4666-8666-666666666666'::uuid
  );

create temporary table phase_14f_state (
  singleton boolean primary key default true check (singleton),
  request_id uuid,
  approved_request_id uuid,
  request_revision integer,
  draft_id uuid,
  draft_revision integer
) on commit drop;
insert into phase_14f_state default values;
grant select, update on phase_14f_state to authenticated;

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select throws_ok(
  $$select * from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 11, 0
  )$$,
  '22023',
  'batch_writing_limit_invalid',
  'a teacher cannot request a value outside 1 through 10'
);

select throws_ok(
  $$select * from api.request_batch_writing_limit(
    'a1474444-4444-4444-8444-444444444444'::uuid, 10, 0
  )$$,
  '23514',
  'batch_writing_limit_batch_inactive',
  'inactive classes cannot acquire a pending request'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1444444-4444-4444-8444-444444444444'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select throws_ok(
  $$select * from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 10, 0
  )$$,
  '42501',
  'permission_denied',
  'students cannot create class-limit requests'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with requested as (
  select *
  from api.request_batch_writing_limit(
    batch_id => 'a1471111-1111-4111-8111-111111111111'::uuid,
    requested_limit => 10,
    expected_revision => 0
  )
)
update pg_temp.phase_14f_state state
set request_id = requested.request_id,
    request_revision = requested.request_revision
from requested
where state.singleton;

select ok(
  (
    select request_id is not null and request_revision = 1
    from pg_temp.phase_14f_state
  ),
  'a teacher creates the single revision-1 pending request from the default 3'
);

select lives_ok(
  $$select * from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 10, 0
  )$$,
  'a lost initial response can be retried idempotently with expected revision 0'
);

reset role;
select ok(
  (
    select count(*) = 1
    from app_private.batch_writing_limit_requests request
    where request.batch_id =
      'a1471111-1111-4111-8111-111111111111'::uuid
      and request.status = 'pending'
  )
    and (
      select count(*) = 1
      from app_private.batch_writing_limit_audit audit
      where audit.request_id = (
        select request_id from pg_temp.phase_14f_state where singleton
      )
    ),
  'the idempotent retry creates neither a second pending row nor duplicate audit'
);

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select ok(
  (
    select item ->> 'pending_writing_daily_limit' = '10'
      and item ->> 'pending_writing_limit_request_revision' = '1'
      and item ->> 'current_writing_daily_limit' = '3'
    from jsonb_array_elements(
      api.list_workspace_batches_page(
        'a1466666-6666-4666-8666-666666666666'::uuid,
        20, null, null, 'all', null
      ) -> 'items'
    ) item
    where item ->> 'id' = 'a1471111-1111-4111-8111-111111111111'
  ),
  'the existing teacher class page exposes the current and pending limits'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1433333-3333-4333-8333-333333333333'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with revised as (
  select *
  from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 9, 1
  )
)
update pg_temp.phase_14f_state state
set request_revision = revised.request_revision
from revised
where state.singleton;

select is(
  (select request_revision from pg_temp.phase_14f_state where singleton),
  2,
  'another authorized teacher revises the one pending request to revision 2'
);

reset role;
select ok(
  (
    select request.requested_by =
      'a1433333-3333-4333-8333-333333333333'::uuid
      and request.requested_limit = 9
    from app_private.batch_writing_limit_requests request
    where request.id = (
      select request_id from pg_temp.phase_14f_state where singleton
    )
  )
    and exists (
      select 1
      from app_private.batch_writing_limit_audit audit
      where audit.request_id = (
        select request_id from pg_temp.phase_14f_state where singleton
      )
        and audit.action = 'request_updated'
        and audit.actor_user_id =
          'a1433333-3333-4333-8333-333333333333'::uuid
        and audit.request_revision_after = 2
    ),
  'latest-revision attribution follows the teacher who actually changed it'
);

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select throws_ok(
  $$select * from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 8, 1
  )$$,
  '40001',
  'batch_writing_limit_revision_conflict',
  'a stale writer cannot overwrite a newer pending revision'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1433333-3333-4333-8333-333333333333'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with revised as (
  select *
  from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 10, 2
  )
)
update pg_temp.phase_14f_state state
set request_revision = revised.request_revision
from revised
where state.singleton;

reset role;
select ok(
  (select request_revision = 3 from pg_temp.phase_14f_state where singleton)
    and (
      select count(*) = 1
      from app_private.batch_writing_limit_requests request
      where request.batch_id =
        'a1471111-1111-4111-8111-111111111111'::uuid
        and request.status = 'pending'
    ),
  'the current actor can revision-safely restore 10 without creating a second pending row'
);

select pg_temp.phase_14f_set_actor(
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  $$select api.list_batch_writing_limit_requests('pending', 25, null, null)$$,
  '42501',
  'platform_admin_mfa_required',
  'an AAL1 administrator cannot read the private approval queue'
);

select throws_ok(
  format(
    'select * from api.decide_batch_writing_limit(%L::uuid, %L, 3)',
    (select request_id from pg_temp.phase_14f_state where singleton),
    'approved'
  ),
  '42501',
  'platform_admin_mfa_required',
  'an AAL1 administrator cannot decide a request'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '11 minutes')::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  format(
    'select * from api.decide_batch_writing_limit(%L::uuid, %L, 3)',
    (select request_id from pg_temp.phase_14f_state where singleton),
    'approved'
  ),
  '42501',
  'platform_admin_fresh_authentication_required',
  'a stale AAL2 TOTP cannot authorize a decision'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now() - interval '1 minute')::bigint
    ),
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '10 seconds')::bigint
    )
  )
);
set local role authenticated;

select ok(
  api.list_batch_writing_limit_requests(
    status => 'pending',
    page_size => 25,
    cursor_updated_at => null,
    cursor_id => null
  )
    #>> '{items,0,requester_email}' = 'phase14f-teacher-two@example.test'
    and api.list_batch_writing_limit_requests(
      status => 'pending',
      page_size => 25,
      cursor_updated_at => null,
      cursor_id => null
    )
      #>> '{items,0,requested_writing_daily_limit}' = '10'
    and api.list_batch_writing_limit_requests(
      status => 'pending',
      page_size => 25,
      cursor_updated_at => null,
      cursor_id => null
    )
      #>> '{items,0,request_revision}' = '3',
  'the AAL2 admin queue shows the latest actor, requested value, and revision'
);

select ok(
  (
    select previous_writing_daily_limit = 3
      and current_writing_daily_limit = 10
      and request_status = 'approved'
      and request_revision = 4
    from api.decide_batch_writing_limit(
      request_id => (
        select request_id from pg_temp.phase_14f_state where singleton
      ),
      decision => 'approved',
      expected_revision => 3
    )
  ),
  'fresh MFA atomically approves revision 3 and makes 10 effective'
);

select ok(
  (
    select current_writing_daily_limit = 10 and request_revision = 4
    from api.decide_batch_writing_limit(
      (select request_id from pg_temp.phase_14f_state where singleton),
      'approved',
      3
    )
  ),
  'a lost approval response can be replayed by the same administrator'
);

reset role;
select ok(
  app_private.current_batch_writing_daily_limit(
    'a1466666-6666-4666-8666-666666666666'::uuid,
    'a1471111-1111-4111-8111-111111111111'::uuid
  ) = 10
    and not exists (
      select 1
      from app_private.batch_writing_limit_requests request
      where request.batch_id =
        'a1471111-1111-4111-8111-111111111111'::uuid
        and request.status = 'pending'
    ),
  'approval replaces pending state with private current state'
);

update pg_temp.phase_14f_state state
set approved_request_id = state.request_id
where state.singleton;

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select ok(
  (
    select item ->> 'current_writing_daily_limit' = '10'
      and item -> 'pending_writing_limit_request_id' = 'null'::jsonb
    from jsonb_array_elements(
      api.list_workspace_batches_page(
        'a1466666-6666-4666-8666-666666666666'::uuid,
        20, null, null, 'all', null
      ) -> 'items'
    ) item
    where item ->> 'id' = 'a1471111-1111-4111-8111-111111111111'
  ),
  'the class page switches from pending to the approved current limit'
);

reset role;
select throws_ok(
  format(
    'update app_private.batch_writing_limit_audit set occurred_at = now() where request_id = %L::uuid',
    (select request_id from pg_temp.phase_14f_state where singleton)
  ),
  '55000',
  'batch_writing_limit_audit_immutable',
  'request and decision evidence is immutable'
);

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with requested as (
  select *
  from api.request_batch_writing_limit(
    'a1472222-2222-4222-8222-222222222222'::uuid, 1, 0
  )
)
update pg_temp.phase_14f_state state
set request_id = requested.request_id,
    request_revision = requested.request_revision
from requested
where state.singleton;

select ok(
  (
    select request_id is not null and request_revision = 1
    from pg_temp.phase_14f_state where singleton
  ),
  'a second class receives its own independent pending request'
);

reset role;
select pg_temp.phase_14f_set_actor(
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '10 seconds')::bigint
    )
  )
);
set local role authenticated;

select ok(
  (
    select request_status = 'rejected'
      and current_writing_daily_limit = 3
      and previous_writing_daily_limit = 3
      and request_revision = 2
    from api.decide_batch_writing_limit(
      (select request_id from pg_temp.phase_14f_state where singleton),
      'rejected',
      1
    )
  ),
  'fresh MFA can reject without changing the class default'
);

select ok(
  (
    select request_status = 'rejected'
      and current_writing_daily_limit = 3
      and request_revision = 2
    from api.decide_batch_writing_limit(
      (select request_id from pg_temp.phase_14f_state where singleton),
      'rejected',
      1
    )
  ),
  'a lost rejection response is replay-safe'
);

reset role;
select is(
  (
    select count(*)::integer
    from app_private.batch_writing_limit_audit audit
    where audit.request_id = (
      select request_id from pg_temp.phase_14f_state where singleton
    )
  ),
  2,
  'rejection replay does not duplicate request or decision audit rows'
);

select pg_temp.phase_14f_set_actor(
  'a1444444-4444-4444-8444-444444444444'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'a1471111-1111-4111-8111-111111111111'::uuid,
    'free_text',
    null,
    'Der erste Text wird als Entwurf gespeichert und dann abgegeben.',
    0
  )
)
update pg_temp.phase_14f_state state
set draft_id = saved.saved_draft_id,
    draft_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (
    select draft_id is not null and draft_revision = 1
    from pg_temp.phase_14f_state where singleton
  ),
  'autosave creates a revision-safe draft in the approved class'
);

select lives_ok(
  format(
    'select * from api.submit_writing_draft(%L::uuid, %s)',
    (select draft_id from pg_temp.phase_14f_state where singleton),
    (select draft_revision from pg_temp.phase_14f_state where singleton)
  ),
  'the draft submission uses the same approved class-local quota path'
);

select lives_ok(
  $$do $phase_14f_nine_more$
    begin
      for counter in 1..9 loop
        perform *
        from api.submit_writing(
          'a1471111-1111-4111-8111-111111111111'::uuid,
          'free_text',
          null,
          format('Zulässiger Text Nummer %s in der Klasse mit Limit zehn.', counter)
        );
      end loop;
    end;
  $phase_14f_nine_more$;$$,
  'nine direct submissions after the draft reach the approved tenth writing'
);

reset role;
select ok(
  (
    select count(*) = 10
    from public.submissions submission
    where submission.batch_id =
      'a1471111-1111-4111-8111-111111111111'::uuid
  )
    and (
      select usage.submission_count = 10
        and usage.usage_day = app_private.india_writing_usage_day(now())
      from app_private.writing_submission_batch_daily_usage usage
      where usage.workspace_id =
          'a1466666-6666-4666-8666-666666666666'::uuid
        and usage.batch_id =
          'a1471111-1111-4111-8111-111111111111'::uuid
        and usage.student_id =
          'a1444444-4444-4444-8444-444444444444'::uuid
    )
    and (
      select count(*) = 10
      from app_private.async_jobs job
      where job.job_kind = 'writing_evaluation'
        and job.requested_by =
          'a1444444-4444-4444-8444-444444444444'::uuid
    ),
  'the approved tenth submission, India-local usage, and durable job all commit'
);

select pg_temp.phase_14f_set_actor(
  'a1444444-4444-4444-8444-444444444444'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select throws_ok(
  $$select * from api.submit_writing(
    'a1471111-1111-4111-8111-111111111111'::uuid,
    'free_text', null, 'Der elfte Text muss atomar abgelehnt werden.'
  )$$,
  'PT429',
  'writing_daily_quota_exceeded',
  'the eleventh submission is rejected at the approved class boundary'
);

reset role;
select ok(
  (
    select count(*) = 10
    from public.submissions submission
    where submission.batch_id =
      'a1471111-1111-4111-8111-111111111111'::uuid
  )
    and (
      select count(*) = 10
      from app_private.async_jobs job
      where job.job_kind = 'writing_evaluation'
        and job.requested_by =
          'a1444444-4444-4444-8444-444444444444'::uuid
    ),
  'the rejected eleventh attempt leaves no partial submission or queue job'
);

select pg_temp.phase_14f_set_actor(
  'a1444444-4444-4444-8444-444444444444'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select lives_ok(
  $$do $phase_14f_default_three$
    begin
      for counter in 1..3 loop
        perform *
        from api.submit_writing(
          'a1472222-2222-4222-8222-222222222222'::uuid,
          'free_text',
          null,
          format('Unabhängiger Standardtext Nummer %s.', counter)
        );
      end loop;
    end;
  $phase_14f_default_three$;$$,
  'three writings in another class remain available after ten in the approved class'
);

select throws_ok(
  $$select * from api.submit_writing(
    'a1472222-2222-4222-8222-222222222222'::uuid,
    'free_text', null, 'Der vierte Standardtext muss abgelehnt werden.'
  )$$,
  'PT429',
  'writing_daily_quota_exceeded',
  'the unapproved class still rejects its fourth daily writing'
);

reset role;
select ok(
  (
    select usage.submission_count = 3
    from app_private.writing_submission_batch_daily_usage usage
    where usage.batch_id =
      'a1472222-2222-4222-8222-222222222222'::uuid
      and usage.student_id =
        'a1444444-4444-4444-8444-444444444444'::uuid
      and usage.usage_day = app_private.india_writing_usage_day(now())
  )
    and (
      select count(*) = 13
      from public.submissions submission
      where submission.workspace_id =
        'a1466666-6666-4666-8666-666666666666'::uuid
        and submission.student_id =
          'a1444444-4444-4444-8444-444444444444'::uuid
    )
    and not exists (
      select 1
      from app_private.writing_submission_daily_usage usage
      where usage.workspace_id =
          'a1466666-6666-4666-8666-666666666666'::uuid
        and usage.student_id =
          'a1444444-4444-4444-8444-444444444444'::uuid
    ),
  'class limits are independent and no workspace-day counter undercuts them'
);

update app_private.writing_submission_monthly_usage usage
set submission_count = 39,
    updated_at = now()
where usage.workspace_id =
    'a1466666-6666-4666-8666-666666666666'::uuid
  and usage.student_id =
    'a1444444-4444-4444-8444-444444444444'::uuid
  and usage.usage_month =
    date_trunc('month', now() at time zone 'UTC')::date;

update app_private.ai_student_daily_usage usage
set writing_job_count = 39,
    updated_at = now()
where usage.workspace_id =
    'a1466666-6666-4666-8666-666666666666'::uuid
  and usage.student_id =
    'a1444444-4444-4444-8444-444444444444'::uuid
  and usage.usage_day = (now() at time zone 'UTC')::date;

update app_private.ai_student_monthly_usage usage
set writing_job_count = 49,
    updated_at = now()
where usage.workspace_id =
    'a1466666-6666-4666-8666-666666666666'::uuid
  and usage.student_id =
    'a1444444-4444-4444-8444-444444444444'::uuid
  and usage.usage_month =
    date_trunc('month', now() at time zone 'UTC')::date;

select pg_temp.phase_14f_set_actor(
  'a1444444-4444-4444-8444-444444444444'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select lives_ok(
  $$select * from api.submit_writing(
    'a1473333-3333-4333-8333-333333333333'::uuid,
    'free_text', null, 'Diese Abgabe erreicht die Monatsgrenze vierzig.'
  )$$,
  'the fortieth workspace-month writing still succeeds'
);

select lives_ok(
  $$select * from api.submit_writing(
    'a1473333-3333-4333-8333-333333333333'::uuid,
    'free_text', null, 'Diese Abgabe überschreitet nur den alten Monatswert.'
  )$$,
  'writing forty-one succeeds while it remains below the approved class/day limit'
);

reset role;
select ok(
  (
    select usage.submission_count = 41
    from app_private.writing_submission_monthly_usage usage
    where usage.workspace_id =
        'a1466666-6666-4666-8666-666666666666'::uuid
      and usage.student_id =
        'a1444444-4444-4444-8444-444444444444'::uuid
      and usage.usage_month =
        date_trunc('month', now() at time zone 'UTC')::date
  )
    and (
      select count(*) = 2
      from public.submissions submission
      where submission.batch_id =
        'a1473333-3333-4333-8333-333333333333'::uuid
    )
    and (
      select count(*) = 15
      from app_private.async_jobs job
      where job.job_kind = 'writing_evaluation'
        and job.requested_by =
          'a1444444-4444-4444-8444-444444444444'::uuid
    )
    and (
      select usage.writing_job_count = 41
      from app_private.ai_student_daily_usage usage
      where usage.workspace_id =
          'a1466666-6666-4666-8666-666666666666'::uuid
        and usage.student_id =
          'a1444444-4444-4444-8444-444444444444'::uuid
        and usage.usage_day = (now() at time zone 'UTC')::date
    )
    and (
      select usage.writing_job_count = 51
      from app_private.ai_student_monthly_usage usage
      where usage.workspace_id =
          'a1466666-6666-4666-8666-666666666666'::uuid
        and usage.student_id =
          'a1444444-4444-4444-8444-444444444444'::uuid
        and usage.usage_month =
          date_trunc('month', now() at time zone 'UTC')::date
    ),
  'crossing historical writing day/month values commits submission, job, and telemetry atomically'
);

select ok(
  (
    select usage.writing_job_count = 41
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id =
        'a1466666-6666-4666-8666-666666666666'::uuid
      and usage.student_id =
        'a1444444-4444-4444-8444-444444444444'::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  )
    and (
      select limits.max_writing_jobs_per_student_workspace_day = 40
      from app_private.ai_paid_work_limits limits
      where limits.singleton
    ),
  'the historical student paid-work day value is retained only as telemetry'
);

select pg_temp.phase_14f_set_actor(
  'a1422222-2222-4222-8222-222222222222'::uuid,
  null,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

with requested as (
  select *
  from api.request_batch_writing_limit(
    'a1471111-1111-4111-8111-111111111111'::uuid, 5, 0
  )
)
update pg_temp.phase_14f_state state
set request_id = requested.request_id,
    request_revision = requested.request_revision
from requested
where state.singleton;

reset role;
select pg_temp.phase_14f_set_actor(
  'a1411111-1111-4111-8111-111111111111'::uuid,
  'a1499999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '10 seconds')::bigint
    )
  )
);
set local role authenticated;

select ok(
  (
    select previous_writing_daily_limit = 10
      and current_writing_daily_limit = 5
      and request_status = 'approved'
      and request_revision = 2
    from api.decide_batch_writing_limit(
      (select request_id from pg_temp.phase_14f_state where singleton),
      'approved',
      1
    )
  ),
  'a later approved decision can intentionally change the current class limit'
);

select ok(
  (
    select previous_writing_daily_limit = 3
      and current_writing_daily_limit = 10
      and requested_writing_daily_limit = 10
      and request_status = 'approved'
      and request_revision = 4
    from api.decide_batch_writing_limit(
      (
        select approved_request_id
        from pg_temp.phase_14f_state
        where singleton
      ),
      'approved',
      3
    )
  ),
  'replaying the older approval returns its immutable decision-time response'
);

reset role;

select * from finish(true);
rollback;
