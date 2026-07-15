import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const EXECUTION_CONFIRMATION_PREFIX = "run-isolated-join-race:";
const COMMAND_TIMEOUT_MS = 35_000;

export const SEC009_FIXTURE = {
  teacherId: "c9090001-0000-4000-8000-000000000001",
  studentId: "c9090002-0000-4000-8000-000000000002",
  workspaceId: "c9091000-0000-4000-8000-000000000001",
  batchId: "c9092000-0000-4000-8000-000000000001",
  requestId: "c9093000-0000-4000-8000-000000000001",
  teacherEmail: "sec009-concurrency-teacher@example.test",
  studentEmail: "sec009-concurrency-student@example.test",
  workspaceSlug: "sec-009-concurrency-fixture",
} as const;

const ADVISORY_LOCK_CLASS = 12_009;
const ADVISORY_LOCK_OBJECT = 9_001;

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  timedOut: boolean;
};

type HarnessOptions = {
  cliPath: string;
  projectRef: string;
  repositoryRoot: string;
};

type HarnessResult = {
  status: "passed";
  project_ref: string;
  terminal_decision: "approved";
  successful_decisions: 1;
  conflicting_decisions: 1;
  membership_count: 1;
  batch_assignment_count: 1;
  idempotent_reread: true;
  overlap_observed: true;
  approve_duration_ms: number;
  reject_duration_ms: number;
  zero_residue: true;
};

export class JoinDecisionRaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JoinDecisionRaceError";
    this.code = code;
  }
}

function quoted(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureUuid(value: string) {
  return `${quoted(value)}::uuid`;
}

function authenticatedTeacherContextSql() {
  return `
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', ${quoted(SEC009_FIXTURE.teacherId)},
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  ${quoted(SEC009_FIXTURE.teacherId)},
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;`;
}

export function buildCleanupSql() {
  const teacherId = fixtureUuid(SEC009_FIXTURE.teacherId);
  const studentId = fixtureUuid(SEC009_FIXTURE.studentId);
  const workspaceId = fixtureUuid(SEC009_FIXTURE.workspaceId);
  const batchId = fixtureUuid(SEC009_FIXTURE.batchId);
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';

delete from app_private.onboarding_progress progress
where progress.workspace_id = ${workspaceId}
   or progress.user_id in (${teacherId}, ${studentId});

delete from app_private.batch_join_attempt_windows usage_window
where usage_window.actor_id in (${teacherId}, ${studentId});

delete from app_private.practice_processor_kick_windows usage_window
where usage_window.actor_id in (${teacherId}, ${studentId});

delete from app_private.writing_processor_kick_windows usage_window
where usage_window.user_id in (${teacherId}, ${studentId});

delete from app_private.writing_submission_daily_usage usage_row
where usage_row.workspace_id = ${workspaceId}
   or usage_row.student_id in (${teacherId}, ${studentId});

delete from public.usage_events event
where event.workspace_id = ${workspaceId}
   or event.user_id in (${teacherId}, ${studentId});

delete from public.batch_join_requests request
where request.id = ${requestId}
   or request.workspace_id = ${workspaceId};

delete from public.batch_students assignment
where assignment.workspace_id = ${workspaceId}
   or (
     assignment.batch_id = ${batchId}
     and assignment.student_id = ${studentId}
   );

delete from public.workspace_members membership
where membership.workspace_id = ${workspaceId};

delete from app_private.batch_join_codes code
where code.batch_id = ${batchId}
   or code.workspace_id = ${workspaceId};

delete from public.batches batch
where batch.id = ${batchId}
   or batch.workspace_id = ${workspaceId};

delete from public.workspaces workspace
where workspace.id = ${workspaceId}
   or workspace.slug = ${quoted(SEC009_FIXTURE.workspaceSlug)};

delete from app_private.teacher_entitlements entitlement
where entitlement.user_id in (${teacherId}, ${studentId});

delete from auth.users auth_user
where auth_user.id in (${teacherId}, ${studentId})
   or auth_user.email in (
     ${quoted(SEC009_FIXTURE.teacherEmail)},
     ${quoted(SEC009_FIXTURE.studentEmail)}
   );

commit;`;
}

export function buildSetupSql() {
  const teacherId = fixtureUuid(SEC009_FIXTURE.teacherId);
  const studentId = fixtureUuid(SEC009_FIXTURE.studentId);
  const workspaceId = fixtureUuid(SEC009_FIXTURE.workspaceId);
  const batchId = fixtureUuid(SEC009_FIXTURE.batchId);
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';

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
    ${teacherId},
    'authenticated',
    'authenticated',
    ${quoted(SEC009_FIXTURE.teacherEmail)},
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"SEC 009 Synthetic Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    ${studentId},
    'authenticated',
    'authenticated',
    ${quoted(SEC009_FIXTURE.studentEmail)},
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"SEC 009 Synthetic Student"}'::jsonb,
    now(),
    now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values (
  ${teacherId},
  true,
  1,
  'SEC-009 isolated join-decision race fixture.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  ${workspaceId},
  'SEC 009 Concurrency Fixture',
  ${quoted(SEC009_FIXTURE.workspaceSlug)},
  ${teacherId}
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', ${quoted(SEC009_FIXTURE.teacherId)},
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  ${quoted(SEC009_FIXTURE.teacherId)},
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (${workspaceId}, ${teacherId}, 'owner');
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values (
  ${batchId},
  ${workspaceId},
  'SEC 009 Concurrency Class',
  'A1',
  ${teacherId},
  true,
  true,
  true,
  'teacher_review_only',
  0,
  0
);

insert into public.batch_join_requests (
  id,
  workspace_id,
  batch_id,
  student_id,
  student_email,
  student_name,
  status
)
values (
  ${requestId},
  ${workspaceId},
  ${batchId},
  ${studentId},
  ${quoted(SEC009_FIXTURE.studentEmail)},
  'SEC 009 Synthetic Student',
  'pending'
);

do $sec009$
begin
  if (
    select count(*)
    from public.batch_join_requests request
    where request.id = ${requestId}
      and request.status = 'pending'
      and request.decided_by is null
      and request.decided_at is null
  ) <> 1 then
    raise exception using message = 'sec009_fixture_request_invalid';
  end if;

  if (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${workspaceId}
      and membership.user_id = ${studentId}
  ) <> 0 then
    raise exception using message = 'sec009_fixture_membership_not_empty';
  end if;

  if (
    select count(*)
    from public.batch_students assignment
    where assignment.batch_id = ${batchId}
      and assignment.student_id = ${studentId}
  ) <> 0 then
    raise exception using message = 'sec009_fixture_assignment_not_empty';
  end if;
end;
$sec009$;

commit;`;
}

export function buildApproveRaceSql() {
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
begin;
set local lock_timeout = '20s';
set local statement_timeout = '25s';

-- Owner-only coordination: acquire the exact row before exposing the barrier.
select request.id
from public.batch_join_requests request
where request.id = ${requestId}
for update;
select pg_advisory_xact_lock(
  ${ADVISORY_LOCK_CLASS},
  ${ADVISORY_LOCK_OBJECT}
);
select pg_sleep(12);

${authenticatedTeacherContextSql()}
select *
from api.decide_batch_join(${requestId}, 'approved');
commit;`;
}

export function buildRejectRaceSql() {
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
begin;
set local lock_timeout = '20s';
set local statement_timeout = '25s';
${authenticatedTeacherContextSql()}
select *
from api.decide_batch_join(${requestId}, 'rejected');
commit;`;
}

export function buildLockProbeSql() {
  return `
do $sec009$
begin
  if not exists (
    select 1
    from pg_locks held_lock
    where held_lock.locktype = 'advisory'
      and held_lock.classid = ${ADVISORY_LOCK_CLASS}::oid
      and held_lock.objid = ${ADVISORY_LOCK_OBJECT}::oid
      and held_lock.objsubid = 2
      and held_lock.granted
  ) then
    raise exception using message = 'sec009_coordination_lock_not_ready';
  end if;
end;
$sec009$;`;
}

export function buildTerminalVerificationSql() {
  const teacherId = fixtureUuid(SEC009_FIXTURE.teacherId);
  const studentId = fixtureUuid(SEC009_FIXTURE.studentId);
  const workspaceId = fixtureUuid(SEC009_FIXTURE.workspaceId);
  const batchId = fixtureUuid(SEC009_FIXTURE.batchId);
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
do $sec009$
begin
  if (
    select count(*)
    from public.batch_join_requests request
    where request.id = ${requestId}
      and request.status = 'approved'
      and request.decided_by = ${teacherId}
      and request.decided_at is not null
  ) <> 1 then
    raise exception using message = 'sec009_terminal_decision_invalid';
  end if;

  if (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${workspaceId}
      and membership.user_id = ${studentId}
      and membership.role = 'student'
  ) <> 1 then
    raise exception using message = 'sec009_membership_count_invalid';
  end if;

  if (
    select count(*)
    from public.batch_students assignment
    where assignment.workspace_id = ${workspaceId}
      and assignment.batch_id = ${batchId}
      and assignment.student_id = ${studentId}
  ) <> 1 then
    raise exception using message = 'sec009_assignment_count_invalid';
  end if;
end;
$sec009$;`;
}

export function buildIdempotentRereadSql() {
  const studentId = fixtureUuid(SEC009_FIXTURE.studentId);
  const workspaceId = fixtureUuid(SEC009_FIXTURE.workspaceId);
  const batchId = fixtureUuid(SEC009_FIXTURE.batchId);
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';
select set_config(
  'app.sec009_original_decided_at',
  (
    select request.decided_at::text
    from public.batch_join_requests request
    where request.id = ${requestId}
  ),
  true
);
${authenticatedTeacherContextSql()}
select *
from api.decide_batch_join(${requestId}, 'approved');
reset role;

do $sec009$
begin
  if (
    select request.status <> 'approved'
      or request.decided_at::text is distinct from
        current_setting('app.sec009_original_decided_at', true)
    from public.batch_join_requests request
    where request.id = ${requestId}
  ) then
    raise exception using message = 'sec009_idempotent_decision_changed';
  end if;

  if (
    select count(*)
    from public.workspace_members membership
    where membership.workspace_id = ${workspaceId}
      and membership.user_id = ${studentId}
      and membership.role = 'student'
  ) <> 1 then
    raise exception using message = 'sec009_idempotent_membership_duplicated';
  end if;

  if (
    select count(*)
    from public.batch_students assignment
    where assignment.workspace_id = ${workspaceId}
      and assignment.batch_id = ${batchId}
      and assignment.student_id = ${studentId}
  ) <> 1 then
    raise exception using message = 'sec009_idempotent_assignment_duplicated';
  end if;
end;
$sec009$;

commit;`;
}

export function buildZeroResidueSql() {
  const teacherId = fixtureUuid(SEC009_FIXTURE.teacherId);
  const studentId = fixtureUuid(SEC009_FIXTURE.studentId);
  const workspaceId = fixtureUuid(SEC009_FIXTURE.workspaceId);
  const batchId = fixtureUuid(SEC009_FIXTURE.batchId);
  const requestId = fixtureUuid(SEC009_FIXTURE.requestId);

  // Shared staging extensions are not created by this harness and therefore
  // are not fixture residue. The guard is restricted to exact owned rows and
  // SEC-009-named temporary database objects.
  return `
do $sec009$
declare
  residue_count bigint;
begin
  select sum(candidate.count_value)
  into residue_count
  from (
    select count(*)::bigint as count_value
    from auth.users auth_user
    where auth_user.id in (${teacherId}, ${studentId})
       or auth_user.email in (
         ${quoted(SEC009_FIXTURE.teacherEmail)},
         ${quoted(SEC009_FIXTURE.studentEmail)}
       )
    union all
    select count(*) from public.profiles profile
    where profile.id in (${teacherId}, ${studentId})
    union all
    select count(*) from public.workspaces workspace
    where workspace.id = ${workspaceId}
       or workspace.slug = ${quoted(SEC009_FIXTURE.workspaceSlug)}
    union all
    select count(*) from public.batches batch
    where batch.id = ${batchId}
       or batch.workspace_id = ${workspaceId}
    union all
    select count(*) from app_private.batch_join_codes code
    where code.batch_id = ${batchId}
       or code.workspace_id = ${workspaceId}
    union all
    select count(*) from public.batch_join_requests request
    where request.id = ${requestId}
       or request.workspace_id = ${workspaceId}
       or request.student_id = ${studentId}
    union all
    select count(*) from public.workspace_members membership
    where membership.workspace_id = ${workspaceId}
       or membership.user_id in (${teacherId}, ${studentId})
    union all
    select count(*) from public.batch_students assignment
    where assignment.workspace_id = ${workspaceId}
       or assignment.batch_id = ${batchId}
       or assignment.student_id = ${studentId}
    union all
    select count(*) from app_private.onboarding_progress progress
    where progress.workspace_id = ${workspaceId}
       or progress.user_id in (${teacherId}, ${studentId})
    union all
    select count(*) from public.usage_events event
    where event.workspace_id = ${workspaceId}
       or event.user_id in (${teacherId}, ${studentId})
    union all
    select count(*) from app_private.teacher_entitlements entitlement
    where entitlement.user_id in (${teacherId}, ${studentId})
    union all
    select count(*) from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id in (${teacherId}, ${studentId})
    union all
    select count(*) from app_private.practice_processor_kick_windows usage_window
    where usage_window.actor_id in (${teacherId}, ${studentId})
    union all
    select count(*) from app_private.writing_processor_kick_windows usage_window
    where usage_window.user_id in (${teacherId}, ${studentId})
    union all
    select count(*) from app_private.writing_submission_daily_usage usage_row
    where usage_row.workspace_id = ${workspaceId}
       or usage_row.student_id in (${teacherId}, ${studentId})
    union all
    select count(*) from pg_class relation
    where relation.relname like 'sec009\\_%' escape '\\'
    union all
    select count(*) from pg_proc routine
    where routine.proname like 'sec009\\_%' escape '\\'
    union all
    select count(*) from pg_trigger trigger_row
    where trigger_row.tgname like 'sec009\\_%' escape '\\'
      and not trigger_row.tgisinternal
  ) candidate;

  if coalesce(residue_count, 0) <> 0 then
    raise exception using message = 'sec009_cleanup_residue_detected';
  end if;
end;
$sec009$;`;
}

const activeChildren = new Set<ChildProcess>();

async function runSql(
  options: HarnessOptions,
  sql: string,
): Promise<CommandResult> {
  const startedAtMs = performance.now();

  return await new Promise((resolvePromise) => {
    const child = spawn(
      options.cliPath,
      ["db", "query", "--linked", sql],
      {
        cwd: options.repositoryRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    child.once("error", (error) => {
      stderr += error instanceof Error ? error.message : "spawn_failed";
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      const endedAtMs = performance.now();
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal,
        stdout,
        stderr,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        timedOut,
      });
    });
  });
}

function safeFailure(result: CommandResult) {
  const normalized = `${result.stderr}\n${result.stdout}`
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 600) || "no diagnostic returned";
}

async function runSqlChecked(
  options: HarnessOptions,
  label: string,
  sql: string,
) {
  const result = await runSql(options, sql);
  if (!result.ok) {
    throw new JoinDecisionRaceError(
      `${label}_failed`,
      `${label} failed: ${safeFailure(result)}`,
    );
  }
  return result;
}

async function waitForCoordinationLock(options: HarnessOptions) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runSql(options, buildLockProbeSql());
    if (result.ok) return;
    if (attempt < 3) await sleep(150);
  }
  throw new JoinDecisionRaceError(
    "coordination_lock_missing",
    "The approve session did not expose its bounded concurrency barrier.",
  );
}

async function resolveOptions(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): Promise<HarnessOptions> {
  const projectRef = environment.SEC009_PROJECT_REF?.trim() ?? "";
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new JoinDecisionRaceError(
      "project_ref_invalid",
      "SEC009_PROJECT_REF must be the exact 20-character linked staging ref.",
    );
  }

  if (
    environment.SEC009_CONFIRM !==
    `${EXECUTION_CONFIRMATION_PREFIX}${projectRef}`
  ) {
    throw new JoinDecisionRaceError(
      "execution_not_confirmed",
      "SEC009_CONFIRM does not authorize this exact linked project.",
    );
  }

  const linkedRef = (
    await readFile(
      resolve(repositoryRoot, "supabase/.temp/project-ref"),
      "utf8",
    )
  ).trim();
  if (linkedRef !== projectRef) {
    throw new JoinDecisionRaceError(
      "linked_project_mismatch",
      "The Supabase CLI link does not match SEC009_PROJECT_REF.",
    );
  }

  const configuredCli = environment.SUPABASE_CLI_PATH?.trim() ?? "";
  if (!isAbsolute(configuredCli)) {
    throw new JoinDecisionRaceError(
      "cli_path_invalid",
      "SUPABASE_CLI_PATH must be an absolute executable path.",
    );
  }
  const cliPath = await realpath(configuredCli);
  const cliStat = await stat(cliPath);
  if (!cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
    throw new JoinDecisionRaceError(
      "cli_path_invalid",
      "SUPABASE_CLI_PATH is not executable.",
    );
  }

  return { cliPath, projectRef, repositoryRoot };
}

export async function runJoinDecisionRace(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))),
): Promise<HarnessResult> {
  const options = await resolveOptions(environment, repositoryRoot);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await runSqlChecked(options, "fixture_cleanup", buildCleanupSql());
      await runSqlChecked(options, "zero_residue", buildZeroResidueSql());
    })();
    return cleanupPromise;
  };

  let completed = false;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    for (const child of activeChildren) child.kill("SIGTERM");
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await cleanup();
    cleanupPromise = undefined;
    await runSqlChecked(options, "fixture_setup", buildSetupSql());

    const approvePromise = runSql(options, buildApproveRaceSql());
    await sleep(150);
    await waitForCoordinationLock(options);
    const rejectPromise = runSql(options, buildRejectRaceSql());
    const [approveResult, rejectResult] = await Promise.all([
      approvePromise,
      rejectPromise,
    ]);

    if (!approveResult.ok) {
      throw new JoinDecisionRaceError(
        "approve_session_failed",
        `The approve session failed: ${safeFailure(approveResult)}`,
      );
    }
    if (
      rejectResult.ok ||
      !/23514/.test(`${rejectResult.stderr}\n${rejectResult.stdout}`) ||
      !/Approved join requests cannot be rejected\./.test(
        `${rejectResult.stderr}\n${rejectResult.stdout}`,
      )
    ) {
      throw new JoinDecisionRaceError(
        "reject_session_not_serialized",
        `The reject session did not observe the approved terminal state: ${safeFailure(rejectResult)}`,
      );
    }
    if (
      rejectResult.startedAtMs >= approveResult.endedAtMs ||
      rejectResult.durationMs < 1_000
    ) {
      throw new JoinDecisionRaceError(
        "overlap_not_observed",
        "The two independent decision sessions did not overlap for a bounded lock wait.",
      );
    }

    await runSqlChecked(
      options,
      "terminal_verification",
      buildTerminalVerificationSql(),
    );
    await runSqlChecked(
      options,
      "idempotent_reread",
      buildIdempotentRereadSql(),
    );

    completed = true;
    return {
      status: "passed",
      project_ref: options.projectRef,
      terminal_decision: "approved",
      successful_decisions: 1,
      conflicting_decisions: 1,
      membership_count: 1,
      batch_assignment_count: 1,
      idempotent_reread: true,
      overlap_observed: true,
      approve_duration_ms: Math.round(approveResult.durationMs),
      reject_duration_ms: Math.round(rejectResult.durationMs),
      zero_residue: true,
    };
  } finally {
    cleanupPromise = undefined;
    try {
      await cleanup();
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (!completed) {
        for (const child of activeChildren) child.kill("SIGTERM");
      }
    }
  }
}

async function main() {
  const result = await runJoinDecisionRace();
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    if (error instanceof JoinDecisionRaceError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(
        "join_decision_race_failed: The isolated concurrency harness failed.",
      );
    }
    process.exitCode = 1;
  });
}
