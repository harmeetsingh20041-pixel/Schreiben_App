import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseArtifactManifest } from "./create-release-artifact-manifest.js";
import {
  APPROVED_PRODUCTION_EDGE_DIRECTORIES,
  APPROVED_PRODUCTION_EDGE_FUNCTIONS,
} from "./production-edge-functions.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "schreiben-artifact-"));
  const frontend = join(root, "frontend");
  const edge = join(root, "edge");
  const migrations = join(root, "migrations");
  await Promise.all([mkdir(frontend), mkdir(edge), mkdir(migrations)]);
  await writeFile(
    join(frontend, "launch-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      app_release: "release-2026-07-10",
      supabase_project_ref: "abcde1ghijklmnopqrst",
      demo_mode_enabled: false,
      public_teacher_signup_enabled: false,
      public_student_signup_enabled: true,
      sentry_source_maps_configured: true,
    }),
  );
  await writeFile(join(frontend, "index.html"), "<main>Schreiben</main>");
  for (const directory of APPROVED_PRODUCTION_EDGE_DIRECTORIES) {
    await mkdir(join(edge, directory));
  }
  await writeFile(join(edge, "_shared", "runtime.ts"), "export default {};");
  for (const slug of APPROVED_PRODUCTION_EDGE_FUNCTIONS) {
    await writeFile(join(edge, slug, "index.ts"), "export default {};");
  }
  await writeFile(join(migrations, "20260710000000_launch.sql"), "select 1;");
  return {
    root,
    frontend,
    edge,
    migrations,
    output: join(root, "manifest.json"),
  };
}

test("creates an immutable content-free manifest for all rollback roots", async () => {
  const value = await fixture();
  const manifest = await createReleaseArtifactManifest({
    release: "release-2026-07-10",
    frontendRoot: value.frontend,
    roots: [
      { label: "frontend", path: value.frontend },
      { label: "edge-functions", path: value.edge },
      { label: "database-migrations", path: value.migrations },
    ],
    outputPath: value.output,
    createdAt: "2026-07-10T12:00:00.000Z",
  });
  assert.equal(manifest.roots.length, 3);
  assert.match(manifest.aggregate_sha256, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(manifest).includes("<main>"));
  const edgeRoot = manifest.roots.find(
    (root) => root.label === "edge-functions",
  )!;
  assert.deepEqual(
    edgeRoot.files
      .filter((file) => file.path.endsWith("/index.ts"))
      .map((file) => file.path.slice(0, -"/index.ts".length))
      .sort(),
    [...APPROVED_PRODUCTION_EDGE_FUNCTIONS].sort(),
  );
  assert.equal(
    JSON.parse(await readFile(value.output, "utf8")).release,
    manifest.release,
  );
  await assert.rejects(
    () =>
      createReleaseArtifactManifest({
        release: "release-2026-07-10",
        frontendRoot: value.frontend,
        roots: [
          { label: "frontend", path: value.frontend },
          { label: "edge-functions", path: value.edge },
          { label: "database-migrations", path: value.migrations },
        ],
        outputPath: value.output,
      }),
    /EEXIST/,
  );
});

test("rejects public source maps and a build without verified Sentry upload", async () => {
  const value = await fixture();
  await writeFile(join(value.frontend, "app.js.map"), "{}");
  await assert.rejects(
    () =>
      createReleaseArtifactManifest({
        release: "release-2026-07-10",
        frontendRoot: value.frontend,
        roots: [
          { label: "frontend", path: value.frontend },
          { label: "edge-functions", path: value.edge },
          { label: "database-migrations", path: value.migrations },
        ],
        outputPath: value.output,
      }),
    /source maps/,
  );

  await unlink(join(value.frontend, "app.js.map"));

  const launchPath = join(value.frontend, "launch-manifest.json");
  const launch = JSON.parse(await readFile(launchPath, "utf8"));
  launch.sentry_source_maps_configured = false;
  await writeFile(launchPath, JSON.stringify(launch));
  await assert.rejects(
    () =>
      createReleaseArtifactManifest({
        release: "release-2026-07-10",
        frontendRoot: value.frontend,
        roots: [
          { label: "frontend", path: value.frontend },
          { label: "edge-functions", path: value.edge },
          { label: "database-migrations", path: value.migrations },
        ],
        outputPath: value.output,
      }),
    /production artifact invariants/,
  );
});

test("rejects an Edge rollback root containing an unapproved function", async () => {
  const value = await fixture();
  const diagnostic = join(value.edge, "provider-transport-diagnostic");
  await mkdir(diagnostic);
  await writeFile(join(diagnostic, "index.ts"), "export default {};");

  await assert.rejects(
    () =>
      createReleaseArtifactManifest({
        release: "release-2026-07-10",
        frontendRoot: value.frontend,
        roots: [
          { label: "frontend", path: value.frontend },
          { label: "edge-functions", path: value.edge },
          { label: "database-migrations", path: value.migrations },
        ],
        outputPath: value.output,
      }),
    /approved production Edge Function inventory/,
  );
});

test("rejects an Edge rollback root missing an approved function", async () => {
  const value = await fixture();
  await unlink(
    join(value.edge, APPROVED_PRODUCTION_EDGE_FUNCTIONS[0], "index.ts"),
  );

  await assert.rejects(
    () =>
      createReleaseArtifactManifest({
        release: "release-2026-07-10",
        frontendRoot: value.frontend,
        roots: [
          { label: "frontend", path: value.frontend },
          { label: "edge-functions", path: value.edge },
          { label: "database-migrations", path: value.migrations },
        ],
        outputPath: value.output,
      }),
    /missing a regular entrypoint/,
  );
});
