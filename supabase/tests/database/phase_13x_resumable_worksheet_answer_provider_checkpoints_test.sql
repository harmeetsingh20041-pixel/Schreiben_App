begin;

set local search_path = public, extensions;

select plan(31);

select ok(
  to_regclass('app_private.worksheet_answer_provider_checkpoints') is not null,
  'private worksheet-answer provider checkpoint table exists'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
  ),
  'checkpoint table has RLS enabled'
);

select ok(
  not has_table_privilege(
    'anon',
    'app_private.worksheet_answer_provider_checkpoints',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'anonymous clients have no checkpoint table privileges'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'app_private.worksheet_answer_provider_checkpoints',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'authenticated clients have no checkpoint table privileges'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.worksheet_answer_provider_checkpoints',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has no direct checkpoint table privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.get_worksheet_answer_provider_checkpoints(uuid,bigint,uuid,uuid,integer,text,text,text,integer,integer)',
    'EXECUTE'
  )
  and (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.get_worksheet_answer_provider_checkpoints(uuid,bigint,uuid,uuid,integer,text,text,text,integer,integer)'::regprocedure
  ),
  'service role can load checkpoints only through the API facade'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  )
  and (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ),
  'service role can save checkpoints only through the API facade'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.get_worksheet_answer_provider_checkpoints(uuid,bigint,uuid,uuid,integer,text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot load checkpoints'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot save checkpoints'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  ),
  'internal checkpoint mutator is not directly executable'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger
    where trigger.tgrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and trigger.tgname = 'worksheet_answer_provider_checkpoints_immutable'
      and not trigger.tgisinternal
  ),
  'checkpoint updates are rejected by an immutable trigger'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger
    where trigger.tgrelid = 'app_private.async_jobs'::regclass
      and trigger.tgname =
        'async_jobs_delete_terminal_worksheet_answer_checkpoints'
      and not trigger.tgisinternal
  ),
  'terminal async jobs invoke checkpoint deletion'
);

select ok(
  pg_get_functiondef(
    'app_private.delete_terminal_worksheet_answer_checkpoints()'::regprocedure
  ) ~ $$new\.status in \('succeeded', 'dead'\)$$
  and pg_get_functiondef(
    'app_private.delete_terminal_worksheet_answer_checkpoints()'::regprocedure
  ) like '%delete from app_private.worksheet_answer_provider_checkpoints%',
  'completion, holding, exhaustion, and reconciliation delete private verdicts'
);

select ok(
  pg_get_functiondef(
    'app_private.assert_active_worksheet_answer_checkpoint_lease(uuid,bigint,uuid,uuid,integer)'::regprocedure
  ) like '%for update%'
  and pg_get_functiondef(
    'app_private.assert_active_worksheet_answer_checkpoint_lease(uuid,bigint,uuid,uuid,integer)'::regprocedure
  ) like '%lease_expires_at <= clock_timestamp()%',
  'every checkpoint operation validates a locked unexpired worker lease'
);

select ok(
  pg_get_functiondef(
    'app_private.get_worksheet_answer_provider_checkpoints(uuid,bigint,uuid,uuid,integer,text,text,text,integer,integer)'::regprocedure
  ) like '%worksheet_answer_checkpoint_replay_mismatch%'
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%worksheet_answer_checkpoint_replay_mismatch%'
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%finalize_ai_spend_reservation%',
  'load/save fail closed and verdict persistence atomically finalizes spend'
);

select ok(
  pg_get_functiondef(
    'app_private.assert_worksheet_answer_checkpoint_verdict(text,jsonb)'::regprocedure
  ) like '%jsonb_array_length(normalized_verdict) not between 1 and 3%'
  and pg_get_functiondef(
    'app_private.assert_worksheet_answer_checkpoint_verdict(text,jsonb)'::regprocedure
  ) like '%count(distinct verdict ->> ''question_id'')%',
  'checkpoint verdicts are closed to at most three unique flexible answers'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%deepseek-v4-flash%'
      and pg_get_constraintdef(constraint_row.oid)
        like '%gemini-3.1-flash-lite%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%canonical_jsonb_sha256(normalized_verdict)%'
  )
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%canonical_jsonb_sha256(target_normalized_verdict)%'
  and app_private.canonical_jsonb_sha256(
    '[{"question_id":"q1","points":1}]'::jsonb
  ) = app_private.canonical_jsonb_sha256(
    '[{"points":1,"question_id":"q1"}]'::jsonb
  ),
  'provider models and canonical JSON verdict hashes are database-enforced'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)',
    'EXECUTE'
  )
  and (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)'::regprocedure
  ),
  'service role can load Pro adjudication only through its API facade'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  )
  and (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ),
  'service role can atomically save Pro adjudication through its API facade'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot read or save Pro adjudication checkpoints'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)',
    'EXECUTE'
  ),
  'internal Pro checkpoint functions are not directly executable'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%checkpoint_role%evaluation%adjudication%'
      and pg_get_constraintdef(constraint_row.oid)
        like '%jsonb_array_length(normalized_verdict)%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%checkpoint_role%adjudication%deepseek-v4-pro%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%evaluator_contract_version = 1%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_provider_checkpoints'::regclass
      and pg_get_constraintdef(constraint_row.oid)
        like '%prompt_contract_version = 1%'
  ),
  'table constraints separate evaluator/Pro shapes and pin contract versions'
);

select ok(
  pg_get_functiondef(
    'app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(jsonb)'::regprocedure
  ) like '%deepseek_result_sha256%'
  and pg_get_functiondef(
    'app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(jsonb)'::regprocedure
  ) like '%gemini_result_sha256%'
  and pg_get_functiondef(
    'app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(jsonb)'::regprocedure
  ) like '%count(distinct resolution ->> ''question_ref'')%'
  and pg_get_functiondef(
    'app_private.assert_worksheet_answer_adjudication_checkpoint_verdict(jsonb)'::regprocedure
  ) like '%resolution_status%uncertain%selected_evidence%'
  and app_private.canonical_jsonb_sha256(
    '{"deepseek_result_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","gemini_result_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","resolutions":[{"question_ref":"q1","resolution_status":"resolved","selected_evidence":"gemini","short_reason":"Beleg."}]}'::jsonb
  ) = app_private.canonical_jsonb_sha256(
    '{"resolutions":[{"short_reason":"Beleg.","selected_evidence":"gemini","resolution_status":"resolved","question_ref":"q1"}],"gemini_result_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","deepseek_result_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb
  ),
  'Pro payload is closed, bounded, consistent, and canonically hashable'
);

select ok(
  pg_get_functiondef(
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%target_normalized_verdict ->> ''deepseek_result_sha256''%'
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%target_normalized_verdict ->> ''gemini_result_sha256''%'
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%worksheet_answer_adjudication%'
  and pg_get_functiondef(
    'app_private.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure
  ) like '%finalize_ai_spend_reservation%'
  and pg_get_functiondef(
    'app_private.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)'::regprocedure
  ) like '%checkpoint_role = ''evaluation''%'
  and pg_get_functiondef(
    'app_private.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)'::regprocedure
  ) like '%checkpoint_role = ''adjudication''%',
  'Pro replay requires both exact Flash hashes and atomically finalizes exact usage'
);

-- Behavioral proof uses a minimal exact worker fixture. Foreign-key triggers
-- are disabled only while the fixture graph is inserted; every contract under
-- test, including the active lease, immutable checkpoints, spend finalizer,
-- and terminal cleanup trigger, runs with ordinary trigger behavior.
reset role;
set local session_replication_role = replica;

-- Spend finalization updates the reservation under ordinary FK enforcement,
-- so its student and workspace anchors must exist even though the larger
-- worksheet fixture graph is inserted with replication triggers disabled.
insert into public.profiles (id, full_name, email, global_role)
values (
  'f1300000-0000-4000-8000-000000000002',
  'Phase 13X Checkpoint Student',
  'phase13x-checkpoint-student@example.test',
  'student'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'f1300000-0000-4000-8000-000000000001',
  'Phase 13X Checkpoint Workspace',
  'phase-13x-checkpoint-workspace',
  'f1300000-0000-4000-8000-000000000002'
);

insert into public.workspace_members (
  id, workspace_id, user_id, role
) values (
  'f1300000-0000-4000-8000-000000000003',
  'f1300000-0000-4000-8000-000000000001',
  'f1300000-0000-4000-8000-000000000002',
  'student'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_at, completed_at, generation_status
) values (
  'f1300000-0000-4000-8000-000000000007',
  'f1300000-0000-4000-8000-000000000001',
  'f1300000-0000-4000-8000-000000000002',
  'f1300000-0000-4000-8000-000000000004',
  'f1300000-0000-4000-8000-000000000005',
  'f1300000-0000-4000-8000-000000000006',
  'A2', 1, 'teacher_verified', 'manual', 'completed', now(), now(), 'ready'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
) values (
  'f1300000-0000-4000-8000-000000000008',
  'f1300000-0000-4000-8000-000000000005',
  'f1300000-0000-4000-8000-000000000002',
  'f1300000-0000-4000-8000-000000000001',
  'f1300000-0000-4000-8000-000000000007',
  '[]'::jsonb,
  0, 1, 0, 1, 0, false, 'phase_13x_checkpoint_behavior',
  'evaluating', 1, now(), 'submitted', now(), now(), now()
);

update public.student_practice_assignments assignment
set latest_attempt_id = 'f1300000-0000-4000-8000-000000000008'
where assignment.id = 'f1300000-0000-4000-8000-000000000007';

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at
) values (
  'f1300000-0000-4000-8000-000000000009',
  'worksheet_answer_evaluation', 'worksheet_answer_evaluation',
  'f1300000-0000-4000-8000-000000000008', 1,
  'phase13x:answer-checkpoint:behavior', 'processing', 1,
  913000000000000001,
  'f1300000-0000-4000-8000-00000000000a',
  now(), now() + interval '10 minutes', now(), now()
);

create temporary table phase_13x_checkpoint_payloads on commit drop as
with hashes as (
  select
    app_private.canonical_jsonb_sha256(
      '[{"provider":"deepseek"}]'::jsonb
    ) as deepseek_hash,
    app_private.canonical_jsonb_sha256(
      '[{"provider":"gemini"}]'::jsonb
    ) as gemini_hash
), payloads as (
  select
    hashes.deepseek_hash,
    hashes.gemini_hash,
    jsonb_build_object(
      'deepseek_result_sha256', hashes.deepseek_hash,
      'gemini_result_sha256', hashes.gemini_hash,
      'resolutions', jsonb_build_array(
        jsonb_build_object(
          'question_ref', 'q1',
          'resolution_status', 'resolved',
          'selected_evidence', 'deepseek',
          'short_reason', 'Der Beleg ist eindeutig.'
        )
      )
    ) as pro_payload
  from hashes
)
select
  payloads.deepseek_hash,
  payloads.gemini_hash,
  payloads.pro_payload,
  app_private.canonical_jsonb_sha256(payloads.pro_payload) as pro_sha256,
  jsonb_set(
    payloads.pro_payload,
    '{deepseek_result_sha256}',
    to_jsonb(repeat('e', 64))
  ) as mismatched_payload,
  app_private.canonical_jsonb_sha256(
    jsonb_set(
      payloads.pro_payload,
      '{deepseek_result_sha256}',
      to_jsonb(repeat('e', 64))
    )
  ) as mismatched_sha256
from payloads;

grant select on phase_13x_checkpoint_payloads to service_role;

insert into app_private.worksheet_answer_provider_checkpoints (
  job_id, attempt_id, entity_version, checkpoint_role,
  evaluator_contract_version, prompt_contract_version, evidence_sha256,
  provider_name, provider_model, verdict_sha256, normalized_verdict
)
select
  'f1300000-0000-4000-8000-000000000009'::uuid,
  'f1300000-0000-4000-8000-000000000008'::uuid,
  1, 'evaluation', 1, 1, repeat('a', 64),
  'deepseek', 'deepseek-v4-flash', payload.deepseek_hash,
  '[{"provider":"deepseek"}]'::jsonb
from phase_13x_checkpoint_payloads payload
union all
select
  'f1300000-0000-4000-8000-000000000009'::uuid,
  'f1300000-0000-4000-8000-000000000008'::uuid,
  1, 'evaluation', 1, 1, repeat('a', 64),
  'gemini', 'gemini-3.1-flash-lite', payload.gemini_hash,
  '[{"provider":"gemini"}]'::jsonb
from phase_13x_checkpoint_payloads payload;

insert into app_private.ai_spend_reservations (
  id, job_id, entity_version, call_key, workspace_id, student_id,
  billing_month, provider_name, model_name, call_purpose,
  cached_input_rate_microusd_per_million,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd, state, expires_at
) values (
  'f1300000-0000-4000-8000-00000000000b',
  'f1300000-0000-4000-8000-000000000009',
  1, 'attempt_1:phase13x.pro',
  'f1300000-0000-4000-8000-000000000001',
  'f1300000-0000-4000-8000-000000000002',
  date_trunc('month', timezone('UTC', now()))::date,
  'deepseek', 'deepseek-v4-pro', 'worksheet_answer_adjudication',
  1000000, 1000000, 1000000, 100000, 'reserved',
  now() + interval '15 minutes'
);

set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

select throws_ok(
  $behavior$
    select *
    from api.save_worksheet_answer_adjudication_checkpoint(
      'f1300000-0000-4000-8000-000000000009',
      913000000000000001,
      'f1300000-0000-4000-8000-00000000000a',
      'f1300000-0000-4000-8000-000000000008',
      1, repeat('d', 64), 'deepseek-v4-pro',
      (select mismatched_sha256 from phase_13x_checkpoint_payloads),
      (select mismatched_payload from phase_13x_checkpoint_payloads),
      'phase13x.pro', 'deepseek-v4-pro', 180, 30, 0, 180, 1, 1
    )
  $behavior$,
  '55000',
  'worksheet_answer_checkpoint_replay_mismatch',
  'Pro save rejects a payload whose embedded Flash hash is not exact'
);

select lives_ok(
  $behavior$
    select *
    from api.save_worksheet_answer_adjudication_checkpoint(
      'f1300000-0000-4000-8000-000000000009',
      913000000000000001,
      'f1300000-0000-4000-8000-00000000000a',
      'f1300000-0000-4000-8000-000000000008',
      1, repeat('d', 64), 'deepseek-v4-pro',
      (select pro_sha256 from phase_13x_checkpoint_payloads),
      (select pro_payload from phase_13x_checkpoint_payloads),
      'phase13x.pro', 'deepseek-v4-pro', 180, 30, 0, 180, 1, 1
    )
  $behavior$,
  'valid Pro checkpoint and exact usage commit together'
);

reset role;
select ok(
  exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = 'f1300000-0000-4000-8000-000000000009'
      and checkpoint.checkpoint_role = 'adjudication'
      and checkpoint.provider_name = 'deepseek'
      and checkpoint.verdict_sha256 =
        (select pro_sha256 from phase_13x_checkpoint_payloads)
  )
  and exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = 'f1300000-0000-4000-8000-00000000000b'
      and reservation.state = 'finalized'
      and reservation.billed_input_tokens = 180
      and reservation.billed_output_tokens = 30
      and reservation.billed_cached_input_tokens = 0
      and reservation.billed_uncached_input_tokens = 180
      and reservation.cache_metadata_present
  ),
  'the behavior fixture proves checkpoint plus exact finalized invoice state'
);

set local role service_role;
select lives_ok(
  $behavior$
    select *
    from api.save_worksheet_answer_adjudication_checkpoint(
      'f1300000-0000-4000-8000-000000000009',
      913000000000000001,
      'f1300000-0000-4000-8000-00000000000a',
      'f1300000-0000-4000-8000-000000000008',
      1, repeat('d', 64), 'deepseek-v4-pro',
      (select pro_sha256 from phase_13x_checkpoint_payloads),
      (select pro_payload from phase_13x_checkpoint_payloads),
      'phase13x.pro', 'deepseek-v4-pro', 180, 30, 0, 180, 1, 1
    )
  $behavior$,
  'an exact lost-response replay accepts the already finalized invoice'
);

reset role;
select is(
  (
    select count(*)
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = 'f1300000-0000-4000-8000-000000000009'
      and checkpoint.checkpoint_role = 'adjudication'
  ),
  1::bigint,
  'idempotent finalized replay retains exactly one immutable Pro row'
);

update app_private.async_jobs job
set lease_expires_at = clock_timestamp() - interval '1 second'
where job.id = 'f1300000-0000-4000-8000-000000000009';
set local role service_role;

select throws_ok(
  $behavior$
    select *
    from api.get_worksheet_answer_adjudication_checkpoint(
      'f1300000-0000-4000-8000-000000000009',
      913000000000000001,
      'f1300000-0000-4000-8000-00000000000a',
      'f1300000-0000-4000-8000-000000000008',
      1, repeat('d', 64), 'deepseek-v4-pro', 1, 1
    )
  $behavior$,
  '55000',
  'worksheet_answer_checkpoint_lease_stale',
  'an expired lease cannot replay even a valid durable Pro checkpoint'
);

reset role;
update app_private.async_jobs job
set
  lease_expires_at = clock_timestamp() + interval '10 minutes',
  status = 'succeeded',
  completed_at = clock_timestamp()
where job.id = 'f1300000-0000-4000-8000-000000000009';

select ok(
  not exists (
    select 1
    from app_private.worksheet_answer_provider_checkpoints checkpoint
    where checkpoint.job_id = 'f1300000-0000-4000-8000-000000000009'
  )
  and exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = 'f1300000-0000-4000-8000-00000000000b'
      and reservation.state = 'finalized'
      and reservation.billed_input_tokens = 180
      and reservation.billed_output_tokens = 30
  ),
  'terminal success deletes all transient roles but preserves invoice evidence'
);

select * from finish(true);
rollback;
