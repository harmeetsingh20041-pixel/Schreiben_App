begin;

-- Shared-staging-safe: historical OpenAI compatibility is read-only, while
-- the live completion fixture owns one exact job/message and rolls it back.
select plan(32);

select has_table(
  'app_private',
  'worksheet_answer_completion_provenance',
  'canonical worksheet-answer completion hashes are stored privately'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conname =
      'practice_attempt_question_reviews_evaluator_source_check'
      and constraint_row.conrelid =
        'public.practice_attempt_question_reviews'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%openai%'
  ),
  'review source constraint permits truthful OpenAI provenance'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace_row
      on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'app_private'
      and relation.relname = 'worksheet_answer_completion_provenance'
  ),
  'private completion provenance has row-level security enabled'
);

select ok(
  (
    select count(*) = 2 and bool_and(constraint_row.confdeltype = 'r')
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_completion_provenance'::regclass
      and constraint_row.contype = 'f'
  ),
  'immutable completion provenance foreign keys use ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_answer_completion_provenance'::regclass
      and trigger_row.tgname =
        'worksheet_answer_completion_provenance_immutable'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgfoid =
        'app_private.reject_worksheet_answer_completion_mutation()'::regprocedure
      and trigger_row.tgtype = 27
  ),
  'completion provenance has the BEFORE UPDATE OR DELETE immutable trigger'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.worksheet_answer_completion_provenance',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_answer_completion_provenance',
      'SELECT'
    )
    and not has_table_privilege(
      'anon',
      'app_private.worksheet_answer_completion_provenance',
      'SELECT'
    ),
  'provider completion hashes are not exposed through Data API roles'
);

select ok(
  to_regprocedure(
    'app_private.normalize_worksheet_answer_provenance(jsonb)'
  ) is not null
    and to_regprocedure(
      'app_private.complete_worksheet_answer_with_provenance(uuid,bigint,uuid,jsonb)'
    ) is not null,
  'private normalization and atomic completion helpers exist'
);

select ok(
  (
    select count(*) = 3
      and bool_and(not routine.prosecdef)
      and bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
    from pg_proc routine
    where routine.oid in (
      'app_private.reject_worksheet_answer_completion_mutation()'::regprocedure,
      'app_private.normalize_worksheet_answer_provenance(jsonb)'::regprocedure,
      'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ),
  'immutable trigger, normalizer, and API adapter are invoker-safe and path-pinned'
);

select ok(
  not has_function_privilege(
    'service_role',
    'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_with_provenance(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and exists (
      select 1
      from pg_proc routine
      where routine.oid =
        'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure
        and not routine.prosecdef
        and position(
          'app_private.complete_worksheet_answer_phase_12r' in routine.prosrc
        ) > 0
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
    )
    and exists (
      select 1
      from pg_proc routine
      where routine.oid =
        'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure
        and routine.prosecdef
        and position('app_private.assert_service_role' in routine.prosrc) > 0
        and position(
          'app_private.complete_worksheet_answer_with_adjudication_v2'
            in routine.prosrc
        ) > 0
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
    ),
  'stale Phase 12I completion is sealed behind the current service-only adjudication boundary'
);

create temporary table phase_12i_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_12i_payloads (name, payload)
values (
  'openai',
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'evaluated',
    'evaluator_model', 'gpt-5.4-mini-2026-03-17',
    'reviews', jsonb_build_array(
      jsonb_build_object(
        'question_id', 'd1211111-1111-4111-8111-111111111111',
        'review_status', 'correct',
        'points_awarded', 1,
        'max_points', 1,
        'evaluator_source', 'openai',
        'feedback_text', 'Der Dativsatz ist korrekt.',
        'corrected_answer', null,
        'model_answer', 'Ich helfe dem Mann.',
        'short_reason', 'Das Dativobjekt ist richtig.'
      )
    )
  )
);

insert into phase_12i_payloads (name, payload)
select
  'deepseek',
  jsonb_set(
    jsonb_set(
      payload,
      '{evaluator_model}',
      to_jsonb('deepseek-v4-flash'::text)
    ),
    '{reviews,0,evaluator_source}',
    to_jsonb('deepseek'::text)
  )
from phase_12i_payloads
where name = 'openai';

insert into phase_12i_payloads (name, payload)
select
  'gemini',
  jsonb_set(
    jsonb_set(
      payload,
      '{evaluator_model}',
      to_jsonb('gemini-3.1-flash-lite'::text)
    ),
    '{reviews,0,evaluator_source}',
    to_jsonb('gemini'::text)
  )
from phase_12i_payloads
where name = 'openai';

insert into phase_12i_payloads (name, payload)
values (
  'manual',
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'evaluated',
    'evaluator_model', null,
    'reviews', jsonb_build_array(
      jsonb_build_object(
        'question_id', 'd1211111-1111-4111-8111-111111111111',
        'review_status', 'incorrect',
        'points_awarded', 0,
        'max_points', 1,
        'evaluator_source', 'manual',
        'feedback_text', 'Keine Antwort wurde abgegeben.',
        'corrected_answer', null,
        'model_answer', 'Ich helfe dem Mann.',
        'short_reason', 'Leere Antwort.'
      )
    )
  )
);

create temporary table phase_12i_adjudications (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_12i_adjudications (name, payload)
values
  (
    'gemini',
    jsonb_build_object(
      'schema_version', 2,
      'deepseek_model', 'deepseek-v4-flash',
      'gemini_model', 'gemini-3.1-flash-lite',
      'adjudication_mode', 'pro_resolved',
      'selected_provider_source', 'gemini',
      'selected_question_sources', jsonb_build_array(jsonb_build_object(
        'question_id', 'd1211111-1111-4111-8111-111111111111',
        'provider_source', 'gemini'
      )),
      'deepseek_result_sha256', repeat('a', 64),
      'gemini_result_sha256', repeat('b', 64),
      'pro_model', 'deepseek-v4-pro',
      'pro_result_sha256', repeat('c', 64)
    )
  ),
  (
    'deepseek',
    jsonb_build_object(
      'schema_version', 2,
      'deepseek_model', 'deepseek-v4-flash',
      'gemini_model', 'gemini-3.1-flash-lite',
      'adjudication_mode', 'agreement',
      'selected_provider_source', 'deepseek',
      'selected_question_sources', jsonb_build_array(jsonb_build_object(
        'question_id', 'd1211111-1111-4111-8111-111111111111',
        'provider_source', 'deepseek'
      )),
      'deepseek_result_sha256', repeat('a', 64),
      'gemini_result_sha256', repeat('b', 64),
      'pro_model', null,
      'pro_result_sha256', null
    )
  );

select ok(
  exists (
    select 1
    from app_private.normalize_worksheet_answer_provenance(
      (select payload from phase_12i_payloads where name = 'openai')
    ) normalized
    where normalized.provider_source = 'openai'
      and normalized.evaluator_model = 'gpt-5.4-mini-2026-03-17'
      and normalized.provider_question_ids =
        array['d1211111-1111-4111-8111-111111111111'::uuid]
      and normalized.legacy_result ->> 'evaluator_model' =
        'deepseek-v4-flash'
      and normalized.legacy_result #>> '{reviews,0,evaluator_source}' =
        'deepseek'
  ),
  'OpenAI payload is pinned and translated only in the legacy copy'
);

select ok(
  exists (
    select 1
    from app_private.normalize_worksheet_answer_provenance(
      (select payload from phase_12i_payloads where name = 'deepseek')
    ) normalized
    where normalized.provider_source = 'deepseek'
      and normalized.evaluator_model = 'deepseek-v4-flash'
      and normalized.legacy_result =
        (select payload from phase_12i_payloads where name = 'deepseek')
  ),
  'DeepSeek payload remains unchanged and pinned'
);

select ok(
  exists (
    select 1
    from app_private.normalize_worksheet_answer_provenance(
      (select payload from phase_12i_payloads where name = 'manual')
    ) normalized
    where normalized.provider_source is null
      and normalized.evaluator_model is null
      and normalized.legacy_result =
        (select payload from phase_12i_payloads where name = 'manual')
  ),
  'manual-only blank-answer completion keeps a null provider model'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_payloads where name = 'openai'),
        '{evaluator_model}',
        to_jsonb('gpt-5.4-mini'::text)
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'an unreviewed OpenAI alias fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      (select payload - 'evaluator_model'
       from phase_12i_payloads where name = 'openai')
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'a missing OpenAI evaluator model fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_payloads where name = 'openai'),
        '{evaluator_model}',
        'null'::jsonb
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'a null OpenAI evaluator model fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_payloads where name = 'openai'),
        '{reviews}',
        (select payload -> 'reviews' from phase_12i_payloads where name = 'openai')
          || (select payload -> 'reviews' from phase_12i_payloads where name = 'deepseek')
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'mixed provider reviews fail closed'
);

select ok(
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        (select payload::text from phase_12i_payloads where name = 'openai'),
        'UTF8'
      )
    ),
    'hex'
  ) = pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        (
          select jsonb_build_object(
            'reviews', payload -> 'reviews',
            'evaluator_model', payload -> 'evaluator_model',
            'mode', payload -> 'mode',
            'schema_version', payload -> 'schema_version'
          )::text
          from phase_12i_payloads
          where name = 'openai'
        ),
        'UTF8'
      )
    ),
    'hex'
  ),
  'canonical result hash is stable across reordered object keys'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated')::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      null::uuid,
      null::bigint,
      null::uuid,
      '{}'::jsonb,
      '{}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function complete_worksheet_answer_adjudication',
  'an authenticated browser cannot execute current answer adjudication'
);
reset role;

-- Shared-staging-safe fixture for a current Gemini/DeepSeek v2 completion,
-- persisted provenance, queue archive, and replay-integrity checks. Every job
-- and queue assertion below is scoped to the IDs created by this transaction.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd1011111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase12i-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12I Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1022222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase12i-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12I Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd1033333-3333-4333-8333-333333333333',
  'Phase 12I Workspace',
  'phase-12i-workspace',
  'd1011111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1011111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd1011111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1033333-3333-4333-8333-333333333333',
  'd1011111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1033333-3333-4333-8333-333333333333',
  'd1022222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  feedback_mode
)
values (
  'd1055555-5555-4555-8555-555555555555',
  'd1033333-3333-4333-8333-333333333333',
  'Phase 12I A2',
  'A2',
  'd1011111-1111-4111-8111-111111111111',
  true,
  'immediate'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'd1033333-3333-4333-8333-333333333333',
  'd1055555-5555-4555-8555-555555555555',
  'd1022222-2222-4222-8222-222222222222'
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'd1044444-4444-4444-8444-444444444444',
  'phase-12i-dativ',
  'Phase 12I Dativ',
  'A2',
  'Reset-safe semantic answer provenance fixture.'
);

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values (
  'd1200000-0000-4000-8000-000000000000',
  'd1033333-3333-4333-8333-333333333333',
  'd1044444-4444-4444-8444-444444444444',
  'A2',
  'medium',
  'Phase 12I semantic answer worksheet',
  'One flexible answer.',
  false,
  true,
  'workspace',
  'd1011111-1111-4111-8111-111111111111',
  'manual_import',
  'approved'
);

insert into public.practice_test_questions (
  id,
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
values (
  'd1211111-1111-4111-8111-111111111111',
  'd1200000-0000-4000-8000-000000000000',
  1,
  'transformation',
  'open_evaluation',
  'Formuliere einen Satz mit helfen.',
  null,
  'Ich helfe dem Mann.',
  '[]'::jsonb,
  '{"criteria":["Use helfen with a correct dative object."],"sample_answer":"Ich helfe dem Mann."}'::jsonb,
  1,
  'Helfen verlangt den Dativ.'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  source,
  status,
  assigned_by,
  generation_status
)
values (
  'd1300000-0000-4000-8000-000000000000',
  'd1033333-3333-4333-8333-333333333333',
  'd1022222-2222-4222-8222-222222222222',
  'd1044444-4444-4444-8444-444444444444',
  'd1200000-0000-4000-8000-000000000000',
  'd1055555-5555-4555-8555-555555555555',
  'A2',
  1,
  'teacher_verified',
  'manual',
  'completed',
  'd1011111-1111-4111-8111-111111111111',
  'ready'
);

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  score_points,
  max_score_points,
  scoring_version,
  evaluation_status,
  evaluation_version,
  status,
  started_at,
  submitted_at,
  completed_at
)
values (
  'd1311111-1111-4111-8111-111111111111',
  'd1200000-0000-4000-8000-000000000000',
  'd1022222-2222-4222-8222-222222222222',
  'd1033333-3333-4333-8333-333333333333',
  'd1300000-0000-4000-8000-000000000000',
  jsonb_build_array(
    jsonb_build_object(
      'question_id', 'd1211111-1111-4111-8111-111111111111',
      'answer', 'Ich helfe dem Mann.'
    )
  ),
  0,
  0,
  null,
  null,
  'phase_12i_pending_fixture',
  'queued',
  1,
  'submitted',
  now(),
  now(),
  now()
);

update public.student_practice_assignments
set latest_attempt_id = 'd1311111-1111-4111-8111-111111111111'
where id = 'd1300000-0000-4000-8000-000000000000';

insert into public.student_grammar_stats (
  workspace_id,
  student_id,
  grammar_topic_id,
  weakness_level,
  practice_unlocked
)
values (
  'd1033333-3333-4333-8333-333333333333',
  'd1022222-2222-4222-8222-222222222222',
  'd1044444-4444-4444-8444-444444444444',
  'unlocked',
  true
);

create temporary table phase_12i_state (
  singleton boolean primary key default true check (singleton),
  job_id uuid,
  message_id bigint,
  review_snapshot jsonb
) on commit drop;

insert into phase_12i_state default values;
grant select, update on table phase_12i_state to service_role;
grant select on table phase_12i_payloads to service_role;
grant select on table phase_12i_adjudications to service_role;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'd1311111-1111-4111-8111-111111111111',
    1,
    'phase12i:gemini-v2:1',
    'd1022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_12i_state state
set job_id = enqueued.job_id,
    message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

-- Lease only the job created above. A queue-wide claim could consume an
-- unrelated staging job before reaching this fixture.
update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = job.attempt_count + 1,
  worker_id = 'd1400000-0000-4000-8000-000000000000',
  lease_expires_at = now() + interval '3 minutes',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now(),
  last_error_code = null
where job.id = (select job_id from phase_12i_state where singleton)
  and job.entity_id = 'd1311111-1111-4111-8111-111111111111'
  and job.queue_message_id = (
    select message_id from phase_12i_state where singleton
  )
  and job.status in ('queued', 'retry');

update public.practice_test_attempts attempt
set
  evaluation_status = 'evaluating',
  evaluation_started_at = coalesce(attempt.evaluation_started_at, now())
where attempt.id = 'd1311111-1111-4111-8111-111111111111'
  and attempt.evaluation_version = 1
  and attempt.status = 'submitted';

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

create function public.phase_12i_force_provenance_restore_failure()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.attempt_id = 'd1311111-1111-4111-8111-111111111111'
    and old.evaluator_source = 'deepseek'
    and new.evaluator_source = 'gemini'
  then
    raise exception using
      errcode = 'P0001',
      message = 'phase 12i forced provenance restore failure';
  end if;
  return new;
end;
$$;

create trigger phase_12i_force_provenance_restore_failure
before update on public.practice_attempt_question_reviews
for each row execute function public.phase_12i_force_provenance_restore_failure();

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      (select job_id from pg_temp.phase_12i_state),
      (select message_id from pg_temp.phase_12i_state),
      'd1400000-0000-4000-8000-000000000000',
      (select payload from pg_temp.phase_12i_payloads where name = 'gemini'),
      (select payload from pg_temp.phase_12i_adjudications where name = 'gemini')
    )
  $$,
  'P0001',
  'phase 12i forced provenance restore failure',
  'a provenance restore failure aborts the complete adapter statement'
);
reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = 'd1311111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'evaluating'
      and attempt.status = 'submitted'
      and attempt.evaluation_model is null
      and assignment.status = 'completed'
  )
    and not exists (
      select 1
      from public.practice_attempt_question_reviews review
      where review.attempt_id = 'd1311111-1111-4111-8111-111111111111'
    )
    and not exists (
      select 1
      from app_private.worksheet_answer_completion_provenance_v2 provenance
      where provenance.job_id = (select job_id from phase_12i_state)
    )
    and not exists (
      select 1
      from app_private.worksheet_answer_adjudication_evidence_v2 evidence
      where evidence.job_id = (select job_id from phase_12i_state)
    ),
  'failed provenance restore rolls back reviews, score finalization, and ledger insertion'
);

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = (select job_id from phase_12i_state)
      and job.status = 'processing'
      and job.worker_id = 'd1400000-0000-4000-8000-000000000000'
      and job.queue_message_id = (select message_id from phase_12i_state)
  )
    and exists (
      select 1
      from pgmq.q_worksheet_answer_evaluation queue
      where queue.msg_id = (select message_id from phase_12i_state)
    )
    and not exists (
      select 1
      from pgmq.a_worksheet_answer_evaluation archive
      where archive.msg_id = (select message_id from phase_12i_state)
    ),
  'failed provenance restore keeps the active lease and live queue message'
);

drop trigger phase_12i_force_provenance_restore_failure
on public.practice_attempt_question_reviews;
drop function public.phase_12i_force_provenance_restore_failure();

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      (select job_id from pg_temp.phase_12i_state),
      (select message_id from pg_temp.phase_12i_state),
      'd1400000-0000-4000-8000-000000000000',
      (select payload from pg_temp.phase_12i_payloads where name = 'gemini'),
      (select payload from pg_temp.phase_12i_adjudications where name = 'gemini')
    )
  $$,
  'Gemini answer completion finalizes atomically through the v2 adjudication adapter'
);
reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = 'd1311111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'completed'
      and attempt.status = 'checked'
      and attempt.score_points = 1
      and attempt.max_score_points = 1
      and attempt.score_percent = 100
      and attempt.passed
      and assignment.status = 'passed'
  ),
  'Gemini v2 completion reaches a coherent terminal scoring state'
);

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.practice_attempt_question_reviews review
      on review.attempt_id = attempt.id
    where attempt.id = 'd1311111-1111-4111-8111-111111111111'
      and attempt.evaluation_model = 'gemini-3.1-flash-lite'
      and review.question_id = 'd1211111-1111-4111-8111-111111111111'
      and review.evaluator_source = 'gemini'
      and review.review_status = 'correct'
      and review.points_awarded = 1
  ),
  'persisted answer review and attempt retain truthful Gemini provenance'
);

select ok(
  exists (
    select 1
    from app_private.worksheet_answer_completion_provenance_v2 provenance
    where provenance.job_id = (select job_id from phase_12i_state)
      and provenance.attempt_id = 'd1311111-1111-4111-8111-111111111111'
      and provenance.evidence_version = 2
      and provenance.provider_source = 'gemini'
      and provenance.evaluator_model = 'gemini-3.1-flash-lite'
      and provenance.result_sha256 ~ '^[0-9a-f]{64}$'
  )
    and exists (
      select 1
      from app_private.worksheet_answer_adjudication_evidence_v2 evidence
      where evidence.job_id = (select job_id from phase_12i_state)
        and evidence.attempt_id = 'd1311111-1111-4111-8111-111111111111'
        and evidence.evidence_version = 2
        and evidence.deepseek_model = 'deepseek-v4-flash'
        and evidence.gemini_model = 'gemini-3.1-flash-lite'
        and evidence.adjudication_mode = 'pro_resolved'
        and evidence.selected_provider_source = 'gemini'
        and evidence.pro_model = 'deepseek-v4-pro'
  ),
  'canonical result hash and dual-provider adjudication are stored privately'
);

select throws_ok(
  $$
    update app_private.worksheet_answer_completion_provenance_v2 provenance
    set completed_at = provenance.completed_at
    where provenance.job_id = (select job_id from phase_12i_state)
  $$,
  '55000',
  'Worksheet answer completion evidence is immutable.',
  'committed completion provenance cannot be updated'
);

select throws_ok(
  $$
    delete from app_private.worksheet_answer_completion_provenance_v2 provenance
    where provenance.job_id = (select job_id from phase_12i_state)
  $$,
  '55000',
  'Worksheet answer completion evidence is immutable.',
  'committed completion provenance cannot be deleted'
);

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = (select job_id from phase_12i_state)
      and job.status = 'succeeded'
      and job.completed_at is not null
  )
    and not exists (
      select 1
      from pgmq.q_worksheet_answer_evaluation queue
      where queue.msg_id = (select message_id from phase_12i_state)
    )
    and exists (
      select 1
      from pgmq.a_worksheet_answer_evaluation archive
      where archive.msg_id = (select message_id from phase_12i_state)
    ),
  'successful v2 completion terminalizes the fixture job and archives its message'
);

update phase_12i_state state
set review_snapshot = (
  select jsonb_build_object(
    'source', review.evaluator_source,
    'feedback', review.feedback_text,
    'model', attempt.evaluation_model
  )
  from public.practice_attempt_question_reviews review
  join public.practice_test_attempts attempt on attempt.id = review.attempt_id
  where review.attempt_id = 'd1311111-1111-4111-8111-111111111111'
)
where state.singleton;

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      (select job_id from pg_temp.phase_12i_state),
      -1,
      'd1499999-9999-4999-8999-999999999999',
      (select payload from pg_temp.phase_12i_payloads where name = 'gemini'),
      (select payload from pg_temp.phase_12i_adjudications where name = 'gemini')
    )
  $$,
  'an identical succeeded-job replay returns the terminal result'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      (select job_id from pg_temp.phase_12i_state),
      -1,
      'd1499999-9999-4999-8999-999999999999',
      jsonb_set(
        (select payload from pg_temp.phase_12i_payloads where name = 'gemini'),
        '{reviews,0,feedback_text}',
        to_jsonb('Changed late feedback.'::text)
      ),
      (select payload from pg_temp.phase_12i_adjudications where name = 'gemini')
    )
  $$,
  '55000',
  'semantic_completion_replay_mismatch',
  'a changed result from the same provider cannot rewrite succeeded feedback'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_answer_adjudication(
      (select job_id from pg_temp.phase_12i_state),
      -1,
      'd1499999-9999-4999-8999-999999999999',
      (select payload from pg_temp.phase_12i_payloads where name = 'deepseek'),
      (select payload from pg_temp.phase_12i_adjudications where name = 'deepseek')
    )
  $$,
  '55000',
  'semantic_completion_replay_mismatch',
  'a mismatched provider replay cannot relabel a succeeded evaluation'
);
reset role;

select ok(
  (select review_snapshot from phase_12i_state) = (
    select jsonb_build_object(
      'source', review.evaluator_source,
      'feedback', review.feedback_text,
      'model', attempt.evaluation_model
    )
    from public.practice_attempt_question_reviews review
    join public.practice_test_attempts attempt on attempt.id = review.attempt_id
    where review.attempt_id = 'd1311111-1111-4111-8111-111111111111'
  )
    and (
      select count(*) = 1
      from app_private.worksheet_answer_completion_provenance_v2 provenance
      where provenance.job_id = (select job_id from phase_12i_state)
    )
      and (
        select count(*) = 1
        from app_private.worksheet_answer_adjudication_evidence_v2 evidence
        where evidence.job_id = (select job_id from phase_12i_state)
      ),
  'rejected replays leave reviews, model provenance, and canonical hash unchanged'
);

select * from finish();
rollback;
