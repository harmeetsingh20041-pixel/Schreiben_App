begin;

select plan(20);

select is(
  (
    with constraint_definition as (
      select pg_get_constraintdef(constraint_row.oid) as value
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.writing_feedback_adjudications_v2'::regclass
        and constraint_row.conname =
          'writing_feedback_adjudications_v2_reason_code_check'
    )
    select count(*)
    from constraint_definition,
      unnest(array[
        'critic_approved',
        'final_critic_approved',
        'recovery_critic_approved',
        'critic_advisory_unavailable',
        'pro_authority_accepted',
        'adjudicator_resolved',
        'generator_not_configured',
        'generator_authentication_failed',
        'generator_not_primary',
        'generator_invalid',
        'critic_not_configured',
        'critic_authentication_failed',
        'critic_invalid',
        'critic_hash_mismatch',
        'critic_disagreed',
        'critic_uncertain',
        'adjudicator_not_configured',
        'adjudicator_authentication_failed',
        'adjudicator_invalid',
        'adjudicator_hash_mismatch',
        'adjudicator_unresolved',
        'final_critic_not_configured',
        'final_critic_authentication_failed',
        'final_critic_invalid',
        'final_critic_hash_mismatch',
        'final_critic_disagreed',
        'final_critic_uncertain'
      ]) expected_reason(reason_code)
    where position(
      quote_literal(expected_reason.reason_code)
      in constraint_definition.value
    ) > 0
  ),
  27::bigint,
  'the reason allowlist preserves every existing reason and adds three authority reasons'
);

select is(
  (
    with constraint_definition as (
      select pg_get_constraintdef(constraint_row.oid) as value
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.writing_feedback_adjudications_v2'::regclass
        and constraint_row.conname =
          'writing_feedback_adjudications_v2_decision_shape_check'
    )
    select count(*)
    from constraint_definition,
      unnest(array[
        'critic_approved',
        'final_critic_approved',
        'recovery_critic_approved',
        'critic_advisory_unavailable',
        'pro_authority_accepted',
        'adjudicator_resolved'
      ]) expected_reason(reason_code)
    where position(
      quote_literal(expected_reason.reason_code)
      in constraint_definition.value
    ) > 0
  ),
  6::bigint,
  'the decision constraint preserves three accepted branches and adds three authority branches'
);

create temporary table phase_14g_writing_authority_evidence (
  like app_private.writing_feedback_adjudications_v2
    including defaults
    including constraints
) on commit drop;

create function pg_temp.phase_14g_evidence_is_valid(
  evidence_overrides jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  insert into pg_temp.phase_14g_writing_authority_evidence
  select populated.*
  from jsonb_populate_record(
    null::pg_temp.phase_14g_writing_authority_evidence,
    jsonb_build_object(
      'job_id', 'e1111111-1111-4111-8111-111111111111',
      'submission_id', 'e1222222-2222-4222-8222-222222222222',
      'evaluation_version', 1,
      'feedback_version', 1,
      'schema_version', 2,
      'decision', 'accepted_model_feedback',
      'reason_code', 'critic_advisory_unavailable',
      'context_sha256', repeat('a', 64),
      'original_text_sha256', repeat('b', 64),
      'final_feedback_sha256', repeat('d', 64),
      'generator_provider', 'deepseek',
      'generator_model', 'deepseek-v4-flash',
      'candidate_feedback_sha256', repeat('c', 64),
      'candidate_release_sha256', repeat('d', 64),
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
      'accepted_provider', 'deepseek',
      'accepted_model', 'deepseek-v4-flash',
      'created_at', now()
    ) || coalesce(evidence_overrides, '{}'::jsonb)
  ) populated;

  return true;
exception
  when check_violation then
    return false;
end;
$$;

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'critic_approved',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'approved',
    'critic_decision_sha256', repeat('e', 64)
  )),
  'the existing direct critic-approved branch remains valid'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'final_critic_approved',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('c', 64),
    'final_critic_provider', 'gemini',
    'final_critic_model', 'gemini-3.1-flash-lite',
    'final_critic_verdict', 'approved',
    'final_critic_decision_sha256', repeat('1', 64)
  )),
  'the existing final-critic-approved branch remains valid'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'recovery_critic_approved',
    'generator_provider', 'gemini',
    'generator_model', 'gemini-3.1-flash-lite',
    'critic_provider', 'deepseek',
    'critic_model', 'deepseek-v4-pro',
    'critic_verdict', 'approved',
    'critic_decision_sha256', repeat('e', 64),
    'accepted_provider', 'gemini',
    'accepted_model', 'gemini-3.1-flash-lite'
  )),
  'the existing cross-provider recovery branch remains valid'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(),
  'a valid DeepSeek candidate survives a completely unavailable advisory'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', null,
    'critic_decision_sha256', null
  )),
  'a configured current Gemini advisory may be unavailable without a response hash'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', null,
    'critic_decision_sha256', repeat('e', 64)
  )),
  'advisory failure may retain a bounded malformed-response hash'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'pro_authority_accepted',
    'generator_model', 'deepseek-v4-pro',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'accepted_model', 'deepseek-v4-pro'
  )),
  'a valid DeepSeek Pro candidate remains authoritative over Gemini dissent'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'adjudicator_resolved',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'uncertain',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('c', 64)
  )),
  'a Pro adjudicator may uphold the exact Flash candidate without a final critic'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'adjudicator_resolved',
    'final_feedback_sha256', repeat('2', 64),
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('1', 64),
    'accepted_model', 'deepseek-v4-pro'
  )),
  'a Pro adjudicator may revise a Flash candidate with distinct resolved and release hashes'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64)
  )),
  'advisory-unavailable evidence cannot conceal a valid dissent verdict'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.5-flash',
    'critic_verdict', null,
    'critic_decision_sha256', null
  )),
  'new advisory-unavailable evidence cannot use a retired Gemini model'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'pro_authority_accepted',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'accepted_model', 'deepseek-v4-pro'
  )),
  'Flash generation cannot masquerade as direct Pro authority'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'adjudicator_resolved',
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('c', 64),
    'final_critic_provider', 'gemini',
    'final_critic_model', 'gemini-3.1-flash-lite',
    'final_critic_verdict', 'approved',
    'final_critic_decision_sha256', repeat('1', 64)
  )),
  'adjudicator authority cannot carry a contradictory final-critic tuple'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'reason_code', 'adjudicator_resolved',
    'final_feedback_sha256', repeat('2', 64),
    'critic_provider', 'gemini',
    'critic_model', 'gemini-3.1-flash-lite',
    'critic_verdict', 'disagreed',
    'critic_decision_sha256', repeat('e', 64),
    'adjudicator_provider', 'deepseek',
    'adjudicator_model', 'deepseek-v4-pro',
    'adjudicator_verdict', 'resolved',
    'adjudicator_decision_sha256', repeat('f', 64),
    'resolved_feedback_sha256', repeat('c', 64),
    'accepted_model', 'deepseek-v4-pro'
  )),
  'a revised adjudication must differ from the original candidate hash'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'decision', 'system_hold',
    'reason_code', 'critic_advisory_unavailable',
    'accepted_provider', null,
    'accepted_model', null
  )),
  'critic-advisory-unavailable is accepted evidence, never a system hold'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'decision', 'system_hold',
    'reason_code', 'pro_authority_accepted',
    'accepted_provider', null,
    'accepted_model', null
  )),
  'pro-authority-accepted is accepted evidence, never a system hold'
);

select ok(
  not pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'decision', 'system_hold',
    'reason_code', 'adjudicator_resolved',
    'accepted_provider', null,
    'accepted_model', null
  )),
  'adjudicator-resolved is accepted evidence, never a system hold'
);

select ok(
  pg_temp.phase_14g_evidence_is_valid(jsonb_build_object(
    'decision', 'system_hold',
    'reason_code', 'generator_invalid',
    'candidate_feedback_sha256', null,
    'candidate_release_sha256', null,
    'accepted_provider', null,
    'accepted_model', null
  )),
  'existing non-accepted reasons remain valid system holds'
);

select * from finish();

rollback;
