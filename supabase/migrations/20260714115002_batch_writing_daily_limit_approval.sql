-- Batch-scoped V1 writing limits with teacher requests and platform-admin
-- approval. The default remains three evaluated writings per India-local day. A
-- teacher can request any different value from one through ten for one active
-- class; only a fresh-MFA platform administrator can make that value effective.

-- ---------------------------------------------------------------------------
-- Private current state, revision-safe requests, immutable audit, and usage
-- ---------------------------------------------------------------------------

create table app_private.batch_writing_limits (
  batch_id uuid primary key,
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  daily_limit smallint not null check (daily_limit between 1 and 10),
  revision integer not null default 1 check (revision > 0),
  approved_by uuid not null
    references public.profiles(id) on delete restrict,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint batch_writing_limits_batch_workspace_fkey
    foreign key (batch_id, workspace_id)
    references public.batches(id, workspace_id) on delete restrict
);

create index batch_writing_limits_workspace_batch_idx
on app_private.batch_writing_limits (workspace_id, batch_id);

create index batch_writing_limits_approved_by_idx
on app_private.batch_writing_limits (approved_by);

create table app_private.batch_writing_limit_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  batch_id uuid not null,
  requested_by uuid not null
    references public.profiles(id) on delete restrict,
  requested_limit smallint not null check (requested_limit between 1 and 10),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  revision integer not null default 1 check (revision > 0),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint batch_writing_limit_requests_batch_workspace_fkey
    foreign key (batch_id, workspace_id)
    references public.batches(id, workspace_id) on delete restrict,
  constraint batch_writing_limit_requests_status_shape_check check (
    (
      status = 'pending'
      and decided_at is null
      and decided_by is null
    )
    or (
      status in ('approved', 'rejected')
      and decided_at is not null
      and decided_by is not null
    )
  )
);

create unique index batch_writing_limit_requests_one_pending_idx
on app_private.batch_writing_limit_requests (batch_id)
where status = 'pending';

create index batch_writing_limit_requests_status_page_idx
on app_private.batch_writing_limit_requests (
  status,
  updated_at desc,
  id desc
);

create index batch_writing_limit_requests_global_page_idx
on app_private.batch_writing_limit_requests (updated_at desc, id desc);

create index batch_writing_limit_requests_workspace_batch_idx
on app_private.batch_writing_limit_requests (workspace_id, batch_id);

create index batch_writing_limit_requests_requested_by_idx
on app_private.batch_writing_limit_requests (requested_by);

create index batch_writing_limit_requests_decided_by_idx
on app_private.batch_writing_limit_requests (decided_by)
where decided_by is not null;

create table app_private.batch_writing_limit_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references app_private.batch_writing_limit_requests(id) on delete restrict,
  workspace_id uuid not null,
  batch_id uuid not null,
  actor_user_id uuid not null
    references public.profiles(id) on delete restrict,
  action text not null check (
    action in ('requested', 'request_updated', 'approved', 'rejected')
  ),
  request_revision_before integer
    check (request_revision_before is null or request_revision_before > 0),
  request_revision_after integer not null
    check (request_revision_after > 0),
  previous_writing_daily_limit smallint not null
    check (previous_writing_daily_limit between 1 and 10),
  requested_writing_daily_limit smallint not null
    check (requested_writing_daily_limit between 1 and 10),
  approved_writing_daily_limit smallint
    check (
      approved_writing_daily_limit is null
      or approved_writing_daily_limit between 1 and 10
    ),
  occurred_at timestamptz not null default now(),
  constraint batch_writing_limit_audit_batch_workspace_fkey
    foreign key (batch_id, workspace_id)
    references public.batches(id, workspace_id) on delete restrict,
  constraint batch_writing_limit_audit_action_shape_check check (
    (
      action = 'approved'
      and approved_writing_daily_limit = requested_writing_daily_limit
    )
    or (
      action <> 'approved'
      and approved_writing_daily_limit is null
    )
  )
);

create index batch_writing_limit_audit_batch_time_idx
on app_private.batch_writing_limit_audit (
  batch_id,
  occurred_at desc,
  id desc
);

create index batch_writing_limit_audit_actor_idx
on app_private.batch_writing_limit_audit (actor_user_id);

create table app_private.writing_submission_batch_daily_usage (
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  batch_id uuid not null,
  student_id uuid not null
    references public.profiles(id) on delete cascade,
  usage_day date not null,
  submission_count integer not null default 0 check (submission_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, batch_id, student_id, usage_day),
  constraint writing_submission_batch_daily_usage_batch_workspace_fkey
    foreign key (batch_id, workspace_id)
    references public.batches(id, workspace_id) on delete cascade
);

create index writing_submission_batch_daily_usage_batch_idx
on app_private.writing_submission_batch_daily_usage (batch_id, workspace_id);

create index writing_submission_batch_daily_usage_student_idx
on app_private.writing_submission_batch_daily_usage (student_id);

insert into app_private.writing_submission_batch_daily_usage (
  workspace_id,
  batch_id,
  student_id,
  usage_day,
  submission_count,
  updated_at
)
select
  submission.workspace_id,
  submission.batch_id,
  submission.student_id,
  (submission.created_at at time zone 'Asia/Kolkata')::date,
  count(*)::integer,
  max(submission.updated_at)
from public.submissions submission
where submission.batch_id is not null
  and submission.status <> 'draft'
group by
  submission.workspace_id,
  submission.batch_id,
  submission.student_id,
  (submission.created_at at time zone 'Asia/Kolkata')::date;

alter table app_private.batch_writing_limits enable row level security;
alter table app_private.batch_writing_limit_requests enable row level security;
alter table app_private.batch_writing_limit_audit enable row level security;
alter table app_private.writing_submission_batch_daily_usage
  enable row level security;

revoke all on table app_private.batch_writing_limits
from public, anon, authenticated, service_role;
revoke all on table app_private.batch_writing_limit_requests
from public, anon, authenticated, service_role;
revoke all on table app_private.batch_writing_limit_audit
from public, anon, authenticated, service_role;
revoke all on table app_private.writing_submission_batch_daily_usage
from public, anon, authenticated, service_role;

comment on table app_private.batch_writing_limits is
  'Private current administrator-approved per-class evaluated-writing limits. Missing rows use the launch default of three.';
comment on table app_private.batch_writing_limit_requests is
  'Private revision-safe teacher requests. A partial unique index permits exactly one pending request per class.';
comment on table app_private.batch_writing_limit_audit is
  'Immutable content-free evidence for every writing-limit request and decision.';
comment on table app_private.writing_submission_batch_daily_usage is
  'Atomic per-class, per-student India-local-day evaluated-writing counters.';

create or replace function app_private.guard_batch_writing_limit_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'batch_writing_limit_request_history_immutable';
  end if;

  if old.status <> 'pending' then
    raise exception using
      errcode = '55000',
      message = 'batch_writing_limit_request_history_immutable';
  end if;

  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.batch_id is distinct from old.batch_id
    or new.created_at is distinct from old.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'batch_writing_limit_request_identity_immutable';
  end if;

  -- A teacher may take over and revise the one pending class request. The
  -- latest actor then becomes the request owner so approval-time membership
  -- freshness checks apply to the revision an administrator actually sees.
  if new.status <> 'pending'
    and new.requested_by is distinct from old.requested_by
  then
    raise exception using
      errcode = '55000',
      message = 'batch_writing_limit_request_identity_immutable';
  end if;

  if new.revision <> old.revision + 1 then
    raise exception using
      errcode = '40001',
      message = 'batch_writing_limit_request_revision_required';
  end if;

  return new;
end;
$$;

create or replace function app_private.reject_batch_writing_limit_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'batch_writing_limit_audit_immutable';
end;
$$;

revoke all on function app_private.guard_batch_writing_limit_request()
from public, anon, authenticated, service_role;
revoke all on function app_private.reject_batch_writing_limit_audit_mutation()
from public, anon, authenticated, service_role;

create trigger batch_writing_limit_requests_history_guard
before update or delete on app_private.batch_writing_limit_requests
for each row execute function app_private.guard_batch_writing_limit_request();

create trigger batch_writing_limit_audit_immutable
before update or delete on app_private.batch_writing_limit_audit
for each row execute function app_private.reject_batch_writing_limit_audit_mutation();

-- The paid-work reservation must never undercut a visible per-class daily
-- allowance. Forty matches the separate evaluated-writing monthly ceiling, so
-- the documented monthly safeguard is always the first workspace-wide student
-- boundary. Worksheet-generation and semantic-evaluation limits are unchanged.
update app_private.ai_paid_work_limits
set max_writing_jobs_per_student_workspace_day = 40,
    updated_at = now()
where singleton;

create or replace function app_private.india_writing_usage_day(
  target_time timestamptz default now()
)
returns date
language sql
security definer
set search_path = ''
immutable
as $$
  select (target_time at time zone 'Asia/Kolkata')::date;
$$;

create or replace function app_private.current_batch_writing_daily_limit(
  target_workspace_id uuid,
  target_batch_id uuid
)
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (
      select batch_limit.daily_limit::integer
      from app_private.batch_writing_limits batch_limit
      where batch_limit.workspace_id = target_workspace_id
        and batch_limit.batch_id = target_batch_id
    ),
    (
      select limits.max_submissions_per_student_workspace_day::integer
      from app_private.writing_security_limits limits
      where limits.singleton
    ),
    3
  );
$$;

create or replace function app_private.lock_batch_writing_limit_request(
  target_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_batch_id is null then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_invalid';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('batch-writing-limit:' || target_batch_id::text, 0)
  );
end;
$$;

revoke all on function app_private.current_batch_writing_daily_limit(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function app_private.lock_batch_writing_limit_request(uuid)
from public, anon, authenticated, service_role;
revoke all on function app_private.india_writing_usage_day(timestamptz)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Teacher request and administrator review contracts
-- ---------------------------------------------------------------------------

create or replace function public.request_batch_writing_limit_internal(
  target_batch_id uuid,
  target_requested_limit integer,
  target_expected_revision integer
)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  current_writing_daily_limit integer,
  requested_writing_daily_limit integer,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_workspace_id uuid;
  selected_batch_active boolean;
  selected_current_limit integer;
  locked_request app_private.batch_writing_limit_requests%rowtype;
  previous_revision integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_batch_id is null
    or target_requested_limit is null
    or target_requested_limit not between 1 and 10
    or target_expected_revision is null
    or target_expected_revision < 0
  then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_invalid';
  end if;

  perform app_private.lock_batch_writing_limit_request(target_batch_id);

  select batch.workspace_id, batch.is_active
  into selected_workspace_id, selected_batch_active
  from public.batches batch
  where batch.id = target_batch_id
  for share;

  if selected_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'batch_writing_limit_batch_not_found';
  end if;

  if not selected_batch_active then
    raise exception using
      errcode = '23514',
      message = 'batch_writing_limit_batch_inactive';
  end if;

  if not public.has_workspace_role(
    selected_workspace_id,
    array['owner', 'teacher']
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  selected_current_limit := app_private.current_batch_writing_daily_limit(
    selected_workspace_id,
    target_batch_id
  );

  if target_requested_limit = selected_current_limit then
    raise exception using
      errcode = '23514',
      message = 'batch_writing_limit_unchanged';
  end if;

  select request.*
  into locked_request
  from app_private.batch_writing_limit_requests request
  where request.batch_id = target_batch_id
    and request.status = 'pending'
  for update;

  if locked_request.id is null then
    if target_expected_revision <> 0 then
      raise exception using
        errcode = '40001',
        message = 'batch_writing_limit_revision_conflict';
    end if;

    insert into app_private.batch_writing_limit_requests (
      workspace_id,
      batch_id,
      requested_by,
      requested_limit,
      status,
      revision,
      requested_at,
      created_at,
      updated_at
    )
    values (
      selected_workspace_id,
      target_batch_id,
      caller_id,
      target_requested_limit,
      'pending',
      1,
      now(),
      now(),
      now()
    )
    returning * into locked_request;

    insert into app_private.batch_writing_limit_audit (
      request_id,
      workspace_id,
      batch_id,
      actor_user_id,
      action,
      request_revision_before,
      request_revision_after,
      previous_writing_daily_limit,
      requested_writing_daily_limit
    )
    values (
      locked_request.id,
      selected_workspace_id,
      target_batch_id,
      caller_id,
      'requested',
      null,
      locked_request.revision,
      selected_current_limit,
      locked_request.requested_limit
    );
  elsif locked_request.requested_limit = target_requested_limit then
    -- Exact-current calls and the one-revision-behind replay of a lost
    -- response are harmless reads and never create another audit event.
    if target_expected_revision not in (
      locked_request.revision,
      locked_request.revision - 1
    ) then
      raise exception using
        errcode = '40001',
        message = 'batch_writing_limit_revision_conflict';
    end if;
  else
    if target_expected_revision <> locked_request.revision then
      raise exception using
        errcode = '40001',
        message = 'batch_writing_limit_revision_conflict';
    end if;

    previous_revision := locked_request.revision;

    update app_private.batch_writing_limit_requests request
    set requested_limit = target_requested_limit,
        requested_by = caller_id,
        revision = request.revision + 1,
        requested_at = now(),
        updated_at = now()
    where request.id = locked_request.id
    returning * into locked_request;

    insert into app_private.batch_writing_limit_audit (
      request_id,
      workspace_id,
      batch_id,
      actor_user_id,
      action,
      request_revision_before,
      request_revision_after,
      previous_writing_daily_limit,
      requested_writing_daily_limit
    )
    values (
      locked_request.id,
      selected_workspace_id,
      target_batch_id,
      caller_id,
      'request_updated',
      previous_revision,
      locked_request.revision,
      selected_current_limit,
      locked_request.requested_limit
    );
  end if;

  request_id := locked_request.id;
  workspace_id := locked_request.workspace_id;
  batch_id := locked_request.batch_id;
  current_writing_daily_limit := selected_current_limit;
  requested_writing_daily_limit := locked_request.requested_limit::integer;
  request_status := locked_request.status;
  request_revision := locked_request.revision;
  requested_at := locked_request.requested_at;
  updated_at := locked_request.updated_at;
  return next;
end;
$$;

create or replace function public.list_batch_writing_limit_requests_internal(
  target_status text default null,
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  clean_status text := nullif(lower(btrim(target_status)), '');
  clean_page_size integer := least(
    greatest(coalesce(requested_page_size, 25), 1),
    100
  );
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  caller_id := app_private.lock_active_platform_admin_session();

  if clean_status = 'all' then
    clean_status := null;
  end if;

  if clean_status is not null
    and clean_status not in ('pending', 'approved', 'rejected')
  then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_status_invalid';
  end if;

  if requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
  then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_page_size_invalid';
  end if;

  if (cursor_updated_at is null) <> (cursor_id is null) then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_cursor_invalid';
  end if;

  select count(*)::bigint
  into exact_total
  from app_private.batch_writing_limit_requests request
  where clean_status is null or request.status = clean_status;

  with candidate_rows as materialized (
    select request.*
    from app_private.batch_writing_limit_requests request
    where (clean_status is null or request.status = clean_status)
      and (
        cursor_updated_at is null
        or (request.updated_at, request.id) < (cursor_updated_at, cursor_id)
      )
    order by request.updated_at desc, request.id desc
    limit clean_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by updated_at desc, id desc
    limit clean_page_size
  ),
  enriched_rows as materialized (
    select
      request.id as request_id,
      request.workspace_id,
      workspace.name as workspace_name,
      request.batch_id,
      batch.name as batch_name,
      batch.is_active as batch_active,
      request.requested_by,
      profile.full_name as requester_name,
      profile.email as requester_email,
      app_private.current_batch_writing_daily_limit(
        request.workspace_id,
        request.batch_id
      ) as current_writing_daily_limit,
      request.requested_limit::integer as requested_writing_daily_limit,
      request.status as request_status,
      request.revision as request_revision,
      request.requested_at,
      request.decided_at,
      request.decided_by,
      request.updated_at
    from page_rows request
    join public.workspaces workspace on workspace.id = request.workspace_id
    join public.batches batch
      on batch.id = request.batch_id
     and batch.workspace_id = request.workspace_id
    join public.profiles profile on profile.id = request.requested_by
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(enriched)
          order by enriched.updated_at desc, enriched.request_id desc
        )
        from enriched_rows enriched
      ),
      '[]'::jsonb
    ),
    (select count(*) > clean_page_size from candidate_rows),
    case
      when (select count(*) > clean_page_size from candidate_rows) then (
        select jsonb_build_object(
          'updated_at', page.updated_at,
          'id', page.id
        )
        from page_rows page
        order by page.updated_at asc, page.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', clean_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

create or replace function public.decide_batch_writing_limit_internal(
  target_request_id uuid,
  target_decision text,
  target_expected_revision integer
)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  request_status text,
  request_revision integer,
  previous_writing_daily_limit integer,
  current_writing_daily_limit integer,
  requested_writing_daily_limit integer,
  decided_at timestamptz,
  decided_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  clean_decision text := lower(btrim(target_decision));
  selected_batch_id uuid;
  locked_request app_private.batch_writing_limit_requests%rowtype;
  replay_audit app_private.batch_writing_limit_audit%rowtype;
  selected_previous_limit integer;
  selected_current_limit integer;
  selected_batch_active boolean;
begin
  caller_id := app_private.lock_fresh_platform_admin_session();

  if target_request_id is null
    or clean_decision is null
    or clean_decision not in ('approved', 'rejected')
    or target_expected_revision is null
    or target_expected_revision < 1
  then
    raise exception using
      errcode = '22023',
      message = 'batch_writing_limit_decision_invalid';
  end if;

  select request.batch_id
  into selected_batch_id
  from app_private.batch_writing_limit_requests request
  where request.id = target_request_id;

  if selected_batch_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'batch_writing_limit_request_not_found';
  end if;

  perform app_private.lock_batch_writing_limit_request(selected_batch_id);

  select request.*
  into locked_request
  from app_private.batch_writing_limit_requests request
  where request.id = target_request_id
    and request.batch_id = selected_batch_id
  for update;

  if locked_request.revision = target_expected_revision + 1
    and locked_request.status = clean_decision
    and locked_request.decided_by = caller_id
  then
    select audit.*
    into replay_audit
    from app_private.batch_writing_limit_audit audit
    where audit.request_id = locked_request.id
      and audit.actor_user_id = caller_id
      and audit.action = clean_decision
      and audit.request_revision_before = target_expected_revision
      and audit.request_revision_after = locked_request.revision
    order by audit.occurred_at desc, audit.id desc
    limit 1;

    if replay_audit.id is not null then
      request_id := locked_request.id;
      workspace_id := locked_request.workspace_id;
      batch_id := locked_request.batch_id;
      request_status := locked_request.status;
      request_revision := locked_request.revision;
      previous_writing_daily_limit :=
        replay_audit.previous_writing_daily_limit;
      -- Lost-response replay is an immutable replay of this decision, not a
      -- read of whatever a later request made current for the class.
      current_writing_daily_limit := case replay_audit.action
        when 'approved' then replay_audit.approved_writing_daily_limit
        else replay_audit.previous_writing_daily_limit
      end;
      requested_writing_daily_limit := locked_request.requested_limit::integer;
      decided_at := locked_request.decided_at;
      decided_by := locked_request.decided_by;
      return next;
      return;
    end if;
  end if;

  if locked_request.revision <> target_expected_revision
    or locked_request.status <> 'pending'
  then
    raise exception using
      errcode = '40001',
      message = 'batch_writing_limit_revision_conflict';
  end if;

  select batch.is_active
  into selected_batch_active
  from public.batches batch
  where batch.id = locked_request.batch_id
    and batch.workspace_id = locked_request.workspace_id
  for share;

  if clean_decision = 'approved' and (
    not coalesce(selected_batch_active, false)
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = locked_request.workspace_id
        and membership.user_id = locked_request.requested_by
        and membership.role in ('owner', 'teacher')
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'batch_writing_limit_request_stale';
  end if;

  selected_previous_limit := app_private.current_batch_writing_daily_limit(
    locked_request.workspace_id,
    locked_request.batch_id
  );
  selected_current_limit := selected_previous_limit;

  if clean_decision = 'approved' then
    insert into app_private.batch_writing_limits (
      batch_id,
      workspace_id,
      daily_limit,
      revision,
      approved_by,
      approved_at,
      updated_at
    )
    values (
      locked_request.batch_id,
      locked_request.workspace_id,
      locked_request.requested_limit,
      1,
      caller_id,
      now(),
      now()
    )
    on conflict on constraint batch_writing_limits_pkey do update
    set daily_limit = excluded.daily_limit,
        revision = app_private.batch_writing_limits.revision + 1,
        approved_by = excluded.approved_by,
        approved_at = excluded.approved_at,
        updated_at = excluded.updated_at
    returning app_private.batch_writing_limits.daily_limit::integer
    into selected_current_limit;
  end if;

  update app_private.batch_writing_limit_requests request
  set status = clean_decision,
      revision = request.revision + 1,
      decided_at = now(),
      decided_by = caller_id,
      updated_at = now()
  where request.id = locked_request.id
  returning * into locked_request;

  insert into app_private.batch_writing_limit_audit (
    request_id,
    workspace_id,
    batch_id,
    actor_user_id,
    action,
    request_revision_before,
    request_revision_after,
    previous_writing_daily_limit,
    requested_writing_daily_limit,
    approved_writing_daily_limit
  )
  values (
    locked_request.id,
    locked_request.workspace_id,
    locked_request.batch_id,
    caller_id,
    clean_decision,
    target_expected_revision,
    locked_request.revision,
    selected_previous_limit,
    locked_request.requested_limit,
    case when clean_decision = 'approved' then selected_current_limit end
  );

  request_id := locked_request.id;
  workspace_id := locked_request.workspace_id;
  batch_id := locked_request.batch_id;
  request_status := locked_request.status;
  request_revision := locked_request.revision;
  previous_writing_daily_limit := selected_previous_limit;
  current_writing_daily_limit := selected_current_limit;
  requested_writing_daily_limit := locked_request.requested_limit::integer;
  decided_at := locked_request.decided_at;
  decided_by := locked_request.decided_by;
  return next;
end;
$$;

revoke all on function public.request_batch_writing_limit_internal(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.list_batch_writing_limit_requests_internal(
  text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.decide_batch_writing_limit_internal(
  uuid, text, integer
) from public, anon, authenticated, service_role;

grant execute on function public.request_batch_writing_limit_internal(
  uuid, integer, integer
) to authenticated;
grant execute on function public.list_batch_writing_limit_requests_internal(
  text, integer, timestamptz, uuid
) to authenticated;
grant execute on function public.decide_batch_writing_limit_internal(
  uuid, text, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic per-batch quota inside the existing durable submission transaction
-- ---------------------------------------------------------------------------

create or replace function app_private.consume_writing_submission_quota(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_student_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  default_daily_limit integer;
  batch_daily_limit integer;
  monthly_limit integer;
  consumed_batch_count integer;
  consumed_monthly_count integer;
  current_usage_day date := app_private.india_writing_usage_day(now());
  current_usage_month date :=
    date_trunc('month', now() at time zone 'UTC')::date;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or target_batch_id is null
    or target_student_id is null
    or caller_id <> target_student_id
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not exists (
    select 1
    from public.batch_students assignment
    join public.batches batch
      on batch.id = assignment.batch_id
     and batch.workspace_id = assignment.workspace_id
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
     and membership.user_id = assignment.student_id
     and membership.role = 'student'
    where assignment.workspace_id = target_workspace_id
      and assignment.batch_id = target_batch_id
      and assignment.student_id = target_student_id
      and batch.is_active
  ) then
    raise exception using
      errcode = '42501',
      message = 'active_batch_assignment_required';
  end if;

  select
    limits.max_submissions_per_student_workspace_day,
    limits.max_submissions_per_student_workspace_month
  into default_daily_limit, monthly_limit
  from app_private.writing_security_limits limits
  where limits.singleton;

  batch_daily_limit := app_private.current_batch_writing_daily_limit(
    target_workspace_id,
    target_batch_id
  );

  if default_daily_limit is null
    or monthly_limit is null
    or batch_daily_limit is null
  then
    raise exception using
      errcode = '55000',
      message = 'writing_quota_unavailable';
  end if;

  insert into app_private.writing_submission_batch_daily_usage as usage (
    workspace_id,
    batch_id,
    student_id,
    usage_day,
    submission_count
  ) values (
    target_workspace_id,
    target_batch_id,
    target_student_id,
    current_usage_day,
    1
  )
  on conflict (workspace_id, batch_id, student_id, usage_day) do update
  set submission_count = usage.submission_count + 1,
      updated_at = now()
  where usage.submission_count < batch_daily_limit
  returning usage.submission_count into consumed_batch_count;

  if consumed_batch_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_daily_quota_exceeded';
  end if;

  insert into app_private.writing_submission_monthly_usage as usage (
    workspace_id,
    student_id,
    usage_month,
    submission_count
  ) values (
    target_workspace_id,
    target_student_id,
    current_usage_month,
    1
  )
  on conflict (workspace_id, student_id, usage_month) do update
  set submission_count = usage.submission_count + 1,
      updated_at = now()
  where usage.submission_count < monthly_limit
  returning usage.submission_count into consumed_monthly_count;

  if consumed_monthly_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_monthly_quota_exceeded';
  end if;

  return consumed_batch_count;
end;
$$;

revoke all on function app_private.consume_writing_submission_quota(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

-- Both direct submission and draft submission enter this same transaction.
-- Passing target_batch_id here therefore gives both paths the exact approved
-- class context before any job or PGMQ message can commit.
create or replace function public.create_writing_submission(
  target_question_source text,
  target_question_id uuid,
  target_batch_id uuid,
  answer_text text,
  save_as_draft boolean default false
)
returns table (
  submission_id uuid,
  feedback_mode text,
  feedback_scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  created_submission record;
  selected_workspace_id uuid;
  selected_student_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_batch_id is null then
    raise exception using errcode = '22023', message = 'Select a batch before submitting writing.';
  end if;

  if not coalesce(save_as_draft, false) then
    perform app_private.lock_writing_submission_source_context(
      target_batch_id,
      target_question_source,
      target_question_id
    );
  end if;

  select created.*
  into created_submission
  from app_private.create_writing_submission_internal(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  ) created;

  if not coalesce(save_as_draft, false) then
    select submission.workspace_id, submission.student_id
    into selected_workspace_id, selected_student_id
    from public.submissions submission
    where submission.id = created_submission.submission_id;

    if selected_workspace_id is null or selected_student_id <> caller_id then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;

    perform app_private.capture_writing_evaluation_context(
      created_submission.submission_id
    );

    perform app_private.consume_writing_submission_quota(
      selected_workspace_id,
      target_batch_id,
      selected_student_id
    );

    update public.submissions submission
    set
      evaluation_status = 'queued',
      release_status = case
        when created_submission.feedback_mode = 'automatic_delayed' then 'scheduled'
        else 'held'
      end,
      release_at = case
        when created_submission.feedback_mode = 'automatic_delayed'
          then created_submission.feedback_scheduled_at
        else null
      end,
      evaluation_version = greatest(submission.evaluation_version, 1),
      feedback_started_at = null,
      feedback_completed_at = null,
      feedback_error = null
    where submission.id = created_submission.submission_id;

    perform *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      created_submission.submission_id,
      1,
      format('writing:%s:%s', created_submission.submission_id, 1),
      caller_id,
      0
    );
  end if;

  return query
  select
    created_submission.submission_id,
    created_submission.feedback_mode,
    created_submission.feedback_scheduled_at;
end;
$$;

revoke all on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
) from public, anon;
grant execute on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
) to authenticated;

-- Keep the historical private signature only as a fail-closed compatibility
-- bridge for old server-side callers and regression tests. It can resolve a
-- class only when the student has exactly one active assignment; every current
-- direct/draft browser path calls the explicit three-argument function above.
create or replace function app_private.consume_writing_submission_quota(
  target_workspace_id uuid,
  target_student_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_batch_id uuid;
  matching_batch_count integer;
begin
  select min(assignment.batch_id::text)::uuid, count(*)::integer
  into selected_batch_id, matching_batch_count
  from public.batch_students assignment
  join public.batches batch
    on batch.id = assignment.batch_id
   and batch.workspace_id = assignment.workspace_id
   and batch.is_active
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id;

  if matching_batch_count <> 1 or selected_batch_id is null then
    raise exception using
      errcode = '42501',
      message = 'explicit_batch_context_required';
  end if;

  return app_private.consume_writing_submission_quota(
    target_workspace_id,
    selected_batch_id,
    target_student_id
  );
end;
$$;

revoke all on function app_private.consume_writing_submission_quota(uuid, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deliberately exposed read model and API facade
-- ---------------------------------------------------------------------------

-- This helper keeps all current/pending limit tables private while giving the
-- existing SECURITY INVOKER batch page one authorized, bounded read model.
create or replace function public.list_batch_writing_limit_summary_internal(
  target_workspace_id uuid
)
returns table (
  batch_id uuid,
  current_writing_daily_limit integer,
  pending_writing_limit_request_id uuid,
  pending_writing_limit_request_status text,
  pending_writing_daily_limit integer,
  pending_writing_limit_request_revision integer
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using
      errcode = '22023',
      message = 'workspace_required';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  return query
  select
    batch.id,
    app_private.current_batch_writing_daily_limit(
      batch.workspace_id,
      batch.id
    ),
    pending_request.id,
    pending_request.status,
    pending_request.requested_limit::integer,
    pending_request.revision
  from public.batches batch
  left join app_private.batch_writing_limit_requests pending_request
    on pending_request.workspace_id = batch.workspace_id
   and pending_request.batch_id = batch.id
   and pending_request.status = 'pending'
  where batch.workspace_id = target_workspace_id;
end;
$$;

revoke all on function public.list_batch_writing_limit_summary_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_batch_writing_limit_summary_internal(uuid)
to authenticated;

-- Preserve the established six-argument class page contract and enrich each
-- item with approved/pending limits. Filters, exact counts, and keyset
-- pagination still execute before enrichment.
create or replace function api.list_workspace_batches_page(
  target_workspace_id uuid,
  requested_page_size integer,
  cursor_created_at timestamptz,
  cursor_id uuid,
  target_status text,
  target_level text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  workspace_total bigint;
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
  then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if target_status is null
    or target_status not in ('active', 'inactive', 'all')
  then
    raise exception using errcode = '22023', message = 'invalid_batch_status';
  end if;

  if target_level is not null
    and target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using errcode = '22023', message = 'invalid_batch_level';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select
    count(*)::bigint,
    count(*) filter (
      where (
        target_status = 'all'
        or batch.is_active = (target_status = 'active')
      )
        and (target_level is null or batch.level = target_level)
    )::bigint
  into workspace_total, exact_total
  from public.batches batch
  where batch.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select
      batch.id,
      batch.workspace_id,
      batch.name,
      batch.level,
      batch.description,
      batch.is_active,
      batch.join_requires_approval,
      batch.feedback_mode,
      batch.feedback_delay_min_minutes,
      batch.feedback_delay_max_minutes,
      batch.created_by,
      batch.created_at,
      batch.updated_at
    from public.batches batch
    where batch.workspace_id = target_workspace_id
      and (
        target_status = 'all'
        or batch.is_active = (target_status = 'active')
      )
      and (target_level is null or batch.level = target_level)
      and (
        cursor_created_at is null
        or (batch.created_at, batch.id) < (cursor_created_at, cursor_id)
      )
    order by batch.created_at desc, batch.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by created_at desc, id desc
    limit requested_page_size
  ),
  join_codes as materialized (
    select join_code.*
    from public.list_workspace_batch_join_codes(target_workspace_id) join_code
    join page_rows page on page.id = join_code.batch_id
  ),
  writing_limits as materialized (
    select writing_limit.*
    from public.list_batch_writing_limit_summary_internal(
      target_workspace_id
    ) writing_limit
    join page_rows page on page.id = writing_limit.batch_id
  ),
  enriched_rows as materialized (
    select
      page.id,
      page.workspace_id,
      page.name,
      page.level,
      page.description,
      page.is_active,
      join_codes.join_code,
      join_codes.join_code_enabled,
      page.join_requires_approval,
      page.feedback_mode,
      page.feedback_delay_min_minutes,
      page.feedback_delay_max_minutes,
      page.created_by,
      page.created_at,
      page.updated_at,
      writing_limits.current_writing_daily_limit,
      writing_limits.pending_writing_limit_request_id,
      writing_limits.pending_writing_limit_request_status,
      writing_limits.pending_writing_daily_limit,
      writing_limits.pending_writing_limit_request_revision,
      (
        select count(*)::integer
        from public.batch_students assignment
        where assignment.workspace_id = page.workspace_id
          and assignment.batch_id = page.id
      ) as student_count,
      (
        select count(*)::integer
        from public.submissions submission
        where submission.workspace_id = page.workspace_id
          and submission.batch_id = page.id
      ) as submission_count
    from page_rows page
    join join_codes on join_codes.batch_id = page.id
    join writing_limits on writing_limits.batch_id = page.id
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(enriched)
          order by enriched.created_at desc, enriched.id desc
        )
        from enriched_rows enriched
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'created_at', page.created_at,
          'id', page.id
        )
        from page_rows page
        order by page.created_at asc, page.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'unfiltered_total_count', workspace_total,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

revoke all on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) to authenticated;

comment on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) is
  'Teacher-only keyset class page. Each item includes the current approved writing limit and at most one revision-safe pending request.';

create or replace function api.request_batch_writing_limit(
  out request_id uuid,
  out workspace_id uuid,
  inout batch_id uuid,
  in requested_limit integer,
  in expected_revision integer,
  out current_writing_daily_limit integer,
  out requested_writing_daily_limit integer,
  out request_status text,
  out request_revision integer,
  out requested_at timestamptz,
  out updated_at timestamptz
)
returns setof record
language sql
security invoker
set search_path = ''
volatile
as $$
  select *
  from public.request_batch_writing_limit_internal($1, $2, $3);
$$;

create or replace function api.list_batch_writing_limit_requests(
  status text default null,
  page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.list_batch_writing_limit_requests_internal($1, $2, $3, $4);
$$;

create or replace function api.decide_batch_writing_limit(
  inout request_id uuid,
  in decision text,
  in expected_revision integer,
  out workspace_id uuid,
  out batch_id uuid,
  out request_status text,
  out request_revision integer,
  out previous_writing_daily_limit integer,
  out current_writing_daily_limit integer,
  out requested_writing_daily_limit integer,
  out decided_at timestamptz,
  out decided_by uuid
)
returns setof record
language sql
security invoker
set search_path = ''
volatile
as $$
  select *
  from public.decide_batch_writing_limit_internal($1, $2, $3);
$$;

revoke all on function api.request_batch_writing_limit(uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.list_batch_writing_limit_requests(
  text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api.decide_batch_writing_limit(uuid, text, integer)
from public, anon, authenticated, service_role;

grant execute on function api.request_batch_writing_limit(uuid, integer, integer)
to authenticated;
grant execute on function api.list_batch_writing_limit_requests(
  text, integer, timestamptz, uuid
) to authenticated;
grant execute on function api.decide_batch_writing_limit(uuid, text, integer)
to authenticated;

comment on function api.request_batch_writing_limit(uuid, integer, integer) is
  'Owner/teacher requests a different 1..10 evaluated-writing daily limit for an active class. expected_revision is 0 for a new request.';
comment on function api.list_batch_writing_limit_requests(
  text, integer, timestamptz, uuid
) is
  'AAL2 platform-admin keyset page of private class writing-limit requests.';
comment on function api.decide_batch_writing_limit(uuid, text, integer) is
  'Fresh-MFA platform-admin approval/rejection. The decision is revision-safe, immutable-audited, and lost-response idempotent.';

notify pgrst, 'reload schema';
