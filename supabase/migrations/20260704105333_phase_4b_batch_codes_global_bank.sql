-- Phase 4B: primary batch-code joining plus a read-only global question bank.

alter table public.batches
add column join_code text,
add column join_code_enabled boolean not null default true,
add column join_requires_approval boolean not null default true;

create or replace function app_private.generate_batch_join_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate text;
begin
  loop
    candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (
      select 1
      from public.batches b
      where b.join_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

revoke all on function app_private.generate_batch_join_code() from public, anon, authenticated;

create or replace function public.normalize_batch_join_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  code_write_allowed boolean :=
    coalesce(current_setting('app.allow_batch_join_code_write', true), '') = '1';
begin
  if tg_op = 'UPDATE'
    and new.join_code is distinct from old.join_code
    and not code_write_allowed
    and not app_private.is_platform_admin()
  then
    raise exception 'Batch join codes must be rotated through the secure RPC.';
  end if;

  if tg_op = 'INSERT' and not code_write_allowed then
    new.join_code := app_private.generate_batch_join_code();
  elsif new.join_code is null or btrim(new.join_code) = '' then
    new.join_code := app_private.generate_batch_join_code();
  else
    new.join_code := regexp_replace(upper(btrim(new.join_code)), '[^A-Z0-9]', '', 'g');
  end if;

  if length(new.join_code) < 8 then
    raise exception 'Batch join code must be at least 8 characters.';
  end if;

  return new;
end;
$$;

revoke all on function public.normalize_batch_join_code() from public, anon;
grant execute on function public.normalize_batch_join_code() to authenticated;

update public.batches
set join_code = app_private.generate_batch_join_code()
where join_code is null;

alter table public.batches
alter column join_code set not null,
add constraint batches_join_code_format_check
  check (join_code ~ '^[A-Z0-9]{8,16}$');

create unique index batches_join_code_key
on public.batches (join_code);

create index batches_join_code_lookup_idx
on public.batches (join_code)
where join_code_enabled = true and is_active = true;

drop trigger if exists batches_normalize_join_code on public.batches;
create trigger batches_normalize_join_code
before insert or update of join_code on public.batches
for each row execute function public.normalize_batch_join_code();

create table public.batch_join_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null)
    or status in ('pending', 'cancelled')
  )
);

create unique index batch_join_requests_pending_or_approved_idx
on public.batch_join_requests (batch_id, student_id)
where status in ('pending', 'approved');

create index batch_join_requests_workspace_status_idx
on public.batch_join_requests (workspace_id, status, requested_at desc);

create index batch_join_requests_batch_status_idx
on public.batch_join_requests (batch_id, status, requested_at desc);

create index batch_join_requests_student_status_idx
on public.batch_join_requests (student_id, status, requested_at desc);

create or replace function public.validate_batch_join_request()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.batches b
    where b.id = new.batch_id
      and b.workspace_id = new.workspace_id
  ) then
    raise exception 'Join request batch must belong to the same workspace.';
  end if;

  return new;
end;
$$;

create trigger batch_join_requests_validate
before insert or update on public.batch_join_requests
for each row execute function public.validate_batch_join_request();

create trigger batch_join_requests_set_updated_at
before update on public.batch_join_requests
for each row execute function public.set_updated_at();

revoke all on function public.validate_batch_join_request() from public, anon;
grant execute on function public.validate_batch_join_request() to authenticated;

alter table public.batch_join_requests enable row level security;

grant select, insert, update, delete on public.batch_join_requests to authenticated;

create policy "batch_join_requests_select_self_or_workspace_teacher"
on public.batch_join_requests for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "batch_join_requests_insert_admin_only"
on public.batch_join_requests for insert
to authenticated
with check (public.is_platform_admin());

create policy "batch_join_requests_update_admin_only"
on public.batch_join_requests for update
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create policy "batch_join_requests_delete_admin_only"
on public.batch_join_requests for delete
to authenticated
using (public.is_platform_admin());

create or replace function app_private.apply_join_request_approval(
  target_request_id uuid,
  actor_id uuid
)
returns table (
  approved_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_record public.batch_join_requests%rowtype;
  new_membership_id uuid;
  new_batch_student_id uuid;
begin
  select *
  into request_record
  from public.batch_join_requests bjr
  where bjr.id = target_request_id;

  if request_record.id is null then
    raise exception 'Join request not found.';
  end if;

  if request_record.status not in ('pending', 'approved') then
    raise exception 'Only pending join requests can be approved.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (request_record.workspace_id, request_record.student_id, 'student')
  on conflict (workspace_id, user_id) do nothing
  returning id into new_membership_id;

  if new_membership_id is null then
    select wm.id
    into new_membership_id
    from public.workspace_members wm
    where wm.workspace_id = request_record.workspace_id
      and wm.user_id = request_record.student_id;
  end if;

  insert into public.batch_students (workspace_id, batch_id, student_id)
  values (request_record.workspace_id, request_record.batch_id, request_record.student_id)
  on conflict (batch_id, student_id) do nothing
  returning id into new_batch_student_id;

  if new_batch_student_id is null then
    select bs.id
    into new_batch_student_id
    from public.batch_students bs
    where bs.batch_id = request_record.batch_id
      and bs.student_id = request_record.student_id;
  end if;

  update public.batch_join_requests
  set
    status = 'approved',
    decided_by = coalesce(actor_id, request_record.decided_by),
    decided_at = coalesce(request_record.decided_at, now())
  where id = request_record.id;

  approved_request_id := request_record.id;
  workspace_id := request_record.workspace_id;
  batch_id := request_record.batch_id;
  student_id := request_record.student_id;
  membership_id := new_membership_id;
  batch_student_id := new_batch_student_id;
  status := 'approved';
  return next;
end;
$$;

revoke all on function app_private.apply_join_request_approval(uuid, uuid) from public, anon, authenticated;

create or replace function app_private.request_join_batch_by_code_internal(join_code text)
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
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  clean_code text := regexp_replace(upper(btrim(join_code)), '[^A-Z0-9]', '', 'g');
  batch_record public.batches%rowtype;
  existing_request public.batch_join_requests%rowtype;
  new_request_id uuid;
  new_status text;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  if clean_code is null or length(clean_code) < 8 then
    raise exception 'Enter a valid batch code.';
  end if;

  select *
  into batch_record
  from public.batches b
  where b.join_code = clean_code
    and b.join_code_enabled = true
    and b.is_active = true;

  if batch_record.id is null then
    raise exception 'Batch code was not found or is inactive.';
  end if;

  select *
  into existing_request
  from public.batch_join_requests bjr
  where bjr.batch_id = batch_record.id
    and bjr.student_id = caller_id
    and bjr.status in ('pending', 'approved')
  order by bjr.requested_at desc
  limit 1;

  if existing_request.id is not null then
    request_id := existing_request.id;
    workspace_id := existing_request.workspace_id;
    batch_id := existing_request.batch_id;
    batch_name := batch_record.name;
    level := batch_record.level;
    status := existing_request.status;
    requires_approval := batch_record.join_requires_approval;
    return next;
    return;
  end if;

  if batch_record.join_requires_approval then
    insert into public.batch_join_requests (
      workspace_id,
      batch_id,
      student_id,
      status
    )
    values (
      batch_record.workspace_id,
      batch_record.id,
      caller_id,
      'pending'
    )
    returning id, status into new_request_id, new_status;
  else
    insert into public.batch_join_requests (
      workspace_id,
      batch_id,
      student_id,
      status,
      decided_by,
      decided_at
    )
    values (
      batch_record.workspace_id,
      batch_record.id,
      caller_id,
      'approved',
      caller_id,
      now()
    )
    returning id, status into new_request_id, new_status;

    perform *
    from app_private.apply_join_request_approval(new_request_id, caller_id);
  end if;

  request_id := new_request_id;
  workspace_id := batch_record.workspace_id;
  batch_id := batch_record.id;
  batch_name := batch_record.name;
  level := batch_record.level;
  status := new_status;
  requires_approval := batch_record.join_requires_approval;
  return next;
end;
$$;

create or replace function public.request_join_batch_by_code(join_code text)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  batch_name text,
  level text,
  status text,
  requires_approval boolean
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.request_join_batch_by_code_internal(join_code);
$$;

revoke all on function app_private.request_join_batch_by_code_internal(text) from public, anon;
grant execute on function app_private.request_join_batch_by_code_internal(text) to authenticated;

revoke all on function public.request_join_batch_by_code(text) from public, anon;
grant execute on function public.request_join_batch_by_code(text) to authenticated;

create or replace function app_private.approve_batch_join_request_internal(target_request_id uuid)
returns table (
  approved_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  request_workspace_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  select bjr.workspace_id
  into request_workspace_id
  from public.batch_join_requests bjr
  where bjr.id = target_request_id;

  if request_workspace_id is null then
    raise exception 'Join request not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(request_workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.';
  end if;

  return query
  select *
  from app_private.apply_join_request_approval(target_request_id, caller_id);
end;
$$;

create or replace function public.approve_batch_join_request(request_id uuid)
returns table (
  approved_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  status text
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.approve_batch_join_request_internal(request_id);
$$;

revoke all on function app_private.approve_batch_join_request_internal(uuid) from public, anon;
grant execute on function app_private.approve_batch_join_request_internal(uuid) to authenticated;

revoke all on function public.approve_batch_join_request(uuid) from public, anon;
grant execute on function public.approve_batch_join_request(uuid) to authenticated;

create or replace function app_private.reject_batch_join_request_internal(target_request_id uuid)
returns table (
  rejected_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  request_record public.batch_join_requests%rowtype;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  select *
  into request_record
  from public.batch_join_requests bjr
  where bjr.id = target_request_id;

  if request_record.id is null then
    raise exception 'Join request not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(request_record.workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.';
  end if;

  if request_record.status = 'approved' then
    raise exception 'Approved join requests cannot be rejected.';
  end if;

  if request_record.status <> 'rejected' then
    update public.batch_join_requests
    set
      status = 'rejected',
      decided_by = caller_id,
      decided_at = now()
    where id = request_record.id;
  end if;

  rejected_request_id := request_record.id;
  workspace_id := request_record.workspace_id;
  batch_id := request_record.batch_id;
  student_id := request_record.student_id;
  status := 'rejected';
  return next;
end;
$$;

create or replace function public.reject_batch_join_request(request_id uuid)
returns table (
  rejected_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  status text
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.reject_batch_join_request_internal(request_id);
$$;

revoke all on function app_private.reject_batch_join_request_internal(uuid) from public, anon;
grant execute on function app_private.reject_batch_join_request_internal(uuid) to authenticated;

revoke all on function public.reject_batch_join_request(uuid) from public, anon;
grant execute on function public.reject_batch_join_request(uuid) to authenticated;

create or replace function app_private.rotate_batch_join_code_internal(target_batch_id uuid)
returns table (
  batch_id uuid,
  join_code text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  target_workspace_id uuid;
  new_code text;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  select b.workspace_id
  into target_workspace_id
  from public.batches b
  where b.id = target_batch_id;

  if target_workspace_id is null then
    raise exception 'Batch not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.';
  end if;

  new_code := app_private.generate_batch_join_code();

  perform set_config('app.allow_batch_join_code_write', '1', true);

  update public.batches
  set
    join_code = new_code,
    join_code_enabled = true
  where id = target_batch_id
  returning id, public.batches.join_code into batch_id, join_code;

  return next;
end;
$$;

create or replace function public.rotate_batch_join_code(target_batch_id uuid)
returns table (
  batch_id uuid,
  join_code text
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.rotate_batch_join_code_internal(target_batch_id);
$$;

revoke all on function app_private.rotate_batch_join_code_internal(uuid) from public, anon;
grant execute on function app_private.rotate_batch_join_code_internal(uuid) to authenticated;

revoke all on function public.rotate_batch_join_code(uuid) from public, anon;
grant execute on function public.rotate_batch_join_code(uuid) to authenticated;

create table public.global_questions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  prompt text not null,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  topic text not null,
  task_type text not null check (
    task_type in (
      'email',
      'message',
      'description',
      'opinion',
      'apology',
      'invitation',
      'formal_letter',
      'free_text',
      'writing'
    )
  ),
  expected_word_min integer check (expected_word_min is null or expected_word_min >= 0),
  expected_word_max integer check (expected_word_max is null or expected_word_max >= 0),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes >= 0),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    expected_word_min is null
    or expected_word_max is null
    or expected_word_min <= expected_word_max
  )
);

create index global_questions_level_active_idx
on public.global_questions (level, is_active, created_at desc);

create index global_questions_topic_idx
on public.global_questions (topic);

create trigger global_questions_set_updated_at
before update on public.global_questions
for each row execute function public.set_updated_at();

alter table public.global_questions enable row level security;

grant select, insert, update, delete on public.global_questions to authenticated;

create policy "global_questions_select_active_members"
on public.global_questions for select
to authenticated
using (
  public.is_platform_admin()
  or (
    is_active = true
    and exists (
      select 1
      from public.workspace_members wm
      where wm.user_id = (select auth.uid())
    )
  )
);

create policy "global_questions_insert_platform_admin"
on public.global_questions for insert
to authenticated
with check (public.is_platform_admin());

create policy "global_questions_update_platform_admin"
on public.global_questions for update
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create policy "global_questions_delete_platform_admin"
on public.global_questions for delete
to authenticated
using (public.is_platform_admin());
