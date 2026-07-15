import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const feedbackModeSpec = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.feedback-modes.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const isolatedFixture = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/fixtures/feedback-modes-isolated-fixture.ts",
    import.meta.url,
  ),
  "utf8",
);
const recoveryManifest = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/fixtures/feedback-modes-recovery-manifest.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedRunner = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/scripts/run-authenticated-playwright.ts",
    import.meta.url,
  ),
  "utf8",
);
const playwrightConfig = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/playwright.config.ts",
    import.meta.url,
  ),
  "utf8",
);
const testingGuide = readFileSync(
  new URL("../../docs/TESTING.md", import.meta.url),
  "utf8",
);
const verifyWorkflow = readFileSync(
  new URL("../../.github/workflows/verify.yml", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const appPackage = JSON.parse(
  readFileSync(
    new URL(
      "../../artifacts/german-writing-coach/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { scripts?: Record<string, string> };

test("the feedback-mode workflow is opt-in and uses the private authenticated runner", () => {
  assert.equal(
    rootPackage.scripts?.["test:e2e:feedback-modes"],
    "pnpm --filter @workspace/german-writing-coach run test:e2e:feedback-modes",
  );
  assert.equal(
    appPackage.scripts?.["test:e2e:feedback-modes"],
    "tsx scripts/run-authenticated-playwright.ts authenticated.feedback-modes.spec.ts",
  );
  assert.match(feedbackModeSpec, /process\.env\.E2E_FEEDBACK_MODES !== "true"/);
  assert.match(feedbackModeSpec, /requiredEnvironment\("E2E_AUTHENTICATED"\)/);
  assert.doesNotMatch(verifyWorkflow, /test:e2e:feedback-modes/);

  assert.match(
    authenticatedRunner,
    /mkdtemp\([\s\S]*AUTHENTICATED_OUTPUT_PREFIX/,
  );
  assert.match(
    authenticatedRunner,
    /finally\s*\{[\s\S]*rm\(privateOutputRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
  );
  assert.match(playwrightConfig, /trace:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /screenshot:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /video:\s*authenticated \? "off"/);
  assert.match(
    playwrightConfig,
    /preserveOutput:\s*authenticated \? "never" : "failures-only"/,
  );
});

test("the workflow covers private teacher review and revision-safe release", () => {
  assert.match(feedbackModeSpec, /const TEACHER_REVIEW_WRITING =/);
  assert.match(feedbackModeSpec, /const SCHEDULED_WRITING =/);
  assert.doesNotMatch(feedbackModeSpec, /E2E_WRITING_SAMPLE/);
  assert.match(feedbackModeSpec, /writing-draft-status/);
  assert.match(feedbackModeSpec, /Submit Writing/);
  assert.match(feedbackModeSpec, /Writing submitted safely\./);
  assert.match(feedbackModeSpec, /Teacher review/);
  assert.match(feedbackModeSpec, /Teacher feedback editor/);
  assert.match(feedbackModeSpec, /Awaiting release\./);
  assert.match(
    feedbackModeSpec,
    /remains private until your teacher releases it/,
  );
  assert.match(feedbackModeSpec, /update_feedback_draft/);
  assert.match(feedbackModeSpec, /expected_revision/);
  assert.match(feedbackModeSpec, /Save private draft/);
  assert.match(feedbackModeSpec, /Approve and release/);
  assert.match(feedbackModeSpec, /release_feedback/);
  assert.match(feedbackModeSpec, /RELEASED_SUMMARY_MARKER/);
  assert.match(feedbackModeSpec, /STUDENT_RELEASE_LIVE_WINDOW_MS = 45_000/);
  assert.match(feedbackModeSpec, /monitorStudentReleaseReadPath/);
  assert.match(feedbackModeSpec, /exactStudentSubmissionRoute/);
  assert.match(feedbackModeSpec, /waitForReleasedStudentFeedback/);
  assert.match(
    feedbackModeSpec,
    /matchesRpc\(response, "get_submission_detail"\)[\s\S]*responseTargetsSubmission\(response, submissionId\)/,
  );
  assert.match(feedbackModeSpec, /feedbackPresent:/);
  assert.match(feedbackModeSpec, /feedbackLineCount:/);
  assert.match(feedbackModeSpec, /feedbackTopicCount:/);
  assert.match(
    feedbackModeSpec,
    /getByRole\("button", \{ name: "Create Class", exact: true \}\)[\s\S]*\.filter\(\{ visible: true \}\)[\s\S]*\.first\(\)/,
  );
  assert.match(
    feedbackModeSpec,
    /name: `\$\{workspaceName\} · student`,[\s\S]*await expect\(fixtureWorkspace\)\.toHaveCount\(1/,
  );
  assert.doesNotMatch(feedbackModeSpec, /studentWorkspaceNames/);

  const releasedStudentWaiter = feedbackModeSpec.slice(
    feedbackModeSpec.indexOf("async function waitForReleasedStudentFeedback"),
    feedbackModeSpec.indexOf("async function waitForRpc"),
  );
  assert.equal(
    releasedStudentWaiter.match(/await safeReload\(options\.page\);/g)?.length,
    1,
    "released feedback permits exactly one instrumented recovery reload",
  );
  assert.doesNotMatch(
    releasedStudentWaiter,
    /expect\s*\.poll\([\s\S]*?safeReload/,
  );
  assert.doesNotMatch(
    releasedStudentWaiter,
    /while\s*\([^)]*\)\s*\{[\s\S]*?safeReload/,
  );
  assert.ok(
    releasedStudentWaiter.indexOf("feedbackSummaryBecameVisible") <
      releasedStudentWaiter.indexOf("monitorStudentReleaseReadPath"),
    "the open page gets its full live-update window before recovery",
  );
});

test("the scheduled flow proves deterministic privacy and the one-minute release gate", () => {
  assert.match(feedbackModeSpec, /Scheduled feedback/);
  assert.match(feedbackModeSpec, /SCHEDULE_MINUTES = "4"/);
  assert.match(feedbackModeSpec, /Earliest release \(minutes\)/);
  assert.match(feedbackModeSpec, /Latest release \(minutes\)/);
  assert.match(feedbackModeSpec, /4–4 minutes/);
  assert.match(feedbackModeSpec, /Randomized between 4 and 4 minutes\./);
  assert.match(feedbackModeSpec, /Release: Scheduled/);
  assert.match(feedbackModeSpec, /Feedback scheduled\./);
  assert.match(feedbackModeSpec, /Scheduled feedback preview/);
  assert.match(feedbackModeSpec, /will appear at the scheduled release time/);
  assert.match(feedbackModeSpec, /releaseAt \+ 60_000/);
  assert.match(feedbackModeSpec, /Release overdue feedback/);
  assert.match(feedbackModeSpec, /monitorScheduledPreviewReadPath/);
  assert.match(feedbackModeSpec, /assertExactScheduledSubmissionIdentity/);
  assert.match(feedbackModeSpec, /responseTargetsSubmission/);
  assert.match(
    feedbackModeSpec,
    /const settle = async \(\) => \{\s*while \(pending\.size > 0\) \{\s*await Promise\.allSettled\(\[\.\.\.pending\]\);/,
  );
  assert.match(feedbackModeSpec, /evaluationStatus:\s*/);
  assert.match(feedbackModeSpec, /releaseStatus:\s*/);
  assert.match(feedbackModeSpec, /feedbackMode:\s*/);
  assert.match(feedbackModeSpec, /draftPresent:\s*/);
  assert.match(feedbackModeSpec, /draftState:\s*/);
  assert.match(feedbackModeSpec, /Date\.now\(\) \+ 60_000/);
  assert.match(
    feedbackModeSpec,
    /timeout: 15_000, intervals: \[500, 1_000, 2_000\]/,
  );
  assert.match(
    feedbackModeSpec,
    /getByText\("Scheduled feedback preview", \{ exact: true \}\)[\s\S]*?\.isVisible\(\)[\s\S]*?\) \{\s*await readMonitor\.settle\(\);\s*if \(!hasScheduledPreviewReadEvidence/,
  );
  assert.doesNotMatch(
    feedbackModeSpec,
    /waitBriefly\(page, 3_000\);\s*await safeReload\(page\)/,
  );

  const scheduledWaiter = feedbackModeSpec.slice(
    feedbackModeSpec.indexOf("async function waitForScheduledTeacherPreview"),
    feedbackModeSpec.indexOf("async function assertScheduledPreviewIsPrivate"),
  );
  assert.equal(
    scheduledWaiter.match(/await safeReload\(page\);/g)?.length,
    1,
    "the scheduled preview waiter has exactly one delayed recovery reload",
  );

  const scheduledReleaseWaiter = feedbackModeSpec.slice(
    feedbackModeSpec.indexOf("async function waitForScheduledRelease"),
    feedbackModeSpec.indexOf("async function offboardTestMembership"),
  );
  assert.match(scheduledReleaseWaiter, /releaseAt \+ 60_000/);
  assert.match(scheduledReleaseWaiter, /waitForReleasedStudentFeedback/);
  assert.doesNotMatch(scheduledReleaseWaiter, /safeReload/);
  assert.doesNotMatch(scheduledReleaseWaiter, /while\s*\(/);
});

test("cleanup is narrowly scoped and historical work is preserved", () => {
  assert.match(feedbackModeSpec, /selectPreferredTeacherMembership/);
  assert.match(feedbackModeSpec, /prepareFeedbackModesFixture/);
  assert.match(feedbackModeSpec, /cleanupFeedbackModesFixture/);
  assert.match(feedbackModeSpec, /Remove student access/);
  assert.match(feedbackModeSpec, /Offboarding completed for/);
  assert.match(feedbackModeSpec, /assertStudentClassAccessRemoved/);
  assert.match(feedbackModeSpec, /Archive Class/);
  assert.match(feedbackModeSpec, /Reactivate Class/);
  assert.match(feedbackModeSpec, /assertTeacherHistoryPreserved/);
  assert.match(feedbackModeSpec, /Student Submissions/);
  assert.ok(
    feedbackModeSpec.indexOf("assertTeacherHistoryPreserved") <
      feedbackModeSpec.lastIndexOf("cleanupFeedbackModesFixture"),
  );

  assert.match(isolatedFixture, /e2e-feedback-modes-/);
  assert.match(isolatedFixture, /teacher_only_contract_invalid/);
  assert.match(isolatedFixture, /membershipFingerprintSql/);
  assert.match(isolatedFixture, /persistent_membership_changed/);
  assert.match(isolatedFixture, /feedback_modes_job_ids/);
  assert.match(isolatedFixture, /pgmq\.q_writing_evaluation/);
  assert.match(isolatedFixture, /pgmq\.a_writing_evaluation/);
  assert.match(isolatedFixture, /ai_spend_reservations/);
  assert.match(isolatedFixture, /ai_canary_spend_archive/);
  assert.match(isolatedFixture, /feedback_modes_residue_guard/);
  assert.match(isolatedFixture, /E2E_FEEDBACK_MODES_RECOVERY_ONLY/);
  assert.doesNotMatch(isolatedFixture, /insert into auth\.users/i);
  assert.doesNotMatch(isolatedFixture, /delete from auth\.users/i);

  assert.match(recoveryManifest, /open\(temporaryPath, "wx", 0o600\)/);
  assert.match(recoveryManifest, /await handle\.sync\(\)/);
  assert.match(recoveryManifest, /metadata\.isSymbolicLink\(\)/);
  assert.match(recoveryManifest, /teacher_membership_fingerprint/);
  assert.match(recoveryManifest, /student_membership_fingerprint/);
  assert.doesNotMatch(recoveryManifest, /email|password|writing_sample/i);
});

test("the authenticated specification cannot emit sensitive browser evidence", () => {
  for (const forbidden of [
    /console\.(?:log|info|warn|error)/,
    /error\.message/,
    /response\.url\(\)/,
    /page\.url\(\)/,
    /toHaveURL/,
    /trace|screenshot|video|testInfo\.attach/,
    /https?:\/\//,
    /provider.*payload/i,
    /E2E_WRITING_SAMPLE/,
  ]) {
    assert.doesNotMatch(feedbackModeSpec, forbidden);
  }
  assert.match(feedbackModeSpec, /pageerror:\$\{error\.name\}/);
  assert.match(
    feedbackModeSpec,
    /http:\$\{response\.status\(\)\}:\$\{response\.request\(\)\.resourceType\(\)\}/,
  );
  assert.doesNotMatch(feedbackModeSpec, /JSON\.stringify\(requestBody\)/);
  assert.doesNotMatch(
    feedbackModeSpec,
    /interface ScheduledPreviewReadObservation\s*\{[^}]*\b(?:content|original_text|corrected_text|overall_summary)\b/s,
  );
  assert.doesNotMatch(
    feedbackModeSpec,
    /interface StudentReleaseReadObservation\s*\{[^}]*\b(?:id|url|content|original_text|corrected_text|overall_summary)\b/s,
  );
  assert.match(
    feedbackModeSpec,
    /payload = await response\.json\(\);[\s\S]*observations\.push\(\{[\s\S]*httpStatus:[\s\S]*draftState:/,
  );
  assert.match(
    feedbackModeSpec,
    /interface StudentReleaseReadObservation\s*\{[\s\S]*httpStatus:[\s\S]*evaluationStatus:[\s\S]*releaseStatus:[\s\S]*feedbackPresent:[\s\S]*feedbackLineCount:[\s\S]*feedbackTopicCount:/,
  );
});

test("the operator guide documents the isolated, artifact-free staging contract", () => {
  assert.match(
    testingGuide,
    /Isolated teacher-review and scheduled-feedback workflow/,
  );
  assert.match(testingGuide, /E2E_FEEDBACK_MODES=true/);
  assert.match(testingGuide, /pnpm run test:e2e:feedback-modes/);
  assert.match(testingGuide, /private secret\s+runner/);
  assert.match(testingGuide, /fingerprints every pre-existing membership/);
  assert.match(testingGuide, /random temporary workspace/);
  assert.match(testingGuide, /equal 4–4 minute range/);
  assert.match(testingGuide, /release_at \+ 60 seconds/);
  assert.match(testingGuide, /not part of the normal\s+`Verify` workflow/);
  assert.match(testingGuide, /E2E_FEEDBACK_MODES_RECOVERY_ONLY=true/);
  assert.match(testingGuide, /pre-existing membership fingerprints/);
  assert.match(testingGuide, /historical\s+submissions remain visible/);
});
