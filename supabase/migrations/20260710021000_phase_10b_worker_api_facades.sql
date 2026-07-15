-- Phase 10B: make every durable Edge worker compatible with an api-only
-- production Data API. These routines are deliberately exposed through the
-- api schema, but executable only by service_role. Browser roles receive no
-- worker lifecycle capability, raw writing loader, answer loader, or answer
-- key access.

-- Keep the underlying worker state transitions private from browser clients.
-- The public routines remain the transaction/authorization boundary and each
-- one independently asserts service_role before touching queues or drafts.

-- The loaders below are SECURITY INVOKER. Make their exact base-table read
-- dependencies explicit so a fresh production project does not depend on
-- historical Supabase default privileges. These grants do not expose public
-- when only api is configured as a Data API schema, and no browser role gets
-- them.
grant select on table
  public.submissions,
  public.batches,
  public.questions,
  public.global_questions,
  public.batch_students,
  public.student_practice_assignments,
  public.grammar_topics,
  public.practice_tests,
  public.practice_test_attempts,
  public.practice_test_questions,
  public.workspace_members
to service_role;

create or replace function api.claim_async_jobs(
  target_queue_name text,
  worker_id uuid,
  batch_size integer default 1,
  visibility_timeout_seconds integer default 180
)
returns table (
  job_id uuid,
  queue_message_id bigint,
  entity_id uuid,
  entity_version integer,
  attempt_number integer,
  lease_expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.claim_async_jobs(
    target_queue_name,
    worker_id,
    batch_size,
    visibility_timeout_seconds
  );
$$;

create or replace function api.fail_async_job(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  error_code text,
  retryable boolean default true
)
returns table (
  job_id uuid,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.fail_async_job(
    target_job_id,
    target_queue_message_id,
    worker_id,
    error_code,
    retryable
  );
$$;

create or replace function api.complete_writing_evaluation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  feedback jsonb
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.complete_writing_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    feedback
  );
$$;

create or replace function api.complete_worksheet_generation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.complete_worksheet_generation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    worksheet
  );
$$;

create or replace function api.complete_worksheet_answer_evaluation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.complete_worksheet_answer_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    result
  );
$$;

create or replace function api.reconcile_async_jobs(
  target_queue_name text default null
)
returns table (repaired_count integer, dead_count integer)
language sql
security invoker
set search_path = ''
as $$
  select * from public.reconcile_async_jobs(target_queue_name);
$$;

create or replace function api.release_due_feedback(batch_size integer default 100)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select public.release_due_feedback(batch_size);
$$;

-- One narrow loader replaces the writing worker's direct reads of submissions,
-- batches, workspace questions, and global questions. Raw student writing is
-- returned only to service_role and never appears in a browser-facing view.
create or replace function api.get_writing_evaluation_context(
  target_submission_id uuid
)
returns table (
  submission_id uuid,
  workspace_id uuid,
  original_text text,
  submission_status text,
  submission_mode text,
  submission_level text,
  batch_level text,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  select
    s.id,
    s.workspace_id,
    s.original_text,
    s.status,
    s.mode,
    s.level_detected,
    b.level,
    coalesce(q.title, gq.title),
    coalesce(q.prompt, gq.prompt),
    coalesce(q.level, gq.level),
    coalesce(q.topic, gq.topic)
  from public.submissions s
  left join public.batches b
    on b.id = s.batch_id
   and b.workspace_id = s.workspace_id
  left join public.questions q
    on s.question_source = 'workspace_question'
   and q.id = s.question_id
   and q.workspace_id = s.workspace_id
  left join public.global_questions gq
    on s.question_source = 'global_question'
   and gq.id = s.global_question_id
  where s.id = target_submission_id;
end;
$$;

-- Resolve all worksheet-generation database context in one service-only RPC.
-- Student identity is used only inside the database to exclude previously used
-- worksheets; it is intentionally absent from the returned contract.
create or replace function api.get_worksheet_generation_context(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  grammar_topic_id uuid,
  attached_practice_test_id uuid,
  assignment_status text,
  topic_name text,
  topic_slug text,
  topic_level text,
  topic_description text,
  active_batch_levels text[],
  reusable_practice_test_id uuid
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  with assignment_context as (
    select
      spa.id,
      spa.workspace_id,
      spa.student_id,
      spa.grammar_topic_id,
      spa.practice_test_id,
      spa.status,
      gt.name,
      gt.slug,
      gt.level,
      gt.description
    from public.student_practice_assignments spa
    join public.grammar_topics gt on gt.id = spa.grammar_topic_id
    where spa.id = target_assignment_id
  ),
  batch_context as (
    select
      ac.id as assignment_id,
      coalesce(
        array_agg(distinct upper(b.level) order by upper(b.level))
          filter (where b.level in ('A1', 'A2', 'B1', 'B2')),
        array[]::text[]
      ) as levels
    from assignment_context ac
    left join public.batch_students bs
      on bs.workspace_id = ac.workspace_id
     and bs.student_id = ac.student_id
    left join public.batches b
      on b.id = bs.batch_id
     and b.workspace_id = ac.workspace_id
     and b.is_active
    group by ac.id
  ),
  resolved_context as (
    select
      ac.*,
      bc.levels,
      case
        when upper(ac.level) in ('A1', 'A2', 'B1', 'B2') then upper(ac.level)
        when cardinality(bc.levels) = 1 then bc.levels[1]
        else null
      end as resolved_level
    from assignment_context ac
    join batch_context bc on bc.assignment_id = ac.id
  )
  select
    rc.id,
    rc.workspace_id,
    rc.grammar_topic_id,
    rc.practice_test_id,
    rc.status,
    rc.name,
    rc.slug,
    rc.level,
    rc.description,
    rc.levels,
    reusable.id
  from resolved_context rc
  left join lateral (
    select pt.id
    from public.practice_tests pt
    where pt.workspace_id = rc.workspace_id
      and pt.grammar_topic_id = rc.grammar_topic_id
      and pt.level = rc.resolved_level
      and pt.visibility = 'workspace'
      and pt.quality_status = 'approved'
      and pt.generation_source <> 'system_fallback'
      and (rc.practice_test_id is null or pt.id = rc.practice_test_id)
      and exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = pt.id
          and contract_question.answer_contract_version = 1
      )
      and not exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = pt.id
          and contract_question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior
        where prior.workspace_id = rc.workspace_id
          and prior.student_id = rc.student_id
          and prior.practice_test_id = pt.id
          and prior.id <> rc.id
      )
    order by pt.created_at desc, pt.id
    limit 1
  ) reusable on true;
end;
$$;

-- The answer worker needs raw answers and answer keys, but only for the claimed
-- attempt. The contract is a single explicit row plus an explicit question
-- field allowlist; no table or view containing answer keys is exposed.
create or replace function api.get_worksheet_answer_evaluation_context(
  target_attempt_id uuid
)
returns table (
  attempt_id uuid,
  practice_test_id uuid,
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  answers jsonb,
  attempt_status text,
  evaluation_status text,
  evaluation_version integer,
  assignment_grammar_topic_id uuid,
  assignment_practice_test_id uuid,
  assignment_latest_attempt_id uuid,
  assignment_status text,
  topic_name text,
  topic_slug text,
  topic_level text,
  topic_description text,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  questions jsonb,
  student_membership_active boolean
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  select
    pta.id,
    pta.practice_test_id,
    pta.assignment_id,
    pta.workspace_id,
    pta.student_id,
    pta.answers,
    pta.status,
    pta.evaluation_status,
    pta.evaluation_version,
    spa.grammar_topic_id,
    spa.practice_test_id,
    spa.latest_attempt_id,
    spa.status,
    gt.name,
    gt.slug,
    gt.level,
    gt.description,
    pt.title,
    pt.level,
    pt.difficulty,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', ptq.id,
          'question_number', ptq.question_number,
          'question_type', ptq.question_type,
          'evaluation_mode', ptq.evaluation_mode,
          'prompt', ptq.prompt,
          'correct_answer', ptq.correct_answer,
          'accepted_answers', ptq.accepted_answers,
          'rubric', ptq.rubric,
          'answer_contract_version', ptq.answer_contract_version,
          'explanation', ptq.explanation
        )
        order by ptq.question_number
      )
      from public.practice_test_questions ptq
      where ptq.practice_test_id = pta.practice_test_id
    ), '[]'::jsonb),
    exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = pta.workspace_id
        and wm.user_id = pta.student_id
        and wm.role = 'student'
    )
  from public.practice_test_attempts pta
  left join public.student_practice_assignments spa
    on spa.id = pta.assignment_id
   and spa.workspace_id = pta.workspace_id
   and spa.student_id = pta.student_id
  left join public.grammar_topics gt on gt.id = spa.grammar_topic_id
  left join public.practice_tests pt
    on pt.id = pta.practice_test_id
   and pt.workspace_id = pta.workspace_id
  where pta.id = target_attempt_id;
end;
$$;

-- Recheck immediately before a provider request so offboarding, superseding,
-- or assignment changes observed after the first context load stop the call.
create or replace function api.is_worksheet_answer_evaluation_current(
  target_attempt_id uuid,
  expected_version integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return exists (
    select 1
    from public.practice_test_attempts pta
    join public.student_practice_assignments spa
      on spa.id = pta.assignment_id
     and spa.workspace_id = pta.workspace_id
     and spa.student_id = pta.student_id
     and spa.practice_test_id = pta.practice_test_id
     and spa.latest_attempt_id = pta.id
     and spa.status in ('completed', 'passed', 'failed')
    join public.workspace_members wm
      on wm.workspace_id = pta.workspace_id
     and wm.user_id = pta.student_id
     and wm.role = 'student'
    where pta.id = target_attempt_id
      and pta.evaluation_status = 'evaluating'
      and pta.evaluation_version = expected_version
      and pta.status in ('submitted', 'checked')
  );
end;
$$;

-- New API functions inherit no grants because Phase 8B revoked API default
-- privileges. Revoke defensively, then grant only the server role.
revoke all on function api.claim_async_jobs(text, uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.fail_async_job(uuid, bigint, uuid, text, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated, service_role;
revoke all on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated, service_role;
revoke all on function api.complete_worksheet_answer_evaluation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated, service_role;
revoke all on function api.reconcile_async_jobs(text)
from public, anon, authenticated, service_role;
revoke all on function api.release_due_feedback(integer)
from public, anon, authenticated, service_role;
revoke all on function api.get_writing_evaluation_context(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.get_worksheet_generation_context(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.get_worksheet_answer_evaluation_context(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.is_worksheet_answer_evaluation_current(uuid, integer)
from public, anon, authenticated, service_role;

grant execute on function api.claim_async_jobs(text, uuid, integer, integer)
to service_role;
grant execute on function api.fail_async_job(uuid, bigint, uuid, text, boolean)
to service_role;
grant execute on function api.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
to service_role;
grant execute on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
to service_role;
grant execute on function api.complete_worksheet_answer_evaluation(uuid, bigint, uuid, jsonb)
to service_role;
grant execute on function api.reconcile_async_jobs(text)
to service_role;
grant execute on function api.release_due_feedback(integer)
to service_role;
grant execute on function api.get_writing_evaluation_context(uuid)
to service_role;
grant execute on function api.get_worksheet_generation_context(uuid)
to service_role;
grant execute on function api.get_worksheet_answer_evaluation_context(uuid)
to service_role;
grant execute on function api.is_worksheet_answer_evaluation_current(uuid, integer)
to service_role;

comment on function api.get_writing_evaluation_context(uuid) is
  'Service-only writing evaluation input; contains raw student writing.';
comment on function api.get_worksheet_answer_evaluation_context(uuid) is
  'Service-only worksheet answer input; contains raw answers and answer keys.';
