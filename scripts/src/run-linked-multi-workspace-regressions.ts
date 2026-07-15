import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const stagingProjectRef = "vzcgalzspdehmnvqczfw";

const pgTapAssertionFunctionNames = [
  "has_function",
  "has_schema",
  "has_table",
  "has_view",
  "hasnt_column",
  "is",
  "is_empty",
  "lives_ok",
  "ok",
  "results_eq",
  "throws_ok",
] as const;
const pgTapAssertionFunctionPattern = pgTapAssertionFunctionNames.join("|");

export const multiWorkspaceLinkedTests = [
  {
    path: "supabase/tests/database/phase_8a_security_test.sql",
    assertions: 60,
  },
  {
    path: "supabase/tests/database/phase_11e_resumable_drafts_test.sql",
    assertions: 32,
  },
  {
    path: "supabase/tests/database/phase_12y_multi_workspace_mutation_matrix_test.sql",
    assertions: 36,
  },
  {
    path: "supabase/tests/database/phase_11d_teacher_feedback_controls_test.sql",
    assertions: 37,
  },
  {
    path: "supabase/tests/database/phase_11l_atomic_class_transfer_test.sql",
    assertions: 20,
  },
] as const;

const fixtureUserIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "e1111111-1111-4111-8111-111111111111",
  "e1222222-2222-4222-8222-222222222222",
  "d0111111-1111-4111-8111-111111111111",
  "d0222222-2222-4222-8222-222222222222",
  "d0333333-3333-4333-8333-333333333333",
  "d0444444-4444-4444-8444-444444444444",
  "fc111111-1111-4111-8111-111111111111",
  "fc222222-2222-4222-8222-222222222222",
  "fc333333-3333-4333-8333-333333333333",
  "b7010001-0001-4001-8001-000000000001",
  "b7010002-0002-4002-8002-000000000002",
  "b7010003-0003-4003-8003-000000000003",
  "b7010004-0004-4004-8004-000000000004",
  "b7010005-0005-4005-8005-000000000005",
  "b7010006-0006-4006-8006-000000000006",
] as const;

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function fixtureUserArray() {
  return `array[${fixtureUserIds
    .map((id) => `${sqlLiteral(id)}::uuid`)
    .join(", ")}]::uuid[]`;
}

function exactResidueGuardSql(marker: string) {
  // pgTAP may already be installed in staging; only deterministic fixture rows
  // are residue owned by this harness.
  return `do $multi_workspace_residue_guard$
begin
  if exists (
    select 1
    from auth.users
    where id = any(${fixtureUserArray()})
  ) then
    raise exception using
      errcode = '55000',
      message = 'multi_workspace_linked_test_residue_detected';
  end if;
end;
$multi_workspace_residue_guard$;

select ${sqlLiteral(marker)} as multi_workspace_fixture_state;`;
}

export function buildFailClosedLinkedSql(args: {
  source: string;
  fileName: string;
  assertions: number;
}) {
  const source = args.source.replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))*\s*/, "");
  const plan = source.match(/select plan\((\d+)\);/i)?.[1];
  if (Number(plan) !== args.assertions) {
    throw new Error(
      `${args.fileName} declares ${plan ?? "no"} assertions; expected ${args.assertions}.`,
    );
  }
  if (!/^begin;\s*/i.test(source)) {
    throw new Error(`${args.fileName} is not outer-transactional.`);
  }
  if (/^\s*commit\s*;/im.test(source)) {
    throw new Error(`${args.fileName} contains a commit statement.`);
  }

  const marker = args.fileName
    .replace(/\.sql$/i, "")
    .replace(/[^a-z0-9_]+/gi, "_")
    .toLowerCase();
  const finishPattern = /select \* from finish\((?:true)?\);\s*rollback;\s*$/i;
  if (!finishPattern.test(source)) {
    throw new Error(
      `${args.fileName} has no reviewed finish-and-rollback tail.`,
    );
  }

  const withPgTap = source.replace(
    /^begin;\s*/i,
    `begin;\n\ncreate extension if not exists pgtap with schema extensions;\n\ncreate temporary table linked_pgtap_results (\n  line text not null\n) on commit drop;\n\ngrant select, insert on linked_pgtap_results to authenticated, anon, service_role;\n\n`,
  );
  const withCapturedWrappedAssertions = withPgTap.replace(
    new RegExp(
      `^select (pg_temp\\.[a-z0-9_]+_require_passing_tap)\\((${pgTapAssertionFunctionPattern})\\(`,
      "gim",
    ),
    "insert into linked_pgtap_results (line)\nselect $1($2(",
  );
  const withCapturedAssertions = withCapturedWrappedAssertions.replace(
    new RegExp(`^select (${pgTapAssertionFunctionPattern})\\(`, "gim"),
    "insert into linked_pgtap_results (line)\nselect $1(",
  );
  return withCapturedAssertions.replace(
    finishPattern,
    `create temporary table linked_pgtap_finish_output (\n  line text not null\n) on commit drop;\n\ninsert into linked_pgtap_finish_output (line)\nselect * from finish();\n\ndo $linked_pgtap_finish_guard$\ndeclare\n  assertion_count integer;\n  failure_summary text;\nbegin\n  select count(*)::integer\n  into assertion_count\n  from linked_pgtap_results;\n\n  select nullif(concat_ws(\n    E'\\n',\n    (\n      select string_agg(line, E'\\n' order by line)\n      from linked_pgtap_results\n      where line like 'not ok%'\n    ),\n    (\n      select string_agg(line, E'\\n' order by line)\n      from linked_pgtap_finish_output\n    )\n  ), '')\n  into failure_summary;\n\n  if assertion_count <> ${args.assertions} or failure_summary is not null then\n    raise exception using\n      errcode = 'P0001',\n      message = 'linked_pgtap_assertion_failure:${marker}:count=' || assertion_count::text || ':details=' || left(coalesce(failure_summary, 'none'), 1500);\n  end if;\nend;\n$linked_pgtap_finish_guard$;\n\nrollback;\n\nselect ${sqlLiteral(`LINKED_PGTAP_PASS:${marker}`)} as linked_test_state;\n`,
  );
}

function parseArgs(argv: string[]) {
  const normalizedArgs = argv[0] === "--" ? argv.slice(1) : argv;
  if (
    normalizedArgs.length !== 2 ||
    normalizedArgs[0] !== "--expected-project-ref" ||
    !normalizedArgs[1]
  ) {
    throw new Error(
      "Usage: linked multi-workspace regressions --expected-project-ref <staging-project-ref>",
    );
  }
  if (normalizedArgs[1] !== stagingProjectRef) {
    throw new Error("This regression harness is restricted to staging.");
  }
  return normalizedArgs[1];
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
      `Refusing linked matrix: expected ${expectedProjectRef}, found ${linkedProjectRef || "no linked project"}.`,
    );
  }

  runSupabase([
    "db",
    "query",
    "--linked",
    exactResidueGuardSql("MULTI_WORKSPACE_FIXTURE_NAMESPACE_CLEAN"),
  ]);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-multi-workspace-"),
  );
  try {
    for (const test of multiWorkspaceLinkedTests) {
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

  runSupabase([
    "db",
    "query",
    "--linked",
    exactResidueGuardSql("MULTI_WORKSPACE_OUTER_ROLLBACK_CONFIRMED"),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        project_ref: expectedProjectRef,
        files: multiWorkspaceLinkedTests.length,
        assertions: multiWorkspaceLinkedTests.reduce(
          (sum, test) => sum + test.assertions,
          0,
        ),
        transaction: "outer rollback per file",
        residue: 0,
      },
      null,
      2,
    ),
  );
}

const isMainModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Linked multi-workspace regressions failed.",
    );
    process.exitCode = 1;
  });
}
