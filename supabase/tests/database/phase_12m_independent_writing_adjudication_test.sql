begin;

-- Isolated/reset database only. The fixture submits and claims two writing jobs
-- and rolls every row and queue mutation back at the end.
select plan(40);

select has_table(
  'app_private',
  'writing_feedback_adjudications',
  'private independent-writing provenance ledger exists'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'app_private'
      and relation.relname = 'writing_feedback_adjudications'
  ),
  'independent-writing provenance has row-level security enabled'
);

select ok(
  (
    select count(*) = 2 and bool_and(constraint_row.confdeltype = 'r')
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.writing_feedback_adjudications'::regclass
      and constraint_row.contype = 'f'
  ),
  'both immutable provenance foreign keys use ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.writing_feedback_adjudications'::regclass
      and trigger_row.tgname = 'writing_feedback_adjudications_immutable'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgfoid =
        'app_private.reject_writing_adjudication_mutation()'::regprocedure
      and trigger_row.tgtype = 27
  ),
  'provenance has the exact BEFORE UPDATE OR DELETE immutable trigger'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'app_private.feedback_drafts'::regclass
      and trigger_row.tgname = 'feedback_drafts_zz_independent_release_gate'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgfoid =
        'app_private.require_independent_writing_release()'::regprocedure
      and trigger_row.tgtype = 23
  ),
  'drafts have the exact BEFORE INSERT OR UPDATE automatic-release gate'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.writing_feedback_adjudications',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_feedback_adjudications',
      'SELECT'
    )
    and not has_table_privilege(
      'anon',
      'app_private.writing_feedback_adjudications',
      'SELECT'
    ),
  'the immutable evidence ledger is not readable through Data API roles'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'writing_feedback_adjudications'
      and (
        column_row.data_type in ('json', 'jsonb')
        or column_row.column_name ~ '(original_text|student_text|prompt|response|feedback_content)$'
      )
  ),
  'provenance stores no raw writing, prompt, response, or feedback body'
);

select ok(
  to_regprocedure('app_private.canonical_jsonb_sha256(jsonb)') is not null
    and to_regprocedure(
      'app_private.record_or_assert_writing_adjudication(uuid,bigint,uuid,jsonb)'
    ) is not null
    and to_regprocedure('api.get_writing_adjudication_context(uuid)') is not null,
  'hashing, record/replay, and service-only hash loader routines exist'
);

select ok(
  (
    select count(*) = 5
      and bool_and(not routine.prosecdef)
      and bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
    from pg_proc routine
    where routine.oid in (
      'app_private.canonical_jsonb_text(jsonb)'::regprocedure,
      'app_private.canonical_jsonb_sha256(jsonb)'::regprocedure,
      'app_private.reject_writing_adjudication_mutation()'::regprocedure,
      'api.get_writing_adjudication_context(uuid)'::regprocedure,
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  )
    and (
      select count(*) = 4
        and bool_and(routine.prosecdef)
        and bool_and(exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        ))
      from pg_proc routine
      where routine.oid in (
        'app_private.record_or_assert_writing_adjudication(uuid,bigint,uuid,jsonb)'::regprocedure,
        'app_private.require_independent_writing_release()'::regprocedure,
        'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure,
        'public.complete_writing_evaluation_legacy_internal(uuid,bigint,uuid,jsonb)'::regprocedure
      )
    ),
  'invoker and definer routines have only their intended boundary and empty path'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.get_writing_adjudication_context(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_writing_adjudication_context(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation_legacy_internal(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'API and stale public signatures are gated while the legacy body is closed'
);

select is(
  app_private.canonical_jsonb_sha256('{"b":2,"a":1}'::jsonb),
  '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  'database canonical JSON hashing matches the Edge canonical hash contract'
);

select is(
  app_private.canonical_jsonb_sha256(jsonb_build_object(
    'overall_summary', E'Grüße – korrekt.\nZweite Zeile',
    'level_detected', 'A2',
    'corrected_text', E'Das ist richtig.\n\nHeute übe ich.',
    'ai_model', 'deepseek-v4-flash',
    'score_summary', jsonb_build_object(
      'correct_lines', 1,
      'acceptable_lines', 0,
      'minor_issues', 0,
      'major_issues', 0,
      'needs_review', 0
    ),
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Das ist richtig.',
      'corrected_line', 'Das ist richtig.',
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb
  )),
  '4d9dcbfb88066fc9ec28eb737298700a7cac6258e1870c841977996700895db4',
  'representative Unicode, newline, array, and empty-field feedback hashes match Edge'
);

select ok(
  position(
    'record_or_assert_writing_adjudication' in pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ) < position(
    'complete_writing_evaluation_legacy_internal' in pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  )
    and pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    ) like '%feedback - ''evaluation_evidence''%',
  'the stale-compatible public boundary records evidence before legacy materialization'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd3111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12m-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12M Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd3222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12m-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12M Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd3333333-3333-4333-8333-333333333333',
  'Phase 12M Workspace', 'phase-12m-workspace',
  'd3111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd3333333-3333-4333-8333-333333333333',
    'd3111111-1111-4111-8111-111111111111', 'teacher'
  ),
  (
    'd3333333-3333-4333-8333-333333333333',
    'd3222222-2222-4222-8222-222222222222', 'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'd3444444-4444-4444-8444-444444444444',
  'd3333333-3333-4333-8333-333333333333',
  'Phase 12M Immediate A2', 'A2', true, 'immediate'
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'd3555555-5555-4555-8555-555555555555',
  'd3444444-4444-4444-8444-444444444444',
  'd3222222-2222-4222-8222-222222222222',
  'd3333333-3333-4333-8333-333333333333'
);

create temporary table phase_12m_state (
  singleton boolean primary key default true check (singleton),
  accepted_submission_id uuid,
  accepted_job_id uuid,
  accepted_message_id bigint,
  accepted_payload jsonb,
  held_submission_id uuid,
  held_job_id uuid,
  held_message_id bigint,
  held_payload jsonb,
  pro_submission_id uuid,
  pro_job_id uuid,
  pro_message_id bigint,
  pro_payload jsonb
) on commit drop;
insert into phase_12m_state default values;
grant select, update on phase_12m_state to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd3222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd3222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'd3444444-4444-4444-8444-444444444444',
    'free_text', null, 'Das ist richtig.'
  )
)
update pg_temp.phase_12m_state state
set accepted_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from api.claim_async_jobs(
    'writing_evaluation',
    'd3666666-6666-4666-8666-666666666666',
    1,
    300
  )
)
update pg_temp.phase_12m_state state
set
  accepted_job_id = claimed.job_id,
  accepted_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;

with base_feedback as (
  select jsonb_build_object(
    'overall_summary', 'Der Text ist korrekt.',
    'level_detected', 'A2',
    'corrected_text', 'Das ist richtig.',
    'ai_model', 'deepseek-v4-flash',
    'score_summary', jsonb_build_object(
      'correct_lines', 1,
      'acceptable_lines', 0,
      'minor_issues', 0,
      'major_issues', 0,
      'needs_review', 0
    ),
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Das ist richtig.',
      'corrected_line', 'Das ist richtig.',
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb
  ) as value
), context_row as (
  select context.*
  from app_private.writing_evaluation_contexts context
  where context.submission_id = (
    select accepted_submission_id from phase_12m_state where singleton
  )
)
update phase_12m_state state
set accepted_payload = base_feedback.value || jsonb_build_object(
  'evaluation_evidence', jsonb_build_object(
    'schema_version', 2,
    'decision', 'accepted_model_feedback',
    'reason_code', 'critic_approved',
    'context_sha256', context_row.context_sha256,
    'original_text_sha256', context_row.original_text_sha256,
    'final_feedback_sha256',
      app_private.canonical_jsonb_sha256(base_feedback.value),
    'generator_provider', 'deepseek',
    'generator_model', 'deepseek-v4-flash',
    'candidate_feedback_sha256', repeat('d', 64),
    'candidate_release_sha256',
      app_private.canonical_jsonb_sha256(base_feedback.value),
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'approved',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', null,
    'adjudicator_model', null,
    'adjudicator_verdict', null,
    'adjudicator_decision_sha256', null,
    'resolved_feedback_sha256', null,
    'final_critic_provider', null,
    'final_critic_model', null,
    'final_critic_verdict', null,
    'final_critic_decision_sha256', null,
    'accepted_provider', 'deepseek',
    'accepted_model', 'deepseek-v4-flash'
  )
)
from base_feedback, context_row
where state.singleton;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12m_state where singleton),
      (select accepted_message_id from phase_12m_state where singleton),
      'd3666666-6666-4666-8666-666666666666',
      (select accepted_payload from phase_12m_state where singleton)
    )
  $$,
  'critic-approved evidence completes through the canonical API'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select accepted_submission_id from phase_12m_state where singleton
    )
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.ai_model = 'deepseek-v4-flash'
      and submission.corrected_text = 'Das ist richtig.'
  ),
  'accepted evidence permits immediate atomic student release'
);

select ok(
  exists (
    select 1
    from app_private.writing_feedback_adjudications_v2 evidence
    where evidence.job_id = (
      select accepted_job_id from phase_12m_state where singleton
    )
      and evidence.decision = 'accepted_model_feedback'
      and evidence.reason_code = 'critic_approved'
      and evidence.schema_version = 2
      and evidence.critic_provider = 'gemini'
      and evidence.critic_model = 'gemini-3.1-flash-lite'
      and evidence.accepted_model = 'deepseek-v4-flash'
  ),
  'accepted release records pinned critic and accepted-model provenance'
);

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    where draft.submission_id = (
      select accepted_submission_id from phase_12m_state where singleton
    )
      and draft.state = 'released'
      and draft.provider_model = 'deepseek-v4-flash'
      and not (draft.content ? 'evaluation_evidence')
      and app_private.canonical_jsonb_sha256(draft.content) = (
        select evidence.final_feedback_sha256
        from app_private.writing_feedback_adjudications_v2 evidence
        where evidence.job_id = (
          select accepted_job_id from phase_12m_state where singleton
        )
      )
  ),
  'the stored normalized release exactly matches its hash and strips metadata'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12m_state where singleton),
      (select accepted_message_id from phase_12m_state where singleton),
      'd3666666-6666-4666-8666-666666666666',
      (select accepted_payload from phase_12m_state where singleton)
    )
  $$,
  'an exact completion replay succeeds without a second ledger row'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12m_state where singleton),
      (select accepted_message_id from phase_12m_state where singleton),
      'd3666666-6666-4666-8666-666666666666',
      jsonb_set(
        (select accepted_payload from phase_12m_state where singleton),
        '{overall_summary}',
        to_jsonb('Altered after independent approval.'::text)
      )
    )
  $$,
  '55000',
  'writing_adjudication_feedback_hash_mismatch',
  'altered visible completion content cannot reuse independent approval'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select accepted_job_id from phase_12m_state where singleton),
      (select accepted_message_id from phase_12m_state where singleton),
      'd3666666-6666-4666-8666-666666666666',
      jsonb_set(
        (select accepted_payload from phase_12m_state where singleton),
        '{evaluation_evidence,candidate_feedback_sha256}',
        to_jsonb(repeat('f', 64))
      )
    )
  $$,
  '55000',
  'writing_adjudication_replay_mismatch',
  'a changed hash cannot replay a succeeded job'
);

reset role;

select throws_ok(
  $$
    update app_private.writing_feedback_adjudications_v2
    set reason_code = 'critic_invalid'
    where job_id = (
      select accepted_job_id from phase_12m_state where singleton
    )
  $$,
  '55000',
  'writing_adjudication_immutable',
  'immutable provenance rejects updates'
);

select throws_ok(
  $$
    delete from app_private.writing_feedback_adjudications_v2
    where job_id = (
      select accepted_job_id from phase_12m_state where singleton
    )
  $$,
  '55000',
  'writing_adjudication_immutable',
  'immutable provenance rejects deletes'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd3222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd3222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'd3444444-4444-4444-8444-444444444444',
    'free_text', null, 'Heute lerne ich.'
  )
)
update pg_temp.phase_12m_state state
set held_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from api.claim_async_jobs(
    'writing_evaluation',
    'd3777777-7777-4777-8777-777777777777',
    1,
    300
  )
)
update pg_temp.phase_12m_state state
set
  held_job_id = claimed.job_id,
  held_message_id = claimed.queue_message_id
from claimed
where state.singleton;

select throws_ok(
  $$
    select *
    from public.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      jsonb_build_object(
        'overall_summary', 'Single-model result.',
        'level_detected', 'A2',
        'corrected_text', 'Heute lerne ich.',
        'ai_model', 'deepseek-v4-flash',
        'lines', jsonb_build_array(jsonb_build_object(
          'line_number', 1,
          'source_start', 0,
          'source_end', 16,
          'original_line', 'Heute lerne ich.',
          'corrected_line', 'Heute lerne ich.',
          'status', 'correct',
          'changed_parts', '[]'::jsonb,
          'short_explanation', '',
          'detailed_explanation', '',
          'grammar_topic', ''
        )),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'the stale public completion signature now requires independent evidence'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.feedback_drafts draft
    where draft.submission_id = (
      select held_submission_id from phase_12m_state where singleton
    )
  )
    and exists (
      select 1
      from app_private.async_jobs job
      where job.id = (select held_job_id from phase_12m_state where singleton)
        and job.status = 'processing'
    ),
  'blocked legacy access leaves the draft absent and the claimed job untouched'
);

with base_feedback as (
  select jsonb_build_object(
    'overall_summary', 'Independent verification was not completed.',
    'level_detected', 'A2',
    'corrected_text', 'Heute lerne ich.',
    'ai_model', 'system_hold',
    'score_summary', jsonb_build_object(
      'correct_lines', 0,
      'acceptable_lines', 0,
      'minor_issues', 0,
      'major_issues', 0,
      'needs_review', 1
    ),
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Heute lerne ich.',
      'corrected_line', 'Heute lerne ich.',
      'status', 'unclear',
      'changed_parts', '[]'::jsonb,
      'short_explanation', 'Independent verification was not completed.',
      'detailed_explanation', 'A teacher may review this private result.',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb
  ) as value
), context_row as (
  select context.*
  from app_private.writing_evaluation_contexts context
  where context.submission_id = (
    select held_submission_id from phase_12m_state where singleton
  )
)
update phase_12m_state state
set held_payload = base_feedback.value || jsonb_build_object(
  'evaluation_evidence', jsonb_build_object(
    'schema_version', 2,
    'decision', 'system_hold',
    'reason_code', 'generator_invalid',
    'context_sha256', context_row.context_sha256,
    'original_text_sha256', context_row.original_text_sha256,
    'final_feedback_sha256',
      app_private.canonical_jsonb_sha256(base_feedback.value),
    'generator_provider', 'deepseek',
    'generator_model', 'deepseek-v4-flash',
    'candidate_feedback_sha256', null,
    'candidate_release_sha256', null,
    'critic_provider', null,
    'critic_model', null,
    'critic_verdict', null,
    'critic_decision_sha256', null,
    'adjudicator_provider', null,
    'adjudicator_model', null,
    'adjudicator_verdict', null,
    'adjudicator_decision_sha256', null,
    'resolved_feedback_sha256', null,
    'final_critic_provider', null,
    'final_critic_model', null,
    'final_critic_verdict', null,
    'final_critic_decision_sha256', null,
    'accepted_provider', null,
    'accepted_model', null
  )
)
from base_feedback, context_row
where state.singleton;

create function pg_temp.phase_12m_accepted_held_payload(
  evidence_overrides jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with base_feedback as (
    select jsonb_build_object(
      'overall_summary', 'Der Text ist korrekt.',
      'level_detected', 'A2',
      'corrected_text', 'Heute lerne ich.',
      'ai_model', 'deepseek-v4-flash',
      'score_summary', jsonb_build_object(
        'correct_lines', 1,
        'acceptable_lines', 0,
        'minor_issues', 0,
        'major_issues', 0,
        'needs_review', 0
      ),
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 16,
        'original_line', 'Heute lerne ich.',
        'corrected_line', 'Heute lerne ich.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb
    ) as value
  ), context_row as (
    select context.*
    from app_private.writing_evaluation_contexts context
    where context.submission_id = (
      select held_submission_id
      from pg_temp.phase_12m_state
      where singleton
    )
  )
  select base_feedback.value || jsonb_build_object(
    'evaluation_evidence', jsonb_build_object(
      'schema_version', 2,
      'decision', 'accepted_model_feedback',
      'reason_code', 'critic_approved',
      'context_sha256', context_row.context_sha256,
      'original_text_sha256', context_row.original_text_sha256,
      'final_feedback_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'generator_provider', 'deepseek',
      'generator_model', 'deepseek-v4-flash',
      'candidate_feedback_sha256', repeat('d', 64),
      'candidate_release_sha256',
        app_private.canonical_jsonb_sha256(base_feedback.value),
      'critic_provider', 'gemini',
      'critic_model', 'gemini-3.1-flash-lite',
      'critic_verdict', 'approved',
      'critic_decision_sha256', repeat('e', 64),
      'adjudicator_provider', null,
      'adjudicator_model', null,
      'adjudicator_verdict', null,
      'adjudicator_decision_sha256', null,
      'resolved_feedback_sha256', null,
      'final_critic_provider', null,
      'final_critic_model', null,
      'final_critic_verdict', null,
      'final_critic_decision_sha256', null,
      'accepted_provider', 'deepseek',
      'accepted_model', 'deepseek-v4-flash'
    ) || evidence_overrides
  )
  from base_feedback, context_row;
$$;

grant execute on function pg_temp.phase_12m_accepted_held_payload(jsonb)
to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      pg_temp.phase_12m_accepted_held_payload(
        jsonb_build_object('accepted_provider', null)
      )
    )
  $$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'JSON null cannot bypass the required accepted provider'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      pg_temp.phase_12m_accepted_held_payload(
        jsonb_build_object('critic_model', null)
      )
    )
  $$,
  '22023',
  'writing_adjudication_critic_model_retired',
  'JSON null cannot bypass the required first critic model'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      pg_temp.phase_12m_accepted_held_payload(jsonb_build_object(
        'reason_code', 'final_critic_approved',
        'critic_verdict', 'disagreed',
        'adjudicator_provider', 'deepseek',
        'adjudicator_model', 'deepseek-v4-pro',
        'adjudicator_verdict', 'resolved',
        'adjudicator_decision_sha256', repeat('f', 64),
        'resolved_feedback_sha256', repeat('d', 64),
        'final_critic_provider', 'gemini',
        'final_critic_model', null,
        'final_critic_verdict', 'approved',
        'final_critic_decision_sha256', repeat('c', 64)
      ))
    )
  $$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'JSON null cannot bypass the required final critic model'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      (
        select
          (payload - 'evaluation_evidence') || jsonb_build_object(
            'evaluation_evidence',
            (payload -> 'evaluation_evidence') || jsonb_build_object(
              'decision', 'accepted_model_feedback',
              'reason_code', 'final_critic_approved',
              'candidate_feedback_sha256', repeat('d', 64),
              'candidate_release_sha256', repeat('b', 64),
              'critic_provider', 'gemini',
              'critic_model', 'gemini-3.1-flash-lite',
              'critic_verdict', 'disagreed',
              'critic_decision_sha256', repeat('e', 64),
              'adjudicator_provider', 'deepseek',
              'adjudicator_model', 'deepseek-v4-pro',
              'adjudicator_verdict', 'resolved',
              'adjudicator_decision_sha256', repeat('f', 64),
              'resolved_feedback_sha256', repeat('a', 64),
              'accepted_provider', 'deepseek',
              'accepted_model', 'deepseek-v4-flash'
            )
          )
        from (
          select held_payload as payload
          from phase_12m_state
          where singleton
        ) source
      )
    )
  $$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'a disputed Pro resolution without exact final-critic approval cannot complete'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      (
        select
          (payload - 'evaluation_evidence') || jsonb_build_object(
            'evaluation_evidence',
            (payload -> 'evaluation_evidence') || jsonb_build_object(
              'decision', 'accepted_model_feedback',
              'reason_code', 'final_critic_approved',
              'candidate_feedback_sha256', repeat('d', 64),
              'candidate_release_sha256', repeat('b', 64),
              'critic_provider', 'gemini',
              'critic_model', 'gemini-3.1-flash-lite',
              'critic_verdict', 'disagreed',
              'critic_decision_sha256', repeat('e', 64),
              'adjudicator_provider', 'deepseek',
              'adjudicator_model', 'deepseek-v4-pro',
              'adjudicator_verdict', 'resolved',
              'adjudicator_decision_sha256', repeat('f', 64),
              'resolved_feedback_sha256', repeat('d', 64),
              'final_critic_provider', 'gemini',
              'final_critic_model', 'gemini-3.1-flash-lite',
              'final_critic_verdict', 'approved',
              'final_critic_decision_sha256', repeat('c', 64),
              'accepted_provider', 'deepseek',
              'accepted_model', 'deepseek-v4-pro'
            )
          )
        from (
          select held_payload as payload
          from phase_12m_state
          where singleton
        ) source
      )
    )
  $$,
  '22023',
  'writing_adjudication_evidence_invalid',
  'accepted Pro provenance cannot claim an unchanged Flash candidate hash'
);

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from phase_12m_state where singleton),
      (select held_message_id from phase_12m_state where singleton),
      'd3777777-7777-4777-8777-777777777777',
      (select held_payload from phase_12m_state where singleton)
    )
  $$,
  'an unresolved result reaches a valid private terminal hold'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select held_submission_id from phase_12m_state where singleton
    )
      and submission.evaluation_status = 'needs_review'
      and submission.release_status = 'held'
      and submission.ai_model is null
      and submission.corrected_text is null
  )
    and exists (
      select 1
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select held_submission_id from phase_12m_state where singleton
      )
        and draft.state = 'needs_review'
        and draft.provider_model = 'system_hold'
        and draft.content ->> 'ai_model' = 'system_hold'
    ),
  'system_hold remains private and its draft model is truthful'
);

select ok(
  exists (
    select 1
    from app_private.writing_feedback_adjudications_v2 evidence
    where evidence.job_id = (
      select held_job_id from phase_12m_state where singleton
    )
      and evidence.decision = 'system_hold'
      and evidence.reason_code = 'generator_invalid'
      and evidence.accepted_provider is null
      and evidence.accepted_model is null
  ),
  'system_hold provenance never invents an accepted provider or model'
);

update app_private.feedback_drafts draft
set state = 'draft'
where draft.submission_id = (
  select held_submission_id from phase_12m_state where singleton
);

select throws_ok(
  $$
    select app_private.materialize_feedback_draft(
      (select held_submission_id from phase_12m_state where singleton),
      (
        select draft.id
        from app_private.feedback_drafts draft
        where draft.submission_id = (
          select held_submission_id from phase_12m_state where singleton
        )
      ),
      null
    )
  $$,
  '55000',
  'writing_independent_evidence_required',
  'an automatic release cannot expose system_hold feedback'
);

select lives_ok(
  $$
    select app_private.materialize_feedback_draft(
      (select held_submission_id from phase_12m_state where singleton),
      (
        select draft.id
        from app_private.feedback_drafts draft
        where draft.submission_id = (
          select held_submission_id from phase_12m_state where singleton
        )
      ),
      'd3111111-1111-4111-8111-111111111111'
    )
  $$,
  'an explicit teacher decision remains the independent human release path'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select held_submission_id from phase_12m_state where singleton
    )
      and submission.release_status = 'released'
      and submission.ai_model = 'system_hold'
  )
    and exists (
      select 1
      from app_private.feedback_drafts draft
      where draft.submission_id = (
        select held_submission_id from phase_12m_state where singleton
      )
        and draft.released_by = 'd3111111-1111-4111-8111-111111111111'
    ),
  'teacher release is auditable and keeps truthful system_hold provenance'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd3222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd3222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'd3444444-4444-4444-8444-444444444444',
    'free_text', null, 'Ich übe heute.'
  )
)
update pg_temp.phase_12m_state state
set pro_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from api.claim_async_jobs(
    'writing_evaluation',
    'd3888888-8888-4888-8888-888888888888',
    1,
    300
  )
)
update pg_temp.phase_12m_state state
set
  pro_job_id = claimed.job_id,
  pro_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;

with base_feedback as (
  select jsonb_build_object(
    'overall_summary', 'Der Text ist korrekt.',
    'level_detected', 'A2',
    'corrected_text', 'Ich übe heute.',
    'ai_model', 'deepseek-v4-pro',
    'score_summary', jsonb_build_object(
      'correct_lines', 1,
      'acceptable_lines', 0,
      'minor_issues', 0,
      'major_issues', 0,
      'needs_review', 0
    ),
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 14,
      'original_line', 'Ich übe heute.',
      'corrected_line', 'Ich übe heute.',
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb
  ) as value
), context_row as (
  select context.*
  from app_private.writing_evaluation_contexts context
  where context.submission_id = (
    select pro_submission_id from phase_12m_state where singleton
  )
)
update phase_12m_state state
set pro_payload = base_feedback.value || jsonb_build_object(
  'evaluation_evidence', jsonb_build_object(
    'schema_version', 2,
    'decision', 'accepted_model_feedback',
    'reason_code', 'final_critic_approved',
    'context_sha256', context_row.context_sha256,
    'original_text_sha256', context_row.original_text_sha256,
    'final_feedback_sha256',
      app_private.canonical_jsonb_sha256(base_feedback.value),
    'generator_provider', 'deepseek',
    'generator_model', 'deepseek-v4-flash',
    'candidate_feedback_sha256', repeat('d', 64),
    'candidate_release_sha256', repeat('b', 64),
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('a', 64),
    'final_critic_provider', 'gemini',
    'final_critic_model', 'gemini-3.1-flash-lite',
    'final_critic_verdict', 'approved',
    'final_critic_decision_sha256', repeat('c', 64),
    'accepted_provider', 'deepseek',
    'accepted_model', 'deepseek-v4-pro'
  )
)
from base_feedback, context_row
where state.singleton;

update app_private.async_jobs job
set status = 'succeeded', completed_at = now()
where job.id = (select pro_job_id from phase_12m_state where singleton);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select pro_job_id from phase_12m_state where singleton),
      (select pro_message_id from phase_12m_state where singleton),
      'd3888888-8888-4888-8888-888888888888',
      (
        select
          (payload - 'evaluation_evidence') || jsonb_build_object(
            'evaluation_evidence',
            (payload -> 'evaluation_evidence') || jsonb_build_object(
              'schema_version', 1,
              'critic_provider', 'openai',
              'critic_model', 'gpt-5.4-2026-03-05',
              'final_critic_provider', 'openai',
              'final_critic_model', 'gpt-5.4-2026-03-05'
            )
          )
        from (
          select pro_payload as payload
          from phase_12m_state
          where singleton
        ) source
      )
    )
  $$,
  '55000',
  'legacy_openai_provenance_forbidden',
  'the sealed legacy path rejects invented OpenAI provenance after completion'
);

reset role;
update app_private.async_jobs job
set status = 'processing', completed_at = null
where job.id = (select pro_job_id from phase_12m_state where singleton);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select pro_job_id from phase_12m_state where singleton),
      (select pro_message_id from phase_12m_state where singleton),
      'd3888888-8888-4888-8888-888888888888',
      (select pro_payload from phase_12m_state where singleton)
    )
  $$,
  'a Pro-revised result completes only with exact final-critic approval'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = (
      select pro_submission_id from phase_12m_state where singleton
    )
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.ai_model = 'deepseek-v4-pro'
  )
    and exists (
      select 1
      from app_private.writing_feedback_adjudications_v2 evidence
      join app_private.feedback_drafts draft
        on draft.submission_id = evidence.submission_id
       and draft.version = evidence.feedback_version
      where evidence.job_id = (
        select pro_job_id from phase_12m_state where singleton
      )
        and evidence.reason_code = 'final_critic_approved'
        and evidence.generator_model = 'deepseek-v4-flash'
        and evidence.adjudicator_model = 'deepseek-v4-pro'
        and evidence.schema_version = 2
        and evidence.critic_provider = 'gemini'
        and evidence.critic_model = 'gemini-3.1-flash-lite'
        and evidence.final_critic_provider = 'gemini'
        and evidence.final_critic_model = 'gemini-3.1-flash-lite'
        and evidence.accepted_model = 'deepseek-v4-pro'
        and draft.state = 'released'
        and draft.provider_model = 'deepseek-v4-pro'
        and app_private.canonical_jsonb_sha256(draft.content) =
          evidence.final_feedback_sha256
    ),
  'Pro revision is released with truthful immutable provenance and exact content hash'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select pro_job_id from phase_12m_state where singleton),
      (select pro_message_id from phase_12m_state where singleton),
      'd3888888-8888-4888-8888-888888888888',
      (select pro_payload from phase_12m_state where singleton)
    )
  $$,
  'an exact Pro-revised completion replay succeeds'
);

select throws_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select pro_job_id from phase_12m_state where singleton),
      (select pro_message_id from phase_12m_state where singleton),
      'd3888888-8888-4888-8888-888888888888',
      jsonb_set(
        (select pro_payload from phase_12m_state where singleton),
        '{overall_summary}',
        to_jsonb('Altered Pro feedback.'::text)
      )
    )
  $$,
  '55000',
  'writing_adjudication_feedback_hash_mismatch',
  'altered Pro-revised content cannot reuse final-critic approval'
);

reset role;

select * from finish();
rollback;
