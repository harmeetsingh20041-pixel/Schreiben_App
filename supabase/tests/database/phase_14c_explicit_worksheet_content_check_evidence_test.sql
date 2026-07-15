begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(35);

create or replace function pg_temp.phase_14c_checks(
  failed_check text default null
)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
begin
  if failed_check is not null and result ? failed_check then
    result := jsonb_set(result, array[failed_check], 'false'::jsonb);
  end if;
  return result;
end;
$$;

create or replace function pg_temp.phase_14c_content_checks(
  failed_check text default null
)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
begin
  if failed_check is not null and result ? failed_check then
    result := jsonb_set(result, array[failed_check], 'false'::jsonb);
  end if;
  return result;
end;
$$;

create or replace function pg_temp.phase_14c_critic(
  provider_name text,
  model_name text,
  candidate_sha256 text,
  failed_check text default null
)
returns jsonb
language plpgsql
as $$
declare
  checks jsonb := pg_temp.phase_14c_checks(failed_check);
  content_checks jsonb := pg_temp.phase_14c_content_checks(failed_check);
  approved boolean;
  result jsonb;
begin
  approved := failed_check is null;
  result := jsonb_build_object(
    'provider', provider_name,
    'model', model_name,
    'candidate_sha256', candidate_sha256,
    'approved', approved,
    'checks', checks,
    'content_checks', content_checks,
    'rejection_reasons', case
      when approved then '[]'::jsonb
      else jsonb_build_array('The explicit worksheet content check failed.')
    end
  );
  return result || jsonb_build_object(
    'verdict_sha256', app_private.worksheet_critic_verdict_sha256(result)
  );
end;
$$;

create or replace function pg_temp.phase_14c_payload(
  deepseek_failed_check text default null,
  gemini_failed_check text default null,
  gemini_model text default 'gemini-3.1-flash-lite'
)
returns jsonb
language plpgsql
as $$
declare
  source_payload jsonb;
  questions jsonb;
  candidate_sha256 text;
  deepseek_critic jsonb;
  gemini_critic jsonb;
  combined_checks jsonb := '{}'::jsonb;
  combined_content_checks jsonb := '{}'::jsonb;
  check_name text;
  content_check_name text;
begin
  select jsonb_agg(
    jsonb_build_object(
      'question_number', question_number,
      'question_type', 'multiple_choice',
      'evaluation_mode', 'local_exact',
      'prompt', format(
        'Welche Satzform ist in Aufgabe %s grammatisch richtig?',
        question_number
      ),
      'options', jsonb_build_array(
        format('Richtige Form %s', question_number),
        format('Falsche Form %sA', question_number),
        format('Falsche Form %sB', question_number)
      ),
      'correct_answer', format('Richtige Form %s', question_number),
      'accepted_answers', jsonb_build_array(
        format('Richtige Form %s', question_number)
      ),
      'rubric', null,
      'explanation', format(
        'Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe %s.',
        question_number
      )
    )
    order by question_number
  )
  into questions
  from generate_series(1, 8) question_number;

  source_payload := jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'deepseek',
    'generator_model', 'deepseek-v4-pro',
    'title', 'Phase 14C explicit content evidence',
    'level', 'A1',
    'difficulty', 'medium',
    'description', 'Acht eindeutige Grammatikaufgaben für A1.',
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Prüfe die Form im vollständigen Satz.',
      'key_rule', 'Nur eine Antwort erfüllt alle genannten Bedingungen.',
      'correct_examples', jsonb_build_array(
        'Der Patient wartet.',
        'Ich sehe den Patienten.'
      ),
      'common_mistake_warning',
        'Achte auf die Satzfunktion und nicht nur auf das Nomen.',
      'what_to_revise', 'Wiederhole die Formen im vollständigen Kontext.'
    ),
    'questions', questions,
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 8,
      'gemini_count', 0
    )
  );

  candidate_sha256 := app_private.worksheet_candidate_sha256(source_payload);
  deepseek_critic := pg_temp.phase_14c_critic(
    'deepseek',
    'deepseek-v4-flash',
    candidate_sha256,
    deepseek_failed_check
  );
  gemini_critic := pg_temp.phase_14c_critic(
    'gemini',
    gemini_model,
    candidate_sha256,
    gemini_failed_check
  );

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
    combined_checks := combined_checks || jsonb_build_object(
      check_name,
      (deepseek_critic #>> array['checks', check_name])::boolean and
        (gemini_critic #>> array['checks', check_name])::boolean
    );
  end loop;

  foreach content_check_name in array array[
    'mini_lesson_scope_accurate',
    'learner_cues_semantically_aligned',
    'examples_rubrics_consistent'
  ]
  loop
    combined_content_checks := combined_content_checks || jsonb_build_object(
      content_check_name,
      (
        deepseek_critic #>> array['content_checks', content_check_name]
      )::boolean and
        (
          gemini_critic #>> array['content_checks', content_check_name]
        )::boolean
    );
  end loop;

  return jsonb_set(
    source_payload,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model',
        (deepseek_critic ->> 'approved')::boolean and
          (gemini_critic ->> 'approved')::boolean,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 1,
      'checks', combined_checks,
      'content_checks', combined_content_checks,
      'rejection_reasons',
        (deepseek_critic -> 'rejection_reasons') ||
          (gemini_critic -> 'rejection_reasons')
    )
  );
end;
$$;

select ok(
  to_regprocedure(
    'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)'
  ) is not null
    and to_regprocedure(
      'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'
    ) is not null
    and to_regprocedure(
      'app_private.assert_worksheet_critics_v2(jsonb)'
    ) is not null,
  'all explicit content-evidence validators exist'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'::regprocedure
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
    )
    and (
      select bool_and(
        routine.provolatile = 'i'
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting = any (array['search_path=', 'search_path=""'])
        )
      )
      from pg_proc routine
      where routine.oid in (
        'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)'::regprocedure,
        'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'::regprocedure,
        'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
      )
    ),
  'validators are immutable, invoker-safe, and search-path pinned'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'app_private.assert_worksheet_critics_v2(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_worksheet_critics_v2(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)',
      'EXECUTE'
    ),
  'only the intended service validators are callable outside app_private owners'
);

select ok(
  (
    select pg_get_functiondef(routine.oid)
    from pg_proc routine
    where routine.oid =
      'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)'::regprocedure
  ) ilike '%content_checks%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure
    ) ilike '%mini_lesson_scope_accurate%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.is_valid_worksheet_checkpoint_critic(jsonb,text,text,text)'::regprocedure
    ) ilike '%gemini-3.1-flash-lite%',
  'database definitions require explicit content checks and the pinned Gemini model'
);

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ) as payload
)
select ok(
  app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'an exact approved DeepSeek verdict validates'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'gemini', 'gemini-3.1-flash-lite', repeat('a', 64)
  ) as payload
)
select ok(
  app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'gemini', 'gemini-3.1-flash-lite', repeat('a', 64)
  ),
  'an exact approved pinned Gemini verdict validates'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64),
    'mini_lesson_scope_accurate'
  ) as payload
)
select ok(
  app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'a rejected verdict retains an explicit failed content check and reason'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ) - 'content_checks' as payload
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'missing content checks fail closed'
)
from evidence;

with evidence as (
  select jsonb_set(
    pg_temp.phase_14c_critic(
      'deepseek', 'deepseek-v4-flash', repeat('a', 64)
    ),
    '{content_checks,unexpected}',
    'true'::jsonb
  ) as payload
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'extra content checks fail closed'
)
from evidence;

with evidence as (
  select jsonb_set(
    pg_temp.phase_14c_critic(
      'deepseek', 'deepseek-v4-flash', repeat('a', 64)
    ),
    '{content_checks,examples_rubrics_consistent}',
    '"yes"'::jsonb
  ) as payload
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'non-boolean content evidence fails closed'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ) as payload
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('b', 64)
  ),
  'candidate hash mismatch cannot replay critic evidence'
)
from evidence;

with evidence as (
  select jsonb_set(
    pg_temp.phase_14c_critic(
      'deepseek', 'deepseek-v4-flash', repeat('a', 64)
    ),
    '{content_checks,learner_cues_semantically_aligned}',
    'false'::jsonb
  ) as payload
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'content evidence cannot be changed without invalidating its verdict hash'
)
from evidence;

with contradictory_without_hash as (
  select (
    pg_temp.phase_14c_critic(
      'deepseek',
      'deepseek-v4-flash',
      repeat('a', 64),
      'mini_lesson_scope_accurate'
    ) - 'verdict_sha256'
  ) || jsonb_build_object(
    'approved', true,
    'rejection_reasons', '[]'::jsonb
  ) as payload
), contradictory as (
  select payload || jsonb_build_object(
    'verdict_sha256', app_private.worksheet_critic_verdict_sha256(payload)
  ) as payload
  from contradictory_without_hash
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'approved=true cannot contradict a failed content check even with a fresh hash'
)
from contradictory;

with contradictory_without_hash as (
  select (
    pg_temp.phase_14c_critic(
      'deepseek',
      'deepseek-v4-flash',
      repeat('a', 64),
      'examples_rubrics_consistent'
    ) - 'verdict_sha256'
  ) || jsonb_build_object('rejection_reasons', '[]'::jsonb) as payload
), contradictory as (
  select payload || jsonb_build_object(
    'verdict_sha256', app_private.worksheet_critic_verdict_sha256(payload)
  ) as payload
  from contradictory_without_hash
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ),
  'a failed content check requires a bounded rejection reason'
)
from contradictory;

with evidence as (
  select pg_temp.phase_14c_critic(
    'gemini', 'gemini-3.5-flash', repeat('a', 64)
  ) as payload
)
select ok(
  app_private.is_valid_worksheet_checkpoint_critic(
    payload, 'gemini', 'gemini-3.5-flash', repeat('a', 64)
  ),
  'historical pinned Gemini evidence remains recoverable'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ) as payload
)
select lives_ok(
  format(
    'select app_private.assert_worksheet_critic_verdict(%L::jsonb, %L, %L, %L)',
    payload::text,
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  ),
  'the strict single-verdict assertion accepts complete content evidence'
)
from evidence;

with evidence as (
  select pg_temp.phase_14c_critic(
    'deepseek', 'deepseek-v4-flash', repeat('a', 64)
  ) - 'content_checks' as payload
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critic_verdict(%L::jsonb, %L, %L, %L)',
    payload::text,
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'the strict assertion rejects missing content evidence'
)
from evidence;

with evidence as (
  select jsonb_set(
    pg_temp.phase_14c_critic(
      'deepseek', 'deepseek-v4-flash', repeat('a', 64)
    ),
    '{content_checks,unexpected}',
    'true'::jsonb
  ) as payload
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critic_verdict(%L::jsonb, %L, %L, %L)',
    payload::text,
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'the strict assertion rejects extra content evidence'
)
from evidence;

with contradictory_without_hash as (
  select (
    pg_temp.phase_14c_critic(
      'deepseek',
      'deepseek-v4-flash',
      repeat('a', 64),
      'mini_lesson_scope_accurate'
    ) - 'verdict_sha256'
  ) || jsonb_build_object(
    'approved', true,
    'rejection_reasons', '[]'::jsonb
  ) as payload
), contradictory as (
  select payload || jsonb_build_object(
    'verdict_sha256', app_private.worksheet_critic_verdict_sha256(payload)
  ) as payload
  from contradictory_without_hash
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critic_verdict(%L::jsonb, %L, %L, %L)',
    payload::text,
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'the strict assertion rejects an approval/content contradiction'
)
from contradictory;

with payload as (
  select pg_temp.phase_14c_payload() as value
)
select lives_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  'a fully approved worksheet preserves both explicit content attestations'
)
from payload;

-- This literal was emitted by the current TypeScript
-- worksheetCandidateSha256/worksheetCriticVerdictSha256 implementations. It
-- deliberately does not call a PostgreSQL hash helper while being built, so
-- this assertion catches cross-runtime canonical-JSON drift.
select lives_ok(
  format(
    'select * from app_private.normalize_worksheet_generation_provenance_v2(%L::jsonb)',
    $json$
    {
      "schema_version": 1,
      "mode": "generated",
      "generation_source": "deepseek",
      "generator_model": "deepseek-v4-pro",
      "title": "Phase 14C TypeScript interoperability",
      "level": "A1",
      "difficulty": "medium",
      "description": "Acht eindeutige Grammatikaufgaben für A1.",
      "mini_lesson": {
        "short_explanation": "Prüfe die Form im vollständigen Satz.",
        "key_rule": "Nur eine Antwort erfüllt alle genannten Bedingungen.",
        "correct_examples": [
          "Der Patient wartet.",
          "Ich sehe den Patienten."
        ],
        "common_mistake_warning": "Achte auf die Satzfunktion und nicht nur auf das Nomen.",
        "what_to_revise": "Wiederhole die Formen im vollständigen Kontext."
      },
      "questions": [
        {
          "question_number": 1,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 1 grammatisch richtig?",
          "options": ["Richtige Form 1", "Falsche Form 1A", "Falsche Form 1B"],
          "correct_answer": "Richtige Form 1",
          "accepted_answers": ["Richtige Form 1"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 1."
        },
        {
          "question_number": 2,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 2 grammatisch richtig?",
          "options": ["Richtige Form 2", "Falsche Form 2A", "Falsche Form 2B"],
          "correct_answer": "Richtige Form 2",
          "accepted_answers": ["Richtige Form 2"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 2."
        },
        {
          "question_number": 3,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 3 grammatisch richtig?",
          "options": ["Richtige Form 3", "Falsche Form 3A", "Falsche Form 3B"],
          "correct_answer": "Richtige Form 3",
          "accepted_answers": ["Richtige Form 3"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 3."
        },
        {
          "question_number": 4,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 4 grammatisch richtig?",
          "options": ["Richtige Form 4", "Falsche Form 4A", "Falsche Form 4B"],
          "correct_answer": "Richtige Form 4",
          "accepted_answers": ["Richtige Form 4"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 4."
        },
        {
          "question_number": 5,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 5 grammatisch richtig?",
          "options": ["Richtige Form 5", "Falsche Form 5A", "Falsche Form 5B"],
          "correct_answer": "Richtige Form 5",
          "accepted_answers": ["Richtige Form 5"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 5."
        },
        {
          "question_number": 6,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 6 grammatisch richtig?",
          "options": ["Richtige Form 6", "Falsche Form 6A", "Falsche Form 6B"],
          "correct_answer": "Richtige Form 6",
          "accepted_answers": ["Richtige Form 6"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 6."
        },
        {
          "question_number": 7,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 7 grammatisch richtig?",
          "options": ["Richtige Form 7", "Falsche Form 7A", "Falsche Form 7B"],
          "correct_answer": "Richtige Form 7",
          "accepted_answers": ["Richtige Form 7"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 7."
        },
        {
          "question_number": 8,
          "question_type": "multiple_choice",
          "evaluation_mode": "local_exact",
          "prompt": "Welche Satzform ist in Aufgabe 8 grammatisch richtig?",
          "options": ["Richtige Form 8", "Falsche Form 8A", "Falsche Form 8B"],
          "correct_answer": "Richtige Form 8",
          "accepted_answers": ["Richtige Form 8"],
          "rubric": null,
          "explanation": "Nur die erste Form erfüllt die Grammatikbedingung in Aufgabe 8."
        }
      ],
      "source_mix": {
        "mode": "deepseek",
        "deepseek_count": 8,
        "gemini_count": 0
      },
      "validation": {
        "deterministic": true,
        "independent_model": true,
        "critic_model": "deepseek-v4-flash",
        "candidate_sha256": "625f5d5cf9e2f43472fc11d9c6ea82967e46619158d8ee691e6fa35a322a6bd4",
        "critics": {
          "deepseek": {
            "provider": "deepseek",
            "model": "deepseek-v4-flash",
            "candidate_sha256": "625f5d5cf9e2f43472fc11d9c6ea82967e46619158d8ee691e6fa35a322a6bd4",
            "approved": true,
            "checks": {
              "ambiguity_free": true,
              "no_answer_leakage": true,
              "duplicate_free": true,
              "level_fit": true,
              "topic_fit": true,
              "type_balance": true,
              "scoring_safe": true
            },
            "content_checks": {
              "mini_lesson_scope_accurate": true,
              "learner_cues_semantically_aligned": true,
              "examples_rubrics_consistent": true
            },
            "rejection_reasons": [],
            "verdict_sha256": "800760bd686e2fd4cf39ab2a0d95ad7a6108ad7f7da340f0409e846d6953f47d"
          },
          "gemini": {
            "provider": "gemini",
            "model": "gemini-3.1-flash-lite",
            "candidate_sha256": "625f5d5cf9e2f43472fc11d9c6ea82967e46619158d8ee691e6fa35a322a6bd4",
            "approved": true,
            "checks": {
              "ambiguity_free": true,
              "no_answer_leakage": true,
              "duplicate_free": true,
              "level_fit": true,
              "topic_fit": true,
              "type_balance": true,
              "scoring_safe": true
            },
            "content_checks": {
              "mini_lesson_scope_accurate": true,
              "learner_cues_semantically_aligned": true,
              "examples_rubrics_consistent": true
            },
            "rejection_reasons": [],
            "verdict_sha256": "7481eeab2f65ed2dd6b0368c29a9ed6ed7a82b0d4a0f0e7106a795535acc8e42"
          }
        },
        "attempt_count": 1,
        "checks": {
          "ambiguity_free": true,
          "no_answer_leakage": true,
          "duplicate_free": true,
          "level_fit": true,
          "topic_fit": true,
          "type_balance": true,
          "scoring_safe": true
        },
        "content_checks": {
          "mini_lesson_scope_accurate": true,
          "learner_cues_semantically_aligned": true,
          "examples_rubrics_consistent": true
        },
        "rejection_reasons": []
      }
    }
    $json$::jsonb::text
  ),
  'TypeScript and PostgreSQL agree on candidate and critic verdict hashes'
);

with payload as (
  select pg_temp.phase_14c_payload() as value
)
select lives_ok(
  format(
    'select * from app_private.normalize_worksheet_generation_provenance_v2(%L::jsonb)',
    value::text
  ),
  'the full current generated shape also passes the provenance boundary'
)
from payload;

with payload as (
  select pg_temp.phase_14c_payload(
    'mini_lesson_scope_accurate', null
  ) as value
)
select lives_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  'a rejected worksheet records content failure without folding ordinary checks'
)
from payload;

with payload as (
  select value #- '{validation,content_checks}' as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'aggregate content evidence is mandatory'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,attempt_count}',
    to_jsonb('1'::text)
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'attempt count must be a JSON number rather than a numeric-looking string'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,content_checks,unexpected}',
    'true'::jsonb
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'aggregate content evidence has an exact closed shape'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,content_checks,learner_cues_semantically_aligned}',
    'false'::jsonb
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'aggregate content checks must equal the two-critic AND projection'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,critics,gemini,content_checks,examples_rubrics_consistent}',
    'false'::jsonb
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'critic content evidence is bound into its immutable verdict hash'
)
from payload;

with payload as (
  select value #- '{validation,critics,deepseek,content_checks}' as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'each independent critic must carry its own content evidence'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,critics,deepseek,candidate_sha256}',
    'null'::jsonb
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'critic identity fields reject present JSON null values'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,rejection_reasons}',
    jsonb_build_array('A fabricated aggregate reason.')
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'aggregate reasons must be the exact ordered two-critic projection'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,candidate_sha256}',
    to_jsonb(repeat('f', 64))
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_candidate_hash_mismatch',
  'the aggregate remains bound to the exact candidate worksheet'
)
from payload;

with payload as (
  select jsonb_set(
    value,
    '{validation,independent_model}',
    'false'::jsonb
  ) as value
  from (select pg_temp.phase_14c_payload() as value) source
)
select throws_ok(
  format(
    'select app_private.assert_worksheet_critics_v2(%L::jsonb)',
    value::text
  ),
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'independent approval must equal both ordinary and content approvals'
)
from payload;

with payload as (
  select pg_temp.phase_14c_payload(null, null, 'gemini-3.1-flash-lite') as value
)
select is(
  value #>> '{validation,critics,gemini,model}',
  'gemini-3.1-flash-lite',
  'new durable worksheet evidence uses the pinned cost-efficient Gemini critic'
)
from payload;

select ok(
  obj_description(
    'app_private.assert_worksheet_critic_verdict(jsonb,text,text,text)'::regprocedure,
    'pg_proc'
  ) ilike '%content-quality%'
    and obj_description(
      'app_private.assert_worksheet_critics_v2(jsonb)'::regprocedure,
      'pg_proc'
    ) ilike '%content-quality%',
  'catalog comments document the explicit content-quality contract'
);

select * from finish();
rollback;
