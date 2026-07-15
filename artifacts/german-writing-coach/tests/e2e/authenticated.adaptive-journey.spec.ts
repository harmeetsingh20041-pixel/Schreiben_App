import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createAdaptiveJourneyRecoveryManifest,
  readAdaptiveJourneyRecoveryManifest,
  removeAdaptiveJourneyRecoveryManifest,
  type AdaptiveJourneyRecoveryManifest,
} from "./fixtures/adaptive-journey-recovery-manifest";

type Credentials = { email: string; password: string };
type AccountSlot = "TEACHER" | "STUDENT";

interface AdaptiveJourneyFixture extends AdaptiveJourneyRecoveryManifest {
  workspaceName: string;
  workspaceSlug: string;
  batchName: string;
  topicName: string;
  topicSlug: string;
}

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const PINNED_STAGING_SUPABASE_ORIGIN =
  "https://vzcgalzspdehmnvqczfw.supabase.co";
const PRIVATE_SQL_MAX_BUFFER = 1024 * 1024;
const PRIVATE_SQL_TIMEOUT_MS = 120_000;
const SAFE_STATUS_PATTERN = /\badaptive_journey_[a-z0-9_]+\b/g;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGINAL_WRITING = "Ich helfen.";
const CORRECTED_WRITING = "Ich helfe.";
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const recoveryOnly = process.env.E2E_ADAPTIVE_JOURNEY_RECOVERY_ONLY === "true";

let fixture: AdaptiveJourneyFixture | null = null;
let studentAccount: Credentials | null = null;
let fixtureInstalled = false;

class PrivateSqlError extends Error {
  constructor(readonly safeCode: string) {
    super(`Private staging SQL failed (${safeCode}).`);
    this.name = "PrivateSqlError";
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the adaptive-journey E2E.`);
  }
  return value;
}

function candidateAccounts(): Credentials[] {
  const candidates = [
    {
      email: requiredEnvironment("E2E_TEACHER_EMAIL"),
      password: requiredEnvironment("E2E_TEACHER_PASSWORD"),
    },
    {
      email: requiredEnvironment("E2E_STUDENT_EMAIL"),
      password: requiredEnvironment("E2E_STUDENT_PASSWORD"),
    },
  ];
  if (candidates[0].email.toLowerCase() === candidates[1].email.toLowerCase()) {
    throw new Error("The adaptive journey requires two distinct accounts.");
  }
  return candidates;
}

function resolveAccountSlots() {
  const requestedStudentSlot = requiredEnvironment("E2E_ADAPTIVE_STUDENT_SLOT");
  if (
    requestedStudentSlot !== "TEACHER" &&
    requestedStudentSlot !== "STUDENT"
  ) {
    throw new Error("E2E_ADAPTIVE_STUDENT_SLOT must equal TEACHER or STUDENT.");
  }
  const accounts = candidateAccounts();
  const studentIndex = requestedStudentSlot === "TEACHER" ? 0 : 1;
  return {
    student: accounts[studentIndex],
    teacher: accounts[studentIndex === 0 ? 1 : 0],
    studentSlot: requestedStudentSlot as AccountSlot,
  };
}

function repositoryRoot() {
  return REPOSITORY_ROOT;
}

function recoveryManifestPath() {
  return resolve(
    repositoryRoot(),
    ".e2e-private/adaptive-journey-fixture.json",
  );
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("The adaptive-journey fixture received an invalid UUID.");
  }
  return value;
}

function sqlUuid(value: string) {
  return `'${requireUuid(value)}'::uuid`;
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The adaptive-journey fixture received an invalid value.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureFromManifest(
  manifest: AdaptiveJourneyRecoveryManifest,
): AdaptiveJourneyFixture {
  const suffix = manifest.workspace_id.slice(0, 8);
  return {
    ...manifest,
    workspaceName: `V1 adaptive journey ${suffix}`,
    workspaceSlug: `e2e-adaptive-journey-${manifest.workspace_id}`,
    batchName: `Adaptive journey class ${suffix}`,
    topicName: "Conjugation",
    topicSlug: "conjugation",
  };
}

function newFixture(grammarTopicId: string): AdaptiveJourneyFixture {
  return fixtureFromManifest({
    schema_version: 1,
    project_ref: PINNED_STAGING_PROJECT_REF,
    workspace_id: randomUUID(),
    teacher_membership_id: randomUUID(),
    student_membership_id: randomUUID(),
    batch_id: randomUUID(),
    batch_student_id: randomUUID(),
    grammar_topic_id: requireUuid(grammarTopicId),
    first_submission_id: randomUUID(),
    recurrence_submission_id: randomUUID(),
    practice_test_ids: [randomUUID(), randomUUID()],
    question_ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  });
}

function manifestForFixture(
  target: AdaptiveJourneyFixture,
): AdaptiveJourneyRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PINNED_STAGING_PROJECT_REF,
    workspace_id: target.workspace_id,
    teacher_membership_id: target.teacher_membership_id,
    student_membership_id: target.student_membership_id,
    batch_id: target.batch_id,
    batch_student_id: target.batch_student_id,
    grammar_topic_id: target.grammar_topic_id,
    first_submission_id: target.first_submission_id,
    recurrence_submission_id: target.recurrence_submission_id,
    practice_test_ids: target.practice_test_ids,
    question_ids: target.question_ids,
  };
}

function assertPinnedLinkedStaging() {
  let projectRef = "";
  try {
    projectRef = readFileSync(
      resolve(repositoryRoot(), "supabase/.temp/project-ref"),
      "utf8",
    ).trim();
  } catch {
    throw new Error("The adaptive journey could not verify staging.");
  }
  if (projectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error("The adaptive journey is not linked to pinned staging.");
  }
}

function assertPinnedBrowserStaging() {
  const configuredOrigin = requiredEnvironment("VITE_SUPABASE_URL").replace(
    /\/$/,
    "",
  );
  if (
    configuredOrigin !== PINNED_STAGING_SUPABASE_ORIGIN ||
    process.env.E2E_BASE_URL?.trim()
  ) {
    throw new Error("The adaptive browser is not pinned to local staging.");
  }
}

async function installPinnedSupabaseRequestGuard(page: Page) {
  let blockedWrongProject = false;
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, async (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin !== PINNED_STAGING_SUPABASE_ORIGIN) {
      blockedWrongProject = true;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return () => expect(blockedWrongProject).toBe(false);
}

function runPrivateLinkedSql(
  sql: string,
  expectedStatuses: readonly string[],
  expectedStatusPrefix?: string,
) {
  assertPinnedLinkedStaging();
  const executable = requiredEnvironment("E2E_SUPABASE_BIN");
  if (!isAbsolute(executable)) {
    throw new Error("E2E_SUPABASE_BIN must be an absolute path.");
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("E2E_")),
  ) as NodeJS.ProcessEnv;
  const result = spawnSync(
    executable,
    ["db", "query", "--linked", "--file", "/dev/stdin"],
    {
      cwd: repositoryRoot(),
      env: childEnvironment,
      input: sql,
      encoding: "utf8",
      maxBuffer: PRIVATE_SQL_MAX_BUFFER,
      timeout: PRIVATE_SQL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      // Database output, credentials, writing, and answers are never retained.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const safeStatuses = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.match(new RegExp(SAFE_STATUS_PATTERN)) ?? []);
  if (result.error || result.status !== 0) {
    throw new PrivateSqlError(
      safeStatuses.at(-1) ?? "adaptive_journey_database_command_failed",
    );
  }
  const matched = safeStatuses.find(
    (status) =>
      expectedStatuses.includes(status) ||
      (expectedStatusPrefix !== undefined &&
        status.startsWith(expectedStatusPrefix)),
  );
  if (!matched) {
    throw new PrivateSqlError("adaptive_journey_safe_status_missing");
  }
  return matched;
}

function resolveCanonicalConjugationTopicId() {
  const statusPrefix = "adaptive_journey_conjugation_";
  const status = runPrivateLinkedSql(
    `
select case
  when count(*) = 1 then
    '${statusPrefix}' || replace(min(topic.id::text), '-', '')
  else 'adaptive_journey_canonical_topic_invalid'
end as safe_status
from public.grammar_topics topic
where topic.slug = 'conjugation'
  and topic.level = 'A1_A2'
  and topic.name = 'Conjugation';
`,
    [],
    statusPrefix,
  );
  const compactId = status.slice(statusPrefix.length);
  if (!/^[0-9a-f]{32}$/i.test(compactId)) {
    throw new Error("The canonical conjugation topic could not be verified.");
  }
  return requireUuid(
    `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`,
  );
}

function worksheetRowsSql(target: AdaptiveJourneyFixture) {
  return `
  insert into public.practice_tests (
    id, workspace_id, grammar_topic_id, level, difficulty, title,
    description, created_by_ai, teacher_reviewed, visibility, created_by,
    generation_source, quality_status
  ) values
    (
      ${sqlUuid(target.practice_test_ids[0])},
      ${sqlUuid(target.workspace_id)},
      ${sqlUuid(target.grammar_topic_id)},
      'A2', 'easy', 'Adaptive journey worksheet one',
      'Approved deterministic worksheet used by the adaptive browser proof.',
      false, true, 'workspace', teacher_profile_id, 'manual_import', 'approved'
    ),
    (
      ${sqlUuid(target.practice_test_ids[1])},
      ${sqlUuid(target.workspace_id)},
      ${sqlUuid(target.grammar_topic_id)},
      'A2', 'easy', 'Adaptive journey worksheet two',
      'Second approved deterministic worksheet reserved for recurrence.',
      false, true, 'workspace', teacher_profile_id, 'manual_import', 'approved'
    );

  insert into public.practice_test_questions (
    id, practice_test_id, question_number, question_type, evaluation_mode,
    prompt, options, correct_answer, accepted_answers, rubric,
    answer_contract_version, explanation
  ) values
    (
      ${sqlUuid(target.question_ids[0])},
      ${sqlUuid(target.practice_test_ids[0])},
      1, 'multiple_choice', 'local_exact',
      'Wähle die richtige Form: Ich ___ meiner Kollegin.',
      '["helfe","hilfst","helfen"]'::jsonb,
      'helfe', '["helfe"]'::jsonb, null, 1,
      'Ich requires the first-person singular form helfe.'
    ),
    (
      ${sqlUuid(target.question_ids[1])},
      ${sqlUuid(target.practice_test_ids[0])},
      2, 'multiple_choice', 'local_exact',
      'Wähle die richtige Form: Er ___ heute zur Arbeit.',
      '["geht","gehe","gehen"]'::jsonb,
      'geht', '["geht"]'::jsonb, null, 1,
      'Er requires the third-person singular form geht.'
    ),
    (
      ${sqlUuid(target.question_ids[2])},
      ${sqlUuid(target.practice_test_ids[1])},
      1, 'multiple_choice', 'local_exact',
      'Wähle die richtige Form: Ich ___ jeden Morgen Deutsch.',
      '["lerne","lernst","lernen"]'::jsonb,
      'lerne', '["lerne"]'::jsonb, null, 1,
      'Ich requires the first-person singular form lerne.'
    ),
    (
      ${sqlUuid(target.question_ids[3])},
      ${sqlUuid(target.practice_test_ids[1])},
      2, 'multiple_choice', 'local_exact',
      'Wähle die richtige Form: Sie ___ im Krankenhaus.',
      '["arbeitet","arbeite","arbeiten"]'::jsonb,
      'arbeitet', '["arbeitet"]'::jsonb, null, 1,
      'Singular sie requires the third-person form arbeitet.'
    );
  `;
}

function releasedSubmissionSql(
  target: AdaptiveJourneyFixture,
  submissionId: string,
  summary: string,
) {
  const feedbackIdExpression = `md5(${sqlLiteral(`${submissionId}-feedback`)})::uuid`;
  return `
  insert into public.submissions (
    id, workspace_id, student_id, batch_id, question_source, mode,
    original_text, corrected_text, overall_summary, level_detected, status,
    feedback_mode, evaluation_status, release_status, checked_at
  ) values (
    ${sqlUuid(submissionId)},
    ${sqlUuid(target.workspace_id)},
    student_profile_id,
    ${sqlUuid(target.batch_id)},
    'free_text', 'free_text',
    ${sqlLiteral(ORIGINAL_WRITING)},
    null,
    null,
    null, 'submitted', 'immediate', 'processing', 'held', null
  );

  insert into app_private.writing_evaluation_contexts (
    submission_id, context_version, workspace_id, student_id, batch_id,
    cefr_level, source_type, source_id, submission_mode, question_metadata,
    original_text_sha256, context_sha256
  )
  select
    ${sqlUuid(submissionId)},
    1,
    ${sqlUuid(target.workspace_id)},
    student_profile_id,
    ${sqlUuid(target.batch_id)},
    'A2', 'free_text', null, 'free_text', '{}'::jsonb,
    source_hash,
    app_private.writing_evaluation_context_sha256(
      ${sqlUuid(submissionId)},
      1::smallint,
      ${sqlUuid(target.workspace_id)},
      student_profile_id,
      ${sqlUuid(target.batch_id)},
      'A2', 'free_text', null, 'free_text', '{}'::jsonb,
      source_hash
    )
  from (
    select pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(${sqlLiteral(ORIGINAL_WRITING)}, 'UTF8')
      ),
      'hex'
    ) as source_hash
  ) source;

  insert into app_private.feedback_drafts (
    id, submission_id, version, state, provider_model, content,
    approved_at, approved_by
  ) values (
    ${feedbackIdExpression},
    ${sqlUuid(submissionId)},
    1,
    'approved',
    'adaptive_journey_fixture',
    jsonb_build_object(
      'feedback_contract_version', 2,
      'overall_summary', ${sqlLiteral(summary)},
      'level_detected', 'A2',
      'corrected_text', ${sqlLiteral(CORRECTED_WRITING)},
      'ai_model', 'adaptive_journey_fixture',
      'score_summary', '{}'::jsonb,
      'grammar_topics', '[]'::jsonb,
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 11,
        'original_line', ${sqlLiteral(ORIGINAL_WRITING)},
        'corrected_line', ${sqlLiteral(CORRECTED_WRITING)},
        'status', 'minor_issue',
        'changed_parts', jsonb_build_array(jsonb_build_object(
          'from', 'helfen',
          'to', 'helfe',
          'reason', 'The verb must agree with ich.',
          'source_start', 4,
          'source_end', 10,
          'corrected_start', 4,
          'corrected_end', 9,
          'severity', 'minor',
          'grammar_topics', jsonb_build_array(${sqlLiteral(target.topicSlug)})
        )),
        'short_explanation',
          'Use the first-person singular form with ich.',
        'detailed_explanation', '',
        'grammar_topic', ${sqlLiteral(target.topicSlug)}
      ))
    ),
    now(), teacher_profile_id
  );

  perform app_private.materialize_feedback_draft(
    ${sqlUuid(submissionId)},
    ${feedbackIdExpression},
    teacher_profile_id
  );
  `;
}

function createFixtureSql(
  target: AdaptiveJourneyFixture,
  teacher: Credentials,
  student: Credentials,
) {
  return `
begin;
do $adaptive_journey_setup$
declare
  teacher_profile_id uuid;
  student_profile_id uuid;
  teacher_role text;
  student_role text;
begin
  select profile.id, profile.global_role
  into teacher_profile_id, teacher_role
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(teacher.email)});

  select profile.id, profile.global_role
  into student_profile_id, student_role
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(student.email)});

  if teacher_profile_id is null
    or student_profile_id is null
    or teacher_profile_id = student_profile_id
    or teacher_role not in ('teacher', 'platform_admin')
    or student_role <> 'student'
  then
    raise exception using message = 'adaptive_journey_accounts_invalid';
  end if;

  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspace_id)}
       or workspace.slug = ${sqlLiteral(target.workspaceSlug)}
  ) then
    raise exception using message = 'adaptive_journey_scope_not_empty';
  end if;

  if not exists (
    select 1 from public.grammar_topics topic
    where topic.id = ${sqlUuid(target.grammar_topic_id)}
      and topic.slug = ${sqlLiteral(target.topicSlug)}
      and topic.name = ${sqlLiteral(target.topicName)}
      and topic.level = 'A1_A2'
  ) then
    raise exception using message = 'adaptive_journey_canonical_topic_invalid';
  end if;

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(target.workspace_id)},
    ${sqlLiteral(target.workspaceName)},
    ${sqlLiteral(target.workspaceSlug)},
    teacher_profile_id
  );

  insert into public.workspace_members (id, workspace_id, user_id, role)
  values
    (
      ${sqlUuid(target.teacher_membership_id)},
      ${sqlUuid(target.workspace_id)},
      teacher_profile_id,
      'teacher'
    ),
    (
      ${sqlUuid(target.student_membership_id)},
      ${sqlUuid(target.workspace_id)},
      student_profile_id,
      'student'
    );

  insert into public.batches (
    id, workspace_id, name, level, created_by, feedback_mode, is_active,
    join_requires_approval
  ) values (
    ${sqlUuid(target.batch_id)},
    ${sqlUuid(target.workspace_id)},
    ${sqlLiteral(target.batchName)},
    'A2', teacher_profile_id, 'immediate', true, true
  );

  insert into public.batch_students (id, batch_id, student_id, workspace_id)
  values (
    ${sqlUuid(target.batch_student_id)},
    ${sqlUuid(target.batch_id)},
    student_profile_id,
    ${sqlUuid(target.workspace_id)}
  );

  ${worksheetRowsSql(target)}
  ${releasedSubmissionSql(
    target,
    target.first_submission_id,
    "The verb form needs to agree with the subject.",
  )}

  if (
    select count(*)
    from public.student_practice_assignments assignment
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    where assignment.workspace_id = ${sqlUuid(target.workspace_id)}
      and assignment.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and assignment.status = 'unlocked'
      and assignment.generation_status = 'ready'
      and assignment.source = 'weakness_auto'
      and assignment.resolution_cycle_number = 1
      and worksheet.quality_status = 'approved'
      and worksheet.teacher_reviewed
      and worksheet.generation_source = 'manual_import'
  ) <> 1 or (
    select count(*)
    from public.submission_lines line
    where line.submission_id = ${sqlUuid(target.first_submission_id)}
      and line.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and line.source_start = 0
      and line.source_end = 11
      and line.original_line = ${sqlLiteral(ORIGINAL_WRITING)}
      and line.corrected_line = ${sqlLiteral(CORRECTED_WRITING)}
      and line.status = 'minor_issue'
  ) <> 1 or (
    select count(*)
    from public.submission_grammar_topics topic
    where topic.submission_id = ${sqlUuid(target.first_submission_id)}
      and topic.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and topic.count = 1
      and topic.severity = 'minor'
  ) <> 1 or (
    select count(*)
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = ${sqlUuid(target.workspace_id)}
      and evidence.submission_id = ${sqlUuid(target.first_submission_id)}
      and evidence.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and evidence.minor_issue_count = 1
      and evidence.major_issue_count = 0
  ) <> 1 or exists (
    select 1 from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where assignment.workspace_id = ${sqlUuid(target.workspace_id)}
  ) then
    raise exception using message = 'adaptive_journey_initial_unlock_invalid';
  end if;
end;
$adaptive_journey_setup$;
commit;
select 'adaptive_journey_fixture_ready' as safe_status;
`;
}

function completeFirstCycleSql(
  target: AdaptiveJourneyFixture,
  firstAssignmentId: string,
) {
  return `
begin;
do $adaptive_journey_first_pass$
declare
  transition_attempt integer;
begin
  for transition_attempt in 1..20 loop
    perform app_private.process_practice_cycle_transition_jobs(1);
    exit when exists (
      select 1
      from public.student_practice_assignments assignment
      join app_private.practice_resolution_cycles cycle
        on cycle.resolution_assignment_id = assignment.id
      where assignment.id = ${sqlUuid(firstAssignmentId)}
        and assignment.workspace_id = ${sqlUuid(target.workspace_id)}
        and assignment.status = 'passed'
        and cycle.resolved_at is not null
    );
    perform pg_catalog.pg_sleep(0.25);
  end loop;

  if not exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
     and attempt.assignment_id = assignment.id
    join app_private.practice_resolution_cycles cycle
      on cycle.resolution_assignment_id = assignment.id
    where assignment.id = ${sqlUuid(firstAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(target.workspace_id)}
      and assignment.status = 'passed'
      and attempt.status = 'checked'
      and attempt.passed
      and attempt.score_percent = 100
      and cycle.cycle_number = 1
      and cycle.state = 'improving'
      and cycle.resolution_outcome = 'passed'
      and cycle.resolved_at is not null
  ) then
    raise exception using message = 'adaptive_journey_resolution_result_invalid';
  end if;

  if exists (
    select 1 from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = ${sqlUuid(target.workspace_id)}
      and cycle.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and cycle.resolved_at is null
  ) then
    raise exception using message = 'adaptive_journey_resolution_cycle_open';
  end if;

  if exists (
    select 1 from public.student_practice_assignments assignment
    where assignment.workspace_id = ${sqlUuid(target.workspace_id)}
      and assignment.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ) then
    raise exception using message = 'adaptive_journey_resolution_assignment_active';
  end if;
end;
$adaptive_journey_first_pass$;
commit;
select 'adaptive_journey_first_cycle_resolved' as safe_status;
`;
}

function createRecurrenceSql(
  target: AdaptiveJourneyFixture,
  firstAssignmentId: string,
) {
  return `
begin;
do $adaptive_journey_recurrence$
declare
  teacher_profile_id uuid;
  student_profile_id uuid;
begin
  select workspace.owner_id
  into teacher_profile_id
  from public.workspaces workspace
  where workspace.id = ${sqlUuid(target.workspace_id)}
    and workspace.slug = ${sqlLiteral(target.workspaceSlug)};

  select membership.user_id
  into student_profile_id
  from public.workspace_members membership
  where membership.id = ${sqlUuid(target.student_membership_id)}
    and membership.workspace_id = ${sqlUuid(target.workspace_id)}
    and membership.role = 'student';

  if teacher_profile_id is null or student_profile_id is null then
    raise exception using message = 'adaptive_journey_recurrence_scope_invalid';
  end if;

  ${releasedSubmissionSql(
    target,
    target.recurrence_submission_id,
    "The same conjugation issue appeared in a later writing.",
  )}

  if (
    select count(*)
    from public.student_practice_assignments assignment
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    where assignment.workspace_id = ${sqlUuid(target.workspace_id)}
      and assignment.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and assignment.status in ('unlocked', 'in_progress', 'completed')
      and assignment.id <> ${sqlUuid(firstAssignmentId)}
      and assignment.previous_assignment_id = ${sqlUuid(firstAssignmentId)}
      and assignment.source = 'adaptive_repeat'
      and assignment.generation_status = 'ready'
      and cycle.cycle_number = 2
      and cycle.state = 'unlocked'
      and cycle.resolved_at is null
      and worksheet.quality_status = 'approved'
      and worksheet.teacher_reviewed
      and worksheet.generation_source = 'manual_import'
      and worksheet.id <> (
        select prior.practice_test_id
        from public.student_practice_assignments prior
        where prior.id = ${sqlUuid(firstAssignmentId)}
      )
  ) <> 1 or (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = ${sqlUuid(target.workspace_id)}
      and assignment.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ) <> 1 or (
    select count(*)
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = ${sqlUuid(target.workspace_id)}
      and evidence.grammar_topic_id = ${sqlUuid(target.grammar_topic_id)}
      and evidence.submission_id in (
        ${sqlUuid(target.first_submission_id)},
        ${sqlUuid(target.recurrence_submission_id)}
      )
  ) <> 2 then
    raise exception using message = 'adaptive_journey_recurrence_invalid';
  end if;
end;
$adaptive_journey_recurrence$;
commit;
select 'adaptive_journey_recurrence_ready' as safe_status;
`;
}

function cleanupFixtureSql(target: AdaptiveJourneyFixture) {
  return `
begin;
do $adaptive_journey_cleanup_lock$
begin
  perform workspace.id
  from public.workspaces workspace
  where workspace.id = ${sqlUuid(target.workspace_id)}
  for update nowait;
exception
  when lock_not_available then
    raise exception using message = 'adaptive_journey_cleanup_active';
end;
$adaptive_journey_cleanup_lock$;

create temp table adaptive_journey_submission_ids (id uuid primary key)
on commit drop;
insert into pg_temp.adaptive_journey_submission_ids (id)
select submission.id from public.submissions submission
where submission.workspace_id = ${sqlUuid(target.workspace_id)};

create temp table adaptive_journey_assignment_ids (id uuid primary key)
on commit drop;
insert into pg_temp.adaptive_journey_assignment_ids (id)
select assignment.id from public.student_practice_assignments assignment
where assignment.workspace_id = ${sqlUuid(target.workspace_id)};

create temp table adaptive_journey_test_ids (id uuid primary key)
on commit drop;
insert into pg_temp.adaptive_journey_test_ids (id)
select worksheet.id from public.practice_tests worksheet
where worksheet.workspace_id = ${sqlUuid(target.workspace_id)};

create temp table adaptive_journey_attempt_ids (id uuid primary key)
on commit drop;
insert into pg_temp.adaptive_journey_attempt_ids (id)
select attempt.id from public.practice_test_attempts attempt
where attempt.workspace_id = ${sqlUuid(target.workspace_id)};

create temp table adaptive_journey_cycle_ids (id uuid primary key)
on commit drop;
insert into pg_temp.adaptive_journey_cycle_ids (id)
select cycle.id from app_private.practice_resolution_cycles cycle
where cycle.workspace_id = ${sqlUuid(target.workspace_id)};

do $adaptive_journey_cleanup_scope$
declare
  workspace_exists boolean := exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspace_id)}
  );
begin
  if not workspace_exists then
    if exists (
      select 1 from public.batches batch
      where batch.id = ${sqlUuid(target.batch_id)}
    ) or exists (
      select 1 from public.workspace_members membership
      where membership.id in (
        ${sqlUuid(target.teacher_membership_id)},
        ${sqlUuid(target.student_membership_id)}
      )
    ) then
      raise exception using message = 'adaptive_journey_cleanup_identity_mismatch';
    end if;
    return;
  end if;

  if not exists (
    select 1
    from public.workspaces workspace
    join public.batches batch on batch.workspace_id = workspace.id
    join public.batch_students enrollment
      on enrollment.batch_id = batch.id
     and enrollment.workspace_id = workspace.id
    where workspace.id = ${sqlUuid(target.workspace_id)}
      and workspace.name = ${sqlLiteral(target.workspaceName)}
      and workspace.slug = ${sqlLiteral(target.workspaceSlug)}
      and batch.id = ${sqlUuid(target.batch_id)}
      and batch.name = ${sqlLiteral(target.batchName)}
      and enrollment.id = ${sqlUuid(target.batch_student_id)}
  ) then
    raise exception using message = 'adaptive_journey_cleanup_identity_mismatch';
  end if;

  if (select count(*) from pg_temp.adaptive_journey_submission_ids) > 2
    or (select count(*) from pg_temp.adaptive_journey_assignment_ids) > 2
    or (select count(*) from pg_temp.adaptive_journey_test_ids) <> 2
    or exists (
      select 1 from pg_temp.adaptive_journey_test_ids worksheet
      where worksheet.id not in (
        ${sqlUuid(target.practice_test_ids[0])},
        ${sqlUuid(target.practice_test_ids[1])}
      )
    )
    or exists (
      select 1 from app_private.async_jobs job
      where job.entity_id in (
        select submission.id from pg_temp.adaptive_journey_submission_ids submission
        union all
        select assignment.id from pg_temp.adaptive_journey_assignment_ids assignment
        union all
        select attempt.id from pg_temp.adaptive_journey_attempt_ids attempt
      )
    )
  then
    raise exception using message = 'adaptive_journey_cleanup_scope_changed';
  end if;
end;
$adaptive_journey_cleanup_scope$;

set local session_replication_role = replica;

delete from app_private.feedback_draft_events event
where event.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from app_private.practice_resolution_cycle_events event
where event.cycle_id in (
  select cycle.id from pg_temp.adaptive_journey_cycle_ids cycle
);
delete from app_private.feedback_drafts draft
where draft.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from app_private.writing_evaluation_context_holds hold
where hold.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from api.submission_status_events status_event
where status_event.id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from public.submission_lines line
where line.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from public.submission_grammar_topics topic
where topic.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from public.teacher_notes note
where note.submission_id in (
  select submission.id from pg_temp.adaptive_journey_submission_ids submission
);
delete from public.practice_test_questions question
where question.practice_test_id in (
  select worksheet.id from pg_temp.adaptive_journey_test_ids worksheet
);

do $adaptive_journey_workspace_cleanup$
declare
  relation_name text;
begin
  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attname = 'workspace_id'
     and attribute.attnum > 0
     and not attribute.attisdropped
    where namespace.nspname in ('api', 'app_private', 'public')
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  loop
    execute format('delete from %s where workspace_id = $1', relation_name)
    using ${sqlUuid(target.workspace_id)};
  end loop;
end;
$adaptive_journey_workspace_cleanup$;

delete from public.workspaces workspace
where workspace.id = ${sqlUuid(target.workspace_id)};

set local session_replication_role = origin;

do $adaptive_journey_cleanup_residue$
declare
  relation_name text;
  residue_exists boolean;
begin
  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspace_id)}
  ) or exists (
    select 1 from app_private.feedback_drafts draft
    where draft.submission_id in (
      ${sqlUuid(target.first_submission_id)},
      ${sqlUuid(target.recurrence_submission_id)}
    )
  ) or exists (
    select 1 from public.practice_test_questions question
    where question.id in (
      ${target.question_ids.map(sqlUuid).join(",\n      ")}
    )
  ) then
    raise exception using message = 'adaptive_journey_cleanup_residue';
  end if;

  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attname = 'workspace_id'
     and attribute.attnum > 0
     and not attribute.attisdropped
    where namespace.nspname in ('api', 'app_private', 'public')
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  loop
    execute format(
      'select exists (select 1 from %s where workspace_id = $1)',
      relation_name
    ) into residue_exists using ${sqlUuid(target.workspace_id)};
    if residue_exists then
      raise exception using message = 'adaptive_journey_cleanup_residue';
    end if;
  end loop;
end;
$adaptive_journey_cleanup_residue$;
commit;
select 'adaptive_journey_cleanup_ok' as safe_status;
`;
}

async function recoverPreviousFixture() {
  assertPinnedLinkedStaging();
  const path = recoveryManifestPath();
  const manifest = await readAdaptiveJourneyRecoveryManifest(
    path,
    PINNED_STAGING_PROJECT_REF,
  );
  if (!manifest) return;
  const previousFixture = fixtureFromManifest(manifest);
  try {
    runPrivateLinkedSql(cleanupFixtureSql(previousFixture), [
      "adaptive_journey_cleanup_ok",
    ]);
  } catch {
    throw new Error(
      "The prior adaptive-journey fixture could not be recovered safely. Its private manifest was retained.",
    );
  }
  await removeAdaptiveJourneyRecoveryManifest(path, PINNED_STAGING_PROJECT_REF);
}

async function signInStudent(
  page: Page,
  account: Credentials,
  membershipId: string,
) {
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.evaluate((targetMembershipId) => {
    window.localStorage.setItem("gwc_active_membership_id", targetMembershipId);
  }, membershipId);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("gwc_active_membership_id"),
        ),
      { timeout: 15_000 },
    )
    .toBe(membershipId);
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectFixtureWorkspace(
  page: Page,
  target: AdaptiveJourneyFixture,
) {
  await page.goto("/student/dashboard");
  const selector = visibleWorkspaceSelector(page);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("gwc_active_membership_id"),
        ),
      { timeout: 15_000 },
    )
    .toBe(target.student_membership_id);
  if ((await selector.count()) === 1) {
    await expect(selector).toContainText(target.workspaceName);
  } else {
    await expect(selector).toHaveCount(0);
  }
}

function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

function topicCard(page: Page, topicName: string) {
  return page
    .getByRole("heading", { name: topicName, exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'p-6')][1]");
}

async function waitForDraftSaved(page: Page) {
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved",
    { timeout: 20_000 },
  );
}

async function chooseAnswer(control: Locator, answer: string) {
  const option = control.getByRole("radio", { name: answer, exact: true });
  await expect(option).toHaveCount(1);
  await option.click();
}

async function availableAnswer(
  control: Locator,
  candidates: readonly string[],
) {
  for (const candidate of candidates) {
    if (
      (await control
        .getByRole("radio", { name: candidate, exact: true })
        .count()) === 1
    ) {
      return candidate;
    }
  }
  throw new Error("The approved worksheet answer contract was incomplete.");
}

test.skip(
  process.env.E2E_ADAPTIVE_JOURNEY !== "true" && !recoveryOnly,
  "Set E2E_ADAPTIVE_JOURNEY=true for the isolated stitched staging proof or E2E_ADAPTIVE_JOURNEY_RECOVERY_ONLY=true for exact recovery.",
);

test.describe.serial("isolated stitched adaptive student journey", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(async () => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    await recoverPreviousFixture();
    if (recoveryOnly) return;

    assertPinnedBrowserStaging();
    const accounts = resolveAccountSlots();
    studentAccount = accounts.student;
    fixture = newFixture(resolveCanonicalConjugationTopicId());
    await createAdaptiveJourneyRecoveryManifest(
      recoveryManifestPath(),
      manifestForFixture(fixture),
      PINNED_STAGING_PROJECT_REF,
    );
    try {
      runPrivateLinkedSql(
        createFixtureSql(fixture, accounts.teacher, accounts.student),
        ["adaptive_journey_fixture_ready"],
      );
      fixtureInstalled = true;
    } catch (error) {
      await recoverPreviousFixture();
      const safeCode =
        error instanceof PrivateSqlError
          ? error.safeCode
          : "adaptive_journey_fixture_setup_failed";
      throw new Error(
        `Adaptive-journey setup failed (${safeCode}); exact recovery completed.`,
      );
    }
  });

  test.afterAll(async () => {
    if (!fixtureInstalled || !fixture) return;
    runPrivateLinkedSql(cleanupFixtureSql(fixture), [
      "adaptive_journey_cleanup_ok",
    ]);
    await removeAdaptiveJourneyRecoveryManifest(
      recoveryManifestPath(),
      PINNED_STAGING_PROJECT_REF,
    );
  });

  test("released writing unlocks one approved worksheet, autosave survives reload, a pass resolves it, and recurrence creates one new worksheet", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(recoveryOnly, "Exact recovery only.");
    if (!fixture || !studentAccount) {
      throw new Error("The adaptive-journey fixture was not prepared.");
    }
    const assertPinnedProject = await installPinnedSupabaseRequestGuard(page);
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);

    await signInStudent(page, studentAccount, fixture.student_membership_id);
    await selectFixtureWorkspace(page, fixture);

    await page.goto(`/student/submission/${fixture.first_submission_id}`);
    await expect(
      page.getByRole("heading", { name: "Feedback Summary", level: 2 }),
    ).toBeVisible({ timeout: 15_000 });
    const originalCard = page
      .getByText("Original Submission", { exact: true })
      .locator("xpath=ancestor::*[contains(@class, 'rounded-xl')][1]");
    const correctedCard = page
      .getByText("Corrected Version", { exact: true })
      .locator("xpath=ancestor::*[contains(@class, 'rounded-xl')][1]");
    await expect(
      originalCard.getByText(ORIGINAL_WRITING, { exact: true }),
    ).toBeVisible();
    await expect(
      correctedCard.getByText(CORRECTED_WRITING, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("1 lines checked", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Use the first-person singular form with ich.", {
        exact: true,
      }),
    ).toBeVisible();
    const grammarTopicsTab = page.getByRole("tab", {
      name: "Grammar Topics",
    });
    await grammarTopicsTab.click();
    await expect(grammarTopicsTab).toHaveAttribute("data-state", "active");
    const grammarTopicsPanel = page.getByRole("tabpanel");
    const grammarTopicLabel = grammarTopicsPanel
      .getByText(fixture.topicName)
      .first();
    if (!(await grammarTopicLabel.isVisible())) {
      if (
        await page
          .getByText(
            "No specific grammar issues identified in this submission.",
            {
              exact: true,
            },
          )
          .isVisible()
      ) {
        throw new Error("adaptive_journey_feedback_topics_empty");
      }
      if (await page.getByText(fixture.topicSlug).isVisible()) {
        throw new Error("adaptive_journey_feedback_topic_slug_visible");
      }
    }
    await expect(grammarTopicLabel).toBeVisible();

    await page.goto("/student/practice");
    await expect(
      page.getByRole("heading", { name: "Practice Center", level: 1 }),
    ).toBeVisible();
    let card = topicCard(page, fixture.topicName);
    await expect(
      card.getByText("Practice unlocked", { exact: true }),
    ).toBeVisible();
    const firstStart = card.getByRole("link", {
      name: "Start worksheet",
      exact: true,
    });
    await expect(firstStart).toHaveCount(1);
    await firstStart.click();
    await expect(
      page.getByRole("progressbar", { name: "Worksheet answer progress" }),
    ).toBeVisible({ timeout: 15_000 });

    const firstAssignmentId = requireUuid(
      new URL(page.url()).pathname.split("/").at(-1) ?? "",
    );
    const firstQuestion = page.getByTestId("worksheet-answer-1");
    const secondQuestion = page.getByTestId("worksheet-answer-2");
    const firstCorrectAnswer = await availableAnswer(firstQuestion, [
      "helfe",
      "lerne",
    ]);
    const secondCorrectAnswer = await availableAnswer(secondQuestion, [
      "geht",
      "arbeitet",
    ]);

    await chooseAnswer(firstQuestion, firstCorrectAnswer);
    await waitForDraftSaved(page);
    await page.reload();
    await expect(
      page
        .getByTestId("worksheet-answer-1")
        .getByRole("radio", { name: firstCorrectAnswer, exact: true }),
    ).toBeChecked({ timeout: 15_000 });
    await chooseAnswer(
      page.getByTestId("worksheet-answer-2"),
      secondCorrectAnswer,
    );
    await waitForDraftSaved(page);

    const submit = page.getByRole("button", { name: "Submit worksheet" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("practice-score")).toContainText("100%", {
      timeout: 20_000,
    });
    await expect(
      page.getByText("Passed", { exact: true }).first(),
    ).toBeVisible();

    runPrivateLinkedSql(completeFirstCycleSql(fixture, firstAssignmentId), [
      "adaptive_journey_first_cycle_resolved",
    ]);
    await page.goto("/student/practice");
    card = topicCard(page, fixture.topicName);
    await expect(card.getByText("Improving", { exact: true })).toBeVisible();
    await expect(
      card.getByRole("link", { name: "Start worksheet" }),
    ).toHaveCount(0);

    runPrivateLinkedSql(createRecurrenceSql(fixture, firstAssignmentId), [
      "adaptive_journey_recurrence_ready",
    ]);
    await page.reload();
    card = topicCard(page, fixture.topicName);
    await expect(
      card.getByText("Practice unlocked", { exact: true }),
    ).toBeVisible();
    const recurrenceStart = card.getByRole("link", {
      name: "Start worksheet",
      exact: true,
    });
    await expect(recurrenceStart).toHaveCount(1);
    await recurrenceStart.click();
    await expect(
      page.getByRole("progressbar", { name: "Worksheet answer progress" }),
    ).toBeVisible({ timeout: 15_000 });
    const recurrenceAssignmentId = requireUuid(
      new URL(page.url()).pathname.split("/").at(-1) ?? "",
    );
    expect(recurrenceAssignmentId).not.toBe(firstAssignmentId);

    assertPinnedProject();
    assertNoFatalFailures();
  });
});
