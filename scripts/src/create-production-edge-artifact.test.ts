import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionEdgeArtifact } from "./create-production-edge-artifact.js";
import {
  APPROVED_PRODUCTION_EDGE_DIRECTORIES,
  APPROVED_PRODUCTION_EDGE_FUNCTIONS,
} from "./production-edge-functions.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "schreiben-production-edge-"));
  const source = join(root, "source");
  const output = join(root, "output");
  await mkdir(source);
  for (const directory of APPROVED_PRODUCTION_EDGE_DIRECTORIES) {
    await mkdir(join(source, directory));
  }
  await writeFile(
    join(source, "_shared", "runtime.ts"),
    "export const shared = true;",
  );
  for (const slug of APPROVED_PRODUCTION_EDGE_FUNCTIONS) {
    await writeFile(
      join(source, slug, "index.ts"),
      `export const slug = ${JSON.stringify(slug)};`,
    );
  }
  for (const unapproved of [
    "provider-transport-diagnostic",
    "future-function",
  ]) {
    await mkdir(join(source, unapproved));
    await writeFile(join(source, unapproved, "index.ts"), "export default {};");
  }
  return { root, source, output };
}

test("packages only the exact approved production functions and shared code", async () => {
  const value = await fixture();
  const result = await createProductionEdgeArtifact({
    sourceRoot: value.source,
    outputRoot: value.output,
  });

  assert.deepEqual(result.function_slugs, APPROVED_PRODUCTION_EDGE_FUNCTIONS);
  assert.deepEqual(
    (await readdir(value.output)).sort(),
    [...APPROVED_PRODUCTION_EDGE_DIRECTORIES].sort(),
  );
  assert.equal(
    await readFile(join(value.output, "_shared", "runtime.ts"), "utf8"),
    "export const shared = true;",
  );
  for (const slug of APPROVED_PRODUCTION_EDGE_FUNCTIONS) {
    assert.match(
      await readFile(join(value.output, slug, "index.ts"), "utf8"),
      new RegExp(slug),
    );
  }
  await assert.rejects(
    access(join(value.output, "provider-transport-diagnostic")),
    /ENOENT/,
  );
  await assert.rejects(access(join(value.output, "future-function")), /ENOENT/);
});

test("fails closed when an approved function is missing", async () => {
  const value = await fixture();
  const missing = APPROVED_PRODUCTION_EDGE_FUNCTIONS[0];
  await rm(join(value.source, missing), { recursive: true });

  await assert.rejects(
    () =>
      createProductionEdgeArtifact({
        sourceRoot: value.source,
        outputRoot: value.output,
      }),
    new RegExp(`Required production Edge source is missing: ${missing}`),
  );
  await assert.rejects(access(value.output), /ENOENT/);
});

test("rejects symlinks and removes only the new partial output", async () => {
  const value = await fixture();
  await symlink(
    join(value.source, "_shared", "runtime.ts"),
    join(value.source, APPROVED_PRODUCTION_EDGE_FUNCTIONS[0], "linked.ts"),
  );

  await assert.rejects(
    () =>
      createProductionEdgeArtifact({
        sourceRoot: value.source,
        outputRoot: value.output,
      }),
    /cannot contain symlinks/,
  );
  await assert.rejects(access(value.output), /ENOENT/);
});

test("never replaces or deletes a pre-existing output directory", async () => {
  const value = await fixture();
  await mkdir(value.output);
  const marker = join(value.output, "keep.txt");
  await writeFile(marker, "preserve");

  await assert.rejects(
    () =>
      createProductionEdgeArtifact({
        sourceRoot: value.source,
        outputRoot: value.output,
      }),
    /EEXIST/,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve");
});

test("rejects output paths inside the Edge source", async () => {
  const value = await fixture();
  await assert.rejects(
    () =>
      createProductionEdgeArtifact({
        sourceRoot: value.source,
        outputRoot: join(value.source, "artifact"),
      }),
    /must be outside its source root/,
  );
});
