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
  createWritingLiveRecoveryManifest,
  readWritingLiveRecoveryManifest,
  removeWritingLiveRecoveryManifest,
  replaceWritingLiveRecoveryManifest,
  type WritingLiveRecoveryManifest,
} from "../e2e/fixtures/writing-live-recovery-manifest";

const PROJECT_REF = "vzcgalzspdehmnvqczfw";
const roots: string[] = [];

function manifest(): WritingLiveRecoveryManifest {
  return {
    schema_version: 1,
    project_ref: PROJECT_REF,
    workspace_id: "11111111-1111-4111-8111-111111111111",
    teacher_membership_id: "22222222-2222-4222-8222-222222222222",
    student_membership_id: "33333333-3333-4333-8333-333333333333",
    batch_id: "44444444-4444-4444-8444-444444444444",
    batch_student_id: "55555555-5555-4555-8555-555555555555",
    submission_id: null,
  };
}

async function fixturePath() {
  const root = await mkdtemp(join(tmpdir(), "writing-live-manifest-"));
  roots.push(root);
  return join(root, ".e2e-private", "writing-live-fixture.json");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("writing-live recovery manifest", () => {
  it("persists only fixture IDs with owner-only permissions and updates atomically", async () => {
    const path = await fixturePath();
    const initial = manifest();
    await createWritingLiveRecoveryManifest(path, initial, PROJECT_REF);

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await readWritingLiveRecoveryManifest(path, PROJECT_REF)).toEqual(
      initial,
    );
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("@");
    expect(raw).not.toContain("Testtext");
    expect(Object.keys(JSON.parse(raw))).toEqual([
      "schema_version",
      "project_ref",
      "workspace_id",
      "teacher_membership_id",
      "student_membership_id",
      "batch_id",
      "batch_student_id",
      "submission_id",
    ]);

    const completed = {
      ...initial,
      submission_id: "66666666-6666-4666-8666-666666666666",
    };
    await replaceWritingLiveRecoveryManifest(path, completed, PROJECT_REF);
    expect(await readWritingLiveRecoveryManifest(path, PROJECT_REF)).toEqual(
      completed,
    );

    await removeWritingLiveRecoveryManifest(path, PROJECT_REF);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses overwrite, permissive files, symlinks, scope drift, and unknown fields", async () => {
    const path = await fixturePath();
    await createWritingLiveRecoveryManifest(path, manifest(), PROJECT_REF);
    await expect(
      createWritingLiveRecoveryManifest(path, manifest(), PROJECT_REF),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await chmod(path, 0o644);
    await expect(
      readWritingLiveRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("not owner-only");
    await chmod(path, 0o600);
    await expect(
      readWritingLiveRecoveryManifest(path, "another-project-ref"),
    ).rejects.toThrow("another scope");

    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.unexpected = "field";
    await rm(path);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, JSON.stringify(raw), { mode: 0o600 }),
    );
    await expect(
      readWritingLiveRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unknown fields");

    const target = join(path, "..");
    await rm(path);
    await symlink(target, path);
    await expect(
      readWritingLiveRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");
  });

  it("never follows a symlinked private parent for create, read, replace, or remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "writing-live-parent-root-"));
    const outside = await mkdtemp(
      join(tmpdir(), "writing-live-parent-outside-"),
    );
    roots.push(root, outside);
    const privateDirectory = join(root, ".e2e-private");
    const path = join(privateDirectory, "writing-live-fixture.json");
    const outsideManifest = join(outside, "writing-live-fixture.json");
    const outsideSentinel = join(outside, "sentinel.txt");
    const serialized = `${JSON.stringify(manifest(), null, 2)}\n`;

    await chmod(outside, 0o755);
    await writeFile(outsideManifest, serialized, { mode: 0o600 });
    await writeFile(outsideSentinel, "outside-content\n", { mode: 0o600 });
    await symlink(outside, privateDirectory);

    const outsideMode = (await lstat(outside)).mode & 0o777;
    const outsideManifestBefore = await readFile(outsideManifest, "utf8");
    const outsideSentinelBefore = await readFile(outsideSentinel, "utf8");

    await expect(
      createWritingLiveRecoveryManifest(path, manifest(), PROJECT_REF),
    ).rejects.toThrow("unsafe");
    await expect(
      readWritingLiveRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");
    await expect(
      replaceWritingLiveRecoveryManifest(path, manifest(), PROJECT_REF),
    ).rejects.toThrow("unsafe");
    await expect(
      removeWritingLiveRecoveryManifest(path, PROJECT_REF),
    ).rejects.toThrow("unsafe");

    expect((await lstat(outside)).mode & 0o777).toBe(outsideMode);
    expect(await readFile(outsideManifest, "utf8")).toBe(outsideManifestBefore);
    expect(await readFile(outsideSentinel, "utf8")).toBe(outsideSentinelBefore);
  });
});
