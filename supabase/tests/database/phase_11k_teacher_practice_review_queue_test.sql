begin;

select plan(21);

select ok(
  to_regprocedure(
    'api.list_practice_review_queue_page(uuid,text,integer,timestamptz,text)'
  ) is not null
    and to_regprocedure(
      'api.get_quarantined_practice_worksheet(uuid)'
    ) is not null
    and to_regprocedure(
      'api.decide_quarantined_practice_worksheet(uuid,text,text)'
    ) is not null,
  'teacher practice review queue and quality decisions have stable API signatures'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and routine.proname in (
        'list_practice_review_queue_page',
        'get_quarantined_practice_worksheet',
        'decide_quarantined_practice_worksheet'
      )
      and routine.prosecdef
  )
    and (
      select bool_and(routine.prosecdef)
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'public'
        and routine.proname in (
          'list_practice_review_queue_page_internal',
          'get_quarantined_practice_worksheet_internal',
          'decide_quarantined_practice_worksheet_internal'
        )
    ),
  'exposed wrappers are invoker functions and non-exposed implementations are definer functions'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.decide_quarantined_practice_worksheet(uuid,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.decide_quarantined_practice_worksheet(uuid,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.decide_quarantined_practice_worksheet(uuid,text,text)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the quality decision API'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.decide_quarantined_practice_worksheet_internal(uuid,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'public.decide_quarantined_practice_worksheet_internal(uuid,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.decide_quarantined_practice_worksheet_internal(uuid,text,text)',
      'EXECUTE'
    ),
  'the invoker wrapper can delegate only through its non-exposed implementation grant'
);

select ok(
  (
    select class.relrowsecurity
    from pg_class class
    where class.oid = 'app_private.practice_quality_actions'::regclass
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_quality_actions',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_quality_actions',
      'SELECT'
    ),
  'quality decisions are stored in a private RLS-protected audit ledger'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fd111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11k-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11K Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fd222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11k-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11K Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fd333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11k-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11K Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'fd111111-1111-4111-8111-111111111111',
    'Phase 11K Teacher', 'phase11k-teacher@example.test', 'student'
  ),
  (
    'fd222222-2222-4222-8222-222222222222',
    'Phase 11K Student', 'phase11k-student@example.test', 'student'
  ),
  (
    'fd333333-3333-4333-8333-333333333333',
    'Phase 11K Outsider', 'phase11k-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'fd444444-4444-4444-8444-444444444444',
  'Phase 11K Workspace',
  'phase-11k-workspace',
  'fd111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'fd111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'fd444444-4444-4444-8444-444444444444',
  'fd111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'fd444444-4444-4444-8444-444444444444',
  'fd222222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

create temporary table phase_11k_state (
  singleton boolean primary key default true check (singleton),
  first_topic_id uuid,
  second_topic_id uuid
) on commit drop;

insert into phase_11k_state (first_topic_id, second_topic_id)
select
  (
    select topic.id
    from public.grammar_topics topic
    where topic.slug = 'prepositions'
    order by topic.id::text
    limit 1
  ),
  (
    select topic.id
    from public.grammar_topics topic
    where topic.slug = 'word-order'
    order by topic.id::text
    limit 1
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, source, status,
  generation_status, generation_version, generation_completed_at
)
select
  fixture.id,
  'fd444444-4444-4444-8444-444444444444',
  'fd222222-2222-4222-8222-222222222222',
  fixture.topic_id,
  'manual',
  'unlocked',
  'needs_review',
  1,
  now()
from phase_11k_state state
cross join lateral (
  values
    ('fd555555-5555-4555-8555-555555555555'::uuid, state.first_topic_id),
    ('fd666666-6666-4666-8666-666666666666'::uuid, state.second_topic_id)
) fixture(id, topic_id);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, generation_source,
  quality_status, quality_notes, generated_from_assignment_id,
  generator_model, generation_metadata
)
select
  fixture.test_id,
  'fd444444-4444-4444-8444-444444444444',
  assignment.grammar_topic_id,
  'A1',
  'easy',
  fixture.title,
  'Human review fixture',
  true,
  false,
  'private',
  'deepseek',
  'needs_review',
  'Independent review rejected this candidate.',
  assignment.id,
  'deepseek-v4-pro',
  '{"schema_version":1,"validation":{"independent_model":false}}'::jsonb
from (
  values
    (
      'fd555555-5555-4555-8555-555555555555'::uuid,
      'fd777777-7777-4777-8777-777777777777'::uuid,
      'Preposition candidate'
    ),
    (
      'fd666666-6666-4666-8666-666666666666'::uuid,
      'fd888888-8888-4888-8888-888888888888'::uuid,
      'Word-order candidate'
    )
) fixture(assignment_id, test_id, title)
join public.student_practice_assignments assignment
  on assignment.id = fixture.assignment_id;

insert into public.practice_test_questions (
  practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'fd777777-7777-4777-8777-777777777777', 1, 'multiple_choice', 'local_exact',
    'Welche Form ist korrekt: Ich gehe ___ Schule?',
    '["zur","zu die","an der"]'::jsonb, 'zur', '["zur"]'::jsonb, null, 1,
    'Zu der contracts to zur.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 2, 'multiple_choice', 'local_exact',
    'Welche Form ist korrekt: Wir warten ___ Bus?',
    '["auf den","an den","für dem"]'::jsonb, 'auf den', '["auf den"]'::jsonb, null, 1,
    'Warten takes auf plus accusative.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 3, 'multiple_choice', 'local_exact',
    'Welche Form ist korrekt: Das Bild hängt ___ Wand?',
    '["an der","auf die","für der"]'::jsonb, 'an der', '["an der"]'::jsonb, null, 1,
    'A location uses dative here.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 4, 'fill_blank', 'local_exact',
    'Setze den bestimmten Artikel ein: Ich sehe ___ Hund.',
    '[]'::jsonb, 'den', '["den"]'::jsonb, null, 1,
    'Hund is masculine accusative.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 5, 'fill_blank', 'local_exact',
    'Setze den unbestimmten Artikel ein: Das ist ___ Katze.',
    '[]'::jsonb, 'eine', '["eine"]'::jsonb, null, 1,
    'Katze is feminine nominative.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 6, 'fill_blank', 'local_exact',
    'Konjugiere sein für wir: Wir ___ müde.',
    '[]'::jsonb, 'sind', '["sind"]'::jsonb, null, 1,
    'The wir form of sein is sind.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 7, 'sentence_correction', 'open_evaluation',
    'Korrigiere den Satz: Ich fahre zu Berlin.',
    '[]'::jsonb, 'Ich fahre nach Berlin.', '[]'::jsonb,
    '{"criteria":["Use the correct directional preposition before a city."],"sample_answer":"Ich fahre nach Berlin."}'::jsonb,
    1, 'Cities without an article normally use nach.'
  ),
  (
    'fd777777-7777-4777-8777-777777777777', 8, 'word_order', 'open_evaluation',
    'Ordne die Wörter: morgen / ich / nach / Berlin / fahre',
    '[]'::jsonb, 'Morgen fahre ich nach Berlin.', '[]'::jsonb,
    '{"criteria":["Put the finite verb in second position."],"sample_answer":"Morgen fahre ich nach Berlin."}'::jsonb,
    1, 'The finite verb occupies position two.'
  );

insert into public.practice_test_questions (
  practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
select
  'fd888888-8888-4888-8888-888888888888',
  source.question_number,
  source.question_type,
  source.evaluation_mode,
  source.prompt || ' Zweite Fassung.',
  source.options,
  source.correct_answer,
  source.accepted_answers,
  source.rubric,
  source.answer_contract_version,
  source.explanation
from public.practice_test_questions source
where source.practice_test_id = 'fd777777-7777-4777-8777-777777777777';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fd111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select ok(
  (
    api.list_practice_review_queue_page(
      'fd444444-4444-4444-8444-444444444444',
      'worksheet_quarantine',
      1,
      null,
      null
    ) ->> 'total_count'
  )::integer = 2
    and (
      api.list_practice_review_queue_page(
        'fd444444-4444-4444-8444-444444444444',
        'worksheet_quarantine',
        1,
        null,
        null
      ) ->> 'has_more'
    )::boolean,
  'the server-filtered queue reports exact counts and keyset continuation'
);

select is(
  jsonb_array_length(
    api.get_quarantined_practice_worksheet(
      'fd555555-5555-4555-8555-555555555555'
    ) #> '{worksheet,questions}'
  ),
  8,
  'a teacher can inspect every prompt, answer contract, rubric, and explanation before deciding'
);

select is(
  api.decide_quarantined_practice_worksheet(
    'fd555555-5555-4555-8555-555555555555',
    'approve',
    'Human review confirms that every item is clear and level appropriate.'
  ) ->> 'generation_status',
  'ready'::text,
  'a teacher can approve a structurally valid quarantined worksheet'
);

reset role;

select ok(
  (
    select worksheet.quality_status = 'approved'
      and worksheet.teacher_reviewed
      and worksheet.visibility = 'workspace'
      and assignment.practice_test_id = worksheet.id
      and assignment.generation_status = 'ready'
      and assignment.generation_error is null
    from public.student_practice_assignments assignment
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    where assignment.id = 'fd555555-5555-4555-8555-555555555555'
  ),
  'approval atomically releases the exact immutable worksheet revision to its assignment'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_quality_actions action
    where action.practice_test_id = 'fd777777-7777-4777-8777-777777777777'
      and action.decision = 'approved'
  ),
  1,
  'approval records one private immutable audit action'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fd111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$select api.decide_quarantined_practice_worksheet(
    'fd555555-5555-4555-8555-555555555555',
    'approve',
    'A stale second decision must not replace the first decision.'
  )$$,
  '55000',
  'worksheet_not_quarantined',
  'a second decision cannot rewrite an already released revision'
);

select is(
  api.decide_quarantined_practice_worksheet(
    'fd666666-6666-4666-8666-666666666666',
    'reject',
    'Human review found an ambiguous task, so this candidate must be regenerated.'
  ) ->> 'quality_status',
  'failed'::text,
  'a teacher can explicitly reject a quarantined worksheet'
);

reset role;

select ok(
  (
    select worksheet.quality_status = 'failed'
      and worksheet.teacher_reviewed
      and worksheet.visibility = 'private'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'failed'
      and assignment.generation_error = 'teacher_rejected'
    from public.student_practice_assignments assignment
    join public.practice_tests worksheet
      on worksheet.generated_from_assignment_id = assignment.id
    where assignment.id = 'fd666666-6666-4666-8666-666666666666'
  ),
  'rejection keeps the candidate private and exposes a safe retryable assignment state'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fd111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select is(
  (
    api.list_practice_review_queue_page(
      'fd444444-4444-4444-8444-444444444444',
      'generation_failed',
      25,
      null,
      null
    ) ->> 'total_count'
  )::integer,
  1,
  'a rejected candidate moves to the generation retry queue'
);

select is(
  (
    api.list_practice_review_queue_page(
      'fd444444-4444-4444-8444-444444444444',
      'worksheet_quarantine',
      25,
      null,
      null
    ) ->> 'total_count'
  )::integer,
  0,
  'resolved quality decisions disappear from the quarantine queue'
);

select throws_ok(
  $$select api.list_practice_review_queue_page(
    'fd444444-4444-4444-8444-444444444444',
    'unsupported_kind',
    25,
    null,
    null
  )$$,
  '22023',
  'invalid_practice_review_page',
  'unknown queue filters fail closed'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fd333333-3333-4333-8333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$select api.list_practice_review_queue_page(
    'fd444444-4444-4444-8444-444444444444',
    'all',
    25,
    null,
    null
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot list another workspace review queue'
);

select throws_ok(
  $$select api.get_quarantined_practice_worksheet(
    'fd666666-6666-4666-8666-666666666666'
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot inspect private worksheet answers'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fd222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$select api.decide_quarantined_practice_worksheet(
    'fd666666-6666-4666-8666-666666666666',
    'approve',
    'A student must never be able to approve private worksheet content.'
  )$$,
  '42501',
  'permission_denied',
  'a student cannot approve a private generated worksheet'
);

reset role;

select throws_ok(
  $$update app_private.practice_quality_actions
    set notes = 'Mutated audit history must be rejected.'
    where practice_test_id = 'fd777777-7777-4777-8777-777777777777'$$,
  '55000',
  'Adaptive-practice history is immutable.',
  'quality decision audit history is immutable'
);

select ok(
  not exists (
    select 1
    from app_private.practice_quality_actions action
    where action.workspace_id <> 'fd444444-4444-4444-8444-444444444444'
  ),
  'quality audit rows retain exact workspace context'
);

select * from finish();
rollback;
