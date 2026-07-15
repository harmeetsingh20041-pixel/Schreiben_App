begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(70);

select ok(
  to_regclass('app_private.worksheet_generation_checkpoints') is not null
    and to_regclass(
      'app_private.worksheet_generation_stage_evidence'
    ) is not null,
  'resumable active state and immutable first-rejection evidence exist'
);

select ok(
  (
    select count(*) = 2 and bool_and(relation.relrowsecurity)
    from pg_class relation
    where relation.oid in (
      'app_private.worksheet_generation_checkpoints'::regclass,
      'app_private.worksheet_generation_stage_evidence'::regclass
    )
  ),
  'both private checkpoint tables have RLS defense in depth'
);

select ok(
  not exists (
    select 1
    from pg_policy policy
    where policy.polrelid in (
      'app_private.worksheet_generation_checkpoints'::regclass,
      'app_private.worksheet_generation_stage_evidence'::regclass
    )
  ),
  'no browser-readable policy exists on either private table'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'app_private.worksheet_generation_checkpoints',
      'app_private.worksheet_generation_stage_evidence'
    ]) relation_name
    cross join unnest(array[
      'anon', 'authenticated', 'service_role'
    ]) role_name
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    ]) privilege_name
    where has_table_privilege(
      role_name,
      relation_name,
      privilege_name
    )
  ),
  'browser and service roles have no direct checkpoint-table privileges'
);

select ok(
  to_regprocedure(
    'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'
  ) is not null
    and to_regprocedure(
      'api.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'
    ) is not null
    and to_regprocedure(
      'api.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'
    ) is not null
    and to_regprocedure(
      'api.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'
    ) is not null
    and to_regprocedure(
      'api.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'
    ) is not null
    and to_regprocedure(
      'api.clear_worksheet_generation_checkpoint(uuid,integer)'
    ) is not null,
  'all six service API checkpoint contracts exist'
);

select ok(
  (
    select count(*) = 6 and bool_and(not routine.prosecdef)
    from pg_proc routine
    where routine.oid in (
      'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure,
      'api.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'::regprocedure,
      'api.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'::regprocedure,
      'api.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'api.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'api.clear_worksheet_generation_checkpoint(uuid,integer)'::regprocedure
    )
  )
    and (
      select count(*) = 6 and bool_and(routine.prosecdef)
      from pg_proc routine
      where routine.oid in (
        'app_private.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure,
        'app_private.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'::regprocedure,
        'app_private.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'::regprocedure,
        'app_private.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
        'app_private.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
        'app_private.clear_worksheet_generation_checkpoint(uuid,integer)'::regprocedure
      )
    ),
  'API facades are invokers and only private implementations are definers'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure,
      'api.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'::regprocedure,
      'api.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'::regprocedure,
      'api.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'api.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'api.clear_worksheet_generation_checkpoint(uuid,integer)'::regprocedure,
      'app_private.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure,
      'app_private.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)'::regprocedure,
      'app_private.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'::regprocedure,
      'app_private.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'app_private.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'::regprocedure,
      'app_private.clear_worksheet_generation_checkpoint(uuid,integer)'::regprocedure
    )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  ),
  'every checkpoint facade and implementation pins an empty search path'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)',
      'api.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)',
      'api.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)',
      'api.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)',
      'api.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)',
      'api.clear_worksheet_generation_checkpoint(uuid,integer)'
    ]) function_name
    cross join unnest(array['anon', 'authenticated']) role_name
    where has_function_privilege(role_name, function_name, 'EXECUTE')
  )
    and not exists (
      select 1
      from unnest(array[
        'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)',
        'api.save_worksheet_generation_candidate(uuid,bigint,uuid,integer,smallint,text,jsonb)',
        'api.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)',
        'api.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)',
        'api.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)',
        'api.clear_worksheet_generation_checkpoint(uuid,integer)'
      ]) function_name
      where not has_function_privilege(
        'service_role', function_name, 'EXECUTE'
      )
    ),
  'only the worker service can execute exposed checkpoint operations'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_stage_evidence'::regclass
      and trigger_row.tgname =
        'worksheet_generation_stage_evidence_immutable'
      and not trigger_row.tgisinternal
  )
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'app_private.async_jobs'::regclass
        and trigger_row.tgname =
          'async_jobs_cleanup_worksheet_generation_checkpoint'
        and not trigger_row.tgisinternal
    )
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
        'public.student_practice_assignments'::regclass
        and trigger_row.tgname =
          'practice_assignments_cleanup_worksheet_generation_checkpoint'
        and not trigger_row.tgisinternal
    ),
  'immutable evidence and both terminal/supersession cleanup triggers exist'
);

select ok(
  (
    select count(*) = 2
      and bool_and(constraint_row.confdeltype = 'c')
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_stage_evidence'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid in (
        'app_private.async_jobs'::regclass,
        'public.student_practice_assignments'::regclass
      )
  )
    and (
      select pg_get_triggerdef(trigger_row.oid) like '%BEFORE UPDATE%'
        and pg_get_triggerdef(trigger_row.oid) not like '%DELETE%'
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
        'app_private.worksheet_generation_stage_evidence'::regclass
        and trigger_row.tgname =
          'worksheet_generation_stage_evidence_immutable'
        and not trigger_row.tgisinternal
    ),
  'evidence is update-immutable but cascades with parent retention deletion'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.student_practice_assignments'::regclass
      and constraint_row.confrelid = 'public.workspaces'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confdeltype = 'c'
  )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.worksheet_generation_stage_evidence'::regclass
        and constraint_row.confrelid =
          'public.student_practice_assignments'::regclass
        and constraint_row.contype = 'f'
        and constraint_row.confdeltype = 'c'
    ),
  'workspace retention deletion cascades through assignments to stage evidence'
);

select ok(
  exists (
    select 1
    from pg_class index_relation
    join pg_index index_row
      on index_row.indexrelid = index_relation.oid
    where index_relation.relname =
        'worksheet_generation_stage_evidence_assignment_id_idx'
      and index_row.indrelid =
        'app_private.worksheet_generation_stage_evidence'::regclass
      and index_row.indisvalid
      and pg_get_indexdef(index_row.indexrelid) like '%(assignment_id)%'
  ),
  'stage evidence has a valid assignment foreign-key supporting index'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
      like '%attempt_count >= 0%attempt_count <= 5%'
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'app_private.async_jobs'::regclass
      and constraint_row.conname = 'async_jobs_attempt_count_check'
  )
    and (
      select position('fallback_queue_message_id = queue_message.msg_id'
          in routine.prosrc) > 0
        and position('repair_queue_message_id = queue_message.msg_id'
          in routine.prosrc) > 0
        and position('selected_job.status in (''queued'', ''retry'')'
          in routine.prosrc) > 0
        and position('selected_job.attempt_count between 3 and 4'
          in routine.prosrc) > 0
      from pg_proc routine
      where routine.oid =
        'public.claim_async_jobs(text,uuid,integer,integer)'::regprocedure
    ),
  'attempt history is bounded at five and only exact queued continuation IDs bypass the ordinary cap'
);

select ok(
  (
    select position('from app_private.async_jobs job' in routine.prosrc) > 0
      and position('from public.student_practice_assignments assignment'
        in routine.prosrc) >
        position('from app_private.async_jobs job' in routine.prosrc)
      and position('for update' in split_part(
        routine.prosrc,
        'from public.student_practice_assignments assignment',
        2
      )) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.lock_worksheet_generation_context(uuid,integer)'::regprocedure
  )
    and not exists (
      select 1
      from unnest(array[
        'app_private.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)',
        'app_private.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'
      ]) routine_name
      cross join lateral (
        select routine.prosrc
        from pg_proc routine
        where routine.oid = routine_name::regprocedure
      ) source
      where position('lock_worksheet_generation_context' in source.prosrc) = 0
        or position('lock_worksheet_generation_context' in source.prosrc) >=
          position('from app_private.worksheet_generation_checkpoints'
            in source.prosrc)
    )
    and (
      select position('assert_active_worksheet_generation_lease'
          in routine.prosrc) > 0
        and position('assert_active_worksheet_generation_lease'
          in routine.prosrc) <
          position('from app_private.worksheet_generation_checkpoints'
            in routine.prosrc)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_completion(uuid,bigint,uuid,integer,jsonb)'::regprocedure
    )
    and (
      select position('from app_private.async_jobs job' in routine.prosrc) > 0
        and position('from public.student_practice_assignments assignment'
          in routine.prosrc) >
          position('from app_private.async_jobs job' in routine.prosrc)
        and position('delete from app_private.worksheet_generation_checkpoints'
          in routine.prosrc) >
          position('from public.student_practice_assignments assignment'
            in routine.prosrc)
      from pg_proc routine
      where routine.oid =
        'app_private.clear_worksheet_generation_checkpoint(uuid,integer)'::regprocedure
    )
    and (
      select position('from public.student_practice_assignments assignment'
          in routine.prosrc) > 0
        and position('from public.student_practice_assignments assignment'
          in routine.prosrc) <
          position('delete from app_private.worksheet_generation_checkpoints'
            in routine.prosrc)
      from pg_proc routine
      where routine.oid =
        'app_private.cleanup_worksheet_generation_checkpoint()'::regprocedure
    ),
  'fallback, repair, completion, and cleanup acquire job then assignment before checkpoint state'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid) like '%131072%'
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_checkpoints'::regclass
      and constraint_row.conname =
        'worksheet_generation_checkpoints_candidate_size_check'
  )
    and (
      select pg_get_constraintdef(constraint_row.oid) like '%deepseek-v4-pro%'
        and pg_get_constraintdef(constraint_row.oid) like '%gemini-3.5-flash%'
        and pg_get_constraintdef(constraint_row.oid)
          like '%gemini-3.1-flash-lite%'
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.worksheet_generation_checkpoints'::regclass
        and constraint_row.conname =
          'worksheet_generation_checkpoints_provider_model_check'
    ),
  'database constraints pin candidate size and generator provenance'
);

select ok(
  (
    with expected(code) as (
      values
        ('worksheet_provider_timeout'),
        ('worksheet_provider_unavailable'),
        ('worksheet_provider_response_too_large'),
        ('worksheet_provider_response_invalid'),
        ('worksheet_provider_invalid_json'),
        ('worksheet_invalid_shape'),
        ('worksheet_invalid_text'),
        ('worksheet_invalid_array'),
        ('worksheet_invalid_rubric'),
        ('worksheet_invalid_mini_lesson'),
        ('worksheet_invalid_question_type'),
        ('worksheet_invalid_prompt'),
        ('worksheet_invalid_answer'),
        ('worksheet_ambiguous_answer'),
        ('worksheet_invalid_explanation'),
        ('worksheet_invalid_accepted_answers'),
        ('worksheet_ambiguous_fill_blank'),
        ('worksheet_invalid_options'),
        ('worksheet_duplicate_options'),
        ('worksheet_answer_not_in_options'),
        ('worksheet_unexpected_options'),
        ('worksheet_level_mismatch'),
        ('worksheet_difficulty_mismatch'),
        ('worksheet_context_mismatch'),
        ('worksheet_invalid_title'),
        ('worksheet_generic_title'),
        ('worksheet_invalid_questions'),
        ('worksheet_question_count'),
        ('worksheet_duplicate_questions'),
        ('worksheet_unsafe_question_mix')
    ),
    expected_codes as (
      select array_agg(code order by code) as codes from expected
    ),
    constraint_codes as (
      select array_agg(match[1] order by match[1]) as codes
      from pg_constraint constraint_row
      cross join lateral regexp_matches(
        pg_get_constraintdef(constraint_row.oid),
        '''(worksheet_[a-z0-9_]+)''',
        'g'
      ) match
      where constraint_row.conrelid =
        'app_private.worksheet_generation_checkpoints'::regclass
        and constraint_row.conname =
          'worksheet_generation_checkpoints_fallback_shape_check'
    ),
    function_gate as (
      select split_part(
        split_part(
          routine.prosrc,
          'if primary_failure_code not in (',
          2
        ),
        ') then',
        1
      ) as source
      from pg_proc routine
      where routine.oid =
        'app_private.advance_worksheet_generation_fallback(uuid,bigint,uuid,integer,text)'::regprocedure
    ),
    function_codes as (
      select array_agg(match[1] order by match[1]) as codes
      from function_gate
      cross join lateral regexp_matches(
        function_gate.source,
        '''(worksheet_[a-z0-9_]+)''',
        'g'
      ) match
    )
    select expected_codes.codes = constraint_codes.codes
      and expected_codes.codes = function_codes.codes
    from expected_codes, constraint_codes, function_codes
  ),
  'constraint and transition RPC share the exact 30-code fallback allowlist'
);

select ok(
  (
    select position('lease_expires_at <= clock_timestamp()' in routine.prosrc) > 0
      and position('class_context_integrity' in routine.prosrc) > 0
      and position('workspace_members' in routine.prosrc) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.assert_active_worksheet_generation_lease(uuid,bigint,uuid,integer)'::regprocedure
  ),
  'every stage transition is bound to an unexpired active lease and class context'
);

select ok(
  (
    select position('jsonb_build_object' in routine.prosrc) > 0
      and position('''job_id''' in routine.prosrc) > 0
      and position('''job_kind''' in routine.prosrc) > 0
      and position('''entity_id''' in routine.prosrc) > 0
      and position('''entity_version''' in routine.prosrc) > 0
      and position('pgmq.send' in routine.prosrc) > 0
      and position('pgmq.archive' in routine.prosrc) > 0
      and position('rejected_candidate_payload' in routine.prosrc) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.advance_worksheet_generation_repair(uuid,bigint,uuid,integer,jsonb)'::regprocedure
  ),
  'repair transition source keeps candidate data out of the PGMQ payload'
);

create or replace function pg_temp.phase_13a_candidate(
  source_name text,
  candidate_attempt smallint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  questions jsonb;
  generator_model text := case source_name
    when 'deepseek' then 'deepseek-v4-pro'
    when 'gemini' then 'gemini-3.1-flash-lite'
    else 'invalid'
  end;
begin
  questions := jsonb_build_array(
    jsonb_build_object(
      'question_number', 1,
      'question_type', 'multiple_choice',
      'evaluation_mode', 'local_exact',
      'prompt', 'Welche Präposition bedeutet hier Begleitung?',
      'options', jsonb_build_array('mit', 'bei', 'für'),
      'correct_answer', 'mit',
      'accepted_answers', jsonb_build_array('mit'),
      'rubric', null,
      'explanation', 'Mit drückt in diesem Satz Begleitung aus.'
    ),
    jsonb_build_object(
      'question_number', 2,
      'question_type', 'multiple_choice',
      'evaluation_mode', 'local_exact',
      'prompt', 'Welche Präposition steht vor dem Ziel Berlin?',
      'options', jsonb_build_array('nach', 'mit', 'bei'),
      'correct_answer', 'nach',
      'accepted_answers', jsonb_build_array('nach'),
      'rubric', null,
      'explanation', 'Vor Städten ohne Artikel verwendet man nach.'
    ),
    jsonb_build_object(
      'question_number', 3,
      'question_type', 'fill_blank',
      'evaluation_mode', 'local_exact',
      'prompt', 'Bedeutung: Begleitung. Wortbank: [mit, bei, für]. Ergänze: Ich fahre ___ dem Bus.',
      'options', '[]'::jsonb,
      'correct_answer', 'mit',
      'accepted_answers', jsonb_build_array('mit'),
      'rubric', null,
      'explanation', 'Mit dem Bus bezeichnet das Verkehrsmittel.'
    ),
    jsonb_build_object(
      'question_number', 4,
      'question_type', 'fill_blank',
      'evaluation_mode', 'local_exact',
      'prompt', 'Bedeutung: Reiseziel. Wortbank: [nach, mit, bei]. Ergänze: Wir fahren ___ Berlin.',
      'options', '[]'::jsonb,
      'correct_answer', 'nach',
      'accepted_answers', jsonb_build_array('nach'),
      'rubric', null,
      'explanation', 'Nach steht vor dem Städtenamen Berlin.'
    ),
    jsonb_build_object(
      'question_number', 5,
      'question_type', 'sentence_correction',
      'evaluation_mode', 'open_evaluation',
      'prompt', 'Korrigiere vollständig: Ich fahre bei dem Bus zur Arbeit.',
      'options', '[]'::jsonb,
      'correct_answer', 'Ich fahre mit dem Bus zur Arbeit.',
      'accepted_answers', '[]'::jsonb,
      'rubric', jsonb_build_object(
        'criteria', jsonb_build_array(
          'Use mit for the means of transport and preserve the meaning.'
        ),
        'sample_answer', 'Ich fahre mit dem Bus zur Arbeit.'
      ),
      'explanation', 'Das Verkehrsmittel wird mit mit ausgedrückt.'
    ),
    jsonb_build_object(
      'question_number', 6,
      'question_type', 'word_order',
      'evaluation_mode', 'open_evaluation',
      'prompt', 'Ordne zu einem Satz: morgen / nach / fährt / sie / Köln.',
      'options', '[]'::jsonb,
      'correct_answer', 'Sie fährt morgen nach Köln.',
      'accepted_answers', '[]'::jsonb,
      'rubric', jsonb_build_object(
        'criteria', jsonb_build_array(
          'Form a grammatical main clause and use nach before Köln.'
        ),
        'sample_answer', 'Sie fährt morgen nach Köln.'
      ),
      'explanation', 'Nach steht direkt vor dem Städtenamen Köln.'
    ),
    jsonb_build_object(
      'question_number', 7,
      'question_type', 'multiple_choice',
      'evaluation_mode', 'local_exact',
      'prompt', 'Welche Präposition bezeichnet einen Aufenthaltsort bei Anna?',
      'options', jsonb_build_array('bei', 'nach', 'für'),
      'correct_answer', 'bei',
      'accepted_answers', jsonb_build_array('bei'),
      'rubric', null,
      'explanation', 'Bei bezeichnet den Aufenthalt bei einer Person.'
    ),
    jsonb_build_object(
      'question_number', 8,
      'question_type', 'fill_blank',
      'evaluation_mode', 'local_exact',
      'prompt', 'Bedeutung: Aufenthalt bei einer Person. Wortbank: [bei, nach, mit]. Ergänze: Er ist ___ Anna.',
      'options', '[]'::jsonb,
      'correct_answer', 'bei',
      'accepted_answers', jsonb_build_array('bei'),
      'rubric', null,
      'explanation', 'Bei Anna bedeutet am Ort dieser Person.'
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', source_name,
    'generator_model', generator_model,
    'title', case source_name
      when 'deepseek' then 'Präpositionen A1 - erster Entwurf'
      else 'Präpositionen A1 - reparierter Entwurf'
    end,
    'level', 'A1',
    'difficulty', 'easy',
    'description', 'Eine sichere A1-Übung zu häufigen lokalen Präpositionen.',
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Präpositionen zeigen Beziehungen zwischen Satzteilen.',
      'key_rule', 'Mit bezeichnet oft ein Mittel, nach ein Ziel und bei einen Ort.',
      'correct_examples', jsonb_build_array(
        'Ich fahre mit dem Bus.',
        'Wir fahren nach Berlin.'
      ),
      'common_mistake_warning', 'Verwechsle das Verkehrsmittel nicht mit dem Reiseziel.',
      'what_to_revise', 'Wiederhole mit, nach und bei in kurzen Sätzen.'
    ),
    'questions', questions,
    'source_mix', jsonb_build_object(
      'mode', source_name,
      'deepseek_count', case when source_name = 'deepseek' then 8 else 0 end,
      'gemini_count', case when source_name = 'gemini' then 8 else 0 end
    ),
    'validation', jsonb_build_object(
      'deterministic', true,
      'independent_model', false,
      'critic_model', null,
      'candidate_sha256', null,
      'critics', jsonb_build_object('deepseek', null, 'gemini', null),
      'attempt_count', candidate_attempt,
      'checks', null,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

create or replace function pg_temp.phase_13a_reviewed_candidate(
  candidate jsonb,
  approved boolean,
  candidate_attempt smallint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  candidate_hash text := app_private.worksheet_candidate_sha256(candidate);
  passing_checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  passing_content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_checks jsonb := passing_checks;
  combined_checks jsonb := passing_checks;
  deepseek_reasons jsonb := '[]'::jsonb;
  deepseek_critic jsonb;
  gemini_critic jsonb;
begin
  if not approved then
    deepseek_checks := jsonb_set(
      deepseek_checks,
      '{ambiguity_free}',
      'false'::jsonb
    );
    combined_checks := jsonb_set(
      combined_checks,
      '{ambiguity_free}',
      'false'::jsonb
    );
    deepseek_reasons := jsonb_build_array(
      'Question 3 needs a clearer semantic cue.'
    );
  end if;

  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_hash,
    'approved', approved,
    'checks', deepseek_checks,
    'content_checks', passing_content_checks,
    'rejection_reasons', deepseek_reasons
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );

  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-3.1-flash-lite',
    'candidate_sha256', candidate_hash,
    'approved', true,
    'checks', passing_checks,
    'content_checks', passing_content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  gemini_critic := gemini_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(gemini_critic)
  );

  return jsonb_set(
    candidate,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', approved,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_hash,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', candidate_attempt,
      'checks', combined_checks,
      'content_checks', passing_content_checks,
      'rejection_reasons', deepseek_reasons
    )
  );
end;
$$;

select lives_ok(
  $test$
  with normalized_rejection as (
    select jsonb_build_object(
      'provider', 'deepseek',
      'model', 'deepseek-v4-flash',
      'candidate_sha256', repeat('a', 64),
      'approved', false,
      'checks', jsonb_build_object(
        'ambiguity_free', true,
        'no_answer_leakage', true,
        'duplicate_free', true,
        'level_fit', true,
        'topic_fit', true,
        'type_balance', true,
        'scoring_safe', false
      ),
      'content_checks', jsonb_build_object(
        'mini_lesson_scope_accurate', true,
        'learner_cues_semantically_aligned', true,
        'examples_rubrics_consistent', true
      ),
      'rejection_reasons', jsonb_build_array(
        'Independent critic verdict was contradictory; repair required.'
      )
    ) as body
  )
  select app_private.assert_worksheet_critic_verdict(
    body || jsonb_build_object(
      'verdict_sha256',
      app_private.worksheet_critic_verdict_sha256(body)
    ),
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  )
  from normalized_rejection
  $test$,
  'a normalized contradictory critic is a durable rejection eligible for repair'
);

create temporary table phase_13a_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_13a_payloads (name, payload)
values
  ('primary', pg_temp.phase_13a_candidate('deepseek', 1::smallint)),
  ('fallback', pg_temp.phase_13a_candidate('gemini', 1::smallint)),
  ('repair', pg_temp.phase_13a_candidate('gemini', 2::smallint));

insert into phase_13a_payloads (name, payload)
select
  'primary_rejected',
  pg_temp.phase_13a_reviewed_candidate(payload, false, 1::smallint)
from phase_13a_payloads where name = 'primary';

insert into phase_13a_payloads (name, payload)
select
  'repair_approved',
  pg_temp.phase_13a_reviewed_candidate(payload, true, 2::smallint)
from phase_13a_payloads where name = 'repair';

-- Phase 13X independently proves the metered critic-save API. This older
-- checkpoint lifecycle suite seeds the exact already-validated critic bytes so
-- repair/completion transitions exercise the current dual-critic guard without
-- dispatching or fabricating provider spend.
create or replace function pg_temp.phase_13a_seed_critic_evidence(
  target_job_id uuid,
  reviewed_candidate jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  update app_private.worksheet_generation_checkpoints checkpoint
  set
    deepseek_critic_evidence =
      reviewed_candidate #> '{validation,critics,deepseek}',
    gemini_critic_evidence =
      reviewed_candidate #> '{validation,critics,gemini}'
  where checkpoint.job_id = target_job_id
    and checkpoint.stage in ('primary_critique', 'repair_critique')
    and checkpoint.candidate_sha256 =
      reviewed_candidate #>> '{validation,candidate_sha256}';

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'phase13a_critic_fixture_context_mismatch';
  end if;
end;
$$;

revoke all on function
  pg_temp.phase_13a_seed_critic_evidence(uuid, jsonb)
from public;
grant execute on function
  pg_temp.phase_13a_seed_critic_evidence(uuid, jsonb)
to service_role;

create or replace function pg_temp.claim_phase_13a_fixture_job(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  visibility_timeout_seconds integer default 300
)
returns table (
  job_id uuid,
  queue_message_id bigint,
  entity_id uuid,
  entity_version integer,
  attempt_number integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_payload jsonb;
  visibility_seconds integer := greatest(
    30,
    least(coalesce(visibility_timeout_seconds, 300), 600)
  );
begin
  perform app_private.assert_service_role();

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
    and job.queue_name = 'worksheet_generation'
    and job.queue_message_id = target_queue_message_id
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'phase_13a_fixture_job_not_found';
  end if;

  select queue.message
  into selected_payload
  from pgmq.q_worksheet_generation queue
  where queue.msg_id = target_queue_message_id
  for update;

  if selected_payload is distinct from jsonb_build_object(
    'job_id', selected_job.id,
    'job_kind', selected_job.job_kind,
    'entity_id', selected_job.entity_id,
    'entity_version', selected_job.entity_version
  ) then
    raise exception using
      errcode = '55000',
      message = 'phase_13a_fixture_message_mismatch';
  end if;

  update pgmq.q_worksheet_generation queue
  set
    vt = clock_timestamp() + make_interval(secs => visibility_seconds),
    read_ct = queue.read_ct + 1
  where queue.msg_id = target_queue_message_id
    and queue.vt <= clock_timestamp()
  returning queue.message into selected_payload;

  if selected_payload is null then
    raise exception using
      errcode = '55000',
      message = 'phase_13a_fixture_message_not_visible';
  end if;

  update app_private.async_jobs job
  set
    status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = target_worker_id,
    lease_expires_at = now() + make_interval(secs => visibility_seconds),
    first_started_at = coalesce(job.first_started_at, now()),
    last_started_at = now(),
    last_error_code = null
  where job.id = selected_job.id
    and job.available_at <= now()
    and (
      job.status in ('queued', 'retry')
      or (job.status = 'processing' and job.lease_expires_at <= now())
    )
  returning job.* into selected_job;

  if selected_job.id is null then
    raise exception using
      errcode = '55000',
      message = 'phase_13a_fixture_job_not_claimable';
  end if;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'processing',
    null
  );

  return query select
    selected_job.id,
    selected_job.queue_message_id,
    selected_job.entity_id,
    selected_job.entity_version,
    selected_job.attempt_count,
    selected_job.lease_expires_at;
end;
$$;

revoke all on function pg_temp.claim_phase_13a_fixture_job(
  uuid, bigint, uuid, integer
) from public;
grant execute on function pg_temp.claim_phase_13a_fixture_job(
  uuid, bigint, uuid, integer
) to service_role;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd1111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase13a-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13A Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase13a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13A Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd1666666-6666-4666-8666-666666666666',
  'Phase 13A Workspace',
  'phase-13a-workspace',
  'd1111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd1111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1666666-6666-4666-8666-666666666666',
  'd1111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1666666-6666-4666-8666-666666666666',
  'd1222222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'd1666666-6666-4666-8666-666666666666',
  'Phase 13A A1 Class',
  'A1',
  true,
  'd1111111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'd1666666-6666-4666-8666-666666666666',
  'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'd1222222-2222-4222-8222-222222222222'
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    'd1811111-1111-4111-8111-111111111111',
    'phase-13a-main-prepositions',
    'Phase 13A Main Prepositions',
    'A1',
    'Main resumable generation fixture.'
  ),
  (
    'd1822222-2222-4222-8222-222222222222',
    'phase-13a-dead-cleanup',
    'Phase 13A Dead Cleanup',
    'A1',
    'Terminal job cleanup fixture.'
  ),
  (
    'd1833333-3333-4333-8333-333333333333',
    'phase-13a-cancel-cleanup',
    'Phase 13A Cancel Cleanup',
    'A1',
    'Cancelled assignment cleanup fixture.'
  ),
  (
    'd1844444-4444-4444-8444-444444444444',
    'phase-13a-supersede-cleanup',
    'Phase 13A Supersede Cleanup',
    'A1',
    'Superseded version cleanup fixture.'
  ),
  (
    'd1855555-5555-4555-8555-555555555555',
    'phase-13a-primary-fallback',
    'Phase 13A Primary Fallback',
    'A1',
    'Transient primary-provider fallback fixture.'
  ),
  (
    'd1866666-6666-4666-8666-666666666666',
    'phase-13a-attempt-three-fallback',
    'Phase 13A Attempt Three Fallback',
    'A1',
    'Exact continuation claim at the ordinary attempt cap.'
  ),
  (
    'd1877777-7777-4777-8777-777777777777',
    'phase-13a-attempt-three-repair',
    'Phase 13A Attempt Three Repair',
    'A1',
    'Exact repair continuation claim at the ordinary attempt cap.'
  );

-- This checkpoint fixture starts after weakness detection. Seed its immutable
-- current-class cycle snapshots directly, then restore ordinary triggers for
-- every assignment, queue, checkpoint and completion mutation under test.
set local session_replication_role = replica;

insert into app_private.practice_resolution_cycles (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  cycle_number,
  state,
  state_reason,
  evidence_start_sequence,
  evidence_through_sequence,
  minor_issue_count,
  major_issue_count,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
select
  fixture.cycle_id,
  'd1666666-6666-4666-8666-666666666666',
  'd1222222-2222-4222-8222-222222222222',
  fixture.grammar_topic_id,
  1,
  'unlocked',
  'weakness_threshold_reached',
  1,
  0,
  0,
  0,
  'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'A1',
  1,
  'teacher_verified'
from (
  values
    (
      'd1c11111-1111-4111-8111-111111111111'::uuid,
      'd1811111-1111-4111-8111-111111111111'::uuid
    ),
    (
      'd1c22222-2222-4222-8222-222222222222'::uuid,
      'd1822222-2222-4222-8222-222222222222'::uuid
    ),
    (
      'd1c33333-3333-4333-8333-333333333333'::uuid,
      'd1833333-3333-4333-8333-333333333333'::uuid
    ),
    (
      'd1c44444-4444-4444-8444-444444444444'::uuid,
      'd1844444-4444-4444-8444-444444444444'::uuid
    ),
    (
      'd1c55555-5555-4555-8555-555555555555'::uuid,
      'd1855555-5555-4555-8555-555555555555'::uuid
    ),
    (
      'd1c66666-6666-4666-8666-666666666666'::uuid,
      'd1866666-6666-4666-8666-666666666666'::uuid
    ),
    (
      'd1c77777-7777-4777-8777-777777777777'::uuid,
      'd1877777-7777-4777-8777-777777777777'::uuid
    )
) as fixture(cycle_id, grammar_topic_id);

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  source,
  status,
  assigned_by,
  generation_status,
  generation_version
)
values
  (
    'd1b11111-1111-4111-8111-111111111111',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1811111-1111-4111-8111-111111111111',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c11111-1111-4111-8111-111111111111',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b22222-2222-4222-8222-222222222222',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1822222-2222-4222-8222-222222222222',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c22222-2222-4222-8222-222222222222',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b33333-3333-4333-8333-333333333333',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1833333-3333-4333-8333-333333333333',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c33333-3333-4333-8333-333333333333',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b44444-4444-4444-8444-444444444444',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1844444-4444-4444-8444-444444444444',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c44444-4444-4444-8444-444444444444',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b55555-5555-4555-8555-555555555555',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1855555-5555-4555-8555-555555555555',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c55555-5555-4555-8555-555555555555',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b66666-6666-4666-8666-666666666666',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1866666-6666-4666-8666-666666666666',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c66666-6666-4666-8666-666666666666',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  ),
  (
    'd1b77777-7777-4777-8777-777777777777',
    'd1666666-6666-4666-8666-666666666666',
    'd1222222-2222-4222-8222-222222222222',
    'd1877777-7777-4777-8777-777777777777',
    'd1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd1c77777-7777-4777-8777-777777777777',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'queued',
    1
  );

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = fixture.assignment_id,
  evidence_frozen_at = now(),
  state_reason = 'worksheet_ready'
from (
  values
    (
      'd1c11111-1111-4111-8111-111111111111'::uuid,
      'd1b11111-1111-4111-8111-111111111111'::uuid
    ),
    (
      'd1c22222-2222-4222-8222-222222222222'::uuid,
      'd1b22222-2222-4222-8222-222222222222'::uuid
    ),
    (
      'd1c33333-3333-4333-8333-333333333333'::uuid,
      'd1b33333-3333-4333-8333-333333333333'::uuid
    ),
    (
      'd1c44444-4444-4444-8444-444444444444'::uuid,
      'd1b44444-4444-4444-8444-444444444444'::uuid
    ),
    (
      'd1c55555-5555-4555-8555-555555555555'::uuid,
      'd1b55555-5555-4555-8555-555555555555'::uuid
    ),
    (
      'd1c66666-6666-4666-8666-666666666666'::uuid,
      'd1b66666-6666-4666-8666-666666666666'::uuid
    ),
    (
      'd1c77777-7777-4777-8777-777777777777'::uuid,
      'd1b77777-7777-4777-8777-777777777777'::uuid
    )
) as fixture(cycle_id, assignment_id)
where cycle.id = fixture.cycle_id;

create temporary table phase_13a_jobs (
  label text primary key,
  assignment_id uuid not null,
  job_id uuid not null,
  original_message_id bigint not null,
  current_message_id bigint not null,
  worker_id uuid not null
) on commit drop;

insert into phase_13a_jobs (
  label,
  assignment_id,
  job_id,
  original_message_id,
  current_message_id,
  worker_id
)
select
  fixture.label,
  fixture.assignment_id,
  queued.job_id,
  queued.queue_message_id,
  queued.queue_message_id,
  fixture.worker_id
from (
  values
    (
      'main'::text,
      'd1b11111-1111-4111-8111-111111111111'::uuid,
      'd1f11111-1111-4111-8111-111111111111'::uuid
    ),
    (
      'dead',
      'd1b22222-2222-4222-8222-222222222222'::uuid,
      'd1f22222-2222-4222-8222-222222222222'::uuid
    ),
    (
      'cancel',
      'd1b33333-3333-4333-8333-333333333333'::uuid,
      'd1f33333-3333-4333-8333-333333333333'::uuid
    ),
    (
      'supersede',
      'd1b44444-4444-4444-8444-444444444444'::uuid,
      'd1f44444-4444-4444-8444-444444444444'::uuid
    ),
    (
      'fallback',
      'd1b55555-5555-4555-8555-555555555555'::uuid,
      'd1f55555-5555-4555-8555-555555555555'::uuid
    ),
    (
      'attempt3_fallback',
      'd1b66666-6666-4666-8666-666666666666'::uuid,
      'd1f66666-6666-4666-8666-666666666666'::uuid
    ),
    (
      'attempt3_repair',
      'd1b77777-7777-4777-8777-777777777777'::uuid,
      'd1f77777-7777-4777-8777-777777777777'::uuid
    )
) fixture(label, assignment_id, worker_id)
cross join lateral app_private.enqueue_async_job(
  'worksheet_generation',
  fixture.assignment_id,
  1,
  format('phase-13a-checkpoint:%s:1', fixture.assignment_id),
  'd1111111-1111-4111-8111-111111111111',
  0
) queued;

-- These two fixtures enter their current primary delivery with two prior
-- ordinary failures. The fixture claim below increments them to attempt three;
-- the production claim function must then grant the exact new continuation
-- message one fresh attempt without resetting this history.
update app_private.async_jobs job
set attempt_count = 2
where job.id in (
  select fixture.job_id
  from phase_13a_jobs fixture
  where fixture.label in ('attempt3_fallback', 'attempt3_repair')
);

grant select, update on table phase_13a_jobs to service_role;
grant select on table phase_13a_jobs to authenticated;
grant select on table phase_13a_payloads to service_role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select current_message_id from phase_13a_jobs where label = 'main'),
  (select worker_id from phase_13a_jobs where label = 'main')
);

select is(
  (
    select count(*)::integer
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1
    )
  ),
  0,
  'no checkpoint row is the canonical primary_generation state'
);

select is(
  (
    select jsonb_build_object(
      'stage', saved.stage,
      'attempt', saved.candidate_attempt,
      'created', saved.created
    )
    from api.save_worksheet_generation_candidate(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1,
      1::smallint,
      app_private.worksheet_candidate_sha256(
        (select payload from phase_13a_payloads where name = 'primary')
      ),
      (select payload from phase_13a_payloads where name = 'primary')
    ) saved
  ),
  '{"stage":"primary_critique","attempt":1,"created":true}'::jsonb,
  'saving a valid first candidate advances to primary_critique'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.worksheet_generation_checkpoints checkpoint
    join phase_13a_jobs fixture on fixture.job_id = checkpoint.job_id
    where fixture.label = 'main'
      and checkpoint.assignment_id = fixture.assignment_id
      and checkpoint.entity_version = 1
      and checkpoint.stage = 'primary_critique'
      and checkpoint.candidate_provider = 'deepseek'
      and checkpoint.candidate_model = 'deepseek-v4-pro'
      and checkpoint.candidate_sha256 =
        app_private.worksheet_candidate_sha256(checkpoint.candidate)
  ),
  'the private row binds job, assignment, version, model, body, and hash'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select saved.created
    from api.save_worksheet_generation_candidate(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1,
      1::smallint,
      app_private.worksheet_candidate_sha256(
        (select payload from phase_13a_payloads where name = 'primary')
      ),
      (select payload from phase_13a_payloads where name = 'primary')
    ) saved
  ),
  false,
  'an exact candidate replay is idempotent'
);

select throws_ok(
  format(
    'select * from api.save_worksheet_generation_candidate(%L::uuid,%s,%L::uuid,1,1::smallint,%L,%L::jsonb)',
    (select job_id from phase_13a_jobs where label = 'main'),
    (select current_message_id from phase_13a_jobs where label = 'main'),
    (select worker_id from phase_13a_jobs where label = 'main'),
    repeat('0', 64),
    (select payload::text from phase_13a_payloads where name = 'primary')
  ),
  '22023',
  'worksheet_checkpoint_candidate_validation_invalid',
  'a caller-supplied candidate hash cannot disagree with the body'
);

select throws_ok(
  format(
    'select * from api.get_worksheet_generation_checkpoint(%L::uuid,%s,%L::uuid,1)',
    (select job_id from phase_13a_jobs where label = 'main'),
    (select current_message_id from phase_13a_jobs where label = 'main'),
    'd1ffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  '55000',
  'worksheet_checkpoint_lease_stale',
  'a different worker cannot read the active checkpoint'
);

select is(
  (
    select jsonb_build_object(
      'stage', checkpoint.stage,
      'attempt', checkpoint.candidate_attempt,
      'source', checkpoint.candidate_provider,
      'has_candidate', checkpoint.candidate is not null,
      'has_completion', checkpoint.completion_payload is not null
    )
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1
    ) checkpoint
  ),
  '{
    "stage":"primary_critique",
    "attempt":1,
    "source":"deepseek",
    "has_candidate":true,
    "has_completion":false
  }'::jsonb,
  'the exact lease loads only the persisted primary-critique state'
);

select pg_temp.phase_13a_seed_critic_evidence(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select payload from phase_13a_payloads where name = 'primary_rejected')
);

create temporary table phase_13a_transition on commit drop as
select transition.*
from api.advance_worksheet_generation_repair(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select current_message_id from phase_13a_jobs where label = 'main'),
  (select worker_id from phase_13a_jobs where label = 'main'),
  1,
  (select payload from phase_13a_payloads where name = 'primary_rejected')
) transition;

grant select on table phase_13a_transition to service_role;

select is(
  (
    select jsonb_build_object(
      'stage', stage,
      'status', status,
      'attempt_count', attempt_count,
      'replayed', replayed,
      'immediate', next_attempt_at <= now() + interval '1 second'
    )
    from phase_13a_transition
  ),
  '{
    "stage":"repair_generation",
    "status":"retry",
    "attempt_count":1,
    "replayed":false,
    "immediate":true
  }'::jsonb,
  'first rejection atomically returns an immediately claimable repair retry'
);

update phase_13a_jobs fixture
set
  current_message_id = transition.next_queue_message_id,
  worker_id = 'd1f51111-1111-4111-8111-111111111111'
from phase_13a_transition transition
where fixture.label = 'main';

reset role;

select ok(
  not exists (
    select 1
    from pgmq.q_worksheet_generation queue
    where queue.msg_id = (
      select original_message_id
      from phase_13a_jobs
      where label = 'main'
    )
  )
    and exists (
      select 1
      from pgmq.a_worksheet_generation archive
      where archive.msg_id = (
        select original_message_id
        from phase_13a_jobs
        where label = 'main'
      )
    )
    and (
      select queue.message
      from pgmq.q_worksheet_generation queue
      where queue.msg_id = (
        select current_message_id
        from phase_13a_jobs
        where label = 'main'
      )
    ) = jsonb_build_object(
      'job_id', (select job_id from phase_13a_jobs where label = 'main'),
      'job_kind', 'worksheet_generation',
      'entity_id', (
        select assignment_id from phase_13a_jobs where label = 'main'
      ),
      'entity_version', 1
    ),
  'the old message is archived and the repair message contains IDs/version only'
);

select ok(
  exists (
    select 1
    from app_private.worksheet_generation_checkpoints checkpoint
    join phase_13a_jobs fixture on fixture.job_id = checkpoint.job_id
    where fixture.label = 'main'
      and checkpoint.stage = 'repair_generation'
      and checkpoint.candidate_attempt = 2
      and checkpoint.candidate is null
      and checkpoint.candidate_sha256 is null
  )
    and exists (
      select 1
      from app_private.worksheet_generation_stage_evidence evidence
      join phase_13a_jobs fixture on fixture.job_id = evidence.job_id
      where fixture.label = 'main'
        and evidence.candidate_provider = 'deepseek'
        and evidence.candidate_model = 'deepseek-v4-pro'
        and evidence.candidate_sha256 =
          app_private.worksheet_candidate_sha256(
            evidence.rejected_candidate
          )
        and evidence.rejection_reasons =
          '["Question 3 needs a clearer semantic cue."]'::jsonb
    ),
  'active state advances without losing immutable first-rejection evidence'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select replay.replayed
    from api.advance_worksheet_generation_repair(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select original_message_id from phase_13a_jobs where label = 'main'),
      'd1f11111-1111-4111-8111-111111111111',
      1,
      (select payload from phase_13a_payloads where name = 'primary_rejected')
    ) replay
  ),
  true,
  'an exact lost-response repair transition replay is idempotent'
);

reset role;

select is(
  (
    select count(*)::integer
    from pgmq.q_worksheet_generation queue
    where queue.message ->> 'job_id' = (
      select job_id::text from phase_13a_jobs where label = 'main'
    )
  ),
  1,
  'repair transition replay does not enqueue a duplicate message'
);

select throws_ok(
  format(
    'update app_private.worksheet_generation_stage_evidence set rejection_reasons = %L::jsonb where job_id = %L::uuid',
    '["tampered"]',
    (select job_id from phase_13a_jobs where label = 'main')
  ),
  '55000',
  'worksheet_bank_history_immutable',
  'first-rejection evidence is immutable even to direct privileged SQL'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select current_message_id from phase_13a_jobs where label = 'main'),
  (select worker_id from phase_13a_jobs where label = 'main')
);

reset role;

select is(
  (
    select attempt_number
    from app_private.async_jobs job
    cross join lateral (
      select job.attempt_count as attempt_number
    ) claimed
    where job.id = (select job_id from phase_13a_jobs where label = 'main')
  ),
  2,
  'the immediate repair message becomes the second durable delivery attempt'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select jsonb_build_object(
      'stage', checkpoint.stage,
      'candidate', checkpoint.candidate,
      'prior_attempt', checkpoint.primary_rejection -> 'attempt_number',
      'prior_provider', checkpoint.primary_rejection -> 'provider',
      'prior_reasons', checkpoint.primary_rejection -> 'rejection_reasons'
    )
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1
    ) checkpoint
  ),
  '{
    "stage":"repair_generation",
    "candidate":null,
    "prior_attempt":1,
    "prior_provider":"deepseek",
    "prior_reasons":["Question 3 needs a clearer semantic cue."]
  }'::jsonb,
  'repair generation resumes with the exact archived first rejection'
);

select is(
  (
    select jsonb_build_object(
      'stage', saved.stage,
      'attempt', saved.candidate_attempt,
      'created', saved.created
    )
    from api.save_worksheet_generation_candidate(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1,
      2::smallint,
      app_private.worksheet_candidate_sha256(
        (select payload from phase_13a_payloads where name = 'repair')
      ),
      (select payload from phase_13a_payloads where name = 'repair')
    ) saved
  ),
  '{"stage":"repair_critique","attempt":2,"created":true}'::jsonb,
  'saving the Gemini repair advances to repair_critique'
);

select is(
  (
    select jsonb_build_object(
      'stage', checkpoint.stage,
      'source', checkpoint.candidate_provider,
      'model', checkpoint.candidate_model,
      'attempt', checkpoint.candidate_attempt
    )
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1
    ) checkpoint
  ),
  '{
    "stage":"repair_critique",
    "source":"gemini",
    "model":"gemini-3.1-flash-lite",
    "attempt":2
  }'::jsonb,
  'repair checkpoint pins the strong Gemini generator contract'
);

select pg_temp.phase_13a_seed_critic_evidence(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select payload from phase_13a_payloads where name = 'repair_approved')
);

select is(
  (
    select jsonb_build_object(
      'stage', saved.stage,
      'replayed', saved.replayed,
      'hash_valid', saved.completion_sha256 ~ '^[a-f0-9]{64}$'
    )
    from api.save_worksheet_generation_completion(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1,
      (select payload from phase_13a_payloads where name = 'repair_approved')
    ) saved
  ),
  '{"stage":"completion","replayed":false,"hash_valid":true}'::jsonb,
  'approved dual-critic evidence becomes a durable completion checkpoint'
);

select is(
  (
    select saved.replayed
    from api.save_worksheet_generation_completion(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1,
      (select payload from phase_13a_payloads where name = 'repair_approved')
    ) saved
  ),
  true,
  'an exact completion checkpoint replay does not repeat critic work'
);

select is(
  (
    select jsonb_build_object(
      'stage', checkpoint.stage,
      'candidate', checkpoint.candidate,
      'completion_matches', checkpoint.completion_payload = (
        select payload
        from phase_13a_payloads
        where name = 'repair_approved'
      ),
      'has_prior_rejection', checkpoint.primary_rejection is not null
    )
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'main'),
      (select current_message_id from phase_13a_jobs where label = 'main'),
      (select worker_id from phase_13a_jobs where label = 'main'),
      1
    ) checkpoint
  ),
  '{
    "stage":"completion",
    "candidate":null,
    "completion_matches":true,
    "has_prior_rejection":true
  }'::jsonb,
  'completion resume returns the exact validated payload and rejection history'
);

create temporary table phase_13a_completion_result on commit drop as
select completed.*
from api.complete_worksheet_generation(
  (select job_id from phase_13a_jobs where label = 'main'),
  (select current_message_id from phase_13a_jobs where label = 'main'),
  (select worker_id from phase_13a_jobs where label = 'main'),
  (select payload from phase_13a_payloads where name = 'repair_approved')
) completed;

select is(
  (
    select jsonb_build_object(
      'assignment', assignment_id,
      'generation_status', generation_status,
      'quality_status', quality_status,
      'has_test', practice_test_id is not null
    )
    from phase_13a_completion_result
  ),
  '{
    "assignment":"d1b11111-1111-4111-8111-111111111111",
    "generation_status":"ready",
    "quality_status":"approved",
    "has_test":true
  }'::jsonb,
  'the existing completion facade accepts and materializes the resumed repair'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_checkpoints checkpoint
    where checkpoint.job_id = (
      select job_id from phase_13a_jobs where label = 'main'
    )
  ),
  0,
  'successful completion removes the active checkpoint'
);

select ok(
  exists (
    select 1
    from app_private.worksheet_generation_stage_evidence evidence
    where evidence.job_id = (
      select job_id from phase_13a_jobs where label = 'main'
    )
  ),
  'successful completion retains immutable first-rejection evidence'
);

select ok(
  exists (
    select 1
    from public.practice_tests worksheet
    join phase_13a_completion_result result
      on result.practice_test_id = worksheet.id
    where worksheet.generation_source = 'gemini'
      and worksheet.generator_model = 'gemini-3.1-flash-lite'
      and worksheet.quality_status = 'approved'
  ),
  'materialized repair preserves truthful Gemini provenance'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'fallback'),
  (select current_message_id from phase_13a_jobs where label = 'fallback'),
  (select worker_id from phase_13a_jobs where label = 'fallback')
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    (select worker_id from phase_13a_jobs where label = 'fallback'),
    'worksheet_provider_authentication_failed'
  ),
  '22023',
  'worksheet_checkpoint_primary_failure_invalid',
  'provider authentication failures cannot enter fallback'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    (select worker_id from phase_13a_jobs where label = 'fallback'),
    'worksheet_provider_not_configured'
  ),
  '22023',
  'worksheet_checkpoint_primary_failure_invalid',
  'provider configuration failures cannot enter fallback'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    (select worker_id from phase_13a_jobs where label = 'fallback'),
    'worksheet_provider_model_invalid'
  ),
  '22023',
  'worksheet_checkpoint_primary_failure_invalid',
  'invalid provider models cannot enter fallback'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    (select worker_id from phase_13a_jobs where label = 'fallback'),
    'worksheet_provider_redirect_rejected'
  ),
  '22023',
  'worksheet_checkpoint_primary_failure_invalid',
  'provider redirect rejections cannot enter fallback'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    (select worker_id from phase_13a_jobs where label = 'fallback'),
    'worksheet_provider_rejected'
  ),
  '22023',
  'worksheet_checkpoint_primary_failure_invalid',
  'provider request rejections cannot enter fallback'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (select current_message_id from phase_13a_jobs where label = 'fallback'),
    'd1ffffff-ffff-4fff-8fff-ffffffffffff',
    'worksheet_provider_timeout'
  ),
  '55000',
  'worksheet_checkpoint_lease_stale',
  'a stale worker cannot create the fallback stage'
);

create temporary table phase_13a_fallback_transition on commit drop as
select transition.*
from api.advance_worksheet_generation_fallback(
  (select job_id from phase_13a_jobs where label = 'fallback'),
  (select current_message_id from phase_13a_jobs where label = 'fallback'),
  (select worker_id from phase_13a_jobs where label = 'fallback'),
  1,
  'worksheet_provider_invalid_json'
) transition;

grant select on table phase_13a_fallback_transition to service_role;

select is(
  (
    select jsonb_build_object(
      'stage', stage,
      'status', status,
      'attempt_count', attempt_count,
      'replayed', replayed,
      'immediate', next_attempt_at <= now() + interval '1 second'
    )
    from phase_13a_fallback_transition
  ),
  '{
    "stage":"primary_fallback_generation",
    "status":"retry",
    "attempt_count":1,
    "replayed":false,
    "immediate":true
  }'::jsonb,
  'malformed primary output atomically becomes an immediate durable fallback stage'
);

update phase_13a_jobs fixture
set
  current_message_id = transition.next_queue_message_id,
  worker_id = 'd1f56666-6666-4666-8666-666666666666'
from phase_13a_fallback_transition transition
where fixture.label = 'fallback';

reset role;

select ok(
  not exists (
    select 1
    from pgmq.q_worksheet_generation queue
    where queue.msg_id = (
      select original_message_id
      from phase_13a_jobs
      where label = 'fallback'
    )
  )
    and exists (
      select 1
      from pgmq.a_worksheet_generation archive
      where archive.msg_id = (
        select original_message_id
        from phase_13a_jobs
        where label = 'fallback'
      )
    )
    and (
      select queue.message
      from pgmq.q_worksheet_generation queue
      where queue.msg_id = (
        select current_message_id
        from phase_13a_jobs
        where label = 'fallback'
      )
    ) = jsonb_build_object(
      'job_id', (select job_id from phase_13a_jobs where label = 'fallback'),
      'job_kind', 'worksheet_generation',
      'entity_id', (
        select assignment_id from phase_13a_jobs where label = 'fallback'
      ),
      'entity_version', 1
    )
    and exists (
      select 1
      from app_private.worksheet_generation_checkpoints checkpoint
      where checkpoint.job_id = (
        select job_id from phase_13a_jobs where label = 'fallback'
      )
        and checkpoint.stage = 'primary_fallback_generation'
        and checkpoint.candidate_attempt = 1
        and checkpoint.candidate is null
        and checkpoint.candidate_provider is null
        and checkpoint.fallback_failure_code = 'worksheet_provider_invalid_json'
    )
    and not exists (
      select 1
      from app_private.worksheet_generation_stage_evidence evidence
      where evidence.job_id = (
        select job_id from phase_13a_jobs where label = 'fallback'
      )
    ),
  'fallback queue payload is ID-only and creates no semantic rejection evidence'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select replay.replayed
    from api.advance_worksheet_generation_fallback(
      (select job_id from phase_13a_jobs where label = 'fallback'),
      (
        select original_message_id
        from phase_13a_jobs
        where label = 'fallback'
      ),
      'd1f55555-5555-4555-8555-555555555555',
      1,
      'worksheet_provider_invalid_json'
    ) replay
  ),
  true,
  'exact primary-fallback transition replay is idempotent'
);

select throws_ok(
  format(
    'select * from api.advance_worksheet_generation_fallback(%L::uuid,%s,%L::uuid,1,%L)',
    (select job_id from phase_13a_jobs where label = 'fallback'),
    (
      select original_message_id
      from phase_13a_jobs
      where label = 'fallback'
    ),
    'd1f55555-5555-4555-8555-555555555555',
    'worksheet_invalid_shape'
  ),
  '55000',
  'worksheet_checkpoint_fallback_replay_mismatch',
  'fallback replay cannot change its classified primary failure'
);

select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'fallback'),
  (select current_message_id from phase_13a_jobs where label = 'fallback'),
  (select worker_id from phase_13a_jobs where label = 'fallback')
);

select is(
  (
    select jsonb_build_object(
      'stage', checkpoint.stage,
      'attempt', checkpoint.candidate_attempt,
      'candidate', checkpoint.candidate,
      'failure_code', checkpoint.fallback_failure_code,
      'rejection', checkpoint.primary_rejection
    )
    from api.get_worksheet_generation_checkpoint(
      (select job_id from phase_13a_jobs where label = 'fallback'),
      (select current_message_id from phase_13a_jobs where label = 'fallback'),
      (select worker_id from phase_13a_jobs where label = 'fallback'),
      1
    ) checkpoint
  ),
  '{
    "stage":"primary_fallback_generation",
    "attempt":1,
    "candidate":null,
    "failure_code":"worksheet_provider_invalid_json",
    "rejection":null
  }'::jsonb,
  'fallback resume preserves its exact failure code without a fabricated rejection'
);

select ok(
  pg_get_function_result(
    'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure
  ) like '%fallback_failure_code text%',
  'the public service facade declares the content-free fallback failure code'
);

select is(
  (
    select jsonb_build_object(
      'stage', saved.stage,
      'attempt', saved.candidate_attempt,
      'created', saved.created
    )
    from api.save_worksheet_generation_candidate(
      (select job_id from phase_13a_jobs where label = 'fallback'),
      (select current_message_id from phase_13a_jobs where label = 'fallback'),
      (select worker_id from phase_13a_jobs where label = 'fallback'),
      1,
      1::smallint,
      app_private.worksheet_candidate_sha256(
        (select payload from phase_13a_payloads where name = 'fallback')
      ),
      (select payload from phase_13a_payloads where name = 'fallback')
    ) saved
  ),
  '{"stage":"primary_critique","attempt":1,"created":true}'::jsonb,
  'fresh-budget Gemini fallback candidate advances to primary_critique'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.worksheet_generation_checkpoints checkpoint
    where checkpoint.job_id = (
      select job_id from phase_13a_jobs where label = 'fallback'
    )
      and checkpoint.stage = 'primary_critique'
      and checkpoint.candidate_provider = 'gemini'
      and checkpoint.candidate_model = 'gemini-3.1-flash-lite'
      and checkpoint.fallback_primary_queue_message_id = (
        select original_message_id
        from phase_13a_jobs
        where label = 'fallback'
      )
      and checkpoint.fallback_queue_message_id = (
        select current_message_id
        from phase_13a_jobs
        where label = 'fallback'
      )
  )
    and not exists (
      select 1
      from app_private.worksheet_generation_stage_evidence evidence
      where evidence.job_id = (
        select job_id from phase_13a_jobs where label = 'fallback'
      )
    ),
  'fallback replay identity survives candidate save without rejection evidence'
);

select pgmq.archive(
  'worksheet_generation',
  (select current_message_id from phase_13a_jobs where label = 'fallback')
);
update app_private.async_jobs job
set
  status = 'dead',
  worker_id = null,
  lease_expires_at = null,
  dead_at = now(),
  last_error_code = 'phase_13a_fallback_cleanup'
where job.id = (select job_id from phase_13a_jobs where label = 'fallback');

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_checkpoints checkpoint
    where checkpoint.job_id = (
      select job_id from phase_13a_jobs where label = 'fallback'
    )
  ),
  0,
  'terminal fallback work cleans its active checkpoint'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

-- Prepare three independent active checkpoints for explicit-live, dead,
-- cancelled-assignment, and superseded-version cleanup behavior.
select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'dead'),
  (select current_message_id from phase_13a_jobs where label = 'dead'),
  (select worker_id from phase_13a_jobs where label = 'dead')
);
select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'cancel'),
  (select current_message_id from phase_13a_jobs where label = 'cancel'),
  (select worker_id from phase_13a_jobs where label = 'cancel')
);
select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'supersede'),
  (select current_message_id from phase_13a_jobs where label = 'supersede'),
  (select worker_id from phase_13a_jobs where label = 'supersede')
);

select *
from phase_13a_jobs fixture
cross join lateral api.save_worksheet_generation_candidate(
  fixture.job_id,
  fixture.current_message_id,
  fixture.worker_id,
  1,
  1::smallint,
  app_private.worksheet_candidate_sha256(
    (select payload from phase_13a_payloads where name = 'primary')
  ),
  (select payload from phase_13a_payloads where name = 'primary')
) saved
where fixture.label in ('dead', 'cancel', 'supersede');

select pg_temp.phase_13a_seed_critic_evidence(
  fixture.job_id,
  (select payload from phase_13a_payloads where name = 'primary_rejected')
)
from phase_13a_jobs fixture
where fixture.label in ('dead', 'cancel');

create temporary table phase_13a_cancel_transition on commit drop as
select transition.*
from api.advance_worksheet_generation_repair(
  (select job_id from phase_13a_jobs where label = 'cancel'),
  (select current_message_id from phase_13a_jobs where label = 'cancel'),
  (select worker_id from phase_13a_jobs where label = 'cancel'),
  1,
  (select payload from phase_13a_payloads where name = 'primary_rejected')
) transition;

update phase_13a_jobs fixture
set current_message_id = transition.next_queue_message_id
from phase_13a_cancel_transition transition
where fixture.label = 'cancel';

select throws_ok(
  format(
    'select api.clear_worksheet_generation_checkpoint(%L::uuid,1)',
    (select job_id from phase_13a_jobs where label = 'dead')
  ),
  '55000',
  'worksheet_checkpoint_still_active',
  'explicit cleanup cannot erase a live active checkpoint'
);

create temporary table phase_13a_dead_transition on commit drop as
select transition.*
from api.advance_worksheet_generation_repair(
  (select job_id from phase_13a_jobs where label = 'dead'),
  (select current_message_id from phase_13a_jobs where label = 'dead'),
  (select worker_id from phase_13a_jobs where label = 'dead'),
  1,
  (select payload from phase_13a_payloads where name = 'primary_rejected')
) transition;

update phase_13a_jobs fixture
set current_message_id = transition.next_queue_message_id
from phase_13a_dead_transition transition
where fixture.label = 'dead';

reset role;

select pgmq.archive(
  'worksheet_generation',
  (select current_message_id from phase_13a_jobs where label = 'dead')
);
update app_private.async_jobs job
set
  status = 'dead',
  worker_id = null,
  lease_expires_at = null,
  dead_at = now(),
  last_error_code = 'phase_13a_terminal_test'
where job.id = (select job_id from phase_13a_jobs where label = 'dead');

select is(
  (
    select jsonb_build_object(
      'active_count', (
        select count(*)
        from app_private.worksheet_generation_checkpoints checkpoint
        where checkpoint.job_id = (
          select job_id from phase_13a_jobs where label = 'dead'
        )
      ),
      'evidence_count', (
        select count(*)
        from app_private.worksheet_generation_stage_evidence evidence
        where evidence.job_id = (
          select job_id from phase_13a_jobs where label = 'dead'
        )
      )
    )
  ),
  '{"active_count":0,"evidence_count":1}'::jsonb,
  'dead-job transition removes active state but retains rejection evidence'
);

delete from app_private.async_jobs job
where job.id = (select job_id from phase_13a_jobs where label = 'dead');

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_stage_evidence evidence
    where evidence.job_id = (
      select job_id from phase_13a_jobs where label = 'dead'
    )
  ),
  0,
  'parent job retention deletion cascades the private evidence row'
);

update public.student_practice_assignments assignment
set
  status = 'cancelled',
  generation_status = 'failed',
  generation_completed_at = now(),
  generation_error = 'phase_13a_cancelled'
where assignment.id = (
  select assignment_id from phase_13a_jobs where label = 'cancel'
);

select is(
  (
    select jsonb_build_object(
      'active_count', (
        select count(*)
        from app_private.worksheet_generation_checkpoints checkpoint
        where checkpoint.job_id = (
          select job_id from phase_13a_jobs where label = 'cancel'
        )
      ),
      'evidence_count', (
        select count(*)
        from app_private.worksheet_generation_stage_evidence evidence
        where evidence.job_id = (
          select job_id from phase_13a_jobs where label = 'cancel'
        )
      )
    )
  ),
  '{"active_count":0,"evidence_count":1}'::jsonb,
  'cancellation removes active state but retains rejection audit evidence'
);

-- The current adaptive contract appends a durable status-transition row for
-- this fixture-only cancellation. This suite next deletes its synthetic parent
-- solely to verify stage-evidence retention cascades, so remove that unrelated
-- outbox fixture first; transition durability is covered by Phase 13F.
delete from app_private.practice_assignment_cycle_transition_jobs transition
where transition.assignment_id = (
  select assignment_id from phase_13a_jobs where label = 'cancel'
);

delete from public.student_practice_assignments assignment
where assignment.id = (
  select assignment_id from phase_13a_jobs where label = 'cancel'
);

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_stage_evidence evidence
    where evidence.job_id = (
      select job_id from phase_13a_jobs where label = 'cancel'
    )
  ),
  0,
  'parent assignment retention deletion cascades the private evidence row'
);

select pgmq.archive(
  'worksheet_generation',
  (select current_message_id from phase_13a_jobs where label = 'cancel')
);
update app_private.async_jobs job
set
  status = 'dead',
  worker_id = null,
  lease_expires_at = null,
  dead_at = now(),
  last_error_code = 'phase_13a_cancelled'
where job.id = (select job_id from phase_13a_jobs where label = 'cancel');

update public.student_practice_assignments assignment
set generation_version = 2
where assignment.id = (
  select assignment_id from phase_13a_jobs where label = 'supersede'
);

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_checkpoints checkpoint
    where checkpoint.job_id = (
      select job_id from phase_13a_jobs where label = 'supersede'
    )
  ),
  0,
  'superseding the entity version removes the stale active checkpoint'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  api.clear_worksheet_generation_checkpoint(
    (select job_id from phase_13a_jobs where label = 'dead'),
    1
  ),
  false,
  'terminal cleanup is idempotent when the trigger already removed the row'
);

-- The ordinary budget is already exhausted when these two primary deliveries
-- finish. Each transition creates one exact, durable continuation ID which the
-- production claim function must execute once with monotonic attempt history.
select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'attempt3_fallback'),
  (select current_message_id from phase_13a_jobs where label = 'attempt3_fallback'),
  (select worker_id from phase_13a_jobs where label = 'attempt3_fallback')
);

select *
from pg_temp.claim_phase_13a_fixture_job(
  (select job_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select current_message_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select worker_id from phase_13a_jobs where label = 'attempt3_repair')
);

select *
from api.save_worksheet_generation_candidate(
  (select job_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select current_message_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select worker_id from phase_13a_jobs where label = 'attempt3_repair'),
  1,
  1::smallint,
  app_private.worksheet_candidate_sha256(
    (select payload from phase_13a_payloads where name = 'primary')
  ),
  (select payload from phase_13a_payloads where name = 'primary')
);

select pg_temp.phase_13a_seed_critic_evidence(
  (select job_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select payload from phase_13a_payloads where name = 'primary_rejected')
);

create temporary table phase_13a_attempt3_fallback_transition
on commit drop as
select transition.*
from api.advance_worksheet_generation_fallback(
  (select job_id from phase_13a_jobs where label = 'attempt3_fallback'),
  (select current_message_id from phase_13a_jobs where label = 'attempt3_fallback'),
  (select worker_id from phase_13a_jobs where label = 'attempt3_fallback'),
  1,
  'worksheet_provider_timeout'
) transition;

create temporary table phase_13a_attempt3_repair_transition
on commit drop as
select transition.*
from api.advance_worksheet_generation_repair(
  (select job_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select current_message_id from phase_13a_jobs where label = 'attempt3_repair'),
  (select worker_id from phase_13a_jobs where label = 'attempt3_repair'),
  1,
  (select payload from phase_13a_payloads where name = 'primary_rejected')
) transition;

grant select on table
  phase_13a_attempt3_fallback_transition,
  phase_13a_attempt3_repair_transition
to service_role;

select is(
  jsonb_build_object(
    'fallback_attempt', (
      select attempt_count
      from phase_13a_attempt3_fallback_transition
    ),
    'fallback_status', (
      select status
      from phase_13a_attempt3_fallback_transition
    ),
    'repair_attempt', (
      select attempt_count
      from phase_13a_attempt3_repair_transition
    ),
    'repair_status', (
      select status
      from phase_13a_attempt3_repair_transition
    )
  ),
  '{
    "fallback_attempt":3,
    "fallback_status":"retry",
    "repair_attempt":3,
    "repair_status":"retry"
  }'::jsonb,
  'fallback and repair transitions preserve the exhausted ordinary attempt count'
);

update phase_13a_jobs fixture
set
  current_message_id = case fixture.label
    when 'attempt3_fallback' then (
      select next_queue_message_id
      from phase_13a_attempt3_fallback_transition
    )
    else (
      select next_queue_message_id
      from phase_13a_attempt3_repair_transition
    )
  end,
  worker_id = 'd1f88888-8888-4888-8888-888888888888'
where fixture.label in ('attempt3_fallback', 'attempt3_repair');

create temporary table phase_13a_attempt3_claims on commit drop as
select claimed.*
from api.claim_async_jobs(
  'worksheet_generation',
  'd1f88888-8888-4888-8888-888888888888',
  10,
  300
) claimed;

grant select on table phase_13a_attempt3_claims to service_role;

select is(
  jsonb_build_object(
    'row_count', (select count(*) from phase_13a_attempt3_claims),
    'attempts', (
      select jsonb_object_agg(
        fixture.label,
        claimed.attempt_number
        order by fixture.label
      )
      from phase_13a_attempt3_claims claimed
      join phase_13a_jobs fixture
        on fixture.job_id = claimed.job_id
      where fixture.label in ('attempt3_fallback', 'attempt3_repair')
    )
  ),
  '{
    "row_count":2,
    "attempts":{"attempt3_fallback":4,"attempt3_repair":4}
  }'::jsonb,
  'each exact attempt-three continuation ID receives one fresh fourth claim'
);

reset role;

update pgmq.q_worksheet_generation queue
set vt = clock_timestamp() - interval '1 second'
where queue.msg_id = (
  select current_message_id
  from phase_13a_jobs
  where label = 'attempt3_fallback'
);

update app_private.async_jobs job
set lease_expires_at = clock_timestamp() - interval '1 second'
where job.id = (
  select job_id from phase_13a_jobs where label = 'attempt3_fallback'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

create temporary table phase_13a_stale_continuation_claim on commit drop as
select claimed.*
from api.claim_async_jobs(
  'worksheet_generation',
  'd1f99999-9999-4999-8999-999999999999',
  10,
  300
) claimed;

grant select on table phase_13a_stale_continuation_claim to service_role;

reset role;

select is(
  (
    select jsonb_build_object(
      'returned_rows', (
        select count(*) from phase_13a_stale_continuation_claim
      ),
      'status', job.status,
      'attempt_count', job.attempt_count
    )
    from app_private.async_jobs job
    where job.id = (
      select job_id from phase_13a_jobs where label = 'attempt3_fallback'
    )
  ),
  '{"returned_rows":0,"status":"dead","attempt_count":4}'::jsonb,
  'an expired processing lease cannot reuse an exact continuation bypass'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

create temporary table phase_13a_post_continuation_failure on commit drop as
select failed.*
from api.fail_async_job(
  (select job_id from phase_13a_jobs where label = 'attempt3_repair'),
  (
    select current_message_id
    from phase_13a_jobs
    where label = 'attempt3_repair'
  ),
  (select worker_id from phase_13a_jobs where label = 'attempt3_repair'),
  'phase_13a_post_continuation_failure',
  true
) failed;

grant select on table phase_13a_post_continuation_failure to service_role;

reset role;

select is(
  (
    select jsonb_build_object(
      'status', failed.status,
      'attempt_count', failed.attempt_count,
      'queue_message_exists', exists (
        select 1
        from pgmq.q_worksheet_generation queue
        where queue.msg_id = (
          select current_message_id
          from phase_13a_jobs
          where label = 'attempt3_repair'
        )
      )
    )
    from phase_13a_post_continuation_failure failed
  ),
  '{"status":"dead","attempt_count":4,"queue_message_exists":false}'::jsonb,
  'a generic retry after the mandatory repair continuation is denied at the cap'
);

reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  format(
    'select * from api.get_worksheet_generation_checkpoint(%L::uuid,%s,%L::uuid,1)',
    (select job_id from phase_13a_jobs where label = 'cancel'),
    (select current_message_id from phase_13a_jobs where label = 'cancel'),
    (select worker_id from phase_13a_jobs where label = 'cancel')
  ),
  '42501',
  'permission denied for function get_worksheet_generation_checkpoint',
  'browser callers cannot invoke the checkpoint loader'
);

reset role;
select * from finish(true);
rollback;
