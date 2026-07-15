import { describe, expect, it } from "vitest";
import { hasScheduledAutomaticRetry } from "@/lib/automaticRetryState";

describe("automatic recovery state", () => {
  const now = Date.parse("2026-07-11T12:00:00.000Z");

  it("shows delayed state only for a valid future retry", () => {
    expect(
      hasScheduledAutomaticRetry("2026-07-11T12:01:00.000Z", now),
    ).toBe(true);
    expect(
      hasScheduledAutomaticRetry("2026-07-11T11:59:59.000Z", now),
    ).toBe(false);
    expect(hasScheduledAutomaticRetry("invalid", now)).toBe(false);
    expect(hasScheduledAutomaticRetry(null, now)).toBe(false);
  });
});
