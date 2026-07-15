export const WORKER_API_SCHEMA = "api" as const;

export type WorkerRpcError = {
  code?: string;
  message?: string;
};

export type WorkerRpcResult = {
  data: unknown;
  error: WorkerRpcError | null;
};

export type WorkerRpcRequest = PromiseLike<WorkerRpcResult> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<WorkerRpcResult>;
};

export type WorkerApiClient = {
  schema(name: typeof WORKER_API_SCHEMA): {
    rpc(
      name: string,
      args: Record<string, unknown>,
    ): WorkerRpcRequest;
  };
};

function abortedRequest() {
  return new DOMException("Worker API request aborted.", "AbortError");
}

/**
 * Durable workers must use the deliberately exposed API schema. Keeping the
 * schema selection at every call site prevents a client default from silently
 * falling back to public when production exposes only api.
 */
export async function callWorkerApiRpc(
  client: WorkerApiClient,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<WorkerRpcResult> {
  const request = client.schema(WORKER_API_SCHEMA).rpc(name, args);
  if (!options.signal) return await request;
  if (options.signal.aborted) throw abortedRequest();
  if (typeof request.abortSignal !== "function") {
    throw new Error("worker_api_abort_signal_unsupported");
  }

  const operation = request.abortSignal(options.signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortedRequest());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  try {
    // The race guarantees a bounded caller even if an erroneous transport
    // ignores the signal. Supabase's PostgREST builder also receives the same
    // signal so the underlying HTTP request is cancelled whenever possible.
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

export function singleWorkerRpcRow(
  value: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    const row = value[0];
    return row && typeof row === "object" && !Array.isArray(row)
      ? row as Record<string, unknown>
      : null;
  }
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}
