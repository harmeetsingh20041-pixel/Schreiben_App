import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260710084111_phase_11j_practice_answer_contract_gate.sql",
  ),
  "utf8",
);

describe("practice answer contract gate", () => {
  it("removes the raw-answer API overload from the browser execution surface", () => {
    expect(migration).toMatch(
      /revoke all on function api\.submit_practice_attempt\(uuid, jsonb\)\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function api\.submit_practice_attempt\(uuid, jsonb\)/i,
    );
  });

  it("keeps the legacy body behind one validated non-exposed wrapper", () => {
    expect(migration).toContain(
      "rename to submit_practice_attempt_phase_11j_unchecked",
    );
    expect(migration).toContain(
      "app_private.assert_practice_assignment_answer_contract",
    );
    expect(migration).toMatch(
      /revoke all on function public\.submit_practice_attempt_phase_11j_unchecked\(uuid, jsonb\)[\s\S]*?from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.submit_practice_attempt\(uuid, jsonb\)\s+to authenticated/i,
    );
  });

  it("repairs safe unused legacy questions without changing used history", () => {
    expect(migration).toContain("evaluation_mode = 'open_evaluation'");
    expect(migration).toContain("answer_contract_version = 1");
    expect(
      migration.match(
        /not exists \(\s*select 1\s*from public\.practice_test_attempts/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain("practice_worksheet_requires_review");
  });
});
