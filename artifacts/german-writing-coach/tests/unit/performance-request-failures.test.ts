import { describe, expect, it } from "vitest";
import {
  isSupersededNavigationAuthAbort,
  type PerformanceRequestFailureEvidence,
} from "../e2e/performance-request-failures";

function request(
  overrides: Partial<PerformanceRequestFailureEvidence> = {},
): PerformanceRequestFailureEvidence {
  return {
    endpoint: "rpc:get_auth_context",
    startedAtMs: 10,
    navigationSequence: 0,
    responseObserved: false,
    status: null,
    failed: true,
    failureText: "net::ERR_ABORTED",
    ...overrides,
  };
}

describe("performance request failure classification", () => {
  it("ignores only a response-free auth abort superseded after navigation", () => {
    const aborted = request();
    const successfulSuccessor = request({
      startedAtMs: 20,
      navigationSequence: 1,
      responseObserved: true,
      status: 200,
      failed: false,
      failureText: null,
    });

    expect(
      isSupersededNavigationAuthAbort(aborted, [aborted, successfulSuccessor]),
    ).toBe(true);
  });

  it.each([
    ["an HTTP failure", { responseObserved: true, status: 500 }],
    ["a different transport failure", { failureText: "net::ERR_FAILED" }],
    ["an abort without a successful successor", {}],
  ])("keeps %s fatal", (_label, overrides) => {
    const failed = request(overrides);
    expect(isSupersededNavigationAuthAbort(failed, [failed])).toBe(false);
  });

  it("keeps an aborted auth request fatal when the success was not from a newer navigation", () => {
    const aborted = request();
    const sameNavigationSuccess = request({
      startedAtMs: 20,
      responseObserved: true,
      status: 200,
      failed: false,
      failureText: null,
    });

    expect(
      isSupersededNavigationAuthAbort(aborted, [
        aborted,
        sameNavigationSuccess,
      ]),
    ).toBe(false);
  });
});
