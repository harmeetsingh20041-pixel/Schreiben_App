import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");

async function applicationSources(directory = sourceRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (path.includes(`${resolve(sourceRoot, "components/ui")}`)) return [];
        return applicationSources(path);
      }
      return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    }),
  );
  return paths.flat();
}

const expectedInventory = {
  "components/admin-mfa-reauth-dialog.tsx": ["DialogContent"],
  "components/layout.tsx": ["SheetContent"],
  "components/onboarding-checklist.tsx": ["DialogContent"],
  "components/student-join-class-dialog.tsx": ["DialogContent"],
  "pages/admin/teacher-access.tsx": [
    "AlertDialogContent",
    "AlertDialogContent",
  ],
  "pages/teacher/batches.tsx": ["DialogContent", "DialogContent"],
  "pages/teacher/practice-quality.tsx": ["AlertDialogContent"],
  "pages/teacher/questions.tsx": ["DialogContent"],
  "pages/teacher/students.tsx": ["AlertDialogContent", "DialogContent"],
} as const;

describe("application dialog inventory", () => {
  it("keeps every application modal surface in the reviewed OPS-002 inventory", async () => {
    const actual: Record<string, string[]> = {};
    for (const path of await applicationSources()) {
      const source = await readFile(path, "utf8");
      const surfaces = [
        ...source.matchAll(
          /<(DialogContent|AlertDialogContent|SheetContent)\b/g,
        ),
      ].map((match) => match[1]);
      if (surfaces.length > 0) {
        actual[relative(sourceRoot, path)] = surfaces.sort();
      }
    }
    expect(actual).toEqual(expectedInventory);
  });

  it("binds each inventory entry to named content and reachable actions", async () => {
    const contracts = [
      [
        "components/admin-mfa-reauth-dialog.tsx",
        ["Confirm administrator action", "Cancel", "Confirm and retry"],
      ],
      [
        "components/layout.tsx",
        ["<SheetTitle>Navigation</SheetTitle>", "SheetClose"],
      ],
      [
        "components/onboarding-checklist.tsx",
        ["<DialogTitle>{step.title}</DialogTitle>", "Back", "Next", "Finish"],
      ],
      [
        "components/student-join-class-dialog.tsx",
        ["<DialogTitle>Join another class</DialogTitle>", "Request access"],
      ],
      [
        "pages/admin/teacher-access.tsx",
        ["Disable teacher access?", "Keep access", "Disable teacher"],
      ],
      [
        "pages/teacher/batches.tsx",
        [
          "Create a class",
          "Daily writing limit",
          "Requested writings per student per day",
          "Send request",
          "Cancel",
          "Back",
          "Continue",
          "Create class",
        ],
      ],
      [
        "pages/teacher/practice-quality.tsx",
        ["Approve this exact worksheet?", "Reject this worksheet?", "Cancel"],
      ],
      [
        "pages/teacher/questions.tsx",
        ["Create New Writing Task", "Cancel", "Save Writing Task"],
      ],
      [
        "pages/teacher/students.tsx",
        ["Keep student", "Remove student access", "Transfer student", "Cancel"],
      ],
    ] as const;
    for (const [path, requiredText] of contracts) {
      const source = await readFile(resolve(sourceRoot, path), "utf8");
      for (const text of requiredText) expect(source).toContain(text);
    }
  });

  it("keeps the shared dialog primitives viewport-bounded and scrollable", async () => {
    for (const component of ["dialog.tsx", "alert-dialog.tsx"] as const) {
      const source = await readFile(
        resolve(sourceRoot, "components/ui", component),
        "utf8",
      );
      expect(source).toContain("max-h-[calc(100dvh-2rem)]");
      expect(source).toContain("w-[calc(100%-2rem)]");
      expect(source).toContain("overflow-y-auto");
      expect(source).toContain("overscroll-contain");
    }
    const layout = await readFile(
      resolve(sourceRoot, "components/layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("w-[min(22rem,88vw)]");
    expect(layout).toContain("overflow-y-auto");
  });
});
