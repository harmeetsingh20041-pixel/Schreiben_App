import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createWritingLiveRecoveryManifest,
  readWritingLiveRecoveryManifest,
  removeWritingLiveRecoveryManifest,
  replaceWritingLiveRecoveryManifest,
  type WritingLiveRecoveryManifest,
} from "./fixtures/writing-live-recovery-manifest";
import {
  classifyWritingLiveSafeStatus,
  parsePrivateNumericRow,
  parseWritingLiveSafeStatus,
  WRITING_LIVE_CAPACITY_VALUE_COUNT,
  WRITING_LIVE_STATUS_VALUE_COUNT,
} from "./fixtures/writing-live-safe-status";
import {
  WRITING_LIVE_RELIABILITY_CORPUS,
  WRITING_LIVE_TOPIC_SLUGS,
  writingLiveReliabilityCase,
  type WritingLiveLevel,
  type WritingLiveReliabilityCase,
} from "./fixtures/writing-live-reliability-corpus";

type Credentials = { email: string; password: string };
type AccountSlot = "TEACHER" | "STUDENT";

interface WritingLiveFixture {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  teacherMembershipId: string;
  studentMembershipId: string;
  batchId: string;
  batchName: string;
  level: WritingLiveLevel;
  batchStudentId: string;
  submissionId: string | null;
}

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const PRIVATE_SQL_MAX_BUFFER = 1024 * 1024;
const PRIVATE_SQL_MUTATION_TIMEOUT_MS = 90_000;
const PRIVATE_SQL_PREFLIGHT_TIMEOUT_MS = 60_000;
const PRIVATE_SQL_STATUS_TIMEOUT_MS = 45_000;
const PRIVATE_SQL_SAFE_ERROR_PATTERN =
  /\bwriting_live_(?:fixture|canary)_[a-z0-9_]+\b/;
const WRITING_FEEDBACK_TIMEOUT_MS = 240_000;
const WRITING_STATUS_POLL_INTERVAL_MS = 1_500;
const DEEPSEEK_FLASH_WRITING_RESERVATION_MICROUSD = 75_000;
const WRITING_LIVE_METRIC_VALUE_COUNT = 44;
const SELECTED_WRITING_CASE = writingLiveReliabilityCase(
  process.env.E2E_LIVE_WRITING_CASE_INDEX,
  process.env.E2E_LIVE_WRITING_REGRESSION_ID,
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let fixture: WritingLiveFixture | null = null;
let studentAccount: Credentials | null = null;
let fixtureInstalled = false;
const recoveryOnly = process.env.E2E_LIVE_WRITING_RECOVERY_ONLY === "true";
const externalRecoveryCanary =
  process.env.E2E_LIVE_WRITING_EXTERNAL_RECOVERY === "true";

class PrivateSqlError extends Error {
  constructor(readonly safeCode: string) {
    super(`Private staging SQL failed (${safeCode}).`);
    this.name = "PrivateSqlError";
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live writing E2E.`);
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
    throw new Error("The live writing check requires two distinct accounts.");
  }
  return candidates;
}

function resolveAccountSlots() {
  const requestedStudentSlot = requiredEnvironment("E2E_WRITING_STUDENT_SLOT");
  if (
    requestedStudentSlot !== "TEACHER" &&
    requestedStudentSlot !== "STUDENT"
  ) {
    throw new Error("E2E_WRITING_STUDENT_SLOT must equal TEACHER or STUDENT.");
  }
  const accounts = candidateAccounts();
  const studentIndex = requestedStudentSlot === "TEACHER" ? 0 : 1;
  return {
    student: accounts[studentIndex],
    teacher: accounts[studentIndex === 0 ? 1 : 0],
    studentSlot: requestedStudentSlot as AccountSlot,
  };
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("The live writing fixture received an invalid UUID.");
  }
  return value;
}

function sqlUuid(value: string) {
  return `'${requireUuid(value)}'::uuid`;
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The live writing fixture received an invalid value.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function newWritingLiveFixture(level: WritingLiveLevel): WritingLiveFixture {
  const workspaceId = randomUUID();
  const suffix = workspaceId.slice(0, 8);
  return {
    workspaceId,
    workspaceName: `V1 writing live ${suffix}`,
    workspaceSlug: `e2e-writing-live-${workspaceId}`,
    teacherMembershipId: randomUUID(),
    studentMembershipId: randomUUID(),
    batchId: randomUUID(),
    batchName: `Writing live class ${suffix}`,
    level,
    batchStudentId: randomUUID(),
    submissionId: null,
  };
}

function repositoryRoot() {
  return resolve(process.cwd(), "../..");
}

function recoveryManifestPath() {
  return resolve(repositoryRoot(), ".e2e-private/writing-live-fixture.json");
}

function recoveryManifestFor(
  target: WritingLiveFixture,
): WritingLiveRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PINNED_STAGING_PROJECT_REF,
    workspace_id: target.workspaceId,
    teacher_membership_id: target.teacherMembershipId,
    student_membership_id: target.studentMembershipId,
    batch_id: target.batchId,
    batch_student_id: target.batchStudentId,
    submission_id: target.submissionId,
  };
}

function fixtureFromRecoveryManifest(
  manifest: WritingLiveRecoveryManifest,
): WritingLiveFixture {
  const suffix = manifest.workspace_id.slice(0, 8);
  return {
    workspaceId: manifest.workspace_id,
    workspaceName: `V1 writing live ${suffix}`,
    workspaceSlug: `e2e-writing-live-${manifest.workspace_id}`,
    teacherMembershipId: manifest.teacher_membership_id,
    studentMembershipId: manifest.student_membership_id,
    batchId: manifest.batch_id,
    batchName: `Writing live class ${suffix}`,
    // Recovery and cleanup are deliberately IDs-only and never inspect level.
    level: "A1",
    batchStudentId: manifest.batch_student_id,
    submissionId: manifest.submission_id,
  };
}

function assertPinnedLinkedStaging() {
  let linkedProjectRef = "";
  try {
    linkedProjectRef = readFileSync(
      resolve(repositoryRoot(), "supabase/.temp/project-ref"),
      "utf8",
    ).trim();
  } catch {
    throw new Error("The live writing check could not verify staging.");
  }
  if (linkedProjectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error("The live writing check is not linked to pinned staging.");
  }
}

function runPrivateLinkedSql(operation: string, sql: string) {
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
      timeout: PRIVATE_SQL_MUTATION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      // SQL, database output, credentials, and writing content never become
      // Playwright artifacts or exception text.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    const safeCode =
      [result.stdout, result.stderr]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.match(PRIVATE_SQL_SAFE_ERROR_PATTERN)?.[0])
        .find((value): value is string => Boolean(value)) ??
      "writing_live_fixture_database_command_failed";
    throw new PrivateSqlError(safeCode);
  }
}

async function runPrivateLinkedNumericSql(
  sql: string,
  expectedValueCount: number,
  options: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal;
  }>,
): Promise<readonly number[]> {
  assertPinnedLinkedStaging();
  const executable = requiredEnvironment("E2E_SUPABASE_BIN");
  if (!isAbsolute(executable)) {
    throw new Error("E2E_SUPABASE_BIN must be an absolute path.");
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("E2E_")),
  ) as NodeJS.ProcessEnv;

  return await new Promise<readonly number[]>((resolveValues, rejectValues) => {
    const child = spawn(
      executable,
      [
        "db",
        "query",
        "--linked",
        "--agent",
        "no",
        "--output-format",
        "json",
        "--file",
        "/dev/stdin",
      ],
      {
        cwd: repositoryRoot(),
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const abortQuery = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abortQuery, { once: true });

    const clearControls = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortQuery);
    };

    const capture = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      capturedBytes += Buffer.byteLength(value, "utf8");
      if (capturedBytes > PRIVATE_SQL_MAX_BUFFER) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += value;
      else stderr += value;
    };

    child.stdout.on("data", (chunk: Buffer | string) =>
      capture("stdout", chunk),
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      capture("stderr", chunk),
    );
    child.stdin.on("error", () => {
      // A failed child is handled by its close/error event without surfacing
      // SQL, credentials, or connection output.
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearControls();
      rejectValues(
        new PrivateSqlError("writing_live_fixture_database_command_failed"),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearControls();
      if (aborted) {
        rejectValues(
          new PrivateSqlError("writing_live_fixture_status_query_aborted"),
        );
        return;
      }
      if (timedOut) {
        rejectValues(
          new PrivateSqlError("writing_live_fixture_status_query_timeout"),
        );
        return;
      }
      if (outputExceeded) {
        rejectValues(
          new PrivateSqlError("writing_live_fixture_status_output_exceeded"),
        );
        return;
      }
      const safeCode = [stdout, stderr]
        .map((value) => value.match(PRIVATE_SQL_SAFE_ERROR_PATTERN)?.[0])
        .find((value): value is string => Boolean(value));
      if (code !== 0) {
        rejectValues(
          new PrivateSqlError(
            safeCode ?? "writing_live_fixture_database_command_failed",
          ),
        );
        return;
      }
      const values = parsePrivateNumericRow(stdout, expectedValueCount);
      if (!values) {
        rejectValues(
          new PrivateSqlError("writing_live_fixture_safe_numbers_missing"),
        );
        return;
      }
      resolveValues(values);
    });

    child.stdin.end(sql);
  });
}

async function latestRecoveryHeartbeatEpoch() {
  const [epoch] = await runPrivateLinkedNumericSql(
    `
select concat_ws(
  ',',
  coalesce(
    extract(epoch from max(heartbeat.last_seen_at))::bigint,
    0::bigint
  )::text
) as safe_numbers
from app_private.recovery_heartbeat heartbeat;
`,
    1,
    { timeoutMs: PRIVATE_SQL_STATUS_TIMEOUT_MS },
  );
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new PrivateSqlError(
      "writing_live_fixture_recovery_heartbeat_invalid",
    );
  }
  return epoch;
}

function createFixtureSql(
  target: WritingLiveFixture,
  teacher: Credentials,
  student: Credentials,
) {
  return `
begin;
do $writing_live_setup$
declare
  teacher_profile_id uuid;
  student_profile_id uuid;
  teacher_role text;
  student_role text;
  setup_stage text := 'account_validation';
  safe_failure_kind text;
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
    raise exception using message = 'writing_live_fixture_accounts_invalid';
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
    raise exception using message = 'writing_live_fixture_roles_invalid';
  end if;

  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
      or workspace.slug = ${sqlLiteral(target.workspaceSlug)}
  ) or exists (
    select 1 from public.batches batch
    where batch.id = ${sqlUuid(target.batchId)}
  ) then
    raise exception using message = 'writing_live_fixture_scope_not_empty';
  end if;

  setup_stage := 'workspace_insert';
  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(target.workspaceId)},
    ${sqlLiteral(target.workspaceName)},
    ${sqlLiteral(target.workspaceSlug)},
    teacher_profile_id
  );

  setup_stage := 'membership_insert';
  insert into public.workspace_members (id, workspace_id, user_id, role)
  values
    (
      ${sqlUuid(target.teacherMembershipId)},
      ${sqlUuid(target.workspaceId)},
      teacher_profile_id,
      'teacher'
    ),
    (
      ${sqlUuid(target.studentMembershipId)},
      ${sqlUuid(target.workspaceId)},
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
    ${sqlUuid(target.batchId)},
    ${sqlUuid(target.workspaceId)},
    ${sqlLiteral(target.batchName)},
    ${sqlLiteral(target.level)},
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
    ${sqlUuid(target.batchStudentId)},
    ${sqlUuid(target.batchId)},
    student_profile_id,
    ${sqlUuid(target.workspaceId)}
  );

  setup_stage := 'contract_validation';
  if (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${sqlUuid(target.workspaceId)}
      and (
        (
          membership.id = ${sqlUuid(target.teacherMembershipId)}
          and membership.user_id = teacher_profile_id
          and membership.role = 'teacher'
        )
        or (
          membership.id = ${sqlUuid(target.studentMembershipId)}
          and membership.user_id = student_profile_id
          and membership.role = 'student'
        )
      )
  ) <> 2 or not exists (
    select 1
    from public.batches batch
    join public.batch_students assignment
      on assignment.batch_id = batch.id
     and assignment.workspace_id = batch.workspace_id
    where batch.id = ${sqlUuid(target.batchId)}
      and batch.workspace_id = ${sqlUuid(target.workspaceId)}
      and batch.feedback_mode = 'immediate'
      and batch.is_active
      and assignment.id = ${sqlUuid(target.batchStudentId)}
      and assignment.student_id = student_profile_id
  ) then
    raise exception using message = 'writing_live_fixture_contract_invalid';
  end if;
exception
  when others then
    if sqlerrm ~ '^writing_live_fixture_[a-z0-9_]+$' then
      raise;
    end if;
    safe_failure_kind := case sqlstate
      when '23503' then 'foreign_key'
      when '23505' then 'unique'
      when '23514' then 'check'
      when '42501' then 'permission'
      when '42703' then 'undefined_column'
      else 'database'
    end;
    raise exception using
      errcode = 'P0001',
      message = 'writing_live_fixture_setup_' || setup_stage || '_' ||
        safe_failure_kind || '_failed';
end;
$writing_live_setup$;
commit;
  `;
}

function writingLiveCapacityPreflightSql(
  target: WritingLiveFixture,
  student: Credentials,
) {
  return `
with billing as (
    select
      date_trunc('month', timezone('UTC', now()))::date as billing_month,
      (timezone('UTC', now()))::date as current_utc_date
  ), selected_student as (
    select
      profile.id,
      profile.global_role,
      count(*) over ()::bigint as match_count
    from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(student.email)})
    order by profile.id
    limit 1
  ), selected_global as (
    select policy.*
    from app_private.ai_spend_global_policy policy
    where policy.singleton
  ), selected_model as (
    select policy.maximum_reservation_microusd
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'deepseek'
      and policy.model_name = 'deepseek-v4-flash'
      and policy.call_purpose = 'writing_generation'
  ), active_cohort as (
    select count(*)::bigint as active_student_count
    from public.workspace_members membership
    where membership.workspace_id = ${sqlUuid(target.workspaceId)}
      and membership.role = 'student'
  ), effective_limits as (
    select
      coalesce((
        select budget.monthly_limit_microusd
        from app_private.ai_workspace_monthly_budgets budget
        where budget.workspace_id = ${sqlUuid(target.workspaceId)}
          and budget.billing_month = billing.billing_month
      ), global_policy.default_workspace_monthly_limit_microusd)
        as workspace_limit_microusd
    from selected_global global_policy
    cross join billing
  ), committed as (
    select
      coalesce((
        select sum(case
          when entry.state = 'finalized' then entry.actual_microusd
          when entry.state = 'reserved' then entry.reserved_microusd
          else 0
        end)::bigint
        from app_private.ai_spend_accounting_entries() entry
        cross join billing
        where entry.workspace_id = ${sqlUuid(target.workspaceId)}
          and entry.billing_month = billing.billing_month
      ), 0)::bigint as workspace_committed_microusd,
      coalesce((
        select sum(case
          when entry.state = 'finalized' then entry.actual_microusd
          when entry.state = 'reserved' then entry.reserved_microusd
          else 0
        end)::bigint
        from app_private.ai_spend_accounting_entries() entry
        cross join billing
        where entry.billing_month = billing.billing_month
      ), 0)::bigint as global_committed_microusd
  ), enforcement_contract as (
    select
      lower(pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )) as attribution_definition,
      lower(pg_get_functiondef(
        'app_private.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'::regprocedure
      )) as reservation_definition
  )
  select concat_ws(
    '|',
    (student.match_count = 1 and student.global_role = 'student')::integer,
    (exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = ${sqlUuid(target.workspaceId)}
        and membership.user_id = student.id
        and membership.role = 'student'
    ))::integer,
    cohort.active_student_count,
    (
      not global_policy.emergency_stop
      and position(
        'ai_spend_emergency_stop' in contract.reservation_definition
      ) > 0
    )::integer,
    (model_policy.maximum_reservation_microusd =
      ${DEEPSEEK_FLASH_WRITING_RESERVATION_MICROUSD})::integer,
    (
      global_policy.operating_target_microeur_per_active_student_month > 0
      and global_policy.fair_share_reserve_basis_points between 0 and 9999
      and global_policy.exchange_rate_verified_at <= billing.current_utc_date
    )::integer,
    (
      position(
        'ai_spend_student_fair_share_exceeded'
        in contract.attribution_definition
      ) = 0
      and position('new.student_id' in contract.attribution_definition) > 0
    )::integer,
    (
      position(
        'ai_fair_share_limit_microusd'
        in contract.attribution_definition
      ) = 0
      and position(
        'cached_input_rate_microusd_per_million'
        in contract.attribution_definition
      ) > 0
    )::integer,
    (
      committed.workspace_committed_microusd +
        ${DEEPSEEK_FLASH_WRITING_RESERVATION_MICROUSD} <=
        limits.workspace_limit_microusd
      and position(
        'ai_spend_workspace_budget_exceeded'
        in contract.reservation_definition
      ) > 0
    )::integer,
    (
      committed.global_committed_microusd +
        ${DEEPSEEK_FLASH_WRITING_RESERVATION_MICROUSD} <=
        global_policy.monthly_limit_microusd
      and position(
        'ai_spend_global_budget_exceeded'
        in contract.reservation_definition
      ) > 0
    )::integer
  ) as safe_numbers
  from selected_student student
  cross join selected_global global_policy
  cross join selected_model model_policy
  cross join active_cohort cohort
  cross join effective_limits limits
  cross join committed
  cross join enforcement_contract contract
  cross join billing;
`;
}

async function assertWritingLiveCapacity(
  target: WritingLiveFixture,
  student: Credentials,
) {
  const values = await runPrivateLinkedNumericSql(
    writingLiveCapacityPreflightSql(target, student),
    WRITING_LIVE_CAPACITY_VALUE_COUNT,
    { timeoutMs: PRIVATE_SQL_PREFLIGHT_TIMEOUT_MS },
  );
  const [
    exactStudent,
    activeMembership,
    activeStudentCount,
    emergencyStopOff,
    exactModelReservation,
    validPlanningPolicy,
    studentTargetMonitorOnly,
    cohortTargetMonitorOnly,
    workspaceFits,
    globalFits,
  ] = values;
  if (
    exactStudent !== 1 ||
    activeMembership !== 1 ||
    !Number.isSafeInteger(activeStudentCount) ||
    activeStudentCount! < 1 ||
    emergencyStopOff !== 1 ||
    exactModelReservation !== 1 ||
    validPlanningPolicy !== 1 ||
    studentTargetMonitorOnly !== 1 ||
    cohortTargetMonitorOnly !== 1 ||
    workspaceFits !== 1 ||
    globalFits !== 1
  ) {
    throw new PrivateSqlError(
      "writing_live_fixture_deepseek_flash_capacity_unavailable",
    );
  }
}

function writingLiveSafeStatusSql(target: WritingLiveFixture) {
  if (!target.submissionId) {
    throw new PrivateSqlError("writing_live_fixture_submission_id_missing");
  }
  return `
with fixture_submission as (
    select submission.*
    from public.submissions submission
    where submission.id = ${sqlUuid(target.submissionId)}
  ), exact_submission as (
    select submission.*
    from fixture_submission submission
    join public.batch_students assignment
      on assignment.id = ${sqlUuid(target.batchStudentId)}
     and assignment.batch_id = submission.batch_id
     and assignment.workspace_id = submission.workspace_id
     and assignment.student_id = submission.student_id
    where submission.workspace_id = ${sqlUuid(target.workspaceId)}
      and submission.batch_id = ${sqlUuid(target.batchId)}
  ), all_jobs as (
    select job.*
    from app_private.async_jobs job
    where job.entity_id = ${sqlUuid(target.submissionId)}
      and job.job_kind = 'writing_evaluation'
      and job.queue_name = 'writing_evaluation'
  ), selected_job as (
    select job.*
    from all_jobs job
    order by job.entity_version desc, job.created_at desc, job.id desc
    limit 1
  ), adjudication_evidence as (
    select evidence.decision, evidence.reason_code
    from app_private.writing_feedback_adjudications_v2 evidence
    join selected_job job
      on job.id = evidence.job_id
     and job.entity_version = evidence.evaluation_version
     and job.entity_version = evidence.feedback_version
    where evidence.submission_id = ${sqlUuid(target.submissionId)}
  )
  select concat_ws(
    '|',
    (select count(*) from fixture_submission)::bigint,
    (exists (select 1 from exact_submission))::integer,
    coalesce((select submission.evaluation_status = 'queued'
      from exact_submission submission), false)::integer,
    coalesce((select submission.evaluation_status = 'processing'
      from exact_submission submission), false)::integer,
    coalesce((select submission.evaluation_status = 'ready'
      from exact_submission submission), false)::integer,
    coalesce((select submission.evaluation_status = 'needs_review'
      from exact_submission submission), false)::integer,
    coalesce((select submission.evaluation_status = 'failed'
      from exact_submission submission), false)::integer,
    coalesce((select submission.release_status = 'held'
      from exact_submission submission), false)::integer,
    coalesce((select submission.release_status = 'scheduled'
      from exact_submission submission), false)::integer,
    coalesce((select submission.release_status = 'released'
      from exact_submission submission), false)::integer,
    (select count(*) from all_jobs)::bigint,
    coalesce((select job.status = 'queued' from selected_job job),
      false)::integer,
    coalesce((select job.status = 'processing' from selected_job job),
      false)::integer,
    coalesce((select job.status = 'retry' from selected_job job),
      false)::integer,
    coalesce((select job.status = 'succeeded' from selected_job job),
      false)::integer,
    coalesce((select job.status = 'dead' from selected_job job),
      false)::integer,
    coalesce((select job.attempt_count from selected_job job), -1)::integer,
    coalesce((select job.last_error_code is not null from selected_job job),
      false)::integer,
    coalesce((select job.status = 'retry' and job.available_at <= now()
      from selected_job job), false)::integer,
    coalesce((select job.status = 'retry' and job.available_at > now()
      from selected_job job), false)::integer,
    coalesce((select job.status = 'processing'
      and job.lease_expires_at > now() from selected_job job), false)::integer,
    (select count(*) from adjudication_evidence)::bigint,
    coalesce((select evidence.decision = 'accepted_model_feedback'
      from adjudication_evidence evidence), false)::integer,
    coalesce((select evidence.decision = 'system_hold'
      from adjudication_evidence evidence), false)::integer,
    coalesce((select case evidence.reason_code
      when 'critic_approved' then 1
      when 'final_critic_approved' then 2
      when 'recovery_critic_approved' then 3
      when 'generator_not_configured' then 4
      when 'generator_authentication_failed' then 5
      when 'generator_not_primary' then 6
      when 'generator_invalid' then 7
      when 'critic_not_configured' then 8
      when 'critic_authentication_failed' then 9
      when 'critic_invalid' then 10
      when 'critic_hash_mismatch' then 11
      when 'critic_disagreed' then 12
      when 'critic_uncertain' then 13
      when 'adjudicator_not_configured' then 14
      when 'adjudicator_authentication_failed' then 15
      when 'adjudicator_invalid' then 16
      when 'adjudicator_hash_mismatch' then 17
      when 'adjudicator_unresolved' then 18
      when 'final_critic_not_configured' then 19
      when 'final_critic_authentication_failed' then 20
      when 'final_critic_invalid' then 21
      when 'final_critic_hash_mismatch' then 22
      when 'final_critic_disagreed' then 23
      when 'final_critic_uncertain' then 24
      when 'critic_advisory_unavailable' then 25
      when 'pro_authority_accepted' then 26
      when 'adjudicator_resolved' then 27
      else 0
    end from adjudication_evidence evidence), 0)::integer,
    coalesce((select case job.last_error_code
      when 'provider_timeout' then 1
      when 'provider_unavailable' then 2
      when 'provider_http_408' then 3
      when 'provider_http_425' then 4
      when 'provider_http_429' then 5
      when 'provider_http_500' then 6
      when 'provider_http_502' then 7
      when 'provider_http_503' then 8
      when 'provider_http_504' then 9
      when 'writing_critic_timeout' then 10
      when 'writing_adjudication_deadline_exceeded' then 11
      when 'writing_spend_accounting_failed' then 12
      when 'provider_response_invalid' then 13
      when 'provider_response_too_large' then 14
      when 'provider_authentication_failed' then 15
      when 'feedback_invalid_after_pro' then 16
      when 'ai_spend_workspace_budget_exceeded' then 17
      when 'ai_spend_cohort_budget_exceeded' then 18
      when 'ai_spend_student_fair_share_exceeded' then 19
      when 'ai_spend_student_inactive' then 20
      when 'ai_spend_global_budget_exceeded' then 21
      when 'ai_spend_fx_rate_future' then 22
      when 'ai_spend_fx_rate_stale' then 23
      when 'ai_spend_emergency_stop' then 24
      when 'ai_spend_model_not_allowed' then 25
      when 'ai_spend_contract_invalid' then 26
      when 'ai_spend_reservation_missing' then 27
      when 'ai_spend_reservation_expired' then 28
      when 'ai_spend_actual_exceeds_reserved' then 29
      when 'ai_spend_reservation_conflict' then 30
      when 'ai_spend_release_reason_invalid' then 31
      when 'ai_spend_job_missing' then 32
      when 'ai_spend_job_version_mismatch' then 33
      when 'ai_spend_job_not_active' then 34
      when 'ai_spend_response_invalid' then 35
      when 'ai_spend_accounting_timeout' then 36
      when 'ai_spend_accounting_unavailable' then 37
      when 'ai_spend_duplicate_dispatch' then 38
      when 'ai_spend_reservation_already_settled' then 39
      when 'ai_spend_dispatch_uncertain' then 40
      else 0
    end from selected_job job), 0)::integer
  ) as safe_numbers;
`;
}

async function waitForValidatedWritingFeedback(
  page: Page,
  target: WritingLiveFixture,
) {
  const feedbackHeading = page.getByRole("heading", {
    name: "Feedback Summary",
    level: 2,
  });
  const deadline = Date.now() + WRITING_FEEDBACK_TIMEOUT_MS;

  const waitForBrowserReady = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      if (await feedbackHeading.isVisible().catch(() => false)) return true;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
    }
    return false;
  };

  const isTransientStatusQueryFailure = (error: unknown) =>
    error instanceof PrivateSqlError &&
    [
      "writing_live_fixture_database_command_failed",
      "writing_live_fixture_status_query_timeout",
    ].includes(error.safeCode);

  while (Date.now() < deadline) {
    if (await feedbackHeading.isVisible().catch(() => false)) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const queryController = new AbortController();
    const browserController = new AbortController();
    const statusQuery = runPrivateLinkedNumericSql(
      writingLiveSafeStatusSql(target),
      WRITING_LIVE_STATUS_VALUE_COUNT,
      {
        timeoutMs: Math.min(PRIVATE_SQL_STATUS_TIMEOUT_MS, remainingMs),
        signal: queryController.signal,
      },
    ).then(
      (values) => ({ kind: "status" as const, values }),
      (error: unknown) => ({ kind: "status_error" as const, error }),
    );
    const browserProbe = waitForBrowserReady(browserController.signal).then(
      (ready) => ({ kind: "browser" as const, ready }),
    );
    const outcome = await Promise.race([statusQuery, browserProbe]);
    if (outcome.kind === "browser") {
      queryController.abort();
      void statusQuery;
      if (outcome.ready) return;
      continue;
    }

    browserController.abort();
    const browserReady = (await browserProbe).ready;
    if (outcome.kind === "status_error") {
      if (browserReady) return;
      if (!isTransientStatusQueryFailure(outcome.error)) throw outcome.error;
      const transientRemainingMs = deadline - Date.now();
      if (transientRemainingMs > 0) {
        await page.waitForTimeout(
          Math.min(WRITING_STATUS_POLL_INTERVAL_MS, transientRemainingMs),
        );
      }
      continue;
    }

    const status = parseWritingLiveSafeStatus(outcome.values);
    if (!status) {
      throw new PrivateSqlError("writing_live_fixture_status_contract_invalid");
    }
    const decision = classifyWritingLiveSafeStatus(status);
    if (decision.state === "failed") {
      throw new PrivateSqlError(decision.safeCode);
    }
    if (browserReady) return;

    const nextRemainingMs = deadline - Date.now();
    if (nextRemainingMs > 0) {
      await page.waitForTimeout(
        Math.min(WRITING_STATUS_POLL_INTERVAL_MS, nextRemainingMs),
      );
    }
  }
  throw new PrivateSqlError("writing_live_fixture_feedback_timeout");
}

async function assertWritingLiveTerminalProof(target: WritingLiveFixture) {
  const values = await runPrivateLinkedNumericSql(
    writingLiveSafeStatusSql(target),
    WRITING_LIVE_STATUS_VALUE_COUNT,
    { timeoutMs: PRIVATE_SQL_STATUS_TIMEOUT_MS },
  );
  const status = parseWritingLiveSafeStatus(values);
  if (!status) {
    throw new PrivateSqlError("writing_live_fixture_status_contract_invalid");
  }
  const decision = classifyWritingLiveSafeStatus(status);
  if (decision.state === "ready") return;
  if (decision.state === "failed") {
    throw new PrivateSqlError(decision.safeCode);
  }
  throw new PrivateSqlError("writing_live_fixture_feedback_not_terminal");
}

type WritingLiveMetrics = Readonly<{
  delivery: "released" | "held" | "failed";
  terminalMs: number;
  wholeTextUnchanged: boolean;
  originalTextExact: boolean;
  lineCount: number;
  issueLineCount: number;
  unclearLineCount: number;
  correctionSpanCount: number;
  allLinesUnchanged: boolean;
  topicRowCount: number;
  topicOccurrenceCount: number;
  topicMask: number;
  durableRetryCount: number;
  providerCallCount: number;
  estimatedUsageCallCount: number;
  criticContractRetryCount: number;
  costMicrousd: number;
  correctionCheckCount: number;
  correctionCheckPassedCount: number;
  forbiddenUncorrectedCount: number;
  adjudicationReasonOrdinal: number;
  generatorProviderOrdinal: number;
  generatorModelOrdinal: number;
  criticProviderOrdinal: number;
  criticModelOrdinal: number;
  adjudicatorProviderOrdinal: number;
  adjudicatorModelOrdinal: number;
  finalCriticProviderOrdinal: number;
  finalCriticModelOrdinal: number;
  acceptedProviderOrdinal: number;
  acceptedModelOrdinal: number;
}>;

function writingLiveMetricsSql(
  target: WritingLiveFixture,
  selectedCase: WritingLiveReliabilityCase,
) {
  if (!target.submissionId) {
    throw new Error("The live-writing metrics require one exact submission.");
  }
  const originalTextSha256 = createHash("sha256")
    .update(selectedCase.text, "utf8")
    .digest("hex");
  const topicContract = WRITING_LIVE_TOPIC_SLUGS.map(
    (slug, index) => `(${sqlLiteral(slug)}, ${index})`,
  ).join(",\n    ");
  const correctionContract = selectedCase.requiredCorrectionGroups?.length
    ? `values\n    ${selectedCase.requiredCorrectionGroups
        .map(
          (group, index) =>
            `(${index}, array[${group.anyOf
              .map((alternative) => sqlLiteral(alternative))
              .join(", ")}]::text[])`,
        )
        .join(",\n    ")}`
    : "select null::integer, array[]::text[] where false";
  const forbiddenContract = selectedCase.forbiddenUncorrectedSubstrings?.length
    ? `values\n    ${selectedCase.forbiddenUncorrectedSubstrings
        .map((fragment, index) => `(${index}, ${sqlLiteral(fragment)})`)
        .join(",\n    ")}`
    : "select null::integer, null::text where false";
  return `
with topic_contract(slug, bit_index) as (
  values
    ${topicContract}
), correction_contract(check_index, alternatives) as (
  ${correctionContract}
), forbidden_contract(check_index, fragment) as (
  ${forbiddenContract}
), target_submission as (
  select submission.*
  from public.submissions submission
  where submission.id = ${sqlUuid(target.submissionId)}
    and submission.workspace_id = ${sqlUuid(target.workspaceId)}
), selected_job as (
  select job.*
  from app_private.async_jobs job
  join target_submission submission on submission.id = job.entity_id
  where job.job_kind = 'writing_evaluation'
    and job.queue_name = 'writing_evaluation'
    and job.entity_version = submission.evaluation_version
), normalized_submission as (
  select
    lower(regexp_replace(
      coalesce(submission.corrected_text || '', ''),
      '[[:space:]]+',
      ' ',
      'g'
    )) as normalized_corrected,
    (
      encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(submission.original_text || '', ''),
            'UTF8'
          )
        ),
        'hex'
      ) = ${sqlLiteral(originalTextSha256)}
    )::integer as original_text_exact
  from target_submission submission
), correction_stats as (
  select
    count(contract.check_index)::bigint as correction_check_count,
    count(*) filter (
      where exists (
        select 1
        from unnest(contract.alternatives) alternative
        where strpos(normalized.normalized_corrected, lower(alternative)) > 0
      )
    )::bigint as correction_check_passed_count
  from correction_contract contract
  cross join normalized_submission normalized
), forbidden_stats as (
  select count(*) filter (
    where strpos(normalized.normalized_corrected, lower(contract.fragment)) > 0
  )::bigint as forbidden_uncorrected_count
  from forbidden_contract contract
  cross join normalized_submission normalized
), line_stats as (
  select
    count(*)::bigint as line_count,
    count(*) filter (
      where line.status in ('minor_issue', 'major_issue')
    )::bigint as issue_line_count,
    count(*) filter (where line.status = 'unclear')::bigint
      as unclear_line_count,
    coalesce(sum(jsonb_array_length(line.changed_parts)), 0)::bigint
      as correction_span_count,
    coalesce(bool_and(line.corrected_line = line.original_line), false)::integer
      as all_lines_unchanged
  from public.submission_lines line
  where line.submission_id = ${sqlUuid(target.submissionId)}
), topic_stats as (
  select
    count(summary.id)::bigint as topic_row_count,
    coalesce(sum(summary.count), 0)::bigint as topic_occurrence_count,
    coalesce(bit_or(1::bigint << contract.bit_index), 0)::bigint
      as topic_mask,
    count(*) filter (
      where summary.id is not null and contract.slug is null
    )::bigint as unknown_topic_count,
    (count(summary.id) - count(distinct topic.slug))::bigint
      as duplicate_topic_slug_count
  from public.submission_grammar_topics summary
  join public.grammar_topics topic on topic.id = summary.grammar_topic_id
  left join topic_contract contract on contract.slug = topic.slug
  where summary.submission_id = ${sqlUuid(target.submissionId)}
), spend as (
  select
    count(*)::bigint as reservation_count,
    count(*) filter (where reservation.state = 'reserved')::bigint
      as reserved_count,
    count(*) filter (where reservation.state = 'finalized')::bigint
      as provider_call_count,
    count(*) filter (
      where reservation.state = 'finalized' and reservation.usage_estimated
    )::bigint as estimated_usage_call_count,
    count(*) filter (
      where reservation.state = 'finalized'
        and reservation.call_key like '%:gemini.routine-critique-retry'
    )::bigint as critic_contract_retry_count,
    coalesce(sum(reservation.actual_microusd) filter (
      where reservation.state = 'finalized'
    ), 0)::bigint as cost_microusd
  from app_private.ai_spend_reservations reservation
  join selected_job job
    on job.id = reservation.job_id
   and job.entity_version = reservation.entity_version
), adjudication_evidence as (
  select evidence.*
  from app_private.writing_feedback_adjudications_v2 evidence
  join selected_job job
    on job.id = evidence.job_id
   and job.entity_version = evidence.evaluation_version
   and job.entity_version = evidence.feedback_version
  where evidence.submission_id = ${sqlUuid(target.submissionId)}
), adjudication_stats as (
  select
    count(*)::bigint as adjudication_count,
    coalesce(max((evidence.decision = 'accepted_model_feedback')::integer), 0)
      as adjudication_accepted,
    coalesce(max((evidence.decision = 'system_hold')::integer), 0)
      as adjudication_system_hold,
    coalesce(max(case evidence.reason_code
      when 'critic_approved' then 1
      when 'final_critic_approved' then 2
      when 'recovery_critic_approved' then 3
      when 'generator_not_configured' then 4
      when 'generator_authentication_failed' then 5
      when 'generator_not_primary' then 6
      when 'generator_invalid' then 7
      when 'critic_not_configured' then 8
      when 'critic_authentication_failed' then 9
      when 'critic_invalid' then 10
      when 'critic_hash_mismatch' then 11
      when 'critic_disagreed' then 12
      when 'critic_uncertain' then 13
      when 'adjudicator_not_configured' then 14
      when 'adjudicator_authentication_failed' then 15
      when 'adjudicator_invalid' then 16
      when 'adjudicator_hash_mismatch' then 17
      when 'adjudicator_unresolved' then 18
      when 'final_critic_not_configured' then 19
      when 'final_critic_authentication_failed' then 20
      when 'final_critic_invalid' then 21
      when 'final_critic_hash_mismatch' then 22
      when 'final_critic_disagreed' then 23
      when 'final_critic_uncertain' then 24
      when 'critic_advisory_unavailable' then 25
      when 'pro_authority_accepted' then 26
      when 'adjudicator_resolved' then 27
      else 0
    end), 0)::integer as reason_ordinal,
    coalesce(max(case evidence.generator_provider
      when 'deepseek' then 1 when 'gemini' then 2 else 3 end), 0)::integer
      as generator_provider_ordinal,
    coalesce(max(case evidence.generator_model
      when 'deepseek-v4-flash' then 1 when 'deepseek-v4-pro' then 2
      when 'gemini-3.1-flash-lite' then 3 else 4 end), 0)::integer
      as generator_model_ordinal,
    coalesce(max(case when evidence.critic_provider is null then 0
      when evidence.critic_provider = 'deepseek' then 1
      when evidence.critic_provider = 'gemini' then 2 else 3 end), 0)::integer
      as critic_provider_ordinal,
    coalesce(max(case when evidence.critic_model is null then 0
      when evidence.critic_model = 'deepseek-v4-flash' then 1
      when evidence.critic_model = 'deepseek-v4-pro' then 2
      when evidence.critic_model = 'gemini-3.1-flash-lite' then 3 else 4 end), 0)::integer
      as critic_model_ordinal,
    coalesce(max(case when evidence.adjudicator_provider is null then 0
      when evidence.adjudicator_provider = 'deepseek' then 1
      when evidence.adjudicator_provider = 'gemini' then 2 else 3 end), 0)::integer
      as adjudicator_provider_ordinal,
    coalesce(max(case when evidence.adjudicator_model is null then 0
      when evidence.adjudicator_model = 'deepseek-v4-flash' then 1
      when evidence.adjudicator_model = 'deepseek-v4-pro' then 2
      when evidence.adjudicator_model = 'gemini-3.1-flash-lite' then 3 else 4 end), 0)::integer
      as adjudicator_model_ordinal,
    coalesce(max(case when evidence.final_critic_provider is null then 0
      when evidence.final_critic_provider = 'deepseek' then 1
      when evidence.final_critic_provider = 'gemini' then 2 else 3 end), 0)::integer
      as final_critic_provider_ordinal,
    coalesce(max(case when evidence.final_critic_model is null then 0
      when evidence.final_critic_model = 'deepseek-v4-flash' then 1
      when evidence.final_critic_model = 'deepseek-v4-pro' then 2
      when evidence.final_critic_model = 'gemini-3.1-flash-lite' then 3 else 4 end), 0)::integer
      as final_critic_model_ordinal,
    coalesce(max(case when evidence.accepted_provider is null then 0
      when evidence.accepted_provider = 'deepseek' then 1
      when evidence.accepted_provider = 'gemini' then 2 else 3 end), 0)::integer
      as accepted_provider_ordinal,
    coalesce(max(case when evidence.accepted_model is null then 0
      when evidence.accepted_model = 'deepseek-v4-flash' then 1
      when evidence.accepted_model = 'deepseek-v4-pro' then 2
      when evidence.accepted_model = 'gemini-3.1-flash-lite' then 3 else 4 end), 0)::integer
      as accepted_model_ordinal
  from adjudication_evidence evidence
)
select concat_ws(
  '|',
  (select count(*) from target_submission),
  coalesce((select (
    submission.evaluation_status = 'ready'
    and submission.release_status = 'released'
  )::integer from target_submission submission), 0),
  coalesce((select (
    submission.evaluation_status = 'needs_review'
    and submission.release_status = 'held'
  )::integer from target_submission submission), 0),
  coalesce((select (submission.evaluation_status = 'failed')::integer
    from target_submission submission), 0),
  coalesce((select (job.status = 'succeeded')::integer
    from selected_job job), 0),
  coalesce((select (job.status = 'dead')::integer
    from selected_job job), 0),
  coalesce((select job.attempt_count from selected_job job), -1),
  coalesce((select greatest(job.attempt_count - 1, 0)
    from selected_job job), 0),
  coalesce((select round(extract(epoch from (
    coalesce(job.completed_at, job.dead_at) - job.created_at
  )) * 1000)::bigint from selected_job job), -1),
  coalesce((select (
    submission.corrected_text = submission.original_text
  )::integer from target_submission submission), 0),
  lines.line_count,
  lines.issue_line_count,
  lines.unclear_line_count,
  lines.correction_span_count,
  lines.all_lines_unchanged,
  topics.topic_row_count,
  topics.topic_occurrence_count,
  topics.topic_mask,
  topics.unknown_topic_count,
  topics.duplicate_topic_slug_count,
  calls.reservation_count,
  calls.reserved_count,
  calls.provider_call_count,
  calls.estimated_usage_call_count,
  calls.critic_contract_retry_count,
  calls.cost_microusd,
  coalesce((select normalized.original_text_exact
    from normalized_submission normalized), 0),
  corrections.correction_check_count,
  corrections.correction_check_passed_count,
  forbidden.forbidden_uncorrected_count,
  adjudication.adjudication_count,
  adjudication.adjudication_accepted,
  adjudication.adjudication_system_hold,
  adjudication.reason_ordinal,
  adjudication.generator_provider_ordinal,
  adjudication.generator_model_ordinal,
  adjudication.critic_provider_ordinal,
  adjudication.critic_model_ordinal,
  adjudication.adjudicator_provider_ordinal,
  adjudication.adjudicator_model_ordinal,
  adjudication.final_critic_provider_ordinal,
  adjudication.final_critic_model_ordinal,
  adjudication.accepted_provider_ordinal,
  adjudication.accepted_model_ordinal
) as safe_numbers
from line_stats lines
cross join topic_stats topics
cross join spend calls
cross join correction_stats corrections
cross join forbidden_stats forbidden
cross join adjudication_stats adjudication;
`;
}

function parseWritingLiveMetrics(
  values: readonly number[],
): WritingLiveMetrics {
  const deliveryFlagCount = values
    .slice(1, 4)
    .reduce((count, value) => count + Number(value === 1), 0);
  const delivery =
    values[1] === 1 ? "released" : values[2] === 1 ? "held" : "failed";
  const adjudicationShapeValid =
    delivery === "released"
      ? values[4] === 1 &&
        values[5] === 0 &&
        values[30] === 1 &&
        values[31] === 1 &&
        values[32] === 0 &&
        values[33]! >= 1 &&
        values[33]! <= 3
      : delivery === "held"
        ? values[4] === 1 &&
          values[5] === 0 &&
          values[30] === 1 &&
          values[31] === 0 &&
          values[32] === 1 &&
          values[33]! >= 4
        : values[4] === 0 && values[5] === 1;
  if (
    values.length !== WRITING_LIVE_METRIC_VALUE_COUNT ||
    values[0] !== 1 ||
    deliveryFlagCount !== 1 ||
    !adjudicationShapeValid ||
    values[18] !== 0 ||
    values[19] !== 0 ||
    values[21] !== 0 ||
    values[8]! < 0
  ) {
    throw new PrivateSqlError("writing_live_fixture_metrics_invalid");
  }
  return {
    delivery,
    terminalMs: values[8]!,
    wholeTextUnchanged: values[9] === 1,
    originalTextExact: values[26] === 1,
    lineCount: values[10]!,
    issueLineCount: values[11]!,
    unclearLineCount: values[12]!,
    correctionSpanCount: values[13]!,
    allLinesUnchanged: values[14] === 1,
    topicRowCount: values[15]!,
    topicOccurrenceCount: values[16]!,
    topicMask: values[17]!,
    durableRetryCount: values[7]!,
    providerCallCount: values[22]!,
    estimatedUsageCallCount: values[23]!,
    criticContractRetryCount: values[24]!,
    costMicrousd: values[25]!,
    correctionCheckCount: values[27]!,
    correctionCheckPassedCount: values[28]!,
    forbiddenUncorrectedCount: values[29]!,
    adjudicationReasonOrdinal: values[33]!,
    generatorProviderOrdinal: values[34]!,
    generatorModelOrdinal: values[35]!,
    criticProviderOrdinal: values[36]!,
    criticModelOrdinal: values[37]!,
    adjudicatorProviderOrdinal: values[38]!,
    adjudicatorModelOrdinal: values[39]!,
    finalCriticProviderOrdinal: values[40]!,
    finalCriticModelOrdinal: values[41]!,
    acceptedProviderOrdinal: values[42]!,
    acceptedModelOrdinal: values[43]!,
  };
}

async function collectWritingLiveMetrics(
  target: WritingLiveFixture,
  selectedCase: WritingLiveReliabilityCase,
) {
  return parseWritingLiveMetrics(
    await runPrivateLinkedNumericSql(
      writingLiveMetricsSql(target, selectedCase),
      WRITING_LIVE_METRIC_VALUE_COUNT,
      { timeoutMs: PRIVATE_SQL_STATUS_TIMEOUT_MS },
    ),
  );
}

function topicSlugsFromMask(mask: number) {
  return WRITING_LIVE_TOPIC_SLUGS.filter(
    (_slug, index) => Math.floor(mask / 2 ** index) % 2 === 1,
  );
}

function expectedTopicHitCount(
  metrics: WritingLiveMetrics,
  selectedCase: WritingLiveReliabilityCase,
) {
  const observed = new Set(topicSlugsFromMask(metrics.topicMask));
  return selectedCase.expectedTopics.filter((topic) => observed.has(topic))
    .length;
}

function writingLiveQualityPass(
  metrics: WritingLiveMetrics,
  selectedCase: WritingLiveReliabilityCase,
) {
  if (
    metrics.delivery !== "released" ||
    !metrics.originalTextExact ||
    metrics.unclearLineCount !== 0 ||
    metrics.correctionCheckCount !==
      (selectedCase.requiredCorrectionGroups?.length ?? 0) ||
    metrics.correctionCheckPassedCount !== metrics.correctionCheckCount ||
    metrics.forbiddenUncorrectedCount !== 0
  ) {
    return false;
  }
  if (selectedCase.mistakeProfile === "correct") {
    return (
      metrics.wholeTextUnchanged &&
      metrics.issueLineCount === 0 &&
      metrics.correctionSpanCount === 0 &&
      metrics.allLinesUnchanged &&
      metrics.topicRowCount === 0 &&
      metrics.topicOccurrenceCount === 0
    );
  }
  return (
    metrics.issueLineCount > 0 &&
    metrics.correctionSpanCount > 0 &&
    metrics.topicOccurrenceCount > 0 &&
    expectedTopicHitCount(metrics, selectedCase) >=
      (selectedCase.minimumExpectedTopicHits ?? 1)
  );
}

const WRITING_ADJUDICATION_REASONS = [
  "none",
  "critic_approved",
  "final_critic_approved",
  "recovery_critic_approved",
  "generator_not_configured",
  "generator_authentication_failed",
  "generator_not_primary",
  "generator_invalid",
  "critic_not_configured",
  "critic_authentication_failed",
  "critic_invalid",
  "critic_hash_mismatch",
  "critic_disagreed",
  "critic_uncertain",
  "adjudicator_not_configured",
  "adjudicator_authentication_failed",
  "adjudicator_invalid",
  "adjudicator_hash_mismatch",
  "adjudicator_unresolved",
  "final_critic_not_configured",
  "final_critic_authentication_failed",
  "final_critic_invalid",
  "final_critic_hash_mismatch",
  "final_critic_disagreed",
  "final_critic_uncertain",
  "critic_advisory_unavailable",
  "pro_authority_accepted",
  "adjudicator_resolved",
] as const;

function providerPathPart(providerOrdinal: number, modelOrdinal: number) {
  const provider =
    ["none", "deepseek", "gemini", "other"][providerOrdinal] ?? "invalid";
  const model =
    [
      "none",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-3.1-flash-lite",
      "other",
    ][modelOrdinal] ?? "invalid";
  return provider === "none" ? "none" : `${provider}:${model}`;
}

function reportWritingLiveOutcome(
  metrics: WritingLiveMetrics,
  selectedCase: WritingLiveReliabilityCase,
  acknowledgementMs: number,
  terminalFailure?: unknown,
) {
  const reason =
    metrics.delivery === "failed" && terminalFailure instanceof PrivateSqlError
      ? terminalFailure.safeCode
      : (WRITING_ADJUDICATION_REASONS[metrics.adjudicationReasonOrdinal] ??
        "invalid_reason");
  process.stdout.write(
    [
      "WRITING_LIVE_OUTCOME",
      `case=${selectedCase.id}`,
      `delivery=${metrics.delivery}`,
      `reason=${reason}`,
      `ack_ms=${acknowledgementMs}`,
      `terminal_ms=${metrics.terminalMs}`,
      `original_exact=${Number(metrics.originalTextExact)}`,
      `correction_checks=${metrics.correctionCheckPassedCount}/${metrics.correctionCheckCount}`,
      `forbidden_remaining=${metrics.forbiddenUncorrectedCount}`,
      `generator=${providerPathPart(metrics.generatorProviderOrdinal, metrics.generatorModelOrdinal)}`,
      `critic=${providerPathPart(metrics.criticProviderOrdinal, metrics.criticModelOrdinal)}`,
      `adjudicator=${providerPathPart(metrics.adjudicatorProviderOrdinal, metrics.adjudicatorModelOrdinal)}`,
      `final_critic=${providerPathPart(metrics.finalCriticProviderOrdinal, metrics.finalCriticModelOrdinal)}`,
      `accepted=${providerPathPart(metrics.acceptedProviderOrdinal, metrics.acceptedModelOrdinal)}`,
      `durable_retries=${metrics.durableRetryCount}`,
      `critic_retries=${metrics.criticContractRetryCount}`,
      `provider_calls=${metrics.providerCallCount}`,
      `estimated_usage_calls=${metrics.estimatedUsageCallCount}`,
      `cost_microusd=${metrics.costMicrousd}`,
    ].join("|") + "\n",
  );
}

function reportWritingLiveMetrics(
  metrics: WritingLiveMetrics,
  selectedCase: WritingLiveReliabilityCase,
  acknowledgementMs: number,
) {
  const topics = topicSlugsFromMask(metrics.topicMask);
  const expectedHits = expectedTopicHitCount(metrics, selectedCase);
  const rangeMatch =
    metrics.topicOccurrenceCount >= selectedCase.expectedIssueRange[0] &&
    metrics.topicOccurrenceCount <= selectedCase.expectedIssueRange[1];
  const qualityPass = writingLiveQualityPass(metrics, selectedCase);
  process.stdout.write(
    [
      "WRITING_LIVE_METRIC",
      `case=${selectedCase.id}`,
      `level=${selectedCase.level}`,
      `profile=${selectedCase.mistakeProfile}`,
      "delivery=released",
      `ack_ms=${acknowledgementMs}`,
      `terminal_ms=${metrics.terminalMs}`,
      `lines=${metrics.lineCount}`,
      `issue_lines=${metrics.issueLineCount}`,
      `spans=${metrics.correctionSpanCount}`,
      `topic_occurrences=${metrics.topicOccurrenceCount}`,
      `topics=${topics.join(",") || "none"}`,
      `expected_topic_hits=${expectedHits}`,
      `range_match=${Number(rangeMatch)}`,
      `quality_pass=${Number(qualityPass)}`,
      `original_exact=${Number(metrics.originalTextExact)}`,
      `correction_checks=${metrics.correctionCheckPassedCount}/${metrics.correctionCheckCount}`,
      `forbidden_remaining=${metrics.forbiddenUncorrectedCount}`,
      `durable_retries=${metrics.durableRetryCount}`,
      `critic_retries=${metrics.criticContractRetryCount}`,
      `provider_calls=${metrics.providerCallCount}`,
      `estimated_usage_calls=${metrics.estimatedUsageCallCount}`,
      `cost_microusd=${metrics.costMicrousd}`,
    ].join("|") + "\n",
  );
}

function cleanupFixtureSql(target: WritingLiveFixture) {
  const expectedSubmissionId = target.submissionId
    ? sqlUuid(target.submissionId)
    : "null::uuid";
  return `
create temp table writing_live_cleanup_anomalies (
  reason text primary key
);

begin;
do $writing_live_cleanup_lock_workspace$
begin
  perform workspace.id
  from public.workspaces workspace
  where workspace.id = ${sqlUuid(target.workspaceId)}
  for update;
end;
$writing_live_cleanup_lock_workspace$;

create temp table writing_live_fixture_submission_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.writing_live_fixture_submission_ids (id)
select submission.id
from public.submissions submission
where submission.workspace_id = ${sqlUuid(target.workspaceId)};

do $writing_live_cleanup_lock_entities$
begin
  perform submission.id
  from public.submissions submission
  where submission.id in (
    select id from pg_temp.writing_live_fixture_submission_ids
  )
  order by submission.id
  for update;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        'paid-job-entity',
        'writing_evaluation',
        fixture_submission.id
      ),
      0
    )
  )
  from pg_temp.writing_live_fixture_submission_ids fixture_submission
  order by fixture_submission.id;
end;
$writing_live_cleanup_lock_entities$;

create temp table writing_live_fixture_job_ids (
  id uuid primary key,
  entity_id uuid not null,
  entity_version integer not null,
  queue_message_id bigint,
  status text not null
) on commit drop;
insert into pg_temp.writing_live_fixture_job_ids (
  id,
  entity_id,
  entity_version,
  queue_message_id,
  status
)
select
  job.id,
  job.entity_id,
  job.entity_version,
  job.queue_message_id,
  job.status
from app_private.async_jobs job
where job.entity_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);

create temp table writing_live_fixture_cycle_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.writing_live_fixture_cycle_ids (id)
select cycle.id
from app_private.practice_resolution_cycles cycle
where cycle.workspace_id = ${sqlUuid(target.workspaceId)};

do $writing_live_scope_guard$
declare
  expected_submission_id uuid := ${expectedSubmissionId};
  fixture_workspace_exists boolean := exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
  );
begin
  if not fixture_workspace_exists then
    if exists (
      select 1 from public.batches batch
      where batch.id = ${sqlUuid(target.batchId)}
    ) or exists (
      select 1 from public.batch_students assignment
      where assignment.id = ${sqlUuid(target.batchStudentId)}
    ) or exists (
      select 1 from public.workspace_members membership
      where membership.id in (
        ${sqlUuid(target.teacherMembershipId)},
        ${sqlUuid(target.studentMembershipId)}
      )
    ) or exists (
      select 1 from pg_temp.writing_live_fixture_submission_ids
    ) then
      raise exception using message = 'writing_live_fixture_identity_mismatch';
    end if;
    return;
  end if;

  if not exists (
    select 1
    from public.workspaces workspace
    join public.batches batch
      on batch.workspace_id = workspace.id
    join public.batch_students assignment
      on assignment.batch_id = batch.id
     and assignment.workspace_id = workspace.id
    where workspace.id = ${sqlUuid(target.workspaceId)}
      and workspace.name = ${sqlLiteral(target.workspaceName)}
      and workspace.slug = ${sqlLiteral(target.workspaceSlug)}
      and batch.id = ${sqlUuid(target.batchId)}
      and batch.name = ${sqlLiteral(target.batchName)}
      and batch.feedback_mode = 'immediate'
      and batch.is_active
      and assignment.id = ${sqlUuid(target.batchStudentId)}
  ) then
    raise exception using message = 'writing_live_fixture_identity_mismatch';
  end if;

  if (
    select count(*) from pg_temp.writing_live_fixture_submission_ids
  ) > 1 then
    raise exception using message = 'unexpected_submission_count';
  end if;

  if exists (
    select 1
    from public.submissions submission
    where submission.id in (
      select id from pg_temp.writing_live_fixture_submission_ids
    )
      and (
        submission.batch_id is distinct from ${sqlUuid(target.batchId)}
        or not exists (
          select 1
          from public.batch_students assignment
          where assignment.id = ${sqlUuid(target.batchStudentId)}
            and assignment.batch_id = submission.batch_id
            and assignment.workspace_id = submission.workspace_id
            and assignment.student_id = submission.student_id
        )
      )
  ) then
    raise exception using message = 'unexpected_submission_scope';
  end if;

  if expected_submission_id is not null and not exists (
    select 1 from pg_temp.writing_live_fixture_submission_ids fixture_submission
    where fixture_submission.id = expected_submission_id
  ) then
    raise exception using message = 'expected_submission_missing';
  end if;

  if exists (
    select 1
    from app_private.async_jobs job
    where job.id in (select id from pg_temp.writing_live_fixture_job_ids)
      and (
        job.job_kind <> 'writing_evaluation'
        or job.queue_name <> 'writing_evaluation'
      )
  ) then
    raise exception using message = 'unexpected_job_scope';
  end if;

  if exists (
    select 1
    from pg_temp.writing_live_fixture_job_ids fixture_job
    where fixture_job.status in ('queued', 'processing', 'retry')
  ) then
    raise exception using message = 'writing_live_fixture_job_not_terminal';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.job_id in (
      select id from pg_temp.writing_live_fixture_job_ids
    )
      and reservation.state = 'reserved'
  ) then
    raise exception using message = 'writing_live_fixture_spend_not_settled';
  end if;

  if exists (
    select 1
    from (
      select live.msg_id, live.message
      from pgmq.q_writing_evaluation live
      union all
      select archived.msg_id, archived.message
      from pgmq.a_writing_evaluation archived
    ) queued
    where (
      queued.msg_id in (
        select queue_message_id
        from pg_temp.writing_live_fixture_job_ids
        where queue_message_id is not null
      )
      or queued.message ->> 'job_id' in (
        select id::text from pg_temp.writing_live_fixture_job_ids
      )
      or queued.message ->> 'entity_id' in (
        select id::text from pg_temp.writing_live_fixture_submission_ids
      )
    )
      and not exists (
        select 1
        from pg_temp.writing_live_fixture_job_ids fixture_job
        where queued.message ->> 'job_id' = fixture_job.id::text
          and queued.message ->> 'entity_id' = fixture_job.entity_id::text
          and queued.message ->> 'job_kind' = 'writing_evaluation'
          and queued.message ->> 'entity_version' =
            fixture_job.entity_version::text
      )
  ) then
    raise exception using message = 'writing_live_queue_scope_mismatch';
  end if;
end;
$writing_live_scope_guard$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $writing_live_spend_archive$
begin
  if exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
  ) then
    perform *
    from api.archive_writing_live_canary_spend(
      ${sqlUuid(target.workspaceId)},
      ${sqlLiteral(target.workspaceSlug)},
      ${sqlUuid(target.batchId)}
    );
  end if;
end;
$writing_live_spend_archive$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

set local session_replication_role = replica;

delete from pgmq.q_writing_evaluation queue
using pg_temp.writing_live_fixture_job_ids fixture_job
where queue.message ->> 'job_id' = fixture_job.id::text
  and queue.message ->> 'entity_id' = fixture_job.entity_id::text
  and queue.message ->> 'job_kind' = 'writing_evaluation'
  and queue.message ->> 'entity_version' = fixture_job.entity_version::text;
delete from pgmq.a_writing_evaluation archive
using pg_temp.writing_live_fixture_job_ids fixture_job
where archive.message ->> 'job_id' = fixture_job.id::text
  and archive.message ->> 'entity_id' = fixture_job.entity_id::text
  and archive.message ->> 'job_kind' = 'writing_evaluation'
  and archive.message ->> 'entity_version' = fixture_job.entity_version::text;

delete from app_private.provider_outage_recovery_events event
where event.job_id in (select id from pg_temp.writing_live_fixture_job_ids)
   or event.predecessor_job_id in (
     select id from pg_temp.writing_live_fixture_job_ids
   );
delete from app_private.writing_feedback_adjudications_v2 evidence
where evidence.job_id in (select id from pg_temp.writing_live_fixture_job_ids)
   or evidence.submission_id in (
     select id from pg_temp.writing_live_fixture_submission_ids
   );
delete from app_private.writing_feedback_adjudications evidence
where evidence.job_id in (select id from pg_temp.writing_live_fixture_job_ids)
   or evidence.submission_id in (
     select id from pg_temp.writing_live_fixture_submission_ids
   );
delete from app_private.feedback_draft_events event
where event.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from app_private.practice_resolution_cycle_events event
where event.cycle_id in (select id from pg_temp.writing_live_fixture_cycle_ids);
delete from app_private.practice_weakness_evidence evidence
where evidence.workspace_id = ${sqlUuid(target.workspaceId)}
   or evidence.submission_id in (
     select id from pg_temp.writing_live_fixture_submission_ids
   );
delete from public.student_practice_assignments assignment
where assignment.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.practice_resolution_cycles cycle
where cycle.id in (select id from pg_temp.writing_live_fixture_cycle_ids);
delete from public.student_grammar_stats grammar_stat
where grammar_stat.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.writing_evaluation_context_holds context_hold
where context_hold.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from app_private.writing_evaluation_contexts context
where context.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from app_private.feedback_drafts draft
where draft.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from api.submission_status_events status_event
where status_event.id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from public.submission_lines line
where line.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from public.submission_grammar_topics topic
where topic.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from public.teacher_notes note
where note.submission_id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from app_private.async_jobs job
where job.id in (select id from pg_temp.writing_live_fixture_job_ids)
   or job.entity_id in (
     select id from pg_temp.writing_live_fixture_submission_ids
   );
delete from public.submissions submission
where submission.id in (
  select id from pg_temp.writing_live_fixture_submission_ids
);
delete from app_private.writing_drafts draft
where draft.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.writing_submission_daily_usage usage
where usage.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.writing_submission_monthly_usage usage
where usage.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.ai_student_daily_usage usage
where usage.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.ai_student_monthly_usage usage
where usage.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.ai_workspace_daily_usage usage
where usage.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.ai_workspace_monthly_budgets budget
where budget.workspace_id = ${sqlUuid(target.workspaceId)};
delete from public.usage_events usage_event
where usage_event.workspace_id = ${sqlUuid(target.workspaceId)};

do $writing_live_workspace_cleanup$
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
    using ${sqlUuid(target.workspaceId)};
  end loop;
end;
$writing_live_workspace_cleanup$;

delete from public.batch_students assignment
where assignment.id = ${sqlUuid(target.batchStudentId)}
   or assignment.batch_id = ${sqlUuid(target.batchId)};
delete from public.batches batch
where batch.id = ${sqlUuid(target.batchId)};
delete from public.workspace_members membership
where membership.workspace_id = ${sqlUuid(target.workspaceId)};
delete from public.workspaces workspace
where workspace.id = ${sqlUuid(target.workspaceId)};

set local session_replication_role = origin;

do $writing_live_residue_guard$
declare
  relation_name text;
  residue_exists boolean;
begin
  if exists (
    select 1
    from pgmq.q_writing_evaluation queue
    join pg_temp.writing_live_fixture_job_ids fixture_job
      on queue.message ->> 'job_id' = fixture_job.id::text
     and queue.message ->> 'entity_id' = fixture_job.entity_id::text
  ) or exists (
    select 1
    from pgmq.a_writing_evaluation archive
    join pg_temp.writing_live_fixture_job_ids fixture_job
      on archive.message ->> 'job_id' = fixture_job.id::text
     and archive.message ->> 'entity_id' = fixture_job.entity_id::text
  ) or exists (
    select 1 from app_private.async_jobs job
    where job.id in (select id from pg_temp.writing_live_fixture_job_ids)
       or job.entity_id in (
         select id from pg_temp.writing_live_fixture_submission_ids
       )
  ) or exists (
    select 1 from public.submissions submission
    where submission.id in (
      select id from pg_temp.writing_live_fixture_submission_ids
    )
  ) or exists (
    select 1 from public.batches batch
    where batch.id = ${sqlUuid(target.batchId)}
  ) or exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
  ) then
    insert into pg_temp.writing_live_cleanup_anomalies (reason)
    values ('direct_residue') on conflict do nothing;
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
    ) into residue_exists using ${sqlUuid(target.workspaceId)};
    if residue_exists then
      insert into pg_temp.writing_live_cleanup_anomalies (reason)
      values ('workspace_residue') on conflict do nothing;
    end if;
  end loop;
end;
$writing_live_residue_guard$;
commit;

do $writing_live_cleanup_report$
begin
  if exists (select 1 from pg_temp.writing_live_cleanup_anomalies) then
    raise exception using message = 'writing_live_fixture_scope_or_cleanup_failed';
  end if;
end;
$writing_live_cleanup_report$;
`;
}

async function recoverPreviousWritingLiveFixture() {
  const path = recoveryManifestPath();
  const manifest = await readWritingLiveRecoveryManifest(
    path,
    PINNED_STAGING_PROJECT_REF,
  );
  if (!manifest) return;

  const previousFixture = fixtureFromRecoveryManifest(manifest);
  try {
    runPrivateLinkedSql(
      "Prior live-writing fixture recovery",
      cleanupFixtureSql(previousFixture),
    );
  } catch (error) {
    const safeCode =
      error instanceof PrivateSqlError
        ? error.safeCode
        : "writing_live_fixture_recovery_failed";
    throw new Error(
      `A prior live-writing fixture is still active or its exact scope could not be verified (${safeCode}). The private recovery manifest was retained; retry recovery after the worker and spend reservations are terminal.`,
    );
  }
  await removeWritingLiveRecoveryManifest(path, PINNED_STAGING_PROJECT_REF);
}

async function signInStudent(page: Page, account: Credentials) {
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();

  const loginOutcome = async () => {
    const pathname = new URL(page.url()).pathname;
    if (pathname === "/student/dashboard") return "student";
    if (
      pathname === "/teacher/dashboard" ||
      pathname === "/teacher/onboarding"
    ) {
      return "teacher";
    }
    const alert = page.getByRole("alert");
    if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
      return "login_error";
    }
    return "pending";
  };

  await expect.poll(loginOutcome, { timeout: 15_000 }).not.toBe("pending");
  const outcome = await loginOutcome();
  if (outcome === "login_error") {
    throw new Error(
      "The configured staging student login was rejected; no writing was submitted.",
    );
  }
  if (outcome !== "student") {
    throw new Error(
      "The configured writing student opened a teacher shell; no writing was submitted.",
    );
  }
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectFixtureWorkspace(page: Page, target: WritingLiveFixture) {
  await page.goto("/student/dashboard");
  const selector = visibleWorkspaceSelector(page);
  await expect(selector).toHaveCount(1, { timeout: 15_000 });
  await selector.click();
  const exactFixtureMembership = page.getByRole("option", {
    name: `${target.workspaceName} · student`,
    exact: true,
  });
  await expect(exactFixtureMembership).toHaveCount(1);
  await exactFixtureMembership.click();
  await expect(selector).toContainText(target.workspaceName);
}

async function openExactFixtureWriting(page: Page, target: WritingLiveFixture) {
  await page.goto("/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  await expect(classSelector).toBeVisible({ timeout: 15_000 });
  await expect(classSelector).toBeEnabled({ timeout: 15_000 });
  await classSelector.click();
  const exactFixtureClass = page.getByRole("option", {
    name: `${target.batchName} · ${target.level}`,
    exact: true,
  });
  await expect(exactFixtureClass).toHaveCount(1);
  await exactFixtureClass.click();
  await expect(classSelector).toContainText(target.batchName);
  await expect(page.getByTestId("writing-draft-status")).toContainText(
    "Draft ready",
    { timeout: 15_000 },
  );
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

test.skip(
  process.env.E2E_LIVE_WRITING !== "true" && !recoveryOnly,
  "Set E2E_LIVE_WRITING=true for a provider run or E2E_LIVE_WRITING_RECOVERY_ONLY=true for exact recovery.",
);

test.describe.serial("isolated immediate-mode writing provider smoke", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    expect(WRITING_LIVE_RELIABILITY_CORPUS).toHaveLength(20);
    await recoverPreviousWritingLiveFixture();
    if (recoveryOnly) return;

    const accounts = resolveAccountSlots();
    studentAccount = accounts.student;
    fixture = newWritingLiveFixture(SELECTED_WRITING_CASE.level);
    await createWritingLiveRecoveryManifest(
      recoveryManifestPath(),
      recoveryManifestFor(fixture),
      PINNED_STAGING_PROJECT_REF,
    );
    try {
      runPrivateLinkedSql(
        "Live writing fixture setup",
        createFixtureSql(fixture, accounts.teacher, accounts.student),
      );
    } catch (error) {
      await recoverPreviousWritingLiveFixture();
      const safeCode =
        error instanceof PrivateSqlError
          ? error.safeCode
          : "writing_live_fixture_setup_failed";
      throw new Error(
        `Live-writing fixture setup failed (${safeCode}); exact database absence was verified and the private recovery manifest was removed.`,
      );
    }
    fixtureInstalled = true;
    try {
      await assertWritingLiveCapacity(fixture, accounts.student);
    } catch (capacityFailure) {
      try {
        runPrivateLinkedSql(
          "Live writing capacity-preflight cleanup",
          cleanupFixtureSql(fixture),
        );
        await removeWritingLiveRecoveryManifest(
          recoveryManifestPath(),
          PINNED_STAGING_PROJECT_REF,
        );
        fixtureInstalled = false;
      } catch (cleanupFailure) {
        throw new AggregateError(
          [capacityFailure, cleanupFailure],
          "Live-writing capacity preflight and exact cleanup failed safely.",
        );
      }
      throw capacityFailure;
    }
  });

  test.afterAll(async () => {
    if (!fixtureInstalled || !fixture) return;
    runPrivateLinkedSql(
      "Live writing exact cleanup",
      cleanupFixtureSql(fixture),
    );
    await removeWritingLiveRecoveryManifest(
      recoveryManifestPath(),
      PINNED_STAGING_PROJECT_REF,
    );
  });

  test("student autosaves, reloads, submits, and receives validated feedback only in the exact fixture class", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    test.skip(
      recoveryOnly,
      "The prior fixture was recovered without a new provider call.",
    );
    if (!fixture || !studentAccount) {
      throw new Error("The live writing fixture was not prepared.");
    }
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    let suppressedImmediateKicks = 0;
    let recoveryHeartbeatBeforeSubmit: number | null = null;
    let workflowFailure: unknown;
    try {
      if (externalRecoveryCanary) {
        await page.route("**/functions/v1/kick-writing-jobs", async (route) => {
          suppressedImmediateKicks += 1;
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: '{"accepted":true}',
          });
        });
      }
      await signInStudent(page, studentAccount);
      await selectFixtureWorkspace(page, fixture);
      await openExactFixtureWriting(page, fixture);

      const writing = page.getByLabel("Your Text");
      await expect(writing).toBeEnabled({ timeout: 15_000 });
      await writing.fill(SELECTED_WRITING_CASE.text);
      await expect(page.getByTestId("writing-draft-status")).toContainText(
        "Saved",
        { timeout: 20_000 },
      );
      await expect
        .poll(() => {
          const draftId = new URL(page.url()).searchParams.get("draft") ?? "";
          return UUID_PATTERN.test(draftId);
        })
        .toBe(true);

      await page.reload();
      await expect
        .poll(
          async () =>
            (await writing.inputValue()) === SELECTED_WRITING_CASE.text,
          {
            timeout: 15_000,
          },
        )
        .toBe(true);
      await expect(page.getByTestId("writing-draft-status")).toContainText(
        "Saved",
      );

      if (externalRecoveryCanary) {
        recoveryHeartbeatBeforeSubmit = await latestRecoveryHeartbeatEpoch();
      }
      const acknowledgementStartedAt = Date.now();
      await page.getByRole("button", { name: "Submit Writing" }).click();
      await expect(
        page.getByRole("heading", { name: "Writing submitted safely." }),
      ).toBeVisible({ timeout: 15_000 });
      const acknowledgementMs = Date.now() - acknowledgementStartedAt;
      expect(acknowledgementMs).toBeLessThan(15_000);
      if (externalRecoveryCanary) {
        await expect
          .poll(() => suppressedImmediateKicks, { timeout: 15_000 })
          .toBe(1);
      }

      await page
        .getByRole("button", { name: /View (?:Submission|Feedback)/ })
        .click();
      await expect
        .poll(() => {
          const match = new URL(page.url()).pathname.match(
            /^\/student\/submission\/([0-9a-f-]{36})$/i,
          );
          if (!match || !UUID_PATTERN.test(match[1] ?? "")) return false;
          fixture!.submissionId = match[1]!;
          return true;
        })
        .toBe(true);
      await replaceWritingLiveRecoveryManifest(
        recoveryManifestPath(),
        recoveryManifestFor(fixture),
        PINNED_STAGING_PROJECT_REF,
      );
      let feedbackWaitFailure: unknown;
      try {
        await waitForValidatedWritingFeedback(page, fixture);
      } catch (error) {
        feedbackWaitFailure = error;
      }
      if (feedbackWaitFailure === undefined) {
        await assertWritingLiveTerminalProof(fixture);
      }
      if (
        feedbackWaitFailure === undefined &&
        externalRecoveryCanary &&
        recoveryHeartbeatBeforeSubmit !== null
      ) {
        await expect
          .poll(() => latestRecoveryHeartbeatEpoch(), {
            timeout: 90_000,
            intervals: [1_000, 2_000, 3_000],
          })
          .toBeGreaterThan(recoveryHeartbeatBeforeSubmit);
        expect(suppressedImmediateKicks).toBe(1);
      }
      const metrics = await collectWritingLiveMetrics(
        fixture,
        SELECTED_WRITING_CASE,
      );
      reportWritingLiveOutcome(
        metrics,
        SELECTED_WRITING_CASE,
        acknowledgementMs,
        feedbackWaitFailure,
      );
      if (feedbackWaitFailure !== undefined) throw feedbackWaitFailure;
      reportWritingLiveMetrics(
        metrics,
        SELECTED_WRITING_CASE,
        acknowledgementMs,
      );
      expect(
        writingLiveQualityPass(metrics, SELECTED_WRITING_CASE),
        `Closed quality checks failed for ${SELECTED_WRITING_CASE.id}.`,
      ).toBe(true);
      await expect(
        page.getByRole("tab", { name: "Line-by-line" }),
      ).toBeVisible();
    } catch (error) {
      workflowFailure = error;
    } finally {
      try {
        assertNoFatalFailures();
      } catch (browserFailure) {
        if (workflowFailure !== undefined) {
          throw new AggregateError(
            [workflowFailure, browserFailure],
            "Live-writing workflow and browser checks failed safely.",
          );
        }
        throw browserFailure;
      }
    }
    if (workflowFailure !== undefined) throw workflowFailure;
  });
});
