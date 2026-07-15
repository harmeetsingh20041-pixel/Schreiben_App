import { beforeEach, describe, expect, it, vi } from "vitest";

const signUp = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: () => ({ auth: { signUp } }),
  isSupabaseConfigured: true,
}));

import { signUpWithEmailPassword } from "@/services/authService";

async function attemptStudentSignup() {
  return signUpWithEmailPassword({
    email: "student@example.invalid",
    password: "StrongPassword123!",
    fullName: "Test Student",
    accountType: "student",
  });
}

describe("public signup rate-limit messages", () => {
  beforeEach(() => {
    signUp.mockReset();
  });

  it("explains a project email-capacity limit without blaming the student", async () => {
    signUp.mockResolvedValue({
      data: { session: null },
      error: {
        code: "over_email_send_rate_limit",
        message: "email rate limit exceeded",
      },
    });

    await expect(attemptStudentSignup()).rejects.toMatchObject({
      code: "auth_rate_limited",
      message:
        "Confirmation email capacity is temporarily busy. Please try again shortly.",
    });
  });

  it("keeps a client request-rate limit generic", async () => {
    signUp.mockResolvedValue({
      data: { session: null },
      error: {
        code: "over_request_rate_limit",
        message: "request rate limit exceeded",
      },
    });

    await expect(attemptStudentSignup()).rejects.toMatchObject({
      code: "auth_rate_limited",
      message: "Too many attempts. Wait a few minutes before trying again.",
    });
  });
});
