import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS,
  AI_SPEND_POLICIES,
  type AiProviderCallIdentity,
  AiSpendAccountingError,
  AiSpendAccountingSession,
  maximumAiCallCostMicrousd,
} from "./ai-spend-accounting.ts";
import type {
  WorkerApiClient,
  WorkerRpcRequest,
  WorkerRpcResult,
} from "./worker-api.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const identity: AiProviderCallIdentity = {
  provider: "gemini",
  requested_model: "gemini-3.1-flash-lite",
  call_purpose: "worksheet_answer_evaluation",
  call_key: "attempt:v1:gemini:evaluation",
};

function abortableRequest(
  promise: Promise<WorkerRpcResult>,
  onSignal?: (signal: AbortSignal) => void,
): WorkerRpcRequest {
  return Object.assign(promise, {
    abortSignal(signal: AbortSignal) {
      onSignal?.(signal);
      return promise;
    },
  });
}

function rawClient(
  handler: (name: string, args: Record<string, unknown>) => WorkerRpcRequest,
) {
  return {
    schema(name: "api") {
      assertEquals(name, "api");
      return { rpc: handler };
    },
  } satisfies WorkerApiClient;
}

function client(
  handler: (
    name: string,
    args: Record<string, unknown>,
  ) => { data: unknown; error: { code?: string; message?: string } | null },
) {
  return rawClient((rpcName, args) =>
    abortableRequest(Promise.resolve().then(() => handler(rpcName, args))),
  );
}

function reservation(replayed = false) {
  return [
    {
      reservation_id: reservationId,
      state: "reserved",
      reserved_microusd: 50_000,
      workspace_remaining_microusd: 99_950_000,
      global_remaining_microusd: 499_950_000,
      expires_at: "2026-07-11T12:15:00.000Z",
      replayed,
    },
  ];
}

async function expectAccountingError(
  promise: Promise<unknown>,
  safeCode: string,
  retryable: boolean,
) {
  const error = (await assertRejects(
    () => promise,
    AiSpendAccountingError,
  )) as AiSpendAccountingError;
  assertEquals(error.safeCode, safeCode);
  assertEquals(error.retryable, retryable);
}

Deno.test("spend policy is an exact provider/model/purpose allowlist", () => {
  assertEquals(AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS, 5_000);
  assertEquals(AI_SPEND_POLICIES.length, 13);
  assertEquals(maximumAiCallCostMicrousd(identity), 50_000);
  assertEquals(
    maximumAiCallCostMicrousd({
      provider: "gemini",
      requested_model: "gemini-3.1-flash-lite",
      call_purpose: "writing_critique",
      call_key: "writing:v1:gemini:critique",
    }),
    150_000,
  );
  assertEquals(
    maximumAiCallCostMicrousd({
      provider: "gemini",
      requested_model: "gemini-3.1-flash-lite",
      call_purpose: "worksheet_critique",
      call_key: "worksheet:v1:gemini:critique",
    }),
    150_000,
  );
  assertRejects(
    async () =>
      maximumAiCallCostMicrousd({
        ...identity,
        requested_model: "gemini-flash-latest",
      }),
    AiSpendAccountingError,
  );
  assertRejects(
    async () =>
      maximumAiCallCostMicrousd({
        provider: "gemini",
        requested_model: "gemini-2.5-flash",
        call_purpose: "writing_critique",
        call_key: "writing:v1:retired-critic",
      }),
    AiSpendAccountingError,
  );
  assertRejects(
    async () =>
      maximumAiCallCostMicrousd({
        provider: "gemini",
        requested_model: "gemini-3.5-flash",
        call_purpose: "writing_critique",
        call_key: "writing:v1:retired-critic-3.5",
      }),
    AiSpendAccountingError,
  );
});

Deno.test(
  "a never-resolving reservation aborts and a replay remains dispatch-uncertain",
  async () => {
    let reserveCalls = 0;
    let aborted = false;
    const never = new Promise<WorkerRpcResult>(() => undefined);
    const session = new AiSpendAccountingSession({
      client: rawClient((name) => {
        assertEquals(name, "reserve_ai_spend");
        reserveCalls += 1;
        if (reserveCalls === 1) {
          return abortableRequest(never, (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
          });
        }
        return abortableRequest(
          Promise.resolve({ data: reservation(true), error: null }),
        );
      }),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
      rpcTimeoutMs: 10,
    });

    const startedAt = performance.now();
    await expectAccountingError(
      session.beforeProviderCall(identity),
      "ai_spend_accounting_timeout",
      true,
    );
    if (performance.now() - startedAt > 500) {
      throw new Error("Reservation timeout exceeded its bounded test window.");
    }
    assertEquals(aborted, true);

    await expectAccountingError(
      session.beforeProviderCall(identity),
      "ai_spend_dispatch_uncertain",
      true,
    );
    assertEquals(reserveCalls, 2);
  },
);

Deno.test(
  "never-resolving finalize and release RPCs abort without discarding reconciliation state",
  async () => {
    for (const operation of ["finalize", "release"] as const) {
      let operationCalls = 0;
      let aborted = false;
      const never = new Promise<WorkerRpcResult>(() => undefined);
      const session = new AiSpendAccountingSession({
        client: rawClient((name) => {
          if (name === "reserve_ai_spend") {
            return abortableRequest(
              Promise.resolve({ data: reservation(), error: null }),
            );
          }
          operationCalls += 1;
          if (operationCalls === 1) {
            return abortableRequest(never, (signal) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
            });
          }
          if (operation === "finalize") {
            assertEquals(name, "finalize_ai_spend_reservation");
            return abortableRequest(
              Promise.resolve({
                data: [
                  {
                    reservation_id: reservationId,
                    state: "finalized",
                    reserved_microusd: 50_000,
                    actual_microusd: 650,
                    billed_input_tokens: 800,
                    billed_output_tokens: 300,
                    finalized_at: "2026-07-11T12:01:00.000Z",
                    replayed: true,
                  },
                ],
                error: null,
              }),
            );
          }
          assertEquals(name, "release_ai_spend_reservation");
          return abortableRequest(
            Promise.resolve({
              data: [
                {
                  reservation_id: reservationId,
                  state: "released",
                  released_at: "2026-07-11T12:01:00.000Z",
                  replayed: true,
                },
              ],
              error: null,
            }),
          );
        }),
        jobId,
        entityVersion: 1,
        attemptNumber: 1,
        rpcTimeoutMs: 10,
      });
      await session.beforeProviderCall(identity);

      const settle = () =>
        operation === "finalize"
          ? session.recordProviderUsage({
              ...identity,
              provider_model_version: identity.requested_model,
              input_tokens: 800,
              output_tokens: 300,
            })
          : session.releaseProviderCall(identity, "provider_not_called");

      await expectAccountingError(
        settle(),
        "ai_spend_accounting_timeout",
        true,
      );
      assertEquals(aborted, true);

      // A second idempotent settlement succeeds only because the timed-out
      // operation retained the in-process reservation for reconciliation.
      await settle();
      assertEquals(operationCalls, 2);
    }
  },
);

Deno.test(
  "session reserves before dispatch and finalizes exact billed usage",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const session = new AiSpendAccountingSession({
      client: client((name, args) => {
        calls.push({ name, args });
        if (name === "reserve_ai_spend") {
          return { data: reservation(), error: null };
        }
        return {
          data: [
            {
              reservation_id: reservationId,
              state: "finalized",
              reserved_microusd: 50_000,
              actual_microusd: 650,
              billed_input_tokens: 800,
              billed_output_tokens: 300,
              finalized_at: "2026-07-11T12:01:00.000Z",
              replayed: false,
            },
          ],
          error: null,
        };
      }),
      jobId,
      entityVersion: 1,
      attemptNumber: 2,
    });

    await session.beforeProviderCall(identity);
    await session.recordProviderUsage({
      ...identity,
      provider_model_version: identity.requested_model,
      input_tokens: 800,
      output_tokens: 300,
      cached_input_tokens: 200,
      uncached_input_tokens: 600,
    });

    assertEquals(
      calls.map((call) => call.name),
      ["reserve_ai_spend", "finalize_ai_spend_reservation"],
    );
    assertEquals(
      calls[0].args.call_key,
      "attempt_2:attempt:v1:gemini:evaluation",
    );
    assertEquals(calls[0].args.maximum_cost_microusd, 50_000);
    assertEquals(calls[1].args.target_billed_output_tokens, 300);
    assertEquals(calls[1].args.target_billed_cached_input_tokens, 200);
    assertEquals(calls[1].args.target_billed_uncached_input_tokens, 600);
  },
);

Deno.test(
  "missing provider cache metadata finalizes conservatively as null/null",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const session = new AiSpendAccountingSession({
      client: client((name, args) => {
        calls.push({ name, args });
        return name === "reserve_ai_spend"
          ? { data: reservation(), error: null }
          : {
              data: [
                {
                  reservation_id: reservationId,
                  state: "finalized",
                  reserved_microusd: 50_000,
                  actual_microusd: 650,
                  billed_input_tokens: 800,
                  billed_output_tokens: 300,
                  finalized_at: "2026-07-11T12:01:00.000Z",
                  replayed: false,
                },
              ],
              error: null,
            };
      }),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await session.beforeProviderCall(identity);
    await session.recordProviderUsage({
      ...identity,
      provider_model_version: identity.requested_model,
      input_tokens: 800,
      output_tokens: 300,
    });
    assertEquals(calls[1]?.args.target_billed_cached_input_tokens, null);
    assertEquals(calls[1]?.args.target_billed_uncached_input_tokens, null);
  },
);

Deno.test(
  "real worksheet fallback keys fit provider and attempt-scoped database contracts",
  async () => {
    const providerCallKey = `worksheet_generation:job_${jobId}:candidate_1:gemini:mcq_safe_generation`;
    const fallbackIdentity: AiProviderCallIdentity = {
      provider: "gemini",
      requested_model: "gemini-3.1-flash-lite",
      call_purpose: "worksheet_generation",
      call_key: providerCallKey,
    };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const session = new AiSpendAccountingSession({
      client: client((name, args) => {
        calls.push({ name, args });
        if (name === "reserve_ai_spend") {
          return {
            data: [
              {
                reservation_id: reservationId,
                state: "reserved",
                reserved_microusd: args.maximum_cost_microusd,
                workspace_remaining_microusd: 99_800_000,
                global_remaining_microusd: 499_800_000,
                expires_at: "2026-07-11T12:15:00.000Z",
                replayed: false,
              },
            ],
            error: null,
          };
        }
        return {
          data: [
            {
              reservation_id: reservationId,
              state: "finalized",
              reserved_microusd: 200_000,
              actual_microusd: 6_500,
              billed_input_tokens: 800,
              billed_output_tokens: 300,
              finalized_at: "2026-07-11T12:01:00.000Z",
              replayed: false,
            },
          ],
          error: null,
        };
      }),
      jobId,
      entityVersion: 1,
      attemptNumber: 2,
    });

    await session.beforeProviderCall(fallbackIdentity);
    await session.recordProviderUsage({
      ...fallbackIdentity,
      provider_model_version: fallbackIdentity.requested_model,
      input_tokens: 800,
      output_tokens: 300,
    });

    const databaseCallKey = calls[0]?.args.call_key;
    assertEquals(providerCallKey.length, 100);
    assertEquals(databaseCallKey, `attempt_2:${providerCallKey}`);
    assertEquals(String(databaseCallKey).length, 110);
    assertEquals(calls[0]?.args.maximum_cost_microusd, 200_000);
    assertEquals(
      calls.map((call) => call.name),
      ["reserve_ai_spend", "finalize_ai_spend_reservation"],
    );
  },
);

Deno.test(
  "targeted worksheet MCQ-safe regeneration has a distinct length-safe accounting lifecycle",
  async () => {
    const providerCallKey = `worksheet_generation:job_${jobId}:candidate_1:gemini:mcq_safe_regeneration`;
    const fallbackIdentity: AiProviderCallIdentity = {
      provider: "gemini",
      requested_model: "gemini-3.1-flash-lite",
      call_purpose: "worksheet_generation",
      call_key: providerCallKey,
    };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const session = new AiSpendAccountingSession({
      client: client((name, args) => {
        calls.push({ name, args });
        if (name === "reserve_ai_spend") {
          return {
            data: [
              {
                reservation_id: reservationId,
                state: "reserved",
                reserved_microusd: 200_000,
                workspace_remaining_microusd: 99_800_000,
                global_remaining_microusd: 499_800_000,
                expires_at: "2026-07-11T12:15:00.000Z",
                replayed: false,
              },
            ],
            error: null,
          };
        }
        return {
          data: [
            {
              reservation_id: reservationId,
              state: "finalized",
              reserved_microusd: 200_000,
              actual_microusd: 6_500,
              billed_input_tokens: 800,
              billed_output_tokens: 300,
              finalized_at: "2026-07-11T12:01:00.000Z",
              replayed: false,
            },
          ],
          error: null,
        };
      }),
      jobId,
      entityVersion: 1,
      attemptNumber: 2,
    });

    await session.beforeProviderCall(fallbackIdentity);
    await session.recordProviderUsage({
      ...fallbackIdentity,
      provider_model_version: fallbackIdentity.requested_model,
      input_tokens: 800,
      output_tokens: 300,
    });

    const databaseCallKey = calls[0]?.args.call_key;
    assertEquals(providerCallKey.length, 102);
    assertEquals(databaseCallKey, `attempt_2:${providerCallKey}`);
    assertEquals(String(databaseCallKey).length, 112);
    assertEquals(calls[0]?.args.maximum_cost_microusd, 200_000);
    assertEquals(
      calls.map((call) => call.name),
      ["reserve_ai_spend", "finalize_ai_spend_reservation"],
    );
  },
);

Deno.test(
  "all production-prefix MCQ-safe generation keys stay within the shared 105-character accounting contract",
  async () => {
    const providerCalls = [
      {
        provider: "deepseek" as const,
        model: "deepseek-v4-pro",
        key: `worksheet_generation:job_${jobId}:candidate_1:deepseek:mcq_safe_generation`,
      },
      {
        provider: "gemini" as const,
        model: "gemini-3.1-flash-lite",
        key: `worksheet_generation:job_${jobId}:candidate_1:gemini:outage_safe_generation`,
      },
      {
        provider: "gemini" as const,
        model: "gemini-3.1-flash-lite",
        key: `worksheet_generation:job_${jobId}:candidate_1:gemini:outage_safe_regen`,
      },
      {
        provider: "gemini" as const,
        model: "gemini-3.1-flash-lite",
        key: `worksheet_generation:job_${jobId}:candidate_2:gemini:mcq_safe_repair`,
      },
    ];
    assertEquals(
      providerCalls.map((call) => call.key.length),
      [102, 103, 98, 96],
    );

    for (const providerCall of providerCalls) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const session = new AiSpendAccountingSession({
        client: client((name, args) => {
          calls.push({ name, args });
          return {
            data: [
              {
                reservation_id: reservationId,
                state: "reserved",
                reserved_microusd: args.maximum_cost_microusd,
                workspace_remaining_microusd: 99_800_000,
                global_remaining_microusd: 499_800_000,
                expires_at: "2026-07-11T12:15:00.000Z",
                replayed: false,
              },
            ],
            error: null,
          };
        }),
        jobId,
        entityVersion: 1,
        attemptNumber: 2,
      });
      await session.beforeProviderCall({
        provider: providerCall.provider,
        requested_model: providerCall.model,
        call_purpose: "worksheet_generation",
        call_key: providerCall.key,
      });
      assertEquals(calls[0]?.name, "reserve_ai_spend");
      assertEquals(calls[0]?.args.call_key, `attempt_2:${providerCall.key}`);
      assertEquals(
        calls[0]?.args.maximum_cost_microusd,
        providerCall.provider === "deepseek" ? 100_000 : 200_000,
      );
    }
  },
);

Deno.test(
  "budget rejection fails before a provider can be called",
  async () => {
    const session = new AiSpendAccountingSession({
      client: client(() => ({
        data: null,
        error: { code: "53000", message: "ai_spend_workspace_budget_exceeded" },
      })),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await assertRejects(
      () => session.beforeProviderCall(identity),
      AiSpendAccountingError,
      "AI spend accounting failed safely.",
    );
  },
);

Deno.test(
  "replayed reserved call never risks a duplicate provider dispatch",
  async () => {
    const session = new AiSpendAccountingSession({
      client: client(() => ({ data: reservation(true), error: null })),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await assertRejects(
      () => session.beforeProviderCall(identity),
      AiSpendAccountingError,
    );
  },
);

Deno.test(
  "usage cannot be finalized without its in-process reservation",
  async () => {
    const session = new AiSpendAccountingSession({
      client: client(() => ({ data: null, error: null })),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await assertRejects(
      () =>
        session.recordProviderUsage({
          ...identity,
          provider_model_version: identity.requested_model,
          input_tokens: 1,
          output_tokens: 1,
        }),
      AiSpendAccountingError,
    );
  },
);

Deno.test("definitely unbilled calls can be released explicitly", async () => {
  const calls: string[] = [];
  const session = new AiSpendAccountingSession({
    client: client((name) => {
      calls.push(name);
      return name === "reserve_ai_spend"
        ? { data: reservation(), error: null }
        : {
            data: [
              {
                reservation_id: reservationId,
                state: "released",
                released_at: "2026-07-11T12:01:00.000Z",
                replayed: false,
              },
            ],
            error: null,
          };
    }),
    jobId,
    entityVersion: 1,
    attemptNumber: 1,
  });
  await session.beforeProviderCall(identity);
  await session.releaseProviderCall(identity, "provider_not_called");
  assertEquals(calls, ["reserve_ai_spend", "release_ai_spend_reservation"]);
});

Deno.test(
  "malformed database rows and changed model versions fail closed",
  async () => {
    const malformed = new AiSpendAccountingSession({
      client: client(() => ({ data: [{ state: "reserved" }], error: null })),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await assertRejects(
      () => malformed.beforeProviderCall(identity),
      AiSpendAccountingError,
    );

    const session = new AiSpendAccountingSession({
      client: client(() => ({ data: reservation(), error: null })),
      jobId,
      entityVersion: 1,
      attemptNumber: 1,
    });
    await session.beforeProviderCall(identity);
    await assertRejects(
      () =>
        session.recordProviderUsage({
          ...identity,
          provider_model_version: "gemini-flash-latest",
          input_tokens: 1,
          output_tokens: 1,
        }),
      AiSpendAccountingError,
    );
    await assertRejects(
      () =>
        session.recordProviderUsage({
          ...identity,
          provider_model_version: identity.requested_model,
          input_tokens: 0,
          output_tokens: 1,
        }),
      AiSpendAccountingError,
    );
  },
);
