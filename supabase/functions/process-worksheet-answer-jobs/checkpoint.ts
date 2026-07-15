import {
  callWorkerApiRpc,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";
import {
  type WorksheetAnswerAdjudicationCheckpoint,
  type WorksheetAnswerCheckpointStore,
  type WorksheetAnswerCompletionReview,
  WorksheetAnswerEvaluationError,
  type WorksheetAnswerProCheckpointPayload,
} from "./evaluate.ts";
import { canonicalJsonSha256 } from "../_shared/writing-adjudication.ts";

type ProviderName = "deepseek" | "gemini";

type ActiveAnswerLease = Readonly<{
  admin: WorkerApiClient;
  jobId: string;
  queueMessageId: number | string;
  workerId: string;
  attemptId: string;
  entityVersion: number;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const CHECKPOINT_RPC_TIMEOUT_MS = 5_000;

function contractVersionsValid(
  evaluatorContractVersion: number,
  promptContractVersion: number,
) {
  return evaluatorContractVersion === 1 && promptContractVersion === 1;
}

function checkpointFailure(
  code = "worksheet_answer_checkpoint_unavailable",
  retryable = true,
) {
  return new WorksheetAnswerEvaluationError(code, retryable);
}

function rpcFailure(error: { code?: string } | null) {
  if (
    error?.code === "55000" || error?.code === "22023" ||
    error?.code === "02000"
  ) {
    return checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }
  return checkpointFailure();
}

async function checkpointRpc(
  admin: WorkerApiClient,
  name: string,
  args: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CHECKPOINT_RPC_TIMEOUT_MS,
  );
  try {
    return await callWorkerApiRpc(admin, name, args, {
      signal: controller.signal,
    });
  } catch {
    throw checkpointFailure();
  } finally {
    clearTimeout(timeout);
  }
}

function leaseArgs(lease: ActiveAnswerLease) {
  return {
    target_job_id: lease.jobId,
    target_queue_message_id: lease.queueMessageId,
    worker_id: lease.workerId,
    target_attempt_id: lease.attemptId,
    expected_entity_version: lease.entityVersion,
  };
}

function objectRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function checkpointRows(value: unknown) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function providerModel(
  provider: ProviderName,
  models: Readonly<{ deepseek: string; gemini: string }>,
) {
  return provider === "deepseek" ? models.deepseek : models.gemini;
}

async function normalizeCheckpointRow(args: {
  value: unknown;
  lease: ActiveAnswerLease;
  evidenceSha256: string;
  models: Readonly<{ deepseek: string; gemini: string }>;
  evaluatorContractVersion: number;
  promptContractVersion: number;
}) {
  const row = objectRow(args.value);
  const provider = row?.provider_name;
  if (
    !row ||
    row.job_id !== args.lease.jobId ||
    row.attempt_id !== args.lease.attemptId ||
    Number(row.entity_version) !== args.lease.entityVersion ||
    Number(row.evaluator_contract_version) !==
      args.evaluatorContractVersion ||
    Number(row.prompt_contract_version) !== args.promptContractVersion ||
    row.evidence_sha256 !== args.evidenceSha256 ||
    (provider !== "deepseek" && provider !== "gemini") ||
    row.provider_model !== providerModel(provider, args.models) ||
    typeof row.verdict_sha256 !== "string" ||
    !hashPattern.test(row.verdict_sha256) ||
    !Array.isArray(row.normalized_verdict)
  ) {
    throw checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }
  const calculatedHash = await canonicalJsonSha256(row.normalized_verdict);
  if (calculatedHash !== row.verdict_sha256) {
    throw checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }
  return {
    provider,
    model: row.provider_model,
    evidenceSha256: row.evidence_sha256,
    verdictSha256: row.verdict_sha256,
    reviews: row.normalized_verdict as WorksheetAnswerCompletionReview[],
  } as const;
}

async function normalizeAdjudicationCheckpointRow(args: {
  value: unknown;
  lease: ActiveAnswerLease;
  evidenceSha256: string;
  model: "deepseek-v4-pro";
  evaluatorContractVersion: number;
  promptContractVersion: number;
}): Promise<WorksheetAnswerAdjudicationCheckpoint> {
  const row = objectRow(args.value);
  if (
    !row ||
    row.job_id !== args.lease.jobId ||
    row.attempt_id !== args.lease.attemptId ||
    Number(row.entity_version) !== args.lease.entityVersion ||
    Number(row.evaluator_contract_version) !==
      args.evaluatorContractVersion ||
    Number(row.prompt_contract_version) !== args.promptContractVersion ||
    row.evidence_sha256 !== args.evidenceSha256 ||
    row.provider_name !== "deepseek" ||
    row.provider_model !== args.model ||
    typeof row.verdict_sha256 !== "string" ||
    !hashPattern.test(row.verdict_sha256) ||
    !row.normalized_verdict ||
    typeof row.normalized_verdict !== "object" ||
    Array.isArray(row.normalized_verdict)
  ) {
    throw checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }
  const calculatedHash = await canonicalJsonSha256(row.normalized_verdict);
  if (calculatedHash !== row.verdict_sha256) {
    throw checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }
  return {
    model: args.model,
    evidenceSha256: args.evidenceSha256,
    verdictSha256: row.verdict_sha256,
    payload: row.normalized_verdict as WorksheetAnswerProCheckpointPayload,
  };
}

function validUsage(args: {
  usage: Parameters<WorksheetAnswerCheckpointStore["save"]>[0]["usage"];
  provider: ProviderName;
  model: string;
  purpose: "worksheet_answer_evaluation" | "worksheet_answer_adjudication";
}) {
  const { usage } = args;
  const hasCached = usage.cached_input_tokens != null;
  const hasUncached = usage.uncached_input_tokens != null;
  return usage.provider === args.provider &&
    usage.requested_model === args.model &&
    usage.provider_model_version === args.model &&
    usage.call_purpose === args.purpose &&
    Boolean(usage.call_key) &&
    Number.isSafeInteger(usage.input_tokens) &&
    usage.input_tokens >= 1 &&
    Number.isSafeInteger(usage.output_tokens) &&
    usage.output_tokens >= 1 &&
    hasCached === hasUncached &&
    (!hasCached ||
      (Number.isSafeInteger(usage.cached_input_tokens) &&
        Number.isSafeInteger(usage.uncached_input_tokens) &&
        (usage.cached_input_tokens as number) >= 0 &&
        (usage.uncached_input_tokens as number) >= 0 &&
        (usage.cached_input_tokens as number) +
              (usage.uncached_input_tokens as number) ===
          usage.input_tokens));
}

export function createWorksheetAnswerCheckpointStore(
  lease: ActiveAnswerLease,
): WorksheetAnswerCheckpointStore {
  if (
    !uuidPattern.test(lease.jobId) ||
    !uuidPattern.test(lease.workerId) ||
    !uuidPattern.test(lease.attemptId) ||
    !Number.isSafeInteger(lease.entityVersion) ||
    lease.entityVersion < 1
  ) {
    throw checkpointFailure(
      "worksheet_answer_checkpoint_replay_mismatch",
      false,
    );
  }

  return {
    load: async ({
      evidenceSha256,
      deepSeekModel,
      geminiModel,
      evaluatorContractVersion,
      promptContractVersion,
    }) => {
      if (
        !hashPattern.test(evidenceSha256) ||
        !contractVersionsValid(
          evaluatorContractVersion,
          promptContractVersion,
        )
      ) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      const response = await checkpointRpc(
        lease.admin,
        "get_worksheet_answer_provider_checkpoints",
        {
          ...leaseArgs(lease),
          expected_evidence_sha256: evidenceSha256,
          expected_deepseek_model: deepSeekModel,
          expected_gemini_model: geminiModel,
          expected_evaluator_contract_version: evaluatorContractVersion,
          expected_prompt_contract_version: promptContractVersion,
        },
      );
      if (response.error) throw rpcFailure(response.error);
      const rows = checkpointRows(response.data);
      if (rows.length > 2) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      const checkpoints = await Promise.all(
        rows.map((value) =>
          normalizeCheckpointRow({
            value,
            lease,
            evidenceSha256,
            models: { deepseek: deepSeekModel, gemini: geminiModel },
            evaluatorContractVersion,
            promptContractVersion,
          })
        ),
      );
      if (
        new Set(checkpoints.map((row) => row.provider)).size !==
          checkpoints.length
      ) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      return checkpoints;
    },
    save: async ({
      evidenceSha256,
      provider,
      model,
      verdictSha256,
      reviews,
      usage,
      evaluatorContractVersion,
      promptContractVersion,
    }) => {
      if (
        !hashPattern.test(evidenceSha256) ||
        !hashPattern.test(verdictSha256) ||
        await canonicalJsonSha256(reviews) !== verdictSha256 ||
        !contractVersionsValid(
          evaluatorContractVersion,
          promptContractVersion,
        ) ||
        !validUsage({
          usage,
          provider,
          model,
          purpose: "worksheet_answer_evaluation",
        })
      ) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      const response = await checkpointRpc(
        lease.admin,
        "save_worksheet_answer_provider_checkpoint",
        {
          ...leaseArgs(lease),
          target_evidence_sha256: evidenceSha256,
          target_provider_name: provider,
          target_provider_model: model,
          target_verdict_sha256: verdictSha256,
          target_normalized_verdict: reviews,
          target_call_key: usage.call_key,
          target_provider_model_version: usage.provider_model_version,
          target_billed_input_tokens: usage.input_tokens,
          target_billed_output_tokens: usage.output_tokens,
          target_billed_cached_input_tokens: usage.cached_input_tokens ?? null,
          target_billed_uncached_input_tokens: usage.uncached_input_tokens ??
            null,
          target_evaluator_contract_version: evaluatorContractVersion,
          target_prompt_contract_version: promptContractVersion,
        },
      );
      if (response.error) throw rpcFailure(response.error);
      const rows = checkpointRows(response.data);
      if (rows.length !== 1) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      await normalizeCheckpointRow({
        value: {
          ...objectRow(rows[0]),
          job_id: lease.jobId,
          attempt_id: lease.attemptId,
          entity_version: lease.entityVersion,
        },
        lease,
        evidenceSha256,
        models: {
          deepseek: provider === "deepseek" ? model : "deepseek-v4-flash",
          gemini: provider === "gemini" ? model : "gemini-3.1-flash-lite",
        },
        evaluatorContractVersion,
        promptContractVersion,
      });
    },
    loadAdjudication: async ({
      evidenceSha256,
      model,
      evaluatorContractVersion,
      promptContractVersion,
    }) => {
      if (
        !hashPattern.test(evidenceSha256) ||
        model !== "deepseek-v4-pro" ||
        !contractVersionsValid(
          evaluatorContractVersion,
          promptContractVersion,
        )
      ) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      const response = await checkpointRpc(
        lease.admin,
        "get_worksheet_answer_adjudication_checkpoint",
        {
          ...leaseArgs(lease),
          expected_evidence_sha256: evidenceSha256,
          expected_provider_model: model,
          expected_evaluator_contract_version: evaluatorContractVersion,
          expected_prompt_contract_version: promptContractVersion,
        },
      );
      if (response.error) throw rpcFailure(response.error);
      const rows = checkpointRows(response.data);
      if (rows.length > 1) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      if (rows.length === 0) return null;
      return await normalizeAdjudicationCheckpointRow({
        value: rows[0],
        lease,
        evidenceSha256,
        model,
        evaluatorContractVersion,
        promptContractVersion,
      });
    },
    saveAdjudication: async ({
      evidenceSha256,
      model,
      verdictSha256,
      payload,
      usage,
      evaluatorContractVersion,
      promptContractVersion,
    }) => {
      if (
        !hashPattern.test(evidenceSha256) ||
        model !== "deepseek-v4-pro" ||
        !hashPattern.test(verdictSha256) ||
        await canonicalJsonSha256(payload) !== verdictSha256 ||
        !contractVersionsValid(
          evaluatorContractVersion,
          promptContractVersion,
        ) ||
        !validUsage({
          usage,
          provider: "deepseek",
          model,
          purpose: "worksheet_answer_adjudication",
        })
      ) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      const response = await checkpointRpc(
        lease.admin,
        "save_worksheet_answer_adjudication_checkpoint",
        {
          ...leaseArgs(lease),
          target_evidence_sha256: evidenceSha256,
          target_provider_model: model,
          target_verdict_sha256: verdictSha256,
          target_normalized_verdict: payload,
          target_call_key: usage.call_key,
          target_provider_model_version: usage.provider_model_version,
          target_billed_input_tokens: usage.input_tokens,
          target_billed_output_tokens: usage.output_tokens,
          target_billed_cached_input_tokens: usage.cached_input_tokens ?? null,
          target_billed_uncached_input_tokens: usage.uncached_input_tokens ??
            null,
          target_evaluator_contract_version: evaluatorContractVersion,
          target_prompt_contract_version: promptContractVersion,
        },
      );
      if (response.error) throw rpcFailure(response.error);
      const rows = checkpointRows(response.data);
      if (rows.length !== 1) {
        throw checkpointFailure(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      await normalizeAdjudicationCheckpointRow({
        value: {
          ...objectRow(rows[0]),
          job_id: lease.jobId,
          attempt_id: lease.attemptId,
          entity_version: lease.entityVersion,
        },
        lease,
        evidenceSha256,
        model,
        evaluatorContractVersion,
        promptContractVersion,
      });
    },
  };
}
