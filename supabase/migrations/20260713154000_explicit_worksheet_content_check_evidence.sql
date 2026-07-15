-- Preserve every mandatory worksheet content attestation as first-class,
-- hash-bound evidence. The prior compatibility bridge folded these three
-- booleans into topic_fit/scoring_safe, which made the durable record lossy
-- and prevented the model-validated cache from independently rechecking them.

-- This is the contract side of a coordinated DB/worker rollout. Holding both
-- write boundaries prevents a new worksheet job or checkpoint from appearing
-- between the quiet-window proof and the validator replacement. Recovery
-- consumers must remain paused until the matching Edge worker is deployed.
begin;

lock table app_private.async_jobs,
  app_private.worksheet_generation_checkpoints
in share row exclusive mode;

do $$
begin
  if exists (
    select 1
    from app_private.async_jobs job
    where job.job_kind = 'worksheet_generation'
      and job.status in ('queued', 'processing', 'retry')
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_content_evidence_quiet_window_required';
  end if;
end;
$$;

create or replace function app_private.assert_worksheet_critic_verdict(
  critic jsonb,
  expected_provider text,
  expected_model text,
  expected_candidate_sha256 text
)
returns void
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  check_name text;
  content_check_name text;
  all_checks_pass boolean := true;
  approved boolean;
begin
  if jsonb_typeof(critic) <> 'object'
    or not (critic ?& array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'content_checks',
      'rejection_reasons',
      'verdict_sha256'
    ])
    or critic - array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'content_checks',
      'rejection_reasons',
      'verdict_sha256'
    ]::text[] <> '{}'::jsonb
    or critic ->> 'provider' is distinct from expected_provider
    or critic ->> 'model' is distinct from expected_model
    or critic ->> 'candidate_sha256' is distinct from expected_candidate_sha256
    or jsonb_typeof(critic -> 'approved') <> 'boolean'
    or jsonb_typeof(critic -> 'checks') <> 'object'
    or jsonb_typeof(critic -> 'content_checks') <> 'object'
    or jsonb_typeof(critic -> 'rejection_reasons') <> 'array'
    or coalesce(critic ->> 'verdict_sha256', '') !~ '^[a-f0-9]{64}$'
    or critic ->> 'verdict_sha256' <>
      app_private.worksheet_critic_verdict_sha256(critic)
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
  end if;

  if (select count(*) from jsonb_object_keys(critic -> 'checks')) <> 7
    or exists (
      select 1
      from jsonb_each(critic -> 'checks') check_entry(key, value)
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
    or (select count(*) from jsonb_object_keys(critic -> 'content_checks')) <> 3
    or exists (
      select 1
      from jsonb_each(critic -> 'content_checks') check_entry(key, value)
      where check_entry.key not in (
        'mini_lesson_scope_accurate',
        'learner_cues_semantically_aligned',
        'examples_rubrics_consistent'
      )
        or jsonb_typeof(check_entry.value) <> 'boolean'
    )
    or jsonb_array_length(critic -> 'rejection_reasons') > 4
    or exists (
      select 1
      from jsonb_array_elements(critic -> 'rejection_reasons') reason(value)
      where jsonb_typeof(reason.value) <> 'string'
        or length(btrim(reason.value #>> '{}')) not between 1 and 240
        or reason.value #>> '{}' is distinct from btrim(reason.value #>> '{}')
    )
    or (
      select count(*) <> count(distinct reason.value #>> '{}')
      from jsonb_array_elements(critic -> 'rejection_reasons') reason(value)
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
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
    all_checks_pass := all_checks_pass and
      (critic #>> array['checks', check_name])::boolean;
  end loop;

  foreach content_check_name in array array[
    'mini_lesson_scope_accurate',
    'learner_cues_semantically_aligned',
    'examples_rubrics_consistent'
  ]
  loop
    all_checks_pass := all_checks_pass and
      (critic #>> array['content_checks', content_check_name])::boolean;
  end loop;

  approved := (critic ->> 'approved')::boolean;
  if approved is distinct from all_checks_pass
    or (approved and jsonb_array_length(critic -> 'rejection_reasons') <> 0)
    or (
      not approved
      and jsonb_array_length(critic -> 'rejection_reasons') = 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_dual_critic_evidence_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_worksheet_critic_verdict(
  jsonb, text, text, text
)
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_worksheet_critic_verdict(
  jsonb, text, text, text
)
to service_role;

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
  content_checks jsonb;
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
        and expected_model in (
          'gemini-2.5-flash',
          'gemini-3.5-flash',
          'gemini-3.1-flash-lite'
        )
      )
    )
    or not (evidence ?& array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'content_checks',
      'rejection_reasons',
      'verdict_sha256'
    ])
    or evidence - array[
      'provider',
      'model',
      'candidate_sha256',
      'approved',
      'checks',
      'content_checks',
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
    or jsonb_typeof(evidence -> 'content_checks') <> 'object'
    or jsonb_typeof(evidence -> 'rejection_reasons') <> 'array'
  then
    return false;
  end if;

  checks := evidence -> 'checks';
  content_checks := evidence -> 'content_checks';
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
    or not (content_checks ?& array[
      'mini_lesson_scope_accurate',
      'learner_cues_semantically_aligned',
      'examples_rubrics_consistent'
    ])
    or content_checks - array[
      'mini_lesson_scope_accurate',
      'learner_cues_semantically_aligned',
      'examples_rubrics_consistent'
    ]::text[] <> '{}'::jsonb
    or exists (
      select 1 from jsonb_each(checks) check_item
      where jsonb_typeof(check_item.value) <> 'boolean'
    )
    or exists (
      select 1 from jsonb_each(content_checks) check_item
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
    and (content_checks ->> 'mini_lesson_scope_accurate')::boolean
    and (content_checks ->> 'learner_cues_semantically_aligned')::boolean
    and (content_checks ->> 'examples_rubrics_consistent')::boolean
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
  content_check_name text;
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
      'content_checks',
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
      'content_checks',
      'rejection_reasons'
    ]::text[] <> '{}'::jsonb
    or validation_metadata -> 'deterministic' is distinct from 'true'::jsonb
    or jsonb_typeof(validation_metadata -> 'independent_model') <> 'boolean'
    or validation_metadata ->> 'critic_model'
      is distinct from 'deepseek-v4-flash'
    or coalesce(validation_metadata ->> 'candidate_sha256', '')
      !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(validation_metadata -> 'attempt_count') <> 'number'
    or coalesce(validation_metadata ->> 'attempt_count', '') not in ('1', '2')
    or jsonb_typeof(validation_metadata -> 'critics') <> 'object'
    or jsonb_typeof(validation_metadata -> 'checks') <> 'object'
    or jsonb_typeof(validation_metadata -> 'content_checks') <> 'object'
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
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite'
  )
  then
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
    or (
      select count(*)
      from jsonb_object_keys(validation_metadata -> 'content_checks')
    ) <> 3
    or exists (
      select 1
      from jsonb_each(
        validation_metadata -> 'content_checks'
      ) check_entry(key, value)
      where check_entry.key not in (
        'mini_lesson_scope_accurate',
        'learner_cues_semantically_aligned',
        'examples_rubrics_consistent'
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

  foreach content_check_name in array array[
    'mini_lesson_scope_accurate',
    'learner_cues_semantically_aligned',
    'examples_rubrics_consistent'
  ]
  loop
    expected_check :=
      (
        deepseek_critic #>> array['content_checks', content_check_name]
      )::boolean and
      (
        gemini_critic #>> array['content_checks', content_check_name]
      )::boolean;
    if validation_metadata #> array['content_checks', content_check_name]
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

comment on function app_private.assert_worksheet_critic_verdict(
  jsonb, text, text, text
) is
  'Requires exact hash-bound ordinary and content-quality checks for one worksheet critic verdict.';
comment on function app_private.is_valid_worksheet_checkpoint_critic(
  jsonb, text, text, text
) is
  'Fail-closed checkpoint predicate for exact ordinary and content-quality critic evidence.';
comment on function app_private.assert_worksheet_critics_v2(jsonb) is
  'Requires DeepSeek and Gemini verdicts plus exact aggregate ordinary and content-quality checks before generated worksheet completion.';

commit;
