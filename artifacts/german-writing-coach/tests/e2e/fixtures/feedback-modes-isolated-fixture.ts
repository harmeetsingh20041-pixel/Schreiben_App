import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createFeedbackModesRecoveryManifest,
  readFeedbackModesRecoveryManifest,
  removeFeedbackModesRecoveryManifest,
  type FeedbackModesRecoveryManifest,
} from "./feedback-modes-recovery-manifest";

export interface FeedbackModeFixtureCredentials {
  email: string;
  password: string;
}

export interface FeedbackModesIsolatedFixture {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  teacherMembershipId: string;
  teacherProfileId: string;
  studentProfileId: string;
  teacherMembershipCount: number;
  teacherMembershipFingerprint: string;
  studentMembershipCount: number;
  studentMembershipFingerprint: string;
}

interface AccountMembershipSnapshot {
  teacherProfileId: string;
  studentProfileId: string;
  teacherMembershipCount: number;
  teacherMembershipFingerprint: string;
  studentMembershipCount: number;
  studentMembershipFingerprint: string;
}

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const PRIVATE_SQL_MAX_BUFFER = 1024 * 1024;
const PRIVATE_SQL_SAFE_ERROR_PATTERN = /\bfeedback_modes_fixture_[a-z0-9_]+\b/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_PATTERN =
  /feedback_modes_fixture_snapshot\|([0-9a-f-]{36})\|([0-9]+)\|([0-9a-f]{32})\|([0-9a-f-]{36})\|([0-9]+)\|([0-9a-f]{32})/i;

export const feedbackModesRecoveryOnly =
  process.env.E2E_FEEDBACK_MODES_RECOVERY_ONLY === "true";

class PrivateSqlError extends Error {
  constructor(readonly safeCode: string) {
    super(`Private staging SQL failed (${safeCode}).`);
    this.name = "PrivateSqlError";
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the isolated feedback-mode run.`);
  }
  return value;
}

function repositoryRoot() {
  return resolve(process.cwd(), "../..");
}

function recoveryManifestPath() {
  return resolve(repositoryRoot(), ".e2e-private/feedback-modes-fixture.json");
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("The feedback-mode fixture received an invalid UUID.");
  }
  return value;
}

function sqlUuid(value: string) {
  return `'${requireUuid(value)}'::uuid`;
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The feedback-mode fixture received an invalid value.");
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
    throw new Error("The feedback-mode fixture could not verify staging.");
  }
  if (linkedProjectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error(
      "The feedback-mode fixture is not linked to pinned staging.",
    );
  }
}

function runPrivateLinkedSql(sql: string) {
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
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    const safeCode =
      [result.stdout, result.stderr]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.match(PRIVATE_SQL_SAFE_ERROR_PATTERN)?.[0])
        .find((value): value is string => Boolean(value)) ??
      "feedback_modes_fixture_database_command_failed";
    throw new PrivateSqlError(safeCode);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function membershipFingerprintSql(profileIdExpression: string) {
  return `md5(coalesce((
    select jsonb_agg(to_jsonb(member) order by member.id)::text
    from public.workspace_members member
    where member.user_id = ${profileIdExpression}
  ), '[]'))`;
}

function accountSnapshotSql(
  teacher: FeedbackModeFixtureCredentials,
  student: FeedbackModeFixtureCredentials,
) {
  return `
do $feedback_modes_snapshot_guard$
begin
  if (
    select count(*) from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(teacher.email)})
  ) <> 1 or (
    select count(*) from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(student.email)})
  ) <> 1 then
    raise exception using message = 'feedback_modes_fixture_accounts_invalid';
  end if;
end;
$feedback_modes_snapshot_guard$;

with selected as (
  select
    (select profile.id from public.profiles profile
      where lower(profile.email) = lower(${sqlLiteral(teacher.email)})) as teacher_id,
    (select profile.id from public.profiles profile
      where lower(profile.email) = lower(${sqlLiteral(student.email)})) as student_id
)
select concat_ws(
  '|',
  'feedback_modes_fixture_snapshot',
  selected.teacher_id::text,
  (select count(*) from public.workspace_members member
    where member.user_id = selected.teacher_id)::text,
  ${membershipFingerprintSql("selected.teacher_id")},
  selected.student_id::text,
  (select count(*) from public.workspace_members member
    where member.user_id = selected.student_id)::text,
  ${membershipFingerprintSql("selected.student_id")}
)
from selected;
`;
}

function readAccountSnapshot(
  teacher: FeedbackModeFixtureCredentials,
  student: FeedbackModeFixtureCredentials,
): AccountMembershipSnapshot {
  const output = runPrivateLinkedSql(accountSnapshotSql(teacher, student));
  const match = output.match(SNAPSHOT_PATTERN);
  if (!match) {
    throw new Error("The private membership snapshot could not be verified.");
  }
  const teacherMembershipCount = Number.parseInt(match[2] ?? "", 10);
  const studentMembershipCount = Number.parseInt(match[5] ?? "", 10);
  if (
    !Number.isSafeInteger(teacherMembershipCount) ||
    teacherMembershipCount < 0 ||
    !Number.isSafeInteger(studentMembershipCount) ||
    studentMembershipCount < 0
  ) {
    throw new Error("The private membership snapshot was invalid.");
  }
  return {
    teacherProfileId: requireUuid(match[1] ?? ""),
    teacherMembershipCount,
    teacherMembershipFingerprint: match[3]!.toLowerCase(),
    studentProfileId: requireUuid(match[4] ?? ""),
    studentMembershipCount,
    studentMembershipFingerprint: match[6]!.toLowerCase(),
  };
}

function newFixture(
  snapshot: AccountMembershipSnapshot,
): FeedbackModesIsolatedFixture {
  const workspaceId = randomUUID();
  const suffix = workspaceId.slice(0, 8);
  return {
    workspaceId,
    workspaceName: `V1 feedback modes ${suffix}`,
    workspaceSlug: `e2e-feedback-modes-${workspaceId}`,
    teacherMembershipId: randomUUID(),
    ...snapshot,
  };
}

function manifestFor(
  fixture: FeedbackModesIsolatedFixture,
): FeedbackModesRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PINNED_STAGING_PROJECT_REF,
    workspace_id: fixture.workspaceId,
    teacher_membership_id: fixture.teacherMembershipId,
    teacher_profile_id: fixture.teacherProfileId,
    student_profile_id: fixture.studentProfileId,
    teacher_membership_count: fixture.teacherMembershipCount,
    teacher_membership_fingerprint: fixture.teacherMembershipFingerprint,
    student_membership_count: fixture.studentMembershipCount,
    student_membership_fingerprint: fixture.studentMembershipFingerprint,
  };
}

function fixtureFromManifest(
  manifest: FeedbackModesRecoveryManifest,
): FeedbackModesIsolatedFixture {
  const suffix = manifest.workspace_id.slice(0, 8);
  return {
    workspaceId: manifest.workspace_id,
    workspaceName: `V1 feedback modes ${suffix}`,
    workspaceSlug: `e2e-feedback-modes-${manifest.workspace_id}`,
    teacherMembershipId: manifest.teacher_membership_id,
    teacherProfileId: manifest.teacher_profile_id,
    studentProfileId: manifest.student_profile_id,
    teacherMembershipCount: manifest.teacher_membership_count,
    teacherMembershipFingerprint: manifest.teacher_membership_fingerprint,
    studentMembershipCount: manifest.student_membership_count,
    studentMembershipFingerprint: manifest.student_membership_fingerprint,
  };
}

function setupFixtureSql(target: FeedbackModesIsolatedFixture) {
  return `
begin;
do $feedback_modes_fixture_setup$
declare
  teacher_role text;
  student_role text;
begin
  select profile.global_role into teacher_role
  from public.profiles profile
  where profile.id = ${sqlUuid(target.teacherProfileId)};
  select profile.global_role into student_role
  from public.profiles profile
  where profile.id = ${sqlUuid(target.studentProfileId)};

  if teacher_role not in ('teacher', 'platform_admin')
    or student_role <> 'student'
    or ${sqlUuid(target.teacherProfileId)} = ${sqlUuid(target.studentProfileId)}
  then
    raise exception using message = 'feedback_modes_fixture_roles_invalid';
  end if;

  if (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.teacherProfileId)}) <>
      ${target.teacherMembershipCount}
    or ${membershipFingerprintSql(sqlUuid(target.teacherProfileId))} <>
      ${sqlLiteral(target.teacherMembershipFingerprint)}
    or (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.studentProfileId)}) <>
      ${target.studentMembershipCount}
    or ${membershipFingerprintSql(sqlUuid(target.studentProfileId))} <>
      ${sqlLiteral(target.studentMembershipFingerprint)}
  then
    raise exception using message = 'feedback_modes_fixture_membership_snapshot_changed';
  end if;

  if exists (select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
       or workspace.slug = ${sqlLiteral(target.workspaceSlug)})
    or exists (select 1 from public.workspace_members member
      where member.id = ${sqlUuid(target.teacherMembershipId)})
  then
    raise exception using message = 'feedback_modes_fixture_scope_not_empty';
  end if;

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(target.workspaceId)},
    ${sqlLiteral(target.workspaceName)},
    ${sqlLiteral(target.workspaceSlug)},
    ${sqlUuid(target.teacherProfileId)}
  );
  insert into public.workspace_members (id, workspace_id, user_id, role)
  values (
    ${sqlUuid(target.teacherMembershipId)},
    ${sqlUuid(target.workspaceId)},
    ${sqlUuid(target.teacherProfileId)},
    'teacher'
  );

  if (select count(*) from public.workspace_members member
      where member.workspace_id = ${sqlUuid(target.workspaceId)}) <> 1
    or not exists (
      select 1 from public.workspace_members member
      where member.id = ${sqlUuid(target.teacherMembershipId)}
        and member.workspace_id = ${sqlUuid(target.workspaceId)}
        and member.user_id = ${sqlUuid(target.teacherProfileId)}
        and member.role = 'teacher'
    )
  then
    raise exception using message = 'feedback_modes_fixture_teacher_only_contract_invalid';
  end if;
end;
$feedback_modes_fixture_setup$;
commit;
`;
}

function cleanupFixtureSql(target: FeedbackModesIsolatedFixture) {
  return `
create temp table feedback_modes_cleanup_anomalies (reason text primary key);
begin;

do $feedback_modes_workspace_lock$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(${sqlLiteral(`feedback-modes:${target.workspaceId}`)}, 0)
  );
  perform workspace.id from public.workspaces workspace
  where workspace.id = ${sqlUuid(target.workspaceId)} for update;
end;
$feedback_modes_workspace_lock$;

create temp table feedback_modes_submission_ids (id uuid primary key) on commit drop;
insert into pg_temp.feedback_modes_submission_ids (id)
select submission.id from public.submissions submission
where submission.workspace_id = ${sqlUuid(target.workspaceId)};

do $feedback_modes_entity_locks$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(concat_ws(':', 'paid-job-entity', 'writing_evaluation', fixture.id), 0)
  ) from pg_temp.feedback_modes_submission_ids fixture order by fixture.id;
end;
$feedback_modes_entity_locks$;

create temp table feedback_modes_job_ids (
  id uuid primary key,
  entity_id uuid not null,
  entity_version integer not null,
  queue_message_id bigint,
  status text not null
) on commit drop;
insert into pg_temp.feedback_modes_job_ids
select job.id, job.entity_id, job.entity_version, job.queue_message_id, job.status
from app_private.async_jobs job
where job.entity_id in (select id from pg_temp.feedback_modes_submission_ids);

do $feedback_modes_job_locks$
begin
  perform job.id from app_private.async_jobs job
  where job.id in (select id from pg_temp.feedback_modes_job_ids)
  order by job.id for update;
  perform reservation.id from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = ${sqlUuid(target.workspaceId)}
  order by reservation.id for update;
end;
$feedback_modes_job_locks$;

do $feedback_modes_scope_guard$
declare
  workspace_exists boolean := exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
  );
begin
  if workspace_exists and not exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(target.workspaceId)}
      and workspace.name = ${sqlLiteral(target.workspaceName)}
      and workspace.slug = ${sqlLiteral(target.workspaceSlug)}
      and workspace.owner_id = ${sqlUuid(target.teacherProfileId)}
  ) then
    raise exception using message = 'feedback_modes_fixture_identity_mismatch';
  end if;

  if exists (
    select 1 from public.workspace_members member
    where member.workspace_id = ${sqlUuid(target.workspaceId)}
      and not (
        (member.id = ${sqlUuid(target.teacherMembershipId)}
          and member.user_id = ${sqlUuid(target.teacherProfileId)}
          and member.role = 'teacher')
        or (member.user_id = ${sqlUuid(target.studentProfileId)}
          and member.role = 'student')
      )
  ) or (select count(*) from public.workspace_members member
    where member.workspace_id = ${sqlUuid(target.workspaceId)}) > 2 then
    raise exception using message = 'feedback_modes_fixture_membership_scope_invalid';
  end if;

  if exists (
    select 1 from public.batches batch
    where batch.workspace_id = ${sqlUuid(target.workspaceId)}
      and not (
        (batch.name like 'V1 feedback review %'
          and batch.feedback_mode = 'teacher_review_only')
        or (batch.name like 'V1 scheduled feedback %'
          and batch.feedback_mode = 'automatic_delayed')
      )
  ) or (select count(*) from public.batches batch
    where batch.workspace_id = ${sqlUuid(target.workspaceId)}) > 2 then
    raise exception using message = 'feedback_modes_fixture_batch_scope_invalid';
  end if;

  if exists (
    select 1 from public.batch_students assignment
    where assignment.workspace_id = ${sqlUuid(target.workspaceId)}
      and (
        assignment.student_id <> ${sqlUuid(target.studentProfileId)}
        or not exists (select 1 from public.batches batch
          where batch.id = assignment.batch_id
            and batch.workspace_id = assignment.workspace_id)
      )
  ) then
    raise exception using message = 'feedback_modes_fixture_assignment_scope_invalid';
  end if;

  if (select count(*) from pg_temp.feedback_modes_submission_ids) > 2
    or exists (
      select 1 from public.submissions submission
      where submission.id in (select id from pg_temp.feedback_modes_submission_ids)
        and (submission.student_id <> ${sqlUuid(target.studentProfileId)}
          or not exists (select 1 from public.batches batch
            where batch.id = submission.batch_id
              and batch.workspace_id = submission.workspace_id))
    )
  then
    raise exception using message = 'feedback_modes_fixture_submission_scope_invalid';
  end if;

  if exists (select 1 from pg_temp.feedback_modes_job_ids job
    where job.status in ('queued', 'processing', 'retry')) then
    raise exception using message = 'feedback_modes_fixture_job_not_terminal';
  end if;
  if exists (select 1 from app_private.async_jobs job
    where job.id in (select id from pg_temp.feedback_modes_job_ids)
      and (job.job_kind <> 'writing_evaluation'
        or job.queue_name <> 'writing_evaluation')) then
    raise exception using message = 'feedback_modes_fixture_job_scope_invalid';
  end if;
  if exists (select 1 from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = ${sqlUuid(target.workspaceId)}
      and (reservation.state = 'reserved'
        or reservation.job_id not in (select id from pg_temp.feedback_modes_job_ids)))
  then
    raise exception using message = 'feedback_modes_fixture_spend_not_terminal';
  end if;

  if (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.teacherProfileId)}
        and member.workspace_id <> ${sqlUuid(target.workspaceId)}) <>
      ${target.teacherMembershipCount}
    or md5(coalesce((select jsonb_agg(to_jsonb(member) order by member.id)::text
      from public.workspace_members member
      where member.user_id = ${sqlUuid(target.teacherProfileId)}
        and member.workspace_id <> ${sqlUuid(target.workspaceId)}), '[]')) <>
      ${sqlLiteral(target.teacherMembershipFingerprint)}
    or (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.studentProfileId)}
        and member.workspace_id <> ${sqlUuid(target.workspaceId)}) <>
      ${target.studentMembershipCount}
    or md5(coalesce((select jsonb_agg(to_jsonb(member) order by member.id)::text
      from public.workspace_members member
      where member.user_id = ${sqlUuid(target.studentProfileId)}
        and member.workspace_id <> ${sqlUuid(target.workspaceId)}), '[]')) <>
      ${sqlLiteral(target.studentMembershipFingerprint)}
  then
    raise exception using message = 'feedback_modes_fixture_persistent_membership_changed';
  end if;
end;
$feedback_modes_scope_guard$;

insert into app_private.ai_canary_spend_archive (
  original_reservation_id, original_job_id, entity_version, call_key,
  original_workspace_id, billing_month, provider_name, model_name, call_purpose,
  input_rate_microusd_per_million, output_rate_microusd_per_million,
  reserved_microusd, state, actual_microusd, billed_input_tokens,
  billed_output_tokens, release_reason, usage_estimated, expires_at, created_at,
  finalized_at, released_at
)
select
  reservation.id, reservation.job_id, reservation.entity_version,
  reservation.call_key, reservation.workspace_id, reservation.billing_month,
  reservation.provider_name, reservation.model_name, reservation.call_purpose,
  reservation.input_rate_microusd_per_million,
  reservation.output_rate_microusd_per_million, reservation.reserved_microusd,
  reservation.state, reservation.actual_microusd,
  reservation.billed_input_tokens, reservation.billed_output_tokens,
  reservation.release_reason, reservation.usage_estimated,
  reservation.expires_at, reservation.created_at,
  reservation.finalized_at, reservation.released_at
from app_private.ai_spend_reservations reservation
where reservation.workspace_id = ${sqlUuid(target.workspaceId)};

select set_config('app.ai_spend_transition', 'on', true);
delete from app_private.ai_spend_reservations reservation
where reservation.workspace_id = ${sqlUuid(target.workspaceId)};
select set_config('app.ai_spend_transition', 'off', true);

set local session_replication_role = replica;
delete from pgmq.q_writing_evaluation queue
using pg_temp.feedback_modes_job_ids job
where queue.message ->> 'job_id' = job.id::text
  and queue.message ->> 'entity_id' = job.entity_id::text;
delete from pgmq.a_writing_evaluation queue
using pg_temp.feedback_modes_job_ids job
where queue.message ->> 'job_id' = job.id::text
  and queue.message ->> 'entity_id' = job.entity_id::text;
delete from app_private.provider_outage_recovery_events event
where event.job_id in (select id from pg_temp.feedback_modes_job_ids)
   or event.predecessor_job_id in (select id from pg_temp.feedback_modes_job_ids);
delete from app_private.writing_feedback_adjudications_v2 evidence
where evidence.job_id in (select id from pg_temp.feedback_modes_job_ids)
   or evidence.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.writing_feedback_adjudications evidence
where evidence.job_id in (select id from pg_temp.feedback_modes_job_ids)
   or evidence.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.feedback_draft_events event
where event.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.writing_evaluation_context_holds context_hold
where context_hold.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.writing_evaluation_contexts context
where context.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.feedback_drafts draft
where draft.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from api.submission_status_events event
where event.id in (select id from pg_temp.feedback_modes_submission_ids);
delete from public.submission_lines line
where line.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from public.submission_grammar_topics topic
where topic.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from public.teacher_notes note
where note.submission_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from app_private.async_jobs job
where job.id in (select id from pg_temp.feedback_modes_job_ids)
   or job.entity_id in (select id from pg_temp.feedback_modes_submission_ids);
delete from public.submissions submission
where submission.id in (select id from pg_temp.feedback_modes_submission_ids);

do $feedback_modes_workspace_cleanup$
declare relation_name text;
begin
  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
      and attribute.attname = 'workspace_id'
      and attribute.attnum > 0 and not attribute.attisdropped
    where namespace.nspname in ('api', 'app_private', 'public')
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  loop
    execute format('delete from %s where workspace_id = $1', relation_name)
    using ${sqlUuid(target.workspaceId)};
  end loop;
end;
$feedback_modes_workspace_cleanup$;
delete from public.workspace_members member
where member.workspace_id = ${sqlUuid(target.workspaceId)};
delete from public.workspaces workspace
where workspace.id = ${sqlUuid(target.workspaceId)};
set local session_replication_role = origin;

do $feedback_modes_residue_guard$
declare relation_name text; residue_exists boolean;
begin
  if exists (select 1 from public.workspaces workspace
      where workspace.id = ${sqlUuid(target.workspaceId)})
    or exists (select 1 from app_private.ai_spend_reservations reservation
      where reservation.workspace_id = ${sqlUuid(target.workspaceId)})
    or exists (select 1 from app_private.async_jobs job
      where job.id in (select id from pg_temp.feedback_modes_job_ids)
         or job.entity_id in (select id from pg_temp.feedback_modes_submission_ids))
    or exists (select 1 from pgmq.q_writing_evaluation queue
      join pg_temp.feedback_modes_job_ids job
        on queue.message ->> 'job_id' = job.id::text)
    or exists (select 1 from pgmq.a_writing_evaluation queue
      join pg_temp.feedback_modes_job_ids job
        on queue.message ->> 'job_id' = job.id::text)
  then
    insert into pg_temp.feedback_modes_cleanup_anomalies values ('direct_residue')
    on conflict do nothing;
  end if;

  for relation_name in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
      and attribute.attname = 'workspace_id'
      and attribute.attnum > 0 and not attribute.attisdropped
    where namespace.nspname in ('api', 'app_private', 'public')
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  loop
    execute format('select exists (select 1 from %s where workspace_id = $1)', relation_name)
      into residue_exists using ${sqlUuid(target.workspaceId)};
    if residue_exists then
      insert into pg_temp.feedback_modes_cleanup_anomalies values ('workspace_residue')
      on conflict do nothing;
    end if;
  end loop;

  if (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.teacherProfileId)}) <>
      ${target.teacherMembershipCount}
    or ${membershipFingerprintSql(sqlUuid(target.teacherProfileId))} <>
      ${sqlLiteral(target.teacherMembershipFingerprint)}
    or (select count(*) from public.workspace_members member
      where member.user_id = ${sqlUuid(target.studentProfileId)}) <>
      ${target.studentMembershipCount}
    or ${membershipFingerprintSql(sqlUuid(target.studentProfileId))} <>
      ${sqlLiteral(target.studentMembershipFingerprint)}
  then
    insert into pg_temp.feedback_modes_cleanup_anomalies values ('membership_drift')
    on conflict do nothing;
  end if;
end;
$feedback_modes_residue_guard$;
commit;

do $feedback_modes_cleanup_report$
begin
  if exists (select 1 from pg_temp.feedback_modes_cleanup_anomalies) then
    raise exception using message = 'feedback_modes_fixture_scope_or_cleanup_failed';
  end if;
end;
$feedback_modes_cleanup_report$;
`;
}

export async function recoverPreviousFeedbackModesFixture() {
  const path = recoveryManifestPath();
  const manifest = await readFeedbackModesRecoveryManifest(
    path,
    PINNED_STAGING_PROJECT_REF,
  );
  if (!manifest) return;
  runPrivateLinkedSql(cleanupFixtureSql(fixtureFromManifest(manifest)));
  await removeFeedbackModesRecoveryManifest(path, PINNED_STAGING_PROJECT_REF);
}

export async function prepareFeedbackModesFixture(
  teacher: FeedbackModeFixtureCredentials,
  student: FeedbackModeFixtureCredentials,
) {
  await recoverPreviousFeedbackModesFixture();
  const target = newFixture(readAccountSnapshot(teacher, student));
  await createFeedbackModesRecoveryManifest(
    recoveryManifestPath(),
    manifestFor(target),
    PINNED_STAGING_PROJECT_REF,
  );
  try {
    runPrivateLinkedSql(setupFixtureSql(target));
  } catch (error) {
    await recoverPreviousFeedbackModesFixture();
    const safeCode =
      error instanceof PrivateSqlError
        ? error.safeCode
        : "feedback_modes_fixture_setup_failed";
    throw new Error(
      `Feedback-mode fixture setup failed (${safeCode}); exact cleanup was verified.`,
    );
  }
  return target;
}

export async function cleanupFeedbackModesFixture(
  target: FeedbackModesIsolatedFixture,
) {
  runPrivateLinkedSql(cleanupFixtureSql(target));
  await removeFeedbackModesRecoveryManifest(
    recoveryManifestPath(),
    PINNED_STAGING_PROJECT_REF,
  );
}
