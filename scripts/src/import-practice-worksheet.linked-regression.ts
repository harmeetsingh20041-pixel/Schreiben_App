import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildLinkedDbSql,
  validateWorksheet,
  type WorksheetImport,
} from "./import-practice-worksheet.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const stagingProjectRef = "vzcgalzspdehmnvqczfw";

const fixture = {
  ownerId: "d7010001-0001-4001-8001-000000000001",
  teacherId: "d7010002-0002-4002-8002-000000000002",
  studentId: "d7010003-0003-4003-8003-000000000003",
  offboardedId: "d7010004-0004-4004-8004-000000000004",
  unrelatedTeacherId: "d7010005-0005-4005-8005-000000000005",
  workspaceId: "d7020001-0001-4001-8001-000000000001",
  unrelatedWorkspaceId: "d7020002-0002-4002-8002-000000000002",
  topicId: "d7030001-0001-4001-8001-000000000001",
  assignmentId: "d7040001-0001-4001-8001-000000000001",
  attemptId: "d7050001-0001-4001-8001-000000000001",
  reviewId: "d7060001-0001-4001-8001-000000000001",
  workspaceSlug: "phase-12x-importer-linked-workspace-20260712",
  unrelatedWorkspaceSlug:
    "phase-12x-importer-linked-unrelated-workspace-20260712",
  topicSlug: "phase-12x-importer-linked-topic-20260712",
  titlePrefix: "Phase 12X Importer Linked 20260712",
} as const;

const fixtureTitles = {
  revision: `${fixture.titlePrefix} Revision`,
  invalid: `${fixture.titlePrefix} Invalid Item`,
  missing: `${fixture.titlePrefix} Missing Reviewer`,
  student: `${fixture.titlePrefix} Student Reviewer`,
  offboarded: `${fixture.titlePrefix} Offboarded Reviewer`,
  unrelated: `${fixture.titlePrefix} Unrelated Reviewer`,
  owner: `${fixture.titlePrefix} Active Owner`,
  teacher: `${fixture.titlePrefix} Active Teacher`,
} as const;

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function baseWorksheet(title: string) {
  return validateWorksheet({
    title,
    level: "A2",
    grammar_topic: { slug: fixture.topicSlug },
    difficulty: "medium",
    visibility: "workspace",
    source: "manual_import",
    source_label: "Phase 12X linked importer regression",
    tags: ["linked-regression", "immutable-revision"],
    mini_lesson: {
      short_explanation:
        "Fixed German prepositions connect verbs to the correct object.",
      key_rule: "The verb determines the preposition and its case.",
      correct_examples: ["Ich warte auf den Bus."],
      common_mistake_warning: "Do not translate the preposition word for word.",
      what_to_revise: "Review common verb-preposition pairs.",
    },
    questions: [
      {
        question_number: 1,
        question_type: "transformation",
        evaluation_mode: "open_evaluation",
        prompt:
          "Formuliere den Satz mit der Verbindung warten auf: Der Bus kommt bald.",
        correct_answer: "Ich warte auf den Bus.",
        rubric: {
          criteria: [
            "The answer uses warten auf with an accusative object.",
            "The sentence is grammatically complete and natural.",
          ],
          sample_answer: "Ich warte auf den Bus.",
        },
        explanation: "Warten is used with auf plus the accusative case.",
      },
      {
        question_number: 2,
        question_type: "fill_blank",
        evaluation_mode: "local_exact",
        prompt: "Wortbank [auf, an, für]: Ich warte ___ den nächsten Bus.",
        correct_answer: "auf",
        accepted_answers: ["auf"],
        explanation: "The fixed phrase is auf etwas warten.",
      },
    ],
  });
}

function changedRevision() {
  const changed = structuredClone(baseWorksheet(fixtureTitles.revision));
  changed.questions[0].explanation =
    "The revised explanation confirms that warten auf takes the accusative.";
  changed.mini_lesson.what_to_revise =
    "Review warten auf and other accusative verb-preposition pairs.";
  return validateWorksheet(changed);
}

function invalidRevision() {
  const invalid = structuredClone(baseWorksheet(fixtureTitles.invalid)) as {
    questions: Array<Record<string, unknown>>;
  } & Omit<WorksheetImport, "questions">;
  invalid.questions[1].answer_contract_version = 2;
  return invalid as unknown as WorksheetImport;
}

function importerMutation(
  worksheet: WorksheetImport,
  createdBy: string | null,
) {
  const sql = buildLinkedDbSql({
    worksheet,
    workspaceId: fixture.workspaceId,
    createdBy,
  });
  const match = sql.match(
    /^do \$worksheet_import\$[\s\S]*?\n\$worksheet_import\$;/,
  );
  if (!match) {
    throw new Error(
      "The linked importer mutation statement could not be isolated.",
    );
  }
  return match[0];
}

function throwsImporter(args: {
  delimiter: string;
  worksheet: WorksheetImport;
  createdBy: string | null;
  sqlState: string;
  message: string;
  description: string;
}) {
  const statement = importerMutation(args.worksheet, args.createdBy);
  return `select pg_temp.importer_throws_ok(
  $${args.delimiter}$
${statement}
  $${args.delimiter}$,
  ${sqlLiteral(args.sqlState)},
  ${sqlLiteral(args.message)},
  ${sqlLiteral(args.description)}
);`;
}

function authUserRow(id: string, label: string) {
  const email = `phase12x-importer-${label.toLowerCase()}@fixture.invalid`;
  return `(
    '00000000-0000-0000-0000-000000000000',
    ${sqlLiteral(id)}::uuid,
    'authenticated',
    'authenticated',
    ${sqlLiteral(email)},
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    ${sqlLiteral(JSON.stringify({ full_name: `Phase 12X ${label}` }))}::jsonb,
    now(),
    now()
  )`;
}

function worksheetTitleArray() {
  return `array[${Object.values(fixtureTitles)
    .map(sqlLiteral)
    .join(", ")}]::text[]`;
}

function fixtureUserArray() {
  return `array[${[
    fixture.ownerId,
    fixture.teacherId,
    fixture.studentId,
    fixture.offboardedId,
    fixture.unrelatedTeacherId,
  ]
    .map((id) => `${sqlLiteral(id)}::uuid`)
    .join(", ")}]::uuid[]`;
}

export function buildLinkedImporterRegressionSql() {
  const original = baseWorksheet(fixtureTitles.revision);
  const changed = changedRevision();
  const invalid = invalidRevision();
  const missing = baseWorksheet(fixtureTitles.missing);
  const student = baseWorksheet(fixtureTitles.student);
  const offboarded = baseWorksheet(fixtureTitles.offboarded);
  const unrelated = baseWorksheet(fixtureTitles.unrelated);
  const owner = baseWorksheet(fixtureTitles.owner);
  const teacher = baseWorksheet(fixtureTitles.teacher);

  return `begin;

create temporary table importer_linked_assertions (
  description text primary key
) on commit drop;

create function pg_temp.importer_record_assertion(assertion_description text)
returns void
language plpgsql
as $importer_record_assertion$
begin
  insert into importer_linked_assertions (description)
  values (assertion_description);
end;
$importer_record_assertion$;

create function pg_temp.importer_ok(
  actual boolean,
  assertion_description text
)
returns boolean
language plpgsql
as $importer_ok$
begin
  if not coalesce(actual, false) then
    raise exception using
      errcode = 'P0001',
      message = 'importer_regression_failed: ' || assertion_description;
  end if;
  perform pg_temp.importer_record_assertion(assertion_description);
  return true;
end;
$importer_ok$;

create function pg_temp.importer_is(
  actual anycompatible,
  expected anycompatible,
  assertion_description text
)
returns boolean
language plpgsql
as $importer_is$
begin
  if actual is distinct from expected then
    raise exception using
      errcode = 'P0001',
      message = 'importer_regression_failed: ' || assertion_description;
  end if;
  perform pg_temp.importer_record_assertion(assertion_description);
  return true;
end;
$importer_is$;

create function pg_temp.importer_isnt(
  actual anycompatible,
  expected anycompatible,
  assertion_description text
)
returns boolean
language plpgsql
as $importer_isnt$
begin
  if actual is not distinct from expected then
    raise exception using
      errcode = 'P0001',
      message = 'importer_regression_failed: ' || assertion_description;
  end if;
  perform pg_temp.importer_record_assertion(assertion_description);
  return true;
end;
$importer_isnt$;

create function pg_temp.importer_matches(
  actual text,
  expected_pattern text,
  assertion_description text
)
returns boolean
language plpgsql
as $importer_matches$
begin
  if actual is null or actual !~ expected_pattern then
    raise exception using
      errcode = 'P0001',
      message = 'importer_regression_failed: ' || assertion_description;
  end if;
  perform pg_temp.importer_record_assertion(assertion_description);
  return true;
end;
$importer_matches$;

create function pg_temp.importer_throws_ok(
  statement text,
  expected_state text,
  expected_message text,
  assertion_description text
)
returns boolean
language plpgsql
as $importer_throws_ok$
declare
  observed_state text;
  observed_message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics
      observed_state = returned_sqlstate,
      observed_message = message_text;
    if observed_state is distinct from expected_state
      or observed_message is distinct from expected_message
    then
      raise exception using
        errcode = 'P0001',
        message = 'importer_regression_failed: ' || assertion_description;
    end if;
    perform pg_temp.importer_record_assertion(assertion_description);
    return true;
  end;

  raise exception using
    errcode = 'P0001',
    message = 'importer_regression_failed: ' || assertion_description;
end;
$importer_throws_ok$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ${authUserRow(fixture.ownerId, "Owner")},
  ${authUserRow(fixture.teacherId, "Teacher")},
  ${authUserRow(fixture.studentId, "Student")},
  ${authUserRow(fixture.offboardedId, "Offboarded")},
  ${authUserRow(fixture.unrelatedTeacherId, "Unrelated-Teacher")};

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    ${sqlLiteral(fixture.workspaceId)}::uuid,
    'Phase 12X Importer Linked Workspace',
    ${sqlLiteral(fixture.workspaceSlug)},
    ${sqlLiteral(fixture.ownerId)}::uuid
  ),
  (
    ${sqlLiteral(fixture.unrelatedWorkspaceId)}::uuid,
    'Phase 12X Importer Linked Unrelated Workspace',
    ${sqlLiteral(fixture.unrelatedWorkspaceSlug)},
    ${sqlLiteral(fixture.ownerId)}::uuid
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', ${sqlLiteral(fixture.ownerId)}, true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  ${sqlLiteral(fixture.workspaceId)}::uuid,
  ${sqlLiteral(fixture.ownerId)}::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    ${sqlLiteral(fixture.workspaceId)}::uuid,
    ${sqlLiteral(fixture.teacherId)}::uuid,
    'teacher'
  ),
  (
    ${sqlLiteral(fixture.workspaceId)}::uuid,
    ${sqlLiteral(fixture.studentId)}::uuid,
    'student'
  ),
  (
    ${sqlLiteral(fixture.unrelatedWorkspaceId)}::uuid,
    ${sqlLiteral(fixture.unrelatedTeacherId)}::uuid,
    'teacher'
  );

insert into public.grammar_topics (id, slug, name, level, description)
values (
  ${sqlLiteral(fixture.topicId)}::uuid,
  ${sqlLiteral(fixture.topicSlug)},
  'Phase 12X Linked Importer Topic',
  'A2',
  'Exact rollback-only importer regression topic.'
);

${importerMutation(original, fixture.ownerId)}

create temporary table importer_linked_state (
  name text primary key,
  practice_test_id uuid not null,
  first_question_id uuid not null,
  second_question_id uuid not null,
  content_sha256 text not null,
  first_explanation text not null
) on commit drop;

insert into importer_linked_state (
  name, practice_test_id, first_question_id, second_question_id,
  content_sha256, first_explanation
)
select
  'original',
  test.id,
  min(question.id::text) filter (where question.question_number = 1)::uuid,
  min(question.id::text) filter (where question.question_number = 2)::uuid,
  app_private.practice_test_content_sha256(test.id),
  min(question.explanation) filter (where question.question_number = 1)
from public.practice_tests test
join public.practice_test_questions question
  on question.practice_test_id = test.id
where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
  and test.title = ${sqlLiteral(fixtureTitles.revision)}
group by test.id;

select pg_temp.importer_ok(
  (
    select test.quality_status = 'approved'
      and test.teacher_reviewed
      and test.reviewed_by = ${sqlLiteral(fixture.ownerId)}::uuid
      and count(question.id) = 2
    from public.practice_tests test
    join public.practice_test_questions question
      on question.practice_test_id = test.id
    where test.id = (
      select practice_test_id from importer_linked_state where name = 'original'
    )
    group by test.id
  ),
  'the active owner imports one approved two-question revision'
);

select pg_temp.importer_matches(
  (select content_sha256 from importer_linked_state where name = 'original'),
  '^[a-f0-9]{64}$',
  'the original imported revision has an exact content fingerprint'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, completed_at, generation_status,
  class_context_version
)
select
  ${sqlLiteral(fixture.assignmentId)}::uuid,
  ${sqlLiteral(fixture.workspaceId)}::uuid,
  ${sqlLiteral(fixture.studentId)}::uuid,
  ${sqlLiteral(fixture.topicId)}::uuid,
  state.practice_test_id,
  'manual',
  'completed',
  ${sqlLiteral(fixture.ownerId)}::uuid,
  now(),
  'ready',
  0
from importer_linked_state state
where state.name = 'original';

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_completed_at, status, started_at, submitted_at, completed_at
)
select
  ${sqlLiteral(fixture.attemptId)}::uuid,
  state.practice_test_id,
  ${sqlLiteral(fixture.studentId)}::uuid,
  ${sqlLiteral(fixture.workspaceId)}::uuid,
  ${sqlLiteral(fixture.assignmentId)}::uuid,
  jsonb_build_array(
    jsonb_build_object(
      'question_id', state.first_question_id,
      'answer', 'Ich warte auf den Bus.'
    ),
    jsonb_build_object(
      'question_id', state.second_question_id,
      'answer', 'auf'
    )
  ),
  2, 2, 2, 2, 100, true,
  'phase_12x_importer_history_fixture',
  'not_needed', 0, now(), 'checked', now(), now(), now()
from importer_linked_state state
where state.name = 'original';

update public.student_practice_assignments assignment
set latest_attempt_id = ${sqlLiteral(fixture.attemptId)}::uuid
where assignment.id = ${sqlLiteral(fixture.assignmentId)}::uuid;

insert into public.practice_attempt_question_reviews (
  id, attempt_id, assignment_id, workspace_id, student_id, question_id,
  review_status, points_awarded, max_points, evaluator_source,
  feedback_text, corrected_answer, model_answer, short_reason
)
select
  ${sqlLiteral(fixture.reviewId)}::uuid,
  ${sqlLiteral(fixture.attemptId)}::uuid,
  ${sqlLiteral(fixture.assignmentId)}::uuid,
  ${sqlLiteral(fixture.workspaceId)}::uuid,
  ${sqlLiteral(fixture.studentId)}::uuid,
  state.first_question_id,
  'correct', 1, 1, 'teacher',
  'The original answer is correct.',
  'Ich warte auf den Bus.',
  'Ich warte auf den Bus.',
  'Historical review must remain attached to the original question.'
from importer_linked_state state
where state.name = 'original';

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join importer_linked_state state
      on state.practice_test_id = attempt.practice_test_id
     and state.name = 'original'
    where attempt.id = ${sqlLiteral(fixture.attemptId)}::uuid
  ),
  'the fixture simulates student use against the original revision'
);

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_attempt_question_reviews review
    join importer_linked_state state
      on state.first_question_id = review.question_id
     and state.name = 'original'
    where review.id = ${sqlLiteral(fixture.reviewId)}::uuid
      and review.attempt_id = ${sqlLiteral(fixture.attemptId)}::uuid
  ),
  'the fixture stores review history against the original question identity'
);

${importerMutation(changed, fixture.ownerId)}

insert into importer_linked_state (
  name, practice_test_id, first_question_id, second_question_id,
  content_sha256, first_explanation
)
select
  'changed',
  test.id,
  min(question.id::text) filter (where question.question_number = 1)::uuid,
  min(question.id::text) filter (where question.question_number = 2)::uuid,
  app_private.practice_test_content_sha256(test.id),
  min(question.explanation) filter (where question.question_number = 1)
from public.practice_tests test
join public.practice_test_questions question
  on question.practice_test_id = test.id
where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
  and test.title = ${sqlLiteral(fixtureTitles.revision)}
  and test.id <> (
    select practice_test_id from importer_linked_state where name = 'original'
  )
group by test.id;

select pg_temp.importer_ok(
  (
    select count(*) = 2
    from public.practice_tests test
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.revision)}
  )
    and (
      select original.practice_test_id <> changed.practice_test_id
      from importer_linked_state original
      cross join importer_linked_state changed
      where original.name = 'original' and changed.name = 'changed'
    ),
  'changed content creates a distinct immutable worksheet revision'
);

select pg_temp.importer_is(
  app_private.practice_test_content_sha256(
    (select practice_test_id from importer_linked_state where name = 'original')
  ),
  (select content_sha256 from importer_linked_state where name = 'original'),
  'the used original revision fingerprint is unchanged after re-import'
);

select pg_temp.importer_ok(
  (
    select count(*) = 2
      and bool_or(
        question.id = state.first_question_id
        and question.explanation = state.first_explanation
      )
      and bool_or(question.id = state.second_question_id)
    from importer_linked_state state
    join public.practice_test_questions question
      on question.practice_test_id = state.practice_test_id
    where state.name = 'original'
    group by state.first_question_id, state.second_question_id,
      state.first_explanation
  ),
  'the original question IDs and text survive the changed re-import'
);

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join importer_linked_state state
      on state.practice_test_id = attempt.practice_test_id
     and state.name = 'original'
    where attempt.id = ${sqlLiteral(fixture.attemptId)}::uuid
  ),
  'the historical attempt remains attached to the original revision'
);

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_attempt_question_reviews review
    join importer_linked_state state
      on state.first_question_id = review.question_id
     and state.name = 'original'
    where review.id = ${sqlLiteral(fixture.reviewId)}::uuid
      and review.attempt_id = ${sqlLiteral(fixture.attemptId)}::uuid
  ),
  'the historical review remains attached to the original question'
);

select pg_temp.importer_is(
  (select first_explanation from importer_linked_state where name = 'changed'),
  'The revised explanation confirms that warten auf takes the accusative.'::text,
  'the new revision contains the changed content without rewriting history'
);

select pg_temp.importer_isnt(
  (select content_sha256 from importer_linked_state where name = 'changed'),
  (select content_sha256 from importer_linked_state where name = 'original'),
  'changed content receives a different immutable fingerprint'
);

${importerMutation(changed, fixture.ownerId)}

select pg_temp.importer_ok(
  (
    select count(*) = 2
    from public.practice_tests test
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.revision)}
  )
    and (
      select count(*) = 1
      from public.practice_tests test
      where test.id = (
        select practice_test_id from importer_linked_state where name = 'changed'
      )
    ),
  'replaying identical changed content is idempotent'
);

${throwsImporter({
  delimiter: "invalid_item_import",
  worksheet: invalid,
  createdBy: fixture.ownerId,
  sqlState: "22023",
  message: "A validated answer contract is required.",
  description: "one invalid question rejects the complete import statement",
})}

select pg_temp.importer_is(
  (
    select count(*)::integer
    from public.practice_tests test
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.invalid)}
  ),
  0,
  'the failed import rolls back its parent worksheet row'
);

select pg_temp.importer_is(
  (
    select count(*)::integer
    from public.practice_test_questions question
    join public.practice_tests test on test.id = question.practice_test_id
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.invalid)}
  ),
  0,
  'the failed import leaves no partial question rows'
);

${throwsImporter({
  delimiter: "missing_reviewer_import",
  worksheet: missing,
  createdBy: null,
  sqlState: "P0001",
  message:
    "A reviewer profile is required before an imported worksheet can be approved.",
  description: "a missing reviewer is rejected before any worksheet insert",
})}

select pg_temp.importer_is(
  (select count(*)::integer from public.practice_tests where title = ${sqlLiteral(fixtureTitles.missing)}),
  0,
  'a missing reviewer produces zero worksheet rows'
);

${throwsImporter({
  delimiter: "student_reviewer_import",
  worksheet: student,
  createdBy: fixture.studentId,
  sqlState: "P0001",
  message:
    "Reviewer must be an active owner or teacher in the target workspace.",
  description: "a student reviewer is rejected before any worksheet insert",
})}

select pg_temp.importer_is(
  (select count(*)::integer from public.practice_tests where title = ${sqlLiteral(fixtureTitles.student)}),
  0,
  'a student reviewer produces zero worksheet rows'
);

${throwsImporter({
  delimiter: "offboarded_reviewer_import",
  worksheet: offboarded,
  createdBy: fixture.offboardedId,
  sqlState: "P0001",
  message:
    "Reviewer must be an active owner or teacher in the target workspace.",
  description: "an offboarded reviewer is rejected before any worksheet insert",
})}

select pg_temp.importer_is(
  (select count(*)::integer from public.practice_tests where title = ${sqlLiteral(fixtureTitles.offboarded)}),
  0,
  'an offboarded reviewer produces zero worksheet rows'
);

${throwsImporter({
  delimiter: "unrelated_reviewer_import",
  worksheet: unrelated,
  createdBy: fixture.unrelatedTeacherId,
  sqlState: "P0001",
  message:
    "Reviewer must be an active owner or teacher in the target workspace.",
  description:
    "an unrelated-workspace teacher is rejected before any worksheet insert",
})}

select pg_temp.importer_is(
  (select count(*)::integer from public.practice_tests where title = ${sqlLiteral(fixtureTitles.unrelated)}),
  0,
  'an unrelated-workspace reviewer produces zero worksheet rows'
);

${importerMutation(owner, fixture.ownerId)}

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_tests test
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.owner)}
      and test.reviewed_by = ${sqlLiteral(fixture.ownerId)}::uuid
      and test.created_by = ${sqlLiteral(fixture.ownerId)}::uuid
      and test.quality_status = 'approved'
      and test.teacher_reviewed
  ),
  'an active workspace owner imports one approved immutable revision'
);

${importerMutation(teacher, fixture.teacherId)}

select pg_temp.importer_ok(
  exists (
    select 1
    from public.practice_tests test
    where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and test.title = ${sqlLiteral(fixtureTitles.teacher)}
      and test.reviewed_by = ${sqlLiteral(fixture.teacherId)}::uuid
      and test.created_by = ${sqlLiteral(fixture.teacherId)}::uuid
      and test.quality_status = 'approved'
      and test.teacher_reviewed
  ),
  'an active workspace teacher imports one approved immutable revision'
);

select pg_temp.importer_ok(
  (
    select count(*) = 2
      and bool_and(reviewed_by is not null and reviewed_at is not null)
    from public.practice_tests
    where title = any(array[
      ${sqlLiteral(fixtureTitles.owner)},
      ${sqlLiteral(fixtureTitles.teacher)}
    ]::text[])
  ),
  'successful authorization cases record exact reviewer provenance'
);

select pg_temp.importer_is(
  (
    select count(*)::integer
    from public.practice_tests
    where title = any(array[
      ${sqlLiteral(fixtureTitles.missing)},
      ${sqlLiteral(fixtureTitles.student)},
      ${sqlLiteral(fixtureTitles.offboarded)},
      ${sqlLiteral(fixtureTitles.unrelated)}
    ]::text[])
  ),
  0,
  'all denied reviewer identities collectively leave zero imports'
);

select pg_temp.importer_ok(
  (
    select count(*) = 4
      and bool_and(quality_status = 'approved')
    from public.practice_tests
    where workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      and title = any(array[
        ${sqlLiteral(fixtureTitles.revision)},
        ${sqlLiteral(fixtureTitles.owner)},
        ${sqlLiteral(fixtureTitles.teacher)}
      ]::text[])
  )
    and (
      select count(*) = 8
      from public.practice_test_questions question
      join public.practice_tests test on test.id = question.practice_test_id
      where test.workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
        and test.title = any(array[
          ${sqlLiteral(fixtureTitles.revision)},
          ${sqlLiteral(fixtureTitles.owner)},
          ${sqlLiteral(fixtureTitles.teacher)}
        ]::text[])
    ),
  'the complete fixture contains only the four expected successful revisions'
);

do $importer_assertion_count$
declare
  actual_assertion_count integer;
begin
  select count(*)::integer
  into actual_assertion_count
  from importer_linked_assertions;

  if actual_assertion_count <> 28 then
    raise exception using
      errcode = 'P0001',
      message = 'importer_regression_assertion_count_mismatch';
  end if;
end;
$importer_assertion_count$;

rollback;

${exactResidueGuardSql("IMPORTER_IN_QUERY_ROLLBACK_CONFIRMED")}
`;
}

function exactResidueGuardSql(marker: string) {
  return `do $importer_residue_guard$
begin
  if exists (
    select 1 from auth.users where id = any(${fixtureUserArray()})
  ) or exists (
    select 1
    from public.workspaces
    where id in (
      ${sqlLiteral(fixture.workspaceId)}::uuid,
      ${sqlLiteral(fixture.unrelatedWorkspaceId)}::uuid
    )
  ) or exists (
    select 1
    from public.grammar_topics
    where id = ${sqlLiteral(fixture.topicId)}::uuid
      or slug = ${sqlLiteral(fixture.topicSlug)}
  ) or exists (
    select 1
    from public.practice_tests
    where workspace_id = ${sqlLiteral(fixture.workspaceId)}::uuid
      or title = any(${worksheetTitleArray()})
  ) or exists (
    select 1
    from public.student_practice_assignments
    where id = ${sqlLiteral(fixture.assignmentId)}::uuid
  ) or exists (
    select 1
    from public.practice_test_attempts
    where id = ${sqlLiteral(fixture.attemptId)}::uuid
  ) or exists (
    select 1
    from public.practice_attempt_question_reviews
    where id = ${sqlLiteral(fixture.reviewId)}::uuid
  ) then
    raise exception using
      errcode = '55000',
      message = 'linked_importer_fixture_residue_detected';
  end if;
end;
$importer_residue_guard$;

select ${sqlLiteral(marker)} as importer_fixture_state;`;
}

function parseArgs(argv: string[]) {
  const normalizedArgs = argv[0] === "--" ? argv.slice(1) : argv;
  if (
    normalizedArgs.length !== 2 ||
    normalizedArgs[0] !== "--expected-project-ref" ||
    !normalizedArgs[1]
  ) {
    throw new Error(
      "Usage: linked importer regression --expected-project-ref <staging-project-ref>",
    );
  }
  if (normalizedArgs[1] !== stagingProjectRef) {
    throw new Error(
      "This regression harness is restricted to the staging project.",
    );
  }
  return normalizedArgs[1];
}

function runSupabase(args: string[], inheritOutput = true) {
  const executable = process.env.SUPABASE_BIN?.trim() || "supabase";
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!inheritOutput && result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      `Supabase command failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const expectedProjectRef = parseArgs(argv);
  const linkedProjectRef = (
    await readFile(
      resolve(repositoryRoot, "supabase/.temp/project-ref"),
      "utf8",
    )
  ).trim();
  if (linkedProjectRef !== expectedProjectRef) {
    throw new Error(
      `Refusing linked importer regression: expected ${expectedProjectRef}, found ${linkedProjectRef || "no linked project"}.`,
    );
  }

  runSupabase([
    "db",
    "query",
    "--linked",
    exactResidueGuardSql("IMPORTER_FIXTURE_NAMESPACE_CLEAN"),
  ]);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-linked-importer-"),
  );
  const testPath = join(temporaryDirectory, "importer-linked.test.sql");
  try {
    await writeFile(testPath, buildLinkedImporterRegressionSql(), {
      encoding: "utf8",
      mode: 0o600,
    });
    runSupabase(["db", "query", "--linked", "--file", testPath]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  runSupabase([
    "db",
    "query",
    "--linked",
    exactResidueGuardSql("IMPORTER_OUTER_ROLLBACK_CONFIRMED"),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        project_ref: expectedProjectRef,
        assertions: 28,
        fixture_scope: "exact deterministic IDs and titles",
        transaction: "outer rollback",
        residue: 0,
      },
      null,
      2,
    ),
  );
}

const isMainModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Linked importer regression failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
