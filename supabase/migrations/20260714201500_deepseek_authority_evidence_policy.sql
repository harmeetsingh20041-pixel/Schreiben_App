-- DeepSeek remains the release authority for valid DeepSeek writing feedback.
-- Gemini is advisory: an unavailable advisory cannot suppress a valid
-- candidate, a valid dissent cannot overrule a DeepSeek Pro candidate, and a
-- DeepSeek Pro adjudication can resolve a Flash candidate without another
-- Gemini approval. Historical accepted and hold evidence remains valid.

alter table app_private.writing_feedback_adjudications_v2
  drop constraint if exists
    writing_feedback_adjudications_v2_reason_code_check,
  drop constraint if exists
    writing_feedback_adjudications_v2_decision_shape_check;

alter table app_private.writing_feedback_adjudications_v2
  add constraint writing_feedback_adjudications_v2_reason_code_check check (
    reason_code in (
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
    )
  ),
  add constraint writing_feedback_adjudications_v2_decision_shape_check check (
    coalesce((
      (
        decision = 'system_hold'
        and reason_code not in (
          'critic_approved',
          'final_critic_approved',
          'recovery_critic_approved',
          'critic_advisory_unavailable',
          'pro_authority_accepted',
          'adjudicator_resolved'
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
          or (
            reason_code = 'critic_advisory_unavailable'
            and generator_provider = 'deepseek'
            and accepted_provider = 'deepseek'
            and accepted_model = generator_model
            and candidate_release_sha256 = final_feedback_sha256
            and (
              (
                critic_provider is null
                and critic_model is null
                and critic_verdict is null
                and critic_decision_sha256 is null
              )
              or (
                critic_provider = 'gemini'
                and critic_model = 'gemini-3.1-flash-lite'
                and critic_verdict is null
              )
            )
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
            reason_code = 'pro_authority_accepted'
            and generator_provider = 'deepseek'
            and generator_model = 'deepseek-v4-pro'
            and accepted_provider = 'deepseek'
            and accepted_model = 'deepseek-v4-pro'
            and candidate_release_sha256 = final_feedback_sha256
            and critic_provider = 'gemini'
            and critic_model = 'gemini-3.1-flash-lite'
            and critic_verdict in ('disagreed', 'uncertain')
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
            reason_code = 'adjudicator_resolved'
            and generator_provider = 'deepseek'
            and generator_model = 'deepseek-v4-flash'
            and accepted_provider = 'deepseek'
            and accepted_model in ('deepseek-v4-flash', 'deepseek-v4-pro')
            and critic_provider = 'gemini'
            and critic_model = 'gemini-3.1-flash-lite'
            and critic_verdict in ('disagreed', 'uncertain')
            and critic_decision_sha256 is not null
            and adjudicator_provider = 'deepseek'
            and adjudicator_model = 'deepseek-v4-pro'
            and adjudicator_verdict = 'resolved'
            and adjudicator_decision_sha256 is not null
            and resolved_feedback_sha256 is not null
            and final_critic_provider is null
            and final_critic_model is null
            and final_critic_verdict is null
            and final_critic_decision_sha256 is null
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
        )
      )
    ), false)
  );
