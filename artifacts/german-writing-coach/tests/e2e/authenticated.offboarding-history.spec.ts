import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";

type Credentials = { email: string; password: string };
type AppRole = "teacher" | "student";

interface TrustedMembership {
  membership_id: string;
  workspace_id: string;
  role: "owner" | "teacher" | "student";
}

interface SignedInAccount {
  context: BrowserContext;
  page: Page;
  account: Credentials;
  userId: string;
  role: AppRole;
  activeWorkspaceId: string | null;
}

interface HistoryFixture {
  submissionId: string;
  workspaceId: string;
  teacherId: string;
  studentId: string;
  className: string;
  originalText: string;
}

interface ExactAssignmentFixture extends HistoryFixture {
  assignmentId: string;
  membershipId: string;
  membershipFingerprint: string;
}

interface RelationshipSnapshot {
  membership: {
    id: string;
    workspace_id: string;
    user_id: string;
    role: string;
    created_at: string;
    row_fingerprint: string;
  } | null;
  assignments: Array<{
    id: string;
    workspace_id: string;
    batch_id: string;
    student_id: string;
    created_at: string;
    batch_name: string;
    batch_is_active: boolean;
    row_fingerprint: string;
  }>;
  join_requests: Array<{
    id: string;
    workspace_id: string;
    batch_id: string;
    student_id: string;
    status: string;
    requested_at: string;
    decided_at: string | null;
    decided_by: string | null;
    row_fingerprint: string;
  }>;
}

const CLASS_LEVEL = "A1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the OPS-020 staging workflow.`);
  }
  return value;
}

function configuredAccounts(): Credentials[] {
  return ["TEACHER", "STUDENT"].map((slot) => ({
    email: requiredEnvironment(`E2E_${slot}_EMAIL`),
    password: requiredEnvironment(`E2E_${slot}_PASSWORD`),
  }));
}

function requireUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`The ${label} was not a valid UUID.`);
  }
  return value;
}

function requireFingerprint(value: string, label: string) {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error(`The ${label} was not a valid row fingerprint.`);
  }
  return value;
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureSqlValues(input: HistoryFixture) {
  return {
    submissionId: sqlLiteral(requireUuid(input.submissionId, "submission id")),
    workspaceId: sqlLiteral(requireUuid(input.workspaceId, "workspace id")),
    teacherId: sqlLiteral(requireUuid(input.teacherId, "teacher id")),
    studentId: sqlLiteral(requireUuid(input.studentId, "student id")),
    className: sqlLiteral(input.className),
    originalText: sqlLiteral(input.originalText),
  };
}

async function runLinkedFixtureSql(sql: string, operation: string) {
  const executable = process.env.SUPABASE_BIN?.trim() || "supabase";
  const repositoryRoot = resolve(process.cwd(), "../..");
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, ["db", "query", "--linked"], {
      cwd: repositoryRoot,
      env: process.env,
      // Keep fixture SQL and all credentials out of process arguments and
      // retained Playwright output. Only the CLI process receives SQL on stdin.
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectRun(error);
      else resolveRun();
    };
    child.once("error", () => {
      settle(new Error(`The ${operation} fixture command could not start.`));
    });
    child.once("close", (code) => {
      if (code === 0) settle();
      else {
        settle(
          new Error(
            `The ${operation} fixture failed with exit code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
    child.stdin.once("error", () => {
      settle(new Error(`The ${operation} fixture input failed.`));
    });
    child.stdin.end(sql);
  });
}

async function runLinkedSnapshotQuery(sql: string) {
  const executable = process.env.SUPABASE_BIN?.trim() || "supabase";
  const repositoryRoot = resolve(process.cwd(), "../..");
  return new Promise<unknown>((resolveRun, rejectRun) => {
    const child = spawn(executable, ["db", "query", "--linked"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const rejectSafely = () => {
      if (settled) return;
      settled = true;
      rejectRun(new Error("The OPS-020 relationship snapshot failed."));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1_000_000) rejectSafely();
    });
    child.once("error", rejectSafely);
    child.stdin.once("error", rejectSafely);
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        rejectSafely();
        return;
      }
      try {
        const jsonStart = output.indexOf("{");
        const envelope = JSON.parse(output.slice(jsonStart)) as {
          rows?: Array<{ relationship_snapshot?: unknown }>;
        };
        const snapshot = envelope.rows?.[0]?.relationship_snapshot;
        if (!snapshot) throw new Error("missing snapshot");
        settled = true;
        resolveRun(snapshot);
      } catch {
        rejectSafely();
      }
    });
    child.stdin.end(sql);
  });
}

function normalizeRelationshipSnapshot(value: unknown): RelationshipSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("The OPS-020 relationship snapshot was malformed.");
  }
  const snapshot = value as Partial<RelationshipSnapshot>;
  if (
    !Array.isArray(snapshot.assignments) ||
    !Array.isArray(snapshot.join_requests) ||
    (snapshot.membership !== null &&
      (typeof snapshot.membership !== "object" ||
        !UUID_PATTERN.test(snapshot.membership.id ?? "") ||
        snapshot.membership.role !== "student" ||
        !/^[0-9a-f]{32}$/.test(snapshot.membership.row_fingerprint ?? "")))
  ) {
    throw new Error("The OPS-020 relationship snapshot was malformed.");
  }
  for (const assignment of snapshot.assignments) {
    if (
      !assignment ||
      !UUID_PATTERN.test(assignment.id ?? "") ||
      !UUID_PATTERN.test(assignment.batch_id ?? "") ||
      typeof assignment.batch_name !== "string" ||
      typeof assignment.batch_is_active !== "boolean" ||
      !/^[0-9a-f]{32}$/.test(assignment.row_fingerprint ?? "")
    ) {
      throw new Error("The OPS-020 assignment snapshot was malformed.");
    }
  }
  for (const request of snapshot.join_requests) {
    if (
      !request ||
      !UUID_PATTERN.test(request.id ?? "") ||
      !UUID_PATTERN.test(request.batch_id ?? "") ||
      typeof request.status !== "string" ||
      !/^[0-9a-f]{32}$/.test(request.row_fingerprint ?? "")
    ) {
      throw new Error("The OPS-020 request snapshot was malformed.");
    }
  }
  return snapshot as RelationshipSnapshot;
}

async function readRelationshipSnapshot(input: {
  workspaceId: string;
  studentId: string;
  excludedClassName: string;
}) {
  const workspaceId = sqlLiteral(
    requireUuid(input.workspaceId, "workspace id"),
  );
  const studentId = sqlLiteral(requireUuid(input.studentId, "student id"));
  const excludedClassName = sqlLiteral(input.excludedClassName);
  const value = await runLinkedSnapshotQuery(`
    select jsonb_build_object(
      'membership', (
        select jsonb_build_object(
          'id', member.id,
          'workspace_id', member.workspace_id,
          'user_id', member.user_id,
          'role', member.role,
          'created_at', member.created_at,
          'row_fingerprint', md5(to_jsonb(member)::text)
        )
        from public.workspace_members member
        where member.workspace_id = ${workspaceId}::uuid
          and member.user_id = ${studentId}::uuid
      ),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', assignment.id,
          'workspace_id', assignment.workspace_id,
          'batch_id', assignment.batch_id,
          'student_id', assignment.student_id,
          'created_at', assignment.created_at,
          'batch_name', batch.name,
          'batch_is_active', batch.is_active,
          'row_fingerprint', md5(to_jsonb(assignment)::text)
        ) order by assignment.id)
        from public.batch_students assignment
        join public.batches batch on batch.id = assignment.batch_id
        where assignment.workspace_id = ${workspaceId}::uuid
          and assignment.student_id = ${studentId}::uuid
          and batch.name <> ${excludedClassName}
      ), '[]'::jsonb),
      'join_requests', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', request.id,
          'workspace_id', request.workspace_id,
          'batch_id', request.batch_id,
          'student_id', request.student_id,
          'status', request.status,
          'requested_at', request.requested_at,
          'decided_at', request.decided_at,
          'decided_by', request.decided_by,
          'row_fingerprint', md5(to_jsonb(request)::text)
        ) order by request.id)
        from public.batch_join_requests request
        join public.batches batch on batch.id = request.batch_id
        where request.workspace_id = ${workspaceId}::uuid
          and request.student_id = ${studentId}::uuid
          and batch.name <> ${excludedClassName}
      ), '[]'::jsonb)
    ) as relationship_snapshot;
  `);
  return normalizeRelationshipSnapshot(value);
}

async function installExactFixtureAssignment(input: ExactAssignmentFixture) {
  const value = fixtureSqlValues(input);
  const assignmentId = sqlLiteral(
    requireUuid(input.assignmentId, "assignment id"),
  );
  const membershipId = sqlLiteral(
    requireUuid(input.membershipId, "membership id"),
  );
  const membershipFingerprint = sqlLiteral(
    requireFingerprint(input.membershipFingerprint, "membership fingerprint"),
  );
  await runLinkedFixtureSql(
    `do $ops_020_assignment$
declare
  target_batch public.batches%rowtype;
begin
  if (
    select count(*) from public.batches batch
    where batch.workspace_id = ${value.workspaceId}::uuid
      and batch.created_by = ${value.teacherId}::uuid
      and batch.name = ${value.className}
  ) <> 1 then
    raise exception using message = 'ops_020_class_not_unique';
  end if;

  select batch.* into target_batch
  from public.batches batch
  where batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className};

  if not target_batch.is_active
    or not exists (
      select 1 from public.workspace_members member
      where member.workspace_id = target_batch.workspace_id
        and member.user_id = ${value.teacherId}::uuid
        and member.role in ('owner', 'teacher')
    )
  then
    raise exception using message = 'ops_020_teacher_not_authorized';
  end if;

  if (
    select count(*) from public.workspace_members member
    where member.id = ${membershipId}::uuid
      and member.workspace_id = target_batch.workspace_id
      and member.user_id = ${value.studentId}::uuid
      and member.role = 'student'
      and md5(to_jsonb(member)::text) = ${membershipFingerprint}
  ) <> 1 then
    raise exception using message = 'ops_020_snapshotted_membership_changed';
  end if;

  if exists (
    select 1 from public.batch_students assignment
    where assignment.batch_id = target_batch.id
  ) or exists (
    select 1 from public.batch_join_requests request
    where request.batch_id = target_batch.id
  ) then
    raise exception using message = 'ops_020_fixture_class_not_empty';
  end if;

  insert into public.batch_students (
    id, workspace_id, batch_id, student_id, created_at
  ) values (
    ${assignmentId}::uuid, target_batch.workspace_id, target_batch.id,
    ${value.studentId}::uuid, clock_timestamp()
  );

  if (
    select count(*) from public.batch_students assignment
    where assignment.id = ${assignmentId}::uuid
      and assignment.workspace_id = target_batch.workspace_id
      and assignment.batch_id = target_batch.id
      and assignment.student_id = ${value.studentId}::uuid
  ) <> 1 or (
    select count(*) from public.batch_students assignment
    where assignment.batch_id = target_batch.id
  ) <> 1 then
    raise exception using message = 'ops_020_fixture_assignment_not_exact';
  end if;
end;
$ops_020_assignment$;
select 'ready' as ops_020_assignment_state;`,
    "OPS-020 exact assignment setup",
  );
}

async function installHistoryFixture(input: HistoryFixture) {
  const value = fixtureSqlValues(input);
  await runLinkedFixtureSql(
    `do $ops_020_fixture$
declare
  target_batch public.batches%rowtype;
begin
  if (
    select count(*) from public.batches batch
    where batch.workspace_id = ${value.workspaceId}::uuid
      and batch.created_by = ${value.teacherId}::uuid
      and batch.name = ${value.className}
  ) <> 1 then
    raise exception using message = 'ops_020_class_not_unique';
  end if;

  select batch.* into target_batch
  from public.batches batch
  where batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className};

  if not target_batch.is_active
    or not exists (
      select 1 from public.workspace_members member
      where member.workspace_id = target_batch.workspace_id
        and member.user_id = ${value.teacherId}::uuid
        and member.role in ('owner', 'teacher')
    )
    or not exists (
      select 1 from public.workspace_members member
      where member.workspace_id = target_batch.workspace_id
        and member.user_id = ${value.studentId}::uuid
        and member.role = 'student'
    )
    or not exists (
      select 1 from public.batch_students assignment
      where assignment.workspace_id = target_batch.workspace_id
        and assignment.batch_id = target_batch.id
        and assignment.student_id = ${value.studentId}::uuid
    )
  then
    raise exception using message = 'ops_020_enrollment_missing';
  end if;

  if exists (
    select 1 from public.submissions submission
    where submission.id = ${value.submissionId}::uuid
      or submission.original_text = ${value.originalText}
  ) then
    raise exception using message = 'ops_020_submission_collision';
  end if;

  insert into public.submissions (
    id, workspace_id, student_id, batch_id, question_source, mode,
    original_text, status, evaluation_status, release_status, feedback_mode,
    feedback_error, created_at, updated_at
  ) values (
    ${value.submissionId}::uuid, target_batch.workspace_id,
    ${value.studentId}::uuid, target_batch.id, 'free_text', 'free_text',
    ${value.originalText}, 'failed', 'failed', 'held', 'teacher_review_only',
    'ops_020_non_ai_fixture', clock_timestamp(), clock_timestamp()
  );

  if exists (
    select 1 from app_private.async_jobs job
    where job.entity_id = ${value.submissionId}::uuid
  ) then
    raise exception using message = 'ops_020_unexpected_ai_job';
  end if;
end;
$ops_020_fixture$;
select 'ready' as ops_020_fixture_state;`,
    "OPS-020 history setup",
  );
}

async function assertPreservedOffboardingState(
  input: HistoryFixture,
  fullOffboard: boolean,
) {
  const value = fixtureSqlValues(input);
  const fullOffboardSql = fullOffboard ? "true" : "false";
  await runLinkedFixtureSql(
    `do $ops_020_verify$
declare
  target_batch_id uuid;
  expected_full_offboard boolean := ${fullOffboardSql};
begin
  select batch.id into strict target_batch_id
  from public.batches batch
  where batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className}
    and not batch.is_active;

  if not exists (
    select 1 from public.submissions submission
    where submission.id = ${value.submissionId}::uuid
      and submission.workspace_id = ${value.workspaceId}::uuid
      and submission.student_id = ${value.studentId}::uuid
      and submission.batch_id = target_batch_id
      and submission.original_text = ${value.originalText}
      and submission.status = 'failed'
      and submission.evaluation_status = 'failed'
      and submission.release_status = 'held'
  ) then
    raise exception using message = 'ops_020_history_not_preserved';
  end if;

  if exists (
    select 1 from public.batch_students assignment
    where assignment.workspace_id = ${value.workspaceId}::uuid
      and assignment.batch_id = target_batch_id
      and assignment.student_id = ${value.studentId}::uuid
  ) then
    raise exception using message = 'ops_020_fixture_assignment_remains';
  end if;

  if expected_full_offboard then
    if exists (
      select 1 from public.workspace_members member
      where member.workspace_id = ${value.workspaceId}::uuid
        and member.user_id = ${value.studentId}::uuid
    ) or (
      select count(*) from public.batch_join_requests request
      where request.workspace_id = ${value.workspaceId}::uuid
        and request.batch_id = target_batch_id
        and request.student_id = ${value.studentId}::uuid
        and request.status = 'cancelled'
    ) <> 1 then
      raise exception using message = 'ops_020_full_offboard_incomplete';
    end if;
  elsif not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = ${value.workspaceId}::uuid
      and member.user_id = ${value.studentId}::uuid
      and member.role = 'student'
  ) then
    raise exception using message = 'ops_020_preexisting_membership_lost';
  end if;

  if exists (
    select 1 from app_private.async_jobs job
    where job.entity_id = ${value.submissionId}::uuid
  ) then
    raise exception using message = 'ops_020_unexpected_ai_job';
  end if;
end;
$ops_020_verify$;
select 'verified' as ops_020_offboarding_state;`,
    "OPS-020 preserved-state verification",
  );
}

async function cleanupExactFixture(
  input: HistoryFixture,
  preserveExistingMembership: boolean,
  expectedAssignmentId: string | null,
) {
  const value = fixtureSqlValues(input);
  const preserveMembershipSql = preserveExistingMembership ? "true" : "false";
  const expectedAssignmentSql = expectedAssignmentId
    ? `${sqlLiteral(requireUuid(expectedAssignmentId, "assignment id"))}::uuid`
    : "null::uuid";
  await runLinkedFixtureSql(
    `do $ops_020_cleanup$
declare
  target_batch_id uuid;
  matching_batches integer;
  preserve_membership boolean := ${preserveMembershipSql};
  expected_assignment_id uuid := ${expectedAssignmentSql};
begin
  select count(*)::integer into matching_batches
  from public.batches batch
  where batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className};

  if matching_batches > 1 then
    raise exception using message = 'ops_020_cleanup_class_not_unique';
  elsif matching_batches = 0 then
    if exists (
      select 1 from public.submissions submission
      where submission.id = ${value.submissionId}::uuid
        or submission.original_text = ${value.originalText}
    ) or (
      not preserve_membership and exists (
        select 1 from public.workspace_members member
        where member.workspace_id = ${value.workspaceId}::uuid
          and member.user_id = ${value.studentId}::uuid
      )
    ) then
      raise exception using message = 'ops_020_cleanup_orphaned_history';
    end if;
    return;
  end if;

  select batch.id into target_batch_id
  from public.batches batch
  where batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className};

  if exists (
    select 1 from public.batch_students assignment
    where assignment.workspace_id = ${value.workspaceId}::uuid
      and assignment.batch_id = target_batch_id
      and assignment.student_id <> ${value.studentId}::uuid
  ) then
    raise exception using message = 'ops_020_cleanup_scope_changed';
  end if;

  if expected_assignment_id is not null and exists (
    select 1 from public.batch_students assignment
    where assignment.workspace_id = ${value.workspaceId}::uuid
      and assignment.batch_id = target_batch_id
      and assignment.student_id = ${value.studentId}::uuid
      and assignment.id <> expected_assignment_id
  ) then
    raise exception using message = 'ops_020_cleanup_assignment_changed';
  end if;

  if exists (
    select 1 from public.submissions submission
    where submission.id = ${value.submissionId}::uuid
      and (submission.workspace_id <> ${value.workspaceId}::uuid
        or submission.student_id <> ${value.studentId}::uuid
        or submission.batch_id <> target_batch_id
        or submission.original_text <> ${value.originalText})
  ) or exists (
    select 1 from public.submissions submission
    where submission.batch_id = target_batch_id
      and submission.id <> ${value.submissionId}::uuid
  ) then
    raise exception using message = 'ops_020_cleanup_history_scope_changed';
  end if;

  delete from public.submissions submission
  where submission.id = ${value.submissionId}::uuid
    and submission.workspace_id = ${value.workspaceId}::uuid
    and submission.student_id = ${value.studentId}::uuid
    and submission.batch_id = target_batch_id
    and submission.original_text = ${value.originalText};
  delete from public.batch_join_requests request
  where request.workspace_id = ${value.workspaceId}::uuid
    and request.batch_id = target_batch_id
    and request.student_id = ${value.studentId}::uuid;
  delete from public.batch_students assignment
  where assignment.workspace_id = ${value.workspaceId}::uuid
    and assignment.batch_id = target_batch_id
    and assignment.student_id = ${value.studentId}::uuid;
  if not preserve_membership then
    if exists (
      select 1 from public.batch_students assignment
      where assignment.workspace_id = ${value.workspaceId}::uuid
        and assignment.student_id = ${value.studentId}::uuid
    ) or exists (
      select 1 from public.batch_join_requests request
      where request.workspace_id = ${value.workspaceId}::uuid
        and request.student_id = ${value.studentId}::uuid
        and request.status in ('pending', 'approved')
    ) then
      raise exception using message = 'ops_020_cleanup_new_membership_in_use';
    end if;
    delete from public.workspace_members member
    where member.workspace_id = ${value.workspaceId}::uuid
      and member.user_id = ${value.studentId}::uuid
      and member.role = 'student';
  end if;
  delete from public.batches batch
  where batch.id = target_batch_id
    and batch.workspace_id = ${value.workspaceId}::uuid
    and batch.created_by = ${value.teacherId}::uuid
    and batch.name = ${value.className};

  if exists (
    select 1 from public.batches batch where batch.id = target_batch_id
  ) or exists (
    select 1 from public.submissions submission
    where submission.id = ${value.submissionId}::uuid
      or submission.original_text = ${value.originalText}
  ) or (
    not preserve_membership and exists (
      select 1 from public.workspace_members member
      where member.workspace_id = ${value.workspaceId}::uuid
        and member.user_id = ${value.studentId}::uuid
    )
  ) then
    raise exception using message = 'ops_020_cleanup_residue';
  end if;
end;
$ops_020_cleanup$;
select 'clean' as ops_020_fixture_state;`,
    "OPS-020 exact cleanup",
  );
}

function normalizeTrustedContext(data: unknown) {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("The trusted auth context was not an object.");
  }
  const row = candidate as { user_id?: unknown; memberships?: unknown };
  if (
    typeof row.user_id !== "string" ||
    !UUID_PATTERN.test(row.user_id) ||
    !Array.isArray(row.memberships)
  ) {
    throw new Error("The trusted auth context was malformed.");
  }
  const memberships = row.memberships.map((membership) => {
    if (!membership || typeof membership !== "object") {
      throw new Error("The trusted membership was malformed.");
    }
    const value = membership as Partial<TrustedMembership>;
    if (
      typeof value.membership_id !== "string" ||
      typeof value.workspace_id !== "string" ||
      !["owner", "teacher", "student"].includes(String(value.role))
    ) {
      throw new Error("The trusted membership was malformed.");
    }
    return value as TrustedMembership;
  });
  return { userId: row.user_id, memberships };
}

function chooseActiveWorkspace(memberships: TrustedMembership[]) {
  const rank = (role: TrustedMembership["role"]) =>
    role === "owner" ? 0 : role === "teacher" ? 1 : 2;
  return (
    [...memberships].sort((left, right) => {
      const rankDifference = rank(left.role) - rank(right.role);
      return (
        rankDifference ||
        left.workspace_id.localeCompare(right.workspace_id) ||
        left.membership_id.localeCompare(right.membership_id)
      );
    })[0]?.workspace_id ?? null
  );
}

async function waitForAuthContext(page: Page) {
  const response = await page.waitForResponse(
    (candidate) => {
      try {
        return (
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).pathname.endsWith(
            "/rest/v1/rpc/get_auth_context",
          )
        );
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  if (response.status() >= 400) {
    throw new Error("The trusted auth context request failed.");
  }
  return normalizeTrustedContext(await response.json());
}

async function signInAndClassify(
  browser: Browser,
  baseURL: string,
  account: Credentials,
): Promise<SignedInAccount> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  const contextResponse = waitForAuthContext(page);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await enterTeacherShellFromAdminLanding(page);
  const trustedContext = await contextResponse;
  await expect(page).toHaveURL(
    /\/(?:teacher\/(?:dashboard|onboarding)|student\/dashboard)$/,
    { timeout: 15_000 },
  );

  const pathname = new URL(page.url()).pathname;
  const role: AppRole = pathname.startsWith("/teacher/")
    ? "teacher"
    : "student";
  if (pathname === "/teacher/onboarding") {
    throw new Error(
      "The detected teacher account needs an existing workspace.",
    );
  }
  return {
    context,
    page,
    account,
    userId: trustedContext.userId,
    role,
    activeWorkspaceId: chooseActiveWorkspace(trustedContext.memberships),
  };
}

function monitorBrowserSafety(page: Page) {
  const failures: string[] = [];
  const forbiddenProviderCalls: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  page.on("request", (request) => {
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      return;
    }
    if (
      /\/(?:prepare-writing-feedback|kick-writing-jobs|generate-practice-worksheet|evaluate-practice-attempt|process-(?:writing|worksheet)-jobs)(?:\/|$)/.test(
        pathname,
      )
    ) {
      forbiddenProviderCalls.push(pathname);
    }
  });
  return () => {
    expect(failures, failures.join("\n")).toEqual([]);
    expect(
      forbiddenProviderCalls,
      "The non-AI OPS-020 workflow invoked an AI/provider worker.",
    ).toEqual([]);
  };
}

async function waitForRpc(page: Page, functionName: string) {
  const response = await page.waitForResponse(
    (candidate) => {
      try {
        return (
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).pathname.endsWith(
            `/rest/v1/rpc/${functionName}`,
          )
        );
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  if (response.status() >= 400) {
    throw new Error(`The ${functionName} staging request failed.`);
  }
  return response;
}

async function fillAndWaitForRpc(
  page: Page,
  field: Locator,
  value: string,
  functionName: string,
) {
  const response = waitForRpc(page, functionName);
  await field.fill(value);
  await response;
}

async function openTeacherStudents(page: Page) {
  await page.goto("/teacher/students");
  await expect(
    page.getByRole("heading", { name: "Students", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading students/ }),
  ).toHaveCount(0, { timeout: 15_000 });
}

function classCard(page: Page, className: string) {
  const codeAnchor = page.getByRole("button", {
    name: `Copy join code for ${className}`,
  });
  return {
    codeAnchor,
    card: codeAnchor.locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
    ),
  };
}

async function createClass(page: Page, className: string) {
  await page.goto("/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create Class" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a class" });
  await dialog.getByLabel("Class name").fill(className);
  await dialog.getByLabel("CEFR level").click();
  await page.getByRole("option", { name: CLASS_LEVEL, exact: true }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("radio", { name: /^Teacher review/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    dialog.getByText("Teacher approval required", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Create class" }).click();

  const { card, codeAnchor } = classCard(page, className);
  await expect(codeAnchor).toBeVisible({ timeout: 10_000 });
  const joinCode = (await card.locator("p.font-mono").textContent())?.trim();
  if (!joinCode || !/^[A-Z0-9]{8,16}$/.test(joinCode)) {
    throw new Error("The OPS-020 class did not expose a valid join code.");
  }
  return joinCode;
}

async function requestClassAccess(
  page: Page,
  joinCode: string,
  className: string,
) {
  await page.goto("/student/dashboard");
  await page.getByLabel("Class join code").fill(joinCode);
  await page.getByRole("button", { name: "Request Access" }).click();
  await expect(
    page.getByText("Request sent", { exact: true }).last(),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText(`${className} · ${CLASS_LEVEL}`, { exact: true }),
  ).toBeVisible();
}

async function approveClassAccess(
  page: Page,
  studentEmail: string,
  className: string,
) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search pending class-code requests"),
    studentEmail,
    "list_workspace_join_requests_filtered_page",
  );
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const requestLine = page.getByText(
    new RegExp(`^${escapedClassName} · ${CLASS_LEVEL} · requested `),
  );
  const requestCard = requestLine.locator(
    "xpath=ancestor::div[.//button[normalize-space()='Approve']][1]",
  );
  await expect(requestCard).toHaveCount(1);
  await requestCard
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(
    page.getByText("Join request approved", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(requestCard).toBeHidden({ timeout: 10_000 });
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectClassInCurrentWorkspace(page: Page, className: string) {
  await page.goto("/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  if (
    !(await classSelector
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    return false;
  }
  await expect
    .poll(async () => classSelector.isEnabled(), { timeout: 15_000 })
    .toBe(true);
  await classSelector.click();
  const option = page.getByRole("option", {
    name: `${className} · ${CLASS_LEVEL}`,
    exact: true,
  });
  if ((await option.count()) !== 1) {
    await page.keyboard.press("Escape");
    return false;
  }
  await option.click();
  await expect(classSelector).toContainText(className);
  return true;
}

async function selectCreatedClass(page: Page, className: string) {
  await page.goto("/student/dashboard");
  const workspaceSelector = visibleWorkspaceSelector(page);
  let workspaceNames: string[] = [];
  if ((await workspaceSelector.count()) === 1) {
    await workspaceSelector.click();
    workspaceNames = (await page.getByRole("option").allTextContents())
      .map((value) => value.trim())
      .filter((value) => value.endsWith(" · student"));
    await page.keyboard.press("Escape");
  }

  if (await selectClassInCurrentWorkspace(page, className)) return;
  for (const workspaceName of workspaceNames) {
    await page.goto("/student/dashboard");
    const selector = visibleWorkspaceSelector(page);
    if ((await selector.count()) !== 1) continue;
    await selector.click();
    const option = page.getByRole("option", {
      name: workspaceName,
      exact: true,
    });
    if ((await option.count()) !== 1) {
      await page.keyboard.press("Escape");
      continue;
    }
    await option.click();
    if (await selectClassInCurrentWorkspace(page, className)) return;
  }
  throw new Error("The approved OPS-020 class was not selectable.");
}

async function openStudentHistoryDetail(
  page: Page,
  submissionId: string,
  className: string,
  originalText: string,
) {
  await page.goto("/student/history");
  await expect(
    page.getByRole("heading", { name: "My History", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading submissions/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  const detailLink = page.locator(
    `a[href="/student/submission/${submissionId}"]`,
  );
  await expect(detailLink).toBeVisible({ timeout: 15_000 });
  const historyCard = detailLink.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
  );
  await expect(historyCard).toContainText(className);
  await expect(historyCard).toContainText(originalText);
  await detailLink.click();
  await expect(page).toHaveURL(
    new RegExp(`/student/submission/${submissionId}$`),
  );
  await expect(page.getByText(originalText, { exact: true })).toBeVisible();
}

async function openTeacherHistoryDetail(
  page: Page,
  submissionId: string,
  className: string,
  originalText: string,
) {
  await page.goto("/teacher/submissions");
  await expect(
    page.getByRole("heading", { name: "Student Submissions", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading submissions/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  const row = page.getByRole("row").filter({ hasText: className });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/teacher/submission/${submissionId}$`),
  );
  await expect(page.getByText(originalText, { exact: true })).toBeVisible();
}

async function offboardStudent(
  page: Page,
  studentEmail: string,
  className: string,
) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search students"),
    studentEmail,
    "list_workspace_students_filtered_page",
  );
  const row = page
    .getByText(studentEmail, { exact: true })
    .locator("xpath=ancestor::tr[1]");
  await expect(row).toHaveCount(1);
  await expect(
    row.getByRole("button", { name: `Remove ${className}`, exact: true }),
  ).toHaveCount(1);
  await row.getByRole("button", { name: "Remove access", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Historical submissions");
  await dialog.getByRole("button", { name: "Remove student access" }).click();
  await expect(
    page.getByText(/^Offboarding completed for /).last(),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText(/Workspace membership removed\./).last(),
  ).toBeVisible();
  await expect(
    page.getByText(/1 batch assignment removed\./).last(),
  ).toBeVisible();
  await expect(
    page.getByText(/1 join request cancelled\./).last(),
  ).toBeVisible();
  await expect(
    page.getByText(/Historical work was preserved\./).last(),
  ).toBeVisible();
  await expect(row).toBeHidden({ timeout: 10_000 });
}

async function removeOnlyFixtureAssignment(
  page: Page,
  studentEmail: string,
  className: string,
) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search students"),
    studentEmail,
    "list_workspace_students_filtered_page",
  );
  const row = page
    .getByText(studentEmail, { exact: true })
    .locator("xpath=ancestor::tr[1]");
  await expect(row).toHaveCount(1);
  const removeFixture = row.getByRole("button", {
    name: `Remove ${className}`,
    exact: true,
  });
  await expect(removeFixture).toHaveCount(1);
  await removeFixture.click();
  await expect(removeFixture).toHaveCount(0, { timeout: 10_000 });
  await expect(
    row.getByRole("button", { name: "Remove access", exact: true }),
  ).toBeVisible();
}

async function archiveClassWithoutReload(page: Page, className: string) {
  await page.goto("/teacher/batches");
  await page.getByLabel("Filter classes by status").click();
  await page.getByRole("option", { name: "All Statuses" }).click();
  const { card, codeAnchor } = classCard(page, className);
  await expect(codeAnchor).toBeVisible({ timeout: 10_000 });
  await card.getByRole("button", { name: "Archive Class" }).click();
  await expect(
    card.getByRole("button", { name: "Reactivate Class" }),
  ).toBeVisible({ timeout: 10_000 });
}

async function assertStudentRevokedWithoutReload(input: {
  page: Page;
  workspaceId: string;
  className: string;
  originalText: string;
}) {
  const nextAuthContext = waitForAuthContext(input.page);
  await input.page.bringToFront();
  // AuthProvider refreshes server-managed access on the normal tab-focus event.
  await input.page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const trustedContext = await nextAuthContext;
  expect(
    trustedContext.memberships.some(
      (membership) => membership.workspace_id === input.workspaceId,
    ),
  ).toBe(false);

  await expect(
    input.page.getByText(input.originalText, { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        (await input.page.getByRole("alert").count()) +
        (await input.page
          .getByRole("heading", { name: "Submission not found." })
          .count()),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await input.page.getByRole("link", { name: "History", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/history$/);
  await expect(
    input.page.getByText(input.originalText, { exact: true }),
  ).toHaveCount(0);
  await expect(
    input.page.getByText(input.className, { exact: true }),
  ).toHaveCount(0);

  await input.page.getByRole("link", { name: "Write", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/questions$/);
  const writingClass = input.page.getByLabel("Class for this writing");
  if ((await writingClass.count()) === 1 && (await writingClass.isEnabled())) {
    await writingClass.click();
    await expect(
      input.page.getByRole("option", {
        name: `${input.className} · ${CLASS_LEVEL}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await input.page.keyboard.press("Escape");
  }
  await expect(
    input.page.getByRole("button", { name: "Join another class" }),
  ).toBeVisible();

  await input.page.getByRole("link", { name: "Practice", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/practice$/);
  await expect(
    input.page.getByText(input.className, { exact: true }),
  ).toHaveCount(0);
}

async function assertFixtureClassRemovedWithoutReload(input: {
  page: Page;
  className: string;
  originalText: string;
}) {
  // Assignment reads have a 30-second cache window. Once stale, verify the
  // real state exposed by normal student navigation. React Query may satisfy
  // this from already-updated cache or refetch it; either is valid as long as
  // the removed class cannot remain visible or selectable.
  await input.page.waitForTimeout(30_500);
  await input.page.getByRole("link", { name: "History", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/history$/);
  await expect(
    input.page.getByText(input.originalText, { exact: true }),
  ).toHaveCount(0);
  await expect(
    input.page.getByText(input.className, { exact: true }),
  ).toHaveCount(0);

  await input.page.getByRole("link", { name: "Write", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/questions$/);
  const writingClass = input.page.getByLabel("Class for this writing");
  if ((await writingClass.count()) === 1 && (await writingClass.isEnabled())) {
    await writingClass.click();
    await expect(
      input.page.getByRole("option", {
        name: `${input.className} · ${CLASS_LEVEL}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await input.page.keyboard.press("Escape");
  }
  await expect(
    input.page.getByRole("button", { name: "Join another class" }),
  ).toBeVisible();

  await input.page.getByRole("link", { name: "Practice", exact: true }).click();
  await expect(input.page).toHaveURL(/\/student\/practice$/);
  await expect(
    input.page.getByText(input.className, { exact: true }),
  ).toHaveCount(0);
}

test.skip(
  process.env.E2E_OFFBOARDING_HISTORY !== "true",
  "Set E2E_OFFBOARDING_HISTORY=true only for the isolated OPS-020 staging run.",
);

test.describe
  .serial("authenticated OPS-020 offboarding and history workflow", () => {
  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
  });

  test("history survives safe access removal and archived classes disappear without UI dead ends", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error(
        "OPS-020 requires the private local authenticated frontend.",
      );
    }

    const accounts = configuredAccounts();
    if (accounts[0].email.toLowerCase() === accounts[1].email.toLowerCase()) {
      throw new Error("OPS-020 requires two different accounts.");
    }

    const signedInAccounts: SignedInAccount[] = [];
    let teacher: SignedInAccount | null = null;
    let student: SignedInAccount | null = null;
    let classMayExist = false;
    let fullOffboard = false;
    let fixtureAssignmentId: string | null = null;
    let relationshipBefore: RelationshipSnapshot | null = null;
    const stamp = `${Date.now().toString(36)}-${process.pid}`;
    const className = `OPS-020 history ${stamp}`;
    const submissionId = crypto.randomUUID();
    const originalText = `OPS-020 preserved writing ${stamp}.\nSecond historical paragraph.`;

    try {
      for (const account of accounts) {
        signedInAccounts.push(
          await signInAndClassify(browser, baseURL, account),
        );
      }
      teacher =
        signedInAccounts.find((account) => account.role === "teacher") ?? null;
      student =
        signedInAccounts.find((account) => account.role === "student") ?? null;
      if (!teacher || !student || !teacher.activeWorkspaceId) {
        throw new Error(
          "The two supplied accounts must resolve in-app to one teacher workspace and one student.",
        );
      }

      const assertTeacherSafe = monitorBrowserSafety(teacher.page);
      const assertStudentSafe = monitorBrowserSafety(student.page);
      relationshipBefore = await readRelationshipSnapshot({
        workspaceId: teacher.activeWorkspaceId,
        studentId: student.userId,
        excludedClassName: className,
      });
      fullOffboard =
        relationshipBefore.membership === null &&
        relationshipBefore.assignments.length === 0 &&
        relationshipBefore.join_requests.length === 0;

      classMayExist = true;
      const joinCode = await createClass(teacher.page, className);
      if (fullOffboard) {
        await requestClassAccess(student.page, joinCode, className);
        await approveClassAccess(
          teacher.page,
          student.account.email,
          className,
        );
      } else {
        const snapshottedMembership = relationshipBefore.membership;
        if (!snapshottedMembership) {
          throw new Error(
            "The existing-relationship branch requires a snapshotted student membership.",
          );
        }
        fixtureAssignmentId = crypto.randomUUID();
        await installExactFixtureAssignment({
          assignmentId: fixtureAssignmentId,
          membershipId: snapshottedMembership.id,
          membershipFingerprint: snapshottedMembership.row_fingerprint,
          submissionId,
          workspaceId: teacher.activeWorkspaceId,
          teacherId: teacher.userId,
          studentId: student.userId,
          className,
          originalText,
        });
      }
      await student.page.reload();
      await selectCreatedClass(student.page, className);

      const fixture: HistoryFixture = {
        submissionId,
        workspaceId: teacher.activeWorkspaceId,
        teacherId: teacher.userId,
        studentId: student.userId,
        className,
        originalText,
      };
      await installHistoryFixture(fixture);
      await openStudentHistoryDetail(
        student.page,
        submissionId,
        className,
        originalText,
      );
      await openTeacherHistoryDetail(
        teacher.page,
        submissionId,
        className,
        originalText,
      );

      if (fullOffboard) {
        await offboardStudent(teacher.page, student.account.email, className);
      } else {
        await removeOnlyFixtureAssignment(
          teacher.page,
          student.account.email,
          className,
        );
      }
      await openTeacherHistoryDetail(
        teacher.page,
        submissionId,
        className,
        originalText,
      );
      await archiveClassWithoutReload(teacher.page, className);
      await openTeacherHistoryDetail(
        teacher.page,
        submissionId,
        className,
        originalText,
      );
      if (fullOffboard) {
        await assertStudentRevokedWithoutReload({
          page: student.page,
          workspaceId: teacher.activeWorkspaceId,
          className,
          originalText,
        });
      } else {
        await assertFixtureClassRemovedWithoutReload({
          page: student.page,
          className,
          originalText,
        });
      }
      await assertPreservedOffboardingState(fixture, fullOffboard);
      expect(
        await readRelationshipSnapshot({
          workspaceId: teacher.activeWorkspaceId,
          studentId: student.userId,
          excludedClassName: className,
        }),
      ).toEqual(relationshipBefore);
      assertTeacherSafe();
      assertStudentSafe();
    } finally {
      const cleanupErrors: string[] = [];
      if (classMayExist && teacher && student && teacher.activeWorkspaceId) {
        await cleanupExactFixture(
          {
            submissionId,
            workspaceId: teacher.activeWorkspaceId,
            teacherId: teacher.userId,
            studentId: student.userId,
            className,
            originalText,
          },
          Boolean(relationshipBefore?.membership),
          fixtureAssignmentId,
        ).catch(() => cleanupErrors.push("exact-fixture-cleanup"));
        if (relationshipBefore) {
          await readRelationshipSnapshot({
            workspaceId: teacher.activeWorkspaceId,
            studentId: student.userId,
            excludedClassName: className,
          })
            .then((relationshipAfterCleanup) =>
              expect(relationshipAfterCleanup).toEqual(relationshipBefore),
            )
            .catch(() => cleanupErrors.push("relationship-restore-check"));
        }
      }
      await Promise.allSettled(
        signedInAccounts.map((account) => account.context.close()),
      );
      expect(cleanupErrors, cleanupErrors.join(",")).toEqual([]);
    }
  });
});
