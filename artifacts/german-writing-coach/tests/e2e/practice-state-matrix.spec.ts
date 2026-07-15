import { expect, test, type Locator, type Page } from "@playwright/test";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const FIXTURE_PATH = "/tests/e2e/fixtures/practice-state-matrix.html";
const OBJECTIVE_FIXTURE_PATH = "/tests/e2e/fixtures/objective-worksheet.html";
const FIXTURE_API_ORIGIN = "http://127.0.0.1:54321";
const OBJECTIVE_ASSIGNMENT_ID = "55555555-5555-4555-8555-555555555555";
const OBJECTIVE_WORKSHEET_ID = "66666666-6666-4666-8666-666666666666";
const OBJECTIVE_ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";

const viewports = [
  { name: "mobile", width: 360, height: 640 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "short-desktop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

type WeaknessLevel =
  | "locked"
  | "unlocked"
  | "in_progress"
  | "improving"
  | "mastered";

type GrammarStatFixture = {
  id: string;
  workspace_id: string;
  student_id: string;
  grammar_topic_id: string;
  topic_name: string;
  topic_slug: string;
  topic_description: string;
  total_minor_issues: number;
  total_major_issues: number;
  total_correct_after_practice: number;
  weakness_level: WeaknessLevel;
  practice_unlocked: boolean;
  resolution_cycle_id: string | null;
  resolution_cycle_number: number;
  resolved_through_sequence: number;
  mastery_pass_count: number;
  state_reason: string | null;
  last_seen_at: string | null;
  updated_at: string;
};

type AssignmentFixture = Record<string, unknown> & {
  id: string;
  grammar_topic_id: string;
};

const topicNames = {
  evidence: "Evidence Builder",
  idle: "Ready to Prepare",
  queued: "Queued Worksheet",
  generating: "Generating Worksheet",
  ready: "Ready Worksheet",
  inProgress: "Active Worksheet",
  qualityHeld: "Quality Held",
  retryFailed: "Retry Required",
  improving: "Improving Topic",
  mastered: "Mastered Topic",
  noCurrent: "No Current Worksheet",
} as const;

function makeStat(options: {
  key: keyof typeof topicNames;
  weaknessLevel: WeaknessLevel;
  practiceUnlocked?: boolean;
  minor?: number;
  major?: number;
  masteryPassCount?: number;
  stateReason?: string | null;
}): GrammarStatFixture {
  const topicId = `topic-${options.key}`;
  return {
    id: `stat-${options.key}`,
    workspace_id: WORKSPACE_ID,
    student_id: STUDENT_ID,
    grammar_topic_id: topicId,
    topic_name: topicNames[options.key],
    topic_slug: options.key.replace(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    ),
    topic_description: `Synthetic description for ${topicNames[options.key]}.`,
    total_minor_issues: options.minor ?? 0,
    total_major_issues: options.major ?? 0,
    total_correct_after_practice: options.masteryPassCount ?? 0,
    weakness_level: options.weaknessLevel,
    practice_unlocked: options.practiceUnlocked ?? false,
    resolution_cycle_id: `cycle-${options.key}`,
    resolution_cycle_number: 1,
    resolved_through_sequence: 0,
    mastery_pass_count: options.masteryPassCount ?? 0,
    state_reason: options.stateReason ?? null,
    last_seen_at: "2026-07-12T06:00:00.000Z",
    updated_at: "2026-07-12T06:00:00.000Z",
  };
}

function makeAssignment(options: {
  key: keyof typeof topicNames;
  status: "unlocked" | "in_progress" | "completed" | "passed" | "failed";
  generationStatus:
    | "idle"
    | "queued"
    | "generating"
    | "ready"
    | "needs_review"
    | "failed";
  hasWorksheet: boolean;
  passed?: boolean | null;
  scorePercent?: number | null;
  generationRetryExhausted?: boolean;
}): AssignmentFixture {
  const completed = ["completed", "passed", "failed"].includes(options.status);
  const hasAttempt = options.status !== "unlocked";
  return {
    id: `assignment-${options.key}`,
    workspace_id: WORKSPACE_ID,
    student_id: STUDENT_ID,
    grammar_topic_id: `topic-${options.key}`,
    grammar_topic_name: topicNames[options.key],
    grammar_topic_slug: options.key,
    grammar_topic_description: `Synthetic description for ${topicNames[options.key]}.`,
    batch_id: BATCH_ID,
    batch_name: "Fixture Class",
    class_context_version: 1,
    practice_test_id: options.hasWorksheet ? `worksheet-${options.key}` : null,
    worksheet_title: options.hasWorksheet
      ? `${topicNames[options.key]} Practice Worksheet`
      : null,
    worksheet_level: options.hasWorksheet ? "A2" : null,
    worksheet_difficulty: options.hasWorksheet ? "standard" : null,
    worksheet_mini_lesson: null,
    status: options.status,
    source: "adaptive",
    assigned_at: "2026-07-12T06:00:00.000Z",
    started_at: hasAttempt ? "2026-07-12T06:05:00.000Z" : null,
    completed_at: completed ? "2026-07-12T06:15:00.000Z" : null,
    latest_attempt_id: hasAttempt ? `attempt-${options.key}` : null,
    latest_attempt_status: completed
      ? "checked"
      : options.status === "in_progress"
        ? "in_progress"
        : null,
    score: options.scorePercent ?? null,
    max_score: options.scorePercent == null ? null : 100,
    score_points: options.scorePercent ?? null,
    max_score_points: options.scorePercent == null ? null : 100,
    scoring_version: completed ? "fixture-v1" : null,
    evaluation_status: completed ? "completed" : null,
    evaluation_automatic_retry_at: null,
    evaluation_automatic_retry_exhausted_at: null,
    evaluation_started_at: completed ? "2026-07-12T06:14:00.000Z" : null,
    evaluation_completed_at: completed ? "2026-07-12T06:15:00.000Z" : null,
    evaluation_error: null,
    score_percent: options.scorePercent ?? null,
    passed: options.passed ?? null,
    question_count: options.hasWorksheet ? 8 : 0,
    generation_status: options.generationStatus,
    generation_retry_exhausted: options.generationRetryExhausted === true,
    generation_automatic_retry_at: null,
    generation_automatic_retry_exhausted_at:
      options.generationStatus === "failed" ? "2026-07-12T06:10:00.000Z" : null,
    generation_started_at:
      options.generationStatus === "idle" ? null : "2026-07-12T06:01:00.000Z",
    generation_completed_at:
      options.generationStatus === "ready" ? "2026-07-12T06:02:00.000Z" : null,
    generation_error:
      options.generationStatus === "failed"
        ? "fixture_generation_failed"
        : null,
    previous_assignment_id: null,
    previous_attempt_id: null,
    repeat_number: 0,
    adaptive_reason: "Synthetic released-feedback evidence.",
    adaptive_status: completed ? "resolved" : "active",
    resolution_cycle_id: `cycle-${options.key}`,
    resolution_cycle_number: 1,
    evidence_cutoff_sequence: 0,
    updated_at: "2026-07-12T06:15:00.000Z",
  };
}

function compareGrammarStats(
  left: GrammarStatFixture,
  right: GrammarStatFixture,
) {
  if (left.practice_unlocked !== right.practice_unlocked) {
    return left.practice_unlocked ? -1 : 1;
  }
  if (left.total_major_issues !== right.total_major_issues) {
    return right.total_major_issues - left.total_major_issues;
  }
  if (left.total_minor_issues !== right.total_minor_issues) {
    return right.total_minor_issues - left.total_minor_issues;
  }
  return left.id.localeCompare(right.id);
}

function stateMatrixFixtures() {
  const stats = [
    makeStat({
      key: "evidence",
      weaknessLevel: "locked",
      minor: 2,
      stateReason: "level_fit_approval_required",
    }),
    makeStat({
      key: "idle",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      minor: 3,
    }),
    makeStat({
      key: "queued",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      minor: 4,
    }),
    makeStat({
      key: "generating",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      minor: 5,
    }),
    makeStat({
      key: "ready",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      major: 2,
    }),
    makeStat({ key: "inProgress", weaknessLevel: "in_progress", major: 2 }),
    makeStat({
      key: "qualityHeld",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      major: 1,
    }),
    makeStat({
      key: "retryFailed",
      weaknessLevel: "unlocked",
      practiceUnlocked: true,
      minor: 3,
    }),
    makeStat({ key: "improving", weaknessLevel: "improving" }),
    makeStat({
      key: "mastered",
      weaknessLevel: "mastered",
      masteryPassCount: 2,
    }),
    makeStat({
      key: "noCurrent",
      weaknessLevel: "locked",
      minor: 1,
      stateReason: "active_class_context_required",
    }),
  ].sort(compareGrammarStats);

  const assignments = [
    makeAssignment({
      key: "idle",
      status: "unlocked",
      generationStatus: "idle",
      hasWorksheet: false,
    }),
    makeAssignment({
      key: "queued",
      status: "unlocked",
      generationStatus: "queued",
      hasWorksheet: false,
    }),
    makeAssignment({
      key: "generating",
      status: "unlocked",
      generationStatus: "generating",
      hasWorksheet: false,
    }),
    makeAssignment({
      key: "ready",
      status: "unlocked",
      generationStatus: "ready",
      hasWorksheet: true,
    }),
    makeAssignment({
      key: "inProgress",
      status: "in_progress",
      generationStatus: "ready",
      hasWorksheet: true,
    }),
    makeAssignment({
      key: "qualityHeld",
      status: "unlocked",
      generationStatus: "needs_review",
      hasWorksheet: false,
    }),
    makeAssignment({
      key: "retryFailed",
      status: "unlocked",
      generationStatus: "failed",
      hasWorksheet: false,
      generationRetryExhausted: true,
    }),
    makeAssignment({
      key: "improving",
      status: "passed",
      generationStatus: "ready",
      hasWorksheet: true,
      passed: true,
      scorePercent: 84,
    }),
    makeAssignment({
      key: "mastered",
      status: "passed",
      generationStatus: "ready",
      hasWorksheet: true,
      passed: true,
      scorePercent: 92,
    }),
    makeAssignment({
      key: "noCurrent",
      status: "completed",
      generationStatus: "ready",
      hasWorksheet: true,
      passed: false,
      scorePercent: 68,
    }),
  ];
  return { assignments, stats };
}

function apiPage(items: unknown[]) {
  return {
    schema_version: 1,
    items,
    total_count: items.length,
    returned_count: items.length,
    page_size: 100,
    has_more: false,
    next_cursor: null,
  };
}

async function installPracticeFixtures(
  page: Page,
  fixtures: { stats: GrammarStatFixture[]; assignments: AssignmentFixture[] },
) {
  const unexpectedRpcNames: string[] = [];
  const unsafeRequests: string[] = [];
  const browserFailures: string[] = [];

  page.on("pageerror", (error) =>
    browserFailures.push(`pageerror:${error.name}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserFailures.push(`console:error:${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      browserFailures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  page.on("request", (request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url());
    } catch {
      unsafeRequests.push("invalid-url");
      return;
    }
    if (
      /openai|deepseek|gemini/i.test(parsed.hostname) ||
      /\/functions\/v1\/(?:generate|prepare|process|evaluate)/.test(
        parsed.pathname,
      )
    ) {
      unsafeRequests.push("ai-request");
    }
  });

  // This deterministic UI matrix has no Supabase Realtime server. Intercept
  // the status-only socket and close it normally so the product's bounded
  // polling fallback is exercised without a synthetic connection-refused
  // browser error.
  await page.routeWebSocket(
    (url) => url.pathname === "/realtime/v1/websocket",
    (socket) => socket.close({ code: 1000, reason: "fixture-fallback" }),
  );

  await page.route(`${FIXTURE_API_ORIGIN}/rest/v1/rpc/**`, async (route) => {
    const functionName = new URL(route.request().url()).pathname
      .split("/")
      .at(-1);
    const headers = {
      "access-control-allow-origin": "*",
      "content-type": "application/json; charset=utf-8",
    };
    if (functionName === "list_student_grammar_stats_page") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify(apiPage(fixtures.stats)),
      });
      return;
    }
    if (functionName === "list_student_practice_assignments_page") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify(apiPage(fixtures.assignments)),
      });
      return;
    }
    unexpectedRpcNames.push(functionName ?? "unknown");
    await route.fulfill({
      status: 400,
      headers,
      body: JSON.stringify({ code: "fixture_unexpected_request" }),
    });
  });

  return () => {
    expect(unexpectedRpcNames, unexpectedRpcNames.join(",")).toEqual([]);
    expect(unsafeRequests, unsafeRequests.join(",")).toEqual([]);
    expect(browserFailures, browserFailures.join(",")).toEqual([]);
  };
}

function topicCard(page: Page, topicName: string) {
  return page
    .getByRole("heading", { name: topicName, level: 3 })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
    );
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    .toBe(true);
}

async function expectCardInsideViewport(card: Locator, viewportWidth: number) {
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + 1);
}

async function assertStateMatrix(page: Page, viewportWidth: number) {
  await expect(
    page.getByRole("heading", { name: "Practice Center", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Loading practice profile...")).toHaveCount(0, {
    timeout: 15_000,
  });

  for (const section of [
    "Practice unlocked",
    "In progress",
    "Temporarily unavailable",
    "Improving",
    "Mastered",
  ]) {
    await expect(
      page.getByRole("heading", { name: section, level: 2 }),
    ).toBeVisible();
  }

  const evidence = topicCard(page, topicNames.evidence);
  await expect(evidence.getByText("Locked", { exact: true })).toBeVisible();
  await expect(
    evidence.getByText(/matching this advanced topic to practice/i).first(),
  ).toBeVisible();
  await expect(evidence.getByRole("link", { name: /worksheet/i })).toHaveCount(
    0,
  );
  await expect(
    evidence.getByRole("button", { name: /worksheet/i }),
  ).toHaveCount(0);

  const idle = topicCard(page, topicNames.idle);
  await expect(
    idle.getByText(
      "Practice is unlocked. Prepare a worksheet when you are ready.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    idle.getByText(
      "Practice unlocked. Prepare a worksheet when you are ready.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    idle.getByRole("button", { name: "Prepare worksheet" }),
  ).toBeEnabled();
  await expect(
    idle.getByText(/One worksheet is ready for this focus area/),
  ).toHaveCount(0);

  for (const preparingTopic of [topicNames.queued, topicNames.generating]) {
    const preparing = topicCard(page, preparingTopic);
    await expect(
      preparing.getByText("Preparing worksheet", { exact: true }),
    ).toBeVisible();
    await expect(
      preparing.getByText(
        "Practice is unlocked and your worksheet is being prepared now.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      preparing.getByRole("button", { name: "Preparing..." }),
    ).toBeDisabled();
    await expect(
      preparing.getByText(/One worksheet is ready for this focus area/),
    ).toHaveCount(0);
  }

  const ready = topicCard(page, topicNames.ready);
  await expect(
    ready.getByText("Worksheet assigned", { exact: true }),
  ).toBeVisible();
  await expect(
    ready.getByText(
      "Your released feedback identified this focus area. One worksheet is available for practice.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    ready.getByRole("link", { name: "Start worksheet" }),
  ).toBeVisible();
  await expect(
    ready.getByText("Preparing worksheet", { exact: true }),
  ).toHaveCount(0);

  const inProgress = topicCard(page, topicNames.inProgress);
  await expect(
    inProgress.getByRole("link", { name: "Continue worksheet" }),
  ).toBeVisible();
  await expect(
    inProgress.getByText(/Finish the current worksheet before another one/),
  ).toBeVisible();
  await expect(
    inProgress.getByRole("link", { name: "Start worksheet" }),
  ).toHaveCount(0);

  const qualityHeld = topicCard(page, topicNames.qualityHeld);
  await expect(
    qualityHeld.getByText("Quality review", { exact: true }),
  ).toBeVisible();
  await expect(
    qualityHeld.getByText(
      "Practice is unlocked, but this worksheet is still being checked before assignment.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    qualityHeld.getByText(/held for quality review before it can be assigned/),
  ).toBeVisible();
  await expect(
    qualityHeld.getByRole("button", { name: "Awaiting review" }),
  ).toBeDisabled();
  await expect(
    qualityHeld.getByText(/One worksheet is ready for this focus area/),
  ).toHaveCount(0);

  const retryFailed = topicCard(page, topicNames.retryFailed);
  await expect(
    retryFailed.getByText("Preparation failed", { exact: true }),
  ).toBeVisible();
  await expect(retryFailed.getByRole("status")).toHaveText(
    "Automatic worksheet retries are exhausted. Your teacher can review this topic while approved material is checked.",
  );
  await expect(
    retryFailed.getByRole("button", { name: "Teacher review needed" }),
  ).toBeDisabled();
  await expect(
    retryFailed.getByText(/One worksheet is ready for this focus area/),
  ).toHaveCount(0);

  const improving = topicCard(page, topicNames.improving);
  await expect(improving.getByText("Improving", { exact: true })).toBeVisible();
  await expect(
    improving.getByText(/Your latest practice passed\. New writing evidence/),
  ).toBeVisible();
  await expect(improving.getByText("Passed", { exact: true })).toBeVisible();

  const mastered = topicCard(page, topicNames.mastered);
  await expect(mastered.getByText("Mastered", { exact: true })).toBeVisible();
  await expect(
    mastered.getByText(
      "This topic is mastered, so no new worksheet is needed.",
      { exact: true },
    ),
  ).toBeVisible();

  const noCurrent = topicCard(page, topicNames.noCurrent);
  await expect(
    noCurrent.getByText("No current worksheet is assigned for this topic.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    noCurrent.getByText("Recent worksheets", { exact: true }),
  ).toBeVisible();
  await expect(
    noCurrent.getByRole("link", { name: "Review worksheet" }),
  ).toBeVisible();

  for (const topicName of Object.values(topicNames)) {
    await expectCardInsideViewport(topicCard(page, topicName), viewportWidth);
  }
  await expectNoHorizontalOverflow(page);
}

for (const viewport of viewports) {
  test(`renders every truthful practice state at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const assertSafeRun = await installPracticeFixtures(
      page,
      stateMatrixFixtures(),
    );
    await page.goto(FIXTURE_PATH);
    await assertStateMatrix(page, viewport.width);
    assertSafeRun();
  });

  test(`renders the truthful empty state at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const assertSafeRun = await installPracticeFixtures(page, {
      stats: [],
      assignments: [],
    });
    await page.goto(FIXTURE_PATH);
    await expect(
      page.getByRole("heading", { name: "No focus areas yet.", level: 2 }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(
        "Released feedback from your next writing will build your focus profile here.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Practice unlocked" }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    assertSafeRun();
  });
}

type ObjectiveAnswer = { question_id: string; answer: string };

const objectiveQuestions = Array.from({ length: 9 }, (_, index) => {
  const questionNumber = index + 1;
  return {
    id: `88888888-8888-4888-8888-${questionNumber.toString().padStart(12, "0")}`,
    question_number: questionNumber,
    question_type: "multiple_choice",
    prompt: `Wähle die richtige Form für Aufgabe ${questionNumber}.`,
    options: [
      `Richtige Antwort ${questionNumber}`,
      `Ablenker A ${questionNumber}`,
      `Ablenker B ${questionNumber}`,
    ],
    correct_answer: `Richtige Antwort ${questionNumber}`,
    explanation: `Antwort ${questionNumber} folgt der geübten Regel.`,
  };
});

function objectiveAssignment(options: {
  started: boolean;
  submitted: boolean;
  score?: number;
}) {
  const score = options.submitted ? (options.score ?? 0) : null;
  return {
    id: OBJECTIVE_ASSIGNMENT_ID,
    workspace_id: WORKSPACE_ID,
    student_id: STUDENT_ID,
    grammar_topic_id: "99999999-9999-4999-8999-999999999999",
    grammar_topic_name: "Akkusativ",
    grammar_topic_slug: "akkusativ",
    grammar_topic_description: "Choose the correct accusative form.",
    batch_id: BATCH_ID,
    batch_name: "Fixture Class",
    class_context_version: 1,
    practice_test_id: OBJECTIVE_WORKSHEET_ID,
    worksheet_title: "Akkusativ Practice Worksheet",
    worksheet_level: "A2",
    worksheet_difficulty: "standard",
    worksheet_mini_lesson: null,
    status: options.submitted
      ? "passed"
      : options.started
        ? "in_progress"
        : "unlocked",
    source: "adaptive",
    assigned_at: "2026-07-12T06:00:00.000Z",
    started_at: options.started ? "2026-07-12T06:01:00.000Z" : null,
    completed_at: options.submitted ? "2026-07-12T06:10:00.000Z" : null,
    latest_attempt_id: options.submitted ? OBJECTIVE_ATTEMPT_ID : null,
    latest_attempt_status: options.submitted ? "checked" : null,
    score,
    max_score: options.submitted ? objectiveQuestions.length : null,
    score_points: score,
    max_score_points: options.submitted ? objectiveQuestions.length : null,
    scoring_version: options.submitted ? "local-exact-v1" : null,
    evaluation_status: options.submitted ? "not_needed" : null,
    evaluation_automatic_retry_at: null,
    evaluation_automatic_retry_exhausted_at: null,
    evaluation_started_at: null,
    evaluation_completed_at: options.submitted
      ? "2026-07-12T06:10:00.000Z"
      : null,
    evaluation_error: null,
    score_percent: options.submitted
      ? (score! * 100) / objectiveQuestions.length
      : null,
    passed: options.submitted ? true : null,
    question_count: objectiveQuestions.length,
    generation_status: "ready",
    generation_retry_exhausted: false,
    generation_automatic_retry_at: null,
    generation_automatic_retry_exhausted_at: null,
    generation_started_at: "2026-07-12T05:59:00.000Z",
    generation_completed_at: "2026-07-12T06:00:00.000Z",
    generation_error: null,
    previous_assignment_id: null,
    previous_attempt_id: null,
    repeat_number: 0,
    adaptive_reason: "Released feedback evidence.",
    adaptive_status: options.submitted ? "resolved" : "active",
    resolution_cycle_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    resolution_cycle_number: 1,
    evidence_cutoff_sequence: 1,
    updated_at: "2026-07-12T06:10:00.000Z",
  };
}

function objectiveReviewRows(answers: ObjectiveAnswer[]) {
  const byQuestion = new Map(
    answers.map((answer) => [answer.question_id, answer.answer]),
  );
  const score = objectiveQuestions.filter(
    (question) => byQuestion.get(question.id) === question.correct_answer,
  ).length;
  return objectiveQuestions.map((question) => {
    const studentAnswer = byQuestion.get(question.id) ?? "";
    const correct = studentAnswer === question.correct_answer;
    return {
      latest_attempt_id: OBJECTIVE_ATTEMPT_ID,
      latest_attempt_status: "checked",
      score,
      max_score: objectiveQuestions.length,
      score_points: score,
      max_score_points: objectiveQuestions.length,
      scoring_version: "local-exact-v1",
      evaluation_status: "not_needed",
      evaluation_error: null,
      score_percent: (score * 100) / objectiveQuestions.length,
      passed: true,
      question_id: question.id,
      question_number: question.question_number,
      question_type: question.question_type,
      prompt: question.prompt,
      options: question.options,
      student_answer: studentAnswer,
      correct_answer: question.correct_answer,
      explanation: question.explanation,
      is_correct: correct,
      review_status: correct ? "correct" : "incorrect",
      points_awarded: correct ? 1 : 0,
      max_points: 1,
      feedback_text: correct
        ? "Richtig gelöst."
        : "Prüfe die Akkusativform noch einmal.",
      corrected_answer: correct ? null : question.correct_answer,
      model_answer: null,
      short_reason: correct ? "Richtige Auswahl." : "Falsche Auswahl.",
      evaluator_source: "local_exact",
    };
  });
}

async function installObjectiveWorksheetFixture(page: Page) {
  const unexpectedRpcNames: string[] = [];
  const unsafeRequests: string[] = [];
  const browserFailures: string[] = [];
  let started = false;
  let submitted = false;
  let revision = 0;
  let savedAnswers: ObjectiveAnswer[] = [];
  let saveCalls = 0;
  let submitCalls = 0;

  page.on("pageerror", (error) =>
    browserFailures.push(`pageerror:${error.name}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserFailures.push(`console:error:${message.text()}`);
    }
  });
  page.on("request", (request) => {
    const parsed = new URL(request.url());
    if (
      /openai|deepseek|gemini/i.test(parsed.hostname) ||
      parsed.pathname.startsWith("/functions/v1/")
    ) {
      unsafeRequests.push(parsed.pathname);
    }
  });

  const headers = {
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
  };

  await page.route(`${FIXTURE_API_ORIGIN}/rest/v1/rpc/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const functionName = new URL(route.request().url()).pathname
      .split("/")
      .at(-1);
    const body = (route.request().postDataJSON() ?? {}) as Record<
      string,
      unknown
    >;
    const fulfill = (value: unknown) =>
      route.fulfill({ status: 200, headers, body: JSON.stringify(value) });

    if (functionName === "get_practice_assignment_summary") {
      const score = submitted
        ? objectiveQuestions.filter(
            (question) =>
              savedAnswers.find((answer) => answer.question_id === question.id)
                ?.answer === question.correct_answer,
          ).length
        : undefined;
      await fulfill(objectiveAssignment({ started, submitted, score }));
      return;
    }
    if (functionName === "start_practice_assignment") {
      expect(body.target_assignment_id).toBe(OBJECTIVE_ASSIGNMENT_ID);
      expect(submitted).toBe(false);
      started = true;
      await fulfill(objectiveAssignment({ started, submitted }));
      return;
    }
    if (functionName === "get_practice_assignment_questions") {
      expect(body.target_assignment_id).toBe(OBJECTIVE_ASSIGNMENT_ID);
      await fulfill(objectiveQuestions);
      return;
    }
    if (functionName === "get_practice_draft") {
      expect(body.target_assignment_id).toBe(OBJECTIVE_ASSIGNMENT_ID);
      await fulfill(
        revision === 0
          ? []
          : [
              {
                draft_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                assignment_id: OBJECTIVE_ASSIGNMENT_ID,
                revision,
                answers: savedAnswers,
                updated_at: "2026-07-12T06:05:00.000Z",
              },
            ],
      );
      return;
    }
    if (functionName === "save_practice_draft") {
      expect(body.target_assignment_id).toBe(OBJECTIVE_ASSIGNMENT_ID);
      expect(body.expected_revision).toBe(revision);
      expect(body.submitted_answers).toHaveLength(objectiveQuestions.length);
      savedAnswers = structuredClone(
        body.submitted_answers as ObjectiveAnswer[],
      );
      revision += 1;
      saveCalls += 1;
      await fulfill([
        {
          draft_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          assignment_id: OBJECTIVE_ASSIGNMENT_ID,
          saved_revision: revision,
          answers: savedAnswers,
          saved_at: "2026-07-12T06:05:00.000Z",
        },
      ]);
      return;
    }
    if (functionName === "submit_practice_attempt") {
      expect(body.target_assignment_id).toBe(OBJECTIVE_ASSIGNMENT_ID);
      expect(body.expected_revision).toBe(revision);
      expect(body).not.toHaveProperty("submitted_answers");
      expect(savedAnswers).toHaveLength(objectiveQuestions.length);
      expect(savedAnswers.every((answer) => answer.answer.length > 0)).toBe(
        true,
      );
      const score = objectiveQuestions.filter(
        (question) =>
          savedAnswers.find((answer) => answer.question_id === question.id)
            ?.answer === question.correct_answer,
      ).length;
      expect(score).toBe(8);
      submitted = true;
      submitCalls += 1;
      await fulfill(objectiveAssignment({ started: true, submitted, score }));
      return;
    }
    if (functionName === "get_practice_assignment_review") {
      expect(submitted).toBe(true);
      await fulfill(objectiveReviewRows(savedAnswers));
      return;
    }

    unexpectedRpcNames.push(functionName ?? "unknown");
    await route.fulfill({
      status: 400,
      headers,
      body: JSON.stringify({ code: "fixture_unexpected_request" }),
    });
  });

  return {
    saveCallCount: () => saveCalls,
    submitCallCount: () => submitCalls,
    assertSafeRun: () => {
      expect(unexpectedRpcNames, unexpectedRpcNames.join(",")).toEqual([]);
      expect(unsafeRequests, unsafeRequests.join(",")).toEqual([]);
      expect(browserFailures, browserFailures.join(",")).toEqual([]);
    },
  };
}

test("keeps a nine-question all-MCQ worksheet on the local objective path", async ({
  page,
}) => {
  const fixture = await installObjectiveWorksheetFixture(page);
  await page.goto(OBJECTIVE_FIXTURE_PATH);

  await expect(
    page.getByRole("heading", {
      name: "Akkusativ Practice Worksheet",
      level: 1,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("radiogroup")).toHaveCount(9);
  await expect(page.getByRole("radio")).toHaveCount(27);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  for (const question of objectiveQuestions) {
    const selectedOption =
      question.question_number === 9
        ? question.options[1]
        : question.correct_answer;
    await page
      .getByTestId(`worksheet-answer-${question.question_number}`)
      .getByRole("radio", { name: selectedOption, exact: true })
      .click();
  }

  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved",
    { timeout: 15_000 },
  );
  const savedRevision = fixture.saveCallCount();
  expect(savedRevision).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    `Revision ${savedRevision}`,
  );

  await page.reload();
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved answers restored.",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    `Revision ${savedRevision}`,
  );
  for (const question of objectiveQuestions) {
    const selectedOption =
      question.question_number === 9
        ? question.options[1]
        : question.correct_answer;
    await expect(
      page
        .getByTestId(`worksheet-answer-${question.question_number}`)
        .getByRole("radio", { name: selectedOption, exact: true }),
    ).toBeChecked();
  }
  await page.waitForTimeout(900);
  expect(fixture.saveCallCount()).toBe(savedRevision);

  await page.getByRole("button", { name: "Submit worksheet" }).click();
  await expect(page.getByTestId("practice-score")).toContainText("8/9 (89%)", {
    timeout: 15_000,
  });
  await expect(page.getByText("Passed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Preparing detailed feedback...")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh feedback status" }),
  ).toHaveCount(0);
  await expect(page.getByTestId(/worksheet-review-status-/)).toHaveCount(9);
  await expect(page.getByTestId("worksheet-review-status-9")).toHaveText(
    "Incorrect",
  );
  expect(fixture.submitCallCount()).toBe(1);
  fixture.assertSafeRun();
});
