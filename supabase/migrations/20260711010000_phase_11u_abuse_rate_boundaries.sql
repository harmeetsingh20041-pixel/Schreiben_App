-- Phase 11U: bound authenticated abuse of privileged practice-worker wakeups
-- and batch-code guessing without weakening durable recovery or join approval.

-- ---------------------------------------------------------------------------
-- Private, transactional rate-limit state
-- ---------------------------------------------------------------------------

create table app_private.abuse_security_limits (
  singleton boolean primary key default true check (singleton),
  max_practice_kicks_per_actor_kind_minute smallint not null default 6
    check (max_practice_kicks_per_actor_kind_minute between 1 and 60),
  max_batch_join_attempts_per_actor_minute smallint not null default 6
    check (max_batch_join_attempts_per_actor_minute between 1 and 60),
  updated_at timestamptz not null default now()
);

insert into app_private.abuse_security_limits (singleton)
values (true)
on conflict (singleton) do nothing;

create table app_private.practice_processor_kick_windows (
  actor_id uuid not null references public.profiles(id) on delete cascade,
  worker_kind text not null check (
    worker_kind in ('worksheet_generation', 'worksheet_answer_evaluation')
  ),
  window_started_at timestamptz not null,
  kick_count integer not null default 0 check (kick_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (actor_id, worker_kind, window_started_at)
);

create index practice_processor_kick_windows_cleanup_idx
on app_private.practice_processor_kick_windows (window_started_at);

create table app_private.batch_join_attempt_windows (
  actor_id uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (actor_id, window_started_at)
);

create index batch_join_attempt_windows_cleanup_idx
on app_private.batch_join_attempt_windows (window_started_at);

alter table app_private.abuse_security_limits enable row level security;
alter table app_private.practice_processor_kick_windows enable row level security;
alter table app_private.batch_join_attempt_windows enable row level security;

revoke all on table app_private.abuse_security_limits
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_processor_kick_windows
from public, anon, authenticated, service_role;
revoke all on table app_private.batch_join_attempt_windows
from public, anon, authenticated, service_role;

-- Only a service-role facade may turn a verified actor into a privileged
-- practice-worker wakeup. The per-kind key prevents one type of practice work
-- from starving the other, while each window is atomic under concurrent RPCs.
create or replace function public.authorize_practice_processor_kick_internal(
  target_actor_id uuid,
  target_worker_kind text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  kick_limit integer;
  current_window timestamptz := date_trunc('minute', now());
  retention_floor timestamptz := current_window - interval '15 minutes';
  consumed_count integer;
begin
  perform app_private.assert_service_role();

  if target_worker_kind is null or target_worker_kind not in (
    'worksheet_generation',
    'worksheet_answer_evaluation'
  ) then
    return 'invalid_worker_kind';
  end if;

  if target_actor_id is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = target_actor_id
      and (
        profile.global_role = 'platform_admin'
        or exists (
          select 1
          from public.workspace_members membership
          where membership.user_id = target_actor_id
            and membership.role in ('owner', 'teacher', 'student')
        )
      )
  ) then
    return 'inactive_actor';
  end if;

  select limits.max_practice_kicks_per_actor_kind_minute
  into kick_limit
  from app_private.abuse_security_limits limits
  where limits.singleton;

  if kick_limit is null then
    return 'unavailable';
  end if;

  -- Retain only the current and previous 15 minute buckets for this actor and
  -- worker kind. The primary-key prefix keeps concurrent actors independent;
  -- at most 16 buckets remain for a continuously active actor/kind.
  delete from app_private.practice_processor_kick_windows usage_window
  where usage_window.actor_id = target_actor_id
    and usage_window.worker_kind = target_worker_kind
    and usage_window.window_started_at < retention_floor;

  insert into app_private.practice_processor_kick_windows (
    actor_id,
    worker_kind,
    window_started_at,
    kick_count
  ) values (
    target_actor_id,
    target_worker_kind,
    current_window,
    1
  )
  on conflict (actor_id, worker_kind, window_started_at) do update
  set kick_count = app_private.practice_processor_kick_windows.kick_count + 1,
      updated_at = now()
  where app_private.practice_processor_kick_windows.kick_count < kick_limit
  returning kick_count into consumed_count;

  if consumed_count is null then
    return 'rate_limited';
  end if;

  return 'allowed';
end;
$$;

revoke all on function public.authorize_practice_processor_kick_internal(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.authorize_practice_processor_kick_internal(uuid, text)
to service_role;

create or replace function api.authorize_practice_processor_kick(
  target_actor_id uuid,
  target_worker_kind text
)
returns text
language sql
security invoker
set search_path = ''
as $$
  select public.authorize_practice_processor_kick_internal(
    target_actor_id,
    target_worker_kind
  );
$$;

revoke all on function api.authorize_practice_processor_kick(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function api.authorize_practice_processor_kick(uuid, text)
to service_role;

create or replace function app_private.consume_batch_join_attempt(
  target_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  attempt_limit integer;
  current_window timestamptz := date_trunc('minute', now());
  retention_floor timestamptz := current_window - interval '15 minutes';
  consumed_count integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_actor_id is null or target_actor_id <> caller_id then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select limits.max_batch_join_attempts_per_actor_minute
  into attempt_limit
  from app_private.abuse_security_limits limits
  where limits.singleton;

  if attempt_limit is null then
    return 'unavailable';
  end if;

  -- Join attempts keep the current and previous 15 minute buckets only for
  -- this actor. The actor-first primary key prevents cross-user cleanup scans.
  delete from app_private.batch_join_attempt_windows usage_window
  where usage_window.actor_id = target_actor_id
    and usage_window.window_started_at < retention_floor;

  insert into app_private.batch_join_attempt_windows (
    actor_id,
    window_started_at,
    attempt_count
  ) values (
    target_actor_id,
    current_window,
    1
  )
  on conflict (actor_id, window_started_at) do update
  set attempt_count = app_private.batch_join_attempt_windows.attempt_count + 1,
      updated_at = now()
  where app_private.batch_join_attempt_windows.attempt_count < attempt_limit
  returning attempt_count into consumed_count;

  if consumed_count is null then
    return 'rate_limited';
  end if;

  return 'allowed';
end;
$$;

revoke all on function app_private.consume_batch_join_attempt(uuid)
from public, anon, authenticated, service_role;

-- Invalid and valid codes take the same private lookup path only after the
-- actor's attempt window has been consumed. Invalid/inactive codes return no
-- identifying row so the counter can commit; once full, a stable, user-safe
-- program-limit error is returned without touching the secret code table.
create or replace function app_private.request_join_batch_by_code_internal(
  join_code text
)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  batch_name text,
  level text,
  status text,
  requires_approval boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  clean_code text;
  batch_record public.batches%rowtype;
  existing_request public.batch_join_requests%rowtype;
  caller_profile public.profiles%rowtype;
  new_request_id uuid;
  new_status text;
  join_attempt_status text;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select p.*
  into caller_profile
  from public.profiles p
  where p.id = caller_id;

  if caller_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Profile not found.';
  end if;

  join_attempt_status := app_private.consume_batch_join_attempt(caller_id);
  if join_attempt_status = 'rate_limited' then
    raise exception using
      errcode = '54000',
      message = 'batch_join_attempt_rate_limited';
  elsif join_attempt_status <> 'allowed' then
    raise exception using
      errcode = '55000',
      message = 'batch_join_attempt_limit_unavailable';
  end if;

  -- Returning no row keeps malformed and unknown codes indistinguishable and,
  -- unlike an exception, commits the already-consumed attempt window.
  if join_code is null or octet_length(join_code) > 64 then
    return;
  end if;
  clean_code := regexp_replace(upper(btrim(join_code)), '[^A-Z0-9]', '', 'g');
  if clean_code is null or length(clean_code) < 8 then
    return;
  end if;

  select b.*
  into batch_record
  from app_private.batch_join_codes bjc
  join public.batches b on b.id = bjc.batch_id
  where bjc.join_code = clean_code
    and bjc.enabled
    and b.join_code_enabled
    and b.is_active
  for share of b;

  if batch_record.id is null then
    return;
  end if;

  select bjr.*
  into existing_request
  from public.batch_join_requests bjr
  where bjr.batch_id = batch_record.id
    and bjr.student_id = caller_id
    and bjr.status in ('pending', 'approved')
  order by bjr.requested_at desc
  limit 1
  for update;

  if existing_request.id is not null then
    request_id := existing_request.id;
    workspace_id := existing_request.workspace_id;
    batch_id := existing_request.batch_id;
    batch_name := batch_record.name;
    level := batch_record.level;
    status := existing_request.status;
    requires_approval := true;
    return next;
    return;
  end if;

  insert into public.batch_join_requests (
    workspace_id,
    batch_id,
    student_id,
    student_email,
    student_name,
    status
  )
  values (
    batch_record.workspace_id,
    batch_record.id,
    caller_id,
    lower(btrim(caller_profile.email)),
    caller_profile.full_name,
    'pending'
  )
  on conflict do nothing
  returning id into new_request_id;

  new_status := 'pending';

  if new_request_id is null then
    select bjr.*
    into existing_request
    from public.batch_join_requests bjr
    where bjr.batch_id = batch_record.id
      and bjr.student_id = caller_id
      and bjr.status in ('pending', 'approved')
    order by bjr.requested_at desc
    limit 1
    for update;

    if existing_request.id is null then
      raise exception using
        errcode = '40001',
        message = 'The join request changed. Please try again.';
    end if;

    new_request_id := existing_request.id;
    new_status := existing_request.status;
  end if;

  request_id := new_request_id;
  workspace_id := batch_record.workspace_id;
  batch_id := batch_record.id;
  batch_name := batch_record.name;
  level := batch_record.level;
  status := new_status;
  requires_approval := true;
  return next;
end;
$$;

revoke all on function app_private.request_join_batch_by_code_internal(text)
from public, anon, authenticated, service_role;

comment on table app_private.practice_processor_kick_windows is
  'Private per-actor/per-practice-worker minute windows. Each authorized consumer call opportunistically retains only the current and prior 15 minutes for that actor/kind.';
comment on table app_private.batch_join_attempt_windows is
  'Private per-actor batch-code attempt windows. Each join attempt opportunistically retains only the current and prior 15 minutes for that actor; no code or lookup result is stored.';
comment on function api.authorize_practice_processor_kick(uuid, text) is
  'Service-only authorization for a best-effort practice worker wakeup; durable recovery remains authoritative.';

notify pgrst, 'reload schema';
