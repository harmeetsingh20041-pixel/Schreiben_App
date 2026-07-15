import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function listTsxFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = path.resolve(process.cwd(), relativeDirectory);
  return readdirSync(absoluteDirectory).flatMap((entry) => {
    const absoluteEntry = path.join(absoluteDirectory, entry);
    const relativeEntry = path.relative(process.cwd(), absoluteEntry);
    return statSync(absoluteEntry).isDirectory()
      ? listTsxFiles(relativeEntry)
      : entry.endsWith(".tsx")
        ? [relativeEntry]
        : [];
  });
}

describe("Phase 5 responsive and state-copy contracts", () => {
  it("puts sign-in before the marketing panel on narrow screens", () => {
    const source = readSource("src/pages/login.tsx");
    expect(source).toContain("order-2 flex-1");
    expect(source).toContain("order-1 w-full");
    expect(source).toContain("lg:order-1");
    expect(source).toContain("lg:order-2");
  });

  it("keeps writing controls inside 360px and short mobile viewports", () => {
    const source = readSource("src/pages/student/write.tsx");
    expect(source).toContain("min-h-[calc(100dvh-4rem)]");
    expect(source).toContain('id="student-writing-text"');
    expect(source).toContain('htmlFor="student-writing-text"');
    expect(source).toContain("min-h-[260px]");
    expect(source).toContain("sm:min-h-[340px]");
    expect(source).not.toContain("AiLearningNotice");
    expect(source).toContain(
      "flex w-full flex-col gap-2 sm:w-auto sm:flex-row",
    );
    expect(source).toContain('role="progressbar"');
  });

  it("keeps the student worksheet free of the removed AI-learning notice", () => {
    const source = readSource("src/pages/student/worksheet.tsx");
    expect(source).not.toContain("AiLearningNotice");
    expect(source).not.toContain("AI-assisted learning");
  });

  it("keeps teacher overview cards out of the tablet overflow gutter", () => {
    const source = readSource("src/pages/teacher/dashboard.tsx");
    expect(source).toContain("sm:grid-cols-2 xl:grid-cols-4");
    expect(source).not.toContain("md:grid-cols-4");
  });

  it("allows long feedback and task-bank tabs to scroll instead of clipping", () => {
    for (const relativePath of [
      "src/components/real-feedback-review.tsx",
      "src/pages/teacher/questions.tsx",
    ]) {
      const source = readSource(relativePath);
      expect(source).toContain("overflow-x-auto");
      expect(source).toContain("shrink-0");
    }
  });

  it("respects reduced-motion preferences globally", () => {
    const source = readSource("src/index.css");
    const login = readSource("src/pages/login.tsx");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toContain("animation-duration: 0.01ms !important");
    expect(source).toContain("transition-duration: 0.01ms !important");
    expect(login).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
  });

  it("keeps browser zoom available and pins the real-screen contrast palette", () => {
    const html = readSource("index.html");
    const styles = readSource("src/index.css");
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    );
    expect(html).not.toMatch(/maximum-scale|user-scalable/i);
    expect(html).not.toContain("built on Replit");
    expect(styles).toContain("--muted-foreground: 60 5% 38%");
    expect(styles).toContain("--destructive: 0 70% 44%");
  });

  it("uses the compact student wordmark when the class switcher shares the desktop header", () => {
    const source = readSource("src/components/layout.tsx");
    expect(source).toMatch(
      /isStudent\s*\?\s*"Schreiben"\s*:\s*"German Writing Coach"/,
    );
    expect(source).toMatch(/isAdminView\s*\?\s*"Schreiben Admin"/);
  });

  it("keeps archived classes out of every student class/task selector", () => {
    const migration = readSource(
      "../../supabase/migrations/20260710032000_phase_11c_browser_api_cutover.sql",
    );
    const activeBatchGuards = migration.match(/and batch\.is_active/g) ?? [];
    expect(activeBatchGuards.length).toBeGreaterThanOrEqual(2);

    const studentTasks = readSource("src/pages/student/questions.tsx");
    expect(studentTasks).toContain("Join another class");
  });

  it("does not promise a future worksheet or shared task bank", () => {
    const practice = readSource("src/pages/student/practice.tsx");
    const tasks = readSource("src/pages/teacher/questions.tsx");
    expect(practice).not.toMatch(/worksheets? will be added|coming soon/i);
    expect(tasks).not.toContain(
      "will appear here after the real bank is imported",
    );
    expect(tasks).toContain("No shared writing tasks are available");
  });

  it("defensively renders student feedback only after release", () => {
    const source = readSource("src/pages/student/submission.tsx");
    expect(source).toContain(
      'realSubmission?.release_status === "released" ? feedback : null',
    );
    expect(source).toMatch(
      /<RealFeedbackReview\s+submission=\{realSubmission\}\s+feedback=\{releasedFeedback\}\s*\/>/,
    );
  });

  it("turns an unknown route into an actionable recovery state", () => {
    const source = readSource("src/pages/not-found.tsx");
    expect(source).not.toContain(
      "Did you forget to add the page to the router?",
    );
    expect(source).toContain("Return to your home page");
  });

  it("uses one interactive element for every linked button", () => {
    const offenders = [
      ...listTsxFiles("src/pages"),
      ...listTsxFiles("src/components"),
    ].filter((relativePath) =>
      /<Link\b[^>]*>\s*<Button\b/s.test(readSource(relativePath)),
    );

    expect(offenders).toEqual([]);
  });
});
