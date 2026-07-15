begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'c5311111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase13e-certifier@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13E Certifier"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c5322222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase13e-releaser@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13E Releaser"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c5333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase13e-unqualified@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13E Unqualified"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c5344444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase13e-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13E Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'authenticated', 'authenticated', 'phase13e-progress@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13E Progress Student"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'c5311111-1111-4111-8111-111111111111',
    'Phase 13E Certifier', 'phase13e-certifier@example.test', 'student'
  ),
  (
    'c5322222-2222-4222-8222-222222222222',
    'Phase 13E Releaser', 'phase13e-releaser@example.test', 'student'
  ),
  (
    'c5333333-3333-4333-8333-333333333333',
    'Phase 13E Unqualified', 'phase13e-unqualified@example.test', 'student'
  ),
  (
    'c5344444-4444-4444-8444-444444444444',
    'Phase 13E Student', 'phase13e-student@example.test', 'student'
  ),
  (
    'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Phase 13E Progress Student', 'phase13e-progress@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c5355555-5555-4555-8555-555555555555',
  'Phase 13E Workspace',
  'phase-13e-canonical-withdrawal',
  'c5311111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c5311111-1111-4111-8111-111111111111', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c5355555-5555-4555-8555-555555555555',
  'c5311111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'c5355555-5555-4555-8555-555555555555',
    'c5344444-4444-4444-8444-444444444444',
    'student'
  ),
  (
    'c5355555-5555-4555-8555-555555555555',
    'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'student'
  );

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'c5366666-6666-4666-8666-666666666666',
  'c5355555-5555-4555-8555-555555555555',
  'Phase 13E A2 Class',
  'A2', true,
  'c5311111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'c5355555-5555-4555-8555-555555555555',
    'c5366666-6666-4666-8666-666666666666',
    'c5344444-4444-4444-8444-444444444444'
  ),
  (
    'c5355555-5555-4555-8555-555555555555',
    'c5366666-6666-4666-8666-666666666666',
    'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );

insert into app_private.practice_worksheet_bank_reviewers (
  user_id, qualification, can_certify, can_release, verified_by
)
values
  (
    'c5311111-1111-4111-8111-111111111111',
    'Qualified German-language worksheet certifier',
    true, false,
    'c5311111-1111-4111-8111-111111111111'
  ),
  (
    'c5322222-2222-4222-8222-222222222222',
    'Qualified educational worksheet release controller',
    false, true,
    'c5311111-1111-4111-8111-111111111111'
  );

create temporary table phase_13e_fixture (
  worksheet jsonb not null,
  checklist jsonb not null
);

insert into phase_13e_fixture (worksheet, checklist)
values (
  $worksheet$
  {
    "title":"A2 Withdrawable Preposition Practice",
    "description":"Practise common German prepositional phrases safely.",
    "level":"A2",
    "grammar_topic":{
      "slug":"prepositions",
      "name":"Präpositionen"
    },
    "difficulty":"medium",
    "visibility":"workspace",
    "source":"manual_import",
    "source_label":"Phase 13E pgTAP corpus",
    "tags":["A2","prepositions"],
    "mini_lesson":{
      "short_explanation":"German verbs often use a fixed preposition.",
      "key_rule":"Learn the verb and its preposition together.",
      "correct_examples":["Ich warte auf den Bus."],
      "common_mistake_warning":"Do not translate each preposition literally.",
      "what_to_revise":"Review fixed verb-preposition pairs."
    },
    "questions":[
      {
        "question_number":1,
        "question_type":"multiple_choice",
        "prompt":"Choose the correct option: Ich warte ___ den Bus.",
        "options":["auf","mit","bei"],
        "correct_answer":"auf",
        "accepted_answers":["auf"],
        "rubric":null,
        "answer_contract_version":1,
        "explanation":"The fixed phrase is auf den Bus warten.",
        "evaluation_mode":"local_exact"
      },
      {
        "question_number":2,
        "question_type":"fill_blank",
        "prompt":"Use the closed word bank [mit, bei, für]. Complete: Wir fahren ___ dem Zug.",
        "options":[],
        "correct_answer":"mit",
        "accepted_answers":["mit"],
        "rubric":null,
        "answer_contract_version":1,
        "explanation":"Use mit for a means of transport.",
        "evaluation_mode":"local_exact"
      },
      {
        "question_number":3,
        "question_type":"sentence_correction",
        "prompt":"Correct this sentence: Ich warte für den Bus.",
        "options":[],
        "correct_answer":"Ich warte auf den Bus.",
        "accepted_answers":[],
        "rubric":{
          "criteria":["Replace für with auf and preserve the intended meaning."],
          "sample_answer":"Ich warte auf den Bus."
        },
        "answer_contract_version":1,
        "explanation":"Warten takes auf in this phrase.",
        "evaluation_mode":"open_evaluation"
      }
    ]
  }
  $worksheet$::jsonb,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb
);

create temporary table phase_13e_state (
  grammar_topic_id uuid,
  template_id uuid,
  revision_id uuid,
  revision_number integer,
  release_id uuid,
  content_sha256 text,
  clone_id uuid,
  replacement_revision_id uuid,
  replacement_content_sha256 text,
  withdrawal_id uuid,
  withdrawal_created boolean,
  active_assignment_id uuid,
  in_progress_assignment_id uuid,
  historical_attempt_id uuid,
  ordinary_test_id uuid,
  replacement_job_id uuid,
  replacement_clone_id uuid,
  replacement_generation_status text,
  reviewer_revocation_job_id uuid,
  reviewer_revocation_generation_status text,
  releaser_revocation_job_id uuid,
  releaser_revocation_generation_status text
);
insert into phase_13e_state default values;
grant select, update on phase_13e_state to authenticated, service_role;

update phase_13e_state state
set grammar_topic_id = canonical_topic.id
from (
  select topic.id
  from public.grammar_topics topic
  join app_private.grammar_topic_contracts contract
    on contract.slug = topic.slug
  where contract.slug = 'prepositions'
    and topic.level in ('A2', 'A1_A2')
  order by
    case when topic.level = 'A2' then 0 else 1 end,
    topic.created_at,
    topic.id
  limit 1
) canonical_topic;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13e.a2.prepositions',
    (select worksheet from phase_13e_fixture),
    'c5311111-1111-4111-8111-111111111111',
    'c5322222-2222-4222-8222-222222222222',
    (select checklist from phase_13e_fixture),
    'Qualified Phase 13E review notes.',
    'Qualified Phase 13E release notes.'
  )
)
update phase_13e_state state
set template_id = published.template_id,
    revision_id = published.revision_id,
    release_id = published.release_id,
    content_sha256 = published.content_sha256
from published;

update phase_13e_state state
set revision_number = revision.revision_number
from app_private.practice_worksheet_template_revisions revision
where revision.id = state.revision_id;

set local role service_role;
update phase_13e_state state
set clone_id = public.clone_released_worksheet_template_internal(
  'c5355555-5555-4555-8555-555555555555',
  state.revision_id
);
reset role;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13e.a2.prepositions',
    jsonb_set(
      (select worksheet from phase_13e_fixture),
      '{title}',
      to_jsonb('A2 Replacement Preposition Practice'::text)
    ),
    'c5311111-1111-4111-8111-111111111111',
    'c5322222-2222-4222-8222-222222222222',
    (select checklist from phase_13e_fixture),
    'Qualified replacement review notes.',
    'Qualified replacement release notes.'
  )
)
update phase_13e_state state
set replacement_revision_id = published.revision_id,
    replacement_content_sha256 = published.content_sha256
from published;

select ok(
  exists (
    select 1
    from phase_13e_state state
    join app_private.practice_worksheet_template_revisions replacement
      on replacement.id = state.replacement_revision_id
    where replacement.template_id = state.template_id
      and replacement.revision_number = state.revision_number + 1
      and replacement.state = 'released'
      and replacement.content_sha256 = state.replacement_content_sha256
      and replacement.content_sha256 <> state.content_sha256
  ),
  'the fixture includes a second released bank revision for AI-free replacement'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, answers,
  score, max_score, status, completed_at, evaluation_status
)
select
  'c5388888-8888-4888-8888-888888888888',
  state.clone_id,
  'c5344444-4444-4444-8444-444444444444',
  'c5355555-5555-4555-8555-555555555555',
  '[]'::jsonb,
  0, 0, 'checked', now(), 'not_needed'
from phase_13e_state state;

update phase_13e_state
set historical_attempt_id = 'c5388888-8888-4888-8888-888888888888';

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity
)
values (
  'c5399999-9999-4999-8999-999999999999',
  'c5355555-5555-4555-8555-555555555555',
  'c5344444-4444-4444-8444-444444444444',
  (select grammar_topic_id from phase_13e_state),
  (select clone_id from phase_13e_state),
  'manual', 'unlocked',
  'c5311111-1111-4111-8111-111111111111',
  'ready',
  'c5366666-6666-4666-8666-666666666666',
  'A2', 1, 'teacher_verified'
);

update phase_13e_state
set active_assignment_id = 'c5399999-9999-4999-8999-999999999999';

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity, started_at
)
values (
  'c53ccccc-cccc-4ccc-8ccc-cccccccccccc',
  'c5355555-5555-4555-8555-555555555555',
  'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (select grammar_topic_id from phase_13e_state),
  (select clone_id from phase_13e_state),
  'manual', 'in_progress',
  'c5311111-1111-4111-8111-111111111111',
  'ready',
  'c5366666-6666-4666-8666-666666666666',
  'A2', 1, 'teacher_verified', now()
);

insert into app_private.practice_drafts (
  assignment_id, workspace_id, student_id, answers
)
values (
  'c53ccccc-cccc-4ccc-8ccc-cccccccccccc',
  'c5355555-5555-4555-8555-555555555555',
  'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '[]'::jsonb
);

update phase_13e_state
set in_progress_assignment_id = 'c53ccccc-cccc-4ccc-8ccc-cccccccccccc';

select ok(
  to_regclass('app_private.practice_worksheet_template_withdrawals') is not null
    and not has_table_privilege(
      'anon',
      'app_private.practice_worksheet_template_withdrawals',
      'SELECT'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_worksheet_template_withdrawals',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_worksheet_template_withdrawals',
      'SELECT'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)',
      'EXECUTE'
    ),
  'the withdrawal ledger and operation are private from browsers and workers'
);

select ok(
  exists (
    select 1
    from phase_13e_state state
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = state.revision_id
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
     and template.grammar_topic_id = state.grammar_topic_id
    join public.grammar_topics topic on topic.id = state.grammar_topic_id
    join app_private.grammar_topic_contracts contract
      on contract.slug = topic.slug
    join public.practice_tests clone on clone.id = state.clone_id
    where topic.slug = 'prepositions'
      and contract.slug = 'prepositions'
      and revision.state = 'released'
      and revision.revision_number = state.revision_number
      and revision.content_sha256 = state.content_sha256
      and clone.worksheet_template_revision_id = revision.id
      and clone.template_content_sha256 = revision.content_sha256
      and app_private.practice_test_canonical_revision_is_current(clone.id)
  ),
  'the fixture starts as one released exact-hash revision and current clone'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select ok(
  exists (
    select 1
    from api.get_worksheet_generation_context(
      'c5399999-9999-4999-8999-999999999999'
    ) context
    join phase_13e_state state on true
    where context.attached_practice_test_id = state.clone_id
      and context.reusable_practice_test_id = state.clone_id
      and context.certified_template_revision_id is null
  ),
  'before withdrawal, the unstarted assignment exposes its current certified clone'
);
reset role;

select throws_ok(
  format(
    'update app_private.practice_worksheet_template_revisions '
      || 'set state = %L where id = %L',
    'superseded',
    (select revision_id from phase_13e_state)
  ),
  '55000',
  'worksheet_bank_state_transition_invalid',
  'direct supersession cannot bypass the protected operation and audit ledger'
);

select throws_ok(
  format(
    'insert into app_private.practice_worksheet_template_withdrawals '
      || '(revision_id, template_id, revision_number, release_id, '
      || 'content_sha256, withdrawn_by, reason) '
      || 'values (%L, %L, %s, %L, %L, %L, %L)',
    (select revision_id from phase_13e_state),
    (select template_id from phase_13e_state),
    (select revision_number from phase_13e_state),
    (select release_id from phase_13e_state),
    (select content_sha256 from phase_13e_state),
    'c5322222-2222-4222-8222-222222222222',
    'A direct insert must not bypass the protected operation.'
  ),
  '55000',
  'worksheet_bank_withdrawal_operation_required',
  'direct ledger inserts cannot bypass the protected operation'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number from phase_13e_state),
      (select content_sha256 from phase_13e_state),
      'c5322222-2222-4222-8222-222222222222',
      'too short'
    )
  $$,
  '22023',
  'worksheet_bank_withdrawal_invalid',
  'a withdrawal requires a useful immutable audit reason'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number from phase_13e_state),
      (select content_sha256 from phase_13e_state),
      'c5333333-3333-4333-8333-333333333333',
      'A qualified releaser is required for canonical withdrawal.'
    )
  $$,
  '42501',
  'worksheet_bank_withdrawal_actor_not_qualified',
  'an unqualified account cannot withdraw canonical content'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number + 1 from phase_13e_state),
      (select content_sha256 from phase_13e_state),
      'c5322222-2222-4222-8222-222222222222',
      'The exact canonical revision binding must match.'
    )
  $$,
  '40001',
  'worksheet_bank_withdrawal_binding_mismatch',
  'a stale or incorrect revision number cannot withdraw content'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number from phase_13e_state),
      repeat('0', 64),
      'c5322222-2222-4222-8222-222222222222',
      'The exact canonical content hash binding must match.'
    )
  $$,
  '40001',
  'worksheet_bank_withdrawal_binding_mismatch',
  'a stale or incorrect content hash cannot withdraw content'
);

select ok(
  not exists (
    select 1 from app_private.practice_worksheet_template_withdrawals
  )
    and exists (
      select 1
      from phase_13e_state state
      join app_private.practice_worksheet_template_revisions revision
        on revision.id = state.revision_id
      where revision.state = 'released'
    ),
  'failed withdrawal attempts leave no partial audit row or state transition'
);

with withdrawn as (
  select *
  from app_private.withdraw_released_worksheet_template(
    (select revision_id from phase_13e_state),
    (select revision_number from phase_13e_state),
    (select content_sha256 from phase_13e_state),
    'c5322222-2222-4222-8222-222222222222',
    'Qualified review found an ambiguity that requires replacement.'
  )
)
update phase_13e_state state
set withdrawal_id = withdrawn.withdrawal_id,
    withdrawal_created = withdrawn.created
from withdrawn;

select ok(
  (select withdrawal_id is not null and withdrawal_created from phase_13e_state),
  'the qualified exact-binding operation creates one withdrawal atomically'
);

select ok(
  exists (
    select 1
    from phase_13e_state state
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = state.revision_id
    join app_private.practice_worksheet_template_withdrawals withdrawal
      on withdrawal.id = state.withdrawal_id
    where revision.state = 'superseded'
      and withdrawal.revision_id = revision.id
      and withdrawal.template_id = state.template_id
      and withdrawal.revision_number = state.revision_number
      and withdrawal.release_id = state.release_id
      and withdrawal.content_sha256 = state.content_sha256
      and withdrawal.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and withdrawal.withdrawn_by =
        'c5322222-2222-4222-8222-222222222222'
      and withdrawal.reason =
        'Qualified review found an ambiguity that requires replacement.'
  ),
  'the immutable audit row binds actor, reason, release, revision, and content hash'
);

select ok(
  exists (
    select 1
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number from phase_13e_state),
      (select content_sha256 from phase_13e_state),
      'c5322222-2222-4222-8222-222222222222',
      'Qualified review found an ambiguity that requires replacement.'
    ) replay
    join phase_13e_state state on state.withdrawal_id = replay.withdrawal_id
    where replay.created = false
  ),
  'an exact lost-response replay returns the same withdrawal without duplication'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select revision_id from phase_13e_state),
      (select revision_number from phase_13e_state),
      (select content_sha256 from phase_13e_state),
      'c5322222-2222-4222-8222-222222222222',
      'A changed reason must not rewrite the immutable withdrawal audit.'
    )
  $$,
  '55000',
  'worksheet_bank_withdrawal_replay_mismatch',
  'a changed replay cannot overwrite immutable withdrawal evidence'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_template_withdrawals
    set reason = 'Mutated withdrawal reason that must never persist.'
  $$,
  '55000',
  'worksheet_bank_history_immutable',
  'withdrawal reasons and actors cannot be updated'
);

select throws_ok(
  $$delete from app_private.practice_worksheet_template_withdrawals$$,
  '55000',
  'worksheet_bank_history_immutable',
  'withdrawal audit rows cannot be deleted'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c5344444-4444-4444-8444-444444444444',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c5344444-4444-4444-8444-444444444444',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  (
    select api.get_practice_assignment_summary(
      'c5399999-9999-4999-8999-999999999999'
    ) @> '{"practice_test_id":null,"question_count":0,"generation_status":"idle"}'::jsonb
  ),
  'an unstarted withdrawn attachment is immediately masked from the student'
);

select throws_ok(
  $$
    select api.get_practice_assignment_questions(
      'c5399999-9999-4999-8999-999999999999'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'the student cannot open questions from the withdrawn unstarted clone'
);

select throws_ok(
  $$
    select *
    from api.save_practice_draft(
      'c5399999-9999-4999-8999-999999999999',
      '[]'::jsonb,
      0
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'autosave cannot start the withdrawn unstarted worksheet'
);

with requested as (
  select *
  from api.request_practice_worksheet(
    'c5399999-9999-4999-8999-999999999999'
  )
)
update phase_13e_state state
set replacement_job_id = requested.job_id,
    replacement_generation_status = requested.generation_status
from requested;

update phase_13e_state state
set replacement_clone_id = assignment.practice_test_id
from public.student_practice_assignments assignment
where assignment.id = state.active_assignment_id;

reset role;

select throws_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'c53ddddd-dddd-4ddd-8ddd-dddddddddddd',
      (select clone_id from phase_13e_state),
      'c5344444-4444-4444-8444-444444444444',
      'c5355555-5555-4555-8555-555555555555',
      null,
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'a new assignment-less attempt cannot bypass canonical withdrawal'
);

select ok(
  exists (
    select 1
    from phase_13e_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.active_assignment_id
    join public.practice_tests worksheet
      on worksheet.id = state.replacement_clone_id
    join app_private.worksheet_bank_direct_attachment_events event
      on event.assignment_id = assignment.id
     and event.cloned_practice_test_id = worksheet.id
    where state.replacement_generation_status = 'ready'
      and state.replacement_job_id is null
      and assignment.practice_test_id = state.replacement_clone_id
      and assignment.generation_status = 'ready'
      and worksheet.worksheet_template_revision_id = state.replacement_revision_id
      and event.template_revision_id = state.replacement_revision_id
      and not exists (
        select 1
        from app_private.async_jobs job
        where job.job_kind = 'worksheet_generation'
          and job.entity_id = assignment.id
      )
  ),
  'requesting practice detaches the withdrawn clone and immediately attaches the certified replacement without paid work'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select ok(
  exists (
    select 1
    from phase_13e_state state
    cross join lateral api.get_worksheet_generation_context(
      state.in_progress_assignment_id
    ) context
    where context.assignment_status = 'in_progress'
      and context.attached_practice_test_id = state.clone_id
      and not public.practice_assignment_has_withdrawn_unstarted_clone_internal(
        state.in_progress_assignment_id
      )
  ),
  'an actual in-progress draft keeps its historical attachment and is not replaced by a queued worker'
);
reset role;

select lives_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'c53eeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      (select clone_id from phase_13e_state),
      'c53bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'c5355555-5555-4555-8555-555555555555',
      'c53ccccc-cccc-4ccc-8ccc-cccccccccccc',
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  'a genuinely in-progress preserved draft may finish against its historical clone'
);

select is(
  public.select_released_worksheet_template_internal(
    'c5355555-5555-4555-8555-555555555555',
    'c5344444-4444-4444-8444-444444444444',
    (select grammar_topic_id from phase_13e_state),
    'A2'
  ),
  (select replacement_revision_id from phase_13e_state),
  'future canonical selection excludes the withdrawn revision and chooses the replacement bank revision'
);

select ok(
  exists (
    select 1
    from phase_13e_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.active_assignment_id
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    where assignment.practice_test_id = state.replacement_clone_id
      and worksheet.worksheet_template_revision_id = state.replacement_revision_id
      and public.practice_test_canonical_revision_is_current_internal(
        worksheet.id
      )
  ),
  'the direct replacement is the current certified revision and needs no worker context'
);

select throws_ok(
  $$
    update public.student_practice_assignments assignment
    set practice_test_id = (select clone_id from phase_13e_state)
    where assignment.id = 'c5399999-9999-4999-8999-999999999999'
  $$,
  '55000',
  'withdrawn_canonical_worksheet_not_reusable',
  'the central assignment guard blocks every future attachment of the clone'
);

set local role service_role;
select throws_ok(
  $$
    select public.clone_released_worksheet_template_internal(
      'c5355555-5555-4555-8555-555555555555',
      (select revision_id from phase_13e_state)
    )
  $$,
  'P0002',
  'worksheet_bank_release_not_found',
  'the clone bridge cannot re-clone a superseded canonical revision'
);
reset role;

select ok(
  exists (
    select 1
    from phase_13e_state state
    join public.practice_test_attempts attempt
      on attempt.id = state.historical_attempt_id
    join public.practice_tests clone on clone.id = attempt.practice_test_id
    where clone.id = state.clone_id
      and clone.worksheet_template_revision_id = state.revision_id
      and attempt.student_id = 'c5344444-4444-4444-8444-444444444444'
      and attempt.completed_at is not null
  ),
  'withdrawal preserves the exact historical clone and completed attempt'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by, mini_lesson,
  generation_source, quality_status
)
values (
  'c53aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'c5355555-5555-4555-8555-555555555555',
  (select grammar_topic_id from phase_13e_state),
  'A2', 'easy', 'Ordinary Human Worksheet',
  'An unrelated human-reviewed worksheet.',
  false, true, 'workspace',
  'c5311111-1111-4111-8111-111111111111',
  '{"short_explanation":"Use the correct preposition.","key_rule":"Learn fixed phrases.","correct_examples":["Ich warte auf den Bus."],"common_mistake_warning":"Do not translate literally.","what_to_revise":"Review common phrases."}'::jsonb,
  'manual_import', 'approved'
);

update phase_13e_state
set ordinary_test_id = 'c53aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select ok(
  app_private.practice_test_canonical_revision_is_current(
    'c53aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'the canonical withdrawal predicate leaves ordinary human worksheets eligible'
);

select lives_ok(
  $$
    update public.student_practice_assignments assignment
    set practice_test_id = 'c53aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    where assignment.id = 'c5399999-9999-4999-8999-999999999999'
  $$,
  'the central guard permits an unrelated current workspace worksheet'
);

-- Qualification revocation is the same current-material boundary as an
-- explicit withdrawal. Keep a separate started learner and completed attempt
-- to prove that only untouched future use is hidden; historical work survives.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  'c53f1111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated', 'phase13e-history@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 13E History Student"}'::jsonb,
  now(), now()
);

insert into public.profiles (id, full_name, email, global_role)
values (
  'c53f1111-1111-4111-8111-111111111111',
  'Phase 13E History Student',
  'phase13e-history@example.test',
  'student'
)
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c5355555-5555-4555-8555-555555555555',
  'c53f1111-1111-4111-8111-111111111111',
  'student'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'c5355555-5555-4555-8555-555555555555',
  'c5366666-6666-4666-8666-666666666666',
  'c53f1111-1111-4111-8111-111111111111'
);

update public.student_practice_assignments assignment
set
  practice_test_id = (select replacement_clone_id from phase_13e_state),
  generation_status = 'ready',
  generation_error = null
where assignment.id = 'c5399999-9999-4999-8999-999999999999';

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity, started_at
)
values (
  'c53f2222-2222-4222-8222-222222222222',
  'c5355555-5555-4555-8555-555555555555',
  'c53f1111-1111-4111-8111-111111111111',
  (select grammar_topic_id from phase_13e_state),
  (select replacement_clone_id from phase_13e_state),
  'manual', 'in_progress',
  'c5311111-1111-4111-8111-111111111111',
  'ready',
  'c5366666-6666-4666-8666-666666666666',
  'A2', 1, 'teacher_verified', now()
);

insert into app_private.practice_drafts (
  assignment_id, workspace_id, student_id, answers
)
values (
  'c53f2222-2222-4222-8222-222222222222',
  'c5355555-5555-4555-8555-555555555555',
  'c53f1111-1111-4111-8111-111111111111',
  '[]'::jsonb
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id,
  answers, score, max_score, status, completed_at, evaluation_status
)
values (
  'c53f3333-3333-4333-8333-333333333333',
  (select replacement_clone_id from phase_13e_state),
  'c53f1111-1111-4111-8111-111111111111',
  'c5355555-5555-4555-8555-555555555555',
  '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
);

-- Simulate a legacy attester revocation state for downstream clone masking;
-- the current coverage trigger prevents this state in normal operation.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = 'c5311111-1111-4111-8111-111111111111';
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c5344444-4444-4444-8444-444444444444',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c5344444-4444-4444-8444-444444444444',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  api.get_practice_assignment_summary(
    'c5399999-9999-4999-8999-999999999999'
  ) @> '{"practice_test_id":null,"question_count":0,"generation_status":"idle"}'::jsonb,
  'deactivating the certifier immediately masks an untouched canonical clone'
);

select throws_ok(
  $$
    select api.get_practice_assignment_questions(
      'c5399999-9999-4999-8999-999999999999'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'certifier revocation prevents opening untouched clone questions'
);

with requested as (
  select *
  from api.request_practice_worksheet(
    'c5399999-9999-4999-8999-999999999999'
  )
)
update pg_temp.phase_13e_state state
set reviewer_revocation_job_id = requested.job_id,
    reviewer_revocation_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13e_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.active_assignment_id
    join app_private.async_jobs job on job.id = state.reviewer_revocation_job_id
    where state.reviewer_revocation_generation_status = 'queued'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'queued'
      and job.status = 'queued'
  ),
  'certifier revocation detaches the untouched clone before durable fallback'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c53f1111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c53f1111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select ok(
  jsonb_array_length(api.get_practice_assignment_questions(
    'c53f2222-2222-4222-8222-222222222222'
  )) = 3
    and exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = 'c53f3333-3333-4333-8333-333333333333'
        and attempt.completed_at is not null
    ),
  'certifier revocation preserves started questions and completed history'
);

reset role;

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = 'c5311111-1111-4111-8111-111111111111';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c5344444-4444-4444-8444-444444444444',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c5344444-4444-4444-8444-444444444444',
  true
);
set local role authenticated;

select *
from api.request_practice_worksheet(
  'c5399999-9999-4999-8999-999999999999'
);

reset role;

-- Simulate the corresponding legacy releaser-revocation state.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = 'c5322222-2222-4222-8222-222222222222';
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

set local role authenticated;

select ok(
  api.get_practice_assignment_summary(
    'c5399999-9999-4999-8999-999999999999'
  ) @> '{"practice_test_id":null,"question_count":0,"generation_status":"idle"}'::jsonb,
  'deactivating the releaser immediately masks an untouched canonical clone'
);

select throws_ok(
  $$
    select api.get_practice_assignment_questions(
      'c5399999-9999-4999-8999-999999999999'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'releaser revocation prevents opening untouched clone questions'
);

with requested as (
  select *
  from api.request_practice_worksheet(
    'c5399999-9999-4999-8999-999999999999'
  )
)
update pg_temp.phase_13e_state state
set releaser_revocation_job_id = requested.job_id,
    releaser_revocation_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13e_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.active_assignment_id
    join app_private.async_jobs job on job.id = state.releaser_revocation_job_id
    where state.releaser_revocation_generation_status = 'queued'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'queued'
      and job.status = 'queued'
  ),
  'releaser revocation detaches the untouched clone before durable fallback'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c53f1111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c53f1111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select ok(
  jsonb_array_length(api.get_practice_assignment_questions(
    'c53f2222-2222-4222-8222-222222222222'
  )) = 3
    and exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = 'c53f3333-3333-4333-8333-333333333333'
        and attempt.completed_at is not null
    ),
  'releaser revocation preserves started questions and completed history'
);

reset role;

select * from finish();

rollback;
