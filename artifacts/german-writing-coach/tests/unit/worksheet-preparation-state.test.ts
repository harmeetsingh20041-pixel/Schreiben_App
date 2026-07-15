import { describe, expect, it } from "vitest";

import { hasDurableWorksheetPreparationState } from "@/services/practiceWorksheetService";

describe("durable worksheet preparation state", () => {
  it.each(["queued", "generating", "needs_review"] as const)(
    "treats %s as a legitimate durable outcome after a concurrent request",
    (generationStatus) => {
      expect(
        hasDurableWorksheetPreparationState({
          practice_test_id: null,
          generation_status: generationStatus,
        }),
      ).toBe(true);
    },
  );

  it("does not suppress a request failure behind a failed assignment snapshot", () => {
    expect(
      hasDurableWorksheetPreparationState({
        practice_test_id: null,
        generation_status: "failed",
      }),
    ).toBe(false);
  });

  it("treats an attached worksheet as ready even if the response state was stale", () => {
    expect(
      hasDurableWorksheetPreparationState({
        practice_test_id: "11111111-1111-4111-8111-111111111111",
        generation_status: "idle",
      }),
    ).toBe(true);
  });

  it("shows a failure only when no durable or terminal outcome exists", () => {
    expect(
      hasDurableWorksheetPreparationState({
        practice_test_id: null,
        generation_status: "idle",
      }),
    ).toBe(false);
  });
});
