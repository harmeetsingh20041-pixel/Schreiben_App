import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

type Policy = {
  provider: string;
  model: string;
  purpose: string;
  cached_input_rate_microusd_per_million: number;
  input_rate_microusd_per_million: number;
  output_rate_microusd_per_million: number;
};

type Fixture = {
  name: string;
  provider: string;
  model: string;
  purpose: string;
  input_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  cache_metadata_present: boolean;
  expected_actual_microusd: number;
};

function lineItem(tokens: number, rate: number) {
  return Math.ceil((tokens * rate) / 1_000_000);
}

test("invoice fixtures price cache hits, misses, and fallback separately", async () => {
  const [contractSource, fixtureSource, migration] = await Promise.all([
    readFile(resolve(ROOT, "config/ai-provider-costs.json"), "utf8"),
    readFile(resolve(ROOT, "config/ai-provider-invoice-fixtures.json"), "utf8"),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713084132_cohort_ai_spend_fair_share.sql",
      ),
      "utf8",
    ),
  ]);
  const contract = JSON.parse(contractSource) as { policies: Policy[] };
  const invoice = JSON.parse(fixtureSource) as {
    schema_version: number;
    fixtures: Fixture[];
  };
  assert.equal(invoice.schema_version, 1);
  assert.equal(invoice.fixtures.length, 4);
  assert.equal(new Set(invoice.fixtures.map((row) => row.name)).size, 4);

  for (const fixture of invoice.fixtures) {
    const policy = contract.policies.find(
      (row) =>
        row.provider === fixture.provider &&
        row.model === fixture.model &&
        row.purpose === fixture.purpose,
    );
    assert(policy, fixture.name);
    assert.equal(
      fixture.cached_input_tokens + fixture.uncached_input_tokens,
      fixture.input_tokens,
      fixture.name,
    );
    if (!fixture.cache_metadata_present) {
      assert.equal(fixture.cached_input_tokens, 0, fixture.name);
      assert.equal(
        fixture.uncached_input_tokens,
        fixture.input_tokens,
        fixture.name,
      );
    }
    const actual =
      lineItem(
        fixture.cached_input_tokens,
        policy.cached_input_rate_microusd_per_million,
      ) +
      lineItem(
        fixture.uncached_input_tokens,
        policy.input_rate_microusd_per_million,
      ) +
      lineItem(fixture.output_tokens, policy.output_rate_microusd_per_million);
    assert.equal(actual, fixture.expected_actual_microusd, fixture.name);
  }

  assert.match(
    migration,
    /cached_input_tokens::numeric[\s\S]*uncached_input_tokens::numeric[\s\S]*output_tokens::numeric/,
  );
  assert.match(
    migration,
    /target_billed_cached_input_tokens is null[\s\S]*target_billed_uncached_input_tokens is null/,
  );
  assert.match(
    migration,
    /normalized_cached_input_tokens := coalesce\([\s\S]*0[\s\S]*normalized_uncached_input_tokens := coalesce\([\s\S]*target_billed_input_tokens/,
  );
});
