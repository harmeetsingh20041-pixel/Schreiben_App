export type PerformanceRequestFailureEvidence = {
  endpoint: string;
  startedAtMs: number;
  navigationSequence: number;
  responseObserved: boolean;
  status: number | null;
  failed: boolean;
  failureText: string | null;
};

export function isSupersededNavigationAuthAbort(
  request: PerformanceRequestFailureEvidence,
  requests: readonly PerformanceRequestFailureEvidence[],
) {
  if (
    request.endpoint !== "rpc:get_auth_context" ||
    !request.failed ||
    request.responseObserved ||
    request.status !== null ||
    request.failureText !== "net::ERR_ABORTED"
  ) {
    return false;
  }

  return requests.some(
    (candidate) =>
      candidate !== request &&
      candidate.endpoint === "rpc:get_auth_context" &&
      candidate.navigationSequence > request.navigationSequence &&
      candidate.startedAtMs >= request.startedAtMs &&
      candidate.responseObserved &&
      candidate.status !== null &&
      candidate.status >= 200 &&
      candidate.status < 300 &&
      !candidate.failed,
  );
}
