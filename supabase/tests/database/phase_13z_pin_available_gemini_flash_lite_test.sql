begin;

select plan(46);

select is(
  (
    select count(*)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and constraint_row.conname in (
        'writing_feedback_adjudications_v2_critic_shape_check',
        'writing_feedback_adjudications_v2_decision_shape_check',
        'writing_feedback_adjudications_v2_final_critic_shape_check',
        'writing_feedback_adjudications_v2_generator_model_check'
      )
      and position(
        'gemini-3.1-flash-lite'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ),
  4::bigint,
  'every writing evidence constraint accepts current Gemini Flash Lite provenance'
);

select ok(
  (
    select position(
      'gemini-2.5-flash'
      in pg_get_constraintdef(constraint_row.oid)
    ) > 0
      and position(
        'gemini-3.5-flash'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and constraint_row.conname =
        'writing_feedback_adjudications_v2_critic_shape_check'
  ),
  'historical Gemini 2.5 and 3.5 writing critic evidence remains valid'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_writing_critic_insert()'::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_writing_critic_insert()'::regprocedure
      )
    ) = 0,
  'new writing adjudications are pinned to Gemini Flash Lite only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and trigger_row.tgname =
        'writing_feedback_adjudications_v2_current_critic'
      and not trigger_row.tgisinternal
  ),
  'the current-writing-model trigger remains installed'
);

select ok(
  (
    select position(
      'gemini-3.1-flash-lite'
      in pg_get_constraintdef(constraint_row.oid)
    ) > 0
      and position(
        'gemini-2.5-flash'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'gemini-3.5-flash'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_completions_v2'::regclass
      and constraint_row.conname =
        'worksheet_generation_completions_v2_shape_check'
  ),
  'worksheet completion evidence accepts current and historical Gemini models'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_worksheet_critic_insert()'::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_worksheet_critic_insert()'::regprocedure
      )
    ) = 0,
  'new worksheet completion evidence is pinned to Gemini Flash Lite only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_completions_v2'::regclass
      and trigger_row.tgname =
        'worksheet_generation_completions_v2_current_critic'
      and not trigger_row.tgisinternal
  ),
  'the current-worksheet-completion-model trigger remains installed'
);

select is(
  (
    select count(*)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_checkpoints'::regclass
      and constraint_row.conname in (
        'worksheet_generation_checkpoints_provider_model_check',
        'worksheet_generation_checkpoints_stage_shape_check'
      )
      and position(
        'gemini-3.1-flash-lite'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'gemini-3.5-flash'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ),
  2::bigint,
  'checkpoint constraints preserve 3.5 rows and accept 3.1 Flash Lite rows'
);

select is(
  (
    select count(*)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_stage_evidence'::regclass
      and constraint_row.conname in (
        'worksheet_generation_stage_evidence_gemini_critic_model_check',
        'worksheet_generation_stage_evidence_provider_model_check'
      )
      and position(
        'gemini-3.1-flash-lite'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'gemini-3.5-flash'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ),
  2::bigint,
  'rejected-stage evidence preserves 3.5 rows and accepts Flash Lite rows'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_checkpoints'::regclass
      and trigger_row.tgname =
        'worksheet_generation_checkpoints_current_gemini'
      and not trigger_row.tgisinternal
      and position(
        'candidate_provider'
        in pg_get_triggerdef(trigger_row.oid)
      ) > 0
      and position(
        'candidate_model'
        in pg_get_triggerdef(trigger_row.oid)
      ) > 0
      and position(
        'candidate_sha256'
        in pg_get_triggerdef(trigger_row.oid)
      ) > 0
  ),
  'provider, model, and hash changes cannot bypass the checkpoint model pin'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_stage_evidence'::regclass
      and trigger_row.tgname =
        'worksheet_generation_stage_evidence_current_gemini'
      and not trigger_row.tgisinternal
  ),
  'new rejected-stage evidence has a current-model trigger'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_worksheet_checkpoint_gemini()'::regprocedure
    )
  ) > 0
    and position(
      'new.candidate_provider is distinct from old.candidate_provider'
      in lower(pg_get_functiondef(
        'app_private.enforce_current_worksheet_checkpoint_gemini()'::regprocedure
      ))
    ) > 0
    and position(
      'new.candidate_model is distinct from old.candidate_model'
      in lower(pg_get_functiondef(
        'app_private.enforce_current_worksheet_checkpoint_gemini()'::regprocedure
      ))
    ) > 0
    and position(
      'new.candidate_sha256 is distinct from old.candidate_sha256'
      in lower(pg_get_functiondef(
        'app_private.enforce_current_worksheet_checkpoint_gemini()'::regprocedure
      ))
    ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_worksheet_checkpoint_gemini()'::regprocedure
      )
    ) = 0,
  'the checkpoint write trigger pins newly changed evidence to Flash Lite'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_worksheet_stage_evidence_gemini()'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_worksheet_stage_evidence_gemini()'
          ::regprocedure
      )
    ) = 0,
  'the rejected-stage write trigger pins new evidence to Flash Lite'
);

select ok(
  position(
    'gemini-2.5-flash'
    in pg_get_functiondef(
      'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'
          ::regprocedure
      )
    ) > 0
    and position(
      'gemini-3.1-flash-lite'
      in pg_get_functiondef(
        'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'
          ::regprocedure
      )
    ) > 0,
  'checkpoint critic validation understands current and historical evidence'
);

select ok(
  position(
    'gemini-2.5-flash'
    in pg_get_functiondef(
      'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
      )
    ) > 0
    and position(
      'gemini-3.1-flash-lite'
      in pg_get_functiondef(
        'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
      )
    ) > 0,
  'dual-critic validation understands current and historical evidence'
);

select ok(
  position(
    'gemini-3.5-flash'
    in pg_get_functiondef(
      'app_private.normalize_worksheet_generation_provenance_v2(jsonb)'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.1-flash-lite'
      in pg_get_functiondef(
        'app_private.normalize_worksheet_generation_provenance_v2(jsonb)'
          ::regprocedure
      )
    ) > 0,
  'worksheet provenance normalization preserves 3.5 and accepts Flash Lite'
);

select ok(
  position(
    'gemini-3.5-flash'
    in pg_get_functiondef(
      'app_private.complete_certified_worksheet_bank_fallback(uuid,bigint,uuid,jsonb)'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.1-flash-lite'
      in pg_get_functiondef(
        'app_private.complete_certified_worksheet_bank_fallback(uuid,bigint,uuid,jsonb)'
          ::regprocedure
      )
    ) > 0,
  'certified-bank fallback accepts historical and current rejected candidates'
);

select ok(
  position(
    'gemini-3.5-flash'
    in pg_get_functiondef(
      'app_private.assert_worksheet_checkpoint_candidate(jsonb,smallint,text,text)'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.1-flash-lite'
      in pg_get_functiondef(
        'app_private.assert_worksheet_checkpoint_candidate(jsonb,smallint,text,text)'
          ::regprocedure
      )
    ) > 0,
  'checkpoint candidate validation accepts historical replay and current work'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'
        ::regprocedure
    )
  ) > 0,
  'the durable fallback save path expects Gemini Flash Lite'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.1-flash-lite'
      and policy.call_purpose in (
        'writing_generation',
        'writing_critique',
        'writing_final_critique',
        'worksheet_generation',
        'worksheet_critique'
      )
      and policy.input_rate_microusd_per_million = 250000
      and policy.cached_input_rate_microusd_per_million = 25000
      and policy.output_rate_microusd_per_million = 1500000
      and policy.maximum_reservation_microusd = case policy.call_purpose
        when 'writing_generation' then 300000
        when 'worksheet_generation' then 200000
        else 150000
      end
  ),
  5::bigint,
  'all five new Flash Lite purposes use the official rates and existing caps'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.1-flash-lite'
      and policy.call_purpose = 'worksheet_answer_evaluation'
      and policy.input_rate_microusd_per_million = 250000
      and policy.cached_input_rate_microusd_per_million = 25000
      and policy.output_rate_microusd_per_million = 1500000
      and policy.maximum_reservation_microusd = 50000
  ),
  1::bigint,
  'the existing Flash Lite worksheet-answer policy uses the official cached-input rate'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.5-flash'
  ),
  5::bigint,
  'all five historical Gemini 3.5 cost-policy rows remain intact'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-2.5-flash'
  ),
  2::bigint,
  'both historical Gemini 2.5 critic cost-policy rows remain intact'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.ai_model_cost_policies'::regclass
      and trigger_row.tgname = 'ai_model_cost_policies_immutable'
      and not trigger_row.tgisinternal
  ),
  'the append-only cost-policy trigger is restored after inserting new rows'
);

create temporary table gemini_checkpoint_pin_fixture (
  id integer primary key,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  gemini_critic_evidence jsonb
);

create trigger gemini_checkpoint_pin_fixture_trigger
before insert or update of
  candidate_provider,
  candidate_model,
  candidate_sha256,
  gemini_critic_evidence
on gemini_checkpoint_pin_fixture
for each row execute function
  app_private.enforce_current_worksheet_checkpoint_gemini();

select lives_ok(
  $$
    insert into gemini_checkpoint_pin_fixture (
      id, candidate_provider, candidate_model, candidate_sha256
    ) values (
      1,
      'gemini',
      'gemini-3.1-flash-lite',
      repeat('a', 64)
    )
  $$,
  'a new Flash Lite checkpoint passes the current-model trigger'
);

select throws_ok(
  $$
    update gemini_checkpoint_pin_fixture
    set candidate_model = 'gemini-3.5-flash'
    where id = 1
  $$,
  '22023',
  'worksheet_checkpoint_candidate_model_retired',
  'changing only the model cannot bypass the current checkpoint pin'
);

insert into gemini_checkpoint_pin_fixture (
  id, candidate_provider, candidate_model, candidate_sha256
) values (
  2,
  'deepseek',
  'deepseek-v4-pro',
  repeat('b', 64)
);

select throws_ok(
  $$
    update gemini_checkpoint_pin_fixture
    set
      candidate_provider = 'gemini',
      candidate_model = 'gemini-3.5-flash'
    where id = 2
  $$,
  '22023',
  'worksheet_checkpoint_candidate_model_retired',
  'changing provider and model while retaining a hash cannot bypass the pin'
);

alter table gemini_checkpoint_pin_fixture
  disable trigger gemini_checkpoint_pin_fixture_trigger;
insert into gemini_checkpoint_pin_fixture (
  id, candidate_provider, candidate_model, candidate_sha256
) values (
  3,
  'gemini',
  'gemini-3.5-flash',
  repeat('c', 64)
);
alter table gemini_checkpoint_pin_fixture
  enable trigger gemini_checkpoint_pin_fixture_trigger;

select lives_ok(
  $$
    update gemini_checkpoint_pin_fixture
    set candidate_model = candidate_model
    where id = 3
  $$,
  'a historical 3.5 checkpoint supports a no-op replay update'
);

select throws_ok(
  $$
    update gemini_checkpoint_pin_fixture
    set gemini_critic_evidence = jsonb_build_object(
      'model', 'gemini-3.5-flash'
    )
    where id = 1
  $$,
  '22023',
  'worksheet_checkpoint_critic_model_retired',
  'new checkpoint critic evidence cannot use a historical Gemini model'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_worksheet_rejection_model_insert()'
        ::regprocedure
    )
  ) > 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_worksheet_rejection_model_insert()'
          ::regprocedure
      )
    ) = 0
    and position(
      '{validation,critics,gemini,model}'
      in pg_get_functiondef(
        'app_private.enforce_current_worksheet_rejection_model_insert()'
          ::regprocedure
      )
    ) > 0,
  'new worksheet rejection evidence is pinned to Gemini Flash Lite only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_rejections'::regclass
      and trigger_row.tgname =
        'worksheet_generation_rejections_10_current_gemini'
      and not trigger_row.tgisinternal
      and position('BEFORE INSERT' in pg_get_triggerdef(trigger_row.oid)) > 0
      and position('UPDATE' in pg_get_triggerdef(trigger_row.oid)) = 0
      and position('DELETE' in pg_get_triggerdef(trigger_row.oid)) = 0
  ),
  'the worksheet-rejection current-model boundary applies only to new rows'
);

create temporary table gemini_rejection_pin_fixture (
  id integer primary key,
  provider text not null,
  model text not null,
  candidate jsonb not null default '{}'::jsonb,
  replay_state text not null default 'recorded'
);

create trigger gemini_rejection_pin_fixture_trigger
before insert on gemini_rejection_pin_fixture
for each row execute function
  app_private.enforce_current_worksheet_rejection_model_insert();

select lives_ok(
  $$insert into gemini_rejection_pin_fixture (id, provider, model)
    values (1, 'deepseek', 'deepseek-v4-pro')$$,
  'the worksheet rejection boundary leaves DeepSeek evidence unaffected'
);

select lives_ok(
  $$insert into gemini_rejection_pin_fixture (
      id, provider, model, candidate
    ) values (
      2,
      'gemini',
      'gemini-3.1-flash-lite',
      '{"validation":{"critics":{"gemini":{"model":"gemini-3.1-flash-lite"}}}}'
    )$$,
  'an active fallback can persist current Flash Lite generation and critic evidence'
);

select throws_ok(
  $$insert into gemini_rejection_pin_fixture (id, provider, model)
    values (3, 'gemini', 'gemini-3.5-flash')$$,
  '22023',
  'worksheet_rejection_model_retired',
  'an active fallback cannot persist a newly rejected Gemini 3.5 candidate'
);

select throws_ok(
  $$insert into gemini_rejection_pin_fixture (
      id, provider, model, candidate
    ) values (
      5,
      'deepseek',
      'deepseek-v4-pro',
      '{"validation":{"critics":{"gemini":{"model":"gemini-3.5-flash"}}}}'
    )$$,
  '22023',
  'worksheet_rejection_critic_model_retired',
  'a DeepSeek candidate cannot embed newly rejected Gemini 3.5 critic evidence'
);

select throws_ok(
  $$insert into gemini_rejection_pin_fixture (
      id, provider, model, candidate
    ) values (
      6,
      'gemini',
      'gemini-3.1-flash-lite',
      '{"validation":{"critics":{"gemini":{"model":"gemini-3.5-flash"}}}}'
    )$$,
  '22023',
  'worksheet_rejection_critic_model_retired',
  'a Flash Lite candidate cannot embed newly rejected Gemini 3.5 critic evidence'
);

alter table gemini_rejection_pin_fixture
  disable trigger gemini_rejection_pin_fixture_trigger;
insert into gemini_rejection_pin_fixture (id, provider, model, candidate)
values (
  4,
  'gemini',
  'gemini-3.5-flash',
  '{"validation":{"critics":{"gemini":{"model":"gemini-3.5-flash"}}}}'
);
alter table gemini_rejection_pin_fixture
  enable trigger gemini_rejection_pin_fixture_trigger;

select lives_ok(
  $$update gemini_rejection_pin_fixture
    set replay_state = 'replayed'
    where id = 4$$,
  'the insert-only pin does not retroactively reject historical 3.5 evidence'
);

select ok(
  (
    select
      position(
        'if selected_job.status = ''succeeded'' then'
        in source.body
      ) > 0
      and position(
        'insert into app_private.worksheet_generation_rejections'
        in source.body
      ) > position(
        'if selected_job.status = ''succeeded'' then'
        in source.body
      )
      and position(
        'return;'
        in substring(
          source.body
          from position(
            'if selected_job.status = ''succeeded'' then'
            in source.body
          )
          for position(
            'insert into app_private.worksheet_generation_rejections'
            in source.body
          ) - position(
            'if selected_job.status = ''succeeded'' then'
            in source.body
          )
        )
      ) > 0
    from (
      select lower(pg_get_functiondef(
        'app_private.complete_certified_worksheet_bank_fallback(uuid,bigint,uuid,jsonb)'
          ::regprocedure
      )) as body
    ) source
  ),
  'an exact succeeded fallback replay returns before the new rejection insert boundary'
);

select ok(
  position(
    'gemini-3.1-flash-lite'
    in pg_get_functiondef(
      'app_private.enforce_current_ai_reservation_model_insert()'::regprocedure
    )
  ) > 0
    and position(
      'gemini-2.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_ai_reservation_model_insert()'::regprocedure
      )
    ) = 0
    and position(
      'gemini-3.5-flash'
      in pg_get_functiondef(
        'app_private.enforce_current_ai_reservation_model_insert()'::regprocedure
      )
    ) = 0,
  'new Gemini spend reservations are pinned to Flash Lite only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.ai_spend_reservations'::regclass
      and trigger_row.tgname = 'ai_spend_reservations_10_current_gemini'
      and not trigger_row.tgisinternal
      and position('BEFORE INSERT' in pg_get_triggerdef(trigger_row.oid)) > 0
      and position('UPDATE' in pg_get_triggerdef(trigger_row.oid)) = 0
      and position('DELETE' in pg_get_triggerdef(trigger_row.oid)) = 0
  ),
  'the current-model spend boundary applies only to new reservations'
);

create temporary table gemini_reservation_pin_fixture (
  id integer primary key,
  provider_name text not null,
  model_name text not null,
  state text not null default 'reserved'
);

create trigger gemini_reservation_pin_fixture_trigger
before insert on gemini_reservation_pin_fixture
for each row execute function
  app_private.enforce_current_ai_reservation_model_insert();

select lives_ok(
  $$insert into gemini_reservation_pin_fixture (id, provider_name, model_name)
    values (1, 'deepseek', 'deepseek-v4-pro')$$,
  'the reservation boundary leaves DeepSeek calls unaffected'
);

select lives_ok(
  $$insert into gemini_reservation_pin_fixture (id, provider_name, model_name)
    values (2, 'gemini', 'gemini-3.1-flash-lite')$$,
  'a new Flash Lite spend reservation passes the current-model boundary'
);

select throws_ok(
  $$insert into gemini_reservation_pin_fixture (id, provider_name, model_name)
    values (3, 'gemini', 'gemini-2.5-flash')$$,
  '22023',
  'ai_spend_reservation_model_retired',
  'a retained Gemini 2.5 cost policy cannot authorize a new reservation'
);

select throws_ok(
  $$insert into gemini_reservation_pin_fixture (id, provider_name, model_name)
    values (4, 'gemini', 'gemini-3.5-flash')$$,
  '22023',
  'ai_spend_reservation_model_retired',
  'a retained Gemini 3.5 cost policy cannot authorize a new reservation'
);

alter table gemini_reservation_pin_fixture
  disable trigger gemini_reservation_pin_fixture_trigger;
insert into gemini_reservation_pin_fixture (
  id, provider_name, model_name, state
) values (
  5, 'gemini', 'gemini-3.5-flash', 'reserved'
);
alter table gemini_reservation_pin_fixture
  enable trigger gemini_reservation_pin_fixture_trigger;

select lives_ok(
  $$update gemini_reservation_pin_fixture
    set state = 'finalized'
    where id = 5$$,
  'the insert-only pin still allows historical reservations to finalize'
);

select ok(
  (
    select
      position('if recorded.id is not null then' in source.body) > 0
      and position(
        'insert into app_private.ai_spend_reservations'
        in source.body
      ) > position('if recorded.id is not null then' in source.body)
      and position(
        'return;'
        in substring(
          source.body
          from position('if recorded.id is not null then' in source.body)
          for position(
            'insert into app_private.ai_spend_reservations'
            in source.body
          ) - position('if recorded.id is not null then' in source.body)
        )
      ) > 0
    from (
      select lower(pg_get_functiondef(
        'app_private.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'
          ::regprocedure
      )) as body
    ) source
  ),
  'an exact historical reservation replay returns before the new insert boundary'
);

select * from finish(true);
rollback;
