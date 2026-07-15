-- Resume a dual-critic worksheet pass without rebilling the critic that
-- already returned a complete, normalized verdict. Evidence remains bound to
-- one private job/assignment/generation/candidate tuple and never enters PGMQ
-- or a browser-readable schema.

alter table app_private.worksheet_generation_checkpoints
  add column deepseek_critic_evidence jsonb,
  add column gemini_critic_evidence jsonb;

create or replace function app_private.is_valid_worksheet_checkpoint_critic(
  evidence jsonb,
  expected_provider text,
  expected_model text,
  expected_candidate_sha256 text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  checks jsonb;
  reasons jsonb;
  all_checks_pass boolean;
  approved boolean;
begin
  if evidence is null
    or jsonb_typeof(evidence) <> 'object'
    or octet_length(evidence::text) > 16384
    or expected_provider is null
    or expected_model is null
    or expected_candidate_sha256 is null
    or expected_candidate_sha256 !~ '^[a-f0-9]{64}$'
    or not (
      (expected_provider = 'deepseek' and expected_model = 'deepseek-v4-flash')
      or (
        expected_provider = 'gemini'
        and expected_model = 'gemini-3.5-flash'
      )
    )
    or not (evidence ?& array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'rejection_reasons',
      'verdict_sha256'
    ])
    or evidence - array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'rejection_reasons',
      'verdict_sha256'
    ]::text[] <> '{}'::jsonb
    or evidence ->> 'provider' is distinct from expected_provider
    or evidence ->> 'model' is distinct from expected_model
    or evidence ->> 'candidate_sha256'
      is distinct from expected_candidate_sha256
    or coalesce(evidence ->> 'verdict_sha256', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(evidence -> 'approved') <> 'boolean'
    or jsonb_typeof(evidence -> 'checks') <> 'object'
    or jsonb_typeof(evidence -> 'rejection_reasons') <> 'array'
  then
    return false;
  end if;

  checks := evidence -> 'checks';
  reasons := evidence -> 'rejection_reasons';
  if not (checks ?& array[
      'ambiguity_free',
      'no_answer_leakage',
      'duplicate_free',
      'level_fit',
      'topic_fit',
      'type_balance',
      'scoring_safe'
    ])
    or checks - array[
      'ambiguity_free',
      'no_answer_leakage',
      'duplicate_free',
      'level_fit',
      'topic_fit',
      'type_balance',
      'scoring_safe'
    ]::text[] <> '{}'::jsonb
    or exists (
      select 1
      from jsonb_each(checks) check_item
      where jsonb_typeof(check_item.value) <> 'boolean'
    )
    or jsonb_array_length(reasons) > 4
    or exists (
      select 1
      from jsonb_array_elements(reasons) reason(item)
      where jsonb_typeof(reason.item) <> 'string'
        or length(btrim(reason.item #>> '{}')) not between 1 and 240
        or reason.item #>> '{}' is distinct from btrim(reason.item #>> '{}')
    )
    or (
      select count(*) <> count(distinct reason.item #>> '{}')
      from jsonb_array_elements(reasons) reason(item)
    )
  then
    return false;
  end if;

  approved := (evidence ->> 'approved')::boolean;
  all_checks_pass := (
    (checks ->> 'ambiguity_free')::boolean
    and (checks ->> 'no_answer_leakage')::boolean
    and (checks ->> 'duplicate_free')::boolean
    and (checks ->> 'level_fit')::boolean
    and (checks ->> 'topic_fit')::boolean
    and (checks ->> 'type_balance')::boolean
    and (checks ->> 'scoring_safe')::boolean
  );

  return approved = all_checks_pass
    and (
      (approved and jsonb_array_length(reasons) = 0)
      or (not approved and jsonb_array_length(reasons) between 1 and 4)
    )
    and evidence ->> 'verdict_sha256'
      = app_private.worksheet_critic_verdict_sha256(evidence);
exception when others then
  return false;
end;
$$;

revoke all on function app_private.is_valid_worksheet_checkpoint_critic(
  jsonb, text, text, text
) from public, anon, authenticated, service_role;

alter table app_private.worksheet_generation_checkpoints
  add constraint worksheet_generation_checkpoints_deepseek_critic_check check (
    deepseek_critic_evidence is null
    or app_private.is_valid_worksheet_checkpoint_critic(
      deepseek_critic_evidence,
      'deepseek',
      deepseek_critic_evidence ->> 'model',
      candidate_sha256
    )
  ),
  add constraint worksheet_generation_checkpoints_gemini_critic_check check (
    gemini_critic_evidence is null
    or app_private.is_valid_worksheet_checkpoint_critic(
      gemini_critic_evidence,
      'gemini',
      gemini_critic_evidence ->> 'model',
      candidate_sha256
    )
  ),
  add constraint worksheet_generation_checkpoints_partial_critic_stage_check
  check (
    (
      stage in ('primary_critique', 'repair_critique')
      and candidate_sha256 is not null
    )
    or (
      deepseek_critic_evidence is null
      and gemini_critic_evidence is null
    )
  );

create or replace function app_private.guard_worksheet_partial_critics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deepseek_critic_evidence is not null
    and new.deepseek_critic_evidence
      is distinct from old.deepseek_critic_evidence
    and new.stage in ('primary_critique', 'repair_critique')
    and new.candidate_sha256 is not distinct from old.candidate_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_evidence_immutable';
  end if;
  if old.gemini_critic_evidence is not null
    and new.gemini_critic_evidence
      is distinct from old.gemini_critic_evidence
    and new.stage in ('primary_critique', 'repair_critique')
    and new.candidate_sha256 is not distinct from old.candidate_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_evidence_immutable';
  end if;

  if old.stage in ('primary_critique', 'repair_critique')
    and new.stage = 'completion'
  then
    if old.deepseek_critic_evidence is null
      or old.gemini_critic_evidence is null
      or new.completion_payload #> '{validation,critics,deepseek}'
        is distinct from old.deepseek_critic_evidence
      or new.completion_payload #> '{validation,critics,gemini}'
        is distinct from old.gemini_critic_evidence
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_dual_critic_evidence_required';
    end if;
  end if;

  if old.stage = 'primary_critique' and new.stage = 'repair_generation' then
    if old.deepseek_critic_evidence is null
      or old.gemini_critic_evidence is null
      or not exists (
        select 1
        from app_private.worksheet_generation_stage_evidence evidence
        where evidence.job_id = old.job_id
          and evidence.assignment_id = old.assignment_id
          and evidence.entity_version = old.entity_version
          and evidence.candidate_sha256 = old.candidate_sha256
          and evidence.rejected_candidate #> '{validation,critics,deepseek}'
            = old.deepseek_critic_evidence
          and evidence.rejected_candidate #> '{validation,critics,gemini}'
            = old.gemini_critic_evidence
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_dual_critic_evidence_required';
    end if;
  end if;

  if new.stage not in ('primary_critique', 'repair_critique')
    or new.candidate_sha256 is distinct from old.candidate_sha256
    or new.candidate_attempt is distinct from old.candidate_attempt
    or new.entity_version is distinct from old.entity_version
  then
    new.deepseek_critic_evidence := null;
    new.gemini_critic_evidence := null;
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_partial_critics()
from public, anon, authenticated, service_role;

create trigger worksheet_generation_checkpoints_guard_partial_critics
before update on app_private.worksheet_generation_checkpoints
for each row execute function app_private.guard_worksheet_partial_critics();

drop function if exists api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
);
drop function if exists app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
);

create function app_private.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  fallback_failure_code text,
  primary_rejection jsonb,
  deepseek_critic_evidence jsonb,
  gemini_critic_evidence jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  return query
  select
    checkpoint.job_id,
    checkpoint.assignment_id,
    checkpoint.entity_version,
    checkpoint.stage,
    checkpoint.candidate_attempt,
    checkpoint.candidate_provider,
    checkpoint.candidate_model,
    checkpoint.candidate_sha256,
    checkpoint.candidate,
    checkpoint.completion_payload,
    checkpoint.fallback_failure_code,
    case
      when evidence.job_id is null then null
      else jsonb_build_object(
        'attempt_number', evidence.candidate_attempt,
        'provider', evidence.candidate_provider,
        'model', evidence.candidate_model,
        'rejection_reasons', evidence.rejection_reasons,
        'candidate', evidence.rejected_candidate
      )
    end,
    checkpoint.deepseek_critic_evidence,
    checkpoint.gemini_critic_evidence
  from app_private.worksheet_generation_checkpoints checkpoint
  left join app_private.worksheet_generation_stage_evidence evidence
    on evidence.job_id = checkpoint.job_id
   and evidence.assignment_id = checkpoint.assignment_id
   and evidence.entity_version = checkpoint.entity_version
  where checkpoint.job_id = selected_job.id
    and checkpoint.assignment_id = selected_job.entity_id
    and checkpoint.entity_version = selected_job.entity_version;
end;
$$;

revoke all on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

create function api.get_worksheet_generation_checkpoint(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer
)
returns table (
  job_id uuid,
  assignment_id uuid,
  entity_version integer,
  stage text,
  candidate_attempt smallint,
  candidate_provider text,
  candidate_model text,
  candidate_sha256 text,
  candidate jsonb,
  completion_payload jsonb,
  fallback_failure_code text,
  primary_rejection jsonb,
  deepseek_critic_evidence jsonb,
  gemini_critic_evidence jsonb
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.get_worksheet_generation_checkpoint(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );
$$;

revoke all on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) from public, anon, authenticated;
grant execute on function api.get_worksheet_generation_checkpoint(
  uuid, bigint, uuid, integer
) to service_role;

create or replace function app_private.save_worksheet_generation_critic_evidence(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_candidate_attempt smallint,
  target_candidate_sha256 text,
  critic_provider text,
  critic_model text,
  target_verdict_sha256 text,
  verdict_payload jsonb,
  target_call_key text,
  target_provider_model_version text,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint
)
returns table (
  provider text,
  candidate_sha256 text,
  verdict_sha256 text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_checkpoint app_private.worksheet_generation_checkpoints%rowtype;
  spend_reservation app_private.ai_spend_reservations%rowtype;
  spend_finalization record;
  recorded_evidence jsonb;
  was_replayed boolean;
  expected_primary_call_key text;
  expected_retry_call_key text;
begin
  selected_job := app_private.assert_active_worksheet_generation_lease(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version
  );

  select checkpoint.*
  into selected_checkpoint
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id
  for update;

  if target_candidate_attempt is null
    or target_candidate_attempt not in (1, 2)
    or critic_provider is null
    or critic_provider not in ('deepseek', 'gemini')
    or coalesce(target_call_key, '') !~ '^[a-z][a-z0-9._:-]{0,104}$'
    or target_provider_model_version is distinct from critic_model
    or target_billed_input_tokens is null
    or target_billed_input_tokens not between 1 and 10000000
    or target_billed_output_tokens is null
    or target_billed_output_tokens not between 1 and 10000000
    or (
      (target_billed_cached_input_tokens is null) <>
      (target_billed_uncached_input_tokens is null)
    )
    or (
      target_billed_cached_input_tokens is not null
      and (
        target_billed_cached_input_tokens not between 0 and 10000000
        or target_billed_uncached_input_tokens not between 0 and 10000000
        or target_billed_cached_input_tokens +
          target_billed_uncached_input_tokens <> target_billed_input_tokens
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_critic_usage_invalid';
  end if;

  expected_primary_call_key :=
    'worksheet_generation:job_' || selected_job.id::text ||
    ':candidate_' || target_candidate_attempt::text || ':' ||
    critic_provider || ':critique';
  expected_retry_call_key := expected_primary_call_key || '_retry';
  if target_call_key is distinct from expected_primary_call_key
    and target_call_key is distinct from expected_retry_call_key
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_critic_usage_invalid';
  end if;

  if selected_checkpoint.job_id is null
    or selected_checkpoint.assignment_id <> selected_job.entity_id
    or selected_checkpoint.entity_version <> selected_job.entity_version
    or selected_checkpoint.stage not in ('primary_critique', 'repair_critique')
    or selected_checkpoint.candidate_attempt <> target_candidate_attempt
    or selected_checkpoint.candidate_sha256 <> target_candidate_sha256
    or not app_private.is_valid_worksheet_checkpoint_critic(
      verdict_payload,
      critic_provider,
      critic_model,
      target_candidate_sha256
    )
    or verdict_payload ->> 'verdict_sha256'
      is distinct from target_verdict_sha256
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_checkpoint_critic_evidence_invalid';
  end if;

  recorded_evidence := case critic_provider
    when 'deepseek' then selected_checkpoint.deepseek_critic_evidence
    when 'gemini' then selected_checkpoint.gemini_critic_evidence
    else null
  end;
  -- The exact critic reservation is locked only after the active job,
  -- assignment, and candidate checkpoint have been locked. Evidence and
  -- metered usage then cross one commit, so a lost RPC response can replay
  -- both idempotently without dispatching the provider again.
  select reservation.*
  into spend_reservation
  from app_private.ai_spend_reservations reservation
  where reservation.job_id = selected_job.id
    and reservation.entity_version = selected_job.entity_version
    and reservation.call_key =
      'attempt_' || selected_job.attempt_count::text || ':' || target_call_key
  for update;

  if spend_reservation.id is null
    or spend_reservation.provider_name <> critic_provider
    or spend_reservation.model_name <> critic_model
    or spend_reservation.call_purpose <> 'worksheet_critique'
    or spend_reservation.state not in ('reserved', 'finalized')
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_spend_mismatch';
  end if;

  was_replayed := recorded_evidence is not null;
  if (
      not was_replayed
      and spend_reservation.state is distinct from 'reserved'
    ) or (
      was_replayed
      and spend_reservation.state is distinct from 'finalized'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_spend_mismatch';
  end if;

  if recorded_evidence is not null then
    if recorded_evidence is distinct from verdict_payload then
      raise exception using
        errcode = '55000',
        message = 'worksheet_checkpoint_critic_evidence_replay_mismatch';
    end if;
  else
    update app_private.worksheet_generation_checkpoints checkpoint
    set
      deepseek_critic_evidence = case
        when critic_provider = 'deepseek' then verdict_payload
        else checkpoint.deepseek_critic_evidence
      end,
      gemini_critic_evidence = case
        when critic_provider = 'gemini' then verdict_payload
        else checkpoint.gemini_critic_evidence
      end
    where checkpoint.job_id = selected_job.id;
  end if;

  select case critic_provider
    when 'deepseek' then checkpoint.deepseek_critic_evidence
    when 'gemini' then checkpoint.gemini_critic_evidence
    else null
  end
  into recorded_evidence
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = selected_job.id;

  if recorded_evidence is distinct from verdict_payload then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_evidence_replay_mismatch';
  end if;

  select finalized.*
  into spend_finalization
  from app_private.finalize_ai_spend_reservation(
    spend_reservation.id,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens
  ) finalized;

  if spend_finalization.reservation_id is distinct from spend_reservation.id
    or spend_finalization.state is distinct from 'finalized'
    or spend_finalization.billed_input_tokens
      is distinct from target_billed_input_tokens
    or spend_finalization.billed_output_tokens
      is distinct from target_billed_output_tokens
    or spend_finalization.replayed is distinct from was_replayed
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_checkpoint_critic_spend_mismatch';
  end if;

  return query select
    critic_provider,
    target_candidate_sha256,
    target_verdict_sha256,
    was_replayed;
end;
$$;

revoke all on function app_private.save_worksheet_generation_critic_evidence(
  uuid, bigint, uuid, integer, smallint, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;

create or replace function api.save_worksheet_generation_critic_evidence(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  expected_entity_version integer,
  target_candidate_attempt smallint,
  target_candidate_sha256 text,
  critic_provider text,
  critic_model text,
  target_verdict_sha256 text,
  verdict_payload jsonb,
  target_call_key text,
  target_provider_model_version text,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint
)
returns table (
  provider text,
  candidate_sha256 text,
  verdict_sha256 text,
  replayed boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.save_worksheet_generation_critic_evidence(
    target_job_id,
    target_queue_message_id,
    worker_id,
    expected_entity_version,
    target_candidate_attempt,
    target_candidate_sha256,
    critic_provider,
    critic_model,
    target_verdict_sha256,
    verdict_payload,
    target_call_key,
    target_provider_model_version,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens
  );
$$;

revoke all on function api.save_worksheet_generation_critic_evidence(
  uuid, bigint, uuid, integer, smallint, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint
) from public, anon, authenticated;
grant execute on function api.save_worksheet_generation_critic_evidence(
  uuid, bigint, uuid, integer, smallint, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint
) to service_role;

comment on function api.save_worksheet_generation_critic_evidence(
  uuid, bigint, uuid, integer, smallint, text, text, text, text, jsonb,
  text, text, bigint, bigint, bigint, bigint
) is
  'Service-only exact-lease atomic checkpoint and spend finalizer for one immutable normalized worksheet critic verdict; the other independent critic remains mandatory.';

comment on column
  app_private.worksheet_generation_checkpoints.deepseek_critic_evidence is
  'Private immutable DeepSeek critic evidence bound to the current candidate hash and generation version.';
comment on column
  app_private.worksheet_generation_checkpoints.gemini_critic_evidence is
  'Private immutable Gemini critic evidence bound to the current candidate hash and generation version.';

notify pgrst, 'reload schema';
