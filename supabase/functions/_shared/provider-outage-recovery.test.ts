import {
  dualProviderOutageReason,
  isTransientProviderHttpStatus,
} from "./provider-outage-recovery.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("temporary provider HTTP classification is narrow", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assertEquals(isTransientProviderHttpStatus(status), true);
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assertEquals(isTransientProviderHttpStatus(status), false);
  }
});

Deno.test("only structured dual-provider failures enter outage recovery", () => {
  assertEquals(
    dualProviderOutageReason({
      safeCode: "provider_timeout",
      retryable: true,
      providerOutageRecoveryEligible: true,
    }),
    "dual_provider_outage_timeout",
  );
  assertEquals(
    dualProviderOutageReason({
      safeCode: "provider_http_429",
      retryable: true,
      providerOutageRecoveryEligible: true,
    }),
    "dual_provider_outage_rate_limited",
  );
  assertEquals(
    dualProviderOutageReason({
      safeCode: "worksheet_fallback_unavailable",
      retryable: true,
      providerOutageRecoveryEligible: true,
    }),
    "dual_provider_outage_unavailable",
  );

  for (
    const failure of [
      {
        safeCode: "provider_authentication_failed",
        retryable: false,
        providerOutageRecoveryEligible: false,
      },
      {
        safeCode: "worksheet_fallback_response_invalid",
        retryable: true,
        providerOutageRecoveryEligible: false,
      },
      {
        safeCode: "worksheet_fallback_timeout",
        retryable: true,
        providerOutageRecoveryEligible: false,
      },
    ]
  ) {
    assertEquals(dualProviderOutageReason(failure), null);
  }
});
