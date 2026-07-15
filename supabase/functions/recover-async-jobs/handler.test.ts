import {
  createAsyncRecoveryHandler,
  RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE,
  RECOVERY_LEVEL_FIT_BATCH_SIZE,
  RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE,
  RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE,
  RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE,
  RECOVERY_SCHEDULED_RELEASE_BATCH_SIZE,
} from "./handler.ts";
import type { WorkerApiClient } from "../_shared/worker-api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function emptyLevelFitRecovery() {
  return {
    data: {
      schema_version: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      exhausted: 0,
    },
    error: null,
  };
}

function emptyPracticeCycleTransitionRecovery() {
  return {
    data: {
      schema_version: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      exhausted: 0,
    },
    error: null,
  };
}

function emptyCertifiedBankRecovery() {
  return {
    data: {
      schema_version: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      exhausted: 0,
    },
    error: null,
  };
}

function emptyModelCacheRecovery() {
  return {
    data: {
      schema_version: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      exhausted: 0,
    },
    error: null,
  };
}

Deno.test(
  "recovery endpoint rejects missing secrets and non-POST methods",
  async () => {
    const handler = createAsyncRecoveryHandler({
      createAdminClient: () => ({}) as WorkerApiClient,
      getRecoverySecret: () => "recovery-secret",
      getServiceKey: () => "service-key",
      getSupabaseUrl: () => "https://project.supabase.co",
      waitUntil: () => undefined,
    });
    assertEquals(
      (await handler(new Request("https://local", { method: "GET" }))).status,
      405,
    );
    assertEquals(
      (await handler(new Request("https://local", { method: "POST" }))).status,
      401,
    );
  },
);

Deno.test(
  "one accepted recovery reconciles all queues and wakes all workers",
  async () => {
    const rpcCalls: Array<{ schema: string; name: string; args: unknown }> = [];
    const wakeups: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let task: Promise<unknown> | null = null;
    const admin = {
      schema: (schema: string) => ({
        rpc: async (name: string, args: Record<string, unknown>) => {
          rpcCalls.push({ schema, name, args });
          if (name === "get_async_claimable_queue_metrics") {
            return {
              data: [
                {
                  queue_name: "writing_evaluation",
                  claimable_jobs: 3,
                  claimable_messages: 3,
                },
                {
                  queue_name: "worksheet_generation",
                  claimable_jobs: 2,
                  claimable_messages: 2,
                },
                {
                  queue_name: "worksheet_answer_evaluation",
                  claimable_jobs: 1,
                  claimable_messages: 1,
                },
              ],
              error: null,
            };
          }
          if (name === "release_due_feedback") {
            return { data: 2, error: null };
          }
          if (name === "reconcile_expired_ai_spend_reservations") {
            return { data: 0, error: null };
          }
          if (name === "process_practice_cycle_transition_jobs") {
            return {
              data: {
                schema_version: 1,
                attempted: 2,
                succeeded: 2,
                failed: 0,
                deferred: 1,
                exhausted: 0,
              },
              error: null,
            };
          }
          if (name === "reconcile_eligible_level_fit_cycles") {
            return {
              data: {
                schema_version: 1,
                attempted: 2,
                succeeded: 1,
                failed: 1,
                deferred: 0,
                exhausted: 0,
              },
              error: null,
            };
          }
          if (name === "recover_current_certified_worksheet_assignments") {
            return {
              data: {
                schema_version: 1,
                attempted: 1,
                succeeded: 1,
                failed: 0,
                deferred: 1,
                exhausted: 0,
              },
              error: null,
            };
          }
          if (name === "promote_pending_model_validated_worksheets") {
            return {
              data: {
                schema_version: 1,
                attempted: 2,
                succeeded: 2,
                failed: 0,
                deferred: 1,
                exhausted: 0,
              },
              error: null,
            };
          }
          if (name === "recover_current_model_cache_assignments") {
            return {
              data: {
                schema_version: 1,
                attempted: 1,
                succeeded: 1,
                failed: 0,
                deferred: 1,
                exhausted: 0,
              },
              error: null,
            };
          }
          return { data: [], error: null };
        },
      }),
    } as unknown as WorkerApiClient;
    const handler = createAsyncRecoveryHandler({
      createAdminClient: () => admin,
      getRecoverySecret: () => "recovery-secret",
      getServiceKey: () => "service-key",
      getSupabaseUrl: () => "https://project.supabase.co/",
      waitUntil: (value) => {
        task = value;
      },
      fetchImpl: async (input, init) => {
        wakeups.push(String(input));
        assertEquals(init?.body, "{}");
        const headers = new Headers(init?.headers);
        assertEquals(headers.get("apikey"), "service-key");
        assertEquals(headers.get("authorization"), null);
        assert(
          init?.signal instanceof AbortSignal,
          "Worker wakeups must be abortable.",
        );
        return new Response(null, { status: 202 });
      },
      log: (event) => logs.push(event),
    });

    const response = await handler(
      new Request("https://local", {
        method: "POST",
        headers: { "x-process-recovery-secret": "recovery-secret" },
      }),
    );
    assertEquals(response.status, 202);
    assert(task, "Recovery must be handed to waitUntil.");
    await task;

    assertEquals(
      rpcCalls.map((call) => call.schema),
      [
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
        "api",
      ],
    );
    assertEquals(
      rpcCalls
        .slice(0, 3)
        .map(
          (call) => (call.args as Record<string, unknown>).target_queue_name,
        ),
      [
        "writing_evaluation",
        "worksheet_generation",
        "worksheet_answer_evaluation",
      ],
    );
    assertEquals(rpcCalls[3]?.name, "reconcile_expired_ai_spend_reservations");
    assertEquals(rpcCalls[3]?.args, { batch_size: 100 });
    assertEquals(rpcCalls[4]?.name, "release_due_feedback");
    assertEquals(rpcCalls[4]?.args, {
      batch_size: RECOVERY_SCHEDULED_RELEASE_BATCH_SIZE,
    });
    assertEquals(rpcCalls[5]?.name, "process_practice_cycle_transition_jobs");
    assertEquals(rpcCalls[5]?.args, {
      max_jobs: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE,
    });
    assertEquals(rpcCalls[6]?.name, "reconcile_eligible_level_fit_cycles");
    assertEquals(rpcCalls[6]?.args, {
      max_cycles: RECOVERY_LEVEL_FIT_BATCH_SIZE,
    });
    assertEquals(
      rpcCalls[7]?.name,
      "recover_current_certified_worksheet_assignments",
    );
    assertEquals(rpcCalls[7]?.args, {
      max_assignments: RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE,
    });
    assertEquals(
      rpcCalls[8]?.name,
      "promote_pending_model_validated_worksheets",
    );
    assertEquals(rpcCalls[8]?.args, {
      max_worksheets: RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE,
    });
    assertEquals(
      rpcCalls[9]?.name,
      "recover_current_model_cache_assignments",
    );
    assertEquals(rpcCalls[9]?.args, {
      max_assignments: RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE,
    });
    assertEquals(rpcCalls[10]?.name, "get_async_claimable_queue_metrics");
    assertEquals(rpcCalls[11]?.name, "record_recovery_heartbeat");
    assertEquals(logs[0]?.expired_reservation_reconciliation_failures, 0);
    assertEquals(logs[0]?.expired_reservations_estimated, 0);
    assertEquals(logs[0]?.scheduled_release_failures, 0);
    assertEquals(logs[0]?.scheduled_feedback_released, 2);
    assertEquals(logs[0]?.practice_cycle_transition_failures, 0);
    assertEquals(logs[0]?.practice_cycle_transition_attempted, 2);
    assertEquals(logs[0]?.practice_cycle_transition_succeeded, 2);
    assertEquals(logs[0]?.practice_cycle_transition_failed, 0);
    assertEquals(logs[0]?.practice_cycle_transition_deferred, 1);
    assertEquals(logs[0]?.practice_cycle_transition_exhausted, 0);
    assertEquals(logs[0]?.level_fit_reconciliation_failures, 0);
    assertEquals(logs[0]?.level_fit_attempted, 2);
    assertEquals(logs[0]?.level_fit_succeeded, 1);
    assertEquals(logs[0]?.level_fit_failed, 1);
    assertEquals(logs[0]?.certified_bank_rescue_failures, 0);
    assertEquals(logs[0]?.certified_bank_rescue_attempted, 1);
    assertEquals(logs[0]?.certified_bank_rescue_succeeded, 1);
    assertEquals(logs[0]?.certified_bank_rescue_failed, 0);
    assertEquals(logs[0]?.certified_bank_rescue_deferred, 1);
    assertEquals(logs[0]?.model_cache_promotion_failures, 0);
    assertEquals(logs[0]?.model_cache_promotion_attempted, 2);
    assertEquals(logs[0]?.model_cache_promotion_succeeded, 2);
    assertEquals(logs[0]?.model_cache_promotion_failed, 0);
    assertEquals(logs[0]?.model_cache_promotion_deferred, 1);
    assertEquals(logs[0]?.model_cache_promotion_exhausted, 0);
    assertEquals(logs[0]?.model_cache_assignment_recovery_failures, 0);
    assertEquals(logs[0]?.model_cache_assignment_recovery_attempted, 1);
    assertEquals(logs[0]?.model_cache_assignment_recovery_succeeded, 1);
    assertEquals(logs[0]?.model_cache_assignment_recovery_failed, 0);
    assertEquals(logs[0]?.model_cache_assignment_recovery_deferred, 1);
    assertEquals(logs[0]?.model_cache_assignment_recovery_exhausted, 0);
    assertEquals(wakeups, [
      "https://project.supabase.co/functions/v1/process-writing-jobs",
      "https://project.supabase.co/functions/v1/process-writing-jobs",
      "https://project.supabase.co/functions/v1/process-writing-jobs",
      "https://project.supabase.co/functions/v1/process-worksheet-generation-jobs",
      "https://project.supabase.co/functions/v1/process-worksheet-generation-jobs",
      "https://project.supabase.co/functions/v1/process-worksheet-answer-jobs",
    ]);
  },
);

Deno.test(
  "a failed scheduled-release sweep withholds the recovery heartbeat",
  async () => {
    const rpcNames: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let task: Promise<unknown> | null = null;
    const admin = {
      schema: () => ({
        rpc: async (name: string) => {
          rpcNames.push(name);
          if (name === "release_due_feedback") {
            return {
              data: null,
              error: { code: "XX000", message: "release failed" },
            };
          }
          if (name === "reconcile_expired_ai_spend_reservations") {
            return { data: 0, error: null };
          }
          if (name === "process_practice_cycle_transition_jobs") {
            return emptyPracticeCycleTransitionRecovery();
          }
          if (name === "reconcile_eligible_level_fit_cycles") {
            return emptyLevelFitRecovery();
          }
          if (name === "recover_current_certified_worksheet_assignments") {
            return emptyCertifiedBankRecovery();
          }
          if (
            name === "promote_pending_model_validated_worksheets" ||
            name === "recover_current_model_cache_assignments"
          ) {
            return emptyModelCacheRecovery();
          }
          if (name === "get_async_claimable_queue_metrics") {
            return { data: [], error: null };
          }
          return { data: [], error: null };
        },
      }),
    } as unknown as WorkerApiClient;
    const handler = createAsyncRecoveryHandler({
      createAdminClient: () => admin,
      getRecoverySecret: () => "recovery-secret",
      getServiceKey: () => "service-key",
      getSupabaseUrl: () => "https://project.supabase.co",
      waitUntil: (value) => {
        task = value;
      },
      fetchImpl: async () => new Response(null, { status: 202 }),
      log: (event) => logs.push(event),
    });

    const response = await handler(
      new Request("https://local", {
        method: "POST",
        headers: { "x-process-recovery-secret": "recovery-secret" },
      }),
    );
    assertEquals(response.status, 202);
    assert(task, "Recovery must be handed to waitUntil.");
    await task;

    assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
    assertEquals(logs[0]?.scheduled_release_failures, 1);
    assertEquals(logs[0]?.scheduled_feedback_released, 0);
  },
);

Deno.test(
  "malformed and thrown scheduled-release results both withhold the recovery heartbeat",
  async () => {
    for (const failure of ["malformed", "thrown"] as const) {
      const rpcNames: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let task: Promise<unknown> | null = null;
      const admin = {
        schema: () => ({
          rpc: async (name: string) => {
            rpcNames.push(name);
            if (name === "release_due_feedback") {
              if (failure === "thrown") throw new Error("raw release failure");
              return { data: "1.5", error: null };
            }
            if (name === "reconcile_expired_ai_spend_reservations") {
              return { data: 0, error: null };
            }
            if (name === "process_practice_cycle_transition_jobs") {
              return emptyPracticeCycleTransitionRecovery();
            }
            if (name === "reconcile_eligible_level_fit_cycles") {
              return emptyLevelFitRecovery();
            }
            if (name === "recover_current_certified_worksheet_assignments") {
              return emptyCertifiedBankRecovery();
            }
            if (
              name === "promote_pending_model_validated_worksheets" ||
              name === "recover_current_model_cache_assignments"
            ) {
              return emptyModelCacheRecovery();
            }
            if (name === "get_async_claimable_queue_metrics") {
              return { data: [], error: null };
            }
            return { data: [], error: null };
          },
        }),
      } as unknown as WorkerApiClient;
      const handler = createAsyncRecoveryHandler({
        createAdminClient: () => admin,
        getRecoverySecret: () => "recovery-secret",
        getServiceKey: () => "service-key",
        getSupabaseUrl: () => "https://project.supabase.co",
        waitUntil: (value) => {
          task = value;
        },
        fetchImpl: async () => new Response(null, { status: 202 }),
        log: (event) => logs.push(event),
      });

      const response = await handler(
        new Request("https://local", {
          method: "POST",
          headers: { "x-process-recovery-secret": "recovery-secret" },
        }),
      );
      assertEquals(response.status, 202);
      assert(task, "Recovery must be handed to waitUntil.");
      await task;

      assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
      assertEquals(logs[0]?.scheduled_release_failures, 1);
      assertEquals(logs[0]?.scheduled_feedback_released, 0);
      assertEquals(JSON.stringify(logs).includes("raw release failure"), false);
    }
  },
);

Deno.test(
  "malformed or failed practice-cycle transition processing withholds heartbeat safely",
  async () => {
    for (
      const failure of [
        "malformed",
        "attempted_overflow",
        "deferred_overflow",
        "extra_category",
        "exhausted",
        "rpc_error",
        "thrown",
      ] as const
    ) {
      const rpcNames: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let task: Promise<unknown> | null = null;
      const admin = {
        schema: () => ({
          rpc: async (name: string) => {
            rpcNames.push(name);
            if (name === "reconcile_expired_ai_spend_reservations") {
              return { data: 0, error: null };
            }
            if (name === "release_due_feedback") {
              return { data: 0, error: null };
            }
            if (name === "process_practice_cycle_transition_jobs") {
              if (failure === "thrown") {
                throw new Error("raw transition processor failure");
              }
              if (failure === "rpc_error") {
                return {
                  data: null,
                  error: {
                    code: "XX000",
                    message: "raw transition db failure",
                  },
                };
              }
              if (failure === "deferred_overflow") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred:
                      RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE * 4 + 1,
                    exhausted: 0,
                  },
                  error: null,
                };
              }
              if (failure === "attempted_overflow") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE +
                      1,
                    succeeded: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE +
                      1,
                    failed: 0,
                    deferred: 0,
                    exhausted: 0,
                  },
                  error: null,
                };
              }
              if (failure === "extra_category") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred: 0,
                    exhausted: 0,
                    skipped: 1,
                  },
                  error: null,
                };
              }
              if (failure === "exhausted") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred: 0,
                    exhausted: 1,
                  },
                  error: null,
                };
              }
              return {
                data: {
                  schema_version: 1,
                  attempted: 1,
                  succeeded: 1,
                  failed: 1,
                  deferred: 0,
                  exhausted: 0,
                },
                error: null,
              };
            }
            if (name === "reconcile_eligible_level_fit_cycles") {
              return emptyLevelFitRecovery();
            }
            if (name === "recover_current_certified_worksheet_assignments") {
              return emptyCertifiedBankRecovery();
            }
            if (
              name === "promote_pending_model_validated_worksheets" ||
              name === "recover_current_model_cache_assignments"
            ) {
              return emptyModelCacheRecovery();
            }
            if (name === "get_async_claimable_queue_metrics") {
              return { data: [], error: null };
            }
            return { data: [], error: null };
          },
        }),
      } as unknown as WorkerApiClient;
      const handler = createAsyncRecoveryHandler({
        createAdminClient: () => admin,
        getRecoverySecret: () => "recovery-secret",
        getServiceKey: () => "service-key",
        getSupabaseUrl: () => "https://project.supabase.co",
        waitUntil: (value) => {
          task = value;
        },
        fetchImpl: async () => new Response(null, { status: 202 }),
        log: (event) => logs.push(event),
      });

      const response = await handler(
        new Request("https://local", {
          method: "POST",
          headers: { "x-process-recovery-secret": "recovery-secret" },
        }),
      );
      assertEquals(response.status, 202);
      assert(task, "Recovery must be handed to waitUntil.");
      await task;

      assertEquals(
        rpcNames.filter((name) => name === "reconcile_async_jobs").length,
        3,
      );
      assertEquals(
        rpcNames.includes("reconcile_eligible_level_fit_cycles"),
        true,
      );
      assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
      assertEquals(logs[0]?.practice_cycle_transition_failures, 1);
      assertEquals(logs[0]?.practice_cycle_transition_attempted, 0);
      assertEquals(logs[0]?.practice_cycle_transition_succeeded, 0);
      assertEquals(logs[0]?.practice_cycle_transition_failed, 0);
      assertEquals(logs[0]?.practice_cycle_transition_deferred, 0);
      assertEquals(
        logs[0]?.practice_cycle_transition_exhausted,
        failure === "exhausted" ? 1 : 0,
      );
      assertEquals(
        JSON.stringify(logs).includes("raw transition processor failure"),
        false,
      );
      assertEquals(
        JSON.stringify(logs).includes("raw transition db failure"),
        false,
      );
    }
  },
);

Deno.test(
  "malformed or failed level-fit recovery withholds heartbeat without blocking queue recovery",
  async () => {
    for (
      const failure of [
        "malformed",
        "exhausted",
        "rpc_error",
        "thrown",
      ] as const
    ) {
      const rpcNames: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let task: Promise<unknown> | null = null;
      const admin = {
        schema: () => ({
          rpc: async (name: string) => {
            rpcNames.push(name);
            if (name === "reconcile_expired_ai_spend_reservations") {
              return { data: 0, error: null };
            }
            if (name === "release_due_feedback") {
              return { data: 0, error: null };
            }
            if (name === "process_practice_cycle_transition_jobs") {
              return emptyPracticeCycleTransitionRecovery();
            }
            if (name === "reconcile_eligible_level_fit_cycles") {
              if (failure === "thrown") {
                throw new Error("raw learner reconciliation failure");
              }
              if (failure === "rpc_error") {
                return {
                  data: null,
                  error: { code: "XX000", message: "raw database failure" },
                };
              }
              if (failure === "exhausted") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred: 0,
                    exhausted: 1,
                  },
                  error: null,
                };
              }
              return {
                data: {
                  schema_version: 1,
                  attempted: 1,
                  succeeded: 2,
                  failed: 0,
                  deferred: 0,
                  exhausted: 0,
                },
                error: null,
              };
            }
            if (name === "get_async_claimable_queue_metrics") {
              return { data: [], error: null };
            }
            if (name === "recover_current_certified_worksheet_assignments") {
              return emptyCertifiedBankRecovery();
            }
            if (
              name === "promote_pending_model_validated_worksheets" ||
              name === "recover_current_model_cache_assignments"
            ) {
              return emptyModelCacheRecovery();
            }
            return { data: [], error: null };
          },
        }),
      } as unknown as WorkerApiClient;
      const handler = createAsyncRecoveryHandler({
        createAdminClient: () => admin,
        getRecoverySecret: () => "recovery-secret",
        getServiceKey: () => "service-key",
        getSupabaseUrl: () => "https://project.supabase.co",
        waitUntil: (value) => {
          task = value;
        },
        fetchImpl: async () => new Response(null, { status: 202 }),
        log: (event) => logs.push(event),
      });

      const response = await handler(
        new Request("https://local", {
          method: "POST",
          headers: { "x-process-recovery-secret": "recovery-secret" },
        }),
      );
      assertEquals(response.status, 202);
      assert(task, "Recovery must be handed to waitUntil.");
      await task;

      assertEquals(
        rpcNames.filter((name) => name === "reconcile_async_jobs").length,
        3,
      );
      assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
      assertEquals(logs[0]?.level_fit_reconciliation_failures, 1);
      assertEquals(logs[0]?.level_fit_attempted, 0);
      assertEquals(
        logs[0]?.level_fit_exhausted,
        failure === "exhausted" ? 1 : 0,
      );
      assertEquals(
        JSON.stringify(logs).includes("raw learner reconciliation failure"),
        false,
      );
      assertEquals(
        JSON.stringify(logs).includes("raw database failure"),
        false,
      );
    }
  },
);

Deno.test(
  "malformed, failed, or per-assignment bank rescue failures withhold heartbeat",
  async () => {
    for (
      const failure of [
        "malformed",
        "deferred_overflow",
        "exhausted",
        "rpc_error",
        "thrown",
        "item_failed",
      ] as const
    ) {
      const rpcNames: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let task: Promise<unknown> | null = null;
      const admin = {
        schema: () => ({
          rpc: async (name: string) => {
            rpcNames.push(name);
            if (name === "reconcile_expired_ai_spend_reservations") {
              return { data: 0, error: null };
            }
            if (name === "release_due_feedback") {
              return { data: 0, error: null };
            }
            if (name === "process_practice_cycle_transition_jobs") {
              return emptyPracticeCycleTransitionRecovery();
            }
            if (name === "reconcile_eligible_level_fit_cycles") {
              return emptyLevelFitRecovery();
            }
            if (name === "recover_current_certified_worksheet_assignments") {
              if (failure === "thrown") {
                throw new Error("raw certified bank rescue failure");
              }
              if (failure === "rpc_error") {
                return {
                  data: null,
                  error: {
                    code: "XX000",
                    message: "raw certified bank database failure",
                  },
                };
              }
              if (failure === "item_failed") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 1,
                    succeeded: 0,
                    failed: 1,
                    deferred: 0,
                    exhausted: 0,
                  },
                  error: null,
                };
              }
              if (failure === "deferred_overflow") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred: RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE * 4 + 1,
                    exhausted: 0,
                  },
                  error: null,
                };
              }
              if (failure === "exhausted") {
                return {
                  data: {
                    schema_version: 1,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    deferred: 0,
                    exhausted: 1,
                  },
                  error: null,
                };
              }
              return {
                data: {
                  schema_version: 1,
                  attempted: 1,
                  succeeded: 2,
                  failed: 0,
                  deferred: 0,
                  exhausted: 0,
                },
                error: null,
              };
            }
            if (
              name === "promote_pending_model_validated_worksheets" ||
              name === "recover_current_model_cache_assignments"
            ) {
              return emptyModelCacheRecovery();
            }
            if (name === "get_async_claimable_queue_metrics") {
              return { data: [], error: null };
            }
            return { data: [], error: null };
          },
        }),
      } as unknown as WorkerApiClient;
      const handler = createAsyncRecoveryHandler({
        createAdminClient: () => admin,
        getRecoverySecret: () => "recovery-secret",
        getServiceKey: () => "service-key",
        getSupabaseUrl: () => "https://project.supabase.co",
        waitUntil: (value) => {
          task = value;
        },
        fetchImpl: async () => new Response(null, { status: 202 }),
        log: (event) => logs.push(event),
      });

      const response = await handler(
        new Request("https://local", {
          method: "POST",
          headers: { "x-process-recovery-secret": "recovery-secret" },
        }),
      );
      assertEquals(response.status, 202);
      assert(task, "Recovery must be handed to waitUntil.");
      await task;

      assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
      assertEquals(logs[0]?.certified_bank_rescue_failures, 1);
      assertEquals(
        logs[0]?.certified_bank_rescue_failed,
        failure === "item_failed" ? 1 : 0,
      );
      assertEquals(
        logs[0]?.certified_bank_rescue_exhausted,
        failure === "exhausted" ? 1 : 0,
      );
      assertEquals(JSON.stringify(logs).includes("raw certified bank"), false);
    }
  },
);

Deno.test(
  "model-cache promotion and assignment recovery fail closed with content-free telemetry",
  async () => {
    for (
      const target of [
        "promote_pending_model_validated_worksheets",
        "recover_current_model_cache_assignments",
      ] as const
    ) {
      for (
        const failure of [
          "malformed",
          "rpc_error",
          "thrown",
          "item_failed",
          "exhausted",
        ] as const
      ) {
        const rpcNames: string[] = [];
        const logs: Array<Record<string, unknown>> = [];
        let task: Promise<unknown> | null = null;
        const admin = {
          schema: () => ({
            rpc: async (name: string) => {
              rpcNames.push(name);
              if (name === "reconcile_expired_ai_spend_reservations") {
                return { data: 0, error: null };
              }
              if (name === "release_due_feedback") {
                return { data: 0, error: null };
              }
              if (name === "process_practice_cycle_transition_jobs") {
                return emptyPracticeCycleTransitionRecovery();
              }
              if (name === "reconcile_eligible_level_fit_cycles") {
                return emptyLevelFitRecovery();
              }
              if (name === "recover_current_certified_worksheet_assignments") {
                return emptyCertifiedBankRecovery();
              }
              if (
                name === "promote_pending_model_validated_worksheets" ||
                name === "recover_current_model_cache_assignments"
              ) {
                if (name !== target) return emptyModelCacheRecovery();
                if (failure === "thrown") {
                  throw new Error("raw model-cache worksheet content");
                }
                if (failure === "rpc_error") {
                  return {
                    data: null,
                    error: {
                      code: "XX000",
                      message: "raw model-cache database content",
                    },
                  };
                }
                if (failure === "malformed") {
                  return { data: { schema_version: 1 }, error: null };
                }
                return {
                  data: {
                    schema_version: 1,
                    attempted: 1,
                    succeeded: failure === "item_failed" ? 0 : 1,
                    failed: failure === "item_failed" ? 1 : 0,
                    deferred: 0,
                    exhausted: failure === "exhausted" ? 1 : 0,
                  },
                  error: null,
                };
              }
              if (name === "get_async_claimable_queue_metrics") {
                return { data: [], error: null };
              }
              return { data: [], error: null };
            },
          }),
        } as unknown as WorkerApiClient;
        const handler = createAsyncRecoveryHandler({
          createAdminClient: () => admin,
          getRecoverySecret: () => "recovery-secret",
          getServiceKey: () => "service-key",
          getSupabaseUrl: () => "https://project.supabase.co",
          waitUntil: (value) => {
            task = value;
          },
          fetchImpl: async () => new Response(null, { status: 202 }),
          log: (event) => logs.push(event),
        });

        const response = await handler(
          new Request("https://local", {
            method: "POST",
            headers: { "x-process-recovery-secret": "recovery-secret" },
          }),
        );
        assertEquals(response.status, 202);
        assert(task, "Recovery must be handed to waitUntil.");
        await task;

        const certifiedIndex = rpcNames.indexOf(
          "recover_current_certified_worksheet_assignments",
        );
        const promotionIndex = rpcNames.indexOf(
          "promote_pending_model_validated_worksheets",
        );
        const assignmentIndex = rpcNames.indexOf(
          "recover_current_model_cache_assignments",
        );
        assert(
          certifiedIndex >= 0 &&
            promotionIndex > certifiedIndex &&
            assignmentIndex > promotionIndex,
          "Model-cache recovery must follow human-certified rescue in order.",
        );
        assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
        const prefix = target === "promote_pending_model_validated_worksheets"
          ? "model_cache_promotion"
          : "model_cache_assignment_recovery";
        assertEquals(logs[0]?.[`${prefix}_failures`], 1);
        assertEquals(
          logs[0]?.[`${prefix}_failed`],
          failure === "item_failed" ? 1 : 0,
        );
        assertEquals(
          logs[0]?.[`${prefix}_exhausted`],
          failure === "exhausted" ? 1 : 0,
        );
        const serializedLogs = JSON.stringify(logs);
        assertEquals(serializedLogs.includes("raw model-cache"), false);
        assertEquals(serializedLogs.includes("worksheet content"), false);
      }
    }
  },
);

Deno.test(
  "failed or malformed spend reconciliation withholds heartbeat but preserves other recovery work",
  async () => {
    for (const failure of ["rpc_error", "malformed", "thrown"] as const) {
      const rpcNames: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      let task: Promise<unknown> | null = null;
      const admin = {
        schema: () => ({
          rpc: async (name: string) => {
            rpcNames.push(name);
            if (name === "reconcile_expired_ai_spend_reservations") {
              if (failure === "thrown") throw new Error("raw spend failure");
              if (failure === "malformed") {
                return { data: "0.5", error: null };
              }
              return {
                data: null,
                error: { code: "XX000", message: "raw spend failure" },
              };
            }
            if (name === "release_due_feedback") {
              return { data: 0, error: null };
            }
            if (name === "process_practice_cycle_transition_jobs") {
              return emptyPracticeCycleTransitionRecovery();
            }
            if (name === "reconcile_eligible_level_fit_cycles") {
              return emptyLevelFitRecovery();
            }
            if (name === "recover_current_certified_worksheet_assignments") {
              return emptyCertifiedBankRecovery();
            }
            if (
              name === "promote_pending_model_validated_worksheets" ||
              name === "recover_current_model_cache_assignments"
            ) {
              return emptyModelCacheRecovery();
            }
            if (name === "get_async_claimable_queue_metrics") {
              return { data: [], error: null };
            }
            return { data: [], error: null };
          },
        }),
      } as unknown as WorkerApiClient;
      const handler = createAsyncRecoveryHandler({
        createAdminClient: () => admin,
        getRecoverySecret: () => "recovery-secret",
        getServiceKey: () => "service-key",
        getSupabaseUrl: () => "https://project.supabase.co",
        waitUntil: (value) => {
          task = value;
        },
        fetchImpl: async () => new Response(null, { status: 202 }),
        log: (event) => logs.push(event),
      });

      const response = await handler(
        new Request("https://local", {
          method: "POST",
          headers: { "x-process-recovery-secret": "recovery-secret" },
        }),
      );
      assertEquals(response.status, 202);
      assert(task, "Recovery must be handed to waitUntil.");
      await task;

      assertEquals(
        rpcNames.filter((name) => name === "reconcile_async_jobs").length,
        3,
      );
      assertEquals(rpcNames.includes("release_due_feedback"), true);
      assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
      assertEquals(logs[0]?.expired_reservation_reconciliation_failures, 1);
      assertEquals(logs[0]?.expired_reservations_estimated, 0);
      assertEquals(JSON.stringify(logs).includes("raw spend failure"), false);
    }
  },
);

Deno.test(
  "recovery bounds unresponsive worker wakeups and withholds the heartbeat",
  async () => {
    const rpcNames: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let task: Promise<unknown> | null = null;
    let abortedWakeups = 0;
    const admin = {
      schema: () => ({
        rpc: async (name: string) => {
          rpcNames.push(name);
          if (name === "get_async_claimable_queue_metrics") {
            return {
              data: [
                {
                  queue_name: "writing_evaluation",
                  claimable_jobs: 1,
                  claimable_messages: 1,
                },
                {
                  queue_name: "worksheet_generation",
                  claimable_jobs: 1,
                  claimable_messages: 1,
                },
                {
                  queue_name: "worksheet_answer_evaluation",
                  claimable_jobs: 1,
                  claimable_messages: 1,
                },
              ],
              error: null,
            };
          }
          if (name === "release_due_feedback") {
            return { data: 0, error: null };
          }
          if (name === "reconcile_expired_ai_spend_reservations") {
            return { data: 0, error: null };
          }
          if (name === "process_practice_cycle_transition_jobs") {
            return emptyPracticeCycleTransitionRecovery();
          }
          if (name === "reconcile_eligible_level_fit_cycles") {
            return emptyLevelFitRecovery();
          }
          if (name === "recover_current_certified_worksheet_assignments") {
            return emptyCertifiedBankRecovery();
          }
          if (
            name === "promote_pending_model_validated_worksheets" ||
            name === "recover_current_model_cache_assignments"
          ) {
            return emptyModelCacheRecovery();
          }
          return { data: [], error: null };
        },
      }),
    } as unknown as WorkerApiClient;
    const handler = createAsyncRecoveryHandler({
      createAdminClient: () => admin,
      getRecoverySecret: () => "recovery-secret",
      getServiceKey: () => "service-key",
      getSupabaseUrl: () => "https://project.supabase.co",
      waitUntil: (value) => {
        task = value;
      },
      wakeupTimeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert(
            signal instanceof AbortSignal,
            "Worker wakeups must include an AbortSignal.",
          );
          signal.addEventListener(
            "abort",
            () => {
              abortedWakeups += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
      log: (event) => logs.push(event),
    });

    const response = await handler(
      new Request("https://local", {
        method: "POST",
        headers: { "x-process-recovery-secret": "recovery-secret" },
      }),
    );
    assertEquals(response.status, 202);
    assert(task, "Recovery must be handed to waitUntil.");
    await task;

    assertEquals(abortedWakeups, 3);
    assertEquals(rpcNames.includes("record_recovery_heartbeat"), false);
    assertEquals(logs[0]?.wakeup_failures, 3);
  },
);

Deno.test(
  "future outage retries do not fan out no-op worker calls",
  async () => {
    let task: Promise<unknown> | null = null;
    let wakeups = 0;
    const admin = {
      schema: () => ({
        rpc: async (name: string) => {
          if (name === "get_async_claimable_queue_metrics") {
            return {
              data: [
                {
                  queue_name: "writing_evaluation",
                  claimable_jobs: 0,
                  claimable_messages: 0,
                },
                {
                  queue_name: "worksheet_generation",
                  claimable_jobs: 0,
                  claimable_messages: 0,
                },
                {
                  queue_name: "worksheet_answer_evaluation",
                  claimable_jobs: 0,
                  claimable_messages: 0,
                },
              ],
              error: null,
            };
          }
          if (name === "release_due_feedback") {
            return { data: 0, error: null };
          }
          if (name === "reconcile_expired_ai_spend_reservations") {
            return { data: 0, error: null };
          }
          if (name === "process_practice_cycle_transition_jobs") {
            return emptyPracticeCycleTransitionRecovery();
          }
          if (name === "reconcile_eligible_level_fit_cycles") {
            return emptyLevelFitRecovery();
          }
          if (name === "recover_current_certified_worksheet_assignments") {
            return emptyCertifiedBankRecovery();
          }
          if (
            name === "promote_pending_model_validated_worksheets" ||
            name === "recover_current_model_cache_assignments"
          ) {
            return emptyModelCacheRecovery();
          }
          return { data: [], error: null };
        },
      }),
    } as unknown as WorkerApiClient;
    const handler = createAsyncRecoveryHandler({
      createAdminClient: () => admin,
      getRecoverySecret: () => "recovery-secret",
      getServiceKey: () => "service-key",
      getSupabaseUrl: () => "https://project.supabase.co",
      waitUntil: (value) => {
        task = value;
      },
      fetchImpl: async () => {
        wakeups += 1;
        return new Response(null, { status: 202 });
      },
    });

    const response = await handler(
      new Request("https://local", {
        method: "POST",
        headers: { "x-process-recovery-secret": "recovery-secret" },
      }),
    );
    assertEquals(response.status, 202);
    assert(task, "Recovery must be handed to waitUntil.");
    await task;
    assertEquals(wakeups, 0);
  },
);
