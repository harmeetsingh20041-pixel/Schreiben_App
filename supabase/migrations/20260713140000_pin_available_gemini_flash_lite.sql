-- Pin every new Gemini writing/worksheet generation and critique call to the
-- model that is available in the launch project. Historical Gemini 2.5/3.5
-- evidence remains truthful, immutable, replayable, and billable at the rate
-- captured when it was created.

-- ---------------------------------------------------------------------------
-- Immutable writing evidence: broaden historical allowlists, then keep the
-- INSERT boundary pinned to the currently available model.
-- ---------------------------------------------------------------------------

alter table app_private.writing_feedback_adjudications_v2
  drop constraint if exists writing_feedback_adjudications_v2_critic_shape_check,
  drop constraint if exists writing_feedback_adjudications_v2_decision_shape_check,
  drop constraint if exists writing_feedback_adjudications_v2_final_critic_shape_check,
  drop constraint if exists writing_feedback_adjudications_v2_generator_model_check;

alter table app_private.writing_feedback_adjudications_v2
  add constraint writing_feedback_adjudications_v2_generator_model_check check (
    (
      generator_provider = 'deepseek'
      and generator_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
    )
    or (
      generator_provider = 'gemini'
      and generator_model in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
    )
  ),
  add constraint writing_feedback_adjudications_v2_critic_shape_check check (
    coalesce((
      (
        critic_provider is null
        and critic_model is null
        and critic_verdict is null
        and critic_decision_sha256 is null
      )
      or (
        critic_provider = 'gemini'
        and critic_model in (
          'gemini-2.5-flash',
          'gemini-3.5-flash',
          'gemini-3.1-flash-lite'
        )
      )
      or (
        critic_provider = 'deepseek'
        and critic_model = 'deepseek-v4-pro'
      )
    ), false)
  ),
  add constraint writing_feedback_adjudications_v2_final_critic_shape_check
  check (
    coalesce((
      (
        final_critic_provider is null
        and final_critic_model is null
        and final_critic_verdict is null
        and final_critic_decision_sha256 is null
      )
      or (
        final_critic_provider = 'gemini'
        and final_critic_model in (
          'gemini-3.5-flash',
          'gemini-3.1-flash-lite'
        )
      )
    ), false)
  ),
  add constraint writing_feedback_adjudications_v2_decision_shape_check check (
    coalesce((
      (
        decision = 'system_hold'
        and reason_code not in (
          'critic_approved',
          'final_critic_approved',
          'recovery_critic_approved'
        )
        and accepted_provider is null
        and accepted_model is null
      )
      or (
        decision = 'accepted_model_feedback'
        and candidate_feedback_sha256 is not null
        and candidate_release_sha256 is not null
        and (
          (
            reason_code = 'critic_approved'
            and generator_provider = 'deepseek'
            and accepted_provider = 'deepseek'
            and accepted_model = generator_model
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'gemini'
            and critic_model in (
              'gemini-2.5-flash',
              'gemini-3.5-flash',
              'gemini-3.1-flash-lite'
            )
            and critic_verdict = 'approved'
            and critic_decision_sha256 is not null
            and adjudicator_provider is null
            and adjudicator_model is null
            and adjudicator_verdict is null
            and adjudicator_decision_sha256 is null
            and resolved_feedback_sha256 is null
            and final_critic_provider is null
            and final_critic_model is null
            and final_critic_verdict is null
            and final_critic_decision_sha256 is null
          )
          or (
            reason_code = 'final_critic_approved'
            and generator_provider = 'deepseek'
            and generator_model = 'deepseek-v4-flash'
            and accepted_provider = 'deepseek'
            and accepted_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
            and critic_provider = 'gemini'
            and critic_model in (
              'gemini-2.5-flash',
              'gemini-3.5-flash',
              'gemini-3.1-flash-lite'
            )
            and critic_verdict in ('disagreed', 'uncertain')
            and critic_decision_sha256 is not null
            and adjudicator_provider = 'deepseek'
            and adjudicator_model = 'deepseek-v4-pro'
            and adjudicator_verdict = 'resolved'
            and adjudicator_decision_sha256 is not null
            and resolved_feedback_sha256 is not null
            and final_critic_provider = 'gemini'
            and final_critic_model in (
              'gemini-3.5-flash',
              'gemini-3.1-flash-lite'
            )
            and final_critic_verdict = 'approved'
            and final_critic_decision_sha256 is not null
            and (
              (
                accepted_model = 'deepseek-v4-flash'
                and resolved_feedback_sha256 = candidate_feedback_sha256
                and final_feedback_sha256 = candidate_release_sha256
              )
              or (
                accepted_model = 'deepseek-v4-pro'
                and resolved_feedback_sha256 <> candidate_feedback_sha256
                and final_feedback_sha256 <> candidate_release_sha256
              )
            )
          )
          or (
            reason_code = 'recovery_critic_approved'
            and generator_provider = 'gemini'
            and generator_model in (
              'gemini-3.5-flash',
              'gemini-3.1-flash-lite'
            )
            and accepted_provider = 'gemini'
            and accepted_model = generator_model
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'deepseek'
            and critic_model = 'deepseek-v4-pro'
            and critic_verdict = 'approved'
            and critic_decision_sha256 is not null
            and adjudicator_provider is null
            and adjudicator_model is null
            and adjudicator_verdict is null
            and adjudicator_decision_sha256 is null
            and resolved_feedback_sha256 is null
            and final_critic_provider is null
            and final_critic_model is null
            and final_critic_verdict is null
            and final_critic_decision_sha256 is null
          )
        )
      )
    ), false)
  );

create or replace function app_private.enforce_current_writing_critic_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.generator_provider = 'gemini'
    and new.generator_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_generator_model_retired';
  end if;
  if new.critic_provider = 'gemini'
    and new.critic_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_critic_model_retired';
  end if;
  if new.final_critic_provider = 'gemini'
    and new.final_critic_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_final_critic_model_retired';
  end if;
  if new.accepted_provider = 'gemini'
    and new.accepted_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_accepted_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_current_writing_critic_insert()
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Immutable worksheet completion and rejected-stage evidence.
-- ---------------------------------------------------------------------------

alter table app_private.worksheet_generation_completions_v2
  drop constraint if exists worksheet_generation_completions_v2_shape_check;

alter table app_private.worksheet_generation_completions_v2
  add constraint worksheet_generation_completions_v2_shape_check check (
    (
      completion_mode = 'reuse'
      and provider_source is null
      and generator_model is null
      and primary_critic_provider is null
      and primary_critic_model is null
      and primary_verdict_sha256 is null
      and secondary_critic_provider is null
      and secondary_critic_model is null
      and secondary_verdict_sha256 is null
      and candidate_sha256 is null
      and provider_metadata is null
    )
    or (
      completion_mode = 'generated'
      and (
        (provider_source = 'deepseek' and generator_model = 'deepseek-v4-pro')
        or (
          provider_source = 'gemini'
          and generator_model in (
            'gemini-3.5-flash',
            'gemini-3.1-flash-lite'
          )
        )
      )
      and primary_critic_provider = 'deepseek'
      and primary_critic_model = 'deepseek-v4-flash'
      and primary_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and secondary_critic_provider = 'gemini'
      and secondary_critic_model in (
        'gemini-2.5-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
      and secondary_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and candidate_sha256 ~ '^[a-f0-9]{64}$'
      and provider_metadata is not null
    )
  );

create or replace function app_private.enforce_current_worksheet_critic_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.completion_mode = 'generated'
    and new.provider_source = 'gemini'
    and new.generator_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_generator_model_retired';
  end if;
  if new.completion_mode = 'generated'
    and new.secondary_critic_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_secondary_critic_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_current_worksheet_critic_insert()
from public, anon, authenticated, service_role;

alter table app_private.worksheet_generation_stage_evidence
  drop constraint if exists worksheet_generation_stage_evidence_gemini_critic_model_check,
  drop constraint if exists worksheet_generation_stage_evidence_provider_model_check;

alter table app_private.worksheet_generation_stage_evidence
  add constraint worksheet_generation_stage_evidence_gemini_critic_model_check
  check (
    gemini_critic_model in (
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite'
    )
  ),
  add constraint worksheet_generation_stage_evidence_provider_model_check
  check (
    (
      candidate_provider = 'deepseek'
      and candidate_model = 'deepseek-v4-pro'
    )
    or (
      candidate_provider = 'gemini'
      and candidate_model in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Active worksheet checkpoints. Old 3.5 rows can finish or replay, while a
-- new candidate or newly persisted Gemini verdict must use 3.1 Flash Lite.
-- ---------------------------------------------------------------------------

alter table app_private.worksheet_generation_checkpoints
  drop constraint if exists worksheet_generation_checkpoints_provider_model_check,
  drop constraint if exists worksheet_generation_checkpoints_stage_shape_check;

alter table app_private.worksheet_generation_checkpoints
  add constraint worksheet_generation_checkpoints_provider_model_check check (
    candidate_provider is null
    or (
      candidate_provider = 'deepseek'
      and candidate_model = 'deepseek-v4-pro'
    )
    or (
      candidate_provider = 'gemini'
      and candidate_model in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
    )
  ),
  add constraint worksheet_generation_checkpoints_stage_shape_check check (
    (
      stage = 'primary_fallback_generation'
      and candidate_attempt = 1
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is null
      and completion_payload is null
      and fallback_primary_queue_message_id is not null
    )
    or (
      stage = 'primary_critique'
      and candidate_attempt = 1
      and candidate_provider is not null
      and candidate_model is not null
      and candidate_sha256 is not null
      and candidate is not null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'repair_generation'
      and candidate_attempt = 2
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'repair_critique'
      and candidate_attempt = 2
      and candidate_provider = 'gemini'
      and candidate_model in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
      and candidate_sha256 is not null
      and candidate is not null
      and completion_payload_sha256 is null
      and completion_payload is null
    )
    or (
      stage = 'completion'
      and candidate_provider is null
      and candidate_model is null
      and candidate_sha256 is null
      and candidate is null
      and completion_payload_sha256 is not null
      and completion_payload is not null
    )
  );

create or replace function app_private.enforce_current_worksheet_checkpoint_gemini()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.candidate_provider = 'gemini'
      and new.candidate_model is distinct from 'gemini-3.1-flash-lite'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_checkpoint_candidate_model_retired';
    end if;
    if new.gemini_critic_evidence is not null
      and new.gemini_critic_evidence ->> 'model'
        is distinct from 'gemini-3.1-flash-lite'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_checkpoint_critic_model_retired';
    end if;
  else
    if (
        new.candidate_provider is distinct from old.candidate_provider
        or new.candidate_model is distinct from old.candidate_model
        or new.candidate_sha256 is distinct from old.candidate_sha256
      )
      and new.candidate_provider = 'gemini'
      and new.candidate_model is distinct from 'gemini-3.1-flash-lite'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_checkpoint_candidate_model_retired';
    end if;
    if new.gemini_critic_evidence
        is distinct from old.gemini_critic_evidence
      and new.gemini_critic_evidence is not null
      and new.gemini_critic_evidence ->> 'model'
        is distinct from 'gemini-3.1-flash-lite'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_checkpoint_critic_model_retired';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function
  app_private.enforce_current_worksheet_checkpoint_gemini()
from public, anon, authenticated, service_role;

drop trigger if exists worksheet_generation_checkpoints_current_gemini
on app_private.worksheet_generation_checkpoints;
create trigger worksheet_generation_checkpoints_current_gemini
before insert or update of
  candidate_provider,
  candidate_model,
  candidate_sha256,
  gemini_critic_evidence
on app_private.worksheet_generation_checkpoints
for each row execute function
  app_private.enforce_current_worksheet_checkpoint_gemini();

create or replace function app_private.enforce_current_worksheet_stage_evidence_gemini()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.candidate_provider = 'gemini'
    and new.candidate_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_stage_candidate_model_retired';
  end if;
  if new.gemini_critic_model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_stage_critic_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.enforce_current_worksheet_stage_evidence_gemini()
from public, anon, authenticated, service_role;

drop trigger if exists worksheet_generation_stage_evidence_current_gemini
on app_private.worksheet_generation_stage_evidence;
create trigger worksheet_generation_stage_evidence_current_gemini
before insert on app_private.worksheet_generation_stage_evidence
for each row execute function
  app_private.enforce_current_worksheet_stage_evidence_gemini();

-- A succeeded fallback replay returns its immutable recorded event before it
-- reaches this INSERT boundary. Active fallbacks that persist newly rejected
-- Gemini candidates must use the currently available model.
create or replace function app_private.enforce_current_worksheet_rejection_model_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.provider = 'gemini'
    and new.model is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_rejection_model_retired';
  end if;
  if new.candidate #> '{validation,critics,gemini}' is not null
    and new.candidate #>> '{validation,critics,gemini,model}'
      is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_rejection_critic_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.enforce_current_worksheet_rejection_model_insert()
from public, anon, authenticated, service_role;

drop trigger if exists worksheet_generation_rejections_10_current_gemini
on app_private.worksheet_generation_rejections;
create trigger worksheet_generation_rejections_10_current_gemini
before insert on app_private.worksheet_generation_rejections
for each row execute function
  app_private.enforce_current_worksheet_rejection_model_insert();

-- ---------------------------------------------------------------------------
-- Preserve every existing validator/replay invariant while teaching the six
-- established functions the new truthful model identifier. Exact, counted
-- fragment guards make a drifted prerequisite fail the migration instead of
-- silently weakening validation logic.
-- ---------------------------------------------------------------------------

do $migration$
declare
  function_ddl text;
  old_fragment text;
  new_fragment text;
  actual_occurrences integer;
begin
  function_ddl := pg_get_functiondef(
    'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'
      ::regprocedure
  );
  old_fragment := $fragment$expected_provider = 'gemini'
        and expected_model = 'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$expected_provider = 'gemini'
        and expected_model in (
          'gemini-2.5-flash',
          'gemini-3.5-flash',
          'gemini-3.1-flash-lite'
        )$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_checkpoint_critic_validator_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);

  function_ddl := pg_get_functiondef(
    'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
  );
  old_fragment := $fragment$'gemini-2.5-flash',
    'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite'$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_dual_critic_validator_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);

  function_ddl := pg_get_functiondef(
    'app_private.normalize_worksheet_generation_provenance_v2(jsonb)'
      ::regprocedure
  );
  old_fragment := $fragment$if generator_model <> 'gemini-3.5-flash'
      or$fragment$;
  new_fragment := $fragment$if generator_model not in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )
      or$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_provenance_normalizer_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);

  function_ddl := pg_get_functiondef(
    'app_private.complete_certified_worksheet_bank_fallback(uuid,bigint,uuid,jsonb)'
      ::regprocedure
  );
  old_fragment := $fragment$rejected_candidate ->> 'provider' = 'gemini'
          and rejected_candidate ->> 'model' = 'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$rejected_candidate ->> 'provider' = 'gemini'
          and rejected_candidate ->> 'model' in (
            'gemini-3.5-flash',
            'gemini-3.1-flash-lite'
          )$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_bank_fallback_validator_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);

  function_ddl := pg_get_functiondef(
    'app_private.assert_worksheet_checkpoint_candidate(jsonb,smallint,text,text)'
      ::regprocedure
  );
  old_fragment := $fragment$source_name = 'gemini'
      and generator_model = 'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$source_name = 'gemini'
      and generator_model in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_checkpoint_candidate_allowlist_drift';
  end if;
  function_ddl := replace(function_ddl, old_fragment, new_fragment);
  old_fragment := $fragment$source_name <> 'gemini'
      or generator_model <> 'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$source_name <> 'gemini'
      or generator_model not in (
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite'
      )$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_checkpoint_repair_allowlist_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);

  function_ddl := pg_get_functiondef(
    'app_private.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'
      ::regprocedure
  );
  old_fragment := $fragment$candidate_payload ->> 'generation_source' <> 'gemini'
        or candidate_payload ->> 'generator_model' <> 'gemini-3.5-flash'$fragment$;
  new_fragment := $fragment$candidate_payload ->> 'generation_source' <> 'gemini'
        or candidate_payload ->> 'generator_model'
          <> 'gemini-3.1-flash-lite'$fragment$;
  actual_occurrences := (
    length(function_ddl) - length(replace(function_ddl, old_fragment, ''))
  ) / length(old_fragment);
  if actual_occurrences <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_lite_checkpoint_fallback_pin_drift';
  end if;
  execute replace(function_ddl, old_fragment, new_fragment);
end;
$migration$;

-- ---------------------------------------------------------------------------
-- Current cost contract. Retired-model policies and finalized reservations are
-- historical evidence and are never rewritten. The still-active Flash-Lite
-- answer policy is corrected to the official cached-input rate below while the
-- immutable-policy trigger is intentionally disabled.
-- ---------------------------------------------------------------------------

drop trigger if exists ai_model_cost_policies_immutable
on app_private.ai_model_cost_policies;

insert into app_private.ai_model_cost_policies (
  provider_name,
  model_name,
  call_purpose,
  input_rate_microusd_per_million,
  cached_input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  maximum_reservation_microusd
)
values
  (
    'gemini', 'gemini-3.1-flash-lite', 'writing_generation',
    250000, 25000, 1500000, 300000
  ),
  (
    'gemini', 'gemini-3.1-flash-lite', 'writing_critique',
    250000, 25000, 1500000, 150000
  ),
  (
    'gemini', 'gemini-3.1-flash-lite', 'writing_final_critique',
    250000, 25000, 1500000, 150000
  ),
  (
    'gemini', 'gemini-3.1-flash-lite', 'worksheet_generation',
    250000, 25000, 1500000, 200000
  ),
  (
    'gemini', 'gemini-3.1-flash-lite', 'worksheet_critique',
    250000, 25000, 1500000, 150000
  )
on conflict (provider_name, model_name, call_purpose) do nothing;

do $$
declare
  corrected_rows integer;
begin
  update app_private.ai_model_cost_policies policy
  set cached_input_rate_microusd_per_million = 25000
  where policy.provider_name = 'gemini'
    and policy.model_name = 'gemini-3.1-flash-lite'
    and policy.call_purpose = 'worksheet_answer_evaluation'
    and policy.input_rate_microusd_per_million = 250000
    and policy.cached_input_rate_microusd_per_million in (250000, 25000)
    and policy.output_rate_microusd_per_million = 1500000
    and policy.maximum_reservation_microusd = 50000;

  get diagnostics corrected_rows = row_count;
  if corrected_rows <> 1 then
    raise exception using
      errcode = '55000',
      message = 'gemini_flash_lite_answer_cost_policy_drift';
  end if;
end;
$$;

do $$
begin
  if (
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
  ) <> 5 then
    raise exception using
      errcode = '55000',
      message = 'gemini_flash_lite_cost_policy_drift';
  end if;
end;
$$;

create trigger ai_model_cost_policies_immutable
before insert or update or delete on app_private.ai_model_cost_policies
for each row execute function
  app_private.reject_ai_spend_evidence_mutation();

-- Retired-model cost policies remain immutable accounting evidence. They may
-- resolve an exact existing reservation replay, but they cannot authorize a
-- newly inserted Gemini reservation.
create or replace function app_private.enforce_current_ai_reservation_model_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.provider_name = 'gemini'
    and new.model_name is distinct from 'gemini-3.1-flash-lite'
  then
    raise exception using
      errcode = '22023',
      message = 'ai_spend_reservation_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.enforce_current_ai_reservation_model_insert()
from public, anon, authenticated, service_role;

drop trigger if exists ai_spend_reservations_10_current_gemini
on app_private.ai_spend_reservations;
create trigger ai_spend_reservations_10_current_gemini
before insert on app_private.ai_spend_reservations
for each row execute function
  app_private.enforce_current_ai_reservation_model_insert();

comment on table app_private.writing_feedback_adjudications_v2 is
  'Private immutable writing decisions. Historical Gemini 2.5/3.5 evidence remains valid; every new Gemini writing role is pinned to 3.1 Flash Lite.';
comment on table app_private.worksheet_generation_completions_v2 is
  'Immutable provider-neutral worksheet completion evidence. Historical Gemini 2.5/3.5 provenance remains valid; new Gemini generation and critique use 3.1 Flash Lite.';
comment on function app_private.assert_worksheet_critics_v2(jsonb) is
  'Validates hash-bound dual-provider worksheet evidence for historical Gemini 2.5/3.5 and current Gemini 3.1 Flash Lite verdicts.';

notify pgrst, 'reload schema';
