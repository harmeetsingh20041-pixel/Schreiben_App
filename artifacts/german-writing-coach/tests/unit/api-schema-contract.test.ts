import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260710002000_phase_8b_api_schema_facade.sql",
  ),
  "utf8",
);
const localConfig = readFileSync(
  path.resolve(process.cwd(), "../../supabase/config.toml"),
  "utf8",
);
const writingKickRelay = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/functions/kick-writing-jobs/index.ts",
  ),
  "utf8",
);
const writingWorker = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/functions/process-writing-jobs/processor.ts",
  ),
  "utf8",
);
const viewSection =
  migration.split("-- Core V1 mutation aliases.")[0] ?? migration;

function functionConfig(slug: string) {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    localConfig.match(
      new RegExp(`\\[functions\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
    )?.[1] ?? ""
  );
}

describe("dedicated Data API contract", () => {
  it("exposes only the reviewed api schema after the browser and Edge cutover", () => {
    expect(localConfig).toContain('schemas = ["api"]');
    expect(localConfig).not.toMatch(/schemas\s*=\s*\[[^\]]*"public"/);
    expect(localConfig).toContain(
      'extra_search_path = ["public", "extensions"]',
    );
  });

  it("exposes only security-invoker, security-barrier read views", () => {
    expect(migration.match(/create or replace view api\./g)).toHaveLength(16);
    expect(
      migration.match(/security_invoker = true, security_barrier = true/g),
    ).toHaveLength(16);
    expect(viewSection).not.toMatch(/select \*/i);
    expect(migration).not.toContain("api.practice_test_questions");
    expect(migration).not.toContain("api.practice_attempt_question_reviews");
  });

  it("contains no exposed security-definer function and gives anon no grant", () => {
    expect(migration).not.toMatch(
      /create or replace function api\.[\s\S]*?security definer/i,
    );
    expect(migration).not.toMatch(/grant\s+.+\s+to\s+anon/i);
    expect(migration).toContain(
      "revoke all on schema api from public, anon, authenticated, service_role",
    );
  });

  it("publishes the Phase 1 stable mutation interfaces", () => {
    for (const signature of [
      "api.get_auth_context()",
      "api.create_teacher_workspace(",
      "api.request_batch_join(code text)",
      "api.decide_batch_join(",
      "api.offboard_student(",
      "api.submit_writing(",
    ]) {
      expect(migration).toContain(signature);
    }
    expect(migration).toContain('"text" text');
    expect(migration).toContain("evaluation_status text");
    expect(migration).toContain("release_status text");
    expect(migration).toContain("release_at timestamptz");
  });

  it("separates the application-verified writing kick relay from the internal worker", () => {
    expect(functionConfig("kick-writing-jobs")).toMatch(
      /verify_jwt\s*=\s*false/,
    );
    expect(functionConfig("process-writing-jobs")).toMatch(
      /verify_jwt\s*=\s*false/,
    );
    expect(writingKickRelay).toContain("authorize_writing_processor_kick");
    expect(writingKickRelay).toContain("createSupabaseUserJwtVerifier");
    expect(writingKickRelay).not.toContain("auth.getUser");
    expect(writingWorker).not.toContain("auth.getUser");
  });
});
