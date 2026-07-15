-- Phase 12W: Gemini 3 critic compatibility.
--
-- The current Gemini project accepts the stable Gemini 3.5 Flash endpoint but
-- does not expose Gemini 2.5 Flash. New writing and worksheet critiques are
-- therefore pinned to Gemini 3.5 Flash in application code. Historical 2.5
-- evidence remains valid and immutable so completed jobs retain truthful
-- provenance and idempotent replay behavior.

-- Preserve historical writing evidence while accepting the current critic.
alter table app_private.writing_feedback_adjudications_v2
  drop constraint if exists writing_feedback_adjudications_v2_critic_shape_check,
  drop constraint if exists writing_feedback_adjudications_v2_decision_shape_check;

alter table app_private.writing_feedback_adjudications_v2
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
        and critic_model in ('gemini-2.5-flash', 'gemini-3.5-flash')
      )
      or (
        critic_provider = 'deepseek'
        and critic_model = 'deepseek-v4-pro'
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
            and critic_model in ('gemini-2.5-flash', 'gemini-3.5-flash')
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
            and critic_model in ('gemini-2.5-flash', 'gemini-3.5-flash')
            and critic_verdict in ('disagreed', 'uncertain')
            and critic_decision_sha256 is not null
            and adjudicator_provider = 'deepseek'
            and adjudicator_model = 'deepseek-v4-pro'
            and adjudicator_verdict = 'resolved'
            and adjudicator_decision_sha256 is not null
            and resolved_feedback_sha256 is not null
            and final_critic_provider = 'gemini'
            and final_critic_model = 'gemini-3.5-flash'
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
            and generator_model = 'gemini-3.5-flash'
            and accepted_provider = 'gemini'
            and accepted_model = 'gemini-3.5-flash'
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

-- Old rows remain valid, but every newly inserted Gemini-backed writing
-- decision must use the current pinned critic. A trigger separates immutable
-- historical compatibility from the live write contract without relying on a
-- wall-clock cutoff.
create or replace function app_private.enforce_current_writing_critic_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.critic_provider = 'gemini'
    and new.critic_model is distinct from 'gemini-3.5-flash'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_adjudication_critic_model_retired';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_current_writing_critic_insert()
from public, anon, authenticated, service_role;

drop trigger if exists writing_feedback_adjudications_v2_current_critic
on app_private.writing_feedback_adjudications_v2;
create trigger writing_feedback_adjudications_v2_current_critic
before insert on app_private.writing_feedback_adjudications_v2
for each row execute function
  app_private.enforce_current_writing_critic_insert();

-- Existing worksheet completions truthfully retain their 2.5 provenance.
-- New completions persist the exact allowlisted Gemini critic model embedded in
-- their independently validated evidence.
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
          and generator_model = 'gemini-3.5-flash'
        )
      )
      and primary_critic_provider = 'deepseek'
      and primary_critic_model = 'deepseek-v4-flash'
      and primary_verdict_sha256 ~ '^[a-f0-9]{64}$'
      and secondary_critic_provider = 'gemini'
      and secondary_critic_model in ('gemini-2.5-flash', 'gemini-3.5-flash')
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
    and new.secondary_critic_model is distinct from 'gemini-3.5-flash'
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

drop trigger if exists worksheet_generation_completions_v2_current_critic
on app_private.worksheet_generation_completions_v2;
create trigger worksheet_generation_completions_v2_current_critic
before insert on app_private.worksheet_generation_completions_v2
for each row execute function
  app_private.enforce_current_worksheet_critic_insert();

create or replace function app_private.assert_worksheet_critics_v2(
  worksheet jsonb
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  validation_metadata jsonb;
  critics jsonb;
  deepseek_critic jsonb;
  gemini_critic jsonb;
  gemini_critic_model text;
  candidate_sha256 text;
  expected_check boolean;
  expected_approved boolean;
  check_name text;
begin
  if worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or worksheet ->> 'mode' is distinct from 'generated'
    or jsonb_typeof(worksheet -> 'validation') <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  validation_metadata := worksheet -> 'validation';
  if not (validation_metadata ?& array[
      'deterministic',
      'independent_model',
      'critic_model',
      'candidate_sha256',
      'critics',
      'attempt_count',
      'checks',
      'rejection_reasons'
    ])
    or validation_metadata - array[
      'deterministic',
      'independent_model',
      'critic_model',
      'candidate_sha256',
      'critics',
      'attempt_count',
      'checks',
      'rejection_reasons'
    ]::text[] <> '{}'::jsonb
    or validation_metadata -> 'deterministic' is distinct from 'true'::jsonb
    or jsonb_typeof(validation_metadata -> 'independent_model') <> 'boolean'
    or validation_metadata ->> 'critic_model'
      is distinct from 'deepseek-v4-flash'
    or coalesce(validation_metadata ->> 'candidate_sha256', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(validation_metadata ->> 'attempt_count', '') not in ('1', '2')
    or jsonb_typeof(validation_metadata -> 'critics') <> 'object'
    or jsonb_typeof(validation_metadata -> 'checks') <> 'object'
    or jsonb_typeof(validation_metadata -> 'rejection_reasons') <> 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  candidate_sha256 := validation_metadata ->> 'candidate_sha256';
  if candidate_sha256 <> app_private.worksheet_candidate_sha256(worksheet) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_candidate_hash_mismatch';
  end if;

  critics := validation_metadata -> 'critics';
  if not (critics ?& array['deepseek', 'gemini'])
    or critics - array['deepseek', 'gemini']::text[] <> '{}'::jsonb
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  deepseek_critic := critics -> 'deepseek';
  gemini_critic := critics -> 'gemini';
  gemini_critic_model := gemini_critic ->> 'model';
  if coalesce(gemini_critic_model, '') not in (
    'gemini-2.5-flash',
    'gemini-3.5-flash'
  ) then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  perform app_private.assert_worksheet_critic_verdict(
    deepseek_critic,
    'deepseek',
    'deepseek-v4-flash',
    candidate_sha256
  );
  perform app_private.assert_worksheet_critic_verdict(
    gemini_critic,
    'gemini',
    gemini_critic_model,
    candidate_sha256
  );

  if (select count(*) from jsonb_object_keys(validation_metadata -> 'checks'))
      <> 7
    or exists (
      select 1
      from jsonb_each(validation_metadata -> 'checks') check_entry(key, value)
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
    or validation_metadata -> 'rejection_reasons' is distinct from (
      (deepseek_critic -> 'rejection_reasons') ||
      (gemini_critic -> 'rejection_reasons')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;

  foreach check_name in array array[
    'ambiguity_free',
    'no_answer_leakage',
    'duplicate_free',
    'level_fit',
    'topic_fit',
    'type_balance',
    'scoring_safe'
  ]
  loop
    expected_check :=
      (deepseek_critic #>> array['checks', check_name])::boolean and
      (gemini_critic #>> array['checks', check_name])::boolean;
    if validation_metadata #> array['checks', check_name]
      is distinct from to_jsonb(expected_check)
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_dual_critic_validation_invalid';
    end if;
  end loop;

  expected_approved :=
    (deepseek_critic ->> 'approved')::boolean and
    (gemini_critic ->> 'approved')::boolean;
  if (validation_metadata ->> 'independent_model')::boolean
      is distinct from expected_approved
    or (
      expected_approved
      and jsonb_array_length(validation_metadata -> 'rejection_reasons') <> 0
    )
    or (
      not expected_approved
      and jsonb_array_length(validation_metadata -> 'rejection_reasons') = 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_validation_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_worksheet_critics_v2(jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_worksheet_critics_v2(jsonb)
to service_role;

create or replace function app_private.assert_or_record_worksheet_generation_completion_v2(
  target_job_id uuid,
  target_practice_test_id uuid,
  worksheet jsonb,
  completion_was_succeeded boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_mode text;
  expected_source text;
  expected_generator_model text;
  expected_secondary_critic_model text;
  expected_metadata jsonb;
  expected_payload_sha256 text;
  current_content_sha256 text;
  recorded app_private.worksheet_generation_completions_v2%rowtype;
begin
  perform app_private.assert_service_role();
  expected_mode := worksheet ->> 'mode';

  if worksheet is null
    or coalesce(expected_mode, '') not in ('generated', 'reuse')
    or target_practice_test_id is null
    or completion_was_succeeded is null
  then
    raise exception using
      errcode = '22023',
      message = 'Generated worksheet completion fingerprint is invalid.';
  end if;

  if expected_mode = 'generated' then
    perform app_private.assert_worksheet_critics_v2(worksheet);
    expected_source := worksheet ->> 'generation_source';
    expected_generator_model := worksheet ->> 'generator_model';
    expected_secondary_critic_model :=
      worksheet #>> '{validation,critics,gemini,model}';
    expected_metadata := jsonb_build_object(
      'schema_version', 2,
      'source_mix', worksheet -> 'source_mix',
      'validation', worksheet -> 'validation'
    );
  end if;

  expected_payload_sha256 :=
    app_private.worksheet_generation_payload_sha256(worksheet);

  select app_private.practice_test_content_sha256(test.id)
  into current_content_sha256
  from public.practice_tests test
  where test.id = target_practice_test_id
    and (
      expected_mode <> 'generated'
      or (
        test.generation_job_id = target_job_id
        and test.generation_source = expected_source
        and test.generator_model = expected_generator_model
        and test.generation_metadata = expected_metadata
      )
    )
  for share;

  if not found or current_content_sha256 is null then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion replay does not match persisted result.';
  end if;

  select completion.*
  into recorded
  from app_private.worksheet_generation_completions_v2 completion
  where completion.job_id = target_job_id
  for update;

  if completion_was_succeeded then
    if recorded.job_id is null
      or recorded.practice_test_id <> target_practice_test_id
      or recorded.completion_mode <> expected_mode
      or recorded.provider_source is distinct from expected_source
      or recorded.generator_model is distinct from expected_generator_model
      or recorded.provider_metadata is distinct from expected_metadata
      or recorded.payload_sha256 <> expected_payload_sha256
      or recorded.content_sha256 <> current_content_sha256
      or recorded.primary_critic_provider is distinct from (case
        when expected_mode = 'generated' then 'deepseek' else null end)
      or recorded.primary_critic_model is distinct from (case
        when expected_mode = 'generated' then 'deepseek-v4-flash' else null end)
      or recorded.primary_verdict_sha256 is distinct from
        worksheet #>> '{validation,critics,deepseek,verdict_sha256}'
      or recorded.secondary_critic_provider is distinct from (case
        when expected_mode = 'generated' then 'gemini' else null end)
      or recorded.secondary_critic_model is distinct from (case
        when expected_mode = 'generated'
          then expected_secondary_critic_model else null end)
      or recorded.secondary_verdict_sha256 is distinct from
        worksheet #>> '{validation,critics,gemini,verdict_sha256}'
      or recorded.candidate_sha256 is distinct from
        worksheet #>> '{validation,candidate_sha256}'
    then
      raise exception using
        errcode = '55000',
        message = 'Worksheet completion replay does not match persisted result.';
    end if;
    return;
  end if;

  if recorded.job_id is not null then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion replay does not match persisted result.';
  end if;

  insert into app_private.worksheet_generation_completions_v2 (
    job_id, practice_test_id, completion_mode, evidence_version,
    provider_source, generator_model, primary_critic_provider,
    primary_critic_model, primary_verdict_sha256,
    secondary_critic_provider, secondary_critic_model,
    secondary_verdict_sha256, candidate_sha256, provider_metadata,
    payload_sha256, content_sha256
  ) values (
    target_job_id,
    target_practice_test_id,
    expected_mode,
    2,
    expected_source,
    expected_generator_model,
    case when expected_mode = 'generated' then 'deepseek' else null end,
    case when expected_mode = 'generated' then 'deepseek-v4-flash' else null end,
    worksheet #>> '{validation,critics,deepseek,verdict_sha256}',
    case when expected_mode = 'generated' then 'gemini' else null end,
    case when expected_mode = 'generated'
      then expected_secondary_critic_model else null end,
    worksheet #>> '{validation,critics,gemini,verdict_sha256}',
    worksheet #>> '{validation,candidate_sha256}',
    expected_metadata,
    expected_payload_sha256,
    current_content_sha256
  );
end;
$$;

revoke all on function
  app_private.assert_or_record_worksheet_generation_completion_v2(
    uuid, uuid, jsonb, boolean
  ) from public, anon, authenticated, service_role;
grant execute on function
  app_private.assert_or_record_worksheet_generation_completion_v2(
    uuid, uuid, jsonb, boolean
  ) to service_role;

-- Cost policy rows are append-only accounting evidence. Keep the old rows for
-- finalized reservations and add the current model/purpose pairs atomically.
drop trigger if exists ai_model_cost_policies_immutable
on app_private.ai_model_cost_policies;

insert into app_private.ai_model_cost_policies (
  provider_name,
  model_name,
  call_purpose,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  maximum_reservation_microusd
)
values
  ('gemini', 'gemini-3.5-flash', 'writing_critique',
    1500000, 9000000, 150000),
  ('gemini', 'gemini-3.5-flash', 'worksheet_critique',
    1500000, 9000000, 150000)
on conflict (provider_name, model_name, call_purpose) do nothing;

do $$
begin
  if (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.5-flash'
      and policy.call_purpose in ('writing_critique', 'worksheet_critique')
      and policy.input_rate_microusd_per_million = 1500000
      and policy.output_rate_microusd_per_million = 9000000
      and policy.maximum_reservation_microusd = 150000
  ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'gemini_3_critic_cost_policy_drift';
  end if;
end;
$$;

create trigger ai_model_cost_policies_immutable
before insert or update or delete on app_private.ai_model_cost_policies
for each row execute function app_private.reject_ai_spend_evidence_mutation();

comment on table app_private.ai_spend_global_policy is
  'Singleton USD 225 monthly hard cap and emergency stop. No browser or service role may mutate it directly.';
comment on function app_private.assert_worksheet_critics_v2(jsonb) is
  'Validates exact dual-provider worksheet evidence. Historical Gemini 2.5 and current Gemini 3.5 critic provenance remain independently hash bound.';
comment on table app_private.writing_feedback_adjudications_v2 is
  'Private immutable writing decisions. Historical Gemini 2.5 and current Gemini 3.5 critic provenance remain valid; only released versions may reach public materialization.';
