import { describe, expect, it } from "vitest";
import { PublicAppError } from "@/lib/appError";
import { formatErrorMessage } from "@/lib/workspaceData";

describe("formatErrorMessage", () => {
  const fallback = "Please try again.";

  it("uses the stable public message from a PublicAppError", () => {
    expect(
      formatErrorMessage(
        new PublicAppError("auth_session_expired", "This link has expired."),
        fallback,
      ),
    ).toBe("This link has expired.");
  });

  it("supports a short, nontechnical thrown string", () => {
    expect(formatErrorMessage("Check the code and try again.", fallback)).toBe(
      "Check the code and try again.",
    );
  });

  it.each([
    "DeepSeek provider returned HTTP 500",
    "violates row-level security policy",
    "duplicate key violates constraint submissions_pkey",
    "https://project.supabase.co/rest/v1/submissions failed",
  ])("replaces technical details with the caller fallback: %s", (message) => {
    expect(formatErrorMessage(message, fallback)).toBe(fallback);
  });

  it("reads a safe message from an error-shaped object", () => {
    expect(formatErrorMessage({ message: "That batch is inactive." }, fallback)).toBe(
      "That batch is inactive.",
    );
  });

  it.each([null, undefined, 42, {}, { message: 7 }])(
    "uses the fallback for unknown input: %j",
    (error) => {
      expect(formatErrorMessage(error, fallback)).toBe(fallback);
    },
  );
});
