import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFailClosedLinkedSql } from "./run-linked-multi-workspace-regressions.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stagingProjectRef = "vzcgalzspdehmnvqczfw";

export const worksheetCacheLinkedTests = [
  {
    path: "supabase/tests/database/phase_14c_explicit_worksheet_content_check_evidence_test.sql",
    assertions: 35,
  },
  {
    path: "supabase/tests/database/phase_14b_model_validated_worksheet_cache_test.sql",
    assertions: 59,
  },
] as const;

const zeroWorkSql = `do $worksheet_cache_zero_work$
begin
  if exists (
    select 1
    from app_private.async_jobs
    where job_kind = 'worksheet_generation'
      and status in ('queued', 'processing', 'retry')
  ) or exists (
    select 1 from pgmq.q_worksheet_generation
  ) or exists (
    select 1 from app_private.worksheet_generation_checkpoints
  ) or exists (
    select 1
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    where reservation.state = 'reserved'
      and job.job_kind = 'worksheet_generation'
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_cache_linked_test_requires_zero_active_work';
  end if;
end;
$worksheet_cache_zero_work$;

select jsonb_build_object(
  'active_generation_jobs', (
    select count(*)
    from app_private.async_jobs
    where job_kind = 'worksheet_generation'
      and status in ('queued', 'processing', 'retry')
  ),
  'generation_queue_messages', (
    select count(*) from pgmq.q_worksheet_generation
  ),
  'generation_checkpoints', (
    select count(*) from app_private.worksheet_generation_checkpoints
  ),
  'reserved_generation_spend', (
    select count(*)
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    where reservation.state = 'reserved'
      and job.job_kind = 'worksheet_generation'
  )
) as worksheet_cache_linked_preflight;`;

function parseArgs(argv: string[]) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (
    normalized.length !== 2 ||
    normalized[0] !== "--expected-project-ref" ||
    normalized[1] !== stagingProjectRef
  ) {
    throw new Error(
      `Usage: linked worksheet-cache regressions --expected-project-ref ${stagingProjectRef}`,
    );
  }
  return normalized[1];
}

function runSupabase(args: string[]) {
  const executable = process.env.SUPABASE_BIN?.trim() || "supabase";
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Supabase command failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const expectedProjectRef = parseArgs(argv);
  const linkedProjectRef = (
    await readFile(
      resolve(repositoryRoot, "supabase/.temp/project-ref"),
      "utf8",
    )
  ).trim();
  if (linkedProjectRef !== expectedProjectRef) {
    throw new Error(
      `Refusing linked cache tests: expected ${expectedProjectRef}, found ${linkedProjectRef || "no linked project"}.`,
    );
  }

  runSupabase(["db", "query", "--linked", zeroWorkSql]);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-worksheet-cache-"),
  );
  try {
    for (const test of worksheetCacheLinkedTests) {
      const source = await readFile(resolve(repositoryRoot, test.path), "utf8");
      const linkedSql = buildFailClosedLinkedSql({
        source,
        fileName: basename(test.path),
        assertions: test.assertions,
      });
      const temporaryPath = join(temporaryDirectory, basename(test.path));
      await writeFile(temporaryPath, linkedSql, {
        encoding: "utf8",
        mode: 0o600,
      });
      runSupabase(["db", "query", "--linked", "--file", temporaryPath]);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  runSupabase(["db", "query", "--linked", zeroWorkSql]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        project_ref: expectedProjectRef,
        files: worksheetCacheLinkedTests.length,
        assertions: worksheetCacheLinkedTests.reduce(
          (total, test) => total + test.assertions,
          0,
        ),
        transaction: "outer rollback per file",
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
