import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

type Credentials = { email: string; password: string };
type AccountSlot = "TEACHER" | "STUDENT";
type WorksheetLiveProfile = "mcq_safe" | "rich_mixed";
type WorksheetLevel = "A1" | "A2" | "B1" | "B2";

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const PINNED_STAGING_SUPABASE_ORIGIN =
  "https://vzcgalzspdehmnvqczfw.supabase.co";
const PRIVATE_SQL_MAX_BUFFER = 1024 * 1024;
const PRIVATE_SQL_TIMEOUT_MS = 120_000;
const PRIVATE_SQL_SAFE_STATUS_PATTERN = /\bworksheet_live_[a-z0-9_]+\b/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_PROGRESS_GATE_MS = 5_000;
const GENERATION_TERMINAL_GATE_MS = 210_000;
const GENERATION_PERFORMANCE_SMOKE_MS = 90_000;
const EVALUATION_TERMINAL_GATE_MS = 180_000;
const SYNTHETIC_SHORT_ANSWER = "der";
const SYNTHETIC_OPEN_ANSWER = "Ich lerne jeden Tag Deutsch.";
const WORKSHEET_LEVELS = ["A1", "A2", "B1", "B2"] as const;

const FIXTURE = Object.freeze({
  workspaceId: "e1300000-0000-4000-8000-000000000001",
  workspaceName: "V1 worksheet live e1300000",
  workspaceSlug: "e2e-worksheet-live-e1300000-0000-4000-8000-000000000001",
  teacherMembershipId: "e1300000-0000-4000-8000-000000000002",
  studentMembershipId: "e1300000-0000-4000-8000-000000000003",
  batchId: "e1300000-0000-4000-8000-000000000004",
  batchName: "Worksheet live class e1300000",
  batchStudentId: "e1300000-0000-4000-8000-000000000005",
  providerAssignmentId: "e1300000-0000-4000-8000-000000000006",
  bankAssignmentId: "e1300000-0000-4000-8000-000000000007",
  providerTopicId: "e1300000-0000-4000-8000-000000000008",
  providerTopicSlug: "e2e-worksheet-provider-canary",
});

let studentAccount: Credentials | null = null;
let teacherAccount: Credentials | null = null;
let fixtureInstalled = false;
let bankAssignmentAvailable = false;
let worksheetLevel: WorksheetLevel | null = null;
const recoveryOnly = process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY === "true";
const requireBank = process.env.E2E_REQUIRE_BANK === "true";

class PrivateSqlError extends Error {
  constructor(readonly safeCode: string) {
    super(`Private staging SQL failed (${safeCode}).`);
    this.name = "PrivateSqlError";
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live worksheet E2E.`);
  return value;
}

function requiredWorksheetLevel(): WorksheetLevel {
  const value = requiredEnvironment("E2E_WORKSHEET_LEVEL");
  if (!WORKSHEET_LEVELS.includes(value as WorksheetLevel)) {
    throw new Error(
      "E2E_WORKSHEET_LEVEL must equal A1, A2, B1, or B2 for live worksheet E2E.",
    );
  }
  return value as WorksheetLevel;
}

function activeWorksheetLevel() {
  if (!worksheetLevel) {
    throw new Error("The live worksheet level was not prepared.");
  }
  return worksheetLevel;
}

function expectedQuestionCount(level = activeWorksheetLevel()) {
  return level === "A2" ? 9 : 8;
}

function providerTopicDescription(level: WorksheetLevel) {
  return `Synthetic staging canary for focused ${level} accusative-case practice.`;
}

function bankTopicLevelsSql(level: WorksheetLevel) {
  return level === "A1" || level === "A2"
    ? `${sqlLiteral(level)}, 'A1_A2'`
    : sqlLiteral(level);
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
    throw new Error("The live worksheet check requires two distinct accounts.");
  }
  return candidates;
}

function resolveAccountSlots() {
  const requestedStudentSlot = requiredEnvironment(
    "E2E_WORKSHEET_STUDENT_SLOT",
  );
  if (
    requestedStudentSlot !== "TEACHER" &&
    requestedStudentSlot !== "STUDENT"
  ) {
    throw new Error(
      "E2E_WORKSHEET_STUDENT_SLOT must equal TEACHER or STUDENT.",
    );
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
  return resolve(process.cwd(), "../..");
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("The live worksheet fixture received an invalid UUID.");
  }
  return value;
}

function sqlUuid(value: string) {
  return `'${requireUuid(value)}'::uuid`;
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The live worksheet fixture received an invalid value.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function assertPinnedLinkedStaging() {
  let linkedProjectRef = "";
  try {
    linkedProjectRef = readFileSync(
      resolve(repositoryRoot(), "supabase/.temp/project-ref"),
      "utf8",
    ).trim();
  } catch {
    throw new Error("The live worksheet check could not verify staging.");
  }
  if (linkedProjectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error(
      "The live worksheet check is not linked to pinned staging.",
    );
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
    throw new Error(
      "The live worksheet browser is not pinned to local staging.",
    );
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
  expectedStatusPrefixes: readonly string[] = [],
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
      // SQL, provider payloads, credentials, and worksheet/answer content never
      // become Playwright artifacts or exception text.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const safeStatuses = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string")
    .flatMap(
      (value) =>
        value.match(new RegExp(PRIVATE_SQL_SAFE_STATUS_PATTERN, "g")) ?? [],
    );
  if (result.error || result.status !== 0) {
    throw new PrivateSqlError(
      safeStatuses.at(-1) ?? "worksheet_live_database_command_failed",
    );
  }
  const matched = safeStatuses.find(
    (value) =>
      expectedStatuses.includes(value) ||
      expectedStatusPrefixes.some((prefix) => value.startsWith(prefix)),
  );
  if (!matched) {
    throw new PrivateSqlError("worksheet_live_safe_status_missing");
  }
  return matched;
}

function cleanupFixtureSql(teacher: Credentials, student: Credentials) {
  return `
begin;

do $worksheet_live_lock_creation_boundaries$
begin
  perform workspace.id
  from public.workspaces workspace
  where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
  for update nowait;

  perform batch.id
  from public.batches batch
  where batch.id = ${sqlUuid(FIXTURE.batchId)}
    and batch.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  for update nowait;

  perform assignment.id
  from public.student_practice_assignments assignment
  where assignment.id in (
    ${sqlUuid(FIXTURE.providerAssignmentId)},
    ${sqlUuid(FIXTURE.bankAssignmentId)}
  )
  order by assignment.id
  for update nowait;

  perform topic.id
  from public.grammar_topics topic
  where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
  for update nowait;

  perform test.id
  from public.practice_tests test
  where test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  order by test.id
  for update nowait;

  if not pg_try_advisory_xact_lock(
    hashtextextended(concat_ws(
      ':',
      'paid-job-entity',
      'worksheet_generation',
      ${sqlUuid(FIXTURE.providerAssignmentId)}
    ), 0)
  ) then
    raise exception using message = 'worksheet_live_cleanup_job_active';
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended(concat_ws(
      ':',
      'paid-job-entity',
      'worksheet_generation',
      ${sqlUuid(FIXTURE.bankAssignmentId)}
    ), 0)
  ) then
    raise exception using message = 'worksheet_live_cleanup_job_active';
  end if;
exception
  when lock_not_available then
    raise exception using message = 'worksheet_live_cleanup_job_active';
end;
$worksheet_live_lock_creation_boundaries$;

create temp table worksheet_live_fixture_context (
  level text primary key,
  topic_description text not null
) on commit drop;
insert into pg_temp.worksheet_live_fixture_context (level, topic_description)
select
  batch.level,
  'Synthetic staging canary for focused ' || batch.level ||
    ' accusative-case practice.'
from public.batches batch
where batch.id = ${sqlUuid(FIXTURE.batchId)}
  and batch.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

create temp table worksheet_live_assignment_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_assignment_ids (id)
select assignment.id
from public.student_practice_assignments assignment
where assignment.id in (
  ${sqlUuid(FIXTURE.providerAssignmentId)},
  ${sqlUuid(FIXTURE.bankAssignmentId)}
)
  and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

create temp table worksheet_live_test_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_test_ids (id)
select test.id
from public.practice_tests test
where test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

create temp table worksheet_live_attempt_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_attempt_ids (id)
select attempt.id
from public.practice_test_attempts attempt
where attempt.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

do $worksheet_live_lock_attempt_boundaries$
declare
  fixture_attempt_id uuid;
begin
  perform attempt.id
  from public.practice_test_attempts attempt
  where attempt.id in (
    select fixture_attempt.id
    from pg_temp.worksheet_live_attempt_ids fixture_attempt
  )
  order by attempt.id
  for update nowait;

  for fixture_attempt_id in
    select fixture_attempt.id
    from pg_temp.worksheet_live_attempt_ids fixture_attempt
    order by fixture_attempt.id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(concat_ws(
        ':',
        'paid-job-entity',
        'worksheet_answer_evaluation',
        fixture_attempt_id
      ), 0)
    ) then
      raise exception using message = 'worksheet_live_cleanup_job_active';
    end if;
  end loop;
exception
  when lock_not_available then
    raise exception using message = 'worksheet_live_cleanup_job_active';
end;
$worksheet_live_lock_attempt_boundaries$;

create temp table worksheet_live_job_ids (
  id uuid primary key,
  entity_id uuid not null,
  entity_version integer not null,
  job_kind text not null,
  queue_name text not null,
  queue_message_id bigint,
  status text not null
) on commit drop;
insert into pg_temp.worksheet_live_job_ids (
  id, entity_id, entity_version, job_kind, queue_name, queue_message_id, status
)
select
  job.id,
  job.entity_id,
  job.entity_version,
  job.job_kind,
  job.queue_name,
  job.queue_message_id,
  job.status
from app_private.async_jobs job
where (
    job.job_kind = 'worksheet_generation'
    and job.entity_id in (
      select assignment.id from pg_temp.worksheet_live_assignment_ids assignment
    )
  ) or (
    job.job_kind = 'worksheet_answer_evaluation'
    and job.entity_id in (
      select attempt.id from pg_temp.worksheet_live_attempt_ids attempt
    )
  );

create temp table worksheet_live_fallback_event_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_fallback_event_ids (id)
select fallback.id
from app_private.worksheet_bank_fallback_events fallback
where fallback.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);

-- A generated worksheet becomes globally reusable after five minutes. Capture
-- only a revision whose immutable source test + completion job are both part
-- of this exact fixture. A source link to a pre-existing/shared revision fails
-- closed below; cleanup never alters shared cache content.
create temp table worksheet_live_model_cache_revision_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_model_cache_revision_ids (id)
select revision.id
from app_private.practice_worksheet_model_cache_revisions revision
join app_private.practice_worksheet_model_cache_sources source_link
  on source_link.revision_id = revision.id
 and source_link.source_practice_test_id = revision.source_practice_test_id
 and source_link.source_completion_job_id = revision.source_completion_job_id
 and source_link.source_content_sha256 = revision.content_sha256
join public.practice_tests test
  on test.id = source_link.source_practice_test_id
join app_private.worksheet_generation_completions_v2 completion
  on completion.job_id = source_link.source_completion_job_id
 and completion.practice_test_id = test.id
join app_private.async_jobs job
  on job.id = completion.job_id
join public.student_practice_assignments assignment
  on assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
 and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
 and assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}
 and assignment.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
 and assignment.practice_test_id = test.id
 and assignment.worksheet_level = test.level
where test.id in (
    select fixture_test.id from pg_temp.worksheet_live_test_ids fixture_test
  )
  and completion.job_id in (
    select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
  )
  and test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  and test.generated_from_assignment_id =
    ${sqlUuid(FIXTURE.providerAssignmentId)}
  and test.generation_job_id = job.id
  and test.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
  and test.level = (
    select fixture.level from pg_temp.worksheet_live_fixture_context fixture
  )
  and job.entity_id = assignment.id
  and job.entity_version = assignment.generation_version
  and job.job_kind = 'worksheet_generation'
  and job.queue_name = 'worksheet_generation'
  and job.status = 'succeeded'
  and job.completed_at is not null
  and job.dead_at is null
  and job.worker_id is null
  and job.lease_expires_at is null
  and job.requested_by = assignment.student_id
  and completion.completion_mode = 'generated'
  and completion.evidence_version = 2
  and test.quality_status = 'approved'
  and test.approval_source = 'independent_model_validation'
  and test.created_by_ai
  and not test.teacher_reviewed
  and test.visibility = 'workspace'
  and test.worksheet_model_cache_revision_id is null
  and revision.grammar_topic_id = test.grammar_topic_id
  and revision.level = test.level
  and revision.generator_provider = completion.provider_source
  and revision.generator_model = completion.generator_model
  and revision.candidate_sha256 = completion.candidate_sha256
  and revision.primary_critic_provider =
    completion.primary_critic_provider
  and revision.primary_critic_model = completion.primary_critic_model
  and revision.primary_verdict_sha256 =
    completion.primary_verdict_sha256
  and revision.secondary_critic_provider =
    completion.secondary_critic_provider
  and revision.secondary_critic_model = completion.secondary_critic_model
  and revision.secondary_verdict_sha256 =
    completion.secondary_verdict_sha256
  and revision.content_sha256 = completion.content_sha256
  and (
    select count(*)
    from app_private.practice_worksheet_model_cache_questions question
    where question.revision_id = revision.id
  ) = case when test.level = 'A2' then 9 else 8 end
  and app_private.practice_worksheet_model_cache_revision_is_current(
    revision.id
  )
  and not exists (
    select 1
    from app_private.practice_worksheet_model_cache_sources other_source
    where other_source.revision_id = revision.id
      and (
        other_source.source_practice_test_id <>
          source_link.source_practice_test_id
        or other_source.source_completion_job_id <>
          source_link.source_completion_job_id
      )
  )
  and not exists (
    select 1
    from app_private.practice_worksheet_model_cache_withdrawals withdrawal
    where withdrawal.revision_id = revision.id
  )
  and not exists (
    select 1
    from public.practice_tests clone
    where clone.worksheet_model_cache_revision_id = revision.id
  )
  and not exists (
    select 1
    from app_private.practice_worksheet_model_cache_attachment_events event
    where event.cache_revision_id = revision.id
  )
  and not exists (
    select 1
    from app_private.practice_worksheet_model_cache_recovery_failures failure
    where failure.cache_revision_id = revision.id
  );

do $worksheet_live_lock_model_cache_scope$
begin
  perform completion.job_id
  from app_private.worksheet_generation_completions_v2 completion
  where completion.job_id in (
      select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
    )
    and completion.practice_test_id in (
      select fixture_test.id
      from pg_temp.worksheet_live_test_ids fixture_test
    )
  order by completion.job_id
  for update nowait;

  perform revision.id
  from app_private.practice_worksheet_model_cache_revisions revision
  where revision.id in (
      select fixture_revision.id
      from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
    )
    or exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.revision_id = revision.id
        and source_link.source_practice_test_id in (
          select fixture_test.id
          from pg_temp.worksheet_live_test_ids fixture_test
        )
        and source_link.source_completion_job_id in (
          select fixture_job.id
          from pg_temp.worksheet_live_job_ids fixture_job
        )
    )
  order by revision.id
  for update nowait;

  perform question.id
  from app_private.practice_worksheet_model_cache_questions question
  where question.revision_id in (
    select fixture_revision.id
    from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
  )
  order by question.id
  for update nowait;

  perform source_link.source_practice_test_id
  from app_private.practice_worksheet_model_cache_sources source_link
  where source_link.source_practice_test_id in (
      select fixture_test.id
      from pg_temp.worksheet_live_test_ids fixture_test
    )
    or source_link.source_completion_job_id in (
      select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
    )
  order by source_link.source_practice_test_id
  for update nowait;

  perform failure.source_practice_test_id
  from app_private.practice_worksheet_model_cache_promotion_failures failure
  where failure.source_practice_test_id in (
      select fixture_test.id
      from pg_temp.worksheet_live_test_ids fixture_test
    )
    or failure.source_completion_job_id in (
      select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
    )
  order by failure.source_practice_test_id
  for update nowait;
exception
  when lock_not_available then
    raise exception using
      message = 'worksheet_live_cleanup_model_cache_active';
end;
$worksheet_live_lock_model_cache_scope$;

do $worksheet_live_model_cache_scope_guard$
begin
  if (
      select count(*)
      from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
    ) > 1 or exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where (
          source_link.source_practice_test_id in (
            select fixture_test.id
            from pg_temp.worksheet_live_test_ids fixture_test
          )
          or source_link.source_completion_job_id in (
            select fixture_job.id
            from pg_temp.worksheet_live_job_ids fixture_job
          )
        )
        and not exists (
          select 1
          from public.practice_tests test
          join app_private.worksheet_generation_completions_v2 completion
            on completion.practice_test_id = test.id
          join app_private.async_jobs job
            on job.id = completion.job_id
          join public.student_practice_assignments assignment
            on assignment.id =
              ${sqlUuid(FIXTURE.providerAssignmentId)}
           and assignment.workspace_id =
              ${sqlUuid(FIXTURE.workspaceId)}
           and assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}
           and assignment.grammar_topic_id =
              ${sqlUuid(FIXTURE.providerTopicId)}
           and assignment.practice_test_id = test.id
           and assignment.worksheet_level = test.level
          join app_private.practice_worksheet_model_cache_revisions revision
            on revision.id = source_link.revision_id
          where test.id = source_link.source_practice_test_id
            and completion.job_id = source_link.source_completion_job_id
            and test.id in (
              select fixture_test.id
              from pg_temp.worksheet_live_test_ids fixture_test
            )
            and completion.job_id in (
              select fixture_job.id
              from pg_temp.worksheet_live_job_ids fixture_job
            )
            and test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
            and test.generated_from_assignment_id =
              ${sqlUuid(FIXTURE.providerAssignmentId)}
            and test.generation_job_id = job.id
            and test.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
            and test.level = (
              select fixture.level
              from pg_temp.worksheet_live_fixture_context fixture
            )
            and job.entity_id = assignment.id
            and job.entity_version = assignment.generation_version
            and job.job_kind = 'worksheet_generation'
            and job.queue_name = 'worksheet_generation'
            and job.status = 'succeeded'
            and completion.completion_mode = 'generated'
            and completion.evidence_version = 2
            and revision.grammar_topic_id = test.grammar_topic_id
            and revision.level = test.level
            and revision.id in (
              select fixture_revision.id
              from pg_temp.worksheet_live_model_cache_revision_ids
                fixture_revision
            )
            and revision.generator_provider = completion.provider_source
            and revision.generator_model = completion.generator_model
            and revision.candidate_sha256 = completion.candidate_sha256
            and revision.primary_critic_provider =
              completion.primary_critic_provider
            and revision.primary_critic_model =
              completion.primary_critic_model
            and revision.primary_verdict_sha256 =
              completion.primary_verdict_sha256
            and revision.secondary_critic_provider =
              completion.secondary_critic_provider
            and revision.secondary_critic_model =
              completion.secondary_critic_model
            and revision.secondary_verdict_sha256 =
              completion.secondary_verdict_sha256
            and revision.content_sha256 =
              source_link.source_content_sha256
            and revision.content_sha256 = completion.content_sha256
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_revisions revision
      where revision.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
        and revision.id not in (
          select fixture_revision.id
          from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_revisions revision
      where (
          revision.source_practice_test_id in (
            select fixture_test.id
            from pg_temp.worksheet_live_test_ids fixture_test
          )
          or revision.source_completion_job_id in (
            select fixture_job.id
            from pg_temp.worksheet_live_job_ids fixture_job
          )
        )
        and revision.id not in (
          select fixture_revision.id
          from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
        )
    ) or exists (
      select 1
      from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
      where exists (
          select 1
          from app_private.practice_worksheet_model_cache_sources other_source
          where other_source.revision_id = fixture_revision.id
            and not (
              other_source.source_practice_test_id in (
                select fixture_test.id
                from pg_temp.worksheet_live_test_ids fixture_test
              )
              and other_source.source_completion_job_id in (
                select fixture_job.id
                from pg_temp.worksheet_live_job_ids fixture_job
              )
            )
        )
        or exists (
          select 1
          from app_private.practice_worksheet_model_cache_withdrawals withdrawal
          where withdrawal.revision_id = fixture_revision.id
        )
        or exists (
          select 1
          from public.practice_tests clone
          where clone.worksheet_model_cache_revision_id = fixture_revision.id
        )
        or exists (
          select 1
          from app_private.practice_worksheet_model_cache_attachment_events event
          where event.cache_revision_id = fixture_revision.id
        )
        or exists (
          select 1
          from app_private.practice_worksheet_model_cache_recovery_failures failure
          where failure.cache_revision_id = fixture_revision.id
        )
        or (
          select count(*)
          from app_private.practice_worksheet_model_cache_questions question
          where question.revision_id = fixture_revision.id
        ) <> case
          when (
            select fixture.level
            from pg_temp.worksheet_live_fixture_context fixture
          ) = 'A2' then 9
          else 8
        end
        or not app_private.practice_worksheet_model_cache_revision_is_current(
          fixture_revision.id
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where (
          failure.source_practice_test_id in (
            select fixture_test.id
            from pg_temp.worksheet_live_test_ids fixture_test
          )
          or failure.source_completion_job_id in (
            select fixture_job.id
            from pg_temp.worksheet_live_job_ids fixture_job
          )
        )
        and not exists (
          select 1
          from public.practice_tests test
          join app_private.worksheet_generation_completions_v2 completion
            on completion.practice_test_id = test.id
          join app_private.async_jobs job
            on job.id = completion.job_id
          join public.student_practice_assignments assignment
            on assignment.id =
              ${sqlUuid(FIXTURE.providerAssignmentId)}
           and assignment.workspace_id =
              ${sqlUuid(FIXTURE.workspaceId)}
           and assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}
           and assignment.grammar_topic_id =
              ${sqlUuid(FIXTURE.providerTopicId)}
           and assignment.practice_test_id = test.id
           and assignment.worksheet_level = test.level
          where test.id = failure.source_practice_test_id
            and completion.job_id = failure.source_completion_job_id
            and test.id in (
              select fixture_test.id
              from pg_temp.worksheet_live_test_ids fixture_test
            )
            and completion.job_id in (
              select fixture_job.id
              from pg_temp.worksheet_live_job_ids fixture_job
            )
            and test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
            and test.generated_from_assignment_id =
              ${sqlUuid(FIXTURE.providerAssignmentId)}
            and test.generation_job_id = job.id
            and job.entity_id = assignment.id
            and job.entity_version = assignment.generation_version
            and job.job_kind = 'worksheet_generation'
            and job.queue_name = 'worksheet_generation'
            and job.status = 'succeeded'
            and completion.completion_mode = 'generated'
            and completion.evidence_version = 2
        )
    )
  then
    raise exception using
      message = 'worksheet_live_cleanup_model_cache_scope_invalid';
  end if;
end;
$worksheet_live_model_cache_scope_guard$;

do $worksheet_live_identity_guard$
declare
  teacher_profile_id uuid;
  student_profile_id uuid;
  fixture_level text;
  fixture_topic_description text;
  workspace_exists boolean := exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
  );
begin
  if (
    select count(*)
    from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(teacher.email)})
  ) <> 1 or (
    select count(*)
    from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(student.email)})
  ) <> 1 then
    raise exception using message = 'worksheet_live_cleanup_accounts_invalid';
  end if;

  select profile.id
  into teacher_profile_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(teacher.email)});

  select profile.id
  into student_profile_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(student.email)});

  select fixture.level, fixture.topic_description
  into fixture_level, fixture_topic_description
  from pg_temp.worksheet_live_fixture_context fixture;

  if not workspace_exists then
    if exists (
      select 1 from public.batches batch
      where batch.id = ${sqlUuid(FIXTURE.batchId)}
    ) or exists (
      select 1 from public.batch_students enrollment
      where enrollment.id = ${sqlUuid(FIXTURE.batchStudentId)}
    ) or exists (
      select 1 from public.workspace_members membership
      where membership.id in (
        ${sqlUuid(FIXTURE.teacherMembershipId)},
        ${sqlUuid(FIXTURE.studentMembershipId)}
      )
    ) or exists (
      select 1 from public.student_practice_assignments assignment
      where assignment.id in (
        ${sqlUuid(FIXTURE.providerAssignmentId)},
        ${sqlUuid(FIXTURE.bankAssignmentId)}
      )
    ) or exists (
      select 1 from public.grammar_topics topic
      where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
         or topic.slug = ${sqlLiteral(FIXTURE.providerTopicSlug)}
    ) or exists (
      select 1 from public.practice_tests test
      where test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    ) or exists (
      select 1 from public.practice_test_attempts attempt
      where attempt.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    ) or exists (
      select 1 from app_private.ai_spend_reservations reservation
      where reservation.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    ) or exists (
      select 1 from app_private.async_jobs job
      where job.entity_id in (
        ${sqlUuid(FIXTURE.providerAssignmentId)},
        ${sqlUuid(FIXTURE.bankAssignmentId)}
      )
    ) or exists (
      select 1
      from (
        select message from pgmq.q_worksheet_generation
        union all
        select message from pgmq.a_worksheet_generation
        union all
        select message from pgmq.q_worksheet_answer_evaluation
        union all
        select message from pgmq.a_worksheet_answer_evaluation
      ) queued
      where queued.message ->> 'entity_id' in (
        ${sqlLiteral(FIXTURE.providerAssignmentId)},
        ${sqlLiteral(FIXTURE.bankAssignmentId)}
      )
    ) then
      raise exception using message = 'worksheet_live_cleanup_identity_mismatch';
    end if;
    return;
  end if;

  if fixture_level not in ('A1', 'A2', 'B1', 'B2')
    or fixture_topic_description is distinct from
      'Synthetic staging canary for focused ' || fixture_level ||
        ' accusative-case practice.'
    or not exists (
    select 1
    from public.workspaces workspace
    join public.batches batch on batch.workspace_id = workspace.id
    join public.batch_students enrollment
      on enrollment.batch_id = batch.id
     and enrollment.workspace_id = workspace.id
    where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
      and workspace.name = ${sqlLiteral(FIXTURE.workspaceName)}
      and workspace.slug = ${sqlLiteral(FIXTURE.workspaceSlug)}
      and workspace.owner_id = teacher_profile_id
      and batch.id = ${sqlUuid(FIXTURE.batchId)}
      and batch.name = ${sqlLiteral(FIXTURE.batchName)}
      and batch.level = fixture_level
      and batch.created_by = teacher_profile_id
      and batch.is_active
      and batch.join_requires_approval
      and enrollment.id = ${sqlUuid(FIXTURE.batchStudentId)}
      and enrollment.student_id = student_profile_id
  ) or (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) <> 2 or (
    select count(*)
    from public.batches batch
    where batch.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) <> 1 or (
    select count(*)
    from public.batch_students enrollment
    where enrollment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) <> 1 or exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and assignment.id not in (
        ${sqlUuid(FIXTURE.providerAssignmentId)},
        ${sqlUuid(FIXTURE.bankAssignmentId)}
      )
  ) or not exists (
    select 1
    from public.workspace_members membership
    where membership.id = ${sqlUuid(FIXTURE.teacherMembershipId)}
      and membership.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and membership.user_id = teacher_profile_id
      and membership.role = 'teacher'
  ) or not exists (
    select 1
    from public.workspace_members membership
    where membership.id = ${sqlUuid(FIXTURE.studentMembershipId)}
      and membership.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and membership.user_id = student_profile_id
      and membership.role = 'student'
  ) or not exists (
    select 1
    from public.grammar_topics topic
    where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
      and topic.slug = ${sqlLiteral(FIXTURE.providerTopicSlug)}
      and topic.name = 'Akkusativ'
      and topic.level = fixture_level
      and topic.description = fixture_topic_description
  ) or not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}
      and assignment.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
      and assignment.source = 'manual'
      and assignment.worksheet_level = fixture_level
      and assignment.class_context_version = 1
      and assignment.class_context_integrity = 'teacher_verified'
  ) or exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = ${sqlUuid(FIXTURE.bankAssignmentId)}
      and (
        assignment.workspace_id <> ${sqlUuid(FIXTURE.workspaceId)}
        or assignment.batch_id <> ${sqlUuid(FIXTURE.batchId)}
        or assignment.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
        or assignment.source <> 'manual'
        or assignment.worksheet_level <> fixture_level
        or assignment.class_context_version <> 1
        or assignment.class_context_integrity <> 'teacher_verified'
        or not exists (
          select 1
          from public.grammar_topics bank_topic
          where bank_topic.id = assignment.grammar_topic_id
            and (
              bank_topic.level = fixture_level
              or (
                fixture_level in ('A1', 'A2')
                and bank_topic.level = 'A1_A2'
              )
            )
            and bank_topic.slug <> ${sqlLiteral(FIXTURE.providerTopicSlug)}
        )
      )
  ) or exists (
    select 1
    from pg_temp.worksheet_live_job_ids job
    where (job.job_kind = 'worksheet_generation'
        and job.queue_name <> 'worksheet_generation')
       or (job.job_kind = 'worksheet_answer_evaluation'
        and job.queue_name <> 'worksheet_answer_evaluation')
  ) then
    raise exception using message = 'worksheet_live_cleanup_identity_mismatch';
  end if;

  if exists (
    select 1
    from pg_temp.worksheet_live_job_ids job
    where job.status in ('queued', 'processing', 'retry')
  ) then
    raise exception using message = 'worksheet_live_cleanup_job_active';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and (
        reservation.state = 'reserved'
        or reservation.job_id not in (
          select job.id from pg_temp.worksheet_live_job_ids job
        )
      )
  ) then
    raise exception using message = 'worksheet_live_cleanup_spend_not_terminal';
  end if;
end;
$worksheet_live_identity_guard$;

do $worksheet_live_lock_scope$
begin
  perform job.id
  from app_private.async_jobs job
  where job.id in (
    select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
  )
  order by job.id
  for update nowait;

  perform reservation.id
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  order by reservation.id
  for update nowait;

  if exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and attempt.id not in (
        select fixture_attempt.id
        from pg_temp.worksheet_live_attempt_ids fixture_attempt
      )
  ) or exists (
    select 1
    from app_private.async_jobs job
    where (
        (
          job.job_kind = 'worksheet_generation'
          and job.entity_id in (
            select assignment.id
            from pg_temp.worksheet_live_assignment_ids assignment
          )
        ) or (
          job.job_kind = 'worksheet_answer_evaluation'
          and job.entity_id in (
            select attempt.id
            from pg_temp.worksheet_live_attempt_ids attempt
          )
        )
      )
      and job.id not in (
        select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
      )
  ) then
    raise exception using message = 'worksheet_live_cleanup_snapshot_changed';
  end if;
exception
  when lock_not_available then
    raise exception using message = 'worksheet_live_cleanup_job_active';
end;
$worksheet_live_lock_scope$;

create temp table worksheet_live_reservation_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.worksheet_live_reservation_ids (id)
select reservation.id
from app_private.ai_spend_reservations reservation
where reservation.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

do $worksheet_live_queue_scope_guard$
begin
  if exists (
    select 1
    from (
      select 'worksheet_generation'::text as queue_name, msg_id, message
      from pgmq.q_worksheet_generation
      union all
      select 'worksheet_generation'::text, msg_id, message
      from pgmq.a_worksheet_generation
      union all
      select 'worksheet_answer_evaluation'::text, msg_id, message
      from pgmq.q_worksheet_answer_evaluation
      union all
      select 'worksheet_answer_evaluation'::text, msg_id, message
      from pgmq.a_worksheet_answer_evaluation
    ) queued
    where (
        queued.message ->> 'job_id' in (
          select job.id::text from pg_temp.worksheet_live_job_ids job
        )
        or queued.message ->> 'entity_id' in (
          select assignment.id::text
          from pg_temp.worksheet_live_assignment_ids assignment
          union all
          select attempt.id::text
          from pg_temp.worksheet_live_attempt_ids attempt
        )
      )
      and not exists (
        select 1
        from pg_temp.worksheet_live_job_ids job
        where queued.message ->> 'job_id' = job.id::text
          and queued.message ->> 'entity_id' = job.entity_id::text
          and queued.message ->> 'job_kind' = job.job_kind
          and queued.message ->> 'entity_version' = job.entity_version::text
          and queued.queue_name = job.queue_name
      )
  ) or exists (
    select 1
    from pg_temp.worksheet_live_job_ids job
    where job.queue_message_id is null
       or not exists (
         select 1
         from (
           select 'worksheet_generation'::text as queue_name, msg_id
           from pgmq.q_worksheet_generation
           union all
           select 'worksheet_generation'::text, msg_id
           from pgmq.a_worksheet_generation
           union all
           select 'worksheet_answer_evaluation'::text, msg_id
           from pgmq.q_worksheet_answer_evaluation
           union all
           select 'worksheet_answer_evaluation'::text, msg_id
           from pgmq.a_worksheet_answer_evaluation
         ) queued
         where queued.queue_name = job.queue_name
           and queued.msg_id = job.queue_message_id
       )
  ) then
    raise exception using message = 'worksheet_live_cleanup_queue_scope_mismatch';
  end if;
end;
$worksheet_live_queue_scope_guard$;

-- A rejected generated worksheet is deliberately quarantined: it remains
-- private and is not attached to the learner assignment. The spend archive
-- facade predates that valid terminal shape and accepts only attached fixture
-- tests. Prove the immutable completion -> job -> exact fixture assignment
-- chain before creating a transaction-local attachment. PostgreSQL does not
-- expose the uncommitted bridge, and it is removed immediately after the
-- archive call (or rolled back together with the transaction on any error).
create temp table worksheet_live_quarantined_test_bindings (
  assignment_id uuid primary key,
  practice_test_id uuid not null unique,
  job_id uuid not null unique
) on commit drop;

insert into pg_temp.worksheet_live_quarantined_test_bindings (
  assignment_id,
  practice_test_id,
  job_id
)
select
  assignment.id,
  test.id,
  job.id
from public.student_practice_assignments assignment
join app_private.async_jobs job
  on job.entity_id = assignment.id
 and job.entity_version = assignment.generation_version
 and job.job_kind = 'worksheet_generation'
 and job.queue_name = 'worksheet_generation'
 and job.status = 'succeeded'
 and job.completed_at is not null
 and job.dead_at is null
 and job.worker_id is null
 and job.lease_expires_at is null
 and job.requested_by = assignment.student_id
join app_private.worksheet_generation_completions_v2 completion
  on completion.job_id = job.id
 and completion.completion_mode = 'generated'
 and completion.evidence_version = 2
join public.practice_tests test
  on test.id = completion.practice_test_id
 and test.generation_job_id = job.id
 and test.generated_from_assignment_id = assignment.id
where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  and assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}
  and assignment.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
  and assignment.practice_test_id is null
  and assignment.status in ('unlocked', 'in_progress')
  and assignment.generation_status = 'needs_review'
  and assignment.generation_error = 'independent_validation_rejected'
  and assignment.worksheet_level = (
    select fixture.level from pg_temp.worksheet_live_fixture_context fixture
  )
  and assignment.class_context_version = 1
  and assignment.class_context_integrity = 'teacher_verified'
  and job.id in (
    select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
  )
  and test.id in (
    select fixture_test.id from pg_temp.worksheet_live_test_ids fixture_test
  )
  and test.workspace_id = assignment.workspace_id
  and test.grammar_topic_id = assignment.grammar_topic_id
  and test.level = assignment.worksheet_level
  and test.visibility = 'private'
  and test.quality_status = 'needs_review'
  and test.created_by_ai
  and not test.teacher_reviewed
  and test.approval_source is null
  and test.worksheet_template_revision_id is null
  and test.worksheet_template_release_id is null
  and test.generation_source = completion.provider_source
  and test.generator_model = completion.generator_model
  and test.generation_metadata is not distinct from completion.provider_metadata;

do $worksheet_live_quarantined_test_scope_guard$
begin
  if (
      select count(*)
      from pg_temp.worksheet_live_quarantined_test_bindings binding
    ) > 1 or exists (
      select 1
      from public.practice_tests test
      where test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
        and not exists (
          select 1
          from public.student_practice_assignments assignment
          where assignment.id in (
              ${sqlUuid(FIXTURE.providerAssignmentId)},
              ${sqlUuid(FIXTURE.bankAssignmentId)}
            )
            and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
            and assignment.practice_test_id = test.id
        )
        and not exists (
          select 1
          from pg_temp.worksheet_live_quarantined_test_bindings binding
          where binding.practice_test_id = test.id
        )
    ) then
    raise exception using
      message = 'worksheet_live_cleanup_test_scope_invalid';
  end if;
end;
$worksheet_live_quarantined_test_scope_guard$;

set local session_replication_role = replica;
update public.student_practice_assignments assignment
set practice_test_id = binding.practice_test_id
from pg_temp.worksheet_live_quarantined_test_bindings binding
where assignment.id = binding.assignment_id
  and assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  and assignment.practice_test_id is null
  and assignment.generation_status = 'needs_review';
set local session_replication_role = origin;

do $worksheet_live_quarantined_test_binding_guard$
begin
  if exists (
    select 1
    from pg_temp.worksheet_live_quarantined_test_bindings binding
    left join public.student_practice_assignments assignment
      on assignment.id = binding.assignment_id
     and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
     and assignment.practice_test_id = binding.practice_test_id
    where assignment.id is null
  ) then
    raise exception using
      message = 'worksheet_live_cleanup_test_binding_invalid';
  end if;
end;
$worksheet_live_quarantined_test_binding_guard$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $worksheet_live_archive_spend$
begin
  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
  ) then
    perform *
    from api.archive_worksheet_live_canary_spend(
      ${sqlUuid(FIXTURE.workspaceId)},
      ${sqlLiteral(FIXTURE.workspaceSlug)},
      ${sqlUuid(FIXTURE.batchId)},
      ${sqlUuid(FIXTURE.providerAssignmentId)},
      ${sqlUuid(FIXTURE.bankAssignmentId)}
    );
  end if;
end;
$worksheet_live_archive_spend$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

set local session_replication_role = replica;
update public.student_practice_assignments assignment
set practice_test_id = null
from pg_temp.worksheet_live_quarantined_test_bindings binding
where assignment.id = binding.assignment_id
  and assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  and assignment.practice_test_id = binding.practice_test_id;
set local session_replication_role = origin;

do $worksheet_live_quarantined_test_unbinding_guard$
begin
  if exists (
    select 1
    from pg_temp.worksheet_live_quarantined_test_bindings binding
    join public.student_practice_assignments assignment
      on assignment.id = binding.assignment_id
    where assignment.practice_test_id is not null
  ) then
    raise exception using
      message = 'worksheet_live_cleanup_test_unbinding_invalid';
  end if;
end;
$worksheet_live_quarantined_test_unbinding_guard$;

do $worksheet_live_archive_guard$
begin
  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id in (
      select fixture_reservation.id
      from pg_temp.worksheet_live_reservation_ids fixture_reservation
    )
  ) or exists (
    select 1
    from pg_temp.worksheet_live_reservation_ids fixture_reservation
    where not exists (
      select 1
      from app_private.ai_canary_spend_archive archived
      where archived.original_reservation_id = fixture_reservation.id
        and archived.original_workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
        and archived.archive_source = 'worksheet_live_canary_cleanup'
    )
  ) then
    raise exception using message = 'worksheet_live_cleanup_spend_archive_invalid';
  end if;
end;
$worksheet_live_archive_guard$;

set local session_replication_role = replica;

delete from app_private.practice_worksheet_model_cache_promotion_failures failure
where failure.source_practice_test_id in (
    select fixture_test.id from pg_temp.worksheet_live_test_ids fixture_test
  )
  and failure.source_completion_job_id in (
    select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
  );
delete from app_private.practice_worksheet_model_cache_questions question
where question.revision_id in (
  select fixture_revision.id
  from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
);
delete from app_private.practice_worksheet_model_cache_sources source_link
where source_link.source_practice_test_id in (
    select fixture_test.id from pg_temp.worksheet_live_test_ids fixture_test
  )
  and source_link.source_completion_job_id in (
    select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
  );
delete from app_private.practice_worksheet_model_cache_revisions revision
where revision.id in (
  select fixture_revision.id
  from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
);

do $worksheet_live_model_cache_delete_guard$
begin
  if exists (
      select 1
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where failure.source_practice_test_id in (
          select fixture_test.id
          from pg_temp.worksheet_live_test_ids fixture_test
        )
         or failure.source_completion_job_id in (
          select fixture_job.id
          from pg_temp.worksheet_live_job_ids fixture_job
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id in (
          select fixture_test.id
          from pg_temp.worksheet_live_test_ids fixture_test
        )
         or source_link.source_completion_job_id in (
          select fixture_job.id
          from pg_temp.worksheet_live_job_ids fixture_job
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_revisions revision
      where revision.id in (
          select fixture_revision.id
          from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
        )
         or revision.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
         or revision.source_practice_test_id in (
          select fixture_test.id
          from pg_temp.worksheet_live_test_ids fixture_test
        )
         or revision.source_completion_job_id in (
          select fixture_job.id
          from pg_temp.worksheet_live_job_ids fixture_job
        )
    ) or exists (
      select 1
      from app_private.practice_worksheet_model_cache_questions question
      where question.revision_id in (
        select fixture_revision.id
        from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
      )
    )
  then
    raise exception using
      message = 'worksheet_live_cleanup_model_cache_residue';
  end if;
end;
$worksheet_live_model_cache_delete_guard$;

delete from pgmq.q_worksheet_generation queue
where queue.message ->> 'job_id' in (
    select job.id::text from pg_temp.worksheet_live_job_ids job
  ) or queue.message ->> 'entity_id' in (
    select assignment.id::text
    from pg_temp.worksheet_live_assignment_ids assignment
  );
delete from pgmq.a_worksheet_generation archive
where archive.message ->> 'job_id' in (
  select job.id::text from pg_temp.worksheet_live_job_ids job
  ) or archive.message ->> 'entity_id' in (
    select assignment.id::text
    from pg_temp.worksheet_live_assignment_ids assignment
  );
delete from pgmq.q_worksheet_answer_evaluation queue
where queue.message ->> 'job_id' in (
  select job.id::text from pg_temp.worksheet_live_job_ids job
  ) or queue.message ->> 'entity_id' in (
    select attempt.id::text from pg_temp.worksheet_live_attempt_ids attempt
  );
delete from pgmq.a_worksheet_answer_evaluation archive
where archive.message ->> 'job_id' in (
  select job.id::text from pg_temp.worksheet_live_job_ids job
  ) or archive.message ->> 'entity_id' in (
    select attempt.id::text from pg_temp.worksheet_live_attempt_ids attempt
  );

delete from app_private.worksheet_generation_rejections rejection
where rejection.fallback_event_id in (
    select fallback.id
    from pg_temp.worksheet_live_fallback_event_ids fallback
  );
delete from app_private.provider_outage_recovery_events event
where event.job_id in (
    select job.id from pg_temp.worksheet_live_job_ids job
  ) or event.predecessor_job_id in (
    select job.id from pg_temp.worksheet_live_job_ids job
  );
delete from app_private.practice_semantic_review_holds hold
where hold.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_answer_adjudication_evidence_v2 evidence
where evidence.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_answer_completion_provenance_v2 provenance
where provenance.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_answer_adjudication_evidence evidence
where evidence.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_answer_completion_provenance provenance
where provenance.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_generation_stage_evidence evidence
where evidence.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_generation_checkpoints checkpoint
where checkpoint.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_generation_completions_v2 completion
where completion.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_generation_completions completion
where completion.job_id in (
  select job.id from pg_temp.worksheet_live_job_ids job
);
delete from app_private.worksheet_bank_fallback_events fallback
where fallback.id in (
  select fixture_fallback.id
  from pg_temp.worksheet_live_fallback_event_ids fixture_fallback
);

delete from public.practice_test_questions question
where question.practice_test_id in (
  select test.id from pg_temp.worksheet_live_test_ids test
);

delete from app_private.async_jobs job
where job.id in (
  select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
);

do $worksheet_live_workspace_cleanup$
declare
  relation_name text;
begin
  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
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
    using ${sqlUuid(FIXTURE.workspaceId)};
  end loop;
end;
$worksheet_live_workspace_cleanup$;

delete from public.grammar_topics topic
where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
  and topic.slug = ${sqlLiteral(FIXTURE.providerTopicSlug)}
  and topic.name = 'Akkusativ'
  and topic.level = (
    select fixture.level from pg_temp.worksheet_live_fixture_context fixture
  )
  and topic.description = (
    select fixture.topic_description
    from pg_temp.worksheet_live_fixture_context fixture
  );

delete from public.workspaces workspace
where workspace.id = ${sqlUuid(FIXTURE.workspaceId)};

set local session_replication_role = origin;

do $worksheet_live_residue_guard$
declare
  relation_name text;
  residue_exists boolean;
begin
  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
  ) or exists (
    select 1
    from app_private.worksheet_bank_fallback_events fallback
    where fallback.id in (
      select fixture_fallback.id
      from pg_temp.worksheet_live_fallback_event_ids fixture_fallback
    )
  ) or exists (
    select 1
    from app_private.worksheet_generation_rejections rejection
    where rejection.fallback_event_id in (
      select fixture_fallback.id
      from pg_temp.worksheet_live_fallback_event_ids fixture_fallback
    )
  ) or exists (
    select 1 from public.grammar_topics topic
    where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
       or topic.slug = ${sqlLiteral(FIXTURE.providerTopicSlug)}
  ) or exists (
    select 1 from public.batches batch
    where batch.id = ${sqlUuid(FIXTURE.batchId)}
  ) or exists (
    select 1 from public.student_practice_assignments assignment
    where assignment.id in (
      ${sqlUuid(FIXTURE.providerAssignmentId)},
      ${sqlUuid(FIXTURE.bankAssignmentId)}
    )
  ) or exists (
    select 1 from public.practice_tests test
    where test.id in (select id from pg_temp.worksheet_live_test_ids)
  ) or exists (
    select 1 from public.practice_test_attempts attempt
    where attempt.id in (select id from pg_temp.worksheet_live_attempt_ids)
  ) or exists (
    select 1 from app_private.async_jobs job
    where job.id in (select id from pg_temp.worksheet_live_job_ids)
  ) or exists (
    select 1 from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) or exists (
    select 1
    from app_private.practice_worksheet_model_cache_promotion_failures failure
    where failure.source_practice_test_id in (
        select fixture_test.id
        from pg_temp.worksheet_live_test_ids fixture_test
      )
       or failure.source_completion_job_id in (
        select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
      )
  ) or exists (
    select 1
    from app_private.practice_worksheet_model_cache_sources source_link
    where source_link.source_practice_test_id in (
        select fixture_test.id
        from pg_temp.worksheet_live_test_ids fixture_test
      )
       or source_link.source_completion_job_id in (
        select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
      )
  ) or exists (
    select 1
    from app_private.practice_worksheet_model_cache_revisions revision
    where revision.id in (
        select fixture_revision.id
        from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
      )
       or revision.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}
       or revision.source_practice_test_id in (
        select fixture_test.id
        from pg_temp.worksheet_live_test_ids fixture_test
      )
       or revision.source_completion_job_id in (
        select fixture_job.id from pg_temp.worksheet_live_job_ids fixture_job
      )
  ) or exists (
    select 1
    from app_private.practice_worksheet_model_cache_questions question
    where question.revision_id in (
      select fixture_revision.id
      from pg_temp.worksheet_live_model_cache_revision_ids fixture_revision
    )
  ) or exists (
    select 1
    from (
      select message from pgmq.q_worksheet_generation
      union all
      select message from pgmq.a_worksheet_generation
      union all
      select message from pgmq.q_worksheet_answer_evaluation
      union all
      select message from pgmq.a_worksheet_answer_evaluation
    ) queued
    where queued.message ->> 'job_id' in (
      select job.id::text from pg_temp.worksheet_live_job_ids job
    ) or queued.message ->> 'entity_id' in (
      select assignment.id::text
      from pg_temp.worksheet_live_assignment_ids assignment
      union all
      select attempt.id::text
      from pg_temp.worksheet_live_attempt_ids attempt
    )
  ) then
    raise exception using message = 'worksheet_live_cleanup_residue_detected';
  end if;

  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
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
    ) into residue_exists using ${sqlUuid(FIXTURE.workspaceId)};
    if residue_exists then
      raise exception using message = 'worksheet_live_cleanup_residue_detected';
    end if;
  end loop;
end;
$worksheet_live_residue_guard$;

commit;
select 'worksheet_live_cleanup_ok' as safe_status;
`;
}

function createFixtureSql(teacher: Credentials, student: Credentials) {
  const level = activeWorksheetLevel();
  const topicDescription = providerTopicDescription(level);
  return `
begin;
do $worksheet_live_setup$
declare
  teacher_profile_id uuid;
  student_profile_id uuid;
  teacher_role text;
  student_role text;
  bank_topic_id uuid;
  setup_stage text := 'account_validation';
begin
  if (
    select count(*)
    from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(teacher.email)})
  ) <> 1 or (
    select count(*)
    from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(student.email)})
  ) <> 1 then
    raise exception using message = 'worksheet_live_fixture_accounts_invalid';
  end if;

  select profile.id, profile.global_role
  into teacher_profile_id, teacher_role
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(teacher.email)});

  select profile.id, profile.global_role
  into student_profile_id, student_role
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(student.email)});

  if teacher_profile_id = student_profile_id
    or teacher_role not in ('teacher', 'platform_admin')
    or student_role <> 'student'
  then
    raise exception using message = 'worksheet_live_fixture_roles_invalid';
  end if;

  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(FIXTURE.workspaceId)}
      or workspace.slug = ${sqlLiteral(FIXTURE.workspaceSlug)}
  ) or exists (
    select 1 from public.batches batch
    where batch.id = ${sqlUuid(FIXTURE.batchId)}
  ) or exists (
    select 1 from public.grammar_topics topic
    where topic.id = ${sqlUuid(FIXTURE.providerTopicId)}
       or topic.slug = ${sqlLiteral(FIXTURE.providerTopicSlug)}
  ) or exists (
    select 1 from public.student_practice_assignments assignment
    where assignment.id in (
      ${sqlUuid(FIXTURE.providerAssignmentId)},
      ${sqlUuid(FIXTURE.bankAssignmentId)}
    )
  ) then
    raise exception using message = 'worksheet_live_fixture_scope_not_empty';
  end if;

  setup_stage := 'workspace_insert';
  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(FIXTURE.workspaceId)},
    ${sqlLiteral(FIXTURE.workspaceName)},
    ${sqlLiteral(FIXTURE.workspaceSlug)},
    teacher_profile_id
  );

  setup_stage := 'membership_insert';
  insert into public.workspace_members (id, workspace_id, user_id, role)
  values
    (
      ${sqlUuid(FIXTURE.teacherMembershipId)},
      ${sqlUuid(FIXTURE.workspaceId)},
      teacher_profile_id,
      'teacher'
    ),
    (
      ${sqlUuid(FIXTURE.studentMembershipId)},
      ${sqlUuid(FIXTURE.workspaceId)},
      student_profile_id,
      'student'
    );

  setup_stage := 'batch_insert';
  insert into public.batches (
    id,
    workspace_id,
    name,
    level,
    created_by,
    feedback_mode,
    is_active,
    join_requires_approval
  ) values (
    ${sqlUuid(FIXTURE.batchId)},
    ${sqlUuid(FIXTURE.workspaceId)},
    ${sqlLiteral(FIXTURE.batchName)},
    ${sqlLiteral(level)},
    teacher_profile_id,
    'immediate',
    true,
    true
  );

  setup_stage := 'batch_student_insert';
  insert into public.batch_students (
    id,
    batch_id,
    student_id,
    workspace_id
  ) values (
    ${sqlUuid(FIXTURE.batchStudentId)},
    ${sqlUuid(FIXTURE.batchId)},
    student_profile_id,
    ${sqlUuid(FIXTURE.workspaceId)}
  );

  setup_stage := 'provider_topic_insert';
  insert into public.grammar_topics (
    id, slug, name, level, description
  ) values (
    ${sqlUuid(FIXTURE.providerTopicId)},
    ${sqlLiteral(FIXTURE.providerTopicSlug)},
    'Akkusativ',
    ${sqlLiteral(level)},
    ${sqlLiteral(topicDescription)}
  );

  setup_stage := 'bank_topic_selection';
  select topic.id
  into bank_topic_id
  from public.grammar_topics topic
  where topic.level in (${bankTopicLevelsSql(level)})
    and topic.id <> ${sqlUuid(FIXTURE.providerTopicId)}
    and public.select_released_worksheet_template_internal(
      ${sqlUuid(FIXTURE.workspaceId)},
      student_profile_id,
      topic.id,
      ${sqlLiteral(level)}
    ) is not null
  order by
    case when topic.level = ${sqlLiteral(level)} then 0 else 1 end,
    topic.slug,
    topic.id
  limit 1;

  setup_stage := 'provider_assignment_insert';
  insert into public.student_practice_assignments (
    id,
    workspace_id,
    student_id,
    grammar_topic_id,
    source,
    status,
    assigned_by,
    generation_status,
    batch_id,
    worksheet_level,
    class_context_version,
    class_context_integrity
  ) values (
    ${sqlUuid(FIXTURE.providerAssignmentId)},
    ${sqlUuid(FIXTURE.workspaceId)},
    student_profile_id,
    ${sqlUuid(FIXTURE.providerTopicId)},
    'manual',
    'unlocked',
    teacher_profile_id,
    'idle',
    ${sqlUuid(FIXTURE.batchId)},
    ${sqlLiteral(level)},
    1,
    'teacher_verified'
  );

  if bank_topic_id is not null then
    setup_stage := 'bank_assignment_insert';
    insert into public.student_practice_assignments (
      id,
      workspace_id,
      student_id,
      grammar_topic_id,
      source,
      status,
      assigned_by,
      generation_status,
      batch_id,
      worksheet_level,
      class_context_version,
      class_context_integrity
    ) values (
      ${sqlUuid(FIXTURE.bankAssignmentId)},
      ${sqlUuid(FIXTURE.workspaceId)},
      student_profile_id,
      bank_topic_id,
      'manual',
      'unlocked',
      teacher_profile_id,
      'idle',
      ${sqlUuid(FIXTURE.batchId)},
      ${sqlLiteral(level)},
      1,
      'teacher_verified'
    );
  end if;

  setup_stage := 'contract_validation';
  if (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and membership.id in (
        ${sqlUuid(FIXTURE.teacherMembershipId)},
        ${sqlUuid(FIXTURE.studentMembershipId)}
      )
  ) <> 2 or not exists (
    select 1
    from public.batches batch
    join public.batch_students enrollment
      on enrollment.batch_id = batch.id
     and enrollment.workspace_id = batch.workspace_id
    where batch.id = ${sqlUuid(FIXTURE.batchId)}
      and batch.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and batch.level = ${sqlLiteral(level)}
      and batch.is_active
      and enrollment.id = ${sqlUuid(FIXTURE.batchStudentId)}
      and enrollment.student_id = student_profile_id
  ) or exists (
    select 1
    from public.practice_tests test
    where test.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) or exists (
    select 1
    from app_private.async_jobs job
    where job.entity_id in (
      ${sqlUuid(FIXTURE.providerAssignmentId)},
      ${sqlUuid(FIXTURE.bankAssignmentId)}
    )
  ) or public.select_released_worksheet_template_internal(
    ${sqlUuid(FIXTURE.workspaceId)},
    student_profile_id,
    ${sqlUuid(FIXTURE.providerTopicId)},
    ${sqlLiteral(level)}
  ) is not null
  then
    raise exception using message = 'worksheet_live_fixture_contract_invalid';
  end if;
exception
  when others then
    if sqlerrm ~ '^worksheet_live_[a-z0-9_]+$' then
      raise;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'worksheet_live_fixture_setup_' || setup_stage || '_failed';
end;
$worksheet_live_setup$;
commit;

select case
  when exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = ${sqlUuid(FIXTURE.bankAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
  ) then 'worksheet_live_fixture_setup_bank_present'
  else 'worksheet_live_fixture_setup_bank_absent'
end as safe_status;
`;
}

function providerGenerationDiagnosticSql() {
  return `
with safe_error_codes(code) as (
  select unnest(array[
    'attempts_exhausted',
    'certified_bank_attached',
    'entity_version_superseded',
    'independent_validation_rejected',
    'level_fit_approval_required',
    'provider_outage_recovery_exhausted',
    'queue_message_missing',
    'queue_message_reconciled',
    'student_offboarded',
    'superseded_version',
    'worksheet_ambiguous_answer',
    'worksheet_ambiguous_fill_blank',
    'worksheet_answer_not_in_options',
    'worksheet_assignment_inactive',
    'worksheet_assignment_unavailable',
    'worksheet_checkpoint_candidate_mismatch',
    'worksheet_checkpoint_completion_invalid',
    'worksheet_checkpoint_fallback_reason_invalid',
    'worksheet_checkpoint_rejection_invalid',
    'worksheet_checkpoint_stage_conflict',
    'worksheet_class_context_required',
    'worksheet_completion_failed',
    'worksheet_completion_rejected',
    'worksheet_context_mismatch',
    'worksheet_critic_invalid_json',
    'worksheet_critic_invalid_shape',
    'worksheet_critic_output_truncated',
    'worksheet_critic_response_invalid',
    'worksheet_critic_response_too_large',
    'worksheet_critic_timeout',
    'worksheet_critic_unavailable',
    'worksheet_dual_critics_not_configured',
    'worksheet_dual_critics_timeout',
    'worksheet_dual_critics_unavailable',
    'worksheet_duplicate_options',
    'worksheet_duplicate_questions',
    'worksheet_fallback_ambiguous_answer',
    'worksheet_fallback_ambiguous_fill_blank',
    'worksheet_fallback_answer_not_in_options',
    'worksheet_fallback_authentication_failed',
    'worksheet_fallback_critic_timeout',
    'worksheet_fallback_critic_unavailable',
    'worksheet_fallback_difficulty_mismatch',
    'worksheet_fallback_duplicate_options',
    'worksheet_fallback_duplicate_questions',
    'worksheet_fallback_generic_title',
    'worksheet_fallback_invalid_json',
    'worksheet_fallback_invalid_accepted_answers',
    'worksheet_fallback_invalid_answer',
    'worksheet_fallback_invalid_array',
    'worksheet_fallback_invalid_explanation',
    'worksheet_fallback_invalid_mini_lesson',
    'worksheet_fallback_invalid_options',
    'worksheet_fallback_invalid_prompt',
    'worksheet_fallback_invalid_question_type',
    'worksheet_fallback_invalid_questions',
    'worksheet_fallback_invalid_rubric',
    'worksheet_fallback_invalid_shape',
    'worksheet_fallback_invalid_text',
    'worksheet_fallback_invalid_title',
    'worksheet_fallback_level_mismatch',
    'worksheet_fallback_not_configured',
    'worksheet_fallback_output_truncated',
    'worksheet_fallback_question_count',
    'worksheet_fallback_redirect_rejected',
    'worksheet_fallback_rejected',
    'worksheet_fallback_response_invalid',
    'worksheet_fallback_response_too_large',
    'worksheet_fallback_timeout',
    'worksheet_fallback_unavailable',
    'worksheet_fallback_unexpected_options',
    'worksheet_fallback_unsafe_question_mix',
    'worksheet_fallback_validation_failed',
    'worksheet_generation_failed',
    'worksheet_generic_title',
    'worksheet_invalid_accepted_answers',
    'worksheet_invalid_answer',
    'worksheet_invalid_array',
    'worksheet_invalid_explanation',
    'worksheet_invalid_mini_lesson',
    'worksheet_invalid_options',
    'worksheet_invalid_prompt',
    'worksheet_invalid_question_type',
    'worksheet_invalid_questions',
    'worksheet_invalid_rubric',
    'worksheet_invalid_shape',
    'worksheet_invalid_text',
    'worksheet_invalid_title',
    'worksheet_level_mismatch',
    'worksheet_provider_deadline_exceeded',
    'worksheet_provider_invalid_json',
    'worksheet_provider_output_truncated',
    'worksheet_provider_redirect_rejected',
    'worksheet_provider_rejected',
    'worksheet_provider_response_invalid',
    'worksheet_provider_response_too_large',
    'worksheet_provider_timeout',
    'worksheet_provider_unavailable',
    'worksheet_question_count',
    'worksheet_repair_required',
    'worksheet_spend_accounting_failed',
    'worksheet_unsafe_question_mix',
    'worksheet_unexpected_options'
  ]::text[])
), selected_job as (
  select job.*
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  order by job.entity_version desc, job.created_at desc
  limit 1
), selected_checkpoint as (
  select checkpoint.*
  from app_private.worksheet_generation_checkpoints checkpoint
  where checkpoint.job_id = (select job.id from selected_job job)
  limit 1
), diagnostic as (
  select concat(
    'worksheet_live_diag_gs_',
    coalesce((
      select left(regexp_replace(lower(assignment.generation_status),
        '[^a-z0-9_]+', '_', 'g'), 24)
      from public.student_practice_assignments assignment
      where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
        and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    ), 'missing'),
    '_ge_',
    coalesce((
      select case
        when assignment.generation_error is null then 'none'
        when exists (
          select 1 from safe_error_codes safe
          where safe.code = assignment.generation_error
        ) then assignment.generation_error
        else 'invalid_or_unmapped'
      end
      from public.student_practice_assignments assignment
      where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
        and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    ), 'missing'),
    '_js_', coalesce((select left(regexp_replace(lower(job.status),
      '[^a-z0-9_]+', '_', 'g'), 16) from selected_job job), 'missing'),
    '_ja_', coalesce((select case
      when job.attempt_count between 0 and 5 then job.attempt_count::text
      else 'over_limit'
    end
      from selected_job job), '0'),
    '_je_', coalesce((select case
      when job.last_error_code is null then 'none'
      when exists (
        select 1 from safe_error_codes safe
        where safe.code = job.last_error_code
      ) then job.last_error_code
      else 'invalid_or_unmapped'
    end from selected_job job), 'missing'),
    '_jl_', coalesce((select case
      when job.lease_expires_at is null then 'none'
      when job.lease_expires_at > now() then 'active'
      else 'expired'
    end from selected_job job), 'missing'),
    '_jv_', coalesce((select case
      when job.available_at <= now() then 'ready'
      else 'future'
    end from selected_job job), 'missing'),
    '_cs_', coalesce((select left(regexp_replace(lower(checkpoint.stage),
      '[^a-z0-9_]+', '_', 'g'), 32)
      from selected_checkpoint checkpoint), 'none'),
    '_cf_', coalesce((select left(regexp_replace(lower(coalesce(
      checkpoint.fallback_failure_code, 'none'
    )), '[^a-z0-9_]+', '_', 'g'), 48)
      from selected_checkpoint checkpoint), 'none'),
    '_ca_', coalesce((select checkpoint.candidate_attempt::text
      from selected_checkpoint checkpoint), '0'),
    '_cp_', coalesce((select case
      when checkpoint.candidate_provider is null then 'none'
      when checkpoint.candidate_provider = 'deepseek' then 'deepseek'
      when checkpoint.candidate_provider = 'gemini' then 'gemini'
      else 'invalid'
    end from selected_checkpoint checkpoint), 'none'),
    '_cm_', coalesce((select case
      when checkpoint.candidate_model is null then 'none' else 'present'
    end from selected_checkpoint checkpoint), 'none'),
    '_hc_', coalesce((select case
      when checkpoint.candidate is null then 'no' else 'yes'
    end from selected_checkpoint checkpoint), 'no'),
    '_ql_', least((select count(*) from pgmq.q_worksheet_generation queued
      where queued.message ->> 'job_id' =
        coalesce((select job.id::text from selected_job job), '')
         or queued.message ->> 'entity_id' =
        ${sqlLiteral(FIXTURE.providerAssignmentId)}), 9)::text,
    '_qa_', least((select count(*) from pgmq.a_worksheet_generation archived
      where archived.message ->> 'job_id' =
        coalesce((select job.id::text from selected_job job), '')
         or archived.message ->> 'entity_id' =
        ${sqlLiteral(FIXTURE.providerAssignmentId)}), 9)::text,
    '_sp_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)), 9)::text,
    '_sr_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)
        and reservation.state = 'reserved'), 9)::text,
    '_sf_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)
        and reservation.state = 'finalized'), 9)::text,
    '_sx_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)
        and reservation.state = 'released'), 9)::text,
    '_sg_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)
        and reservation.call_purpose = 'worksheet_generation'), 9)::text,
    '_sc_', least((select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (select job.id from selected_job job)
        and reservation.call_purpose = 'worksheet_critique'), 9)::text,
    '_se_', least((select count(*)
      from app_private.worksheet_generation_stage_evidence evidence
      where evidence.job_id = (select job.id from selected_job job)), 9)::text,
    '_gr_', least((select count(*)
      from app_private.worksheet_generation_rejections rejection
      join app_private.worksheet_bank_fallback_events fallback
        on fallback.id = rejection.fallback_event_id
      where fallback.job_id = (select job.id from selected_job job)), 9)::text,
    '_fb_', least((select count(*)
      from app_private.worksheet_bank_fallback_events fallback
      where fallback.job_id = (select job.id from selected_job job)), 9)::text,
    '_fr_', coalesce((select left(regexp_replace(lower(
      fallback.fallback_reason
    ), '[^a-z0-9_]+', '_', 'g'), 32)
      from app_private.worksheet_bank_fallback_events fallback
      where fallback.job_id = (select job.id from selected_job job)
      limit 1), 'none')
  ) as safe_status
)
select diagnostic.safe_status from diagnostic;
`;
}

function bankReadyAssertionSql() {
  return `
do $worksheet_live_bank_assert$
begin
  if not exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_tests test on test.id = assignment.practice_test_id
    join app_private.worksheet_bank_direct_attachment_events event
      on event.assignment_id = assignment.id
     and event.cloned_practice_test_id = test.id
    where assignment.id = ${sqlUuid(FIXTURE.bankAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and assignment.generation_status = 'ready'
      and test.worksheet_template_revision_id is not null
      and test.approval_source = 'certified_template_bank'
  ) or exists (
    select 1
    from app_private.async_jobs job
    where job.job_kind = 'worksheet_generation'
      and job.entity_id = ${sqlUuid(FIXTURE.bankAssignmentId)}
  ) or exists (
    select 1
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    where job.entity_id = ${sqlUuid(FIXTURE.bankAssignmentId)}
  ) then
    raise exception using message = 'worksheet_live_bank_reuse_invalid';
  end if;
end;
$worksheet_live_bank_assert$;
select 'worksheet_live_bank_reuse_ready' as safe_status;
`;
}

function providerReadyAssertionSql() {
  return `
do $worksheet_live_provider_assert$
declare
  source_name text;
begin
  select completion.provider_source
  into source_name
  from public.student_practice_assignments assignment
  join public.practice_tests test on test.id = assignment.practice_test_id
  join app_private.async_jobs job
    on job.entity_id = assignment.id
   and job.job_kind = 'worksheet_generation'
  join app_private.worksheet_generation_completions_v2 completion
    on completion.job_id = job.id
   and completion.practice_test_id = test.id
  where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
    and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
    and assignment.generation_status = 'ready'
    and job.status = 'succeeded'
    and job.attempt_count between 1 and 5
    and completion.completion_mode = 'generated'
    and completion.provider_source in ('deepseek', 'gemini')
    and completion.generator_model = case completion.provider_source
      when 'deepseek' then 'deepseek-v4-pro'
      when 'gemini' then 'gemini-3.1-flash-lite'
    end
    and completion.primary_critic_provider = 'deepseek'
    and completion.primary_critic_model = 'deepseek-v4-flash'
    and completion.secondary_critic_provider = 'gemini'
    and completion.secondary_critic_model = 'gemini-3.1-flash-lite'
    and completion.provider_metadata #>> '{validation,critics,deepseek,approved}' = 'true'
    and completion.provider_metadata #>> '{validation,critics,gemini,approved}' = 'true'
    and test.worksheet_template_revision_id is null
    and test.generation_source = completion.provider_source
    and test.generator_model = completion.generator_model
    and not exists (
      select 1
      from app_private.worksheet_generation_checkpoints checkpoint
      where checkpoint.job_id = job.id
    )
    and not exists (
      select 1
      from pgmq.q_worksheet_generation queued
      where queued.message ->> 'job_id' = job.id::text
         or queued.message ->> 'entity_id' = assignment.id::text
    )
    and (
      select count(*)
      from pgmq.a_worksheet_generation archived
      where archived.msg_id = job.queue_message_id
        and archived.message ->> 'job_id' = job.id::text
        and archived.message ->> 'entity_id' = assignment.id::text
        and archived.message ->> 'job_kind' = job.job_kind
        and archived.message ->> 'entity_version' = job.entity_version::text
    ) = 1
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
        and reservation.call_purpose = 'worksheet_generation'
        and reservation.provider_name = completion.provider_source
        and reservation.model_name = completion.generator_model
        and reservation.state = 'finalized'
    )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
        and reservation.call_purpose = 'worksheet_critique'
        and reservation.provider_name = 'deepseek'
        and reservation.model_name = 'deepseek-v4-flash'
        and reservation.state = 'finalized'
        and split_part(reservation.call_key, ':', 1) =
          'attempt_' || job.attempt_count::text
    )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
        and reservation.call_purpose = 'worksheet_critique'
        and reservation.provider_name = 'gemini'
        and reservation.model_name = 'gemini-3.1-flash-lite'
        and reservation.state = 'finalized'
        and split_part(reservation.call_key, ':', 1) =
          'attempt_' || job.attempt_count::text
    )
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
        and reservation.state = 'reserved'
        and not (
          split_part(reservation.call_key, ':', 1) ~ '^attempt_[1-5]$'
          and substring(
            split_part(reservation.call_key, ':', 1)
            from 9
          )::integer < job.attempt_count
        )
    )
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
        and (
          reservation.call_purpose not in (
            'worksheet_generation',
            'worksheet_critique'
          )
          or (
            reservation.call_purpose = 'worksheet_generation'
            and (
              (reservation.provider_name = 'deepseek'
                and reservation.model_name <> 'deepseek-v4-pro')
              or (reservation.provider_name = 'gemini'
                and reservation.model_name <> 'gemini-3.1-flash-lite')
              or reservation.provider_name not in ('deepseek', 'gemini')
            )
          )
          or (
            reservation.call_purpose = 'worksheet_critique'
            and (
              (reservation.provider_name = 'deepseek'
                and reservation.model_name <> 'deepseek-v4-flash')
              or (reservation.provider_name = 'gemini'
                and reservation.model_name <> 'gemini-3.1-flash-lite')
              or reservation.provider_name not in ('deepseek', 'gemini')
            )
          )
        )
    )
    and (
      select count(*) = count(distinct reservation.call_key)
        and count(distinct reservation.call_key) between 3 and 13
        and count(*) filter (
          where reservation.call_purpose = 'worksheet_generation'
        ) between 1 and 3
        and count(*) filter (
          where reservation.call_purpose = 'worksheet_critique'
        ) between 2 and 10
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = job.id
    );

  if source_name is null or source_name not in ('deepseek', 'gemini') or exists (
    select 1
    from app_private.worksheet_bank_direct_attachment_events event
    where event.assignment_id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  ) or exists (
    select 1
    from app_private.worksheet_bank_fallback_events event
    where event.assignment_id = ${sqlUuid(FIXTURE.providerAssignmentId)}
  ) then
    raise exception using message = 'worksheet_live_provider_provenance_invalid';
  end if;
end;
$worksheet_live_provider_assert$;

select concat(
  'worksheet_live_generation_',
  test.generation_source,
  '_',
  case
    when count(*) = ${expectedQuestionCount()}
      and count(*) filter (
        where question.question_type = 'multiple_choice'
          and question.evaluation_mode = 'local_exact'
          and jsonb_array_length(question.options) between 3 and 4
          and jsonb_array_length(question.accepted_answers) = 1
          and (question.accepted_answers ->> 0) is not distinct from
            question.correct_answer
          and (
            select count(*)
            from jsonb_array_elements_text(question.options) option(value)
            where option.value = question.correct_answer
          ) = 1
          and question.rubric is null
      ) = ${expectedQuestionCount()}
    then 'mcq_safe'
    else 'rich_mixed'
  end
) as safe_status
from public.student_practice_assignments assignment
join public.practice_tests test on test.id = assignment.practice_test_id
join public.practice_test_questions question
  on question.practice_test_id = test.id
where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
group by test.generation_source;
`;
}

function evaluationTerminalAssertionSql() {
  return `
do $worksheet_live_evaluation_assert$
declare
  selected_attempt_id uuid;
begin
  select assignment.latest_attempt_id
  into selected_attempt_id
  from public.student_practice_assignments assignment
  where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
    and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

  if selected_attempt_id is null or not exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
     and attempt.assignment_id = assignment.id
    join app_private.async_jobs job
      on job.entity_id = attempt.id
     and job.job_kind = 'worksheet_answer_evaluation'
    join app_private.worksheet_answer_completion_provenance_v2 provenance
      on provenance.job_id = job.id
     and provenance.attempt_id = attempt.id
    join app_private.worksheet_answer_adjudication_evidence_v2 evidence
      on evidence.job_id = job.id
     and evidence.attempt_id = attempt.id
    join lateral (
      select
        round(sum(review.points_awarded), 2) as score_points,
        round(sum(review.max_points), 2) as max_score_points
      from public.practice_attempt_question_reviews review
      where review.attempt_id = attempt.id
        and review.assignment_id = assignment.id
        and review.workspace_id = assignment.workspace_id
    ) review_totals on true
    where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and assignment.status in ('passed', 'failed', 'completed')
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'completed'
      and job.status = 'succeeded'
      and provenance.provider_source in ('deepseek', 'gemini', 'mixed')
      and provenance.evaluator_model in (
        'deepseek-v4-flash',
        'gemini-3.1-flash-lite',
        'deepseek-v4-flash+gemini-3.1-flash-lite'
      )
      and evidence.deepseek_model = 'deepseek-v4-flash'
      and evidence.gemini_model = 'gemini-3.1-flash-lite'
      and review_totals.max_score_points > 0
      and attempt.score_points = review_totals.score_points
      and attempt.max_score_points = review_totals.max_score_points
      and attempt.score_percent = round(
        (review_totals.score_points * 100) / review_totals.max_score_points,
        2
      )
      and attempt.passed = (attempt.score_percent >= 70)
      and assignment.status = case
        when attempt.passed then 'passed' else 'failed'
      end
      and exists (
        select 1
        from app_private.ai_spend_reservations reservation
        where reservation.job_id = job.id
          and reservation.call_purpose = 'worksheet_answer_evaluation'
          and reservation.provider_name = 'deepseek'
          and reservation.model_name = 'deepseek-v4-flash'
          and reservation.state = 'finalized'
      )
      and exists (
        select 1
        from app_private.ai_spend_reservations reservation
        where reservation.job_id = job.id
          and reservation.call_purpose = 'worksheet_answer_evaluation'
          and reservation.provider_name = 'gemini'
          and reservation.model_name = 'gemini-3.1-flash-lite'
          and reservation.state = 'finalized'
      )
      and not exists (
        select 1
        from app_private.ai_spend_reservations reservation
        where reservation.job_id = job.id
          and reservation.state = 'reserved'
      )
  ) or (
    select count(*)
    from public.practice_attempt_question_reviews review
    where review.attempt_id = selected_attempt_id
      and review.assignment_id = ${sqlUuid(FIXTURE.providerAssignmentId)}
      and review.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and review.review_status <> 'submitted_for_review'
  ) <> ${expectedQuestionCount()} then
    raise exception using message = 'worksheet_live_evaluation_terminal_invalid';
  end if;
end;
$worksheet_live_evaluation_assert$;
select 'worksheet_live_evaluation_terminal' as safe_status;
`;
}

function objectiveTerminalAssertionSql() {
  return `
do $worksheet_live_objective_assert$
declare
  selected_attempt_id uuid;
begin
  select assignment.latest_attempt_id
  into selected_attempt_id
  from public.student_practice_assignments assignment
  where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
    and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)};

  if selected_attempt_id is null or not exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
     and attempt.assignment_id = assignment.id
    join public.practice_tests test on test.id = attempt.practice_test_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    join lateral (
      select
        count(*) as review_count,
        round(sum(app_private.practice_review_status_points(
          app_private.practice_answer_review_status_any(
            coalesce(submitted.answer, ''),
            question.correct_answer,
            question.accepted_answers,
            coalesce(app_private.is_practice_topic_strict_scoring(
              topic.name,
              topic.slug
            ), false),
            assignment.grammar_topic_id
          )
        )), 2) as score_points,
        count(*)::numeric(6, 2) as max_score_points
      from public.practice_test_questions question
      left join lateral (
        select answer_item ->> 'answer' as answer
        from jsonb_array_elements(attempt.answers) answer_item
        where (answer_item ->> 'question_id')::uuid = question.id
        limit 1
      ) submitted on true
      where question.practice_test_id = test.id
        and app_private.is_practice_question_locally_scorable(
          question.question_type,
          question.correct_answer,
          question.evaluation_mode,
          question.accepted_answers
        )
    ) review_totals on true
    where assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}
      and assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}
      and assignment.status in ('passed', 'failed')
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'not_needed'
      and attempt.evaluation_completed_at is not null
      and review_totals.review_count = ${expectedQuestionCount()}
      and review_totals.max_score_points > 0
      and attempt.score_points = review_totals.score_points
      and attempt.max_score_points = review_totals.max_score_points
      and attempt.score_percent = round(
        (review_totals.score_points * 100) / review_totals.max_score_points,
        2
      )
      and attempt.passed = (attempt.score_percent >= 70)
      and assignment.status = case
        when attempt.passed then 'passed' else 'failed'
      end
      and (
        select count(*)
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and question.question_type = 'multiple_choice'
          and question.evaluation_mode = 'local_exact'
          and jsonb_array_length(question.options) between 3 and 4
          and jsonb_array_length(question.accepted_answers) = 1
          and (question.accepted_answers ->> 0) is not distinct from
            question.correct_answer
          and (
            select count(*)
            from jsonb_array_elements_text(question.options) option(value)
            where option.value = question.correct_answer
          ) = 1
          and question.rubric is null
      ) = ${expectedQuestionCount()}
  ) or exists (
    select 1
    from app_private.async_jobs job
    where job.entity_id = selected_attempt_id
      and job.job_kind = 'worksheet_answer_evaluation'
  ) or exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.call_purpose = 'worksheet_answer_evaluation'
      and reservation.job_id in (
        select job.id
        from app_private.async_jobs job
        where job.entity_id = selected_attempt_id
      )
  ) then
    raise exception using message = 'worksheet_live_objective_terminal_invalid';
  end if;
end;
$worksheet_live_objective_assert$;
select 'worksheet_live_objective_terminal' as safe_status;
`;
}

async function signInStudent(page: Page, account: Credentials) {
  assertPinnedBrowserStaging();
  const assertNoWrongProjectRequest =
    await installPinnedSupabaseRequestGuard(page);
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();

  const loginOutcome = async () => {
    const pathname = new URL(page.url()).pathname;
    if (pathname === "/student/dashboard") return "student";
    if (
      pathname === "/teacher/dashboard" ||
      pathname === "/teacher/onboarding" ||
      pathname === "/admin/teacher-access"
    ) {
      return "teacher";
    }
    const alert = page.getByRole("alert");
    if ((await alert.count()) > 0 && (await alert.nth(0).isVisible())) {
      return "login_error";
    }
    return "pending";
  };

  await expect.poll(loginOutcome, { timeout: 15_000 }).not.toBe("pending");
  const outcome = await loginOutcome();
  if (outcome === "login_error") {
    throw new Error(
      "The configured staging student login was rejected; no worksheet mutation was started.",
    );
  }
  if (outcome !== "student") {
    throw new Error(
      "The configured worksheet student opened a teacher shell; no worksheet mutation was started.",
    );
  }
  assertNoWrongProjectRequest();
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectFixtureWorkspace(page: Page) {
  await page.goto("/student/dashboard");
  const selector = visibleWorkspaceSelector(page);
  await expect(selector).toHaveCount(1, { timeout: 15_000 });
  await selector.click();
  const fixtureMembership = page.getByRole("option", {
    name: `${FIXTURE.workspaceName} · student`,
    exact: true,
  });
  await expect(fixtureMembership).toHaveCount(1);
  await fixtureMembership.click();
  await expect(selector).toContainText(FIXTURE.workspaceName);
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

async function openUnpreparedAssignment(page: Page, assignmentId: string) {
  await page.goto(`/student/practice/${assignmentId}`);
  await expect(page).toHaveURL(`/student/practice/${assignmentId}`);
  await expect(
    page.getByText("Loading worksheet...", { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("worksheet-generation-status")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare worksheet", exact: true }),
  ).toHaveCount(1);
}

async function worksheetPreparationState(page: Page) {
  if (
    await page
      .getByRole("progressbar", { name: "Worksheet answer progress" })
      .isVisible()
      .catch(() => false)
  ) {
    return "ready";
  }
  const status = page.getByTestId("worksheet-generation-status");
  if ((await status.count()) === 0) return "transitioning";
  const generationStatus = await status.getAttribute("data-generation-status");
  if (generationStatus === "failed" || generationStatus === "needs_review") {
    return "failed";
  }
  return "preparing";
}

async function waitForPreparedWorksheet(page: Page) {
  const deadlineAt = Date.now() + GENERATION_TERMINAL_GATE_MS;
  const intervals = [250, 500, 1_000, 2_000, 5_000];
  let intervalIndex = 0;
  while (Date.now() < deadlineAt) {
    const state = await worksheetPreparationState(page);
    if (state === "ready") return;
    if (state === "failed") {
      throw new Error("worksheet_generation_terminal_failure");
    }
    const remainingMs = deadlineAt - Date.now();
    await page.waitForTimeout(
      Math.min(
        intervals[Math.min(intervalIndex, intervals.length - 1)],
        remainingMs,
      ),
    );
    intervalIndex += 1;
  }
  throw new Error("worksheet_generation_terminal_timeout");
}

async function prepareWorksheet(page: Page, assignmentId: string) {
  await openUnpreparedAssignment(page, assignmentId);
  const startedAt = Date.now();
  await page
    .getByRole("button", { name: "Prepare worksheet", exact: true })
    .click();

  await waitForPreparedWorksheet(page);
  return Date.now() - startedAt;
}

async function assertPreparationProgressAppears(page: Page) {
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByRole("progressbar", { name: "Worksheet answer progress" })
            .isVisible()
            .catch(() => false)
        ) {
          return "ready";
        }
        const status = page.getByTestId("worksheet-generation-status");
        if ((await status.count()) === 0 || !(await status.isVisible())) {
          return "pending";
        }
        const text = await status.innerText();
        return text.includes("being prepared") ||
          text.includes("safely delayed")
          ? "durable"
          : "pending";
      },
      { timeout: GENERATION_PROGRESS_GATE_MS, intervals: [100, 250, 500] },
    )
    .not.toBe("pending");
}

async function waitForDraftReady(page: Page) {
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    /Autosave ready|Saved/,
    { timeout: 20_000 },
  );
}

async function waitForSaved(page: Page) {
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved",
    { timeout: 20_000 },
  );
}

function answerControls(page: Page) {
  return page.locator('[data-testid^="worksheet-answer-"]');
}

async function answerControl(control: Locator, questionIndex: number) {
  if ((await control.getAttribute("role")) === "radiogroup") {
    await control.getByRole("radio").nth(0).click();
    return;
  }
  await control.fill(
    questionIndex < 6 ? SYNTHETIC_SHORT_ANSWER : SYNTHETIC_OPEN_ANSWER,
  );
}

async function autosaveReloadAndCompleteAnswers(
  page: Page,
  profile: WorksheetLiveProfile,
) {
  await waitForDraftReady(page);
  const controls = answerControls(page);
  await expect(controls).toHaveCount(expectedQuestionCount());

  const firstControl = controls.nth(0);
  await expect(firstControl).toHaveAttribute("role", "radiogroup");
  const firstChoice = firstControl.getByRole("radio").nth(0);
  await firstChoice.click();

  let textControlIndex = -1;
  let savedTextAnswer = "";
  if (profile === "mcq_safe") {
    for (let index = 0; index < expectedQuestionCount(); index += 1) {
      await expect(controls.nth(index)).toHaveAttribute("role", "radiogroup");
      const optionCount = await controls.nth(index).getByRole("radio").count();
      expect(optionCount).toBeGreaterThanOrEqual(3);
      expect(optionCount).toBeLessThanOrEqual(4);
    }
  } else {
    for (let index = 1; index < expectedQuestionCount(); index += 1) {
      if ((await controls.nth(index).getAttribute("role")) !== "radiogroup") {
        textControlIndex = index;
        break;
      }
    }
    expect(textControlIndex).toBeGreaterThanOrEqual(1);
    savedTextAnswer =
      textControlIndex < 6 ? SYNTHETIC_SHORT_ANSWER : SYNTHETIC_OPEN_ANSWER;
    await controls.nth(textControlIndex).fill(savedTextAnswer);
    await page.keyboard.press("Tab");
  }
  await waitForSaved(page);

  await page.reload();
  await expect(
    page.getByText("Loading worksheet...", { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await waitForDraftReady(page);
  await expect(
    answerControls(page).nth(0).getByRole("radio").nth(0),
  ).toBeChecked();
  if (profile === "rich_mixed") {
    await expect(answerControls(page).nth(textControlIndex)).toHaveValue(
      savedTextAnswer,
    );
  }

  const restoredControls = answerControls(page);
  await expect(restoredControls).toHaveCount(expectedQuestionCount());
  for (let index = 1; index < expectedQuestionCount(); index += 1) {
    if (profile === "rich_mixed" && index === textControlIndex) continue;
    await answerControl(restoredControls.nth(index), index);
  }
  await page.keyboard.press("Tab");
  await waitForSaved(page);

  await page.reload();
  await expect(
    page.getByText("Loading worksheet...", { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await waitForDraftReady(page);
  const fullyRestoredControls = answerControls(page);
  await expect(fullyRestoredControls).toHaveCount(expectedQuestionCount());
  for (let index = 0; index < expectedQuestionCount(); index += 1) {
    const restoredControl = fullyRestoredControls.nth(index);
    if ((await restoredControl.getAttribute("role")) === "radiogroup") {
      await expect(restoredControl.getByRole("radio").nth(0)).toBeChecked();
      continue;
    }
    const expectedAnswer =
      profile === "rich_mixed" && index === textControlIndex
        ? savedTextAnswer
        : index < 6
          ? SYNTHETIC_SHORT_ANSWER
          : SYNTHETIC_OPEN_ANSWER;
    await expect(restoredControl).toHaveValue(expectedAnswer);
  }
  await expect(
    page.getByRole("button", { name: "Submit worksheet", exact: true }),
  ).toBeEnabled();
}

async function submitAndWaitForTerminalEvaluation(page: Page) {
  const startedAt = Date.now();
  const submit = page.getByRole("button", {
    name: "Submit worksheet",
    exact: true,
  });
  await submit.click();

  await expect
    .poll(
      async () => {
        const safeFailure = page.getByText(
          "Feedback could not be prepared after safe retries",
          { exact: false },
        );
        if (
          (await safeFailure.count()) > 0 &&
          (await safeFailure.nth(0).isVisible())
        ) {
          return "failed";
        }
        const pending = await page
          .getByText("Preparing detailed feedback...", { exact: true })
          .count();
        const reviewCount = await page
          .locator('[data-testid^="worksheet-review-status-"]')
          .count();
        return pending === 0 && reviewCount === expectedQuestionCount()
          ? "terminal"
          : "pending";
      },
      {
        timeout: EVALUATION_TERMINAL_GATE_MS,
        intervals: [500, 1_000, 2_000, 5_000],
      },
    )
    .toBe("terminal");

  await expect(page.getByTestId("practice-score")).toBeVisible();
  await expect(submit).toHaveCount(0);
  return Date.now() - startedAt;
}

test.skip(
  process.env.E2E_LIVE_WORKSHEET !== "true" && !recoveryOnly,
  "Set E2E_LIVE_WORKSHEET=true for the isolated staging worksheet run or E2E_LIVE_WORKSHEET_RECOVERY_ONLY=true for exact cleanup.",
);

test.describe.serial("isolated bank-first and provider worksheet smoke", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    assertPinnedBrowserStaging();
    worksheetLevel = requiredWorksheetLevel();
    const accounts = resolveAccountSlots();
    studentAccount = accounts.student;
    teacherAccount = accounts.teacher;
    runPrivateLinkedSql(cleanupFixtureSql(accounts.teacher, accounts.student), [
      "worksheet_live_cleanup_ok",
    ]);
    if (recoveryOnly) {
      runPrivateLinkedSql(
        providerGenerationDiagnosticSql(),
        [],
        ["worksheet_live_diag_"],
      );
      return;
    }

    fixtureInstalled = true;
    const setupStatus = runPrivateLinkedSql(
      createFixtureSql(accounts.teacher, accounts.student),
      [
        "worksheet_live_fixture_setup_bank_present",
        "worksheet_live_fixture_setup_bank_absent",
      ],
    );
    bankAssignmentAvailable =
      setupStatus === "worksheet_live_fixture_setup_bank_present";
    if (requireBank && !bankAssignmentAvailable) {
      throw new Error(
        `Launch certification requires an existing qualified ${activeWorksheetLevel()} bank release.`,
      );
    }
  });

  test.afterAll(() => {
    if (!fixtureInstalled || !teacherAccount || !studentAccount) return;
    runPrivateLinkedSql(cleanupFixtureSql(teacherAccount, studentAccount), [
      "worksheet_live_cleanup_ok",
    ]);
  });

  test("reuses an existing qualified bank worksheet synchronously when staging has one", async ({
    page,
  }) => {
    test.skip(recoveryOnly, "Exact recovery only.");
    test.skip(
      !bankAssignmentAvailable,
      `Staging has no existing qualified ${activeWorksheetLevel()} bank release; no draft is certified by this test.`,
    );
    test.setTimeout(45_000);
    if (!studentAccount) {
      throw new Error("The live worksheet student account was not prepared.");
    }
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    await signInStudent(page, studentAccount);
    await selectFixtureWorkspace(page);
    const elapsedMs = await prepareWorksheet(page, FIXTURE.bankAssignmentId);
    expect(elapsedMs).toBeLessThanOrEqual(5_000);
    runPrivateLinkedSql(bankReadyAssertionSql(), [
      "worksheet_live_bank_reuse_ready",
    ]);
    assertNoFatalFailures();
  });

  test("generates with dual-provider evidence, restores autosave, and reaches terminal scoring", async ({
    page,
  }) => {
    test.skip(recoveryOnly, "Exact recovery only.");
    test.setTimeout(7 * 60_000);
    if (!studentAccount) {
      throw new Error("The live worksheet student account was not prepared.");
    }
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    await signInStudent(page, studentAccount);
    await selectFixtureWorkspace(page);

    await openUnpreparedAssignment(page, FIXTURE.providerAssignmentId);
    const startedAt = Date.now();
    await page
      .getByRole("button", { name: "Prepare worksheet", exact: true })
      .click();
    let progressAppearedWithinGate = true;
    try {
      await assertPreparationProgressAppears(page);
    } catch {
      progressAppearedWithinGate = false;
    }
    try {
      await waitForPreparedWorksheet(page);
    } catch {
      const diagnostic = runPrivateLinkedSql(
        providerGenerationDiagnosticSql(),
        [],
        ["worksheet_live_diag_"],
      );
      throw new PrivateSqlError(diagnostic);
    }
    const generationElapsedMs = Date.now() - startedAt;
    expect(generationElapsedMs).toBeLessThanOrEqual(
      GENERATION_TERMINAL_GATE_MS,
    );

    const generationStatus = runPrivateLinkedSql(providerReadyAssertionSql(), [
      "worksheet_live_generation_deepseek_mcq_safe",
      "worksheet_live_generation_gemini_mcq_safe",
    ]);
    expect(generationStatus.endsWith("_mcq_safe")).toBe(true);
    const worksheetProfile: WorksheetLiveProfile = "mcq_safe";

    await autosaveReloadAndCompleteAnswers(page, worksheetProfile);
    const evaluationElapsedMs = await submitAndWaitForTerminalEvaluation(page);
    expect(evaluationElapsedMs).toBeLessThanOrEqual(
      EVALUATION_TERMINAL_GATE_MS,
    );
    if (worksheetProfile === "mcq_safe") {
      runPrivateLinkedSql(objectiveTerminalAssertionSql(), [
        "worksheet_live_objective_terminal",
      ]);
    } else {
      runPrivateLinkedSql(evaluationTerminalAssertionSql(), [
        "worksheet_live_evaluation_terminal",
      ]);
    }
    expect(generationElapsedMs).toBeLessThanOrEqual(
      GENERATION_PERFORMANCE_SMOKE_MS,
    );
    expect(progressAppearedWithinGate).toBe(true);
    assertNoFatalFailures();
  });
});
