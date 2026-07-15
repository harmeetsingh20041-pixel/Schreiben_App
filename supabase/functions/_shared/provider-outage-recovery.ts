export type ProviderOutageReason =
  | "dual_provider_outage_unavailable"
  | "dual_provider_outage_rate_limited"
  | "dual_provider_outage_timeout";

type ClassifiedProviderFailure = Readonly<{
  safeCode: string;
  retryable: boolean;
  providerOutageRecoveryEligible: boolean;
}>;

/**
 * Provider HTTP statuses that represent temporary availability, not a content
 * or credential problem. 409 is deliberately excluded: a conflict can signal
 * a request/idempotency defect and must not be hidden behind a 24-hour loop.
 */
export function isTransientProviderHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Convert a structured, dual-provider failure into the only three reasons the
 * database accepts. Safe-code text alone is never enough: auth failover and
 * response validation can produce similar secondary-provider codes.
 */
export function dualProviderOutageReason(
  failure: ClassifiedProviderFailure,
): ProviderOutageReason | null {
  if (
    failure.retryable !== true ||
    failure.providerOutageRecoveryEligible !== true
  ) {
    return null;
  }

  const code = failure.safeCode.toLowerCase();
  if (code.includes("timeout") || code.includes("deadline")) {
    return "dual_provider_outage_timeout";
  }
  if (code.includes("429") || code.includes("rate_limit")) {
    return "dual_provider_outage_rate_limited";
  }
  return "dual_provider_outage_unavailable";
}
