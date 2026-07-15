-- Ordinary optimistic-lock conflicts are precondition failures at the browser
-- boundary, not retryable database serialization failures. Keep SQLSTATE 40001
-- inside the privileged implementations, but translate only the exact draft
-- revision conflict to PostgREST's HTTP 412 code in exposed API wrappers.

create or replace function api.save_writing_draft(
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  expected_revision integer
)
returns table (
  saved_draft_id uuid,
  workspace_id uuid,
  saved_revision integer,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.save_writing_draft_internal(
    draft_id,
    batch_id,
    source_type,
    source_id,
    "text",
    expected_revision
  );
exception
  when sqlstate '40001' then
    if sqlerrm = 'draft_revision_conflict' then
      raise exception using
        errcode = 'PT412',
        message = 'draft_revision_conflict';
    end if;
    raise;
end;
$$;

create or replace function api.submit_writing_draft(
  target_draft_id uuid,
  expected_revision integer
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text,
  release_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.submit_writing_draft_internal(
    target_draft_id,
    expected_revision
  );
exception
  when sqlstate '40001' then
    if sqlerrm = 'draft_revision_conflict' then
      raise exception using
        errcode = 'PT412',
        message = 'draft_revision_conflict';
    end if;
    raise;
end;
$$;

create or replace function api.save_practice_draft(
  target_assignment_id uuid,
  submitted_answers jsonb,
  expected_revision integer
)
returns table (
  draft_id uuid,
  assignment_id uuid,
  saved_revision integer,
  answers jsonb,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.save_practice_draft_internal(
    target_assignment_id,
    submitted_answers,
    expected_revision
  );
exception
  when sqlstate '40001' then
    if sqlerrm = 'draft_revision_conflict' then
      raise exception using
        errcode = 'PT412',
        message = 'draft_revision_conflict';
    end if;
    raise;
end;
$$;

-- Preserve the latest submit-then-readback implementation so students never
-- receive provisional practice scores while adding the same conflict boundary.
create or replace function api.submit_practice_attempt(
  target_assignment_id uuid,
  expected_revision integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  internal_result jsonb;
  safe_result jsonb;
begin
  select public.submit_practice_draft_internal(
    target_assignment_id,
    expected_revision
  )
  into internal_result;

  if internal_result is null then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_failed';
  end if;

  select api.get_practice_assignment_summary(target_assignment_id)
  into safe_result;

  if safe_result is null then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_readback_failed';
  end if;

  return safe_result;
exception
  when sqlstate '40001' then
    if sqlerrm = 'draft_revision_conflict' then
      raise exception using
        errcode = 'PT412',
        message = 'draft_revision_conflict';
    end if;
    raise;
end;
$$;

revoke all on function api.save_writing_draft(
  uuid, uuid, text, uuid, text, integer
) from public, anon;
revoke all on function api.submit_writing_draft(uuid, integer)
from public, anon;
revoke all on function api.save_practice_draft(uuid, jsonb, integer)
from public, anon;
revoke all on function api.submit_practice_attempt(uuid, integer)
from public, anon;

grant execute on function api.save_writing_draft(
  uuid, uuid, text, uuid, text, integer
) to authenticated;
grant execute on function api.submit_writing_draft(uuid, integer)
to authenticated;
grant execute on function api.save_practice_draft(uuid, jsonb, integer)
to authenticated;
grant execute on function api.submit_practice_attempt(uuid, integer)
to authenticated;

comment on function api.save_writing_draft(
  uuid, uuid, text, uuid, text, integer
) is
  'Invoker boundary for revision-safe writing autosave. Exact draft conflicts return PT412; unrelated 40001 errors are rethrown.';
comment on function api.submit_writing_draft(uuid, integer) is
  'Invoker boundary for revision-safe writing submission. Exact draft conflicts return PT412; unrelated 40001 errors are rethrown.';
comment on function api.save_practice_draft(uuid, jsonb, integer) is
  'Invoker boundary for revision-safe practice autosave. Exact draft conflicts return PT412; unrelated 40001 errors are rethrown.';
comment on function api.submit_practice_attempt(uuid, integer) is
  'Submits a revision-locked practice draft and returns a score-safe read model. Exact draft conflicts return PT412.';

notify pgrst, 'reload schema';
