import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const CONFIRMATION_PREFIX = "run-isolated-practice-transition-races:";
const COMMAND_TIMEOUT_MS = 90_000;
const CHILD_KILL_GRACE_MS = 2_000;
const MUTATING_SETTLE_TIMEOUT_MS =
  COMMAND_TIMEOUT_MS + CHILD_KILL_GRACE_MS + 1_000;
const BLOCKING_OWNER_HOLD_SECONDS = 30;
const RACE_LOCK_TIMEOUT_SECONDS = 45;
const RACE_STATEMENT_TIMEOUT_SECONDS = 60;
const PROBE_TIMEOUT_SECONDS = 18;
const SESSION_DRAIN_TIMEOUT_SECONDS = 40;
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 500;
const LEGACY_REJECTION_SENTINEL =
  "phase13j_legacy_rejection_while_owner_locked";
const MVCC_BARRIER = { classId: 13_162, objectId: 1 } as const;
const WORKER_BARRIER = { classId: 13_162, objectId: 2 } as const;
const LEGACY_CONTEXT_BARRIER = { classId: 13_162, objectId: 3 } as const;
const MVCC_OWNER_APPLICATION = "phase13j_mvcc_owner";
const MVCC_CONTENDER_APPLICATION = "phase13j_mvcc_contender";
const WORKER_APPLICATION = "phase13j_transition_worker";
const TEACHER_APPLICATION = "phase13j_teacher_reassign";
const LEGACY_CONTEXT_OWNER_APPLICATION = "phase13j_legacy_context_owner";
const LEGACY_REASSIGN_APPLICATION = "phase13j_legacy_reassign";
const CLEANUP_APPLICATION = "phase13j_fixture_cleanup";
const MUTATING_APPLICATION_NAMES = {
  fixture_setup: "phase13j_fixture_setup",
  mvcc_verification: "phase13j_mvcc_verification",
  worker_fixture_transition: "phase13j_worker_fixture_transition",
} as const;
const HARNESS_APPLICATION_NAMES = [
  MVCC_OWNER_APPLICATION,
  MVCC_CONTENDER_APPLICATION,
  WORKER_APPLICATION,
  TEACHER_APPLICATION,
  LEGACY_CONTEXT_OWNER_APPLICATION,
  LEGACY_REASSIGN_APPLICATION,
  CLEANUP_APPLICATION,
  ...Object.values(MUTATING_APPLICATION_NAMES),
] as const;

type AdvisoryBarrier = {
  classId: number;
  objectId: number;
};

export const PRACTICE_TRANSITION_FIXTURE = {
  teacherId: "d9130001-0000-4000-8000-000000000001",
  studentId: "d9130002-0000-4000-8000-000000000002",
  workspaceId: "d9131000-0000-4000-8000-000000000001",
  batchId: "d9132000-0000-4000-8000-000000000001",
  mvccTopicId: "d9133000-0000-4000-8000-000000000001",
  workerTopicId: "d9133000-0000-4000-8000-000000000002",
  legacyTopicId: "d9133000-0000-4000-8000-000000000003",
  mvccCycleId: "d9134000-0000-4000-8000-000000000001",
  workerCycleId: "d9134000-0000-4000-8000-000000000002",
  legacyCycleId: "d9134000-0000-4000-8000-000000000003",
  mvccAssignmentId: "d9135000-0000-4000-8000-000000000001",
  workerAssignmentId: "d9135000-0000-4000-8000-000000000002",
  legacyCurrentAssignmentId: "d9135000-0000-4000-8000-000000000003",
  legacyHistoricalAssignmentId: "d9135000-0000-4000-8000-000000000004",
  teacherEmail: "phase13j-race-teacher@example.test",
  studentEmail: "phase13j-race-student@example.test",
  workspaceSlug: "phase-13j-practice-transition-races",
  mvccTopicSlug: "phase-13j-mvcc-terminal-race",
  workerTopicSlug: "phase-13j-worker-reassign-race",
  legacyTopicSlug: "phase-13j-legacy-context-race",
} as const;

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
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

type RaceResult = {
  status: "passed";
  project_ref: string;
  mvcc_overlap_observed: true;
  worker_reassignment_overlap_observed: true;
  legacy_context_overlap_observed: true;
  legacy_reassignment_rejected: true;
  mvcc_replacement_count: 0;
  worker_replacement_count: 1;
  teacher_action_count: 1;
  zero_residue: true;
};

export class PracticeTransitionRaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PracticeTransitionRaceError";
    this.code = code;
  }
}

export function createPracticeTransitionRaceLifecycle() {
  let abortRequested = false;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownStarted = false;
  const mutatingOperations = new Set<Promise<unknown>>();
  const assertActive = (label: string) => {
    if (abortRequested) {
      throw new PracticeTransitionRaceError(
        "execution_interrupted",
        `The race harness was interrupted before ${label}.`,
      );
    }
  };

  return {
    get abortRequested() {
      return abortRequested;
    },
    requestAbort() {
      abortRequested = true;
    },
    assertActive,
    prepareForMutations() {
      assertActive("fixture mutation");
      cleanupPromise = undefined;
    },
    trackMutatingOperation<T>(operation: Promise<T>) {
      mutatingOperations.add(operation);
      void operation.then(
        () => mutatingOperations.delete(operation),
        () => mutatingOperations.delete(operation),
      );
      return operation;
    },
    async settleMutatingOperations(timeoutMs: number) {
      const deadline = performance.now() + timeoutMs;
      while (mutatingOperations.size > 0) {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) return false;
        const timeoutController = new AbortController();
        let settled: boolean;
        try {
          settled = await Promise.race([
            Promise.allSettled([...mutatingOperations]).then(() => true),
            sleep(remainingMs, undefined, {
              signal: timeoutController.signal,
            }).then(() => false),
          ]);
        } finally {
          timeoutController.abort();
        }
        if (!settled) return false;
      }
      return true;
    },
    runCleanup(action: () => Promise<void>) {
      cleanupPromise ??= action();
      return cleanupPromise;
    },
    async settleCurrentCleanup() {
      if (!cleanupPromise) return;
      try {
        await cleanupPromise;
      } catch {
        // Shutdown replaces a rejected or interrupted cleanup generation below.
      }
    },
    prepareShutdownCleanup() {
      if (!shutdownStarted) {
        throw new PracticeTransitionRaceError(
          "shutdown_not_started",
          "A fresh cleanup generation may only start inside shutdown.",
        );
      }
      cleanupPromise = undefined;
    },
    runShutdown(action: () => Promise<void>) {
      if (!shutdownPromise) {
        shutdownStarted = true;
        shutdownPromise = action();
      }
      return shutdownPromise;
    },
  };
}

function quoted(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function uuid(value: string) {
  return `${quoted(value)}::uuid`;
}

export function buildHarnessApplicationSql(
  applicationName: string,
  sql: string,
) {
  const transactionSql = sql.trim();
  const localApplicationName = `set local application_name = ${quoted(applicationName)};`;
  if (/^begin;/i.test(transactionSql)) {
    return transactionSql.replace(
      /^begin;/i,
      `begin;\n${localApplicationName}`,
    );
  }
  return `begin;\n${localApplicationName}\n${transactionSql}\ncommit;`;
}

function authenticatedTeacherContextSql() {
  return `
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', ${quoted(PRACTICE_TRANSITION_FIXTURE.teacherId)},
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  ${quoted(PRACTICE_TRANSITION_FIXTURE.teacherId)},
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;`;
}

function serviceContextSql() {
  return `
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;`;
}

export function buildPracticeTransitionCleanupSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  const topicIds = [
    fixture.mvccTopicId,
    fixture.workerTopicId,
    fixture.legacyTopicId,
  ]
    .map(uuid)
    .join(", ");
  const cycleIds = [
    fixture.mvccCycleId,
    fixture.workerCycleId,
    fixture.legacyCycleId,
  ]
    .map(uuid)
    .join(", ");
  const assignmentIds = [
    fixture.mvccAssignmentId,
    fixture.workerAssignmentId,
    fixture.legacyCurrentAssignmentId,
    fixture.legacyHistoricalAssignmentId,
  ]
    .map(uuid)
    .join(", ");

  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
set local session_replication_role = replica;

delete from app_private.practice_teacher_actions action
where action.workspace_id = ${uuid(fixture.workspaceId)}
   or action.assignment_id in (${assignmentIds});

delete from app_private.practice_assignment_cycle_transition_jobs job
where job.workspace_id = ${uuid(fixture.workspaceId)}
   or job.resolution_cycle_id in (${cycleIds});

delete from app_private.practice_resolution_cycle_events event
where event.cycle_id in (${cycleIds});

delete from app_private.practice_level_fit_reconciliation_failures failure
where failure.cycle_id in (${cycleIds});

delete from app_private.practice_level_fit_opt_ins opt_in
where opt_in.cycle_id in (${cycleIds});

delete from public.student_practice_assignments assignment
where assignment.workspace_id = ${uuid(fixture.workspaceId)}
   or assignment.grammar_topic_id in (${topicIds});

delete from app_private.practice_resolution_cycles cycle
where cycle.workspace_id = ${uuid(fixture.workspaceId)}
   or cycle.id in (${cycleIds});

delete from public.student_grammar_stats stats
where stats.workspace_id = ${uuid(fixture.workspaceId)}
   or stats.grammar_topic_id in (${topicIds});

delete from public.grammar_topics topic
where topic.id in (${topicIds})
   or topic.slug in (
     ${quoted(fixture.mvccTopicSlug)},
     ${quoted(fixture.workerTopicSlug)},
     ${quoted(fixture.legacyTopicSlug)}
   );

set local session_replication_role = origin;

delete from public.batch_students membership
where membership.workspace_id = ${uuid(fixture.workspaceId)}
   or membership.batch_id = ${uuid(fixture.batchId)};

delete from public.workspace_members membership
where membership.workspace_id = ${uuid(fixture.workspaceId)};

delete from public.batches batch
where batch.id = ${uuid(fixture.batchId)}
   or batch.workspace_id = ${uuid(fixture.workspaceId)};

delete from public.workspaces workspace
where workspace.id = ${uuid(fixture.workspaceId)}
   or workspace.slug = ${quoted(fixture.workspaceSlug)};

delete from app_private.teacher_entitlements entitlement
where entitlement.user_id in (
  ${uuid(fixture.teacherId)},
  ${uuid(fixture.studentId)}
);

delete from auth.users auth_user
where auth_user.id in (
  ${uuid(fixture.teacherId)},
  ${uuid(fixture.studentId)}
)
or auth_user.email in (
  ${quoted(fixture.teacherEmail)},
  ${quoted(fixture.studentEmail)}
);

commit;`;
}

export function buildPracticeTransitionSetupSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    ${uuid(fixture.teacherId)},
    'authenticated', 'authenticated', ${quoted(fixture.teacherEmail)}, '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13J Synthetic Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    ${uuid(fixture.studentId)},
    'authenticated', 'authenticated', ${quoted(fixture.studentEmail)}, '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13J Synthetic Student"}'::jsonb,
    now(), now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values (
  ${uuid(fixture.teacherId)},
  true,
  1,
  'Phase 13J isolated practice-transition race fixture.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  ${uuid(fixture.workspaceId)},
  'Phase 13J Practice Transition Races',
  ${quoted(fixture.workspaceSlug)},
  ${uuid(fixture.teacherId)}
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', ${quoted(fixture.teacherId)}, true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (${uuid(fixture.workspaceId)}, ${uuid(fixture.teacherId)}, 'owner');
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (${uuid(fixture.workspaceId)}, ${uuid(fixture.studentId)}, 'student');

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, created_by, is_active,
  join_code_enabled, join_requires_approval, feedback_mode,
  feedback_delay_min_minutes, feedback_delay_max_minutes
)
values (
  ${uuid(fixture.batchId)}, ${uuid(fixture.workspaceId)},
  'Phase 13J B2 Race Class', 'B2', ${uuid(fixture.teacherId)}, true,
  true, true, 'immediate', 0, 0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  ${uuid(fixture.workspaceId)},
  ${uuid(fixture.batchId)},
  ${uuid(fixture.studentId)}
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    ${uuid(fixture.mvccTopicId)}, ${quoted(fixture.mvccTopicSlug)},
    'Phase 13J MVCC Race', 'B2', 'Synthetic concurrency fixture.'
  ),
  (
    ${uuid(fixture.workerTopicId)}, ${quoted(fixture.workerTopicSlug)},
    'Phase 13J Worker Race', 'B2', 'Synthetic concurrency fixture.'
  ),
  (
    ${uuid(fixture.legacyTopicId)}, ${quoted(fixture.legacyTopicSlug)},
    'Phase 13J Legacy Context Race', 'B2', 'Synthetic concurrency fixture.'
  );

set local session_replication_role = replica;
insert into app_private.practice_resolution_cycles (
  id, workspace_id, student_id, grammar_topic_id, cycle_number,
  state, state_reason, evidence_start_sequence, evidence_through_sequence,
  minor_issue_count, major_issue_count, batch_id, worksheet_level,
  class_context_version, class_context_integrity
)
values
  (
    ${uuid(fixture.mvccCycleId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.mvccTopicId)}, 1,
    'unlocked', 'worksheet_ready', 1, 1, 0, 1,
    ${uuid(fixture.batchId)}, 'B2', 1, 'teacher_verified'
  ),
  (
    ${uuid(fixture.workerCycleId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.workerTopicId)}, 1,
    'unlocked', 'worksheet_ready', 1, 1, 0, 1,
    ${uuid(fixture.batchId)}, 'B2', 1, 'teacher_verified'
  ),
  (
    ${uuid(fixture.legacyCycleId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.legacyTopicId)}, 1,
    'unlocked', 'worksheet_ready', 1, 1, 0, 1,
    null, null, 0, 'legacy_unverified'
  );
set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, source, status,
  generation_status, resolution_cycle_id, resolution_cycle_number,
  evidence_cutoff_sequence, batch_id, worksheet_level,
  class_context_version, class_context_integrity
)
values
  (
    ${uuid(fixture.mvccAssignmentId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.mvccTopicId)},
    'weakness_auto', 'unlocked', 'idle', ${uuid(fixture.mvccCycleId)}, 1, 1,
    ${uuid(fixture.batchId)}, 'B2', 1, 'teacher_verified'
  ),
  (
    ${uuid(fixture.workerAssignmentId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.workerTopicId)},
    'weakness_auto', 'unlocked', 'idle', ${uuid(fixture.workerCycleId)}, 1, 1,
    ${uuid(fixture.batchId)}, 'B2', 1, 'teacher_verified'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, source, status,
  generation_status, generation_error, resolution_cycle_id,
  resolution_cycle_number, evidence_cutoff_sequence,
  class_context_version, class_context_integrity
)
values
  (
    ${uuid(fixture.legacyCurrentAssignmentId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.legacyTopicId)},
    'weakness_auto', 'unlocked', 'failed', 'worksheet_class_context_required',
    ${uuid(fixture.legacyCycleId)}, 1, 1, 0, 'legacy_unverified'
  ),
  (
    ${uuid(fixture.legacyHistoricalAssignmentId)}, ${uuid(fixture.workspaceId)},
    ${uuid(fixture.studentId)}, ${uuid(fixture.legacyTopicId)},
    'manual', 'failed', 'idle', null, null, null, null, 0,
    'legacy_unverified'
  );

update app_private.practice_resolution_cycles cycle
set active_assignment_id = case cycle.id
  when ${uuid(fixture.mvccCycleId)} then ${uuid(fixture.mvccAssignmentId)}
  when ${uuid(fixture.workerCycleId)} then ${uuid(fixture.workerAssignmentId)}
  else ${uuid(fixture.legacyCurrentAssignmentId)}
end,
evidence_frozen_at = now()
where cycle.id in (
  ${uuid(fixture.mvccCycleId)},
  ${uuid(fixture.workerCycleId)},
  ${uuid(fixture.legacyCycleId)}
);

commit;`;
}

export function buildMvccTerminalSessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '${RACE_LOCK_TIMEOUT_SECONDS}s';
set local statement_timeout = '${RACE_STATEMENT_TIMEOUT_SECONDS}s';
set local application_name = ${quoted(MVCC_OWNER_APPLICATION)};
update public.student_practice_assignments assignment
set status = 'failed', completed_at = now()
where assignment.id = ${uuid(fixture.mvccAssignmentId)};
select pg_advisory_xact_lock(${MVCC_BARRIER.classId}, ${MVCC_BARRIER.objectId});
select pg_sleep(${BLOCKING_OWNER_HOLD_SECONDS});
commit;`;
}

export function buildMvccReconcileSessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '${RACE_LOCK_TIMEOUT_SECONDS}s';
set local statement_timeout = '${RACE_STATEMENT_TIMEOUT_SECONDS}s';
set local application_name = ${quoted(MVCC_CONTENDER_APPLICATION)};
select app_private.ensure_practice_cycle_assignment_internal(
  ${uuid(fixture.mvccCycleId)}
) as protected_assignment_id;
commit;`;
}

export function buildBarrierProbeSql(
  barrier: AdvisoryBarrier,
  ownerApplicationName: string,
) {
  return `
begin;
set local statement_timeout = '${PROBE_TIMEOUT_SECONDS + 2}s';
do $phase13j_race$
declare
  deadline timestamptz := clock_timestamp() + interval '${PROBE_TIMEOUT_SECONDS} seconds';
begin
  loop
    if exists (
      select 1
      from pg_locks held_lock
      join pg_stat_activity owner_activity
        on owner_activity.pid = held_lock.pid
      where held_lock.locktype = 'advisory'
        and held_lock.classid = ${barrier.classId}::oid
        and held_lock.objid = ${barrier.objectId}::oid
        and held_lock.objsubid = 2
        and held_lock.granted
        and owner_activity.application_name = ${quoted(ownerApplicationName)}
    ) then
      return;
    end if;

    exit when clock_timestamp() >= deadline;
    perform pg_sleep(0.1);
  end loop;

  raise exception using message = 'phase13j_coordination_lock_not_ready';
end;
$phase13j_race$;
commit;`;
}

export function buildBlockedSessionProbeSql(
  applicationName: string,
  blockerApplicationName: string,
) {
  return `
begin;
set local statement_timeout = '${PROBE_TIMEOUT_SECONDS + 2}s';
do $phase13j_race$
declare
  deadline timestamptz := clock_timestamp() + interval '${PROBE_TIMEOUT_SECONDS} seconds';
begin
  loop
    if exists (
      select 1
      from pg_stat_activity activity
      where activity.application_name = ${quoted(applicationName)}
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and activity.wait_event is not null
        and exists (
          select 1
          from unnest(pg_blocking_pids(activity.pid)) as blocking(blocker_pid)
          join pg_stat_activity expected_blocker
            on expected_blocker.pid = blocking.blocker_pid
          where expected_blocker.application_name = ${quoted(blockerApplicationName)}
        )
    ) then
      return;
    end if;

    exit when clock_timestamp() >= deadline;
    perform pg_sleep(0.1);
  end loop;

  raise exception using message = 'phase13j_blocked_session_not_ready';
end;
$phase13j_race$;
commit;`;
}

export function buildHarnessSessionDrainProbeSql() {
  return `
begin;
set local statement_timeout = '${SESSION_DRAIN_TIMEOUT_SECONDS + 2}s';
do $phase13j_race$
declare
  deadline timestamptz := clock_timestamp() + interval '${SESSION_DRAIN_TIMEOUT_SECONDS} seconds';
begin
  loop
    if not exists (
      select 1
      from pg_stat_activity activity
      where activity.application_name in (
        ${HARNESS_APPLICATION_NAMES.map(quoted).join(",\n        ")}
      )
    ) then
      return;
    end if;

    exit when clock_timestamp() >= deadline;
    perform pg_sleep(0.1);
  end loop;

  raise exception using message = 'phase13j_harness_sessions_did_not_drain';
end;
$phase13j_race$;
commit;`;
}

export function buildMvccVerificationSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
do $phase13j_race$
begin
  if (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = ${uuid(fixture.workspaceId)}
      and assignment.grammar_topic_id = ${uuid(fixture.mvccTopicId)}
  ) <> 1 then
    raise exception using message = 'phase13j_mvcc_replacement_created';
  end if;

  if not exists (
    select 1
    from public.student_practice_assignments assignment
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
     and job.status_revision = assignment.status_revision
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
    where assignment.id = ${uuid(fixture.mvccAssignmentId)}
      and assignment.status = 'failed'
      and assignment.status_revision = 1
      and job.target_status = 'failed'
      and job.processed_at is null
      and cycle.active_assignment_id = assignment.id
      and cycle.resolved_at is null
  ) then
    raise exception using message = 'phase13j_mvcc_terminal_state_invalid';
  end if;
end;
$phase13j_race$;

update app_private.practice_assignment_cycle_transition_jobs job
set next_retry_at = now() + interval '1 hour'
where job.assignment_id = ${uuid(fixture.mvccAssignmentId)};
`;
}

export function buildWorkerFixtureTransitionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
update public.student_practice_assignments assignment
set status = 'failed', completed_at = now()
where assignment.id = ${uuid(fixture.workerAssignmentId)};
commit;`;
}

export function buildWorkerSessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '${RACE_LOCK_TIMEOUT_SECONDS}s';
set local statement_timeout = '${RACE_STATEMENT_TIMEOUT_SECONDS}s';
set local application_name = ${quoted(WORKER_APPLICATION)};
select job.id
from app_private.practice_assignment_cycle_transition_jobs job
where job.assignment_id = ${uuid(fixture.workerAssignmentId)}
  and job.status_revision = 1
for update;
select pg_advisory_xact_lock(
  hashtextextended(
    concat_ws(
      ':',
      ${quoted(fixture.workspaceId)},
      ${quoted(fixture.studentId)},
      ${quoted(fixture.workerTopicId)}
    ),
    0
  )
);
select pg_advisory_xact_lock(${WORKER_BARRIER.classId}, ${WORKER_BARRIER.objectId});
select pg_sleep(${BLOCKING_OWNER_HOLD_SECONDS});
${serviceContextSql()}
select api.process_practice_cycle_transition_jobs(10);
reset role;
commit;`;
}

export function buildTeacherReassignmentSessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '${RACE_LOCK_TIMEOUT_SECONDS}s';
set local statement_timeout = '${RACE_STATEMENT_TIMEOUT_SECONDS}s';
set local application_name = ${quoted(TEACHER_APPLICATION)};
${authenticatedTeacherContextSql()}
select api.reassign_practice_assignment(
  ${uuid(fixture.workerAssignmentId)},
  'Use the replacement created by the settled transition worker.',
  0
);
reset role;
commit;`;
}

export function buildWorkerRaceVerificationSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
do $phase13j_race$
declare
  replacement_id uuid;
begin
  select cycle.active_assignment_id
  into replacement_id
  from app_private.practice_resolution_cycles cycle
  where cycle.id = ${uuid(fixture.workerCycleId)}
    and cycle.resolved_at is null
    and cycle.state = 'unlocked';

  if replacement_id is null then
    raise exception using message = 'phase13j_worker_replacement_missing';
  end if;

  if (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = ${uuid(fixture.workspaceId)}
      and assignment.grammar_topic_id = ${uuid(fixture.workerTopicId)}
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ) <> 1 then
    raise exception using message = 'phase13j_worker_active_count_invalid';
  end if;

  if not exists (
    select 1
    from public.student_practice_assignments assignment
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = ${uuid(fixture.workerAssignmentId)}
    join app_private.practice_teacher_actions action
      on action.assignment_id = ${uuid(fixture.workerAssignmentId)}
     and action.related_assignment_id = replacement_id
    where assignment.id = replacement_id
      and assignment.previous_assignment_id = ${uuid(fixture.workerAssignmentId)}
      and assignment.status = 'unlocked'
      and assignment.batch_id = ${uuid(fixture.batchId)}
      and assignment.worksheet_level = 'B2'
      and job.processed_at is not null
      and job.failure_count = 0
      and action.action_type = 'assignment_reassigned'
      and action.action_revision = 1
  ) then
    raise exception using message = 'phase13j_worker_teacher_audit_invalid';
  end if;
end;
$phase13j_race$;`;
}

export function buildLegacyContextRecoverySessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '${RACE_LOCK_TIMEOUT_SECONDS}s';
set local statement_timeout = '${RACE_STATEMENT_TIMEOUT_SECONDS}s';
set local application_name = ${quoted(LEGACY_CONTEXT_OWNER_APPLICATION)};
select assignment.id
from public.student_practice_assignments assignment
where assignment.id = ${uuid(fixture.legacyCurrentAssignmentId)}
for update;
select pg_advisory_xact_lock(
  ${LEGACY_CONTEXT_BARRIER.classId},
  ${LEGACY_CONTEXT_BARRIER.objectId}
);
select pg_sleep(${BLOCKING_OWNER_HOLD_SECONDS});
${authenticatedTeacherContextSql()}
select api.resolve_practice_assignment_class_context(
  ${uuid(fixture.legacyCurrentAssignmentId)},
  ${uuid(fixture.batchId)}
);
reset role;
commit;`;
}

export function buildLegacyHistoricalReassignmentSessionSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
begin;
set local lock_timeout = '2s';
set local statement_timeout = '8s';
set local application_name = ${quoted(LEGACY_REASSIGN_APPLICATION)};
${authenticatedTeacherContextSql()}
do $phase13j_expected_rejection$
declare
  rejection_started_at timestamptz := clock_timestamp();
begin
  perform api.reassign_practice_assignment(
    ${uuid(fixture.legacyHistoricalAssignmentId)},
    'Resolve the current legacy class context before historical reassignment.',
    0
  );
  raise exception using message = 'phase13j_legacy_reassignment_unexpectedly_succeeded';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'practice_class_context_resolution_pending' then
      raise;
    end if;

    if clock_timestamp() - rejection_started_at >= interval '5 seconds' then
      raise exception using message = 'phase13j_legacy_reassignment_not_fast';
    end if;

end;
$phase13j_expected_rejection$;
reset role;
do $phase13j_overlap_witness$
begin
  if not exists (
    select 1
    from pg_locks held_lock
    join pg_stat_activity owner_activity
      on owner_activity.pid = held_lock.pid
    where held_lock.locktype = 'advisory'
      and held_lock.classid = ${LEGACY_CONTEXT_BARRIER.classId}::oid
      and held_lock.objid = ${LEGACY_CONTEXT_BARRIER.objectId}::oid
      and held_lock.objsubid = 2
      and held_lock.granted
      and owner_activity.application_name = ${quoted(LEGACY_CONTEXT_OWNER_APPLICATION)}
  ) then
    raise exception using message = 'phase13j_legacy_owner_barrier_missing';
  end if;
end;
$phase13j_overlap_witness$;
select
  'practice_class_context_resolution_pending' as safe_rejection,
  ${quoted(LEGACY_REJECTION_SENTINEL)} as overlap_proof;
commit;`;
}

export function buildLegacyContextRaceVerificationSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  return `
do $phase13j_race$
begin
  if not exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    where cycle.id = ${uuid(fixture.legacyCycleId)}
      and cycle.class_context_version = 1
      and cycle.class_context_integrity = 'teacher_verified'
      and cycle.batch_id = ${uuid(fixture.batchId)}
      and cycle.worksheet_level = 'B2'
      and assignment.id = ${uuid(fixture.legacyCurrentAssignmentId)}
      and assignment.class_context_version = 1
      and assignment.class_context_integrity = 'teacher_verified'
      and assignment.batch_id = ${uuid(fixture.batchId)}
      and assignment.worksheet_level = 'B2'
  ) then
    raise exception using message = 'phase13j_legacy_context_recovery_invalid';
  end if;

  if (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = ${uuid(fixture.workspaceId)}
      and assignment.grammar_topic_id = ${uuid(fixture.legacyTopicId)}
  ) <> 2 then
    raise exception using message = 'phase13j_legacy_replacement_created';
  end if;

  if exists (
    select 1
    from app_private.practice_teacher_actions action
    where action.assignment_id = ${uuid(fixture.legacyHistoricalAssignmentId)}
  ) then
    raise exception using message = 'phase13j_legacy_teacher_action_created';
  end if;
end;
$phase13j_race$;`;
}

export function buildPracticeTransitionZeroResidueSql() {
  const fixture = PRACTICE_TRANSITION_FIXTURE;
  const ids = [
    fixture.teacherId,
    fixture.studentId,
    fixture.workspaceId,
    fixture.batchId,
    fixture.mvccTopicId,
    fixture.workerTopicId,
    fixture.legacyTopicId,
    fixture.mvccCycleId,
    fixture.workerCycleId,
    fixture.legacyCycleId,
    fixture.mvccAssignmentId,
    fixture.workerAssignmentId,
    fixture.legacyCurrentAssignmentId,
    fixture.legacyHistoricalAssignmentId,
  ]
    .map(uuid)
    .join(", ");
  return `
do $phase13j_race$
declare
  residue_count bigint;
begin
  select sum(candidate.count_value)
  into residue_count
  from (
    select count(*)::bigint as count_value from auth.users where id in (${ids})
    union all select count(*) from public.profiles where id in (${ids})
    union all select count(*) from public.workspaces
      where id = ${uuid(fixture.workspaceId)} or slug = ${quoted(fixture.workspaceSlug)}
    union all select count(*) from public.batches
      where id = ${uuid(fixture.batchId)} or workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from public.workspace_members
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from app_private.teacher_entitlements
      where user_id in (
        ${uuid(fixture.teacherId)},
        ${uuid(fixture.studentId)}
      )
    union all select count(*) from public.batch_students
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from public.grammar_topics
      where id in (
        ${uuid(fixture.mvccTopicId)},
        ${uuid(fixture.workerTopicId)},
        ${uuid(fixture.legacyTopicId)}
      )
    union all select count(*) from public.student_grammar_stats
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from public.student_practice_assignments
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from app_private.practice_resolution_cycles
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from app_private.practice_resolution_cycle_events
      where cycle_id in (
        ${uuid(fixture.mvccCycleId)},
        ${uuid(fixture.workerCycleId)},
        ${uuid(fixture.legacyCycleId)}
      )
    union all select count(*) from app_private.practice_level_fit_reconciliation_failures
      where cycle_id in (
        ${uuid(fixture.mvccCycleId)},
        ${uuid(fixture.workerCycleId)},
        ${uuid(fixture.legacyCycleId)}
      )
    union all select count(*) from app_private.practice_level_fit_opt_ins
      where cycle_id in (
        ${uuid(fixture.mvccCycleId)},
        ${uuid(fixture.workerCycleId)},
        ${uuid(fixture.legacyCycleId)}
      )
    union all select count(*) from app_private.practice_assignment_cycle_transition_jobs
      where workspace_id = ${uuid(fixture.workspaceId)}
    union all select count(*) from app_private.practice_teacher_actions
      where workspace_id = ${uuid(fixture.workspaceId)}
  ) candidate;

  if coalesce(residue_count, 0) <> 0 then
    raise exception using message = 'phase13j_race_cleanup_residue_detected';
  end if;
end;
$phase13j_race$;`;
}

const activeChildren = new Set<ChildProcess>();

async function terminateActiveChildren() {
  for (const child of activeChildren) child.kill("SIGTERM");
  for (
    let attempt = 1;
    attempt <= 40 && activeChildren.size > 0;
    attempt += 1
  ) {
    await sleep(50);
  }
  if (activeChildren.size > 0) {
    for (const child of activeChildren) child.kill("SIGKILL");
    for (
      let attempt = 1;
      attempt <= 40 && activeChildren.size > 0;
      attempt += 1
    ) {
      await sleep(50);
    }
  }
}

async function runSql(
  options: HarnessOptions,
  sql: string,
): Promise<CommandResult> {
  const startedAtMs = performance.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(options.cliPath, ["db", "query", "--linked", sql], {
      cwd: options.repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    let killEscalation: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killEscalation = setTimeout(() => {
        if (activeChildren.has(child)) child.kill("SIGKILL");
      }, CHILD_KILL_GRACE_MS);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      stderr += error instanceof Error ? error.message : "spawn_failed";
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      activeChildren.delete(child);
      const endedAtMs = performance.now();
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        exitCode,
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
  return (
    `${result.stderr}\n${result.stdout}`
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, 700) || "no diagnostic returned"
  );
}

async function resultIfSettled(
  resultPromise: Promise<CommandResult>,
  waitMs: number,
) {
  return await Promise.race([
    resultPromise.then((result) => ({ settled: true as const, result })),
    sleep(waitMs).then(() => ({ settled: false as const })),
  ]);
}

async function runSqlChecked(
  options: HarnessOptions,
  label: string,
  sql: string,
) {
  const result = await runSql(options, sql);
  if (!result.ok) {
    throw new PracticeTransitionRaceError(
      `${label}_failed`,
      `${label} failed: ${safeFailure(result)}`,
    );
  }
  return result;
}

async function runSqlCheckedWithRetry(
  options: HarnessOptions,
  label: string,
  sql: string,
  attempts: number,
) {
  let finalResult: CommandResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    finalResult = await runSql(options, sql);
    if (finalResult.ok) return finalResult;
    if (attempt < attempts) {
      await sleep(CLEANUP_RETRY_DELAY_MS * attempt);
    }
  }

  throw new PracticeTransitionRaceError(
    `${label}_failed`,
    `${label} failed after ${attempts} bounded attempts: ${safeFailure(finalResult!)}`,
  );
}

async function waitForBarrier(
  options: HarnessOptions,
  barrier: AdvisoryBarrier,
  ownerApplicationName: string,
) {
  const result = await runSql(
    options,
    buildBarrierProbeSql(barrier, ownerApplicationName),
  );
  if (result.ok) return;
  throw new PracticeTransitionRaceError(
    "coordination_lock_missing",
    `The race owner did not expose its bounded advisory barrier: ${safeFailure(result)}`,
  );
}

async function waitForBlockedSession(
  options: HarnessOptions,
  applicationName: string,
  blockerApplicationName: string,
) {
  const result = await runSql(
    options,
    buildBlockedSessionProbeSql(applicationName, blockerApplicationName),
  );
  if (result.ok) return;
  throw new PracticeTransitionRaceError(
    "blocked_session_missing",
    `${applicationName} never reached a database lock wait behind ${blockerApplicationName}: ${safeFailure(result)}`,
  );
}

async function waitForHarnessSessionsToDrain(options: HarnessOptions) {
  await runSqlChecked(
    options,
    "harness_session_drain",
    buildHarnessSessionDrainProbeSql(),
  );
}

async function resolveOptions(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): Promise<HarnessOptions> {
  const projectRef = environment.PRACTICE_RACE_PROJECT_REF?.trim() ?? "";
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new PracticeTransitionRaceError(
      "project_ref_invalid",
      "PRACTICE_RACE_PROJECT_REF must be the exact linked project ref.",
    );
  }
  if (
    environment.PRACTICE_RACE_CONFIRM !== `${CONFIRMATION_PREFIX}${projectRef}`
  ) {
    throw new PracticeTransitionRaceError(
      "execution_not_confirmed",
      "PRACTICE_RACE_CONFIRM does not authorize this exact linked project.",
    );
  }
  const linkedRef = (
    await readFile(
      resolve(repositoryRoot, "supabase/.temp/project-ref"),
      "utf8",
    )
  ).trim();
  if (linkedRef !== projectRef) {
    throw new PracticeTransitionRaceError(
      "linked_project_mismatch",
      "The Supabase CLI link does not match PRACTICE_RACE_PROJECT_REF.",
    );
  }
  const configuredCli = environment.SUPABASE_CLI_PATH?.trim() ?? "";
  if (!isAbsolute(configuredCli)) {
    throw new PracticeTransitionRaceError(
      "cli_path_invalid",
      "SUPABASE_CLI_PATH must be an absolute executable path.",
    );
  }
  const cliPath = await realpath(configuredCli);
  const cliStat = await stat(cliPath);
  if (!cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
    throw new PracticeTransitionRaceError(
      "cli_path_invalid",
      "SUPABASE_CLI_PATH is not executable.",
    );
  }
  return { cliPath, projectRef, repositoryRoot };
}

function assertOverlap(
  owner: CommandResult,
  contender: CommandResult,
  label: string,
) {
  if (
    contender.startedAtMs >= owner.endedAtMs ||
    contender.durationMs < 1_000
  ) {
    throw new PracticeTransitionRaceError(
      `${label}_overlap_missing`,
      `${label} did not overlap for a bounded database lock wait.`,
    );
  }
}

function assertFastOverlap(
  owner: CommandResult,
  contender: CommandResult,
  label: string,
) {
  if (
    contender.startedAtMs >= owner.endedAtMs ||
    !contender.stdout.includes(LEGACY_REJECTION_SENTINEL)
  ) {
    throw new PracticeTransitionRaceError(
      `${label}_fast_rejection_missing`,
      `${label} did not prove a bounded database-side rejection while the legacy owner still held its barrier.`,
    );
  }
}

export async function runPracticeTransitionRaces(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))),
): Promise<RaceResult> {
  const options = await resolveOptions(environment, repositoryRoot);
  const lifecycle = createPracticeTransitionRaceLifecycle();
  const cleanup = () =>
    lifecycle.runCleanup(async () => {
      await lifecycle.trackMutatingOperation(
        runSqlCheckedWithRetry(
          options,
          "fixture_cleanup",
          buildHarnessApplicationSql(
            CLEANUP_APPLICATION,
            buildPracticeTransitionCleanupSql(),
          ),
          CLEANUP_ATTEMPTS,
        ),
      );
      await runSqlCheckedWithRetry(
        options,
        "zero_residue",
        buildPracticeTransitionZeroResidueSql(),
        CLEANUP_ATTEMPTS,
      );
    });
  const shutdown = () =>
    lifecycle.runShutdown(async () => {
      let drainFailure: unknown;
      let cleanupFailure: unknown;
      let mutationSettleFailure: unknown;
      const mutationsSettled = await lifecycle.settleMutatingOperations(
        MUTATING_SETTLE_TIMEOUT_MS,
      );
      if (!mutationsSettled) {
        mutationSettleFailure = new PracticeTransitionRaceError(
          "mutating_operations_did_not_settle",
          "A submitted mutating Management API command exceeded its bounded settle window.",
        );
      }
      await terminateActiveChildren();
      await lifecycle.settleCurrentCleanup();
      await terminateActiveChildren();
      try {
        await waitForHarnessSessionsToDrain(options);
      } catch (error: unknown) {
        drainFailure = error;
      }

      try {
        lifecycle.prepareShutdownCleanup();
        await cleanup();
      } catch (error: unknown) {
        cleanupFailure = error;
      }

      if (cleanupFailure) throw cleanupFailure;
      if (drainFailure) throw drainFailure;
      if (mutationSettleFailure) throw mutationSettleFailure;
    });
  const startMutatingSql = (label: string, sql: string) => {
    lifecycle.assertActive(label);
    return lifecycle.trackMutatingOperation(runSql(options, sql));
  };
  const runMutatingSqlChecked = (
    label: keyof typeof MUTATING_APPLICATION_NAMES,
    sql: string,
  ) => {
    lifecycle.assertActive(label);
    return lifecycle.trackMutatingOperation(
      runSqlChecked(
        options,
        label,
        buildHarnessApplicationSql(MUTATING_APPLICATION_NAMES[label], sql),
      ),
    );
  };

  let completed = false;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    lifecycle.requestAbort();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void shutdown().catch(() => {
      console.error("practice_transition_shutdown_failed");
    });
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    await cleanup();
    lifecycle.prepareForMutations();
    await runMutatingSqlChecked(
      "fixture_setup",
      buildPracticeTransitionSetupSql(),
    );

    const mvccOwnerPromise = startMutatingSql(
      "mvcc_terminal_session",
      buildMvccTerminalSessionSql(),
    );
    await waitForBarrier(options, MVCC_BARRIER, MVCC_OWNER_APPLICATION);
    const mvccContenderPromise = startMutatingSql(
      "mvcc_reconcile_session",
      buildMvccReconcileSessionSql(),
    );
    await waitForBlockedSession(
      options,
      MVCC_CONTENDER_APPLICATION,
      MVCC_OWNER_APPLICATION,
    );
    const [mvccOwner, mvccContender] = await Promise.all([
      mvccOwnerPromise,
      mvccContenderPromise,
    ]);
    if (!mvccOwner.ok || !mvccContender.ok) {
      throw new PracticeTransitionRaceError(
        "mvcc_race_failed",
        `MVCC sessions failed: owner=${safeFailure(mvccOwner)} contender=${safeFailure(mvccContender)}`,
      );
    }
    if (
      !mvccContender.stdout.includes(
        PRACTICE_TRANSITION_FIXTURE.mvccAssignmentId,
      )
    ) {
      throw new PracticeTransitionRaceError(
        "mvcc_terminal_not_preserved",
        "The blocked selector did not return the original terminal assignment.",
      );
    }
    assertOverlap(mvccOwner, mvccContender, "mvcc_race");
    await runMutatingSqlChecked(
      "mvcc_verification",
      buildMvccVerificationSql(),
    );

    await runMutatingSqlChecked(
      "worker_fixture_transition",
      buildWorkerFixtureTransitionSql(),
    );
    const workerPromise = startMutatingSql(
      "worker_transition_session",
      buildWorkerSessionSql(),
    );
    await waitForBarrier(options, WORKER_BARRIER, WORKER_APPLICATION);
    const teacherPromise = startMutatingSql(
      "teacher_reassignment_session",
      buildTeacherReassignmentSessionSql(),
    );
    try {
      await waitForBlockedSession(
        options,
        TEACHER_APPLICATION,
        WORKER_APPLICATION,
      );
    } catch (error) {
      const earlyTeacher = await resultIfSettled(teacherPromise, 1_000);
      if (earlyTeacher.settled) {
        throw new PracticeTransitionRaceError(
          "teacher_completed_before_expected_lock",
          `The teacher reassignment completed before the expected worker lock wait: ${safeFailure(earlyTeacher.result)}`,
        );
      }
      throw error;
    }
    const [worker, teacher] = await Promise.all([
      workerPromise,
      teacherPromise,
    ]);
    if (!worker.ok || !teacher.ok) {
      throw new PracticeTransitionRaceError(
        "worker_reassignment_race_failed",
        `Worker/teacher sessions failed: worker=${safeFailure(worker)} teacher=${safeFailure(teacher)}`,
      );
    }
    assertOverlap(worker, teacher, "worker_reassignment_race");
    await runSqlChecked(
      options,
      "worker_race_verification",
      buildWorkerRaceVerificationSql(),
    );

    const legacyContextOwnerPromise = startMutatingSql(
      "legacy_context_recovery_session",
      buildLegacyContextRecoverySessionSql(),
    );
    await waitForBarrier(
      options,
      LEGACY_CONTEXT_BARRIER,
      LEGACY_CONTEXT_OWNER_APPLICATION,
    );
    const legacyReassignmentPromise = startMutatingSql(
      "legacy_historical_reassignment_session",
      buildLegacyHistoricalReassignmentSessionSql(),
    );
    const [legacyContextOwner, legacyReassignment] = await Promise.all([
      legacyContextOwnerPromise,
      legacyReassignmentPromise,
    ]);
    if (!legacyContextOwner.ok || !legacyReassignment.ok) {
      throw new PracticeTransitionRaceError(
        "legacy_context_race_failed",
        `Legacy context sessions failed: owner=${safeFailure(legacyContextOwner)} contender=${safeFailure(legacyReassignment)}`,
      );
    }
    if (
      !legacyReassignment.stdout.includes(
        "practice_class_context_resolution_pending",
      )
    ) {
      throw new PracticeTransitionRaceError(
        "legacy_context_safe_rejection_missing",
        "Historical reassignment did not return the stable legacy-context rejection.",
      );
    }
    assertFastOverlap(
      legacyContextOwner,
      legacyReassignment,
      "legacy_context_race",
    );
    await runSqlChecked(
      options,
      "legacy_context_race_verification",
      buildLegacyContextRaceVerificationSql(),
    );

    completed = true;
    return {
      status: "passed",
      project_ref: options.projectRef,
      mvcc_overlap_observed: true,
      worker_reassignment_overlap_observed: true,
      legacy_context_overlap_observed: true,
      legacy_reassignment_rejected: true,
      mvcc_replacement_count: 0,
      worker_replacement_count: 1,
      teacher_action_count: 1,
      zero_residue: true,
    };
  } finally {
    try {
      let finalizationFailure: unknown;
      try {
        if (!completed || lifecycle.abortRequested) {
          await shutdown();
        } else {
          await cleanup();
        }
      } catch (error: unknown) {
        finalizationFailure = error;
      }

      if (lifecycle.abortRequested) {
        try {
          await shutdown();
          finalizationFailure = new PracticeTransitionRaceError(
            "execution_interrupted",
            "The race harness was interrupted after session drain and zero-residue cleanup.",
          );
        } catch (error: unknown) {
          finalizationFailure = error;
        }
      }

      if (finalizationFailure) throw finalizationFailure;
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
}

async function main() {
  console.log(JSON.stringify(await runPracticeTransitionRaces(), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    if (error instanceof PracticeTransitionRaceError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error("practice_transition_races_failed");
    }
    if (!process.exitCode) process.exitCode = 1;
  });
}
