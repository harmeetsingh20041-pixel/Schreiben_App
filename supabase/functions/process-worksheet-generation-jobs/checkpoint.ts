import {
  type GeneratedWorksheetCompletion,
  PRIMARY_WORKSHEET_FALLBACK_CODES,
  type PrimaryWorksheetFallbackCode,
  type WorksheetCriticEvidence,
  WorksheetGenerationError,
  type WorksheetProviderUsage,
  type WorksheetRejectedCandidate,
} from "../_shared/worksheet-generation.ts";
import {
  callWorkerApiRpc,
  singleWorkerRpcRow,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";

export type WorksheetCheckpointStage =
  | "primary_fallback_generation"
  | "primary_critique"
  | "repair_generation"
  | "repair_critique"
  | "completion";

export type WorksheetGenerationCheckpoint = Readonly<{
  jobId: string;
  assignmentId: string;
  entityVersion: number;
  stage: WorksheetCheckpointStage;
  candidateAttempt: 1 | 2 | null;
  candidateProvider: "deepseek" | "gemini" | null;
  candidateModel: string | null;
  candidateSha256: string | null;
  candidate: unknown;
  primaryFailureCode: PrimaryWorksheetFallbackCode | null;
  primaryRejection: unknown;
  completionPayload: unknown;
  criticEvidence: Readonly<{
    deepseek: unknown | null;
    gemini: unknown | null;
  }>;
}>;

type ActiveLease = Readonly<{
  admin: WorkerApiClient;
  jobId: string;
  queueMessageId: number | string;
  workerId: string;
  entityVersion: number;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const callKeyPattern = /^[a-z][a-z0-9._:-]{0,104}$/;
const WORKSHEET_CHECKPOINT_RPC_TIMEOUT_MS = 5_000;
const checkpointStages = new Set<WorksheetCheckpointStage>([
  "primary_fallback_generation",
  "primary_critique",
  "repair_generation",
  "repair_critique",
  "completion",
]);

function safeAttempt(value: unknown): 1 | 2 | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[12]$/.test(value)
    ? Number(value)
    : Number.NaN;
  return parsed === 1 || parsed === 2 ? parsed : null;
}

function checkpointFailure(code = "worksheet_checkpoint_unavailable") {
  return new WorksheetGenerationError(code, true);
}

function rpcArgs(lease: ActiveLease) {
  return {
    target_job_id: lease.jobId,
    target_queue_message_id: lease.queueMessageId,
    worker_id: lease.workerId,
    expected_entity_version: lease.entityVersion,
  };
}

async function checkpointRpc(
  admin: WorkerApiClient,
  name: string,
  args: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    WORKSHEET_CHECKPOINT_RPC_TIMEOUT_MS,
  );
  try {
    return await callWorkerApiRpc(admin, name, args, {
      signal: controller.signal,
    });
  } catch {
    throw checkpointFailure();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function loadWorksheetGenerationCheckpoint(
  lease: ActiveLease,
): Promise<WorksheetGenerationCheckpoint | null> {
  let response;
  try {
    response = await checkpointRpc(
      lease.admin,
      "get_worksheet_generation_checkpoint",
      rpcArgs(lease),
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) throw checkpointFailure();
  const rows = Array.isArray(response.data)
    ? response.data
    : response.data == null
    ? []
    : [response.data];
  if (rows.length === 0) return null;
  const row = singleWorkerRpcRow(rows);
  if (!row) throw checkpointFailure("worksheet_checkpoint_response_invalid");
  const stage = row.stage;
  const attempt = row.candidate_attempt == null
    ? null
    : safeAttempt(row.candidate_attempt);
  const provider = row.candidate_provider == null
    ? null
    : row.candidate_provider === "deepseek" ||
        row.candidate_provider === "gemini"
    ? row.candidate_provider
    : undefined;
  const model = row.candidate_model == null
    ? null
    : typeof row.candidate_model === "string" &&
        /^[a-z0-9._:/-]{1,100}$/i.test(row.candidate_model)
    ? row.candidate_model
    : undefined;
  const candidateHash = row.candidate_sha256 == null
    ? null
    : typeof row.candidate_sha256 === "string" &&
        hashPattern.test(row.candidate_sha256)
    ? row.candidate_sha256
    : undefined;
  const fallbackFailureCode = row.fallback_failure_code == null
    ? null
    : typeof row.fallback_failure_code === "string" &&
        PRIMARY_WORKSHEET_FALLBACK_CODES.includes(
          row.fallback_failure_code as PrimaryWorksheetFallbackCode,
        )
    ? row.fallback_failure_code as PrimaryWorksheetFallbackCode
    : undefined;
  const deepSeekCriticEvidence = row.deepseek_critic_evidence ?? null;
  const geminiCriticEvidence = row.gemini_critic_evidence ?? null;
  const invalidCriticEvidence = [
    deepSeekCriticEvidence,
    geminiCriticEvidence,
  ].some((evidence) =>
    evidence !== null &&
    (typeof evidence !== "object" || Array.isArray(evidence))
  );
  if (
    row.job_id !== lease.jobId ||
    typeof row.assignment_id !== "string" ||
    !uuidPattern.test(row.assignment_id) ||
    Number(row.entity_version) !== lease.entityVersion ||
    typeof stage !== "string" ||
    !checkpointStages.has(stage as WorksheetCheckpointStage) ||
    provider === undefined || model === undefined ||
    candidateHash === undefined ||
    fallbackFailureCode === undefined || invalidCriticEvidence
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
  if (
    (stage === "primary_fallback_generation" &&
      (attempt !== 1 || provider !== null || model !== null ||
        candidateHash !== null || row.candidate !== null ||
        row.primary_rejection !== null || fallbackFailureCode === null)) ||
    (stage === "primary_critique" &&
      (attempt !== 1 || provider == null || model == null ||
        candidateHash == null || row.candidate == null)) ||
    (stage === "repair_generation" &&
      (attempt !== 2 || provider !== null || model !== null ||
        candidateHash !== null || row.candidate !== null ||
        row.primary_rejection == null)) ||
    (stage === "repair_critique" &&
      (attempt !== 2 || provider !== "gemini" || model == null ||
        candidateHash == null || row.candidate == null ||
        row.primary_rejection == null)) ||
    (stage === "completion" && row.completion_payload == null) ||
    (!["primary_critique", "repair_critique"].includes(String(stage)) &&
      (deepSeekCriticEvidence !== null || geminiCriticEvidence !== null))
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
  return {
    jobId: lease.jobId,
    assignmentId: row.assignment_id,
    entityVersion: lease.entityVersion,
    stage: stage as WorksheetCheckpointStage,
    candidateAttempt: attempt,
    candidateProvider: provider,
    candidateModel: model,
    candidateSha256: candidateHash,
    candidate: row.candidate ?? null,
    primaryFailureCode: fallbackFailureCode,
    primaryRejection: row.primary_rejection ?? null,
    completionPayload: row.completion_payload ?? null,
    criticEvidence: {
      deepseek: deepSeekCriticEvidence,
      gemini: geminiCriticEvidence,
    },
  };
}

export async function saveWorksheetGenerationCandidate(
  args: ActiveLease & {
    candidateAttempt: 1 | 2;
    candidateSha256: string;
    candidate: GeneratedWorksheetCompletion;
  },
) {
  if (!hashPattern.test(args.candidateSha256)) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_candidate_hash_invalid",
      false,
    );
  }
  let response;
  try {
    response = await checkpointRpc(
      args.admin,
      "save_worksheet_generation_candidate",
      {
        ...rpcArgs(args),
        target_candidate_attempt: args.candidateAttempt,
        target_candidate_sha256: args.candidateSha256,
        candidate_payload: args.candidate,
      },
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) throw checkpointFailure();
  const row = singleWorkerRpcRow(response.data);
  const expectedStage = args.candidateAttempt === 1
    ? "primary_critique"
    : "repair_critique";
  if (
    !row || row.stage !== expectedStage ||
    safeAttempt(row.candidate_attempt) !== args.candidateAttempt ||
    row.candidate_sha256 !== args.candidateSha256 ||
    typeof row.created !== "boolean"
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
}

export async function saveWorksheetGenerationCompletion(
  args: ActiveLease & {
    completion: GeneratedWorksheetCompletion;
  },
) {
  let response;
  try {
    response = await checkpointRpc(
      args.admin,
      "save_worksheet_generation_completion",
      { ...rpcArgs(args), target_completion_payload: args.completion },
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) throw checkpointFailure();
  const row = singleWorkerRpcRow(response.data);
  if (!row || row.stage !== "completion" || typeof row.replayed !== "boolean") {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
}

export async function saveWorksheetGenerationCriticEvidence(
  args: ActiveLease & {
    candidateAttempt: 1 | 2;
    candidateSha256: string;
    evidence: WorksheetCriticEvidence;
    usage: WorksheetProviderUsage;
  },
) {
  const hasCached = args.usage.cached_input_tokens != null;
  const hasUncached = args.usage.uncached_input_tokens != null;
  const expectedCallKey =
    `worksheet_generation:job_${args.jobId}:candidate_${args.candidateAttempt}:${args.evidence.provider}:critique`;
  if (
    (args.candidateAttempt !== 1 && args.candidateAttempt !== 2) ||
    !hashPattern.test(args.candidateSha256) ||
    args.evidence.candidate_sha256 !== args.candidateSha256 ||
    !hashPattern.test(args.evidence.verdict_sha256) ||
    args.usage.provider !== args.evidence.provider ||
    args.usage.requested_model !== args.evidence.model ||
    args.usage.provider_model_version !== args.evidence.model ||
    args.usage.call_purpose !== "worksheet_critique" ||
    !callKeyPattern.test(args.usage.call_key) ||
    (args.usage.call_key !== expectedCallKey &&
      args.usage.call_key !== `${expectedCallKey}_retry`) ||
    !Number.isSafeInteger(args.usage.input_tokens) ||
    args.usage.input_tokens < 1 ||
    !Number.isSafeInteger(args.usage.output_tokens) ||
    args.usage.output_tokens < 1 ||
    hasCached !== hasUncached ||
    (hasCached &&
      (!Number.isSafeInteger(args.usage.cached_input_tokens) ||
        !Number.isSafeInteger(args.usage.uncached_input_tokens) ||
        (args.usage.cached_input_tokens as number) < 0 ||
        (args.usage.uncached_input_tokens as number) < 0 ||
        (args.usage.cached_input_tokens as number) +
              (args.usage.uncached_input_tokens as number) !==
          args.usage.input_tokens))
  ) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_critic_usage_invalid",
      false,
    );
  }
  let response;
  try {
    response = await checkpointRpc(
      args.admin,
      "save_worksheet_generation_critic_evidence",
      {
        ...rpcArgs(args),
        target_candidate_attempt: args.candidateAttempt,
        target_candidate_sha256: args.candidateSha256,
        critic_provider: args.evidence.provider,
        critic_model: args.evidence.model,
        target_verdict_sha256: args.evidence.verdict_sha256,
        verdict_payload: args.evidence,
        target_call_key: args.usage.call_key,
        target_provider_model_version: args.usage.provider_model_version,
        target_billed_input_tokens: args.usage.input_tokens,
        target_billed_output_tokens: args.usage.output_tokens,
        target_billed_cached_input_tokens: args.usage.cached_input_tokens ??
          null,
        target_billed_uncached_input_tokens: args.usage.uncached_input_tokens ??
          null,
      },
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) {
    if (
      response.error.code === "55000" || response.error.code === "22023" ||
      response.error.code === "02000"
    ) {
      throw new WorksheetGenerationError(
        "worksheet_checkpoint_critic_evidence_mismatch",
        false,
      );
    }
    throw checkpointFailure();
  }
  const row = singleWorkerRpcRow(response.data);
  if (
    !row || row.provider !== args.evidence.provider ||
    row.candidate_sha256 !== args.candidateSha256 ||
    row.verdict_sha256 !== args.evidence.verdict_sha256 ||
    typeof row.replayed !== "boolean"
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
}

export class WorksheetRepairContinuation extends Error {
  readonly rejectedCandidate: WorksheetRejectedCandidate;

  constructor(rejectedCandidate: WorksheetRejectedCandidate) {
    super("Worksheet repair must continue in a fresh durable stage.");
    this.name = "WorksheetRepairContinuation";
    this.rejectedCandidate = rejectedCandidate;
  }
}

export class WorksheetPrimaryFallbackContinuation extends Error {
  readonly safeCode: PrimaryWorksheetFallbackCode;

  constructor(safeCode: PrimaryWorksheetFallbackCode) {
    super("Worksheet primary fallback must continue in a fresh durable stage.");
    this.name = "WorksheetPrimaryFallbackContinuation";
    this.safeCode = safeCode;
  }
}

export async function advanceWorksheetGenerationFallback(
  args: ActiveLease & { primaryFailureCode: PrimaryWorksheetFallbackCode },
) {
  let response;
  try {
    response = await checkpointRpc(
      args.admin,
      "advance_worksheet_generation_fallback",
      {
        ...rpcArgs(args),
        primary_failure_code: args.primaryFailureCode,
      },
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) throw checkpointFailure();
  const row = singleWorkerRpcRow(response.data);
  if (
    !row || row.job_id !== args.jobId || row.status !== "retry" ||
    row.stage !== "primary_fallback_generation" ||
    typeof row.replayed !== "boolean" ||
    !Number.isSafeInteger(Number(row.attempt_count)) ||
    Number(row.attempt_count) < 1 ||
    typeof row.next_attempt_at !== "string" ||
    !Number.isFinite(Date.parse(row.next_attempt_at))
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
  return response.data;
}

export async function advanceWorksheetGenerationRepair(
  args: ActiveLease & {
    rejectedCandidate: WorksheetRejectedCandidate;
  },
) {
  let response;
  try {
    response = await checkpointRpc(
      args.admin,
      "advance_worksheet_generation_repair",
      {
        ...rpcArgs(args),
        // The database transition validates and archives the completed
        // worksheet candidate itself. The surrounding TypeScript rejection
        // envelope is reconstructed from immutable stage evidence when the
        // repair worker resumes; sending that envelope here violates the SQL
        // contract because it has no top-level worksheet validation object.
        rejected_candidate_payload: args.rejectedCandidate.candidate,
      },
    );
  } catch {
    throw checkpointFailure();
  }
  if (response.error) throw checkpointFailure();
  const row = singleWorkerRpcRow(response.data);
  if (
    !row || row.job_id !== args.jobId || row.status !== "retry" ||
    row.stage !== "repair_generation" || typeof row.replayed !== "boolean" ||
    !Number.isSafeInteger(Number(row.attempt_count)) ||
    Number(row.attempt_count) < 1 ||
    typeof row.next_attempt_at !== "string" ||
    !Number.isFinite(Date.parse(row.next_attempt_at))
  ) {
    throw checkpointFailure("worksheet_checkpoint_response_invalid");
  }
  return response.data;
}
