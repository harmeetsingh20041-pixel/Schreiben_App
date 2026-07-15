import { expect, test, type Page } from "@playwright/test";

type Credentials = { email: string; password: string };
type PracticeSmokeMode = "autosave" | "generation" | "submission";

const WORKSHEET_GENERATION_GATE_MS = 90_000;

interface PracticeSmokeAnswer {
  question_number: number;
  answer: string;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live practice E2E.`);
  return value;
}

function requiredAssignmentId() {
  const value = requiredEnvironment("E2E_PRACTICE_ASSIGNMENT_ID");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("E2E_PRACTICE_ASSIGNMENT_ID must be a UUID.");
  }
  return value;
}

function requiredPracticeMode(): PracticeSmokeMode {
  const value = requiredEnvironment("E2E_PRACTICE_MODE");
  if (
    value !== "autosave" &&
    value !== "generation" &&
    value !== "submission"
  ) {
    throw new Error(
      "E2E_PRACTICE_MODE must equal autosave, generation, or submission.",
    );
  }
  return value;
}

function requiredSubmissionAnswers(): PracticeSmokeAnswer[] {
  let value: unknown;
  try {
    value = JSON.parse(requiredEnvironment("E2E_PRACTICE_ANSWERS_JSON"));
  } catch {
    throw new Error("E2E_PRACTICE_ANSWERS_JSON must be valid JSON.");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("E2E_PRACTICE_ANSWERS_JSON must contain 1 to 50 answers.");
  }
  const answers = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Number.isSafeInteger(
        (entry as Record<string, unknown>).question_number,
      ) ||
      Number((entry as Record<string, unknown>).question_number) < 1 ||
      Number((entry as Record<string, unknown>).question_number) > 50 ||
      typeof (entry as Record<string, unknown>).answer !== "string" ||
      !(entry as Record<string, unknown>).answer?.toString().trim() ||
      (entry as Record<string, unknown>).answer!.toString().length > 800
    ) {
      throw new Error(
        "E2E_PRACTICE_ANSWERS_JSON contains an invalid answer contract.",
      );
    }
    return {
      question_number: Number(
        (entry as Record<string, unknown>).question_number,
      ),
      answer: String((entry as Record<string, unknown>).answer),
    };
  });
  if (
    new Set(answers.map((answer) => answer.question_number)).size !==
    answers.length
  ) {
    throw new Error(
      "E2E_PRACTICE_ANSWERS_JSON contains duplicate question numbers.",
    );
  }
  return answers.sort(
    (left, right) => left.question_number - right.question_number,
  );
}

function requiredQuestionNumber() {
  const value = Number(requiredEnvironment("E2E_PRACTICE_QUESTION_NUMBER"));
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error(
      "E2E_PRACTICE_QUESTION_NUMBER must be an integer from 1 to 50.",
    );
  }
  return value;
}

function studentCredentials(): Credentials {
  return {
    email: requiredEnvironment("E2E_STUDENT_EMAIL"),
    password: requiredEnvironment("E2E_STUDENT_PASSWORD"),
  };
}

async function signInStudent(page: Page) {
  const account = studentCredentials();
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
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

async function openTargetAssignment(page: Page, assignmentId: string) {
  await page.goto(`/student/practice/${assignmentId}`);
  await expect
    .poll(
      () =>
        new URL(page.url()).pathname === `/student/practice/${assignmentId}`,
    )
    .toBe(true);
  await expect(
    page.getByText("Loading worksheet...", { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
}

async function runTargetedGeneration(page: Page, assignmentId: string) {
  await openTargetAssignment(page, assignmentId);
  const generationStatus = page.getByTestId("worksheet-generation-status");
  await expect(generationStatus).toBeVisible();

  const prepareOrRefresh = page.getByRole("button", {
    name: /^(?:Prepare worksheet|Prepare next worksheet|Refresh status)$/,
  });
  await expect(prepareOrRefresh).toHaveCount(1);
  await prepareOrRefresh.click();
  await expect(
    page.getByRole("progressbar", { name: "Worksheet answer progress" }),
  ).toBeVisible({ timeout: WORKSHEET_GENERATION_GATE_MS });
}

async function waitForReadyWorksheet(
  page: Page,
  assignmentId: string,
  timeout = 15_000,
) {
  await openTargetAssignment(page, assignmentId);
  await expect(page.getByTestId("worksheet-generation-status")).toHaveCount(0, {
    timeout,
  });
  await expect(
    page.getByRole("progressbar", { name: "Worksheet answer progress" }),
  ).toBeVisible({ timeout });
}

async function waitUntilSaved(page: Page) {
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved",
    { timeout: 20_000 },
  );
}

async function restoreAnswer(
  page: Page,
  assignmentId: string,
  questionNumber: number,
  originalAnswer: string,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cleanupPage = attempt === 0 ? page : await page.context().newPage();
    try {
      await waitForReadyWorksheet(cleanupPage, assignmentId);
      const answerField = cleanupPage.getByTestId(
        `worksheet-answer-${questionNumber}`,
      );
      await expect(answerField).toHaveCount(1, { timeout: 15_000 });
      await expect(answerField).toBeVisible({ timeout: 15_000 });
      if ((await answerField.inputValue()) !== originalAnswer) {
        await answerField.fill(originalAnswer);
        await answerField.press("Tab");
        await waitUntilSaved(cleanupPage);
      }
      await cleanupPage.reload();
      await waitForReadyWorksheet(cleanupPage, assignmentId);
      const restoredField = cleanupPage.getByTestId(
        `worksheet-answer-${questionNumber}`,
      );
      await expect
        .poll(
          async () => (await restoredField.inputValue()) === originalAnswer,
          { timeout: 15_000 },
        )
        .toBe(true);
      return;
    } catch (cleanupError) {
      if (attempt === 1) throw cleanupError;
    } finally {
      if (cleanupPage !== page) await cleanupPage.close();
    }
  }
}

async function runReversibleAutosave(
  page: Page,
  assignmentId: string,
  questionNumber: number,
  privateSample: string,
) {
  await waitForReadyWorksheet(page, assignmentId);

  const answerField = page.getByTestId(`worksheet-answer-${questionNumber}`);
  await expect(answerField).toHaveCount(1);
  await expect(answerField).toBeVisible();

  const originalAnswer = await answerField.inputValue();
  const probeAnswer =
    `${privateSample.slice(0, 120)} ${Date.now().toString(36)}`.slice(0, 140);
  let restorationRequired = false;
  try {
    restorationRequired = true;
    await answerField.fill(probeAnswer);
    await answerField.press("Tab");
    await waitUntilSaved(page);

    await page.reload();
    await expect
      .poll(async () => (await answerField.inputValue()) === probeAnswer, {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Submit worksheet" }),
    ).toBeVisible();
  } finally {
    if (restorationRequired) {
      await restoreAnswer(page, assignmentId, questionNumber, originalAnswer);
    }
  }
}

async function answerTargetedQuestion(page: Page, entry: PracticeSmokeAnswer) {
  const control = page.getByTestId(`worksheet-answer-${entry.question_number}`);
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  if ((await control.getAttribute("role")) === "radiogroup") {
    const radios = control.getByRole("radio");
    const labels = await radios.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
    const optionIndex = labels.findIndex(
      (label) => label.trim() === entry.answer,
    );
    if (optionIndex < 0) {
      throw new Error(
        "A submitted practice answer did not match its targeted choice contract.",
      );
    }
    await radios.nth(optionIndex).click();
    return;
  }
  await control.fill(entry.answer);
}

async function runTerminalSubmission(
  page: Page,
  assignmentId: string,
  answers: PracticeSmokeAnswer[],
) {
  await waitForReadyWorksheet(page, assignmentId);

  for (const answer of answers) await answerTargetedQuestion(page, answer);
  await page.keyboard.press("Tab");
  await waitUntilSaved(page);

  const submit = page.getByRole("button", { name: "Submit worksheet" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect
    .poll(
      async () => {
        const failureMessage = page.getByText(
          "Feedback could not be prepared after safe retries",
          { exact: false },
        );
        if (
          (await failureMessage.count()) > 0 &&
          (await failureMessage.nth(0).isVisible())
        ) {
          return "failed";
        }
        const visibleAlert = page.getByRole("alert").last();
        if (
          (await visibleAlert.count()) > 0 &&
          (await visibleAlert.isVisible())
        ) {
          return "failed";
        }
        const pending = await page
          .getByText("Preparing detailed feedback...", { exact: true })
          .count();
        const reviewCount = await page
          .locator('[data-testid^="worksheet-review-status-"]')
          .count();
        return pending === 0 && reviewCount === answers.length
          ? "terminal"
          : "pending";
      },
      { timeout: 5 * 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("terminal");

  await expect(page.getByTestId("practice-score")).toBeVisible();
  await expect(submit).toHaveCount(0);
  for (const answer of answers) {
    await expect(
      page.getByTestId(`worksheet-review-status-${answer.question_number}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`worksheet-review-points-${answer.question_number}`),
    ).toBeVisible();
  }
}

test.skip(
  process.env.E2E_LIVE_PRACTICE !== "true",
  "Set E2E_LIVE_PRACTICE=true only for an approved staging worksheet run.",
);

test.describe.serial("preconditioned targeted real-app practice smoke", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    const mode = requiredPracticeMode();
    requiredAssignmentId();
    if (mode === "autosave") {
      requiredEnvironment("E2E_PRACTICE_SAMPLE");
      requiredQuestionNumber();
    } else if (mode === "submission") {
      requiredSubmissionAnswers();
    }
  });

  test("student generates the explicitly targeted worksheet within the V1 gate", async ({
    page,
  }) => {
    test.skip(requiredPracticeMode() !== "generation", "Generation mode only.");
    test.setTimeout(2 * 60_000);
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    const assignmentId = requiredAssignmentId();

    await signInStudent(page);
    await runTargetedGeneration(page, assignmentId);

    assertNoFatalFailures();
  });

  test("student autosaves, reloads, and restores the explicitly targeted answer", async ({
    page,
  }) => {
    test.skip(requiredPracticeMode() !== "autosave", "Autosave mode only.");
    test.setTimeout(2 * 60_000);
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    const assignmentId = requiredAssignmentId();

    await signInStudent(page);
    await runReversibleAutosave(
      page,
      assignmentId,
      requiredQuestionNumber(),
      requiredEnvironment("E2E_PRACTICE_SAMPLE"),
    );

    assertNoFatalFailures();
  });

  test("student submits and receives terminal scoring for the explicitly targeted worksheet", async ({
    page,
  }) => {
    test.skip(requiredPracticeMode() !== "submission", "Submission mode only.");
    test.setTimeout(6 * 60_000);
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    const assignmentId = requiredAssignmentId();

    await signInStudent(page);
    await runTerminalSubmission(
      page,
      assignmentId,
      requiredSubmissionAnswers(),
    );

    assertNoFatalFailures();
  });
});
