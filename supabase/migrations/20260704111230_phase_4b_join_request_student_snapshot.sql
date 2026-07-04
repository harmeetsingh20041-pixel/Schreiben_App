-- Keep pending join request displays useful without broadening profile RLS.

alter table public.batch_join_requests
add column student_email text,
add column student_name text;

update public.batch_join_requests bjr
set
  student_email = lower(btrim(p.email)),
  student_name = p.full_name
from public.profiles p
where p.id = bjr.student_id;

alter table public.batch_join_requests
alter column student_email set not null,
add constraint batch_join_requests_student_email_check
  check (student_email = lower(btrim(student_email)) and position('@' in student_email) > 1);

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
  caller_profile public.profiles%rowtype;
  new_request_id uuid;
  new_status text;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  select *
  into caller_profile
  from public.profiles p
  where p.id = caller_id;

  if caller_profile.id is null then
    raise exception 'Profile not found.';
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
    returning id into new_request_id;

    new_status := 'pending';
  else
    insert into public.batch_join_requests (
      workspace_id,
      batch_id,
      student_id,
      student_email,
      student_name,
      status,
      decided_by,
      decided_at
    )
    values (
      batch_record.workspace_id,
      batch_record.id,
      caller_id,
      lower(btrim(caller_profile.email)),
      caller_profile.full_name,
      'approved',
      caller_id,
      now()
    )
    returning id into new_request_id;

    new_status := 'approved';

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
