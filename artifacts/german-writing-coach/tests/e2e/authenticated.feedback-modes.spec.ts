import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";
import {
  cleanupFeedbackModesFixture,
  feedbackModesRecoveryOnly,
  prepareFeedbackModesFixture,
  recoverPreviousFeedbackModesFixture,
  type FeedbackModesIsolatedFixture,
} from "./fixtures/feedback-modes-isolated-fixture";

type Credentials = { email: string; password: string };
type FeedbackMode = "teacher-review" | "scheduled";
type ScheduledPreviewRpcKind = "get_submission_detail" | "get_feedback_draft";

interface ScheduledPreviewReadObservation {
  kind: ScheduledPreviewRpcKind;
  httpStatus: number;
  evaluationStatus: string | null;
  releaseStatus: string | null;
  feedbackMode: string | null;
  draftPresent: boolean | null;
  draftState: string | null;
}

interface ScheduledPreviewReadMonitor {
  observations: ScheduledPreviewReadObservation[];
  settle: () => Promise<void>;
  stop: () => Promise<void>;
}

interface StudentReleaseReadObservation {
  httpStatus: number;
  evaluationStatus: string | null;
  releaseStatus: string | null;
  feedbackPresent: boolean | null;
  feedbackLineCount: number | null;
  feedbackTopicCount: number | null;
}

interface StudentReleaseReadMonitor {
  observations: StudentReleaseReadObservation[];
  settle: () => Promise<void>;
  stop: () => Promise<void>;
}

const CLASS_LEVEL = "A1";
const SCHEDULE_MINUTES = "4";
const TEACHER_REVIEW_WRITING =
  "Ich arbeite heute im Krankenhaus. Meine Schicht beginnt um acht Uhr.";
const SCHEDULED_WRITING =
  "Heute beginnt meine Schicht um acht Uhr. Danach spreche ich mit meinem Team.";
const RELEASED_SUMMARY_MARKER = "Synthetic teacher review completed.";
const STUDENT_RELEASE_LIVE_WINDOW_MS = 45_000;
const STUDENT_RELEASE_RECOVERY_READ_MS = 30_000;
const STUDENT_RELEASE_RECOVERY_RESERVE_MS = 15_000;
let isolatedFixture: FeedbackModesIsolatedFixture | null = null;
let isolatedFixtureInstalled = false;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the feedback-mode workflow.`);
  }
  return value;
}

function credentials(role: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

async function safeGoto(page: Page, path: string) {
  try {
    await page.goto(path);
  } catch {
    throw new Error("A protected browser navigation did not complete.");
  }
}

async function safeReload(page: Page) {
  try {
    await page.reload();
  } catch {
    throw new Error("A protected browser refresh did not complete.");
  }
}

async function fillPrivately(field: Locator, value: string) {
  try {
    await field.fill(value);
  } catch {
    throw new Error("A private browser field could not be filled.");
  }
}

async function waitBriefly(page: Page, milliseconds: number) {
  try {
    await page.waitForTimeout(milliseconds);
  } catch {
    throw new Error("The protected browser wait was interrupted.");
  }
}

async function signIn(
  page: Page,
  account: Credentials,
  role: "teacher" | "student",
) {
  await safeGoto(page, "/");
  await fillPrivately(page.getByLabel("Email"), account.email);
  await fillPrivately(page.getByLabel("Password"), account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await enterTeacherShellFromAdminLanding(page);

  if (role === "teacher") {
    const overview = page.getByRole("heading", {
      name: "Teacher Overview",
      level: 1,
    });
    const onboarding = page.getByText("Set Up Your Workspace", {
      exact: true,
    });
    await expect
      .poll(
        async () =>
          (await overview.isVisible()) || (await onboarding.isVisible()),
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!(await overview.isVisible())) {
      throw new Error(
        "The teacher workflow account needs an existing staging workspace.",
      );
    }
    return;
  }

  await expect(
    page.getByRole("heading", { name: /^Welcome back,/ }),
  ).toBeVisible({ timeout: 15_000 });
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

function matchesRpc(candidate: Response, functionName: string) {
  let pathname = "";
  try {
    pathname = new URL(candidate.url()).pathname;
  } catch {
    return false;
  }
  return (
    candidate.request().method() === "POST" &&
    pathname.endsWith(`/rest/v1/rpc/${functionName}`)
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableObservedString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function responseTargetsSubmission(response: Response, submissionId: string) {
  try {
    const requestBody = response.request().postDataJSON();
    return (
      isUnknownRecord(requestBody) &&
      requestBody.target_submission_id === submissionId
    );
  } catch {
    return false;
  }
}

function monitorScheduledPreviewReadPath(
  page: Page,
  submissionId: string,
): ScheduledPreviewReadMonitor {
  const observations: ScheduledPreviewReadObservation[] = [];
  const pending = new Set<Promise<void>>();

  const handler = (response: Response) => {
    const kind = (
      ["get_submission_detail", "get_feedback_draft"] as const
    ).find(
      (candidate) =>
        matchesRpc(response, candidate) &&
        responseTargetsSubmission(response, submissionId),
    );
    if (!kind) return;

    let task: Promise<void>;
    task = (async () => {
      let payload: unknown = null;
      let bodyParsed = false;
      try {
        payload = await response.json();
        bodyParsed = true;
      } catch {
        // The HTTP status remains useful without retaining an invalid body.
      }

      const record = isUnknownRecord(payload) ? payload : null;
      const submission =
        record && isUnknownRecord(record.submission) ? record.submission : null;
      const draft =
        record && isUnknownRecord(record.draft) ? record.draft : null;
      observations.push({
        kind,
        httpStatus: response.status(),
        evaluationStatus:
          kind === "get_submission_detail"
            ? nullableObservedString(submission?.evaluation_status)
            : null,
        releaseStatus:
          kind === "get_submission_detail"
            ? nullableObservedString(submission?.release_status)
            : null,
        feedbackMode:
          kind === "get_submission_detail"
            ? nullableObservedString(submission?.feedback_mode)
            : null,
        draftPresent:
          kind === "get_feedback_draft" && bodyParsed && record
            ? record.draft === null
              ? false
              : Boolean(draft)
            : null,
        draftState:
          kind === "get_feedback_draft"
            ? nullableObservedString(draft?.state)
            : null,
      });
    })().finally(() => pending.delete(task));
    pending.add(task);
  };

  page.on("response", handler);
  const settle = async () => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };
  return {
    observations,
    settle,
    stop: async () => {
      page.off("response", handler);
      await settle();
    },
  };
}

function monitorStudentReleaseReadPath(
  page: Page,
  submissionId: string,
): StudentReleaseReadMonitor {
  const observations: StudentReleaseReadObservation[] = [];
  const pending = new Set<Promise<void>>();

  const handler = (response: Response) => {
    if (
      !matchesRpc(response, "get_submission_detail") ||
      !responseTargetsSubmission(response, submissionId)
    ) {
      return;
    }

    let task: Promise<void>;
    task = (async () => {
      let payload: unknown = null;
      let bodyParsed = false;
      try {
        payload = await response.json();
        bodyParsed = true;
      } catch {
        // The HTTP result remains useful without retaining an invalid body.
      }

      const record = isUnknownRecord(payload) ? payload : null;
      const submission =
        record && isUnknownRecord(record.submission) ? record.submission : null;
      const feedbackValue = record?.feedback;
      const feedback = isUnknownRecord(feedbackValue) ? feedbackValue : null;
      observations.push({
        httpStatus: response.status(),
        evaluationStatus: nullableObservedString(submission?.evaluation_status),
        releaseStatus: nullableObservedString(submission?.release_status),
        feedbackPresent:
          bodyParsed && record
            ? feedbackValue === null
              ? false
              : feedback
                ? true
                : null
            : null,
        feedbackLineCount:
          feedback && Array.isArray(feedback.lines)
            ? feedback.lines.length
            : null,
        feedbackTopicCount:
          feedback && Array.isArray(feedback.grammar_topics)
            ? feedback.grammar_topics.length
            : null,
      });
    })().finally(() => pending.delete(task));
    pending.add(task);
  };

  page.on("response", handler);
  const settle = async () => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };
  return {
    observations,
    settle,
    stop: async () => {
      page.off("response", handler);
      await settle();
    },
  };
}

async function exactStudentSubmissionRoute(page: Page, submissionId: string) {
  try {
    return await page.evaluate(
      (expectedSubmissionId) =>
        window.location.pathname ===
        `/student/submission/${expectedSubmissionId}`,
      submissionId,
    );
  } catch {
    return false;
  }
}

async function waitForStudentReleaseReadObservation(
  page: Page,
  monitor: StudentReleaseReadMonitor,
  initialObservationCount: number,
  deadline: number,
) {
  while (Date.now() < deadline) {
    await monitor.settle();
    const observation = monitor.observations
      .slice(initialObservationCount)
      .at(-1);
    if (observation) return observation;
    await waitBriefly(page, Math.min(500, Math.max(1, deadline - Date.now())));
  }
  await monitor.settle();
  return monitor.observations.slice(initialObservationCount).at(-1) ?? null;
}

function assertReleasedStudentRead(
  routeMatches: boolean,
  observation: StudentReleaseReadObservation | null,
) {
  if (!routeMatches) {
    throw new Error(
      "Student release verification left the exact submission route.",
    );
  }
  if (!observation) {
    throw new Error(
      "Student release verification did not observe its exact detail read.",
    );
  }
  if (observation.httpStatus >= 400) {
    throw new Error("Student release verification detail read failed safely.");
  }
  if (
    observation.evaluationStatus !== "ready" ||
    observation.releaseStatus !== "released"
  ) {
    throw new Error(
      "Student release verification did not observe the terminal released state.",
    );
  }
  if (observation.feedbackPresent !== true) {
    throw new Error(
      "Student release verification observed released state without feedback.",
    );
  }
  if (
    observation.feedbackLineCount === null ||
    observation.feedbackLineCount < 1 ||
    observation.feedbackTopicCount === null ||
    observation.feedbackTopicCount < 0
  ) {
    throw new Error(
      "Student release verification observed an invalid feedback projection.",
    );
  }
}

async function feedbackSummaryBecameVisible(page: Page, timeout: number) {
  const heading = page.getByRole("heading", {
    name: "Feedback Summary",
    level: 2,
  });
  if (await heading.isVisible()) return true;
  if (timeout <= 0) return false;
  return heading
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForReleasedStudentFeedback(options: {
  page: Page;
  submissionId: string;
  deadline: number;
  deadlineFailure: string;
}) {
  const availableBeforeDeadline = Math.max(0, options.deadline - Date.now());
  const liveWindow = Math.min(
    STUDENT_RELEASE_LIVE_WINDOW_MS,
    Math.max(0, availableBeforeDeadline - STUDENT_RELEASE_RECOVERY_RESERVE_MS),
  );
  if (await feedbackSummaryBecameVisible(options.page, liveWindow)) {
    if (Date.now() > options.deadline) throw new Error(options.deadlineFailure);
    return;
  }
  if (Date.now() >= options.deadline) {
    throw new Error(options.deadlineFailure);
  }

  const monitor = monitorStudentReleaseReadPath(
    options.page,
    options.submissionId,
  );
  const initialObservationCount = monitor.observations.length;
  try {
    // Exactly one recovery refresh is allowed. Repeated reloads can keep
    // aborting the asynchronous auth context and React Query detail read.
    await safeReload(options.page);
    const readDeadline = Math.min(
      options.deadline,
      Date.now() + STUDENT_RELEASE_RECOVERY_READ_MS,
    );
    const observation = await waitForStudentReleaseReadObservation(
      options.page,
      monitor,
      initialObservationCount,
      readDeadline,
    );
    const routeMatches = await exactStudentSubmissionRoute(
      options.page,
      options.submissionId,
    );
    assertReleasedStudentRead(routeMatches, observation);

    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error(options.deadlineFailure);
    if (!(await feedbackSummaryBecameVisible(options.page, remaining))) {
      throw new Error(
        "The released feedback read completed, but its student view did not render.",
      );
    }
    if (Date.now() > options.deadline) throw new Error(options.deadlineFailure);
  } finally {
    await monitor.stop();
  }
}

async function waitForRpc(page: Page, functionName: string) {
  let response: Response;
  try {
    response = await page.waitForResponse(
      (candidate) => matchesRpc(candidate, functionName),
      { timeout: 15_000 },
    );
  } catch {
    throw new Error(`The ${functionName} browser request was not observed.`);
  }
  if (response.status() >= 400) {
    throw new Error(`The ${functionName} browser request failed safely.`);
  }
  return response;
}

async function fillAndWaitForRpc(
  page: Page,
  field: Locator,
  value: string,
  functionName: string,
) {
  const responsePromise = waitForRpc(page, functionName);
  try {
    await fillPrivately(field, value);
    await responsePromise;
  } catch {
    void responsePromise.catch(() => undefined);
    throw new Error("The private filtered browser read did not complete.");
  }
}

async function observeRpcAction(
  page: Page,
  functionName: string,
  action: () => Promise<void>,
) {
  const responsePromise = waitForRpc(page, functionName);
  try {
    await action();
    return await responsePromise;
  } catch {
    void responsePromise.catch(() => undefined);
    throw new Error(`The ${functionName} browser action did not complete.`);
  }
}

async function openTeacherStudents(page: Page) {
  await safeGoto(page, "/teacher/students");
  await expect(
    page.getByRole("heading", { name: "Students", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading students/ }),
  ).toHaveCount(0, { timeout: 15_000 });
}

async function filterRosterByStudent(page: Page, studentEmail: string) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search students"),
    studentEmail,
    "list_workspace_students_filtered_page",
  );
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading student page/ }),
  ).toHaveCount(0, { timeout: 10_000 });
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

async function createClass(page: Page, className: string, mode: FeedbackMode) {
  await safeGoto(page, "/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  const createClassButton = page
    .getByRole("button", { name: "Create Class", exact: true })
    .filter({ visible: true })
    .first();
  await expect(createClassButton).toBeVisible();
  await createClassButton.click();

  const dialog = page.getByRole("dialog", { name: "Create a class" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Class name").fill(className);
  await dialog.getByLabel("CEFR level").click();
  await page.getByRole("option", { name: CLASS_LEVEL, exact: true }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();

  const modeLabel =
    mode === "scheduled" ? "Scheduled feedback" : "Teacher review";
  await dialog
    .getByRole("radio", { name: new RegExp(`^${modeLabel}`) })
    .click();
  await dialog.getByRole("button", { name: "Continue" }).click();

  if (mode === "scheduled") {
    await dialog
      .getByLabel("Earliest release (minutes)")
      .fill(SCHEDULE_MINUTES);
    await dialog.getByLabel("Latest release (minutes)").fill(SCHEDULE_MINUTES);
  }
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    dialog.getByText("Teacher approval required", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(className, { exact: false })).toBeVisible();
  if (mode === "scheduled") {
    await expect(
      dialog.getByText("4–4 minutes", { exact: true }),
    ).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Create class" }).click();

  const { card, codeAnchor } = classCard(page, className);
  await expect(codeAnchor).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(modeLabel, { exact: true })).toBeVisible();
  if (mode === "scheduled") {
    await expect(
      card.getByText("Randomized between 4 and 4 minutes.", {
        exact: true,
      }),
    ).toBeVisible();
  }
  const joinCode = (await card.locator("p.font-mono").textContent())?.trim();
  if (!joinCode || !/^[A-Z0-9]{8,16}$/.test(joinCode)) {
    throw new Error(
      "The test class did not provide a valid private join code.",
    );
  }
  return joinCode;
}

async function submitJoinRequest(
  page: Page,
  joinCode: string,
  className: string,
) {
  await safeGoto(page, "/student/dashboard");
  await fillPrivately(page.getByLabel("Class join code"), joinCode);
  await page.getByRole("button", { name: "Request Access" }).click();
  await expect(
    page.getByText("Request sent", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  const requestSummary = page
    .getByText(`${className} · ${CLASS_LEVEL}`, { exact: true })
    .locator("..");
  await expect(
    requestSummary.getByText("pending", { exact: true }),
  ).toBeVisible();
}

function pendingRequestCard(page: Page, className: string) {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const requestLine = page.getByText(
    new RegExp(`^${escapedClassName} · ${CLASS_LEVEL} · requested `),
  );
  return {
    requestLine,
    card: requestLine.locator(
      "xpath=ancestor::div[.//button[normalize-space()='Approve']][1]",
    ),
  };
}

async function approveJoinRequest(page: Page, className: string) {
  await openTeacherStudents(page);
  const deadline = Date.now() + 30_000;
  let requestCard: Locator | null = null;

  while (Date.now() < deadline) {
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /^Loading class-code requests/ }),
    ).toHaveCount(0, { timeout: 15_000 });
    const candidate = pendingRequestCard(page, className);
    const count = await candidate.requestLine.count();
    if (count > 1) {
      throw new Error("The test join request was not unique.");
    }
    if (count === 1) {
      requestCard = candidate.card;
      break;
    }
    await safeReload(page);
    await waitBriefly(page, 1_000);
  }

  if (!requestCard) {
    throw new Error("The test join request did not reach the teacher.");
  }
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

async function selectPreferredTeacherMembership(
  page: Page,
  fixture: FeedbackModesIsolatedFixture,
) {
  await safeGoto(page, "/teacher/dashboard");
  const selector = visibleWorkspaceSelector(page);
  await expect(selector).toHaveCount(1, { timeout: 15_000 });
  await selector.click();
  const preferredMembership = page.getByRole("option", {
    name: `${fixture.workspaceName} · teacher`,
    exact: true,
  });
  await expect(preferredMembership).toHaveCount(1);
  await preferredMembership.click();
  await expect(selector).toContainText(fixture.workspaceName);
  await expect(
    page.getByRole("heading", { name: "Teacher Overview", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
}

async function selectClassInCurrentWorkspace(page: Page, className: string) {
  await safeGoto(page, "/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  const available = await classSelector
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!available) return false;

  const noEligibleClass = page.getByText(
    "Join an active class that matches this task before submitting writing.",
    { exact: true },
  );
  await expect
    .poll(
      async () =>
        (await classSelector.isEnabled()) ||
        (await noEligibleClass.isVisible()),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!(await classSelector.isEnabled())) return false;

  await classSelector.click();
  const classOption = page.getByRole("option", {
    name: `${className} · ${CLASS_LEVEL}`,
    exact: true,
  });
  if ((await classOption.count()) !== 1) {
    await page.keyboard.press("Escape");
    return false;
  }
  await classOption.click();
  await expect(classSelector).toContainText(className);
  return true;
}

async function selectCreatedStudentClass(
  page: Page,
  className: string,
  workspaceName: string,
) {
  await safeGoto(page, "/student/dashboard");
  await safeReload(page);
  const workspaceSelector = visibleWorkspaceSelector(page);
  await expect(workspaceSelector).toHaveCount(1, { timeout: 15_000 });
  await workspaceSelector.click();
  const fixtureWorkspace = page.getByRole("option", {
    name: `${workspaceName} · student`,
    exact: true,
  });
  await expect(fixtureWorkspace).toHaveCount(1, { timeout: 15_000 });
  await fixtureWorkspace.click();
  await expect(workspaceSelector).toContainText(workspaceName);
  await expect(
    page.getByRole("heading", { name: /^Welcome back,/ }),
  ).toBeVisible({ timeout: 10_000 });
  if (!(await selectClassInCurrentWorkspace(page, className))) {
    throw new Error(
      "The approved test class was not available in its exact student workspace.",
    );
  }
}

async function submitSyntheticWriting(page: Page, writing: string) {
  await expect(page.getByTestId("writing-draft-status")).toContainText(
    "Draft ready",
    { timeout: 15_000 },
  );
  const writingField = page.getByLabel("Your Text");
  await fillPrivately(writingField, writing);
  await expect(page.getByTestId("writing-draft-status")).toContainText(
    "Saved",
    { timeout: 20_000 },
  );

  await safeReload(page);
  await expect
    .poll(async () => (await writingField.inputValue()) === writing, {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.getByTestId("writing-draft-status")).toContainText("Saved");

  const acknowledgementStartedAt = Date.now();
  await page.getByRole("button", { name: "Submit Writing" }).click();
  await expect(
    page.getByRole("heading", { name: "Writing submitted safely." }),
  ).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - acknowledgementStartedAt).toBeLessThan(15_000);
}

async function openSubmittedStudentWriting(page: Page) {
  await page.getByRole("button", { name: "View Submission" }).click();
  await expect(
    page.getByText("Original Submission", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

async function assertFeedbackHidden(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Feedback Summary", level: 2 }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Corrected Version", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Line-by-line" })).toHaveCount(0);
  await expect(
    page.getByText(RELEASED_SUMMARY_MARKER, { exact: true }),
  ).toHaveCount(0);
}

async function assertTeacherReviewPrivateForStudent(page: Page) {
  await safeReload(page);
  await expect(
    page.getByRole("heading", { name: "Awaiting release." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(
      "Your feedback is prepared and remains private until your teacher releases it.",
      { exact: true },
    ),
  ).toBeVisible();
  await assertFeedbackHidden(page);
}

async function openTeacherReviewItem(page: Page, className: string) {
  await safeGoto(page, "/teacher/review-queue");
  await expect(
    page.getByRole("heading", { name: "Review Queue", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Filter writing feedback queue").click();
  await page.getByRole("option", { name: "Teacher review" }).click();

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const rows = page.getByRole("row").filter({ hasText: className });
    const count = await rows.count();
    if (count > 1) {
      throw new Error("The teacher-review queue item was not unique.");
    }
    if (count === 1) {
      await rows.getByRole("link", { name: "Review" }).click();
      await expect(
        page.getByText("Teacher feedback editor", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      return;
    }

    const refresh = page.getByLabel("Refresh writing feedback queue");
    if (await refresh.isEnabled()) await refresh.click();
    await waitBriefly(page, 2_000);
  }

  throw new Error("Teacher-review feedback did not reach a private draft.");
}

async function currentDraftRevision(page: Page) {
  const label = page.getByText(/^Version \d+, revision \d+$/).first();
  const text = (await label.textContent())?.trim() ?? "";
  const match = /^Version \d+, revision (\d+)$/.exec(text);
  if (!match) {
    throw new Error("The private feedback revision could not be verified.");
  }
  return Number.parseInt(match[1], 10);
}

async function saveAndReleaseTeacherDraft(
  teacherPage: Page,
  studentPage: Page,
) {
  await expect(
    teacherPage.getByText("Private feedback draft", { exact: true }),
  ).toBeVisible();
  await assertTeacherReviewPrivateForStudent(studentPage);

  const initialRevision = await currentDraftRevision(teacherPage);
  await fillPrivately(
    teacherPage.getByLabel("Overall summary"),
    RELEASED_SUMMARY_MARKER,
  );

  const saveResponse = await observeRpcAction(
    teacherPage,
    "update_feedback_draft",
    async () => {
      await teacherPage
        .getByRole("button", { name: "Save private draft" })
        .click();
    },
  );
  let requestBody: unknown;
  try {
    requestBody = saveResponse.request().postDataJSON();
  } catch {
    throw new Error("The draft revision contract could not be inspected.");
  }
  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    !("expected_revision" in requestBody) ||
    requestBody.expected_revision !== initialRevision
  ) {
    throw new Error("The draft save did not use its expected revision.");
  }
  await expect(
    teacherPage.getByText("Feedback draft saved", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () => (await currentDraftRevision(teacherPage)) > initialRevision,
      {
        timeout: 15_000,
      },
    )
    .toBe(true);

  await assertTeacherReviewPrivateForStudent(studentPage);
  const releaseButton = teacherPage.getByRole("button", {
    name: "Approve and release",
  });
  if (!(await releaseButton.isEnabled())) {
    throw new Error("The validated teacher draft was not releasable.");
  }
  const releaseResponse = await observeRpcAction(
    teacherPage,
    "release_feedback",
    async () => {
      await releaseButton.click();
    },
  );
  let releaseRequestBody: unknown;
  try {
    releaseRequestBody = releaseResponse.request().postDataJSON();
  } catch {
    throw new Error(
      "The feedback release could not be tied to its exact submission.",
    );
  }
  if (
    !isUnknownRecord(releaseRequestBody) ||
    typeof releaseRequestBody.submission_id !== "string" ||
    releaseRequestBody.submission_id.length === 0
  ) {
    throw new Error(
      "The feedback release could not be tied to its exact submission.",
    );
  }
  const releasedSubmissionId = releaseRequestBody.submission_id;
  await expect(
    teacherPage.getByText("Feedback released", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });

  await waitForReleasedStudentFeedback({
    page: studentPage,
    submissionId: releasedSubmissionId,
    deadline: Date.now() + 120_000,
    deadlineFailure: "Teacher-review feedback did not appear after release.",
  });
  await expect(
    studentPage.getByText(RELEASED_SUMMARY_MARKER, { exact: true }),
  ).toBeVisible();
  await expect(
    studentPage.getByText("Corrected Version", { exact: true }),
  ).toBeVisible();
  await expect(
    studentPage.getByRole("tab", { name: "Line-by-line" }),
  ).toBeVisible();
}

async function assertExactScheduledSubmissionIdentity(
  page: Page,
  submissionId: string,
  className: string,
) {
  const exactPath = await page.evaluate(
    (expectedSubmissionId) =>
      window.location.pathname ===
      `/teacher/submission/${expectedSubmissionId}`,
    submissionId,
  );
  if (!exactPath) {
    throw new Error("The scheduled submission detail route changed.");
  }
  await expect(page.getByText(className, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

function parseSubmissionIdFromDetailHref(href: string | null) {
  const match = href?.match(
    /^\/teacher\/submission\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (!match?.[1]) {
    throw new Error("The scheduled submission link was invalid.");
  }
  return match[1];
}

async function openScheduledTeacherSubmission(page: Page, className: string) {
  await safeGoto(page, "/teacher/submissions");
  await expect(
    page.getByRole("heading", { name: "Student Submissions", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading submissions/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  const row = page.getByRole("row").filter({ hasText: className });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const openLink = row.getByRole("link", { name: "Open" });
  const submissionId = parseSubmissionIdFromDetailHref(
    await openLink.getAttribute("href"),
  );
  const readMonitor = monitorScheduledPreviewReadPath(page, submissionId);
  try {
    await openLink.click();
    await assertExactScheduledSubmissionIdentity(page, submissionId, className);
    return { submissionId, readMonitor };
  } catch (error) {
    await readMonitor.stop();
    throw error;
  }
}

function firstScheduledReadFailure(
  observations: ScheduledPreviewReadObservation[],
) {
  return observations.find(
    (observation) =>
      observation.httpStatus >= 400 ||
      (observation.kind === "get_feedback_draft" &&
        observation.draftPresent === false),
  );
}

function scheduledReadEvidenceCode(
  observations: ScheduledPreviewReadObservation[],
) {
  const latestDetail = observations
    .filter((observation) => observation.kind === "get_submission_detail")
    .at(-1);
  const latestDraft = observations
    .filter((observation) => observation.kind === "get_feedback_draft")
    .at(-1);
  const knownEvaluation = [
    "queued",
    "processing",
    "ready",
    "needs_review",
    "failed",
  ].includes(latestDetail?.evaluationStatus ?? "")
    ? latestDetail!.evaluationStatus
    : "unobserved";
  const knownRelease = ["held", "scheduled", "released"].includes(
    latestDetail?.releaseStatus ?? "",
  )
    ? latestDetail!.releaseStatus
    : "unobserved";
  const knownMode = [
    "immediate",
    "automatic_delayed",
    "teacher_review_only",
  ].includes(latestDetail?.feedbackMode ?? "")
    ? latestDetail!.feedbackMode
    : "unobserved";
  const knownDraftState = ["draft", "needs_review", "approved"].includes(
    latestDraft?.draftState ?? "",
  )
    ? latestDraft!.draftState
    : "unobserved";
  return [
    `detail_http_${latestDetail?.httpStatus ?? "none"}`,
    `detail_${knownEvaluation}_${knownRelease}_${knownMode}`,
    `draft_http_${latestDraft?.httpStatus ?? "none"}`,
    `draft_${latestDraft?.draftPresent === true ? "present" : latestDraft?.draftPresent === false ? "absent" : "unobserved"}_${knownDraftState}`,
  ].join("|");
}

function hasScheduledPreviewReadEvidence(
  observations: ScheduledPreviewReadObservation[],
) {
  const detailReady = observations.some(
    (observation) =>
      observation.kind === "get_submission_detail" &&
      observation.httpStatus < 400 &&
      observation.evaluationStatus === "ready" &&
      observation.releaseStatus === "scheduled" &&
      observation.feedbackMode === "automatic_delayed",
  );
  const draftReady = observations.some(
    (observation) =>
      observation.kind === "get_feedback_draft" &&
      observation.httpStatus < 400 &&
      observation.draftPresent === true &&
      (observation.draftState === "draft" ||
        observation.draftState === "approved"),
  );
  return detailReady && draftReady;
}

function recoveryReadSettled(
  observations: ScheduledPreviewReadObservation[],
  priorDetailCount: number,
  priorDraftCount: number,
) {
  const laterDetails = observations
    .filter((observation) => observation.kind === "get_submission_detail")
    .slice(priorDetailCount);
  if (laterDetails.length === 0) return false;
  const latestDetail = laterDetails.at(-1)!;
  if (
    latestDetail.httpStatus >= 400 ||
    !["ready", "needs_review"].includes(latestDetail.evaluationStatus ?? "")
  ) {
    return true;
  }
  return (
    observations.filter(
      (observation) => observation.kind === "get_feedback_draft",
    ).length > priorDraftCount
  );
}

async function waitForScheduledTeacherPreview(
  page: Page,
  releaseAt: number,
  submissionId: string,
  className: string,
  readMonitor: ScheduledPreviewReadMonitor,
) {
  const deadline = Math.min(Date.now() + 180_000, releaseAt - 5_000);
  const recoveryReloadAt = Math.min(Date.now() + 60_000, deadline - 20_000);
  let recoveryReloaded = false;
  while (Date.now() < deadline) {
    await readMonitor.settle();
    if (firstScheduledReadFailure(readMonitor.observations)) {
      throw new Error(
        `The scheduled preview read failed safely (${scheduledReadEvidenceCode(readMonitor.observations)}).`,
      );
    }
    if (
      await page
        .getByText("Teacher feedback editor", { exact: true })
        .isVisible()
    ) {
      throw new Error("Scheduled evaluation required human review.");
    }
    if (
      await page
        .getByText("Scheduled feedback preview", { exact: true })
        .isVisible()
    ) {
      await readMonitor.settle();
      if (!hasScheduledPreviewReadEvidence(readMonitor.observations)) {
        throw new Error(
          `The scheduled preview appeared without its verified read state (${scheduledReadEvidenceCode(readMonitor.observations)}).`,
        );
      }
      return;
    }
    if (
      await page
        .getByRole("button", { name: "Reload private draft" })
        .isVisible()
    ) {
      throw new Error("The private scheduled draft could not be loaded.");
    }
    if (
      await page
        .getByRole("button", { name: "Try preparing again" })
        .isVisible()
    ) {
      throw new Error("Scheduled evaluation reached a failed state.");
    }
    if (
      await page.getByText("Submission not found.", { exact: true }).isVisible()
    ) {
      throw new Error("The scheduled submission detail became unavailable.");
    }

    if (!recoveryReloaded && Date.now() >= recoveryReloadAt) {
      recoveryReloaded = true;
      const priorDetailCount = readMonitor.observations.filter(
        (observation) => observation.kind === "get_submission_detail",
      ).length;
      const priorDraftCount = readMonitor.observations.filter(
        (observation) => observation.kind === "get_feedback_draft",
      ).length;
      await safeReload(page);
      await assertExactScheduledSubmissionIdentity(
        page,
        submissionId,
        className,
      );
      await expect
        .poll(
          async () => {
            await readMonitor.settle();
            return recoveryReadSettled(
              readMonitor.observations,
              priorDetailCount,
              priorDraftCount,
            );
          },
          { timeout: 15_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);
      continue;
    }
    await waitBriefly(page, 2_000);
  }
  throw new Error(
    `Scheduled feedback was not prepared before its due time (${scheduledReadEvidenceCode(readMonitor.observations)}).`,
  );
}

async function assertScheduledPreviewIsPrivate(
  teacherPage: Page,
  studentPage: Page,
) {
  await expect(
    teacherPage.getByText("Scheduled feedback preview", { exact: true }),
  ).toBeVisible();
  await expect(
    teacherPage.getByRole("heading", { name: "Feedback Summary", level: 2 }),
  ).toBeVisible();
  await expect(
    teacherPage.getByText("Corrected Version", { exact: true }),
  ).toBeVisible();
  await expect(
    teacherPage.getByRole("tab", { name: "Line-by-line" }),
  ).toBeVisible();
  for (const buttonName of [
    "Approve and release",
    "Save private draft",
    "Release overdue feedback",
  ]) {
    await expect(
      teacherPage.getByRole("button", { name: buttonName }),
    ).toHaveCount(0);
  }

  await safeReload(studentPage);
  await expect(
    studentPage.getByRole("heading", { name: "Feedback scheduled." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    studentPage.getByText(
      "Your feedback is prepared and will appear at the scheduled release time.",
      { exact: true },
    ),
  ).toBeVisible();
  await assertFeedbackHidden(studentPage);
}

async function protectScheduledPrivacyUntilDue(
  studentPage: Page,
  releaseAt: number,
) {
  while (Date.now() < releaseAt) {
    const refreshStartedAt = Date.now();
    await safeReload(studentPage);
    if (Date.now() < releaseAt && refreshStartedAt < releaseAt) {
      await assertFeedbackHidden(studentPage);
    }
    const remaining = releaseAt - Date.now();
    if (remaining > 0) {
      await waitBriefly(studentPage, Math.min(15_000, remaining));
    }
  }
}

async function waitForScheduledRelease(
  page: Page,
  releaseAt: number,
  submissionId: string,
) {
  const releaseDeadline = releaseAt + 60_000;
  await waitForReleasedStudentFeedback({
    page,
    submissionId,
    deadline: releaseDeadline,
    deadlineFailure: "Scheduled feedback missed its one-minute release gate.",
  });
  await expect(
    page.getByText("Corrected Version", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Line-by-line" })).toBeVisible();
}

async function offboardTestMembership(
  page: Page,
  studentEmail: string,
  classNames: string[],
) {
  await filterRosterByStudent(page, studentEmail);
  const removeAccess = page.getByRole("button", {
    name: "Remove access",
    exact: true,
  });
  if ((await removeAccess.count()) === 0) return false;
  if ((await removeAccess.count()) !== 1) {
    throw new Error("The cleanup student lookup was not unique.");
  }

  const studentRow = removeAccess.locator("xpath=ancestor::tr[1]");
  const assignmentRemovals = studentRow.locator(
    'button[aria-label^="Remove "]',
  );
  if ((await assignmentRemovals.count()) !== classNames.length) {
    throw new Error(
      "The test membership assignment count changed during the run.",
    );
  }
  const assignmentLabels = (
    await assignmentRemovals.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    )
  ).sort();
  const expectedLabels = classNames.map((name) => `Remove ${name}`).sort();
  if (JSON.stringify(assignmentLabels) !== JSON.stringify(expectedLabels)) {
    throw new Error("The test membership assignment changed during the run.");
  }

  await removeAccess.click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Remove student access" }).click();
  await expect(
    page.getByText(/^Offboarding completed for /).last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(removeAccess).toHaveCount(0, { timeout: 10_000 });
  return true;
}

async function assertStudentClassAccessRemoved(
  page: Page,
  classNames: string[],
) {
  await expect
    .poll(
      async () => {
        await safeGoto(page, "/student/write?mode=free");
        await safeReload(page);
        const selector = page.getByLabel("Class receiving this writing");
        if ((await selector.count()) === 0 || !(await selector.isEnabled())) {
          return true;
        }
        await selector.click();
        let removed = true;
        for (const className of classNames) {
          const oldClass = page.getByRole("option", {
            name: `${className} · ${CLASS_LEVEL}`,
            exact: true,
          });
          if ((await oldClass.count()) !== 0) removed = false;
        }
        await page.keyboard.press("Escape");
        return removed;
      },
      { timeout: 20_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
}

async function archiveCreatedClass(page: Page, className: string) {
  await safeGoto(page, "/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Filter classes by status").click();
  await page.getByRole("option", { name: "All Statuses" }).click();

  const { card, codeAnchor } = classCard(page, className);
  const exists = await codeAnchor
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!exists) return;

  const studentsRow = card
    .getByText("Students", { exact: true })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flex ') and contains(concat(' ', normalize-space(@class), ' '), ' justify-between ')][1]",
    );
  const remainingStudentText = (
    await studentsRow.locator("span.font-semibold").textContent()
  )?.trim();
  const remainingStudents = Number.parseInt(remainingStudentText ?? "", 10);
  if (!Number.isSafeInteger(remainingStudents) || remainingStudents !== 0) {
    throw new Error("The test class still contains a current assignment.");
  }

  const archive = card.getByRole("button", {
    name: "Archive Class",
    exact: true,
  });
  if ((await archive.count()) === 1) await archive.click();
  await expect(
    card.getByRole("button", { name: "Reactivate Class", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
}

async function assertTeacherHistoryPreserved(page: Page, className: string) {
  await safeGoto(page, "/teacher/submissions");
  await expect(
    page.getByRole("heading", { name: "Student Submissions", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading submissions/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(
    page.getByRole("row").filter({ hasText: className }),
  ).toHaveCount(1, { timeout: 15_000 });
}

async function runTeacherReviewWorkflow(options: {
  teacherPage: Page;
  studentPage: Page;
  studentEmail: string;
  className: string;
  workspaceName: string;
}) {
  const joinCode = await createClass(
    options.teacherPage,
    options.className,
    "teacher-review",
  );
  await submitJoinRequest(options.studentPage, joinCode, options.className);
  await approveJoinRequest(options.teacherPage, options.className);
  await selectCreatedStudentClass(
    options.studentPage,
    options.className,
    options.workspaceName,
  );
  await submitSyntheticWriting(options.studentPage, TEACHER_REVIEW_WRITING);
  await expect(
    options.studentPage.getByText("Release: Held safely", { exact: true }),
  ).toBeVisible();
  await openSubmittedStudentWriting(options.studentPage);
  await assertFeedbackHidden(options.studentPage);

  await openTeacherReviewItem(options.teacherPage, options.className);
  await saveAndReleaseTeacherDraft(options.teacherPage, options.studentPage);
}

async function runScheduledWorkflow(options: {
  teacherPage: Page;
  studentPage: Page;
  studentEmail: string;
  className: string;
  workspaceName: string;
}) {
  const joinCode = await createClass(
    options.teacherPage,
    options.className,
    "scheduled",
  );
  await submitJoinRequest(options.studentPage, joinCode, options.className);
  await approveJoinRequest(options.teacherPage, options.className);
  await selectCreatedStudentClass(
    options.studentPage,
    options.className,
    options.workspaceName,
  );
  await submitSyntheticWriting(options.studentPage, SCHEDULED_WRITING);

  await expect(
    options.studentPage.getByText("Release: Scheduled", { exact: true }),
  ).toBeVisible();
  const releaseValue = await options.studentPage
    .locator("time[datetime]")
    .getAttribute("datetime");
  const releaseAt = releaseValue ? Date.parse(releaseValue) : Number.NaN;
  if (!Number.isFinite(releaseAt)) {
    throw new Error("The scheduled release time was not valid.");
  }
  const releaseDelay = releaseAt - Date.now();
  if (releaseDelay < 180_000 || releaseDelay > 300_000) {
    throw new Error("The scheduled release did not use the fixed delay.");
  }

  await openSubmittedStudentWriting(options.studentPage);
  await assertFeedbackHidden(options.studentPage);
  const { submissionId, readMonitor } = await openScheduledTeacherSubmission(
    options.teacherPage,
    options.className,
  );
  try {
    await waitForScheduledTeacherPreview(
      options.teacherPage,
      releaseAt,
      submissionId,
      options.className,
      readMonitor,
    );
    await assertScheduledPreviewIsPrivate(
      options.teacherPage,
      options.studentPage,
    );
    await protectScheduledPrivacyUntilDue(options.studentPage, releaseAt);
    await waitForScheduledRelease(options.studentPage, releaseAt, submissionId);
  } finally {
    await readMonitor.stop();
  }
}

async function newPrivateContext(browser: Browser, baseURL: string) {
  return browser.newContext({
    baseURL,
    viewport: { width: 1366, height: 768 },
  });
}

test.skip(
  process.env.E2E_FEEDBACK_MODES !== "true" && !feedbackModesRecoveryOnly,
  "Set E2E_FEEDBACK_MODES=true for the isolated run or E2E_FEEDBACK_MODES_RECOVERY_ONLY=true for exact recovery.",
);

test.describe.serial("authenticated real feedback-mode workflows", () => {
  test.beforeAll(async () => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    if (feedbackModesRecoveryOnly) {
      await recoverPreviousFeedbackModesFixture();
      return;
    }
    isolatedFixture = await prepareFeedbackModesFixture(
      credentials("TEACHER"),
      credentials("STUDENT"),
    );
    isolatedFixtureInstalled = true;
  });

  test.afterAll(async () => {
    if (!isolatedFixtureInstalled || !isolatedFixture) return;
    await cleanupFeedbackModesFixture(isolatedFixture);
  });

  test("teacher review and scheduled feedback remain private, release safely, and preserve history after offboarding", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(720_000);
    test.skip(
      feedbackModesRecoveryOnly,
      "The previous isolated fixture was recovered without a provider call.",
    );
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The feedback-mode workflow needs a local base address.");
    }

    const teacherAccount = credentials("TEACHER");
    const studentAccount = credentials("STUDENT");
    if (!isolatedFixture) {
      throw new Error("The isolated feedback-mode fixture was not prepared.");
    }
    if (
      teacherAccount.email.toLowerCase() === studentAccount.email.toLowerCase()
    ) {
      throw new Error(
        "Teacher and student workflow accounts must be different.",
      );
    }

    const teacherContext = await newPrivateContext(browser, baseURL);
    const studentContext = await newPrivateContext(browser, baseURL);
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    const assertNoTeacherFailures = monitorFatalBrowserFailures(teacherPage);
    const assertNoStudentFailures = monitorFatalBrowserFailures(studentPage);
    const runStamp = `${Date.now().toString(36)}-${process.pid}`;

    try {
      await signIn(teacherPage, teacherAccount, "teacher");
      await signIn(studentPage, studentAccount, "student");
      await selectPreferredTeacherMembership(teacherPage, isolatedFixture);

      const teacherReviewClassName = `V1 feedback review ${runStamp}`;
      const scheduledClassName = `V1 scheduled feedback ${runStamp}`;
      await runTeacherReviewWorkflow({
        teacherPage,
        studentPage,
        studentEmail: studentAccount.email,
        className: teacherReviewClassName,
        workspaceName: isolatedFixture.workspaceName,
      });
      await runScheduledWorkflow({
        teacherPage,
        studentPage,
        studentEmail: studentAccount.email,
        className: scheduledClassName,
        workspaceName: isolatedFixture.workspaceName,
      });

      const classNames = [teacherReviewClassName, scheduledClassName];
      const offboarded = await offboardTestMembership(
        teacherPage,
        studentAccount.email,
        classNames,
      );
      expect(offboarded).toBe(true);
      await assertStudentClassAccessRemoved(studentPage, classNames);
      for (const className of classNames) {
        await archiveCreatedClass(teacherPage, className);
        await assertTeacherHistoryPreserved(teacherPage, className);
      }

      assertNoTeacherFailures();
      assertNoStudentFailures();
    } finally {
      await Promise.allSettled([
        teacherContext.close(),
        studentContext.close(),
      ]);
    }
  });
});
