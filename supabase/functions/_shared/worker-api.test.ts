import {
  callWorkerApiRpc,
  singleWorkerRpcRow,
  WORKER_API_SCHEMA,
  type WorkerRpcRequest,
} from "./worker-api.ts";

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

Deno.test("worker RPC calls are always scoped to the api schema", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await callWorkerApiRpc(
    {
      schema: (schema) => {
        calls.push({ schema });
        return {
          rpc: async (name, args) => {
            calls.push({ name, args });
            return { data: [{ ok: true }], error: null };
          },
        };
      },
    },
    "claim_async_jobs",
    { target_queue_name: "writing_evaluation" },
  );

  assertEquals(calls, [
    { schema: WORKER_API_SCHEMA },
    {
      name: "claim_async_jobs",
      args: { target_queue_name: "writing_evaluation" },
    },
  ]);
  assertEquals(result, { data: [{ ok: true }], error: null });
});

Deno.test("single worker rows reject empty, duplicate, and scalar responses", () => {
  assertEquals(singleWorkerRpcRow([{ id: "one" }]), { id: "one" });
  assertEquals(singleWorkerRpcRow({ id: "one" }), { id: "one" });
  assertEquals(singleWorkerRpcRow([]), null);
  assertEquals(singleWorkerRpcRow([{ id: "one" }, { id: "two" }]), null);
  assertEquals(singleWorkerRpcRow("not-a-row"), null);
});

Deno.test(
  "an abort signal bounds a genuinely never-resolving Worker API request",
  async () => {
    let receivedSignal: AbortSignal | null = null;
    let transportObservedAbort = false;
    const never = new Promise<{ data: unknown; error: null }>(() => undefined);
    const request = Object.assign(never, {
      abortSignal(signal: AbortSignal) {
        receivedSignal = signal;
        signal.addEventListener("abort", () => {
          transportObservedAbort = true;
        }, { once: true });
        return never;
      },
    }) satisfies WorkerRpcRequest;
    const controller = new AbortController();
    const rpc = callWorkerApiRpc(
      {
        schema: () => ({ rpc: () => request }),
      },
      "reserve_ai_spend",
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);

    const outcome = await Promise.race([
      rpc.then(
        () => "resolved",
        (error) => error instanceof Error ? error.name : "unknown_error",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still_pending"), 250)
      ),
    ]);
    assertEquals(outcome, "AbortError");
    assertEquals(receivedSignal, controller.signal);
    assertEquals(transportObservedAbort, true);
  },
);

Deno.test(
  "signal-bound Worker API calls fail closed when the transport is not abortable",
  async () => {
    const controller = new AbortController();
    let failure = "";
    try {
      await callWorkerApiRpc(
        {
          schema: () => ({
            rpc: () => Promise.resolve({ data: null, error: null }),
          }),
        },
        "reserve_ai_spend",
        {},
        { signal: controller.signal },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : "unknown_error";
    }
    assertEquals(failure, "worker_api_abort_signal_unsupported");
  },
);
