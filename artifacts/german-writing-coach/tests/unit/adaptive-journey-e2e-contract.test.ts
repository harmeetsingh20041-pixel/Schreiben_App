// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdaptiveJourneyRecoveryManifest,
  readAdaptiveJourneyRecoveryManifest,
  removeAdaptiveJourneyRecoveryManifest,
  type AdaptiveJourneyRecoveryManifest,
} from "../e2e/fixtures/adaptive-journey-recovery-manifest";

const PROJECT_REF = "vzcgalzspdehmnvqczfw";
const roots: string[] = [];
const source = readFileSync(
  new URL("../e2e/authenticated.adaptive-journey.spec.ts", import.meta.url),
  "utf8",
);

function manifest(): AdaptiveJourneyRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PROJECT_REF,
    workspace_id: "11111111-1111-4111-8111-111111111111",
    teacher_membership_id: "22222222-2222-4222-8222-222222222222",
    student_membership_id: "33333333-3333-4333-8333-333333333333",
    batch_id: "44444444-4444-4444-8444-444444444444",
    batch_student_id: "55555555-5555-4555-8555-555555555555",
    grammar_topic_id: "66666666-6666-4666-8666-666666666666",
    first_submission_id: "77777777-7777-4777-8777-777777777777",
    recurrence_submission_id: "88888888-8888-4888-8888-888888888888",
    practice_test_ids: [
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ],
    question_ids: [
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ],
  };
}

async function fixturePath() {
  const root = await mkdtemp(join(tmpdir(), "adaptive-journey-manifest-"));
  roots.push(root);
  return join(root, ".e2e-private", "adaptive-journey-fixture.json");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("stitched adaptive journey E2E contract", () => {
  it("pins the disposable staging scope and never retains private output", () => {
    expect(source).toContain(
      'const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw"',
    );
    expect(source).toContain('"https://vzcgalzspdehmnvqczfw.supabase.co"');
    expect(source).toContain("assertPinnedBrowserStaging()");
    expect(source).toContain("installPinnedSupabaseRequestGuard(page)");
    expect(source).toContain('requiredEnvironment("E2E_SUPABASE_BIN")');
    expect(source).toContain('!name.startsWith("E2E_")');
    expect(source).toContain('stdio: ["pipe", "pipe", "pipe"]');
    expect(source).toContain("PRIVATE_SQL_TIMEOUT_MS = 120_000");
    expect(source).toContain("dirname(fileURLToPath(import.meta.url))");
    expect(source).not.toContain('resolve(process.cwd(), "../..")');
    expect(source).not.toContain("console.");
    expect(source).not.toContain("result.stdout.trim");
    expect(source).not.toContain("result.stderr.trim");
    expect(source).not.toContain("error.message");
  });

  it("stitches released feedback through approved reuse, scoring, resolution, and recurrence", () => {
    expect(source).toContain("releasedSubmissionSql(");
    expect(source).toContain("'feedback_contract_version', 2");
    expect(source).toContain("'severity', 'minor'");
    expect(source).toContain("'grammar_topics', jsonb_build_array(");
    expect(source).toContain("resolveCanonicalConjugationTopicId()");
    expect(source).toContain("app_private.materialize_feedback_draft(");
    expect(source).toContain('page.getByText("1 lines checked"');
    expect(source).toContain('"gwc_active_membership_id"');
    expect(source).toContain("submission_grammar_topics");
    expect(source).toContain("practice_weakness_evidence");
    expect(source).toContain("assignment.source = 'weakness_auto'");
    expect(source).toContain("worksheet.quality_status = 'approved'");
    expect(source).toContain("worksheet.teacher_reviewed");
    expect(source).toContain("worksheet.generation_source = 'manual_import'");
    expect(source).toContain("assignment.generation_status = 'ready'");
    expect(source).toContain("app_private.async_jobs");
    expect(source).toContain('page.getByTestId("practice-draft-status")');
    expect(source).toContain("await page.reload()");
    expect(source).toContain('page.getByTestId("practice-score")');
    expect(source).toContain(
      "app_private.process_practice_cycle_transition_jobs(1)",
    );
    expect(source).toContain("for transition_attempt in 1..20 loop");
    expect(source).toContain("cycle.state = 'improving'");
    expect(source).toContain("assignment.source = 'adaptive_repeat'");
    expect(source).toContain("cycle.cycle_number = 2");
    expect(source).toContain("assignment.previous_assignment_id");
    expect(source).toContain("expect(recurrenceAssignmentId).not.toBe(");
  });

  it("has exact recovery and residue checks for every persistent fixture run", () => {
    expect(source).toContain("recoverPreviousFixture()");
    expect(source).toContain("createAdaptiveJourneyRecoveryManifest(");
    expect(source).toContain("removeAdaptiveJourneyRecoveryManifest(");
    expect(source).toContain("adaptive_journey_cleanup_identity_mismatch");
    expect(source).toContain("adaptive_journey_cleanup_scope_changed");
    expect(source).toContain("adaptive_journey_cleanup_residue");
    expect(source).toContain("set local session_replication_role = replica");
    expect(source).toContain("for update nowait");
    expect(source).toContain("E2E_ADAPTIVE_JOURNEY_RECOVERY_ONLY");
  });
});

describe("adaptive journey recovery manifest", () => {
  it("is owner-only and contains fixture IDs only", async () => {
    const path = await fixturePath();
    const initial = manifest();
    await createAdaptiveJourneyRecoveryManifest(path, initial, PROJECT_REF);

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(
      await readAdaptiveJourneyRecoveryManifest(path, PROJECT_REF),
    ).toEqual(initial);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("@");
    expect(raw).not.toContain("Ich helfen");

    await removeAdaptiveJourneyRecoveryManifest(path, PROJECT_REF);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses permissive files, project drift, and a symlinked private directory", async () => {
    const path = await fixturePath();
    await createAdaptiveJourneyRecoveryManifest(path, manifest(), PROJECT_REF);
    await chmod(path, 0o644);
    await expect(
      readAdaptiveJourneyRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("not owner-only");
    await chmod(path, 0o600);
    await expect(
      readAdaptiveJourneyRecoveryManifest(path, "another-project"),
    ).rejects.toThrow("another scope");

    const root = await mkdtemp(join(tmpdir(), "adaptive-journey-symlink-"));
    const outside = await mkdtemp(
      join(tmpdir(), "adaptive-journey-symlink-target-"),
    );
    roots.push(root, outside);
    const symlinkedPath = join(
      root,
      ".e2e-private",
      "adaptive-journey-fixture.json",
    );
    await symlink(outside, join(root, ".e2e-private"));
    await expect(
      createAdaptiveJourneyRecoveryManifest(
        symlinkedPath,
        manifest(),
        PROJECT_REF,
      ),
    ).rejects.toThrow("unsafe");
  });
});
