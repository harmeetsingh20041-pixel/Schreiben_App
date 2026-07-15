// @vitest-environment node

import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFeedbackModesRecoveryManifest,
  readFeedbackModesRecoveryManifest,
  removeFeedbackModesRecoveryManifest,
  type FeedbackModesRecoveryManifest,
} from "../e2e/fixtures/feedback-modes-recovery-manifest";

const PROJECT_REF = "vzcgalzspdehmnvqczfw";
const roots: string[] = [];

function manifest(): FeedbackModesRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PROJECT_REF,
    workspace_id: "11111111-1111-4111-8111-111111111111",
    teacher_membership_id: "22222222-2222-4222-8222-222222222222",
    teacher_profile_id: "33333333-3333-4333-8333-333333333333",
    student_profile_id: "44444444-4444-4444-8444-444444444444",
    teacher_membership_count: 2,
    teacher_membership_fingerprint: "a".repeat(32),
    student_membership_count: 3,
    student_membership_fingerprint: "b".repeat(32),
  };
}

async function fixturePath() {
  const root = await mkdtemp(join(tmpdir(), "feedback-modes-manifest-"));
  roots.push(root);
  return join(root, ".e2e-private", "feedback-modes-fixture.json");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("feedback-mode recovery manifest", () => {
  it("stores only fixture identity and membership fingerprints with owner-only permissions", async () => {
    const path = await fixturePath();
    const initial = manifest();
    await createFeedbackModesRecoveryManifest(path, initial, PROJECT_REF);

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await readFeedbackModesRecoveryManifest(path, PROJECT_REF)).toEqual(
      initial,
    );
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("@");
    expect(raw).not.toMatch(/password|writing|content/i);

    await removeFeedbackModesRecoveryManifest(path, PROJECT_REF);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses overwrite, permissive files, scope drift, unknown fields, and symlink files", async () => {
    const path = await fixturePath();
    await createFeedbackModesRecoveryManifest(path, manifest(), PROJECT_REF);
    await expect(
      createFeedbackModesRecoveryManifest(path, manifest(), PROJECT_REF),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await chmod(path, 0o644);
    await expect(
      readFeedbackModesRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("not owner-only");
    await chmod(path, 0o600);
    await expect(
      readFeedbackModesRecoveryManifest(path, "another-project-ref"),
    ).rejects.toThrow("another scope");

    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.unexpected = true;
    await rm(path);
    await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
    await expect(
      readFeedbackModesRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unknown fields");

    const target = join(path, "..");
    await rm(path);
    await symlink(target, path);
    await expect(
      readFeedbackModesRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");
  });

  it("never follows a symlinked private parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-modes-root-"));
    const outside = await mkdtemp(join(tmpdir(), "feedback-modes-outside-"));
    roots.push(root, outside);
    const privateDirectory = join(root, ".e2e-private");
    const path = join(privateDirectory, "feedback-modes-fixture.json");
    const outsideManifest = join(outside, "feedback-modes-fixture.json");
    const sentinel = join(outside, "sentinel.txt");
    await chmod(outside, 0o755);
    await writeFile(outsideManifest, JSON.stringify(manifest()), {
      mode: 0o600,
    });
    await writeFile(sentinel, "unchanged\n", { mode: 0o600 });
    await symlink(outside, privateDirectory);

    await expect(
      createFeedbackModesRecoveryManifest(path, manifest(), PROJECT_REF),
    ).rejects.toThrow("unsafe");
    await expect(
      readFeedbackModesRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");
    await expect(
      removeFeedbackModesRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  });
});
