-- An approved request represents an active class assignment, not a permanent
-- bypass of future teacher approval. Transfer, removal, and offboarding all
-- delete batch_students rows, so cancel the corresponding approval atomically.
create or replace function app_private.cancel_join_approval_after_assignment_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.batch_join_requests request
  set status = 'cancelled'
  where request.workspace_id = old.workspace_id
    and request.batch_id = old.batch_id
    and request.student_id = old.student_id
    and request.status = 'approved'
    and not exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = old.workspace_id
        and assignment.batch_id = old.batch_id
        and assignment.student_id = old.student_id
    );
  return old;
end;
$$;

revoke all on function app_private.cancel_join_approval_after_assignment_delete()
from public, anon, authenticated, service_role;

drop trigger if exists batch_students_cancel_stale_join_approval
on public.batch_students;
create trigger batch_students_cancel_stale_join_approval
after delete on public.batch_students
for each row execute function app_private.cancel_join_approval_after_assignment_delete();

-- Repair stale approvals created before this invariant existed. Decision
-- metadata remains intact for the audit trail; only the active state changes.
update public.batch_join_requests request
set status = 'cancelled'
where request.status = 'approved'
  and not exists (
    select 1
    from public.batch_students assignment
    where assignment.workspace_id = request.workspace_id
      and assignment.batch_id = request.batch_id
      and assignment.student_id = request.student_id
  );
