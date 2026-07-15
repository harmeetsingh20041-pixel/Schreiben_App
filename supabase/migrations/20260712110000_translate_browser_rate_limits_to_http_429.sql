-- Known quota, budget, and retry ceilings are normal browser-facing rate
-- limits, not HTTP 500 failures. Preserve SQLSTATE 54000 inside privileged
-- implementations and translate only exact, reviewed messages at exposed API
-- boundaries. Unknown 54000 errors are rethrown unchanged.

create or replace function api.submit_writing(
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text
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
declare
  created_submission record;
begin
  select created.*
  into created_submission
  from public.create_writing_submission(
    source_type,
    source_id,
    batch_id,
    "text",
    false
  ) created;

  return query
  select
    submission.id,
    submission.evaluation_status,
    submission.release_status,
    submission.release_at
  from public.submissions submission
  where submission.id = created_submission.submission_id;
exception
  when sqlstate '54000' then
    if sqlerrm in (
      'writing_daily_quota_exceeded',
      'writing_monthly_quota_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded',
      'student_ai_monthly_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
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
  when sqlstate '54000' then
    if sqlerrm in (
      'writing_daily_quota_exceeded',
      'writing_monthly_quota_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded',
      'student_ai_monthly_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

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
  when sqlstate '54000' then
    if sqlerrm in (
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

create or replace function api.retry_writing_evaluation(
  target_submission_id uuid
)
returns table (
  submission_id uuid,
  job_id uuid,
  evaluation_status text,
  release_status text,
  release_at timestamptz,
  job_created boolean,
  already_processing boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.retry_writing_evaluation(target_submission_id);
exception
  when sqlstate '54000' then
    if sqlerrm in (
      'writing_manual_retry_limit_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded',
      'student_ai_monthly_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

create or replace function api.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.request_practice_worksheet(target_assignment_id);
exception
  when sqlstate '54000' then
    if sqlerrm in (
      'worksheet_generation_retry_limit_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

create or replace function api.retry_practice_attempt_evaluation(
  target_attempt_id uuid
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  job_id uuid,
  evaluation_status text,
  job_created boolean,
  already_processing boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.retry_practice_attempt_evaluation(target_attempt_id);
exception
  when sqlstate '54000' then
    if sqlerrm in (
      'practice_manual_retry_limit_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

create or replace function api.request_batch_join(code text)
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
security invoker
set search_path = ''
as $$
begin
  return query
  select *
  from public.request_join_batch_by_code(code);
exception
  when sqlstate '54000' then
    if sqlerrm = 'batch_join_attempt_rate_limited' then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

revoke all on function api.submit_writing(uuid, text, uuid, text)
from public, anon;
revoke all on function api.submit_writing_draft(uuid, integer)
from public, anon;
revoke all on function api.submit_practice_attempt(uuid, integer)
from public, anon;
revoke all on function api.retry_writing_evaluation(uuid)
from public, anon;
revoke all on function api.request_practice_worksheet(uuid)
from public, anon;
revoke all on function api.retry_practice_attempt_evaluation(uuid)
from public, anon;
revoke all on function api.request_batch_join(text)
from public, anon;

grant execute on function api.submit_writing(uuid, text, uuid, text)
to authenticated;
grant execute on function api.submit_writing_draft(uuid, integer)
to authenticated;
grant execute on function api.submit_practice_attempt(uuid, integer)
to authenticated;
grant execute on function api.retry_writing_evaluation(uuid)
to authenticated;
grant execute on function api.request_practice_worksheet(uuid)
to authenticated;
grant execute on function api.retry_practice_attempt_evaluation(uuid)
to authenticated;
grant execute on function api.request_batch_join(text)
to authenticated;

comment on function api.submit_writing(uuid, text, uuid, text) is
  'Browser writing submission boundary. Exact quota and AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.submit_writing_draft(uuid, integer) is
  'Invoker boundary for revision-safe writing submission. Exact draft conflicts return PT412; unrelated 40001 errors are rethrown. Exact quota and AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.submit_practice_attempt(uuid, integer) is
  'Submits a revision-locked practice draft and returns a score-safe read model. Exact draft conflicts return PT412; unrelated 40001 errors are rethrown. Exact AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.retry_writing_evaluation(uuid) is
  'Browser writing retry boundary. Exact retry and AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.request_practice_worksheet(uuid) is
  'Browser worksheet request boundary. Exact retry and AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.retry_practice_attempt_evaluation(uuid) is
  'Browser practice retry boundary. Exact retry and AI-budget limits return PT429; unknown 54000 errors are rethrown.';
comment on function api.request_batch_join(text) is
  'Browser class-code boundary. Exact attempt throttling returns PT429; unknown 54000 errors are rethrown.';

notify pgrst, 'reload schema';
