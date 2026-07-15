begin;

select plan(19);

select ok(
  to_regprocedure(
    'api.get_writing_draft_by_context(uuid,uuid,text,uuid)'
  ) is not null
    and to_regprocedure(
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)'
    ) is not null,
  'the exact writing-draft context read model exists behind an internal implementation'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.get_writing_draft_by_context(uuid,uuid,text,uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_writing_draft_by_context(uuid,uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)',
      'EXECUTE'
    ),
  'only authenticated callers can invoke the exact context wrapper and its non-exposed delegate'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.get_writing_draft_by_context(uuid,uuid,text,uuid)'::regprocedure
  )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)'::regprocedure
    )
    and not exists (
      select 1
      from pg_proc routine
      where routine.oid in (
        'api.get_writing_draft_by_context(uuid,uuid,text,uuid)'::regprocedure,
        'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)'::regprocedure
      )
        and not exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
    ),
  'the exposed wrapper is invoker-safe and both routines pin an empty search path'
);

select ok(
  exists (
    select 1
    from pg_index index_metadata
    where index_metadata.indexrelid =
      'app_private.writing_drafts_context_unique_idx'::regclass
      and index_metadata.indisunique
      and index_metadata.indisvalid
  ),
  'one unique private row remains enforced per student, class, and writing-source context'
);

create temporary table phase_12z_state (
  teacher_id uuid not null,
  student_id uuid not null,
  workspace_id uuid not null,
  target_draft_id uuid not null
) on commit drop;

insert into phase_12z_state values (
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid()
);

create temporary table phase_12z_batches (
  sequence_number integer primary key,
  batch_id uuid not null unique
) on commit drop;

insert into phase_12z_batches (sequence_number, batch_id)
select number, gen_random_uuid()
from generate_series(0, 101) number;

grant select on phase_12z_state, phase_12z_batches to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.teacher_id,
  'authenticated',
  'authenticated',
  'phase12z-teacher-' || fixture.teacher_id::text || '@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 12Z Teacher"}'::jsonb,
  now(),
  now()
from phase_12z_state fixture
union all
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.student_id,
  'authenticated',
  'authenticated',
  'phase12z-student-' || fixture.student_id::text || '@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 12Z Student"}'::jsonb,
  now(),
  now()
from phase_12z_state fixture;

insert into public.workspaces (id, name, slug, owner_id)
select
  fixture.workspace_id,
  'Phase 12Z Workspace',
  'phase-12z-' || fixture.workspace_id::text,
  fixture.teacher_id
from phase_12z_state fixture;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  (select teacher_id::text from phase_12z_state),
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
select fixture.workspace_id, fixture.teacher_id, 'owner'
from phase_12z_state fixture;

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
select fixture.workspace_id, fixture.student_id, 'student'
from phase_12z_state fixture;

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode, created_by
)
select
  batch.batch_id,
  fixture.workspace_id,
  'Phase 12Z Class ' || batch.sequence_number::text,
  'A2',
  true,
  'immediate',
  fixture.teacher_id
from phase_12z_batches batch
cross join phase_12z_state fixture;

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
select
  gen_random_uuid(),
  batch.batch_id,
  fixture.student_id,
  fixture.workspace_id
from phase_12z_batches batch
cross join phase_12z_state fixture;

insert into app_private.writing_drafts (
  id, workspace_id, student_id, batch_id, source_type, source_id,
  content, revision, created_at, updated_at
)
select
  fixture.target_draft_id,
  fixture.workspace_id,
  fixture.student_id,
  batch.batch_id,
  'free_text',
  null,
  E'  Zielentwurf.\n\nMit exaktem Abstand.  ',
  7,
  now() - interval '2 days',
  now() - interval '2 days'
from phase_12z_state fixture
join phase_12z_batches batch on batch.sequence_number = 0;

insert into app_private.writing_drafts (
  id, workspace_id, student_id, batch_id, source_type, source_id,
  content, revision, created_at, updated_at
)
select
  gen_random_uuid(),
  fixture.workspace_id,
  fixture.student_id,
  batch.batch_id,
  'free_text',
  null,
  'Newer context ' || batch.sequence_number::text,
  1,
  now() + batch.sequence_number * interval '1 second',
  now() + batch.sequence_number * interval '1 second'
from phase_12z_state fixture
join phase_12z_batches batch on batch.sequence_number between 1 and 101;

select is(
  (
    select count(*)
    from app_private.writing_drafts draft
    join phase_12z_state fixture
      on fixture.student_id = draft.student_id
    where draft.updated_at > now() - interval '1 day'
  ),
  101::bigint,
  'the regression fixture contains 101 drafts newer than the target context'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select student_id from phase_12z_state),
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select student_id::text from phase_12z_state),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    select count(*)
    from api.list_my_writing_drafts(
      (select workspace_id from phase_12z_state),
      100
    )
  ),
  100::bigint,
  'the legacy draft summary endpoint remains capped at 100 rows'
);

select ok(
  not exists (
    select 1
    from api.list_my_writing_drafts(
      (select workspace_id from phase_12z_state),
      100
    ) listed
    where listed.draft_id = (select target_draft_id from phase_12z_state)
  ),
  'the 101 newer drafts reproduce the old capped restoration miss'
);

select is(
  (
    select count(*)
    from api.get_writing_draft_by_context(
      (select workspace_id from phase_12z_state),
      (select batch_id from phase_12z_batches where sequence_number = 0),
      'free_text',
      null
    )
  ),
  1::bigint,
  'the exact context lookup returns one target draft independently of recency'
);

select is(
  (
    select "text"
    from api.get_writing_draft_by_context(
      (select workspace_id from phase_12z_state),
      (select batch_id from phase_12z_batches where sequence_number = 0),
      'free_text',
      null
    )
  ),
  E'  Zielentwurf.\n\nMit exaktem Abstand.  ',
  'the exact context lookup preserves the complete original draft text'
);

select is(
  (
    select revision
    from api.get_writing_draft_by_context(
      (select workspace_id from phase_12z_state),
      (select batch_id from phase_12z_batches where sequence_number = 0),
      'free_text',
      null
    )
  ),
  7,
  'the exact context lookup returns the optimistic-lock revision'
);

select is(
  (
    with found as (
      select *
      from api.get_writing_draft_by_context(
        (select workspace_id from phase_12z_state),
        (select batch_id from phase_12z_batches where sequence_number = 0),
        'free_text',
        null
      )
    )
    select saved.saved_revision
    from found
    cross join lateral api.save_writing_draft(
      found.draft_id,
      found.batch_id,
      found.source_type,
      found.source_id,
      E'  Sicher fortgesetzt.\nOhne Duplikat.  ',
      found.revision
    ) saved
  ),
  8,
  'the exact id and revision resume the existing unique draft without conflict'
);

select is(
  (
    select jsonb_build_object('text', "text", 'revision', revision)
    from api.get_writing_draft_by_context(
      (select workspace_id from phase_12z_state),
      (select batch_id from phase_12z_batches where sequence_number = 0),
      'free_text',
      null
    )
  ),
  jsonb_build_object(
    'text', E'  Sicher fortgesetzt.\nOhne Duplikat.  ',
    'revision', 8
  ),
  'the resumed content and revision read back atomically through the same context'
);

reset role;

select is(
  (
    select count(*)
    from app_private.writing_drafts draft
    where draft.student_id = (select student_id from phase_12z_state)
      and draft.batch_id = (
        select batch_id from phase_12z_batches where sequence_number = 0
      )
      and draft.source_type = 'free_text'
      and draft.source_id is null
  ),
  1::bigint,
  'resuming leaves exactly one private draft for the unique writing context'
);

select throws_ok(
  $$
    insert into app_private.writing_drafts (
      workspace_id, student_id, batch_id, source_type, source_id, content
    )
    select
      fixture.workspace_id,
      fixture.student_id,
      batch.batch_id,
      'free_text',
      null,
      'duplicate context'
    from phase_12z_state fixture
    join phase_12z_batches batch on batch.sequence_number = 0
  $$,
  '23505',
  'duplicate key value violates unique constraint "writing_drafts_context_unique_idx"',
  'the database still rejects a second row for the same writing context'
);

set local role authenticated;

select throws_ok(
  format(
    'select * from api.get_writing_draft_by_context(%L::uuid,%L::uuid,%L,null)',
    gen_random_uuid(),
    (select batch_id from phase_12z_batches where sequence_number = 0),
    'free_text'
  ),
  '42501',
  'writing_workspace_context_mismatch',
  'a caller cannot substitute another workspace around an authorized class'
);

select throws_ok(
  format(
    'select * from api.get_writing_draft_by_context(%L::uuid,%L::uuid,%L,null)',
    (select workspace_id from phase_12z_state),
    gen_random_uuid(),
    'free_text'
  ),
  '42501',
  'active_class_membership_required',
  'a caller cannot read a context outside an active class enrollment'
);

select throws_ok(
  format(
    'select * from api.get_writing_draft_by_context(%L::uuid,%L::uuid,%L,null)',
    (select workspace_id from phase_12z_state),
    (select batch_id from phase_12z_batches where sequence_number = 0),
    'workspace_question'
  ),
  '22023',
  'writing_question_unavailable',
  'the source type and source id are authorized as part of the exact context'
);

reset role;
delete from public.batch_students enrollment
where enrollment.batch_id = (
    select batch_id from phase_12z_batches where sequence_number = 0
  )
  and enrollment.student_id = (select student_id from phase_12z_state);
set local role authenticated;

select throws_ok(
  format(
    'select * from api.get_writing_draft_by_context(%L::uuid,%L::uuid,%L,null)',
    (select workspace_id from phase_12z_state),
    (select batch_id from phase_12z_batches where sequence_number = 0),
    'free_text'
  ),
  '42501',
  'active_class_membership_required',
  'offboarding immediately revokes exact-context draft restoration'
);

reset role;
select ok(
  exists (
    select 1
    from app_private.writing_drafts draft
    where draft.id = (select target_draft_id from phase_12z_state)
      and draft.revision = 8
  ),
  'offboarding preserves the revisioned private draft for audit and possible restoration'
);

select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select * from finish();
rollback;
