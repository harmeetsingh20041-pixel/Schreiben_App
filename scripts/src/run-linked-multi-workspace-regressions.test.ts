import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFailClosedLinkedSql,
  multiWorkspaceLinkedTests,
} from "./run-linked-multi-workspace-regressions.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("multi-workspace linked suite reuses reviewed tests and fails closed", async () => {
  assert.equal(multiWorkspaceLinkedTests.length, 5);
  assert.equal(
    multiWorkspaceLinkedTests.reduce(
      (sum, linkedTest) => sum + linkedTest.assertions,
      0,
    ),
    185,
  );

  for (const linkedTest of multiWorkspaceLinkedTests) {
    const source = await readFile(
      resolve(repositoryRoot, linkedTest.path),
      "utf8",
    );
    const linkedSql = buildFailClosedLinkedSql({
      source,
      fileName: basename(linkedTest.path),
      assertions: linkedTest.assertions,
    });
    assert.match(linkedSql, /^begin;/);
    assert.match(linkedSql, /create extension if not exists pgtap/);
    assert.match(linkedSql, /linked_pgtap_results/);
    assert.match(linkedSql, /linked_pgtap_finish_output/);
    assert.match(linkedSql, /linked_pgtap_assertion_failure:/);
    assert.match(linkedSql, /where line like 'not ok%'/);
    assert.match(linkedSql, /rollback;\n\nselect 'LINKED_PGTAP_PASS:/);
    assert.doesNotMatch(linkedSql, /^\s*commit\s*;/im);
  }
});

test("wrapped pgTAP assertions are captured without bypassing their guard", () => {
  const linkedSql = buildFailClosedLinkedSql({
    fileName: "wrapped_capture_probe.sql",
    assertions: 2,
    source: `begin;
select plan(2);
select pg_temp.capture_probe_require_passing_tap(ok(true, 'wrapped ok'));
select pg_temp.capture_probe_require_passing_tap(throws_ok('select 1', null, null, 'wrapped throws_ok'));
select * from finish(true);
rollback;`,
  });

  assert.equal(
    linkedSql.match(/insert into linked_pgtap_results \(line\)/g)?.length,
    2,
  );
  assert.match(
    linkedSql,
    /select pg_temp\.capture_probe_require_passing_tap\(ok\(/,
  );
  assert.match(
    linkedSql,
    /select pg_temp\.capture_probe_require_passing_tap\(throws_ok\(/,
  );
  assert.match(linkedSql, /where line like 'not ok%'/);
  assert.match(linkedSql, /assertion_count <> 2/);
});
