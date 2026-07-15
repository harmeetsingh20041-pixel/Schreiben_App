-- Phase 9A: durable jobs, private feedback staging, and explicit release state.
--
-- Queue payloads intentionally contain identifiers and version numbers only.
-- Raw writing, worksheet answers, provider responses, and errors never enter
-- pgmq. All queue access is mediated by service-role-only RPCs.

create extension if not exists pgmq;

revoke all on schema pgmq from public, anon, authenticated, service_role;
revoke all on all tables in schema pgmq from public, anon, authenticated, service_role;
revoke all on all sequences in schema pgmq from public, anon, authenticated, service_role;
revoke execute on all functions in schema pgmq from public, anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pgmq.list_queues() q where q.queue_name = 'writing_evaluation'
  ) then
    perform pgmq.create('writing_evaluation');
  end if;

  if not exists (
    select 1 from pgmq.list_queues() q where q.queue_name = 'worksheet_generation'
  ) then
    perform pgmq.create('worksheet_generation');
  end if;

  if not exists (
    select 1 from pgmq.list_queues() q where q.queue_name = 'worksheet_answer_evaluation'
  ) then
    perform pgmq.create('worksheet_answer_evaluation');
  end if;
end;
$$;

create table if not exists app_private.async_jobs (
  id uuid primary key default gen_random_uuid(),
  queue_name text not null,
  job_kind text not null,
  entity_id uuid not null,
  entity_version integer not null check (entity_version > 0),
  idempotency_key text not null unique,
  status text not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  queue_message_id bigint,
  worker_id uuid,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  first_started_at timestamptz,
  last_started_at timestamptz,
  completed_at timestamptz,
  dead_at timestamptz,
  last_error_code text,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint async_jobs_queue_kind_check check (
    (queue_name = 'writing_evaluation' and job_kind = 'writing_evaluation')
    or (queue_name = 'worksheet_generation' and job_kind = 'worksheet_generation')
    or (
      queue_name = 'worksheet_answer_evaluation'
      and job_kind = 'worksheet_answer_evaluation'
    )
  ),
  constraint async_jobs_status_check check (
    status in ('queued', 'processing', 'retry', 'succeeded', 'dead')
  ),
  constraint async_jobs_terminal_shape_check check (
    (status = 'succeeded' and completed_at is not null and dead_at is null)
    or (status = 'dead' and dead_at is not null and completed_at is null)
    or (status not in ('succeeded', 'dead') and completed_at is null and dead_at is null)
  )
);

create index if not exists async_jobs_claim_idx
on app_private.async_jobs (queue_name, status, available_at, created_at)
where status in ('queued', 'retry', 'processing');

create index if not exists async_jobs_entity_idx
on app_private.async_jobs (job_kind, entity_id, entity_version desc);

create unique index if not exists async_jobs_one_entity_version_idx
on app_private.async_jobs (job_kind, entity_id, entity_version);

create unique index if not exists async_jobs_queue_message_idx
on app_private.async_jobs (queue_name, queue_message_id)
where queue_message_id is not null;

create index if not exists async_jobs_stale_lease_idx
on app_private.async_jobs (lease_expires_at)
where status = 'processing';

alter table app_private.async_jobs enable row level security;

drop trigger if exists async_jobs_set_updated_at on app_private.async_jobs;
create trigger async_jobs_set_updated_at
before update on app_private.async_jobs
for each row execute function public.set_updated_at();

revoke all on table app_private.async_jobs from public, anon, authenticated, service_role;

alter table public.submissions
  add column if not exists evaluation_status text,
  add column if not exists release_status text,
  add column if not exists release_at timestamptz,
  add column if not exists evaluation_version integer not null default 1;

alter table public.submissions
  drop constraint if exists submissions_evaluation_status_check,
  drop constraint if exists submissions_release_status_check,
  drop constraint if exists submissions_release_shape_check;

alter table public.submissions
  add constraint submissions_evaluation_status_check
    check (
      evaluation_status is null
      or evaluation_status in ('queued', 'processing', 'ready', 'needs_review', 'failed')
    ),
  add constraint submissions_release_status_check
    check (
      release_status is null
      or release_status in ('held', 'scheduled', 'released')
    ),
  add constraint submissions_release_shape_check
    check (
      release_status is null
      or release_status <> 'scheduled'
      or release_at is not null
    ),
  add constraint submissions_evaluation_version_check
    check (evaluation_version > 0);

create index if not exists submissions_evaluation_queue_idx
on public.submissions (evaluation_status, created_at)
where evaluation_status in ('queued', 'processing');

create index if not exists submissions_release_due_idx
on public.submissions (release_at, id)
where release_status = 'scheduled';

alter table public.student_practice_assignments
  add column if not exists generation_version integer not null default 0;

alter table public.practice_tests
  add column if not exists generator_model text,
  add column if not exists generation_metadata jsonb,
  add column if not exists generation_job_id uuid;

create unique index if not exists practice_tests_generation_job_idx
on public.practice_tests (generation_job_id)
where generation_job_id is not null;

alter table public.practice_tests
  drop constraint if exists practice_tests_generation_metadata_object_check;

alter table public.practice_tests
  add constraint practice_tests_generation_metadata_object_check
  check (
    generation_metadata is null
    or jsonb_typeof(generation_metadata) = 'object'
  );

alter table public.student_practice_assignments
  drop constraint if exists student_practice_assignments_generation_status_check;

alter table public.student_practice_assignments
  add constraint student_practice_assignments_generation_status_check
  check (generation_status in ('idle', 'queued', 'generating', 'ready', 'needs_review', 'failed'));

alter table public.practice_test_attempts
  add column if not exists evaluation_version integer not null default 0;

alter table public.practice_test_attempts
  drop constraint if exists practice_test_attempts_evaluation_status_check;

alter table public.practice_test_attempts
  add constraint practice_test_attempts_evaluation_status_check
  check (evaluation_status in ('not_needed', 'pending', 'queued', 'evaluating', 'completed', 'failed'));

alter table public.practice_test_questions
  add column if not exists accepted_answers jsonb not null default '[]'::jsonb,
  add column if not exists rubric jsonb,
  add column if not exists answer_contract_version integer not null default 0;

alter table public.practice_test_questions
  drop constraint if exists practice_test_questions_answer_contract_version_check,
  add constraint practice_test_questions_answer_contract_version_check
    check (answer_contract_version in (0, 1)),
  drop constraint if exists practice_test_questions_accepted_answers_array_check,
  add constraint practice_test_questions_accepted_answers_array_check
    check (jsonb_typeof(accepted_answers) = 'array'),
  drop constraint if exists practice_test_questions_rubric_object_check,
  add constraint practice_test_questions_rubric_object_check
    check (rubric is null or jsonb_typeof(rubric) = 'object');

-- Preserve the historical display/scoring shape for legacy objective rows, but
-- make every pre-contract worksheet ineligible for launch reuse until a new,
-- human-reviewed revision is imported with answer_contract_version = 1.
update public.practice_test_questions
set accepted_answers = jsonb_build_array(correct_answer)
where evaluation_mode = 'local_exact'
  and question_type in ('multiple_choice', 'fill_blank')
  and nullif(btrim(coalesce(correct_answer, '')), '') is not null;

update public.practice_test_questions
set
  evaluation_mode = 'open_evaluation',
  accepted_answers = '[]'::jsonb,
  correct_answer = case
    when lower(btrim(coalesce(correct_answer, ''))) in (
      'manual_review',
      'manual review',
      'open_review',
      'flexible_review',
      'requires_review'
    ) then ''
    else correct_answer
  end,
  rubric = jsonb_build_object(
    'criteria', jsonb_build_array(
      'The response must satisfy the stated German grammar task and remain valid in context.'
    ),
    'sample_answer', case
      when lower(btrim(coalesce(correct_answer, ''))) in (
        'manual_review',
        'manual review',
        'open_review',
        'flexible_review',
        'requires_review'
      ) then 'null'::jsonb
      when nullif(btrim(coalesce(correct_answer, '')), '') is null then 'null'::jsonb
      else to_jsonb(correct_answer)
    end
  )
where question_type in (
  'correction',
  'sentence_correction',
  'word_order',
  'transformation',
  'rewrite_sentence',
  'short_answer',
  'mini_writing',
  'error_detection'
)
or evaluation_mode = 'open_evaluation';

update public.practice_tests
set
  quality_status = 'needs_review',
  teacher_reviewed = false,
  quality_notes = concat_ws(
    '; ',
    nullif(quality_notes, ''),
    'answer_contract_review_required=v1'
  )
where exists (
  select 1
  from public.practice_test_questions ptq
  where ptq.practice_test_id = practice_tests.id
    and ptq.answer_contract_version = 0
);

create or replace function app_private.validate_practice_question_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted_count integer;
  criteria_count integer;
  normalized_answer text := lower(regexp_replace(btrim(coalesce(new.correct_answer, '')), '\s+', ' ', 'g'));
begin
  if new.answer_contract_version <> 1 then
    raise exception using errcode = '22023', message = 'A validated answer contract is required.';
  end if;

  if lower(btrim(coalesce(new.correct_answer, ''))) in (
    'manual_review',
    'manual review',
    'open_review',
    'flexible_review',
    'requires_review'
  ) then
    raise exception using errcode = '22023', message = 'Manual-review sentinels are not valid answers.';
  end if;

  if jsonb_typeof(new.accepted_answers) <> 'array' then
    raise exception using errcode = '22023', message = 'Accepted answers must be an array.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.accepted_answers) accepted(item)
    where jsonb_typeof(accepted.item) <> 'string'
      or length(btrim(accepted.item #>> '{}')) not between 1 and 500
  ) or (
    select count(*) <> count(distinct lower(regexp_replace(btrim(accepted.item #>> '{}'), '\s+', ' ', 'g')))
    from jsonb_array_elements(new.accepted_answers) accepted(item)
  ) then
    raise exception using errcode = '22023', message = 'Accepted answers are invalid or duplicated.';
  end if;

  accepted_count := jsonb_array_length(new.accepted_answers);

  if new.evaluation_mode = 'local_exact' then
    if new.question_type not in ('multiple_choice', 'fill_blank')
      or normalized_answer = ''
      or accepted_count not between 1 and 12
      or new.rubric is not null
      or not exists (
        select 1
        from jsonb_array_elements_text(new.accepted_answers) accepted(answer)
        where lower(regexp_replace(btrim(accepted.answer), '\s+', ' ', 'g')) = normalized_answer
      )
    then
      raise exception using errcode = '22023', message = 'Exact-scoring contract is invalid.';
    end if;

    if new.question_type = 'multiple_choice' and (
      accepted_count <> 1
      or jsonb_typeof(new.options) <> 'array'
      or (
        select count(*)
        from jsonb_array_elements_text(new.options) option_value
        where lower(regexp_replace(btrim(option_value), '\s+', ' ', 'g')) = normalized_answer
      ) <> 1
    ) then
      raise exception using errcode = '22023', message = 'Multiple-choice answer contract is invalid.';
    end if;

    if new.question_type = 'fill_blank' and (
      (length(new.prompt) - length(replace(new.prompt, '___', ''))) / 3 <> 1
      or not (
        new.prompt ~* '(definite|indefinite|possessive)[[:space:]]+article'
        or new.prompt ~* '(bestimmt[^[:space:]]*|unbestimmt[^[:space:]]*|possessiv[^[:space:]]*)[[:space:]]+artikel'
        or new.prompt ~* '(conjugate|correct form of|partizip[[:space:]]*(ii|2)|comparative|superlative)'
        or new.prompt ~* '(konjugier|richtige[^[:space:]]*[[:space:]]+form|komparativ|superlativ|partizip[[:space:]]*(ii|2))'
        or (
          new.prompt ~* '(closed[[:space:]]+)?(word[[:space:]]+bank|word[[:space:]]+list)|wortbank|wortliste'
          and position(',' in new.prompt) > 0
        )
      )
    ) then
      raise exception using errcode = '22023', message = 'Fill-blank answer contract is ambiguous.';
    end if;
  elsif new.evaluation_mode = 'open_evaluation' then
    if accepted_count <> 0
      or new.question_type = 'multiple_choice'
      or new.rubric is null
      or not (new.rubric ?& array['criteria', 'sample_answer'])
      or new.rubric - array['criteria', 'sample_answer']::text[] <> '{}'::jsonb
      or jsonb_typeof(new.rubric -> 'criteria') <> 'array'
      or jsonb_typeof(new.rubric -> 'sample_answer') not in ('string', 'null')
    then
      raise exception using errcode = '22023', message = 'Semantic-evaluation rubric is invalid.';
    end if;

    criteria_count := jsonb_array_length(new.rubric -> 'criteria');
    if criteria_count not between 1 and 6 or exists (
      select 1
      from jsonb_array_elements(new.rubric -> 'criteria') criterion(item)
      where jsonb_typeof(criterion.item) <> 'string'
        or length(btrim(criterion.item #>> '{}')) not between 1 and 240
    ) then
      raise exception using errcode = '22023', message = 'Semantic-evaluation criteria are invalid.';
    end if;

    if jsonb_typeof(new.rubric -> 'sample_answer') = 'string' and (
      length(btrim(new.rubric ->> 'sample_answer')) not between 1 and 500
      or (
        normalized_answer <> ''
        and lower(regexp_replace(btrim(new.rubric ->> 'sample_answer'), '\s+', ' ', 'g')) <> normalized_answer
      )
    ) then
      raise exception using errcode = '22023', message = 'Semantic sample answer is invalid.';
    end if;
  else
    raise exception using errcode = '22023', message = 'Evaluation mode is invalid.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_practice_question_contract()
from public, anon, authenticated, service_role;

drop trigger if exists practice_test_questions_validate_answer_contract
on public.practice_test_questions;
create trigger practice_test_questions_validate_answer_contract
before insert or update on public.practice_test_questions
for each row execute function app_private.validate_practice_question_contract();

create or replace function app_private.is_practice_question_locally_scorable(
  question_type text,
  correct_answer text,
  evaluation_mode text,
  accepted_answers jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(evaluation_mode, 'local_exact') <> 'open_evaluation'
    and question_type in ('multiple_choice', 'fill_blank')
    and nullif(btrim(coalesce(correct_answer, '')), '') is not null
    and lower(btrim(coalesce(correct_answer, ''))) not in (
      'manual_review',
      'manual review',
      'open_review',
      'flexible_review',
      'requires_review'
    )
    and jsonb_typeof(accepted_answers) = 'array'
    and jsonb_array_length(accepted_answers) between 1 and 12
    and exists (
      select 1
      from jsonb_array_elements_text(accepted_answers) accepted(answer)
      where lower(regexp_replace(btrim(accepted.answer), '\s+', ' ', 'g'))
        = lower(regexp_replace(btrim(correct_answer), '\s+', ' ', 'g'))
    );
$$;

create or replace function app_private.is_practice_question_locally_scorable(
  question_type text,
  correct_answer text,
  evaluation_mode text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app_private.is_practice_question_locally_scorable(
    question_type,
    correct_answer,
    evaluation_mode,
    case
      when question_type = 'multiple_choice' then jsonb_build_array(correct_answer)
      else '[]'::jsonb
    end
  );
$$;

create or replace function app_private.is_practice_question_locally_scorable(
  question_type text,
  correct_answer text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app_private.is_practice_question_locally_scorable(
    question_type,
    correct_answer,
    'local_exact',
    case
      when question_type = 'multiple_choice' then jsonb_build_array(correct_answer)
      else '[]'::jsonb
    end
  );
$$;

revoke all on function app_private.is_practice_question_locally_scorable(text, text, text, jsonb)
from public, anon, authenticated, service_role;
revoke all on function app_private.is_practice_question_locally_scorable(text, text, text)
from public, anon, authenticated, service_role;
revoke all on function app_private.is_practice_question_locally_scorable(text, text)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_answer_review_status_any(
  submitted_answer text,
  correct_answer text,
  accepted_answers jsonb,
  strict_scoring boolean default false
)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select app_private.practice_answer_review_status(
      submitted_answer,
      accepted.answer,
      strict_scoring
    )
    from jsonb_array_elements_text(accepted_answers) accepted(answer)
    order by
      app_private.practice_review_status_points(
        app_private.practice_answer_review_status(
          submitted_answer,
          accepted.answer,
          strict_scoring
        )
      ) desc,
      case app_private.practice_answer_review_status(
        submitted_answer,
        accepted.answer,
        strict_scoring
      )
        when 'correct' then 5
        when 'minor_punctuation' then 4
        when 'partially_correct' then 3
        when 'capitalization_issue' then 2
        else 1
      end desc
    limit 1
  ), app_private.practice_answer_review_status(
    submitted_answer,
    correct_answer,
    strict_scoring
  ));
$$;

revoke all on function app_private.practice_answer_review_status_any(text, text, jsonb, boolean)
from public, anon, authenticated, service_role;

-- The Phase 7 scorer is intentionally retained, but its three answer-key
-- decision points are upgraded to use the explicit accepted-answer contract.
-- Abort the migration if an older function body no longer matches: silently
-- falling back to one-string scoring is not a safe compatibility mode.
do $answer_contract_upgrade$
declare
  function_sql text;
  original_sql text;
begin
  select pg_get_functiondef(
    'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'      ptq.correct_answer,\n      ptq.evaluation_mode',
    E'      ptq.correct_answer,\n      ptq.accepted_answers,\n      ptq.evaluation_mode'
  );
  function_sql := replace(
    function_sql,
    E'      aq.correct_answer\n    from all_questions aq',
    E'      aq.correct_answer,\n      aq.accepted_answers\n    from all_questions aq'
  );
  function_sql := replace(
    function_sql,
    'app_private.is_practice_question_locally_scorable(aq.question_type, aq.correct_answer, aq.evaluation_mode)',
    'app_private.is_practice_question_locally_scorable(aq.question_type, aq.correct_answer, aq.evaluation_mode, aq.accepted_answers)'
  );
  function_sql := replace(
    function_sql,
    E'app_private.practice_answer_review_status(\n        coalesce(submitted.answer, ''''),\n        sq.correct_answer,\n        strict_scoring\n      )',
    E'app_private.practice_answer_review_status_any(\n        coalesce(submitted.answer, ''''),\n        sq.correct_answer,\n        sq.accepted_answers,\n        strict_scoring\n      )'
  );
  if function_sql = original_sql
    or position('sq.accepted_answers' in function_sql) = 0
    or position('aq.accepted_answers' in function_sql) = 0
  then
    raise exception 'Practice submit scorer could not be upgraded to answer contracts.';
  end if;
  execute function_sql;

  select pg_get_functiondef(
    'public.finalize_practice_attempt_evaluation(uuid)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'      ptq.correct_answer,\n      ptq.evaluation_mode,',
    E'      ptq.correct_answer,\n      ptq.accepted_answers,\n      ptq.evaluation_mode,'
  );
  function_sql := replace(
    function_sql,
    'app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer, ptq.evaluation_mode)',
    'app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer, ptq.evaluation_mode, ptq.accepted_answers)'
  );
  function_sql := replace(
    function_sql,
    'app_private.practice_answer_review_status(q.student_answer, q.correct_answer, strict_scoring)',
    'app_private.practice_answer_review_status_any(q.student_answer, q.correct_answer, q.accepted_answers, strict_scoring)'
  );
  if function_sql = original_sql
    or position('q.accepted_answers' in function_sql) = 0
    or position('ptq.accepted_answers' in function_sql) = 0
  then
    raise exception 'Practice finalizer could not be upgraded to answer contracts.';
  end if;
  execute function_sql;

  select pg_get_functiondef(
    'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'        ptq.correct_answer,\n        ptq.explanation,',
    E'        ptq.correct_answer,\n        ptq.accepted_answers,\n        ptq.explanation,'
  );
  function_sql := replace(
    function_sql,
    'app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer, ptq.evaluation_mode)',
    'app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer, ptq.evaluation_mode, ptq.accepted_answers)'
  );
  function_sql := replace(
    function_sql,
    'app_private.practice_answer_review_status(q.student_answer, q.correct_answer, strict_scoring)',
    'app_private.practice_answer_review_status_any(q.student_answer, q.correct_answer, q.accepted_answers, strict_scoring)'
  );
  if function_sql = original_sql
    or position('q.accepted_answers' in function_sql) = 0
    or position('ptq.accepted_answers' in function_sql) = 0
  then
    raise exception 'Practice review model could not be upgraded to answer contracts.';
  end if;
  execute function_sql;
end;
$answer_contract_upgrade$;

create or replace function app_private.prevent_used_practice_test_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_test_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  if exists (
    select 1
    from public.practice_test_attempts pta
    where pta.practice_test_id = selected_test_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Used worksheet revisions are immutable.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_used_practice_test_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists practice_tests_prevent_used_mutation on public.practice_tests;
create trigger practice_tests_prevent_used_mutation
before update or delete on public.practice_tests
for each row execute function app_private.prevent_used_practice_test_mutation();

create or replace function app_private.prevent_used_practice_question_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_test_id uuid := case when tg_op = 'INSERT' then null else old.practice_test_id end;
  new_test_id uuid := case when tg_op = 'DELETE' then null else new.practice_test_id end;
begin
  if exists (
    select 1
    from public.practice_test_attempts pta
    where pta.practice_test_id in (old_test_id, new_test_id)
  ) then
    raise exception using
      errcode = '55000',
      message = 'Used worksheet questions are immutable.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_used_practice_question_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists practice_test_questions_prevent_used_mutation
on public.practice_test_questions;
create trigger practice_test_questions_prevent_used_mutation
before insert or update or delete on public.practice_test_questions
for each row execute function app_private.prevent_used_practice_question_mutation();

create table if not exists app_private.feedback_drafts (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  version integer not null check (version > 0),
  state text not null,
  content jsonb not null,
  provider_model text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  released_at timestamptz,
  released_by uuid references public.profiles(id) on delete set null,
  unique (submission_id, version),
  constraint feedback_drafts_state_check check (
    state in ('draft', 'needs_review', 'approved', 'released', 'superseded')
  ),
  constraint feedback_drafts_content_object_check check (jsonb_typeof(content) = 'object')
);

create unique index if not exists feedback_drafts_one_current_idx
on app_private.feedback_drafts (submission_id)
where state in ('draft', 'needs_review', 'approved');

alter table app_private.feedback_drafts enable row level security;

drop trigger if exists feedback_drafts_set_updated_at on app_private.feedback_drafts;
create trigger feedback_drafts_set_updated_at
before update on app_private.feedback_drafts
for each row execute function public.set_updated_at();

revoke all on table app_private.feedback_drafts from public, anon, authenticated, service_role;

create or replace function app_private.assert_service_role()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;
end;
$$;

revoke all on function app_private.assert_service_role() from public, anon, authenticated, service_role;

create or replace function app_private.queue_name_for_kind(target_job_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case target_job_kind
    when 'writing_evaluation' then 'writing_evaluation'
    when 'worksheet_generation' then 'worksheet_generation'
    when 'worksheet_answer_evaluation' then 'worksheet_answer_evaluation'
    else null
  end;
$$;

revoke all on function app_private.queue_name_for_kind(text)
from public, anon, authenticated, service_role;

create or replace function app_private.enqueue_async_job(
  target_job_kind text,
  target_entity_id uuid,
  target_entity_version integer,
  target_idempotency_key text,
  target_requested_by uuid default null,
  delay_seconds integer default 0
)
returns table (job_id uuid, queue_message_id bigint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_queue_name text := app_private.queue_name_for_kind(target_job_kind);
  selected_job app_private.async_jobs%rowtype;
  selected_message_id bigint;
begin
  if selected_queue_name is null then
    raise exception using errcode = '22023', message = 'Unsupported job kind.';
  end if;

  if target_entity_id is null or target_entity_version is null or target_entity_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid job entity.';
  end if;

  if target_idempotency_key is null or length(target_idempotency_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'Invalid idempotency key.';
  end if;

  delay_seconds := greatest(0, least(coalesce(delay_seconds, 0), 86400));

  insert into app_private.async_jobs (
    queue_name,
    job_kind,
    entity_id,
    entity_version,
    idempotency_key,
    status,
    available_at,
    requested_by
  ) values (
    selected_queue_name,
    target_job_kind,
    target_entity_id,
    target_entity_version,
    target_idempotency_key,
    'queued',
    now() + make_interval(secs => delay_seconds),
    target_requested_by
  )
  on conflict (idempotency_key) do nothing
  returning * into selected_job;

  if selected_job.id is null then
    select j.*
    into selected_job
    from app_private.async_jobs j
    where j.idempotency_key = target_idempotency_key;

    return query
    select selected_job.id, selected_job.queue_message_id, false;
    return;
  end if;

  select sent.send
  into selected_message_id
  from pgmq.send(
    selected_queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    delay_seconds
  ) sent;

  update app_private.async_jobs j
  set queue_message_id = selected_message_id
  where j.id = selected_job.id;

  return query select selected_job.id, selected_message_id, true;
end;
$$;

revoke all on function app_private.enqueue_async_job(text, uuid, integer, text, uuid, integer)
from public, anon, authenticated, service_role;

-- Existing terminal rows are released; incomplete or uncertain rows remain
-- held. New jobs use these columns as the authoritative state machine.
update public.submissions s
set
  evaluation_status = case s.status
    when 'checked' then 'ready'
    when 'needs_review' then 'needs_review'
    when 'failed' then 'failed'
    when 'checking' then 'queued'
    when 'submitted' then 'queued'
    else null
  end,
  release_status = case s.status
    when 'checked' then 'released'
    when 'needs_review' then 'held'
    when 'failed' then 'held'
    when 'checking' then case
      when s.feedback_mode = 'automatic_delayed' then 'scheduled'
      else 'held'
    end
    when 'submitted' then case
      when s.feedback_mode = 'automatic_delayed' then 'scheduled'
      else 'held'
    end
    else null
  end,
  release_at = case
    when s.status in ('checking', 'submitted')
      and s.feedback_mode = 'automatic_delayed'
    then s.feedback_scheduled_at
    else null
  end
where s.evaluation_status is null
   or s.release_status is null;

-- Preserve any legacy uncertain result privately before clearing its public
-- correction fields. Clean production starts empty, but staging remains safe.
insert into app_private.feedback_drafts (
  submission_id,
  version,
  state,
  provider_model,
  content
)
select
  s.id,
  greatest(s.evaluation_version, 1),
  'needs_review',
  s.ai_model,
  jsonb_build_object(
    'overall_summary', coalesce(s.overall_summary, ''),
    'level_detected', coalesce(s.level_detected, 'A2'),
    'corrected_text', coalesce(s.corrected_text, s.original_text),
    'ai_model', coalesce(s.ai_model, 'legacy'),
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'line_number', sl.line_number,
          'original_line', sl.original_line,
          'corrected_line', sl.corrected_line,
          'status', sl.status,
          'changed_parts', sl.changed_parts,
          'short_explanation', coalesce(sl.short_explanation, ''),
          'detailed_explanation', coalesce(sl.detailed_explanation, ''),
          'grammar_topic', coalesce(gt.slug, '')
        ) order by sl.line_number
      )
      from public.submission_lines sl
      left join public.grammar_topics gt on gt.id = sl.grammar_topic_id
      where sl.submission_id = s.id
    ), '[]'::jsonb),
    'grammar_topics', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'topic', gt.slug,
          'count', sgt.count,
          'severity', sgt.severity,
          'simple_explanation', coalesce(sgt.simple_explanation, '')
        ) order by gt.slug
      )
      from public.submission_grammar_topics sgt
      join public.grammar_topics gt on gt.id = sgt.grammar_topic_id
      where sgt.submission_id = s.id
    ), '[]'::jsonb)
  )
from public.submissions s
where s.status = 'needs_review'
  and not exists (
    select 1 from app_private.feedback_drafts fd where fd.submission_id = s.id
  );

delete from public.submission_lines sl
using public.submissions s
where s.id = sl.submission_id
  and s.status = 'needs_review';

delete from public.submission_grammar_topics sgt
using public.submissions s
where s.id = sgt.submission_id
  and s.status = 'needs_review';

update public.submissions
set corrected_text = null,
    overall_summary = null,
    level_detected = null,
    checked_at = null
where status = 'needs_review';

delete from public.submission_lines sl
using public.submissions s
where s.id = sl.submission_id
  and s.release_status is distinct from 'released';

delete from public.submission_grammar_topics sgt
using public.submissions s
where s.id = sgt.submission_id
  and s.release_status is distinct from 'released';

update public.submissions s
set
  corrected_text = null,
  overall_summary = null,
  level_detected = null,
  checked_at = null,
  feedback_error = case
    when s.feedback_error is null then null
    else 'feedback_failed'
  end
where s.release_status is distinct from 'released';

alter table public.submissions
  drop constraint if exists submissions_release_state_consistency_check,
  drop constraint if exists submissions_private_feedback_null_check;

alter table public.submissions
  add constraint submissions_release_state_consistency_check
  check (
    release_status is null
    or (
      release_status = 'released'
      and evaluation_status = 'ready'
      and status = 'checked'
    )
    or (
      release_status = 'scheduled'
      and evaluation_status in ('queued', 'processing', 'ready')
      and status in ('submitted', 'checking', 'checked')
    )
    or (
      release_status = 'held'
      and (
        (evaluation_status in ('queued', 'processing', 'ready')
          and status in ('submitted', 'checking', 'checked'))
        or (evaluation_status = 'needs_review' and status = 'needs_review')
        or (evaluation_status = 'failed' and status = 'failed')
      )
    )
  ),
  add constraint submissions_private_feedback_null_check
  check (
    release_status = 'released'
    or (
      corrected_text is null
      and overall_summary is null
      and level_detected is null
      and checked_at is null
    )
  );

-- Backfill unfinished submissions into the durable queue. Drafts are never
-- enqueued. Idempotency makes migration replay safe.
do $$
declare
  pending_submission record;
begin
  for pending_submission in
    select s.id, s.evaluation_version, s.student_id
    from public.submissions s
    where s.evaluation_status = 'queued'
      and s.status <> 'draft'
  loop
    perform *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      pending_submission.id,
      pending_submission.evaluation_version,
      format('writing:%s:%s', pending_submission.id, pending_submission.evaluation_version),
      pending_submission.student_id,
      0
    );
  end loop;
end;
$$;

-- Recover legacy semantic attempts into the new queue. Attempts that cannot
-- satisfy the closed three-question contract become actionable failures
-- instead of remaining pending/evaluating forever.
do $$
declare
  pending_attempt record;
  next_version integer;
begin
  for pending_attempt in
    select pta.id, pta.evaluation_version, pta.student_id
    from public.practice_test_attempts pta
    join public.student_practice_assignments spa
      on spa.id = pta.assignment_id
     and spa.latest_attempt_id = pta.id
     and spa.practice_test_id = pta.practice_test_id
    where pta.evaluation_status in ('pending', 'evaluating')
      and pta.status in ('submitted', 'checked')
      and spa.status in ('completed', 'passed', 'failed')
      and exists (
        select 1
        from public.workspace_members wm
        where wm.workspace_id = spa.workspace_id
          and wm.user_id = spa.student_id
          and wm.role = 'student'
      )
      and (
        select count(*)
        from public.practice_test_questions ptq
        where ptq.practice_test_id = pta.practice_test_id
          and not app_private.is_practice_question_locally_scorable(
            ptq.question_type,
            ptq.correct_answer,
            ptq.evaluation_mode,
            ptq.accepted_answers
          )
      ) between 1 and 3
  loop
    next_version := greatest(pending_attempt.evaluation_version, 0) + 1;

    update public.practice_test_attempts pta
    set
      evaluation_status = 'queued',
      evaluation_version = next_version,
      evaluation_started_at = null,
      evaluation_completed_at = null,
      evaluation_error = null
    where pta.id = pending_attempt.id;

    perform *
    from app_private.enqueue_async_job(
      'worksheet_answer_evaluation',
      pending_attempt.id,
      next_version,
      format('worksheet-evaluation:%s:%s', pending_attempt.id, next_version),
      pending_attempt.student_id,
      0
    );
  end loop;

  update public.practice_test_attempts pta
  set
    evaluation_status = 'failed',
    evaluation_completed_at = now(),
    evaluation_error = 'practice_evaluation_requires_review'
  where pta.evaluation_status in ('pending', 'evaluating');
end;
$$;

create or replace function app_private.set_job_entity_state(
  target_job_kind text,
  target_entity_id uuid,
  target_entity_version integer,
  target_state text,
  target_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_job_kind = 'writing_evaluation' then
    update public.submissions s
    set
      evaluation_status = case target_state
        when 'processing' then 'processing'
        when 'queued' then 'queued'
        when 'failed' then 'failed'
        else s.evaluation_status
      end,
      status = case target_state
        when 'processing' then 'checking'
        when 'failed' then 'failed'
        else s.status
      end,
      feedback_started_at = case
        when target_state = 'processing' then coalesce(s.feedback_started_at, now())
        else s.feedback_started_at
      end,
      feedback_completed_at = case
        when target_state = 'failed' then now()
        else s.feedback_completed_at
      end,
      release_status = case
        when target_state = 'failed' then 'held'
        else s.release_status
      end,
      release_at = case
        when target_state = 'failed' then null
        else s.release_at
      end,
      feedback_error = case
        when target_state = 'failed' then coalesce(target_error_code, 'feedback_failed')
        when target_state in ('queued', 'processing') then null
        else s.feedback_error
      end
    where s.id = target_entity_id
      and s.evaluation_version = target_entity_version;
  elsif target_job_kind = 'worksheet_generation' then
    update public.student_practice_assignments spa
    set
      generation_status = case target_state
        when 'processing' then 'generating'
        when 'queued' then 'queued'
        when 'failed' then 'failed'
        else spa.generation_status
      end,
      generation_started_at = case
        when target_state = 'processing' then coalesce(spa.generation_started_at, now())
        else spa.generation_started_at
      end,
      generation_completed_at = case
        when target_state = 'failed' then now()
        else spa.generation_completed_at
      end,
      generation_error = case
        when target_state = 'failed' then coalesce(target_error_code, 'generation_failed')
        when target_state in ('queued', 'processing') then null
        else spa.generation_error
      end
    where spa.id = target_entity_id
      and spa.generation_version = target_entity_version;
  elsif target_job_kind = 'worksheet_answer_evaluation' then
    update public.practice_test_attempts pta
    set
      evaluation_status = case target_state
        when 'processing' then 'evaluating'
        when 'queued' then 'queued'
        when 'failed' then 'failed'
        else pta.evaluation_status
      end,
      evaluation_started_at = case
        when target_state = 'processing' then coalesce(pta.evaluation_started_at, now())
        else pta.evaluation_started_at
      end,
      evaluation_completed_at = case
        when target_state = 'failed' then now()
        else pta.evaluation_completed_at
      end,
      evaluation_error = case
        when target_state = 'failed' then coalesce(target_error_code, 'evaluation_failed')
        when target_state in ('queued', 'processing') then null
        else pta.evaluation_error
      end
    where pta.id = target_entity_id
      and pta.evaluation_version = target_entity_version;
  end if;
end;
$$;

revoke all on function app_private.set_job_entity_state(text, uuid, integer, text, text)
from public, anon, authenticated, service_role;

create or replace function public.claim_async_jobs(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_message record;
  selected_job app_private.async_jobs%rowtype;
  payload_job_id uuid;
  payload_kind text;
  payload_entity_id uuid;
  payload_entity_version integer;
  selected_worker_id uuid := worker_id;
  claim_limit integer := greatest(1, least(coalesce(batch_size, 1), 10));
  visibility_seconds integer := greatest(
    30,
    least(coalesce(visibility_timeout_seconds, 180), 600)
  );
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  if target_queue_name is null or target_queue_name not in (
    'writing_evaluation',
    'worksheet_generation',
    'worksheet_answer_evaluation'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported queue.';
  end if;

  for queue_message in
    select * from pgmq.read(target_queue_name, visibility_seconds, claim_limit)
  loop
    begin
      if jsonb_typeof(queue_message.message) <> 'object'
        or exists (
          select 1
          from jsonb_object_keys(queue_message.message) payload_key
          where payload_key not in ('job_id', 'job_kind', 'entity_id', 'entity_version')
        )
      then
        raise exception 'invalid payload';
      end if;

      payload_job_id := (queue_message.message ->> 'job_id')::uuid;
      payload_kind := queue_message.message ->> 'job_kind';
      payload_entity_id := (queue_message.message ->> 'entity_id')::uuid;
      payload_entity_version := (queue_message.message ->> 'entity_version')::integer;
    exception when others then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end;

    select j.*
    into selected_job
    from app_private.async_jobs j
    where j.id = payload_job_id
      and j.queue_name = target_queue_name
      and j.queue_message_id = queue_message.msg_id
      and j.job_kind = payload_kind
      and j.entity_id = payload_entity_id
      and j.entity_version = payload_entity_version
    for update;

    if selected_job.id is null then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if selected_job.status in ('succeeded', 'dead') then
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if (
      selected_job.job_kind = 'writing_evaluation'
      and not exists (
        select 1 from public.submissions s
        where s.id = selected_job.entity_id
          and s.evaluation_version = selected_job.entity_version
      )
    ) or (
      selected_job.job_kind = 'worksheet_generation'
      and not exists (
        select 1 from public.student_practice_assignments spa
        where spa.id = selected_job.entity_id
          and spa.generation_version = selected_job.entity_version
      )
    ) or (
      selected_job.job_kind = 'worksheet_answer_evaluation'
      and not exists (
        select 1 from public.practice_test_attempts pta
        where pta.id = selected_job.entity_id
          and pta.evaluation_version = selected_job.entity_version
      )
    ) then
      update app_private.async_jobs j
      set
        status = 'dead',
        worker_id = null,
        lease_expires_at = null,
        dead_at = now(),
        last_error_code = 'superseded_version'
      where j.id = selected_job.id;
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    if selected_job.attempt_count >= 3 then
      update app_private.async_jobs j
      set
        status = 'dead',
        worker_id = null,
        lease_expires_at = null,
        dead_at = now(),
        last_error_code = coalesce(j.last_error_code, 'attempts_exhausted')
      where j.id = selected_job.id;

      perform app_private.set_job_entity_state(
        selected_job.job_kind,
        selected_job.entity_id,
        selected_job.entity_version,
        'failed',
        coalesce(selected_job.last_error_code, 'attempts_exhausted')
      );
      perform pgmq.archive(target_queue_name, queue_message.msg_id);
      continue;
    end if;

    update app_private.async_jobs j
    set
      status = 'processing',
      attempt_count = j.attempt_count + 1,
      worker_id = selected_worker_id,
      lease_expires_at = now() + make_interval(secs => visibility_seconds),
      first_started_at = coalesce(j.first_started_at, now()),
      last_started_at = now(),
      last_error_code = null
    where j.id = selected_job.id
      and j.available_at <= now()
      and (
        j.status in ('queued', 'retry')
        or (j.status = 'processing' and j.lease_expires_at <= now())
      )
    returning j.* into selected_job;

    if selected_job.id is null then
      continue;
    end if;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'processing',
      null
    );

    job_id := selected_job.id;
    queue_message_id := selected_job.queue_message_id;
    entity_id := selected_job.entity_id;
    entity_version := selected_job.entity_version;
    attempt_number := selected_job.attempt_count;
    lease_expires_at := selected_job.lease_expires_at;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_async_jobs(text, uuid, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_async_jobs(text, uuid, integer, integer)
to service_role;

create or replace function public.fail_async_job(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  safe_error_code text;
  retry_delay integer;
  next_message_id bigint;
  selected_worker_id uuid := worker_id;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  safe_error_code := left(
    trim(both '_' from regexp_replace(lower(coalesce(error_code, 'job_failed')), '[^a-z0-9_]+', '_', 'g')),
    80
  );
  if safe_error_code = '' then
    safe_error_code := 'job_failed';
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'Job not found.';
  end if;

  if selected_job.status in ('succeeded', 'dead', 'retry') then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      case when selected_job.status = 'retry' then selected_job.available_at else null end;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
  then
    raise exception using errcode = '55000', message = 'Job lease is no longer active.';
  end if;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  if coalesce(retryable, true) and selected_job.attempt_count < 3 then
    retry_delay := least(60, 5 * (2 ^ greatest(selected_job.attempt_count - 1, 0))::integer);

    select sent.send
    into next_message_id
    from pgmq.send(
      selected_job.queue_name,
      jsonb_build_object(
        'job_id', selected_job.id,
        'job_kind', selected_job.job_kind,
        'entity_id', selected_job.entity_id,
        'entity_version', selected_job.entity_version
      ),
      retry_delay
    ) sent;

    update app_private.async_jobs j
    set
      status = 'retry',
      queue_message_id = next_message_id,
      worker_id = null,
      lease_expires_at = null,
      available_at = now() + make_interval(secs => retry_delay),
      last_error_code = safe_error_code
    where j.id = selected_job.id
    returning j.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'queued',
      null
    );
  else
    update app_private.async_jobs j
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = safe_error_code
    where j.id = selected_job.id
    returning j.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      safe_error_code
    );
  end if;

  return query
  select
    selected_job.id,
    selected_job.status,
    selected_job.attempt_count,
    case when selected_job.status = 'retry' then selected_job.available_at else null end;
end;
$$;

revoke all on function public.fail_async_job(uuid, bigint, uuid, text, boolean)
from public, anon, authenticated;
grant execute on function public.fail_async_job(uuid, bigint, uuid, text, boolean)
to service_role;

create or replace function app_private.materialize_feedback_draft(
  target_submission_id uuid,
  target_draft_id uuid,
  target_released_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_draft app_private.feedback_drafts%rowtype;
  selected_submission public.submissions%rowtype;
begin
  select s.*
  into selected_submission
  from public.submissions s
  where s.id = target_submission_id
  for update;

  if selected_submission.id is null then
    raise exception using errcode = '02000', message = 'Submission not found.';
  end if;

  select fd.*
  into selected_draft
  from app_private.feedback_drafts fd
  where fd.id = target_draft_id
    and fd.submission_id = target_submission_id
  for update;

  if selected_draft.id is null then
    raise exception using errcode = '02000', message = 'Feedback draft not found.';
  end if;

  if selected_draft.state = 'released' then
    return;
  end if;

  if selected_draft.state not in ('draft', 'approved') then
    raise exception using errcode = '55000', message = 'Feedback is not releasable.';
  end if;

  if exists (
    with topic_keys as (
      select btrim(line_item ->> 'grammar_topic') as topic_key
      from jsonb_array_elements(selected_draft.content -> 'lines') line_item
      where btrim(coalesce(line_item ->> 'grammar_topic', '')) <> ''
      union
      select btrim(topic_item ->> 'topic') as topic_key
      from jsonb_array_elements(selected_draft.content -> 'grammar_topics') topic_item
      where btrim(coalesce(topic_item ->> 'topic', '')) <> ''
    )
    select 1
    from topic_keys tk
    where not exists (
      select 1
      from public.grammar_topics gt
      where (
        lower(regexp_replace(gt.slug, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(tk.topic_key, '[^[:alnum:]]+', '', 'g'))
        or lower(regexp_replace(gt.name, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(tk.topic_key, '[^[:alnum:]]+', '', 'g'))
      )
        and gt.level in (selected_draft.content ->> 'level_detected', 'A1_A2')
    )
  ) then
    raise exception using errcode = '22023', message = 'Feedback contains an unmapped grammar topic.';
  end if;

  delete from public.submission_lines sl
  where sl.submission_id = target_submission_id;

  delete from public.submission_grammar_topics sgt
  where sgt.submission_id = target_submission_id;

  insert into public.submission_lines (
    submission_id,
    line_number,
    original_line,
    corrected_line,
    status,
    changed_parts,
    short_explanation,
    detailed_explanation,
    grammar_topic_id
  )
  select
    target_submission_id,
    (line_item ->> 'line_number')::integer,
    line_item ->> 'original_line',
    line_item ->> 'corrected_line',
    line_item ->> 'status',
    coalesce(line_item -> 'changed_parts', '[]'::jsonb),
    nullif(line_item ->> 'short_explanation', ''),
    nullif(line_item ->> 'detailed_explanation', ''),
    resolved_topic.id
  from jsonb_array_elements(selected_draft.content -> 'lines') line_item
  left join lateral (
    select gt.id
    from public.grammar_topics gt
    where (
      lower(regexp_replace(gt.slug, '[^[:alnum:]]+', '', 'g'))
        = lower(regexp_replace(line_item ->> 'grammar_topic', '[^[:alnum:]]+', '', 'g'))
      or lower(regexp_replace(gt.name, '[^[:alnum:]]+', '', 'g'))
        = lower(regexp_replace(line_item ->> 'grammar_topic', '[^[:alnum:]]+', '', 'g'))
    )
      and gt.level in (selected_draft.content ->> 'level_detected', 'A1_A2')
    order by
      case when lower(gt.slug) = lower(line_item ->> 'grammar_topic') then 0 else 1 end,
      case when gt.level = selected_draft.content ->> 'level_detected' then 0 else 1 end,
      gt.id
    limit 1
  ) resolved_topic on btrim(coalesce(line_item ->> 'grammar_topic', '')) <> '';

  with parsed_topics as (
    select
      topic_item,
      resolved_topic.id as grammar_topic_id
    from jsonb_array_elements(selected_draft.content -> 'grammar_topics') topic_item
    left join lateral (
      select gt.id
      from public.grammar_topics gt
      where (
        lower(regexp_replace(gt.slug, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(topic_item ->> 'topic', '[^[:alnum:]]+', '', 'g'))
        or lower(regexp_replace(gt.name, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(topic_item ->> 'topic', '[^[:alnum:]]+', '', 'g'))
      )
        and gt.level in (selected_draft.content ->> 'level_detected', 'A1_A2')
      order by
        case when lower(gt.slug) = lower(topic_item ->> 'topic') then 0 else 1 end,
        case when gt.level = selected_draft.content ->> 'level_detected' then 0 else 1 end,
        gt.id
      limit 1
    ) resolved_topic on true
  )
  insert into public.submission_grammar_topics (
    submission_id,
    grammar_topic_id,
    count,
    severity,
    simple_explanation
  )
  select
    target_submission_id,
    pt.grammar_topic_id,
    sum((pt.topic_item ->> 'count')::integer)::integer,
    case
      when bool_or((pt.topic_item ->> 'severity') = 'mixed') then 'mixed'
      when bool_or((pt.topic_item ->> 'severity') = 'major')
       and bool_or((pt.topic_item ->> 'severity') = 'minor') then 'mixed'
      when bool_or((pt.topic_item ->> 'severity') = 'major') then 'major'
      else 'minor'
    end,
    max(nullif(pt.topic_item ->> 'simple_explanation', ''))
  from parsed_topics pt
  where pt.grammar_topic_id is not null
  group by pt.grammar_topic_id;

  update public.submissions s
  set
    corrected_text = selected_draft.content ->> 'corrected_text',
    overall_summary = selected_draft.content ->> 'overall_summary',
    level_detected = selected_draft.content ->> 'level_detected',
    ai_model = nullif(selected_draft.content ->> 'ai_model', ''),
    status = 'checked',
    evaluation_status = 'ready',
    release_status = 'released',
    checked_at = now(),
    feedback_completed_at = now(),
    feedback_error = null
  where s.id = target_submission_id;

  update app_private.feedback_drafts fd
  set
    state = 'released',
    released_at = now(),
    released_by = target_released_by
  where fd.id = selected_draft.id;

  if exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = selected_submission.workspace_id
      and wm.user_id = selected_submission.student_id
      and wm.role = 'student'
  ) then
    if coalesce((select auth.role()), '') = '' then
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    end if;

    perform public.refresh_student_grammar_stats(
      selected_submission.workspace_id,
      selected_submission.student_id
    );
  end if;
end;
$$;

revoke all on function app_private.materialize_feedback_draft(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function public.complete_writing_evaluation(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_submission public.submissions%rowtype;
  selected_draft_id uuid;
  selected_worker_id uuid := worker_id;
  has_uncertainty boolean;
  has_unmapped_topic boolean;
  release_immediately boolean;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  if feedback is null
    or coalesce(jsonb_typeof(feedback) <> 'object', true)
    or coalesce(jsonb_typeof(feedback -> 'lines') <> 'array', true)
    or coalesce(jsonb_typeof(feedback -> 'grammar_topics') <> 'array', true)
    or jsonb_array_length(feedback -> 'lines') not between 1 and 120
    or jsonb_array_length(feedback -> 'grammar_topics') > 100
    or coalesce(feedback ->> 'level_detected', '') not in ('A1', 'A2', 'B1', 'B2')
    or length(coalesce(feedback ->> 'overall_summary', '')) not between 1 and 8000
    or length(coalesce(feedback ->> 'corrected_text', '')) not between 1 and 12000
    or length(coalesce(feedback ->> 'ai_model', '')) not between 1 and 160
  then
    raise exception using errcode = '22023', message = 'Feedback payload is invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(feedback -> 'lines') line_item
    where jsonb_typeof(line_item) <> 'object'
      or coalesce(line_item ->> 'line_number', '') !~ '^[1-9][0-9]*$'
      or coalesce(line_item ->> 'status', '') not in (
        'correct',
        'acceptable_for_level',
        'acceptable_a1_a2',
        'minor_issue',
        'major_issue',
        'unclear'
      )
      or coalesce(jsonb_typeof(line_item -> 'original_line') <> 'string', true)
      or coalesce(jsonb_typeof(line_item -> 'corrected_line') <> 'string', true)
      or coalesce(
        jsonb_typeof(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 'array',
        true
      )
      or length(coalesce(line_item ->> 'original_line', '')) > 12000
      or length(coalesce(line_item ->> 'corrected_line', '')) > 12000
      or length(coalesce(line_item ->> 'short_explanation', '')) > 4000
      or length(coalesce(line_item ->> 'detailed_explanation', '')) > 8000
  ) then
    raise exception using errcode = '22023', message = 'Feedback lines are invalid.';
  end if;

  if (
    select count(*) <> count(distinct (line_item ->> 'line_number')::integer)
    from jsonb_array_elements(feedback -> 'lines') line_item
  ) then
    raise exception using errcode = '22023', message = 'Feedback lines are invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(feedback -> 'grammar_topics') topic_item
    where jsonb_typeof(topic_item) <> 'object'
      or btrim(coalesce(topic_item ->> 'topic', '')) = ''
      or coalesce(topic_item ->> 'count', '') !~ '^[0-9]+$'
      or coalesce(topic_item ->> 'severity', '') not in ('minor', 'major', 'mixed')
      or length(coalesce(topic_item ->> 'simple_explanation', '')) > 4000
  ) then
    raise exception using errcode = '22023', message = 'Feedback topics are invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(feedback -> 'lines') line_item
    where (line_item ->> 'line_number')::integer > 120
      or jsonb_array_length(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) > 80
  ) or exists (
    select 1
    from jsonb_array_elements(feedback -> 'grammar_topics') topic_item
    where (topic_item ->> 'count')::numeric > 120
  ) then
    raise exception using errcode = '22023', message = 'Feedback numeric limits are invalid.';
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.id = target_job_id
  for update;

  if selected_job.id is null or selected_job.job_kind <> 'writing_evaluation' then
    raise exception using errcode = '02000', message = 'Writing evaluation job not found.';
  end if;

  select s.*
  into selected_submission
  from public.submissions s
  where s.id = selected_job.entity_id
  for update;

  if selected_submission.id is null then
    raise exception using errcode = '02000', message = 'Submission not found.';
  end if;

  if selected_job.status = 'succeeded' then
    return query
    select
      selected_submission.id,
      selected_submission.evaluation_status,
      selected_submission.release_status;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
    or selected_job.entity_version <> selected_submission.evaluation_version
  then
    raise exception using errcode = '55000', message = 'Job lease is no longer active.';
  end if;

  has_unmapped_topic := exists (
    with topic_keys as (
      select btrim(line_item ->> 'grammar_topic') as topic_key
      from jsonb_array_elements(feedback -> 'lines') line_item
      where btrim(coalesce(line_item ->> 'grammar_topic', '')) <> ''
      union
      select btrim(topic_item ->> 'topic') as topic_key
      from jsonb_array_elements(feedback -> 'grammar_topics') topic_item
      where btrim(coalesce(topic_item ->> 'topic', '')) <> ''
    )
    select 1
    from topic_keys tk
    where not exists (
      select 1
      from public.grammar_topics gt
      where (
        lower(regexp_replace(gt.slug, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(tk.topic_key, '[^[:alnum:]]+', '', 'g'))
        or lower(regexp_replace(gt.name, '[^[:alnum:]]+', '', 'g'))
          = lower(regexp_replace(tk.topic_key, '[^[:alnum:]]+', '', 'g'))
      )
        and gt.level in (feedback ->> 'level_detected', 'A1_A2')
    )
  );

  has_uncertainty := has_unmapped_topic or exists (
    select 1
    from jsonb_array_elements(feedback -> 'lines') line_item
    where line_item ->> 'status' = 'unclear'
  );
  release_immediately := selected_submission.feedback_mode = 'immediate'
    and not has_uncertainty;

  update app_private.feedback_drafts fd
  set state = 'superseded'
  where fd.submission_id = selected_submission.id
    and fd.state in ('draft', 'needs_review', 'approved');

  insert into app_private.feedback_drafts (
    submission_id,
    version,
    state,
    content,
    provider_model
  ) values (
    selected_submission.id,
    selected_job.entity_version,
    case when has_uncertainty then 'needs_review' else 'draft' end,
    feedback,
    nullif(feedback ->> 'ai_model', '')
  )
  returning id into selected_draft_id;

  -- A held result has no student-visible correction fragments. The private
  -- draft is the sole source until an atomic release materializes it.
  delete from public.submission_lines sl
  where sl.submission_id = selected_submission.id;
  delete from public.submission_grammar_topics sgt
  where sgt.submission_id = selected_submission.id;

  update public.submissions s
  set
    corrected_text = null,
    overall_summary = null,
    level_detected = null,
    checked_at = null,
    status = case when has_uncertainty then 'needs_review' else 'checked' end,
    evaluation_status = case when has_uncertainty then 'needs_review' else 'ready' end,
    release_status = case
      when has_uncertainty then 'held'
      else s.release_status
    end,
    feedback_completed_at = now(),
    feedback_error = null
  where s.id = selected_submission.id;

  if release_immediately then
    perform app_private.materialize_feedback_draft(
      selected_submission.id,
      selected_draft_id,
      null
    );
  end if;

  update app_private.async_jobs j
  set
    status = 'succeeded',
    worker_id = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = null
  where j.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  select s.*
  into selected_submission
  from public.submissions s
  where s.id = selected_submission.id;

  return query
  select
    selected_submission.id,
    selected_submission.evaluation_status,
    selected_submission.release_status;
end;
$$;

revoke all on function public.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.complete_writing_evaluation(uuid, bigint, uuid, jsonb)
to service_role;

create or replace function app_private.release_due_feedback_internal(
  batch_size integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_feedback record;
  released_count integer := 0;
  selected_limit integer := greatest(1, least(coalesce(batch_size, 25), 25));
begin
  for due_feedback in
    select s.id as submission_id, fd.id as draft_id
    from public.submissions s
    join app_private.feedback_drafts fd
      on fd.submission_id = s.id
     and fd.state in ('draft', 'approved')
    where s.evaluation_status = 'ready'
      and s.release_status = 'scheduled'
      and s.release_at <= now()
    order by s.release_at, s.id
    for update of s skip locked
    limit selected_limit
  loop
    begin
      perform app_private.materialize_feedback_draft(
        due_feedback.submission_id,
        due_feedback.draft_id,
        null
      );
      released_count := released_count + 1;
    exception when others then
      -- The block is a subtransaction: any partially materialized lines or
      -- parent changes are rolled back before this poison draft is held.
      update app_private.feedback_drafts fd
      set state = 'needs_review'
      where fd.id = due_feedback.draft_id
        and fd.state in ('draft', 'approved');

      update public.submissions s
      set
        evaluation_status = 'needs_review',
        release_status = 'held',
        release_at = null,
        status = 'needs_review',
        feedback_error = 'release_validation_failed'
      where s.id = due_feedback.submission_id;
    end;
  end loop;

  return released_count;
end;
$$;

revoke all on function app_private.release_due_feedback_internal(integer)
from public, anon, authenticated, service_role;

create or replace function public.release_due_feedback(batch_size integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();
  return app_private.release_due_feedback_internal(batch_size);
end;
$$;

revoke all on function public.release_due_feedback(integer)
from public, anon, authenticated;
grant execute on function public.release_due_feedback(integer) to service_role;

create or replace function app_private.queue_message_exists(
  target_queue_name text,
  target_queue_message_id bigint
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select case target_queue_name
    when 'writing_evaluation' then exists (
      select 1 from pgmq.q_writing_evaluation q
      where q.msg_id = target_queue_message_id
    )
    when 'worksheet_generation' then exists (
      select 1 from pgmq.q_worksheet_generation q
      where q.msg_id = target_queue_message_id
    )
    when 'worksheet_answer_evaluation' then exists (
      select 1 from pgmq.q_worksheet_answer_evaluation q
      where q.msg_id = target_queue_message_id
    )
    else false
  end;
$$;

revoke all on function app_private.queue_message_exists(text, bigint)
from public, anon, authenticated, service_role;

create or replace function app_private.reconcile_async_job(target_job_id uuid)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  replacement_message_id bigint;
begin
  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.status not in ('queued', 'retry', 'processing')
    or (
      selected_job.queue_message_id is not null
      and app_private.queue_message_exists(
        selected_job.queue_name,
        selected_job.queue_message_id
      )
    )
  then
    return selected_job;
  end if;

  if selected_job.attempt_count >= 3 then
    update app_private.async_jobs j
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'queue_message_missing'
    where j.id = selected_job.id
    returning j.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      'queue_message_missing'
    );
    return selected_job;
  end if;

  select sent.send
  into replacement_message_id
  from pgmq.send(
    selected_job.queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    0
  ) sent;

  update app_private.async_jobs j
  set
    status = 'retry',
    queue_message_id = replacement_message_id,
    worker_id = null,
    lease_expires_at = null,
    available_at = now(),
    last_error_code = 'queue_message_reconciled'
  where j.id = selected_job.id
  returning j.* into selected_job;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'queued',
    null
  );

  return selected_job;
end;
$$;

revoke all on function app_private.reconcile_async_job(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.reconcile_async_jobs_internal(
  target_queue_name text default null
)
returns table (repaired_count integer, dead_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  reconciled app_private.async_jobs%rowtype;
begin
  repaired_count := 0;
  dead_count := 0;

  if target_queue_name is not null and target_queue_name not in (
    'writing_evaluation',
    'worksheet_generation',
    'worksheet_answer_evaluation'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported queue.';
  end if;

  for candidate in
    select j.id
    from app_private.async_jobs j
    where j.status in ('queued', 'retry', 'processing')
      and (target_queue_name is null or j.queue_name = target_queue_name)
      and (
        j.queue_message_id is null
        or not app_private.queue_message_exists(j.queue_name, j.queue_message_id)
      )
    order by j.created_at
    limit 100
  loop
    select *
    into reconciled
    from app_private.reconcile_async_job(candidate.id);

    if reconciled.status = 'dead' then
      dead_count := dead_count + 1;
    elsif reconciled.last_error_code = 'queue_message_reconciled' then
      repaired_count := repaired_count + 1;
    end if;
  end loop;

  return next;
end;
$$;

revoke all on function app_private.reconcile_async_jobs_internal(text)
from public, anon, authenticated, service_role;

create or replace function public.reconcile_async_jobs(target_queue_name text default null)
returns table (repaired_count integer, dead_count integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();
  return query
  select * from app_private.reconcile_async_jobs_internal(target_queue_name);
end;
$$;

revoke all on function public.reconcile_async_jobs(text)
from public, anon, authenticated;
grant execute on function public.reconcile_async_jobs(text)
to service_role;

-- Replace the compatibility write RPC so submission creation and queue send
-- commit or roll back together. Existing clients keep their old return shape;
-- api.submit_writing exposes the durable state contract.
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
  created_submission record;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_batch_id is null then
    raise exception using errcode = '22023', message = 'Select a batch before submitting writing.';
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
    update public.submissions s
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
      evaluation_version = greatest(s.evaluation_version, 1),
      feedback_started_at = null,
      feedback_completed_at = null,
      feedback_error = null
    where s.id = created_submission.submission_id;

    perform *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      created_submission.submission_id,
      1,
      format('writing:%s:%s', created_submission.submission_id, 1),
      (select auth.uid()),
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

revoke all on function public.create_writing_submission(text, uuid, uuid, text, boolean)
from public, anon;
grant execute on function public.create_writing_submission(text, uuid, uuid, text, boolean)
to authenticated;

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
    s.id,
    s.evaluation_status,
    s.release_status,
    s.release_at
  from public.submissions s
  where s.id = created_submission.submission_id;
end;
$$;

revoke all on function api.submit_writing(uuid, text, uuid, text)
from public, anon;
grant execute on function api.submit_writing(uuid, text, uuid, text)
to authenticated;

create or replace function public.retry_writing_evaluation(
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
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_submission public.submissions%rowtype;
  selected_job app_private.async_jobs%rowtype;
  queued_job record;
  next_version integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  select s.*
  into selected_submission
  from public.submissions s
  where s.id = target_submission_id
  for update;

  if selected_submission.id is null then
    raise exception using errcode = '02000', message = 'Submission not found.';
  end if;

  if not public.has_workspace_role(
    selected_submission.workspace_id,
    array['owner', 'teacher']
  ) and not public.is_platform_admin()
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.job_kind = 'writing_evaluation'
    and j.entity_id = selected_submission.id
    and j.status in ('queued', 'retry', 'processing')
  order by j.entity_version desc
  limit 1;

  if selected_job.id is not null then
    if selected_job.queue_message_id is null
      or not app_private.queue_message_exists(
        selected_job.queue_name,
        selected_job.queue_message_id
      )
    then
      select *
      into selected_job
      from app_private.reconcile_async_job(selected_job.id);

      select s.*
      into selected_submission
      from public.submissions s
      where s.id = target_submission_id;
    end if;

    if selected_job.status not in ('queued', 'retry', 'processing') then
      selected_job := null;
    end if;
  end if;

  if selected_job.id is not null then
    return query
    select
      selected_submission.id,
      selected_job.id,
      selected_submission.evaluation_status,
      selected_submission.release_status,
      selected_submission.release_at,
      false,
      true;
    return;
  end if;

  -- Prepared and released results require edit/release workflows, not a blind
  -- duplicate provider call. Failed work may be retried as a new version.
  if selected_submission.evaluation_status in ('ready', 'needs_review')
    or selected_submission.release_status = 'released'
  then
    return query
    select
      selected_submission.id,
      null::uuid,
      selected_submission.evaluation_status,
      selected_submission.release_status,
      selected_submission.release_at,
      false,
      false;
    return;
  end if;

  next_version := greatest(selected_submission.evaluation_version, 0) + 1;

  update public.submissions s
  set
    evaluation_version = next_version,
    evaluation_status = 'queued',
    release_status = case
      when s.feedback_mode = 'automatic_delayed' then 'scheduled'
      else 'held'
    end,
    release_at = case
      when s.feedback_mode = 'automatic_delayed'
        then coalesce(s.release_at, s.feedback_scheduled_at, now())
      else null
    end,
    status = 'submitted',
    feedback_started_at = null,
    feedback_completed_at = null,
    feedback_error = null
  where s.id = selected_submission.id;

  select enqueued.*
  into queued_job
  from app_private.enqueue_async_job(
    'writing_evaluation',
    selected_submission.id,
    next_version,
    format('writing:%s:%s', selected_submission.id, next_version),
    caller_id,
    0
  ) enqueued;

  return query
  select
    selected_submission.id,
    queued_job.job_id,
    'queued'::text,
    case
      when selected_submission.feedback_mode = 'automatic_delayed' then 'scheduled'
      else 'held'
    end,
    case
      when selected_submission.feedback_mode = 'automatic_delayed'
        then coalesce(
          selected_submission.release_at,
          selected_submission.feedback_scheduled_at,
          now()
        )
      else null
    end,
    true,
    false;
end;
$$;

revoke all on function public.retry_writing_evaluation(uuid)
from public, anon;
grant execute on function public.retry_writing_evaluation(uuid)
to authenticated;

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
language sql
security invoker
set search_path = ''
as $$
  select * from public.retry_writing_evaluation(target_submission_id);
$$;

revoke all on function api.retry_writing_evaluation(uuid)
from public, anon;
grant execute on function api.retry_writing_evaluation(uuid)
to authenticated;

create or replace function public.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  queued_job record;
  next_version integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = '02000', message = 'Practice assignment not found.';
  end if;

  if selected_assignment.student_id <> caller_id
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
    and not public.is_platform_admin()
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  if selected_assignment.student_id = caller_id and not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = selected_assignment.workspace_id
      and wm.user_id = caller_id
      and wm.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'Active class membership is required.';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress') then
    raise exception using errcode = '55000', message = 'Practice assignment is not active.';
  end if;

  if selected_assignment.practice_test_id is not null then
    update public.student_practice_assignments spa
    set generation_status = 'ready',
        generation_error = null
    where spa.id = selected_assignment.id;

    return query select selected_assignment.id, null::uuid, 'ready'::text;
    return;
  end if;

  if selected_assignment.generation_status = 'needs_review'
    and exists (
      select 1
      from public.practice_tests pt
      where pt.generated_from_assignment_id = selected_assignment.id
        and pt.quality_status = 'needs_review'
    )
  then
    return query select selected_assignment.id, null::uuid, 'needs_review'::text;
    return;
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.job_kind = 'worksheet_generation'
    and j.entity_id = selected_assignment.id
    and j.status in ('queued', 'retry', 'processing')
  order by j.entity_version desc
  limit 1;

  if selected_job.id is not null then
    return query
    select
      selected_assignment.id,
      selected_job.id,
      case when selected_job.status = 'processing' then 'generating' else 'queued' end;
    return;
  end if;

  next_version := greatest(selected_assignment.generation_version, 0) + 1;

  update public.student_practice_assignments spa
  set
    generation_version = next_version,
    generation_status = 'queued',
    generation_started_at = null,
    generation_completed_at = null,
    generation_error = null
  where spa.id = selected_assignment.id;

  select enqueued.*
  into queued_job
  from app_private.enqueue_async_job(
    'worksheet_generation',
    selected_assignment.id,
    next_version,
    format('worksheet-generation:%s:%s', selected_assignment.id, next_version),
    caller_id,
    0
  ) enqueued;

  return query select selected_assignment.id, queued_job.job_id, 'queued'::text;
end;
$$;

revoke all on function public.request_practice_worksheet(uuid)
from public, anon;
grant execute on function public.request_practice_worksheet(uuid)
to authenticated;

create or replace function api.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language sql
security invoker
set search_path = ''
as $$
  select * from public.request_practice_worksheet(target_assignment_id);
$$;

revoke all on function api.request_practice_worksheet(uuid)
from public, anon;
grant execute on function api.request_practice_worksheet(uuid)
to authenticated;

create or replace function public.complete_worksheet_generation(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  reusable_test public.practice_tests%rowtype;
  selected_worker_id uuid := worker_id;
  selected_test_id uuid;
  selected_quality_status text;
  target_level text;
  active_level_count integer;
  question_count integer;
  open_question_count integer;
  multiple_choice_count integer;
  fill_blank_count integer;
  completion_mode text;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.id = target_job_id
  for update;

  if selected_job.id is null or selected_job.job_kind <> 'worksheet_generation' then
    raise exception using errcode = '02000', message = 'Worksheet generation job not found.';
  end if;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = selected_job.entity_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = '02000', message = 'Practice assignment not found.';
  end if;

  if selected_job.status = 'succeeded' then
    select pt.id, pt.quality_status
    into selected_test_id, selected_quality_status
    from public.practice_tests pt
    where pt.id = selected_assignment.practice_test_id
       or pt.generation_job_id = selected_job.id
    order by (pt.id = selected_assignment.practice_test_id) desc, pt.created_at desc
    limit 1;

    return query
    select
      selected_assignment.id,
      selected_test_id,
      selected_assignment.generation_status,
      selected_quality_status;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
    or selected_job.entity_version <> selected_assignment.generation_version
  then
    raise exception using errcode = '55000', message = 'Job lease is no longer active.';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress')
    or not exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = selected_assignment.workspace_id
        and wm.user_id = selected_assignment.student_id
        and wm.role = 'student'
    )
  then
    raise exception using errcode = '55000', message = 'Practice assignment is not active.';
  end if;

  select gt.level
  into target_level
  from public.grammar_topics gt
  where gt.id = selected_assignment.grammar_topic_id;

  if target_level not in ('A1', 'A2', 'B1', 'B2') then
    select count(distinct b.level), min(b.level)
    into active_level_count, target_level
    from public.batch_students bs
    join public.batches b
      on b.id = bs.batch_id
     and b.workspace_id = bs.workspace_id
    where bs.workspace_id = selected_assignment.workspace_id
      and bs.student_id = selected_assignment.student_id
      and b.is_active;

    if active_level_count <> 1 then
      raise exception using errcode = '22023', message = 'Practice level context is ambiguous.';
    end if;
  end if;

  if worksheet is null
    or coalesce(jsonb_typeof(worksheet) <> 'object', true)
    or worksheet ->> 'schema_version' <> '1'
    or coalesce(worksheet ->> 'mode', '') not in ('reuse', 'generated')
  then
    raise exception using errcode = '22023', message = 'Worksheet completion payload is invalid.';
  end if;

  completion_mode := worksheet ->> 'mode';

  if completion_mode = 'reuse' then
    if coalesce(worksheet ->> 'reusable_practice_test_id', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception using errcode = '22023', message = 'Reusable worksheet id is invalid.';
    end if;

    select pt.*
    into reusable_test
    from public.practice_tests pt
    where pt.id = (worksheet ->> 'reusable_practice_test_id')::uuid
      and pt.workspace_id = selected_assignment.workspace_id
      and pt.grammar_topic_id = selected_assignment.grammar_topic_id
      and pt.level = target_level
      and pt.visibility = 'workspace'
      and pt.quality_status = 'approved'
      and pt.generation_source <> 'system_fallback'
      and not exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = pt.id
          and contract_question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior
        where prior.workspace_id = selected_assignment.workspace_id
          and prior.student_id = selected_assignment.student_id
          and prior.practice_test_id = pt.id
          and prior.id <> selected_assignment.id
      )
    for share;

    if reusable_test.id is null then
      raise exception using errcode = '22023', message = 'Reusable worksheet is not eligible.';
    end if;

    update public.student_practice_assignments spa
    set
      practice_test_id = reusable_test.id,
      generation_status = 'ready',
      generation_completed_at = now(),
      generation_error = null
    where spa.id = selected_assignment.id;

    selected_test_id := reusable_test.id;
    selected_quality_status := reusable_test.quality_status;
  else
    if worksheet ->> 'generation_source' <> 'deepseek'
      or coalesce(worksheet ->> 'level', '') <> target_level
      or coalesce(worksheet ->> 'difficulty', '') not in ('easy', 'medium', 'hard')
      or coalesce(worksheet ->> 'generator_model', '') !~ '^[a-zA-Z0-9._:/-]{1,100}$'
      or coalesce(jsonb_typeof(worksheet -> 'mini_lesson') <> 'object', true)
      or coalesce(jsonb_typeof(worksheet -> 'questions') <> 'array', true)
      or coalesce(jsonb_typeof(worksheet -> 'source_mix') <> 'object', true)
      or coalesce(jsonb_typeof(worksheet -> 'validation') <> 'object', true)
      or coalesce(worksheet #>> '{validation,deterministic}', '') <> 'true'
      or coalesce(worksheet #>> '{validation,independent_model}', '') not in ('true', 'false')
      or coalesce(worksheet #>> '{validation,critic_model}', '') !~ '^[a-zA-Z0-9._:/-]{1,100}$'
      or coalesce(worksheet #>> '{validation,attempt_count}', '') not in ('1', '2')
      or coalesce(jsonb_typeof(worksheet #> '{validation,checks}') <> 'object', true)
      or coalesce(jsonb_typeof(worksheet #> '{validation,rejection_reasons}') <> 'array', true)
      or worksheet #>> '{source_mix,mode}' <> 'deepseek'
      or coalesce(worksheet #>> '{source_mix,fallback_count}', '') <> '0'
      or length(btrim(coalesce(worksheet ->> 'title', ''))) not between 1 and 120
      or length(btrim(coalesce(worksheet ->> 'description', ''))) not between 1 and 1000
    then
      raise exception using errcode = '22023', message = 'Generated worksheet metadata is invalid.';
    end if;

    if exists (
      select 1
      from jsonb_each(worksheet #> '{validation,checks}') check_entry(key, value)
      where check_entry.key not in (
        'ambiguity_free',
        'no_answer_leakage',
        'duplicate_free',
        'level_fit',
        'topic_fit',
        'type_balance',
        'scoring_safe'
      )
        or jsonb_typeof(check_entry.value) <> 'boolean'
    )
      or (
        select count(*)
        from jsonb_each(worksheet #> '{validation,checks}')
      ) <> 7
      or jsonb_array_length(worksheet #> '{validation,rejection_reasons}') > 8
      or exists (
        select 1
        from jsonb_array_elements(worksheet #> '{validation,rejection_reasons}') reason(value)
        where jsonb_typeof(reason.value) <> 'string'
          or length(btrim(reason.value #>> '{}')) not between 1 and 240
      )
      or (
        coalesce(worksheet #>> '{validation,independent_model}', '') = 'true'
        and (
          jsonb_array_length(worksheet #> '{validation,rejection_reasons}') <> 0
          or exists (
            select 1
            from jsonb_each(worksheet #> '{validation,checks}') check_entry(key, value)
            where check_entry.value <> 'true'::jsonb
          )
        )
      )
      or (
        coalesce(worksheet #>> '{validation,independent_model}', '') = 'false'
        and jsonb_array_length(worksheet #> '{validation,rejection_reasons}') = 0
      )
    then
      raise exception using errcode = '22023', message = 'Independent worksheet validation is invalid.';
    end if;

    question_count := jsonb_array_length(worksheet -> 'questions');
    if question_count <> (case when target_level = 'A2' then 9 else 8 end)
      or coalesce(worksheet #>> '{source_mix,deepseek_count}', '') !~ '^[0-9]+$'
    then
      raise exception using errcode = '22023', message = 'Generated worksheet count is invalid.';
    end if;

    if (worksheet #>> '{source_mix,deepseek_count}')::integer <> question_count then
      raise exception using errcode = '22023', message = 'Generated worksheet source count is invalid.';
    end if;

    if coalesce(jsonb_typeof(worksheet #> '{mini_lesson,correct_examples}') <> 'array', true)
      or jsonb_array_length(worksheet #> '{mini_lesson,correct_examples}') not between 1 and 2
      or length(btrim(coalesce(worksheet #>> '{mini_lesson,short_explanation}', ''))) not between 1 and 500
      or length(btrim(coalesce(worksheet #>> '{mini_lesson,key_rule}', ''))) not between 1 and 400
      or length(btrim(coalesce(worksheet #>> '{mini_lesson,common_mistake_warning}', ''))) not between 1 and 300
      or length(btrim(coalesce(worksheet #>> '{mini_lesson,what_to_revise}', ''))) not between 1 and 300
    then
      raise exception using errcode = '22023', message = 'Generated mini lesson is invalid.';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') with ordinality q(item, ordinal)
      where jsonb_typeof(q.item) <> 'object'
        or coalesce(q.item ->> 'question_number', '') !~ '^[1-9][0-9]*$'
        or coalesce(q.item ->> 'question_type', '') not in (
          'multiple_choice',
          'fill_blank',
          'sentence_correction',
          'word_order',
          'transformation',
          'rewrite_sentence'
        )
        or coalesce(q.item ->> 'evaluation_mode', '') not in ('local_exact', 'open_evaluation')
        or (
          q.item ->> 'question_type' in ('multiple_choice', 'fill_blank')
          and q.item ->> 'evaluation_mode' <> 'local_exact'
        )
        or (
          q.item ->> 'question_type' in (
            'sentence_correction', 'word_order', 'transformation', 'rewrite_sentence'
          )
          and q.item ->> 'evaluation_mode' <> 'open_evaluation'
        )
        or coalesce(jsonb_typeof(q.item -> 'prompt') <> 'string', true)
        or length(btrim(coalesce(q.item ->> 'prompt', ''))) not between 12 and 800
        or coalesce(jsonb_typeof(q.item -> 'correct_answer') <> 'string', true)
        or length(btrim(coalesce(q.item ->> 'correct_answer', ''))) not between 1 and 500
        or lower(q.item ->> 'correct_answer') = 'manual_review'
        or q.item ->> 'correct_answer' ~* '\s(or|oder)\s|[|;/]'
        or coalesce(jsonb_typeof(q.item -> 'explanation') <> 'string', true)
        or length(btrim(coalesce(q.item ->> 'explanation', ''))) not between 1 and 600
        or coalesce(jsonb_typeof(q.item -> 'options') <> 'array', true)
        or coalesce(jsonb_typeof(q.item -> 'accepted_answers') <> 'array', true)
        or coalesce(jsonb_typeof(q.item -> 'rubric') not in ('object', 'null'), true)
    ) then
      raise exception using errcode = '22023', message = 'Generated worksheet question is invalid.';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') with ordinality q(item, ordinal)
      where (q.item ->> 'question_number')::integer <> q.ordinal
        or (
          q.item ->> 'question_type' = 'multiple_choice'
          and jsonb_array_length(q.item -> 'options') not between 3 and 4
        )
        or (
          q.item ->> 'question_type' <> 'multiple_choice'
          and jsonb_array_length(q.item -> 'options') <> 0
        )
        or (
          q.item ->> 'question_type' = 'fill_blank'
          and (
            length(q.item ->> 'prompt')
              - length(replace(q.item ->> 'prompt', '___', ''))
          ) / 3 <> 1
        )
        or (
          q.item ->> 'question_type' = 'fill_blank'
          and not (
            q.item ->> 'prompt' ~* '(definite|indefinite|possessive)[[:space:]]+article'
            or q.item ->> 'prompt' ~* '(bestimmt[^[:space:]]*|unbestimmt[^[:space:]]*|possessiv[^[:space:]]*)[[:space:]]+artikel'
            or q.item ->> 'prompt' ~* '(conjugate|correct form of|partizip[[:space:]]*(ii|2)|comparative|superlative)'
            or q.item ->> 'prompt' ~* '(konjugier|richtige[^[:space:]]*[[:space:]]+form|komparativ|superlativ|partizip[[:space:]]*(ii|2))'
            or (
              q.item ->> 'prompt' ~* '(closed[[:space:]]+)?(word[[:space:]]+bank|word[[:space:]]+list)|wortbank|wortliste'
              and position(',' in q.item ->> 'prompt') > 0
              and regexp_replace(lower(q.item ->> 'prompt'), '[^[:alnum:]]+', '', 'g')
                like '%' || regexp_replace(
                  lower(q.item ->> 'correct_answer'),
                  '[^[:alnum:]]+',
                  '',
                  'g'
                ) || '%'
            )
          )
        )
    ) then
      raise exception using errcode = '22023', message = 'Generated worksheet question constraints are invalid.';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*)
          from jsonb_array_elements_text(q.item -> 'options') option_value
          where lower(btrim(option_value)) = lower(btrim(q.item ->> 'correct_answer'))
        ) <> 1
    ) or exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*) <> count(distinct lower(btrim(option_value)))
          from jsonb_array_elements_text(q.item -> 'options') option_value
        )
    ) or (
      select count(*) <> count(distinct lower(regexp_replace(btrim(q.item ->> 'prompt'), '\s+', ' ', 'g')))
      from jsonb_array_elements(worksheet -> 'questions') q(item)
    ) then
      raise exception using errcode = '22023', message = 'Generated worksheet contains duplicate or unsafe options.';
    end if;

    select
      count(*) filter (where q.item ->> 'evaluation_mode' = 'open_evaluation'),
      count(*) filter (where q.item ->> 'question_type' = 'multiple_choice'),
      count(*) filter (where q.item ->> 'question_type' = 'fill_blank')
    into open_question_count, multiple_choice_count, fill_blank_count
    from jsonb_array_elements(worksheet -> 'questions') q(item);

    if open_question_count not between 1 and 3
      or multiple_choice_count < 2
      or fill_blank_count < 2
    then
      raise exception using errcode = '22023', message = 'Generated worksheet mix is unsafe.';
    end if;

    insert into public.practice_tests (
      workspace_id,
      grammar_topic_id,
      level,
      difficulty,
      title,
      description,
      created_by_ai,
      teacher_reviewed,
      visibility,
      mini_lesson,
      generation_source,
      quality_status,
      quality_notes,
      generated_from_assignment_id,
      generator_model,
      generation_metadata,
      generation_job_id
    ) values (
      selected_assignment.workspace_id,
      selected_assignment.grammar_topic_id,
      target_level,
      worksheet ->> 'difficulty',
      btrim(worksheet ->> 'title'),
      btrim(worksheet ->> 'description'),
      true,
      false,
      case
        when (worksheet #>> '{validation,independent_model}')::boolean then 'workspace'
        else 'private'
      end,
      worksheet -> 'mini_lesson',
      'deepseek',
      case
        when (worksheet #>> '{validation,independent_model}')::boolean then 'approved'
        else 'needs_review'
      end,
      case
        when (worksheet #>> '{validation,independent_model}')::boolean
          then 'Passed deterministic and independent model validation.'
        else 'Quarantined after independent model rejection.'
      end,
      selected_assignment.id,
      worksheet ->> 'generator_model',
      jsonb_build_object(
        'schema_version', 1,
        'source_mix', worksheet -> 'source_mix',
        'validation', worksheet -> 'validation'
      ),
      selected_job.id
    )
    returning id into selected_test_id;

    insert into public.practice_test_questions (
      practice_test_id,
      question_number,
      question_type,
      evaluation_mode,
      prompt,
      options,
      correct_answer,
      accepted_answers,
      rubric,
      answer_contract_version,
      explanation
    )
    select
      selected_test_id,
      (q.item ->> 'question_number')::integer,
      q.item ->> 'question_type',
      q.item ->> 'evaluation_mode',
      btrim(q.item ->> 'prompt'),
      q.item -> 'options',
      btrim(q.item ->> 'correct_answer'),
      q.item -> 'accepted_answers',
      case when q.item -> 'rubric' = 'null'::jsonb then null else q.item -> 'rubric' end,
      1,
      btrim(q.item ->> 'explanation')
    from jsonb_array_elements(worksheet -> 'questions') q(item);

    update public.student_practice_assignments spa
    set
      practice_test_id = case
        when (worksheet #>> '{validation,independent_model}')::boolean
          then selected_test_id
        else null
      end,
      generation_status = case
        when (worksheet #>> '{validation,independent_model}')::boolean
          then 'ready'
        else 'needs_review'
      end,
      generation_completed_at = now(),
      generation_error = case
        when (worksheet #>> '{validation,independent_model}')::boolean
          then null
        else 'independent_validation_rejected'
      end
    where spa.id = selected_assignment.id;

    selected_quality_status := case
      when (worksheet #>> '{validation,independent_model}')::boolean
        then 'approved'
      else 'needs_review'
    end;
  end if;

  update app_private.async_jobs j
  set
    status = 'succeeded',
    worker_id = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = null
  where j.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  return query
  select
    selected_assignment.id,
    selected_test_id,
    case
      when completion_mode = 'reuse' then 'ready'
      when (worksheet #>> '{validation,independent_model}')::boolean then 'ready'
      else 'needs_review'
    end,
    selected_quality_status;
end;
$$;

revoke all on function public.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.complete_worksheet_generation(uuid, bigint, uuid, jsonb)
to service_role;

-- Persist every flexible-answer review, calculate the final score, transition
-- the assignment, and archive the queue message as one database transaction.
-- The worker cannot make partial reviews student-visible if finalization fails.
create or replace function public.complete_worksheet_answer_evaluation(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_worker_id uuid := worker_id;
  attempt_assignment_id uuid;
  open_question_count integer := 0;
  review_count integer := 0;
  completion_mode text;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.job_kind <> 'worksheet_answer_evaluation'
  then
    raise exception using errcode = '02000', message = 'Worksheet answer evaluation job not found.';
  end if;

  select pta.assignment_id
  into attempt_assignment_id
  from public.practice_test_attempts pta
  where pta.id = selected_job.entity_id;

  if attempt_assignment_id is null then
    raise exception using errcode = '02000', message = 'Practice attempt not found.';
  end if;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = attempt_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = '02000', message = 'Practice assignment not found.';
  end if;

  select pta.*
  into selected_attempt
  from public.practice_test_attempts pta
  where pta.id = selected_job.entity_id
  for update;

  if selected_attempt.id is null
    or selected_attempt.assignment_id <> selected_assignment.id
  then
    raise exception using errcode = '55000', message = 'Practice attempt context changed.';
  end if;

  -- A successfully archived delivery may be acknowledged again by a caller
  -- that did not receive the first response. Return the terminal state without
  -- repeating review writes or score/statistics updates.
  if selected_job.status = 'succeeded' then
    return query
    select
      selected_attempt.id,
      selected_assignment.id,
      selected_attempt.evaluation_status,
      selected_attempt.status,
      selected_assignment.status,
      selected_attempt.score_points,
      selected_attempt.max_score_points,
      selected_attempt.score_percent,
      selected_attempt.passed;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
    or selected_job.entity_version <> selected_attempt.evaluation_version
  then
    raise exception using errcode = '55000', message = 'Job lease is no longer active.';
  end if;

  if selected_attempt.evaluation_status <> 'evaluating'
    or selected_attempt.status not in ('submitted', 'checked')
    or selected_attempt.practice_test_id <> selected_assignment.practice_test_id
    or selected_assignment.latest_attempt_id <> selected_attempt.id
    or selected_attempt.workspace_id <> selected_assignment.workspace_id
    or selected_attempt.student_id <> selected_assignment.student_id
    or selected_assignment.status not in ('completed', 'passed', 'failed')
    or not exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = selected_assignment.workspace_id
        and wm.user_id = selected_assignment.student_id
        and wm.role = 'student'
    )
  then
    raise exception using errcode = '55000', message = 'Practice attempt is not active.';
  end if;

  select count(*)::integer
  into open_question_count
  from public.practice_test_questions ptq
  where ptq.practice_test_id = selected_attempt.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      ptq.question_type,
      ptq.correct_answer,
      ptq.evaluation_mode,
      ptq.accepted_answers
    );

  if open_question_count > 3 then
    raise exception using errcode = '22023', message = 'Flexible question limit exceeded.';
  end if;

  if result is null
    or coalesce(jsonb_typeof(result) <> 'object', true)
    or not (result ?& array['schema_version', 'mode', 'evaluator_model', 'reviews'])
    or result - array['schema_version', 'mode', 'evaluator_model', 'reviews']::text[] <> '{}'::jsonb
    or result -> 'schema_version' <> '1'::jsonb
    or coalesce(jsonb_typeof(result -> 'mode') <> 'string', true)
    or coalesce(result ->> 'mode', '') not in ('not_needed', 'evaluated')
    or coalesce(jsonb_typeof(result -> 'reviews') <> 'array', true)
  then
    raise exception using errcode = '22023', message = 'Worksheet answer completion payload is invalid.';
  end if;

  completion_mode := result ->> 'mode';
  review_count := jsonb_array_length(result -> 'reviews');

  if (completion_mode = 'not_needed' and (
      open_question_count <> 0
      or review_count <> 0
      or result -> 'evaluator_model' <> 'null'::jsonb
    ))
    or (completion_mode = 'evaluated' and (
      open_question_count = 0
      or review_count <> open_question_count
      or review_count > 3
    ))
  then
    raise exception using errcode = '22023', message = 'Worksheet answer completion mode is invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review_item
    where jsonb_typeof(review_item) <> 'object'
      or not (review_item ?& array[
        'question_id',
        'review_status',
        'points_awarded',
        'max_points',
        'evaluator_source',
        'feedback_text',
        'corrected_answer',
        'model_answer',
        'short_reason'
      ])
      or review_item - array[
        'question_id',
        'review_status',
        'points_awarded',
        'max_points',
        'evaluator_source',
        'feedback_text',
        'corrected_answer',
        'model_answer',
        'short_reason'
      ]::text[] <> '{}'::jsonb
      or coalesce(jsonb_typeof(review_item -> 'question_id') <> 'string', true)
      or coalesce(review_item ->> 'question_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(jsonb_typeof(review_item -> 'review_status') <> 'string', true)
      or coalesce(review_item ->> 'review_status', '') not in (
        'correct',
        'partially_correct',
        'capitalization_issue',
        'minor_punctuation',
        'incorrect'
      )
      or coalesce(jsonb_typeof(review_item -> 'points_awarded') <> 'number', true)
      or coalesce(jsonb_typeof(review_item -> 'max_points') <> 'number', true)
      or review_item -> 'max_points' <> '1'::jsonb
      or review_item -> 'points_awarded' <> case review_item ->> 'review_status'
        when 'correct' then '1'::jsonb
        when 'minor_punctuation' then '1'::jsonb
        when 'partially_correct' then '0.5'::jsonb
        when 'capitalization_issue' then '0.5'::jsonb
        when 'incorrect' then '0'::jsonb
        else 'null'::jsonb
      end
      or coalesce(jsonb_typeof(review_item -> 'evaluator_source') <> 'string', true)
      or coalesce(review_item ->> 'evaluator_source', '') not in ('deepseek', 'manual')
      or coalesce(jsonb_typeof(review_item -> 'feedback_text') <> 'string', true)
      or length(btrim(coalesce(review_item ->> 'feedback_text', ''))) not between 1 and 500
      or coalesce(jsonb_typeof(review_item -> 'short_reason') <> 'string', true)
      or length(btrim(coalesce(review_item ->> 'short_reason', ''))) not between 1 and 240
      or coalesce(jsonb_typeof(review_item -> 'corrected_answer') not in ('string', 'null'), true)
      or length(btrim(coalesce(review_item ->> 'corrected_answer', ''))) > 500
      or coalesce(jsonb_typeof(review_item -> 'model_answer') not in ('string', 'null'), true)
      or length(btrim(coalesce(review_item ->> 'model_answer', ''))) > 500
      or lower(btrim(coalesce(review_item ->> 'model_answer', ''))) in (
        'manual_review',
        'manual review',
        'open_review',
        'flexible_review',
        'requires_review'
      )
      or concat_ws(
        ' ',
        review_item ->> 'feedback_text',
        review_item ->> 'corrected_answer',
        review_item ->> 'model_answer',
        review_item ->> 'short_reason'
      ) ~* '(deepseek|chatgpt|artificial intelligence|language model|internal prompt|automatic correction)'
  ) then
    raise exception using errcode = '22023', message = 'Worksheet answer review is invalid.';
  end if;

  if (
    select count(*) <> count(distinct (review_item ->> 'question_id')::uuid)
    from jsonb_array_elements(result -> 'reviews') review_item
  ) then
    raise exception using errcode = '22023', message = 'Worksheet answer reviews contain duplicates.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review_item
    left join public.practice_test_questions ptq
      on ptq.id = (review_item ->> 'question_id')::uuid
      and ptq.practice_test_id = selected_attempt.practice_test_id
      and not app_private.is_practice_question_locally_scorable(
        ptq.question_type,
        ptq.correct_answer,
        ptq.evaluation_mode,
        ptq.accepted_answers
      )
    where ptq.id is null
  ) or exists (
    select 1
    from public.practice_test_questions ptq
    where ptq.practice_test_id = selected_attempt.practice_test_id
      and not app_private.is_practice_question_locally_scorable(
        ptq.question_type,
        ptq.correct_answer,
        ptq.evaluation_mode,
        ptq.accepted_answers
      )
      and not exists (
        select 1
        from jsonb_array_elements(result -> 'reviews') review_item
        where (review_item ->> 'question_id')::uuid = ptq.id
      )
  ) then
    raise exception using errcode = '22023', message = 'Worksheet answer reviews do not match the worksheet.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review_item
    where review_item ->> 'evaluator_source' = 'deepseek'
  ) then
    if coalesce(jsonb_typeof(result -> 'evaluator_model') <> 'string', true)
      or coalesce(result ->> 'evaluator_model', '') !~ '^[a-zA-Z0-9._:/-]{1,100}$'
    then
      raise exception using errcode = '22023', message = 'Worksheet evaluator model is invalid.';
    end if;
  elsif result -> 'evaluator_model' <> 'null'::jsonb then
    raise exception using errcode = '22023', message = 'Worksheet evaluator model is invalid.';
  end if;

  delete from public.practice_attempt_question_reviews paqr
  where paqr.attempt_id = selected_attempt.id
    and exists (
      select 1
      from public.practice_test_questions ptq
      where ptq.id = paqr.question_id
        and ptq.practice_test_id = selected_attempt.practice_test_id
        and not app_private.is_practice_question_locally_scorable(
          ptq.question_type,
          ptq.correct_answer,
          ptq.evaluation_mode,
          ptq.accepted_answers
        )
    );

  insert into public.practice_attempt_question_reviews (
    attempt_id,
    assignment_id,
    workspace_id,
    student_id,
    question_id,
    review_status,
    points_awarded,
    max_points,
    evaluator_source,
    feedback_text,
    corrected_answer,
    model_answer,
    short_reason
  )
  select
    selected_attempt.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    (review_item ->> 'question_id')::uuid,
    review_item ->> 'review_status',
    (review_item ->> 'points_awarded')::numeric,
    1,
    review_item ->> 'evaluator_source',
    btrim(review_item ->> 'feedback_text'),
    nullif(btrim(review_item ->> 'corrected_answer'), ''),
    nullif(btrim(review_item ->> 'model_answer'), ''),
    btrim(review_item ->> 'short_reason')
  from jsonb_array_elements(result -> 'reviews') review_item;

  update public.practice_test_attempts pta
  set evaluation_model = nullif(result ->> 'evaluator_model', '')
  where pta.id = selected_attempt.id;

  -- This existing function calculates local + semantic points and updates the
  -- assignment/statistics. Any exception rolls back the reviews above.
  perform public.finalize_practice_attempt_evaluation(selected_attempt.id);

  select pta.*
  into selected_attempt
  from public.practice_test_attempts pta
  where pta.id = selected_attempt.id;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = selected_assignment.id;

  if selected_attempt.evaluation_status not in ('completed', 'not_needed')
    or selected_attempt.status <> 'checked'
    or selected_assignment.status not in ('passed', 'failed')
  then
    raise exception using errcode = '55000', message = 'Practice evaluation did not reach a terminal state.';
  end if;

  update app_private.async_jobs j
  set
    status = 'succeeded',
    worker_id = null,
    lease_expires_at = null,
    completed_at = now(),
    last_error_code = null
  where j.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  return query
  select
    selected_attempt.id,
    selected_assignment.id,
    selected_attempt.evaluation_status,
    selected_attempt.status,
    selected_assignment.status,
    selected_attempt.score_points,
    selected_attempt.max_score_points,
    selected_attempt.score_percent,
    selected_attempt.passed;
end;
$$;

revoke all on function public.complete_worksheet_answer_evaluation(uuid, bigint, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.complete_worksheet_answer_evaluation(uuid, bigint, uuid, jsonb)
to service_role;

-- The legacy submit RPC now enqueues flexible-answer evaluation in the same
-- transaction as the attempt. Objective-only attempts remain terminal locally.
create or replace function public.submit_practice_attempt(
  target_assignment_id uuid,
  submitted_answers jsonb
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_percent numeric,
  passed boolean,
  question_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  submitted_result record;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  caller_id uuid := (select auth.uid());
  next_version integer;
  semantic_question_count integer := 0;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = '02000', message = 'Practice assignment not found.';
  end if;

  if selected_assignment.student_id = caller_id and not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = selected_assignment.workspace_id
      and wm.user_id = caller_id
      and wm.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'Active class membership is required.';
  end if;

  if submitted_answers is null
    or coalesce(jsonb_typeof(submitted_answers) <> 'array', true)
    or jsonb_array_length(submitted_answers) > 50
    or exists (
      select 1
      from jsonb_array_elements(submitted_answers) answer_item
      where jsonb_typeof(answer_item) <> 'object'
        or not (answer_item ?& array['question_id', 'answer'])
        or coalesce(jsonb_typeof(answer_item -> 'question_id') <> 'string', true)
        or coalesce(answer_item ->> 'question_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(jsonb_typeof(answer_item -> 'answer') <> 'string', true)
        or length(answer_item ->> 'answer') > 1000
    )
  then
    raise exception using errcode = '22023', message = 'Practice answers are invalid.';
  end if;

  if (
    select count(*) <> count(distinct (answer_item ->> 'question_id')::uuid)
    from jsonb_array_elements(submitted_answers) answer_item
  ) then
    raise exception using errcode = '22023', message = 'Practice answers contain duplicates.';
  end if;

  select count(*)::integer
  into semantic_question_count
  from public.practice_test_questions ptq
  where ptq.practice_test_id = selected_assignment.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      ptq.question_type,
      ptq.correct_answer,
      ptq.evaluation_mode,
      ptq.accepted_answers
    );

  if semantic_question_count > 3 then
    raise exception using
      errcode = '22023',
      message = 'Worksheet exceeds the flexible question limit.';
  end if;

  select result.*
  into submitted_result
  from app_private.submit_practice_attempt_internal(
    target_assignment_id,
    submitted_answers
  ) result;

  if submitted_result.latest_attempt_id is not null then
    select pta.*
    into selected_attempt
    from public.practice_test_attempts pta
    where pta.id = submitted_result.latest_attempt_id
    for update;

    if selected_attempt.evaluation_status = 'pending' then
      next_version := greatest(selected_attempt.evaluation_version, 0) + 1;

      update public.practice_test_attempts pta
      set
        evaluation_status = 'queued',
        evaluation_version = next_version,
        evaluation_started_at = null,
        evaluation_completed_at = null,
        evaluation_error = null
      where pta.id = selected_attempt.id;

      perform *
      from app_private.enqueue_async_job(
        'worksheet_answer_evaluation',
        selected_attempt.id,
        next_version,
        format('worksheet-evaluation:%s:%s', selected_attempt.id, next_version),
        (select auth.uid()),
        0
      );
    end if;
  end if;

  return query
  select
    submitted_result.assignment_id,
    submitted_result.workspace_id,
    submitted_result.student_id,
    submitted_result.grammar_topic_id,
    submitted_result.grammar_topic_name,
    submitted_result.grammar_topic_slug,
    submitted_result.practice_test_id,
    submitted_result.worksheet_title,
    submitted_result.worksheet_level,
    submitted_result.worksheet_difficulty,
    submitted_result.status,
    submitted_result.source,
    submitted_result.assigned_at,
    submitted_result.started_at,
    submitted_result.completed_at,
    submitted_result.latest_attempt_id,
    submitted_result.latest_attempt_status,
    submitted_result.score,
    submitted_result.max_score,
    submitted_result.score_percent,
    submitted_result.passed,
    submitted_result.question_count;
end;
$$;

revoke all on function public.submit_practice_attempt(uuid, jsonb)
from public, anon;
grant execute on function public.submit_practice_attempt(uuid, jsonb)
to authenticated;

create or replace function api.submit_practice_attempt(
  target_assignment_id uuid,
  submitted_answers jsonb
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_percent numeric,
  passed boolean,
  question_count integer
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.submit_practice_attempt(target_assignment_id, submitted_answers);
$$;

revoke all on function api.submit_practice_attempt(uuid, jsonb)
from public, anon;
grant execute on function api.submit_practice_attempt(uuid, jsonb)
to authenticated;

create or replace function public.retry_practice_attempt_evaluation(
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
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_attempt public.practice_test_attempts%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  queued_job record;
  next_version integer;
  attempt_assignment_id uuid;
  semantic_question_count integer := 0;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  -- Match the completion lock order when a live job already exists.
  select j.*
  into selected_job
  from app_private.async_jobs j
  where j.job_kind = 'worksheet_answer_evaluation'
    and j.entity_id = target_attempt_id
    and j.status in ('queued', 'retry', 'processing')
  order by j.entity_version desc
  limit 1
  for update;

  select pta.assignment_id
  into attempt_assignment_id
  from public.practice_test_attempts pta
  where pta.id = target_attempt_id;

  if attempt_assignment_id is null then
    raise exception using errcode = '02000', message = 'Practice attempt not found.';
  end if;

  select spa.*
  into selected_assignment
  from public.student_practice_assignments spa
  where spa.id = attempt_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = '02000', message = 'Practice assignment not found.';
  end if;

  select pta.*
  into selected_attempt
  from public.practice_test_attempts pta
  where pta.id = target_attempt_id
  for update;

  if selected_attempt.id is null
    or selected_attempt.assignment_id <> selected_assignment.id
  then
    raise exception using errcode = '55000', message = 'Practice attempt context changed.';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  if selected_assignment.latest_attempt_id <> selected_attempt.id
    or selected_attempt.practice_test_id <> selected_assignment.practice_test_id
    or selected_attempt.workspace_id <> selected_assignment.workspace_id
    or selected_attempt.student_id <> selected_assignment.student_id
    or not exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = selected_assignment.workspace_id
        and wm.user_id = selected_assignment.student_id
        and wm.role = 'student'
    )
  then
    raise exception using errcode = '55000', message = 'Practice attempt is not active.';
  end if;

  if selected_attempt.status not in ('submitted', 'checked')
    or selected_assignment.status not in ('completed', 'passed', 'failed')
  then
    raise exception using errcode = '55000', message = 'Practice attempt is not retryable.';
  end if;

  select count(*)::integer
  into semantic_question_count
  from public.practice_test_questions ptq
  where ptq.practice_test_id = selected_attempt.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      ptq.question_type,
      ptq.correct_answer,
      ptq.evaluation_mode,
      ptq.accepted_answers
    );

  if semantic_question_count not between 1 and 3 then
    raise exception using errcode = '22023', message = 'Practice feedback requires teacher review.';
  end if;

  -- Recheck after the attempt lock so simultaneous teacher retries collapse to
  -- one durable job and one version increment.
  if selected_job.id is null then
    select j.*
    into selected_job
    from app_private.async_jobs j
    where j.job_kind = 'worksheet_answer_evaluation'
      and j.entity_id = selected_attempt.id
      and j.status in ('queued', 'retry', 'processing')
    order by j.entity_version desc
    limit 1
    for update;
  end if;

  if selected_job.id is not null then
    if selected_job.entity_version <> selected_attempt.evaluation_version then
      if selected_job.queue_message_id is not null then
        perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);
      end if;
      update app_private.async_jobs j
      set
        status = 'dead',
        worker_id = null,
        lease_expires_at = null,
        dead_at = now(),
        last_error_code = 'entity_version_superseded'
      where j.id = selected_job.id;
      selected_job := null;
    else
      select reconciled.*
      into selected_job
      from app_private.reconcile_async_job(selected_job.id) reconciled;

      select pta.*
      into selected_attempt
      from public.practice_test_attempts pta
      where pta.id = target_attempt_id;

      if selected_job.status in ('queued', 'retry', 'processing') then
        return query
        select
          selected_attempt.id,
          selected_assignment.id,
          selected_job.id,
          case when selected_job.status = 'processing' then 'evaluating' else 'queued' end,
          false,
          true;
        return;
      end if;
      selected_job := null;
    end if;
  end if;

  if selected_attempt.evaluation_status <> 'failed' then
    raise exception using errcode = '55000', message = 'Only failed practice feedback can be retried.';
  end if;

  next_version := greatest(selected_attempt.evaluation_version, 0) + 1;

  update public.practice_test_attempts pta
  set
    evaluation_status = 'queued',
    evaluation_version = next_version,
    evaluation_started_at = null,
    evaluation_completed_at = null,
    evaluation_error = null,
    evaluation_model = null
  where pta.id = selected_attempt.id;

  select enqueued.*
  into queued_job
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    selected_attempt.id,
    next_version,
    format('worksheet-evaluation:%s:%s', selected_attempt.id, next_version),
    caller_id,
    0
  ) enqueued;

  return query
  select
    selected_attempt.id,
    selected_assignment.id,
    queued_job.job_id,
    'queued'::text,
    true,
    false;
end;
$$;

revoke all on function public.retry_practice_attempt_evaluation(uuid)
from public, anon;
grant execute on function public.retry_practice_attempt_evaluation(uuid)
to authenticated;

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
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.retry_practice_attempt_evaluation(target_attempt_id);
$$;

revoke all on function api.retry_practice_attempt_evaluation(uuid)
from public, anon;
grant execute on function api.retry_practice_attempt_evaluation(uuid)
to authenticated;

create or replace function app_private.offboard_student_internal(
  target_student_id uuid,
  target_workspace_id uuid
)
returns table (
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_role text;
  removed_assignments integer := 0;
  cancelled_requests integer := 0;
  removed_memberships integer := 0;
  active_job app_private.async_jobs%rowtype;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  select wm.role
  into target_role
  from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = target_student_id
  for update;

  if target_role is not null and target_role <> 'student' then
    raise exception using errcode = '23514', message = 'Only student memberships can be offboarded.';
  end if;

  for active_job in
    select j.*
    from app_private.async_jobs j
    where j.status in ('queued', 'retry', 'processing')
      and (
        (
          j.job_kind = 'worksheet_generation'
          and exists (
            select 1
            from public.student_practice_assignments spa
            where spa.id = j.entity_id
              and spa.workspace_id = target_workspace_id
              and spa.student_id = target_student_id
              and spa.status in ('unlocked', 'in_progress')
          )
        )
        or (
          j.job_kind = 'worksheet_answer_evaluation'
          and exists (
            select 1
            from public.practice_test_attempts pta
            join public.student_practice_assignments spa
              on spa.id = pta.assignment_id
            where pta.id = j.entity_id
              and spa.workspace_id = target_workspace_id
              and spa.student_id = target_student_id
              and pta.evaluation_status in ('pending', 'queued', 'evaluating')
          )
        )
      )
    for update
  loop
    if active_job.queue_message_id is not null then
      perform pgmq.archive(active_job.queue_name, active_job.queue_message_id);
    end if;

    update app_private.async_jobs j
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'student_offboarded'
    where j.id = active_job.id;
  end loop;

  update public.practice_test_attempts pta
  set
    evaluation_status = 'failed',
    evaluation_completed_at = now(),
    evaluation_error = 'student_offboarded'
  where pta.assignment_id in (
    select spa.id
    from public.student_practice_assignments spa
    where spa.workspace_id = target_workspace_id
      and spa.student_id = target_student_id
  )
    and pta.evaluation_status in ('pending', 'queued', 'evaluating');

  update public.student_practice_assignments spa
  set
    status = 'cancelled',
    completed_at = coalesce(spa.completed_at, now()),
    generation_status = case
      when spa.generation_status in ('queued', 'generating') then 'failed'
      else spa.generation_status
    end,
    generation_completed_at = case
      when spa.generation_status in ('queued', 'generating') then now()
      else spa.generation_completed_at
    end,
    generation_error = case
      when spa.generation_status in ('queued', 'generating') then 'student_offboarded'
      else spa.generation_error
    end
  where spa.workspace_id = target_workspace_id
    and spa.student_id = target_student_id
    and spa.status in ('unlocked', 'in_progress');

  update public.batch_join_requests bjr
  set
    status = 'cancelled',
    decided_by = caller_id,
    decided_at = now()
  where bjr.workspace_id = target_workspace_id
    and bjr.student_id = target_student_id
    and bjr.status in ('pending', 'approved');
  get diagnostics cancelled_requests = row_count;

  delete from public.batch_students bs
  where bs.workspace_id = target_workspace_id
    and bs.student_id = target_student_id;
  get diagnostics removed_assignments = row_count;

  delete from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = target_student_id
    and wm.role = 'student';
  get diagnostics removed_memberships = row_count;

  removed_batch_assignments := removed_assignments;
  cancelled_join_requests := cancelled_requests;
  membership_removed := removed_memberships > 0;
  return next;
end;
$$;

revoke all on function app_private.offboard_student_internal(uuid, uuid)
from public, anon, authenticated, service_role;

drop policy if exists "practice_tests_select_workspace_members"
on public.practice_tests;

create policy "practice_tests_select_assigned_or_teacher"
on public.practice_tests for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or exists (
    select 1
    from public.student_practice_assignments spa
    where spa.practice_test_id = practice_tests.id
      and spa.student_id = (select auth.uid())
  )
);

-- Child feedback is readable by a student only after the parent release is
-- committed. Teachers retain private review access. Parent correction fields
-- remain null while held, so direct public-schema reads cannot reveal drafts.
drop policy if exists "submission_lines_select_parent_visible"
on public.submission_lines;

create policy "submission_lines_select_released_or_teacher"
on public.submission_lines for select
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = submission_lines.submission_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
        or (
          s.student_id = (select auth.uid())
          and s.release_status = 'released'
        )
      )
  )
);

drop policy if exists "submission_grammar_topics_select_parent_visible"
on public.submission_grammar_topics;

create policy "submission_grammar_topics_select_released_or_teacher"
on public.submission_grammar_topics for select
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = submission_grammar_topics.submission_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
        or (
          s.student_id = (select auth.uid())
          and s.release_status = 'released'
        )
      )
  )
);

drop policy if exists "practice_attempt_question_reviews_select_owner_or_teacher"
on public.practice_attempt_question_reviews;

create policy "practice_attempt_question_reviews_select_terminal_or_teacher"
on public.practice_attempt_question_reviews for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.practice_test_attempts pta
      where pta.id = practice_attempt_question_reviews.attempt_id
        and pta.status = 'checked'
        and pta.evaluation_status in ('completed', 'not_needed')
    )
  )
);

create or replace view api.submissions
with (security_invoker = true, security_barrier = true)
as
select
  s.id,
  s.workspace_id,
  s.student_id,
  s.batch_id,
  s.question_id,
  s.global_question_id,
  s.question_source,
  s.mode,
  s.original_text,
  s.status,
  case
    when s.release_status = 'released'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.corrected_text
    else null
  end as corrected_text,
  case
    when s.release_status = 'released'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.overall_summary
    else null
  end as overall_summary,
  case
    when s.release_status = 'released'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.level_detected
    else null
  end as level_detected,
  case
    when s.release_status = 'released'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.checked_at
    else null
  end as checked_at,
  s.feedback_mode,
  s.feedback_scheduled_at,
  s.feedback_started_at,
  s.feedback_completed_at,
  case when s.feedback_error is null then null else 'feedback_failed' end
    as feedback_error,
  s.created_at,
  s.updated_at,
  s.evaluation_status,
  s.release_status,
  s.release_at,
  s.evaluation_version
from public.submissions s;

create or replace view api.submission_lines
with (security_invoker = true, security_barrier = true)
as
select
  sl.id,
  sl.submission_id,
  sl.line_number,
  sl.original_line,
  sl.corrected_line,
  sl.status,
  sl.grammar_topic_id,
  sl.short_explanation,
  sl.detailed_explanation,
  sl.changed_parts,
  sl.created_at
from public.submission_lines sl
join public.submissions s on s.id = sl.submission_id
where
  s.release_status = 'released'
  or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']);

create or replace view api.submission_grammar_topics
with (security_invoker = true, security_barrier = true)
as
select
  sgt.id,
  sgt.submission_id,
  sgt.grammar_topic_id,
  sgt.count,
  sgt.severity,
  sgt.simple_explanation,
  sgt.created_at
from public.submission_grammar_topics sgt
join public.submissions s on s.id = sgt.submission_id
where
  s.release_status = 'released'
  or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']);

-- Weakness evidence is derived exclusively from released feedback. Private,
-- scheduled, failed, and uncertain drafts never affect adaptive practice.
create or replace function public.refresh_student_grammar_stats(
  target_workspace_id uuid,
  target_student_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  total_minor_issues integer,
  total_major_issues integer,
  total_correct_after_practice integer,
  weakness_level text,
  practice_unlocked boolean,
  last_seen_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if target_workspace_id is null or target_student_id is null then
    raise exception using errcode = '22023', message = 'Workspace and student are required.';
  end if;

  if jwt_role <> 'service_role' then
    if actor_id is null then
      raise exception using errcode = '28000', message = 'Authentication required.';
    end if;

    if actor_id <> target_student_id
      and not public.is_platform_admin()
      and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
    then
      raise exception using errcode = '42501', message = 'Permission denied.';
    end if;
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = target_student_id
      and wm.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'Student is not a member of this workspace.';
  end if;

  with topic_totals as (
    select
      sgt.grammar_topic_id,
      coalesce(sum(case when sgt.severity = 'minor' then sgt.count else 0 end), 0)::integer
        as minor_count,
      coalesce(sum(case when sgt.severity in ('major', 'mixed') then sgt.count else 0 end), 0)::integer
        as major_count,
      max(coalesce(s.checked_at, s.feedback_completed_at, s.updated_at, s.created_at))
        as seen_at
    from public.submissions s
    join public.submission_grammar_topics sgt on sgt.submission_id = s.id
    where s.workspace_id = target_workspace_id
      and s.student_id = target_student_id
      and s.release_status = 'released'
    group by sgt.grammar_topic_id
  )
  insert into public.student_grammar_stats (
    workspace_id,
    student_id,
    grammar_topic_id,
    total_minor_issues,
    total_major_issues,
    weakness_level,
    practice_unlocked,
    last_seen_at,
    updated_at
  )
  select
    target_workspace_id,
    target_student_id,
    totals.grammar_topic_id,
    totals.minor_count,
    totals.major_count,
    case
      when totals.major_count >= 1 then 'unlocked'
      when totals.minor_count >= 3 then 'unlocked'
      when totals.minor_count >= 2 then 'weak'
      else 'tracking'
    end,
    totals.major_count >= 1 or totals.minor_count >= 3,
    totals.seen_at,
    now()
  from topic_totals totals
  where totals.minor_count > 0 or totals.major_count > 0
  on conflict on constraint student_grammar_stats_workspace_id_student_id_grammar_topic_key
  do update set
    total_minor_issues = excluded.total_minor_issues,
    total_major_issues = excluded.total_major_issues,
    weakness_level = excluded.weakness_level,
    practice_unlocked = excluded.practice_unlocked,
    last_seen_at = excluded.last_seen_at,
    updated_at = now();

  delete from public.student_grammar_stats sgs
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
    and sgs.total_correct_after_practice = 0
    and not exists (
      select 1
      from public.submissions s
      join public.submission_grammar_topics sgt on sgt.submission_id = s.id
      where s.workspace_id = target_workspace_id
        and s.student_id = target_student_id
        and s.release_status = 'released'
        and sgt.grammar_topic_id = sgs.grammar_topic_id
        and sgt.count > 0
    );

  update public.student_grammar_stats sgs
  set
    total_minor_issues = 0,
    total_major_issues = 0,
    weakness_level = case
      when sgs.weakness_level = 'mastered' then 'mastered'
      else 'tracking'
    end,
    practice_unlocked = false,
    last_seen_at = null,
    updated_at = now()
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
    and sgs.total_correct_after_practice > 0
    and not exists (
      select 1
      from public.submissions s
      join public.submission_grammar_topics sgt on sgt.submission_id = s.id
      where s.workspace_id = target_workspace_id
        and s.student_id = target_student_id
        and s.release_status = 'released'
        and sgt.grammar_topic_id = sgs.grammar_topic_id
        and sgt.count > 0
    );

  return query
  select
    sgs.id,
    sgs.workspace_id,
    sgs.student_id,
    sgs.grammar_topic_id,
    gt.name,
    gt.slug,
    sgs.total_minor_issues,
    sgs.total_major_issues,
    sgs.total_correct_after_practice,
    sgs.weakness_level,
    sgs.practice_unlocked,
    sgs.last_seen_at,
    sgs.updated_at
  from public.student_grammar_stats sgs
  join public.grammar_topics gt on gt.id = sgs.grammar_topic_id
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
  order by
    sgs.practice_unlocked desc,
    sgs.total_major_issues desc,
    sgs.total_minor_issues desc,
    gt.name;
end;
$$;

revoke all on function public.refresh_student_grammar_stats(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.refresh_student_grammar_stats(uuid, uuid)
to service_role;

do $$
declare
  active_student record;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for active_student in
    select wm.workspace_id, wm.user_id as student_id
    from public.workspace_members wm
    where wm.role = 'student'
      and (
        exists (
          select 1
          from public.student_grammar_stats sgs
          where sgs.workspace_id = wm.workspace_id
            and sgs.student_id = wm.user_id
        )
        or exists (
          select 1
          from public.submissions s
          where s.workspace_id = wm.workspace_id
            and s.student_id = wm.user_id
            and s.release_status = 'released'
        )
      )
  loop
    perform public.refresh_student_grammar_stats(
      active_student.workspace_id,
      active_student.student_id
    );
  end loop;
end;
$$;

create or replace function public.get_async_queue_metrics()
returns table (
  queue_name text,
  queue_length bigint,
  oldest_message_age_seconds integer,
  queued_jobs bigint,
  processing_jobs bigint,
  retry_jobs bigint,
  dead_jobs bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();

  return query
  with queue_metrics as (
    select m.queue_name, m.queue_length, m.oldest_msg_age_sec
    from pgmq.metrics_all() m
    where m.queue_name in (
      'writing_evaluation',
      'worksheet_generation',
      'worksheet_answer_evaluation'
    )
  ), job_counts as (
    select
      j.queue_name,
      count(*) filter (where j.status = 'queued') as queued_jobs,
      count(*) filter (where j.status = 'processing') as processing_jobs,
      count(*) filter (where j.status = 'retry') as retry_jobs,
      count(*) filter (where j.status = 'dead') as dead_jobs
    from app_private.async_jobs j
    group by j.queue_name
  )
  select
    qm.queue_name,
    qm.queue_length,
    qm.oldest_msg_age_sec,
    coalesce(jc.queued_jobs, 0),
    coalesce(jc.processing_jobs, 0),
    coalesce(jc.retry_jobs, 0),
    coalesce(jc.dead_jobs, 0)
  from queue_metrics qm
  left join job_counts jc on jc.queue_name = qm.queue_name
  order by qm.queue_name;
end;
$$;

revoke all on function public.get_async_queue_metrics()
from public, anon, authenticated;
grant execute on function public.get_async_queue_metrics() to service_role;

-- Realtime carries state only. Content still comes through authorized reads.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'submissions'
  ) then
    alter publication supabase_realtime add table public.submissions;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'student_practice_assignments'
  ) then
    alter publication supabase_realtime add table public.student_practice_assignments;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'practice_test_attempts'
  ) then
    alter publication supabase_realtime add table public.practice_test_attempts;
  end if;
end;
$$;

-- Scheduled release is pure SQL and does not need pg_net. The old five-minute
-- HTTP processor is removed when present. Recovery wake-ups for queue workers
-- are configured separately because they require deployment-specific secrets.
do $$
begin
  if exists (
    select 1 from cron.job where jobname = 'process-due-feedback-every-5-minutes'
  ) then
    perform cron.unschedule('process-due-feedback-every-5-minutes');
  end if;

  if exists (
    select 1 from cron.job where jobname = 'release-due-feedback-every-30-seconds'
  ) then
    perform cron.unschedule('release-due-feedback-every-30-seconds');
  end if;

  perform cron.schedule(
    'release-due-feedback-every-30-seconds',
    '30 seconds',
    $cron$select app_private.release_due_feedback_internal(100);$cron$
  );
end;
$$;

notify pgrst, 'reload schema';
