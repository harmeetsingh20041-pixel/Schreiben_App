import {
  callWorkerApiRpc,
  singleWorkerRpcRow,
  type WorkerApiClient,
} from "./worker-api.ts";

export type AiProviderName = "deepseek" | "gemini";

export type AiCallPurpose =
  | "writing_generation"
  | "writing_critique"
  | "writing_adjudication"
  | "writing_final_critique"
  | "worksheet_generation"
  | "worksheet_critique"
  | "worksheet_answer_evaluation"
  | "worksheet_answer_adjudication";

export type AiProviderCallIdentity = Readonly<{
  provider: AiProviderName;
  requested_model: string;
  call_purpose: AiCallPurpose;
  call_key: string;
}>;

export type AiProviderUsage = AiProviderCallIdentity &
  Readonly<{
    provider_model_version: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number | null;
    uncached_input_tokens?: number | null;
  }>;

export type AiProviderCallBeforeRecorder = (
  identity: AiProviderCallIdentity,
) => Promise<void>;

export type AiProviderUsageRecorder = (usage: AiProviderUsage) => Promise<void>;

export type AiProviderNotCalledRecorder = (
  identity: AiProviderCallIdentity,
  reason: "provider_not_called" | "request_failed_unbilled",
) => Promise<void>;

export type AiSpendReleaseReason =
  | "provider_not_called"
  | "request_failed_unbilled"
  | "superseded"
  | "job_cancelled";

// Every spend mutation is an authorization boundary for provider dispatch.
// Keep it short, abortable, and code-pinned so an unavailable database cannot
// hold an Edge worker forever or silently extend provider latency budgets.
export const AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS = 5_000;

type SpendPolicy = Readonly<{
  provider: AiProviderName;
  model: string;
  purpose: AiCallPurpose;
  maximumCostMicrousd: number;
}>;

export const AI_SPEND_POLICIES: readonly SpendPolicy[] = Object.freeze([
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "writing_generation",
    maximumCostMicrousd: 75_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worksheet_critique",
    maximumCostMicrousd: 50_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worksheet_answer_evaluation",
    maximumCostMicrousd: 50_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    purpose: "writing_generation",
    maximumCostMicrousd: 100_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    purpose: "writing_adjudication",
    maximumCostMicrousd: 75_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    purpose: "worksheet_generation",
    maximumCostMicrousd: 100_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    purpose: "worksheet_answer_adjudication",
    maximumCostMicrousd: 50_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "writing_critique",
    maximumCostMicrousd: 150_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "worksheet_critique",
    maximumCostMicrousd: 150_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "worksheet_answer_evaluation",
    maximumCostMicrousd: 50_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "writing_generation",
    maximumCostMicrousd: 300_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "writing_final_critique",
    maximumCostMicrousd: 150_000,
  },
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    purpose: "worksheet_generation",
    maximumCostMicrousd: 200_000,
  },
]);

const policyByIdentity = new Map(
  AI_SPEND_POLICIES.map((policy) => [
    `${policy.provider}:${policy.model}:${policy.purpose}`,
    policy,
  ]),
);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const callKeyPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const knownDatabaseSafeCodes = new Set([
  "ai_spend_workspace_budget_exceeded",
  "ai_spend_cohort_budget_exceeded",
  "ai_spend_student_fair_share_exceeded",
  "ai_spend_student_inactive",
  "ai_spend_global_budget_exceeded",
  "ai_spend_fx_rate_future",
  "ai_spend_fx_rate_stale",
  "ai_spend_emergency_stop",
  "ai_spend_model_not_allowed",
  "ai_spend_contract_invalid",
  "ai_spend_reservation_missing",
  "ai_spend_reservation_expired",
  "ai_spend_actual_exceeds_reserved",
  "ai_spend_reservation_conflict",
  "ai_spend_release_reason_invalid",
  "ai_spend_job_missing",
  "ai_spend_job_version_mismatch",
  "ai_spend_job_not_active",
]);

export class AiSpendAccountingError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(safeCode: string, retryable: boolean) {
    super("AI spend accounting failed safely.");
    this.name = "AiSpendAccountingError";
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

function policyKey(identity: AiProviderCallIdentity) {
  return `${identity.provider}:${identity.requested_model}:${identity.call_purpose}`;
}

export function maximumAiCallCostMicrousd(identity: AiProviderCallIdentity) {
  const policy = policyByIdentity.get(policyKey(identity));
  if (!policy) {
    throw new AiSpendAccountingError("ai_spend_model_not_allowed", false);
  }
  return policy.maximumCostMicrousd;
}

function safeInteger(value: unknown, minimum = 0) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function rpcSafeCode(error: { code?: string; message?: string } | null) {
  const message = error?.message?.trim() ?? "";
  return knownDatabaseSafeCodes.has(message)
    ? message
    : "ai_spend_accounting_unavailable";
}

function rpcFailure(error: { code?: string; message?: string } | null) {
  const safeCode = rpcSafeCode(error);
  const retryable =
    safeCode === "ai_spend_accounting_unavailable" ||
    safeCode === "ai_spend_reservation_expired";
  return new AiSpendAccountingError(safeCode, retryable);
}

function exactIdentity(identity: AiProviderCallIdentity) {
  if (
    (identity.provider !== "deepseek" && identity.provider !== "gemini") ||
    !identity.requested_model ||
    identity.requested_model.length > 100 ||
    !identity.call_purpose ||
    !identity.call_key ||
    identity.call_key.length > 105 ||
    !callKeyPattern.test(identity.call_key)
  ) {
    throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
  }
  maximumAiCallCostMicrousd(identity);
  return identity;
}

type Reservation = Readonly<{
  reservationId: string;
  identity: AiProviderCallIdentity;
  databaseCallKey: string;
  state: "reserved" | "finalized" | "released";
  reservedMicrousd: number;
}>;

function reservationRow(value: unknown, identity: AiProviderCallIdentity) {
  const row = singleWorkerRpcRow(value);
  if (!row) throw new AiSpendAccountingError("ai_spend_response_invalid", true);
  const reservationId =
    typeof row.reservation_id === "string" ? row.reservation_id : "";
  const state = row.state;
  const reservedMicrousd = safeInteger(row.reserved_microusd, 1);
  const workspaceRemaining = safeInteger(row.workspace_remaining_microusd);
  const globalRemaining = safeInteger(row.global_remaining_microusd);
  const expiresAt = timestamp(row.expires_at);
  if (
    !uuidPattern.test(reservationId) ||
    (state !== "reserved" && state !== "finalized" && state !== "released") ||
    reservedMicrousd === null ||
    workspaceRemaining === null ||
    globalRemaining === null ||
    !expiresAt ||
    typeof row.replayed !== "boolean"
  ) {
    throw new AiSpendAccountingError("ai_spend_response_invalid", true);
  }
  return {
    reservation: {
      reservationId,
      identity,
      databaseCallKey: "",
      state,
      reservedMicrousd,
    } satisfies Reservation,
    replayed: row.replayed,
  };
}

function finalizedRow(value: unknown, expected: Reservation) {
  const row = singleWorkerRpcRow(value);
  if (!row) throw new AiSpendAccountingError("ai_spend_response_invalid", true);
  const actual = safeInteger(row.actual_microusd);
  const input = safeInteger(row.billed_input_tokens);
  const output = safeInteger(row.billed_output_tokens);
  if (
    row.reservation_id !== expected.reservationId ||
    row.state !== "finalized" ||
    safeInteger(row.reserved_microusd, 1) !== expected.reservedMicrousd ||
    actual === null ||
    actual > expected.reservedMicrousd ||
    input === null ||
    output === null ||
    !timestamp(row.finalized_at) ||
    typeof row.replayed !== "boolean"
  ) {
    throw new AiSpendAccountingError("ai_spend_response_invalid", true);
  }
}

function releasedRow(value: unknown, expected: Reservation) {
  const row = singleWorkerRpcRow(value);
  if (
    !row ||
    row.reservation_id !== expected.reservationId ||
    row.state !== "released" ||
    !timestamp(row.released_at) ||
    typeof row.replayed !== "boolean"
  ) {
    throw new AiSpendAccountingError("ai_spend_response_invalid", true);
  }
}

export class AiSpendAccountingSession {
  readonly #client: WorkerApiClient;
  readonly #jobId: string;
  readonly #entityVersion: number;
  readonly #attemptNumber: number;
  readonly #reservationTtlSeconds: number;
  readonly #rpcTimeoutMs: number;
  readonly #reservations = new Map<string, Reservation>();

  constructor(args: {
    client: WorkerApiClient;
    jobId: string;
    entityVersion: number;
    attemptNumber: number;
    reservationTtlSeconds?: number;
    rpcTimeoutMs?: number;
  }) {
    if (
      !uuidPattern.test(args.jobId) ||
      !Number.isSafeInteger(args.entityVersion) ||
      args.entityVersion < 1 ||
      !Number.isSafeInteger(args.attemptNumber) ||
      args.attemptNumber < 1
    ) {
      throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
    }
    const ttl = args.reservationTtlSeconds ?? 900;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
      throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
    }
    const rpcTimeoutMs =
      args.rpcTimeoutMs ?? AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(rpcTimeoutMs) ||
      rpcTimeoutMs < 1 ||
      rpcTimeoutMs > AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS
    ) {
      throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
    }
    this.#client = args.client;
    this.#jobId = args.jobId;
    this.#entityVersion = args.entityVersion;
    this.#attemptNumber = args.attemptNumber;
    this.#reservationTtlSeconds = ttl;
    this.#rpcTimeoutMs = rpcTimeoutMs;
  }

  #databaseCallKey(callKey: string) {
    const value = `attempt_${this.#attemptNumber}:${callKey}`;
    if (value.length > 120 || !callKeyPattern.test(value)) {
      throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
    }
    return value;
  }

  async #callRpc(name: string, args: Record<string, unknown>) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.#rpcTimeoutMs);
    try {
      return await callWorkerApiRpc(this.#client, name, args, {
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AiSpendAccountingError) throw error;
      if (
        controller.signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        // The database may have committed before transport cancellation. Keep
        // the outcome uncertain and let reservation reconciliation settle it;
        // callers must not dispatch a provider after this failure.
        throw new AiSpendAccountingError("ai_spend_accounting_timeout", true);
      }
      throw new AiSpendAccountingError("ai_spend_accounting_unavailable", true);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  readonly beforeProviderCall: AiProviderCallBeforeRecorder = async (
    rawIdentity,
  ) => {
    const identity = exactIdentity(rawIdentity);
    const databaseCallKey = this.#databaseCallKey(identity.call_key);
    if (this.#reservations.has(databaseCallKey)) {
      throw new AiSpendAccountingError("ai_spend_duplicate_dispatch", false);
    }
    const maximumCostMicrousd = maximumAiCallCostMicrousd(identity);
    const { data, error } = await this.#callRpc("reserve_ai_spend", {
      target_job_id: this.#jobId,
      target_entity_version: this.#entityVersion,
      call_key: databaseCallKey,
      provider_name: identity.provider,
      model_name: identity.requested_model,
      call_purpose: identity.call_purpose,
      maximum_cost_microusd: maximumCostMicrousd,
      reservation_ttl_seconds: this.#reservationTtlSeconds,
    });
    if (error) throw rpcFailure(error);
    const parsed = reservationRow(data, identity);
    const reservation = {
      ...parsed.reservation,
      databaseCallKey,
    };
    if (
      reservation.state !== "reserved" ||
      reservation.reservedMicrousd !== maximumCostMicrousd
    ) {
      throw new AiSpendAccountingError(
        "ai_spend_reservation_already_settled",
        false,
      );
    }
    // A replayed reservation could belong to a previous worker that reached
    // the provider but crashed before metering. Never risk a second billed
    // dispatch under the same idempotency key; the durable job retry gets a
    // new attempt-scoped key instead.
    if (parsed.replayed) {
      throw new AiSpendAccountingError("ai_spend_dispatch_uncertain", true);
    }
    this.#reservations.set(databaseCallKey, reservation);
  };

  readonly recordProviderUsage: AiProviderUsageRecorder = async (usage) => {
    const identity = exactIdentity(usage);
    const hasCached =
      usage.cached_input_tokens !== undefined &&
      usage.cached_input_tokens !== null;
    const hasUncached =
      usage.uncached_input_tokens !== undefined &&
      usage.uncached_input_tokens !== null;
    if (
      usage.provider_model_version !== usage.requested_model ||
      !Number.isSafeInteger(usage.input_tokens) ||
      usage.input_tokens < 1 ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.output_tokens < 1 ||
      hasCached !== hasUncached ||
      (hasCached &&
        (!Number.isSafeInteger(usage.cached_input_tokens) ||
          (usage.cached_input_tokens as number) < 0 ||
          !Number.isSafeInteger(usage.uncached_input_tokens) ||
          (usage.uncached_input_tokens as number) < 0 ||
          (usage.cached_input_tokens as number) +
            (usage.uncached_input_tokens as number) !==
            usage.input_tokens))
    ) {
      throw new AiSpendAccountingError("ai_spend_contract_invalid", false);
    }
    const databaseCallKey = this.#databaseCallKey(identity.call_key);
    const reservation = this.#reservations.get(databaseCallKey);
    if (
      !reservation ||
      policyKey(reservation.identity) !== policyKey(identity)
    ) {
      throw new AiSpendAccountingError("ai_spend_reservation_missing", false);
    }
    const { data, error } = await this.#callRpc(
      "finalize_ai_spend_reservation",
      {
        target_reservation_id: reservation.reservationId,
        target_billed_input_tokens: usage.input_tokens,
        target_billed_output_tokens: usage.output_tokens,
        target_billed_cached_input_tokens: hasCached
          ? usage.cached_input_tokens
          : null,
        target_billed_uncached_input_tokens: hasUncached
          ? usage.uncached_input_tokens
          : null,
      },
    );
    if (error) throw rpcFailure(error);
    finalizedRow(data, reservation);
    this.#reservations.delete(databaseCallKey);
  };

  readonly providerNotCalled: AiProviderNotCalledRecorder = async (
    identity,
    reason,
  ) => await this.releaseProviderCall(identity, reason);

  async releaseProviderCall(
    identity: AiProviderCallIdentity,
    reason: AiSpendReleaseReason,
  ) {
    const checked = exactIdentity(identity);
    const databaseCallKey = this.#databaseCallKey(checked.call_key);
    const reservation = this.#reservations.get(databaseCallKey);
    if (
      !reservation ||
      policyKey(reservation.identity) !== policyKey(checked)
    ) {
      throw new AiSpendAccountingError("ai_spend_reservation_missing", false);
    }
    const { data, error } = await this.#callRpc(
      "release_ai_spend_reservation",
      {
        target_reservation_id: reservation.reservationId,
        release_reason: reason,
      },
    );
    if (error) throw rpcFailure(error);
    releasedRow(data, reservation);
    this.#reservations.delete(databaseCallKey);
  }
}
