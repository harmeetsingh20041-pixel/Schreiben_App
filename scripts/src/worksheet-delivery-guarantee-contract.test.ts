import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateWorksheet } from "./import-practice-worksheet.js";
import {
  verifyWorksheetDrafts,
  type WorksheetDraftInput,
} from "./verify-a1-worksheet-drafts.js";
import {
  canonicalWorksheetTemplateContexts,
  canonicalWorksheetTopics,
  worksheetLevels,
  type WorksheetLevel,
} from "./verify-worksheet-authoring-matrix.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const deliveryMigrationPath = resolve(
  repositoryRoot,
  "supabase/migrations/20260713080000_phase_13w_worksheet_delivery_guarantee.sql",
);
const currentQualificationMigrationPath = resolve(
  repositoryRoot,
  "supabase/migrations/20260713070804_require_current_worksheet_reviewer_qualification.sql",
);
const authoringMatrixPath = resolve(
  repositoryRoot,
  "quality/worksheet-bank/authoring-matrix.json",
);
const worksheetPreparePath = resolve(
  repositoryRoot,
  "supabase/functions/process-worksheet-generation-jobs/prepare.ts",
);
const worksheetProcessorPath = resolve(
  repositoryRoot,
  "supabase/functions/process-worksheet-generation-jobs/processor.ts",
);
const recoveryHandlerPath = resolve(
  repositoryRoot,
  "supabase/functions/recover-async-jobs/handler.ts",
);

type DraftMetadata = {
  schema_version: number;
  slot_id: string;
  template_key: string;
  revision_number: number;
  authoring_status: string;
  certification_status: string;
  approval_status: string;
};

type FoundationDraft = Record<string, unknown> & {
  draft_metadata: DraftMetadata;
  level: string;
  grammar_topic: { slug?: string };
  visibility: string;
  source: string;
  source_label: string;
  tags: string[];
};

const forbiddenReleaseEvidenceKeys = new Set([
  "bank_certification",
  "reviewer",
  "reviewer_id",
  "reviewed_by",
  "reviewed_at",
  "approved_by",
  "certified_by",
  "released_by",
  "released_at",
  "release_id",
  "release_notes",
  "release_status",
]);

async function readRequiredFile(path: string, label: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`${label} is required at ${path}: ${detail}`);
  }
}

async function readLevelDrafts(level: WorksheetLevel) {
  const directory = resolve(
    repositoryRoot,
    `quality/worksheet-bank/drafts/${level.toLowerCase()}`,
  );
  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  const drafts = await Promise.all(
    fileNames.map(
      async (fileName): Promise<WorksheetDraftInput> => ({
        fileName,
        value: JSON.parse(
          await readFile(resolve(directory, fileName), "utf8"),
        ) as unknown,
      }),
    ),
  );
  return { drafts, fileNames };
}

function releaseEvidencePaths(value: unknown, path = "worksheet"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      releaseEvidencePaths(entry, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];

  const paths: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (forbiddenReleaseEvidenceKeys.has(key.toLowerCase())) {
      paths.push(entryPath);
    }
    paths.push(...releaseEvidencePaths(entry, entryPath));
  }
  return paths;
}

test("the checked-in r1 bank contains every exact A1-B2 foundation context once", async () => {
  const foundationContexts = canonicalWorksheetTemplateContexts.filter(
    (context) => context.revisionNumber === 1,
  );
  assert.equal(canonicalWorksheetTopics.length, 36);
  assert.equal(foundationContexts.length, 144);

  for (const level of worksheetLevels) {
    const expected = foundationContexts
      .filter((context) => context.level === level)
      .map((context) => `${context.templateKey}.json`)
      .sort();
    assert.equal(
      expected.length,
      36,
      `${level} must have 36 canonical r1 slots`,
    );

    const { fileNames } = await readLevelDrafts(level);
    const actual = fileNames.filter((fileName) =>
      fileName.endsWith("-r1.json"),
    );
    assert.deepEqual(
      actual,
      expected,
      `${level} r1 files must equal the closed 36-topic matrix exactly`,
    );
  }
});

test("all 144 foundations remain private unapproved drafts and pass the existing validators", async () => {
  const matrix = JSON.parse(
    await readFile(authoringMatrixPath, "utf8"),
  ) as unknown;
  let validatedFoundationCount = 0;

  for (const level of worksheetLevels) {
    const { drafts } = await readLevelDrafts(level);
    const portfolioReport = verifyWorksheetDrafts(matrix, drafts, level);
    assert.equal(portfolioReport.ok, true, portfolioReport.errors.join("\n"));
    assert.equal(portfolioReport.importerValidDrafts, 46);

    const foundations = drafts.filter((draft) =>
      draft.fileName.endsWith("-r1.json"),
    );
    assert.equal(foundations.length, 36);

    for (const input of foundations) {
      const draft = input.value as FoundationDraft;
      const context = canonicalWorksheetTemplateContexts.find(
        (candidate) =>
          candidate.revisionNumber === 1 &&
          `${candidate.templateKey}.json` === input.fileName,
      );
      assert.ok(context, `unexpected foundation file ${input.fileName}`);

      assert.equal(draft.draft_metadata.schema_version, 1);
      assert.equal(draft.draft_metadata.template_key, context.templateKey);
      assert.equal(draft.draft_metadata.revision_number, 1);
      assert.equal(draft.draft_metadata.authoring_status, "draft_unapproved");
      assert.equal(draft.draft_metadata.certification_status, "not_certified");
      assert.equal(draft.draft_metadata.approval_status, "unapproved");
      assert.equal(draft.level, context.level);
      assert.equal(draft.grammar_topic.slug, context.topicSlug);
      assert.equal(draft.visibility, "private");
      assert.equal(draft.source, "manual_import");
      assert.equal(
        draft.source_label,
        `V1 ${level} draft worksheet; unapproved and not certified`,
      );
      assert.equal(draft.tags.includes("draft"), true);
      assert.equal(draft.tags.includes("unapproved"), true);
      assert.equal(draft.tags.includes("not-certified"), true);
      assert.deepEqual(
        releaseEvidencePaths(draft),
        [],
        `${input.fileName} must not claim review, certification, or release evidence`,
      );

      const importShape = validateWorksheet(draft);
      assert.equal(importShape.level, context.level);
      assert.equal(importShape.grammar_topic.slug, context.topicSlug);
      assert.equal(importShape.visibility, "private");
      assert.equal(importShape.source, "manual_import");
      validatedFoundationCount += 1;
    }
  }

  assert.equal(validatedFoundationCount, 144);
});

test("terminal rescue can attach only the current exact qualified bank revision", async () => {
  const [migration, qualificationMigration] = await Promise.all([
    readRequiredFile(deliveryMigrationPath, "worksheet delivery migration"),
    readRequiredFile(
      currentQualificationMigrationPath,
      "current worksheet qualification migration",
    ),
  ]);

  assert.match(
    qualificationMigration,
    /create or replace function public\.select_released_worksheet_template_internal\([\s\S]*template\.grammar_topic_id = target_grammar_topic_id[\s\S]*template\.level = target_level[\s\S]*revision\.content_sha256 =\s*app_private\.practice_worksheet_template_revision_sha256\(revision\.id\)[\s\S]*practice_worksheet_template_withdrawals/,
  );
  assert.match(
    qualificationMigration,
    /reviewer\.active[\s\S]*reviewer\.can_certify[\s\S]*reviewer\.verified_at <= review\.reviewed_at[\s\S]*reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)/,
  );
  assert.match(
    qualificationMigration,
    /releaser\.active[\s\S]*releaser\.can_release[\s\S]*releaser\.verified_at <= release\.released_at[\s\S]*releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /create or replace function app_private\.attach_current_certified_worksheet_for_recovery/,
  );
  assert.match(
    migration,
    /app_private\.attach_current_certified_worksheet_for_recovery[\s\S]*public\.select_released_worksheet_template_internal/,
  );
  assert.match(
    migration,
    /app_private\.attach_current_certified_worksheet_for_recovery[\s\S]*app_private\.clone_released_worksheet_template/,
  );
  assert.match(
    migration,
    /app_private\.attach_current_certified_worksheet_for_recovery[\s\S]*for update/,
  );
});

test("terminal delivery states have an auditable single-assignment and bulk bank rescue path", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );

  for (const identifier of [
    "api.try_complete_current_certified_worksheet_bank_fallback",
    "app_private.attach_current_certified_worksheet_for_recovery",
    "api.recover_current_certified_worksheet_assignments",
    "app_private.worksheet_bank_terminal_rescue_events",
    "app_private.worksheet_bank_terminal_rescue_failures",
  ]) {
    assert.match(migration, new RegExp(identifier.replaceAll(".", "\\.")));
  }
  assert.match(migration, /generation_status\s+(?:=|in)[\s\S]{0,120}'failed'/);
  assert.match(migration, /generation_status[\s\S]{0,160}'needs_review'/);
  assert.match(migration, /practice_test_id\s*=\s*cloned_test_id/);
  assert.match(migration, /generation_status\s*=\s*'ready'/);
  assert.match(
    migration,
    /insert into app_private\.worksheet_bank_terminal_rescue_events/,
  );
  assert.match(migration, /target_fallback_reason is null/);
  assert.match(migration, /rejected_candidates is null/);
  assert.match(
    migration,
    /revoke all on function app_private\.attach_current_certified_worksheet_for_recovery[\s\S]*from public, anon, authenticated, service_role/,
  );
});

test("active-worker rescue locks and revalidates exact class, lease, job, and assignment context before selection", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );
  const functionStart = migration.indexOf(
    "create or replace function api.try_complete_current_certified_worksheet_bank_fallback",
  );
  const functionEnd = migration.indexOf(
    "revoke all on function api.try_complete_current_certified_worksheet_bank_fallback",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const workerRescue = migration.slice(functionStart, functionEnd);

  const classLock = workerRescue.indexOf(
    "app_private.lock_active_practice_class_context(",
  );
  const jobLock = workerRescue.indexOf("into selected_job");
  const assignmentLock = workerRescue.indexOf("into selected_assignment");
  const selector = workerRescue.indexOf(
    "public.select_released_worksheet_template_internal(",
  );
  assert.ok(classLock >= 0, "active class context must be locked");
  assert.ok(jobLock > classLock, "job lock must follow the class locks");
  assert.ok(
    assignmentLock > jobLock,
    "assignment lock must follow the job lock",
  );
  assert.ok(
    selector > assignmentLock,
    "the certified selector must run only after all mutable locks",
  );
  assert.match(workerRescue, /into selected_job[\s\S]*for update;/);
  assert.match(workerRescue, /into selected_assignment[\s\S]*for update;/);
  assert.match(
    workerRescue,
    /selected_job\.status <> 'processing'[\s\S]*selected_job\.queue_message_id is distinct from target_queue_message_id[\s\S]*selected_job\.worker_id is distinct from target_worker_id[\s\S]*selected_job\.lease_expires_at <= now\(\)/,
  );
  assert.match(
    workerRescue,
    /selected_assignment\.workspace_id is distinct from assignment_snapshot\.workspace_id[\s\S]*selected_assignment\.student_id is distinct from assignment_snapshot\.student_id[\s\S]*selected_assignment\.grammar_topic_id is distinct from assignment_snapshot\.grammar_topic_id[\s\S]*selected_assignment\.batch_id is distinct from assignment_snapshot\.batch_id[\s\S]*selected_assignment\.worksheet_level is distinct from assignment_snapshot\.worksheet_level/,
  );
  assert.match(
    workerRescue,
    /class_context_integrity not in \([\s\S]*'writing_snapshot', 'teacher_verified'/,
  );
  assert.doesNotMatch(
    workerRescue,
    /(?:assignment_snapshot|selected_assignment)\.source/,
  );
});

test("recovery ledger is private, content-free, revision-aware, and prevents poison-row starvation", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );
  const tableStart = migration.indexOf(
    "create table app_private.worksheet_bank_terminal_rescue_failures",
  );
  const tableEnd = migration.indexOf(
    "create index worksheet_bank_terminal_rescue_failures_due_idx",
    tableStart,
  );
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const ledgerDefinition = migration.slice(tableStart, tableEnd);

  assert.match(ledgerDefinition, /assignment_id uuid primary key/);
  assert.match(ledgerDefinition, /template_revision_id uuid not null/);
  assert.match(ledgerDefinition, /failure_count between 0 and 5/);
  assert.match(ledgerDefinition, /last_safe_error_code text not null/);
  assert.doesNotMatch(
    ledgerDefinition,
    /(?:student_answer|worksheet_content|provider_payload|error_message|jsonb)/,
  );
  assert.match(
    migration,
    /alter table app_private\.worksheet_bank_terminal_rescue_failures[\s\S]*enable row level security;[\s\S]*revoke all on table app_private\.worksheet_bank_terminal_rescue_failures[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /failure\.failure_count < 5[\s\S]*failure\.next_retry_at <= now\(\)/,
  );
  assert.match(
    migration,
    /failure\.template_revision_id is distinct from eligible\.template_revision_id/,
  );
  assert.match(
    migration,
    /order by[\s\S]*coalesce\(failure\.failure_count, 0\)[\s\S]*limit clean_limit \* 4/,
  );
  assert.match(
    migration,
    /worksheet_bank_rescue_serialization_failure[\s\S]*worksheet_bank_rescue_deadlock[\s\S]*worksheet_bank_rescue_internal_failure/,
  );
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf(
        "create or replace function api.recover_current_certified_worksheet_assignments",
      ),
      migration.indexOf(
        "revoke all on function api.recover_current_certified_worksheet_assignments",
      ),
    ),
    /last_safe_error_code\s*=\s*(?:sqlerrm|failure_message)/i,
  );
});

test("withdrawal, qualification expiry, active leases, and duplicate recovery fail closed", async () => {
  const [migration, qualificationMigration] = await Promise.all([
    readRequiredFile(deliveryMigrationPath, "worksheet delivery migration"),
    readRequiredFile(
      currentQualificationMigrationPath,
      "current worksheet qualification migration",
    ),
  ]);

  assert.match(
    qualificationMigration,
    /not exists \([\s\S]*practice_worksheet_template_withdrawals/,
  );
  assert.match(
    qualificationMigration,
    /reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /not exists \([\s\S]*active_job\.status = 'processing'[\s\S]*active_job\.lease_expires_at > now\(\)[\s\S]*\)[\s\S]*limit clean_limit \* 4/,
  );
  assert.match(
    migration,
    /selected_job\.status = 'processing'[\s\S]*selected_job\.lease_expires_at > now\(\)[\s\S]*return false/,
  );
  assert.match(migration, /unique \(assignment_id, cloned_practice_test_id\)/);
  assert.match(
    migration,
    /assignment\.practice_test_id is not null[\s\S]*return false/,
  );
  assert.match(
    migration,
    /on conflict \(assignment_id, cloned_practice_test_id\) do nothing/,
  );
});

test("clone attesters, duplicate losers, and exhausted resets stay serialized and private", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );
  const cloneStart = migration.indexOf(
    "create or replace function app_private.clone_released_worksheet_template",
  );
  const cloneEnd = migration.indexOf(
    "revoke all on function app_private.clone_released_worksheet_template",
    cloneStart,
  );
  assert.ok(cloneStart >= 0 && cloneEnd > cloneStart);
  const clone = migration.slice(cloneStart, cloneEnd);
  const coverageAdvisory = clone.indexOf(
    "'worksheet-bank-withdrawal-coverage'",
  );
  const cloneAdvisory = clone.indexOf("'worksheet-bank-clone:'");
  const revisionLock = clone.indexOf("select revision.*", cloneAdvisory);
  const attesterLock = clone.indexOf("order by attester.user_id");
  const hashCheck = clone.indexOf("actual_template_hash :=");
  assert.ok(coverageAdvisory >= 0);
  assert.ok(cloneAdvisory > coverageAdvisory);
  assert.ok(revisionLock > cloneAdvisory);
  assert.ok(attesterLock > revisionLock);
  assert.ok(hashCheck > attesterLock);
  assert.match(clone, /order by attester\.user_id\s+for share;/);
  assert.match(
    clone,
    /selected_reviewer\.expires_at <= greatest\([\s\S]*selected_review\.reviewed_at,[\s\S]*now\(\)[\s\S]*selected_releaser\.expires_at <= greatest\([\s\S]*selected_release\.released_at,[\s\S]*now\(\)/,
  );
  assert.match(
    clone,
    /practice_worksheet_template_withdrawals withdrawal[\s\S]*withdrawal\.revision_id = selected_revision\.id/,
  );

  assert.match(
    migration,
    /create or replace function\s+app_private\.resolve_terminal_rescue_failure_if_assignment_ready\([\s\S]*for update;[\s\S]*generation_status <> 'ready'[\s\S]*resolved_at = resolution_time/,
  );
  assert.match(
    migration,
    /create trigger student_practice_assignments_resolve_terminal_rescue_failure[\s\S]*after insert or update of practice_test_id, generation_status/,
  );
  assert.ok(
    (
      migration.match(
        /resolve_terminal_rescue_failure_if_assignment_ready\(\s*candidate\.id\s*\)/g,
      ) ?? []
    ).length >= 2,
    "both deferred and exception ledger paths must recheck a concurrent winner",
  );

  const resetStart = migration.indexOf(
    "create or replace function api.reset_worksheet_bank_terminal_rescue_failure",
  );
  const resetEnd = migration.indexOf(
    "-- ---------------------------------------------------------------------------",
    resetStart,
  );
  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  const reset = migration.slice(resetStart, resetEnd);
  assert.match(reset, /app_private\.assert_service_role\(\)/);
  assert.match(
    reset,
    /into selected_assignment[\s\S]*for update;[\s\S]*into selected_failure[\s\S]*for update;/,
  );
  assert.match(reset, /selected_failure\.failure_count < 5/);
  assert.match(reset, /failure_count = 0/);
  assert.match(reset, /last_safe_error_code = 'worksheet_bank_rescue_operator_reset'/);
  assert.match(
    reset,
    /revoke all on function api\.reset_worksheet_bank_terminal_rescue_failure\([\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute on function api\.reset_worksheet_bank_terminal_rescue_failure\([\s\S]*to service_role;/,
  );
});

test("teacher quarantine approval accepts both the rich mix and the validated mcq_safe profile", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );

  assert.match(
    migration,
    /public\.decide_quarantined_practice_worksheet_internal\(uuid,text,text\)/,
  );
  assert.match(migration, /mcq_safe/);
  assert.match(
    migration,
    /multiple_choice_count >= 2[\s\S]*fill_blank_count >= 2[\s\S]*open_question_count between 1 and 3/,
  );
  assert.match(
    migration,
    /multiple_choice_count = question_count[\s\S]*fill_blank_count = 0[\s\S]*open_question_count = 0/,
  );
  assert.match(
    migration,
    /question_type\s*<>\s*'multiple_choice'[\s\S]*evaluation_mode\s*<>\s*'local_exact'/,
  );
  assert.match(migration, /answer_contract_version\s*<>\s*1/);
  assert.match(migration, /worksheet_contract_invalid/);
});

test("retry exhaustion is projected and invokes the certified-bank rescue instead of a silent retry loop", async () => {
  const migration = await readRequiredFile(
    deliveryMigrationPath,
    "worksheet delivery migration",
  );

  assert.match(migration, /'generation_retry_exhausted'/);
  assert.match(
    migration,
    /'generation_retry_exhausted'[\s\S]*selected_assignment\.practice_test_id is null[\s\S]*selected_assignment\.generation_status = 'failed'[\s\S]*count\(\*\) >= 1 \+ limits\.max_manual_generation_requeues_per_assignment/,
  );
  assert.match(
    migration,
    /create or replace function api\.recover_current_certified_worksheet_assignments[\s\S]*app_private\.attach_current_certified_worksheet_for_recovery/,
  );
  assert.match(
    migration,
    /practice_generation_retry_projection_patch_mismatch/,
  );
});

test("both the active worker and recovery consumer invoke the certified-bank rescue APIs", async () => {
  const [processorSource, recoverySource] = await Promise.all([
    readRequiredFile(worksheetProcessorPath, "worksheet generation processor"),
    readRequiredFile(recoveryHandlerPath, "async recovery handler"),
  ]);

  assert.match(
    processorSource,
    /try_complete_current_certified_worksheet_bank_fallback/,
  );
  assert.match(processorSource, /candidates_rejected/);
  assert.match(processorSource, /provider_(?:unavailable|exhausted)/);
  assert.match(
    recoverySource,
    /recover_current_certified_worksheet_assignments/,
  );
  assert.match(recoverySource, /certified_bank_rescue/);
});

test("dual rejection rechecks the certified bank before returning a private rejected completion", async () => {
  const prepareSource = await readRequiredFile(
    worksheetPreparePath,
    "worksheet preparation orchestrator",
  );

  assert.match(
    prepareSource,
    /candidateAttempt = 2;[\s\S]*generateRepairWorksheetCandidate[\s\S]*buildWorksheetRepairSalvagePlan\(primaryRejection\)/,
  );
  assert.match(
    prepareSource,
    /validateWorksheetCandidateWithDualCritics\([\s\S]*if \(!completed\.validation\.independent_model && candidateAttempt === 1\)[\s\S]*WorksheetRepairContinuation/,
  );
  assert.match(
    prepareSource,
    /if \(!completed\.validation\.independent_model\)[\s\S]*refreshedCertifiedRevision\([\s\S]*fallbackReason: "candidates_rejected"[\s\S]*return completed/,
  );
  assert.match(
    prepareSource,
    /checkpoint\?\.stage === "completion"[\s\S]*refreshedCertifiedRevision\([\s\S]*fallbackReason: "candidates_rejected"/,
  );
});
