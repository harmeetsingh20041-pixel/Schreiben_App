import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicAppError } from "@/lib/appError";
import {
  clearSupabaseBrowserSession,
  SUPABASE_AUTH_STORAGE_KEY,
} from "@/lib/supabaseClient";
import { parseApiPage, toPublicDataError } from "@/services/apiFacade";

function readSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("browser API-only cutover", () => {
  it("defaults every browser database request to the api schema", () => {
    const clientSource = readSource("src/lib/supabaseClient.ts");
    expect(clientSource).toContain('SupabaseClient<Database, "api">');
    expect(clientSource).toContain('createClient<Database, "api">');
    expect(clientSource).toContain('db: { schema: "api" }');
  });

  it("binds redirect-based Auth sessions to the initiating browser with PKCE", () => {
    const clientSource = readSource("src/lib/supabaseClient.ts");
    expect(clientSource).toContain('flowType: "pkce"');
    expect(clientSource).toContain("detectSessionInUrl: true");
    expect(clientSource).toContain("storageKey: SUPABASE_AUTH_STORAGE_KEY");
  });

  it("can purge local Supabase tokens when remote sign-out is unavailable", () => {
    for (const key of [
      SUPABASE_AUTH_STORAGE_KEY,
      `${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`,
      `${SUPABASE_AUTH_STORAGE_KEY}-user`,
    ]) {
      localStorage.setItem(key, "sensitive-session-material");
    }

    clearSupabaseBrowserSession();

    expect(localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY)).toBeNull();
    expect(
      localStorage.getItem(`${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`),
    ).toBeNull();
    expect(
      localStorage.getItem(`${SUPABASE_AUTH_STORAGE_KEY}-user`),
    ).toBeNull();
  });

  it("clears local auth and query state from the logout finally path", () => {
    const authSource = readSource("src/lib/auth.tsx");
    expect(authSource).toMatch(
      /const logout = async \(\) => \{[\s\S]*?finally \{[\s\S]*?clearAuthState\(\);[\s\S]*?setLocation\("\/"\);/,
    );
  });

  it("contains no direct browser table query or mutation", () => {
    const serviceFiles = [
      "src/services/authService.ts",
      "src/services/batchWritingLimitService.ts",
      "src/services/batchService.ts",
      "src/services/grammarStatsService.ts",
      "src/services/onboardingService.ts",
      "src/services/practiceReviewQueueService.ts",
      "src/services/practiceWorksheetService.ts",
      "src/services/questionService.ts",
      "src/services/studentService.ts",
      "src/services/submissionService.ts",
      "src/services/workspaceService.ts",
    ];

    for (const file of serviceFiles) {
      expect(readSource(file), file).not.toMatch(/\.from\s*\(/);
      expect(readSource(file), file).not.toContain('.schema("public")');
    }
  });

  it("maps internal database errors to stable, student-safe errors", () => {
    const error = toPublicDataError(
      { code: "42501", message: "sensitive internal RLS details" },
      "Request failed.",
    );
    expect(error).toBeInstanceOf(PublicAppError);
    expect(error.code).toBe("data_permission_denied");
    expect(error.message).not.toContain("RLS");
    expect(error.message).not.toContain("sensitive");
  });

  it("keeps administrator MFA setup and fresh step-up errors distinct", () => {
    expect(
      toPublicDataError(
        { code: "42501", message: "platform_admin_mfa_required" },
        "Request failed.",
      ).code,
    ).toBe("data_mfa_required");
    expect(
      toPublicDataError(
        {
          code: "42501",
          message: "platform_admin_fresh_authentication_required",
        },
        "Request failed.",
      ).code,
    ).toBe("data_fresh_reauthentication_required");
  });

  it("maps HTTP 412 draft conflicts to stable conflict guidance", () => {
    const error = toPublicDataError(
      { code: "PT412", message: "draft_revision_conflict" },
      "Request failed.",
    );

    expect(error).toBeInstanceOf(PublicAppError);
    expect(error.code).toBe("data_conflict");
    expect(error.message).toContain("changed while you were working");
    expect(error.message).not.toContain("draft_revision_conflict");
  });

  it("maps the database writing quota to actionable student-safe copy", () => {
    const error = toPublicDataError(
      { code: "PT429", message: "writing_daily_quota_exceeded" },
      "Request failed.",
    );
    expect(error).toBeInstanceOf(PublicAppError);
    expect(error.code).toBe("data_rate_limited");
    expect(error.message).toContain("today’s writing-feedback limit");
    expect(error.message).not.toContain("writing_daily_quota_exceeded");
  });

  it("maps batch writing-limit decisions to specific admin-safe guidance", () => {
    const cases = [
      ["batch_writing_limit_invalid", "data_invalid_request", /1 to 10/i],
      [
        "batch_writing_limit_unchanged",
        "data_invalid_request",
        /different from the class's current limit/i,
      ],
      [
        "batch_writing_limit_revision_conflict",
        "data_conflict",
        /changed while you were reviewing/i,
      ],
      [
        "batch_writing_limit_request_not_found",
        "data_not_found",
        /no longer available/i,
      ],
      [
        "batch_writing_limit_request_stale",
        "data_conflict",
        /current limit or active state/i,
      ],
    ] as const;

    for (const [databaseMessage, expectedCode, messagePattern] of cases) {
      const error = toPublicDataError(
        { code: "P0001", message: databaseMessage },
        "Request failed.",
      );
      expect(error.code).toBe(expectedCode);
      expect(error.message).toMatch(messagePattern);
      expect(error.message).not.toContain(databaseMessage);
    }
  });

  it("maps monthly writing and paid-work quotas to preserved-work guidance", () => {
    for (const databaseMessage of [
      "writing_monthly_quota_exceeded",
      "student_ai_monthly_budget_exceeded",
    ]) {
      const error = toPublicDataError(
        { code: "PT429", message: databaseMessage },
        "Request failed.",
      );
      expect(error).toBeInstanceOf(PublicAppError);
      expect(error.code).toBe("data_rate_limited");
      expect(error.message).toMatch(/month|saved|work remains/i);
      expect(error.message).not.toContain(databaseMessage);
    }
  });

  it("maps join-code throttling without showing the writing quota message", () => {
    const error = toPublicDataError(
      { code: "PT429", message: "batch_join_attempt_rate_limited" },
      "The class code could not be submitted.",
    );
    expect(error).toBeInstanceOf(PublicAppError);
    expect(error.code).toBe("data_rate_limited");
    expect(error.message).toContain("Wait one minute");
    expect(error.message).not.toContain("writing-feedback limit");
    expect(error.message).not.toContain("batch_join_attempt_rate_limited");
  });

  it("maps paid-work budgets and retry ceilings to preserved-work guidance", () => {
    for (const databaseMessage of [
      "student_ai_daily_budget_exceeded",
      "workspace_ai_daily_budget_exceeded",
      "writing_manual_retry_limit_exceeded",
      "worksheet_generation_retry_limit_exceeded",
      "practice_manual_retry_limit_exceeded",
    ]) {
      const error = toPublicDataError(
        { code: "PT429", message: databaseMessage },
        "Request failed.",
      );
      expect(error).toBeInstanceOf(PublicAppError);
      expect(error.code).toBe("data_rate_limited");
      expect(error.message).toMatch(/saved|preserved/i);
      expect(error.message).not.toContain(databaseMessage);
    }
  });

  it("retains safe mapping for historical internal 54000 responses", () => {
    const error = toPublicDataError(
      { code: "54000", message: "writing_daily_quota_exceeded" },
      "Request failed.",
    );

    expect(error.code).toBe("data_rate_limited");
    expect(error.message).toContain("today’s writing-feedback limit");
  });

  it("does not misclassify an unknown internal 54000 as a user rate limit", () => {
    const error = toPublicDataError(
      { code: "54000", message: "future_internal_resource_failure" },
      "Request failed safely.",
    );

    expect(error.code).toBe("data_request_failed");
    expect(error.message).toBe("Request failed safely.");
    expect(error.message).not.toContain("future_internal_resource_failure");
  });

  it("maps the V1 writing bounds to specific student-safe guidance", () => {
    const tooLong = toPublicDataError(
      { code: "22023", message: "writing_text_too_long" },
      "Request failed.",
    );
    const tooManyUnits = toPublicDataError(
      { code: "22023", message: "writing_too_many_units" },
      "Request failed.",
    );

    expect(tooLong.code).toBe("data_invalid_request");
    expect(tooLong.message).toContain("4,000 characters");
    expect(tooLong.message).not.toContain("writing_text_too_long");
    expect(tooManyUnits.code).toBe("data_invalid_request");
    expect(tooManyUnits.message).toContain("40 sentences or paragraphs");
    expect(tooManyUnits.message).not.toContain("writing_too_many_units");
  });

  it("maps an oversized teacher task to the public 4,000-character contract", () => {
    const error = toPublicDataError(
      { code: "22023", message: "teacher_task_prompt_too_long" },
      "Request failed.",
    );

    expect(error.code).toBe("data_invalid_request");
    expect(error.message).toContain("4,000 characters");
    expect(error.message).not.toContain("teacher_task_prompt_too_long");
  });

  it("keeps Edge acknowledgement reads behind a narrow authorized RPC", () => {
    const edgeSource = readSource(
      "../../supabase/functions/evaluate-practice-attempt/index.ts",
    );
    expect(edgeSource).toContain(
      'rpc(\n    "get_practice_evaluation_request_state"',
    );
    expect(edgeSource).not.toMatch(/\.from\s*\(/);
  });

  it("rejects malformed pagination responses before a UI can trust them", () => {
    expect(() =>
      parseApiPage({ schema_version: 1, items: [] }, "Roster"),
    ).toThrowError(PublicAppError);
    expect(() =>
      parseApiPage(
        {
          schema_version: 1,
          items: [],
          total_count: 2,
          returned_count: 0,
          page_size: 50,
          has_more: true,
          next_cursor: null,
        },
        "Roster",
      ),
    ).toThrowError(PublicAppError);
  });
});
