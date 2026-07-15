import type { SupabaseAdminClient } from "../_shared/writing-feedback.ts";
import { callWorkerApiRpc, singleWorkerRpcRow } from "../_shared/worker-api.ts";
import {
  certifiedBankWorksheetPayload,
  type GeneratedWorksheetCompletion,
  reusableWorksheetPayload,
  validatePersistedGeneratedWorksheetCandidate,
  WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS,
  type WorksheetBankFallbackReason,
  type WorksheetCompletionPayload,
  type WorksheetDifficulty,
  WorksheetGenerationError,
  type WorksheetLevel,
  type WorksheetProviderLifecycleHooks,
  type WorksheetRejectedCandidate,
  type WorksheetTopic,
} from "../_shared/worksheet-generation.ts";
import {
  buildWorksheetRepairSalvagePlan,
  generatePrimaryFallbackWorksheetCandidate,
  generatePrimaryWorksheetCandidate,
  generateRepairWorksheetCandidate,
  isPrimaryGeneratorFallbackEligible,
  validateWorksheetCandidateWithDualCritics,
  worksheetCandidateSha256,
} from "../_shared/worksheet-validation.ts";
import {
  type ChatCompletionProvider,
  DEEPSEEK_V1_FLASH_MODEL,
  type GeminiSecondaryProvider,
} from "../_shared/chat-completion-provider.ts";
import {
  loadWorksheetGenerationCheckpoint,
  saveWorksheetGenerationCandidate,
  saveWorksheetGenerationCompletion,
  saveWorksheetGenerationCriticEvidence,
  type WorksheetGenerationCheckpoint,
  WorksheetPrimaryFallbackContinuation,
  WorksheetRepairContinuation,
} from "./checkpoint.ts";

type WorksheetCheckpointStore = Readonly<{
  load: typeof loadWorksheetGenerationCheckpoint;
  saveCandidate: typeof saveWorksheetGenerationCandidate;
  saveCriticEvidence: typeof saveWorksheetGenerationCriticEvidence;
  saveCompletion: typeof saveWorksheetGenerationCompletion;
}>;

const durableCheckpointStore: WorksheetCheckpointStore = {
  load: loadWorksheetGenerationCheckpoint,
  saveCandidate: saveWorksheetGenerationCandidate,
  saveCriticEvidence: saveWorksheetGenerationCriticEvidence,
  saveCompletion: saveWorksheetGenerationCompletion,
};

type AssignmentContext = {
  id: string;
  workspace_id: string;
  grammar_topic_id: string;
  practice_test_id: string | null;
  status: string;
};

type TopicRow = WorksheetTopic & { id: string; level: string };

type WorksheetGenerationContextRow = {
  assignment_id: string;
  workspace_id: string;
  grammar_topic_id: string;
  attached_practice_test_id: string | null;
  assignment_status: string;
  batch_id: string | null;
  batch_name: string | null;
  worksheet_level: string | null;
  topic_name: string;
  topic_slug: string;
  topic_level: string;
  topic_description: string | null;
  reusable_practice_test_id: string | null;
  certified_template_revision_id: string | null;
};

function chooseDifficulty(level: WorksheetLevel): WorksheetDifficulty {
  return level === "A1" ? "easy" : "medium";
}

export function certifiedBankReasonForGenerationFailure(
  error: unknown,
): Extract<
  WorksheetBankFallbackReason,
  "provider_unavailable" | "provider_exhausted"
> {
  if (
    error instanceof WorksheetGenerationError &&
    error.retryable &&
    [
      "worksheet_provider_unavailable",
      "worksheet_provider_timeout",
      "worksheet_provider_deadline_exceeded",
      "worksheet_fallback_unavailable",
      "worksheet_fallback_timeout",
      "worksheet_critic_unavailable",
      "worksheet_critic_timeout",
      "worksheet_fallback_critic_unavailable",
      "worksheet_fallback_critic_timeout",
      "worksheet_dual_critics_unavailable",
      "worksheet_dual_critics_timeout",
    ].includes(error.safeCode)
  ) {
    return "provider_unavailable";
  }
  return "provider_exhausted";
}

export function resolveWorksheetLevel(assignmentLevel: string): WorksheetLevel {
  const normalizedAssignmentLevel = assignmentLevel.toUpperCase();
  if (["A1", "A2", "B1", "B2"].includes(normalizedAssignmentLevel)) {
    return normalizedAssignmentLevel as WorksheetLevel;
  }
  throw new WorksheetGenerationError("worksheet_class_context_required", false);
}

function normalizeGenerationContext(
  value: unknown,
): WorksheetGenerationContextRow | null {
  const row = singleWorkerRpcRow(value);
  if (!row) return null;
  const certifiedTemplateRevisionId = row.certified_template_revision_id ??
    null;
  if (
    typeof row.assignment_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.grammar_topic_id !== "string" ||
    (row.attached_practice_test_id !== null &&
      typeof row.attached_practice_test_id !== "string") ||
    typeof row.assignment_status !== "string" ||
    (row.batch_id !== null && typeof row.batch_id !== "string") ||
    (row.batch_name !== null && typeof row.batch_name !== "string") ||
    (row.worksheet_level !== null && typeof row.worksheet_level !== "string") ||
    typeof row.topic_name !== "string" ||
    typeof row.topic_slug !== "string" ||
    typeof row.topic_level !== "string" ||
    (row.topic_description !== null &&
      typeof row.topic_description !== "string") ||
    (row.reusable_practice_test_id !== null &&
      typeof row.reusable_practice_test_id !== "string") ||
    (certifiedTemplateRevisionId !== null &&
      typeof certifiedTemplateRevisionId !== "string")
  ) {
    return null;
  }
  return {
    ...row,
    certified_template_revision_id: certifiedTemplateRevisionId,
  } as unknown as WorksheetGenerationContextRow;
}

async function loadGenerationContext(
  admin: SupabaseAdminClient,
  assignmentId: string,
) {
  const result = await callWorkerApiRpc(
    admin,
    "get_worksheet_generation_context",
    { target_assignment_id: assignmentId },
  );
  return result.error ? null : normalizeGenerationContext(result.data);
}

async function refreshedCertifiedRevision(args: {
  admin: SupabaseAdminClient;
  assignmentId: string;
  original: WorksheetGenerationContextRow;
}) {
  const refreshed = await loadGenerationContext(args.admin, args.assignmentId);
  if (
    !refreshed ||
    refreshed.assignment_id !== args.original.assignment_id ||
    refreshed.workspace_id !== args.original.workspace_id ||
    refreshed.grammar_topic_id !== args.original.grammar_topic_id ||
    refreshed.batch_id !== args.original.batch_id ||
    refreshed.worksheet_level !== args.original.worksheet_level ||
    refreshed.attached_practice_test_id !== null ||
    !["unlocked", "in_progress"].includes(refreshed.assignment_status)
  ) {
    return null;
  }
  return refreshed.certified_template_revision_id;
}

function checkpointRejectedCandidate(
  value: unknown,
): WorksheetRejectedCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.attempt_number !== 1 ||
    (row.provider !== "deepseek" && row.provider !== "gemini") ||
    typeof row.model !== "string" ||
    !/^[a-z0-9._:/-]{1,100}$/i.test(row.model) ||
    !Array.isArray(row.rejection_reasons) ||
    row.rejection_reasons.length < 1 || row.rejection_reasons.length > 8 ||
    row.rejection_reasons.some((reason) =>
      typeof reason !== "string" || !reason.trim() || reason.length > 240
    ) ||
    !row.candidate || typeof row.candidate !== "object" ||
    Array.isArray(row.candidate)
  ) return null;
  const candidate = row.candidate as Record<string, unknown>;
  const validation = candidate.validation;
  if (
    candidate.generation_source !== row.provider ||
    candidate.generator_model !== row.model ||
    !validation || typeof validation !== "object" ||
    Array.isArray(validation) ||
    (validation as Record<string, unknown>).independent_model !== false
  ) return null;
  return value as WorksheetRejectedCandidate;
}

function checkpointCompletionPayload(
  checkpoint: WorksheetGenerationCheckpoint,
): GeneratedWorksheetCompletion {
  const value = checkpoint.completionPayload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_completion_invalid",
      false,
    );
  }
  const completion = value as Record<string, unknown>;
  const validation = completion.validation;
  if (
    completion.schema_version !== 1 || completion.mode !== "generated" ||
    (completion.generation_source !== "deepseek" &&
      completion.generation_source !== "gemini") ||
    !validation || typeof validation !== "object" ||
    Array.isArray(validation) ||
    (validation as Record<string, unknown>).deterministic !== true ||
    ![1, 2].includes(
      Number((validation as Record<string, unknown>).attempt_count),
    ) ||
    !(validation as Record<string, unknown>).critics ||
    typeof (validation as Record<string, unknown>).critics !== "object"
  ) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_completion_invalid",
      false,
    );
  }
  return value as GeneratedWorksheetCompletion;
}

async function checkpointCandidate(args: {
  checkpoint: WorksheetGenerationCheckpoint;
  level: WorksheetLevel;
  difficulty: WorksheetDifficulty;
  topicSlug: string;
}) {
  const candidate = validatePersistedGeneratedWorksheetCandidate({
    value: args.checkpoint.candidate,
    level: args.level,
    difficulty: args.difficulty,
    topicSlug: args.topicSlug,
    candidateAttempt: args.checkpoint.candidateAttempt ?? undefined,
  });
  const candidateSha256 = await worksheetCandidateSha256(candidate);
  if (
    candidateSha256 !== args.checkpoint.candidateSha256 ||
    candidate.generation_source !== args.checkpoint.candidateProvider ||
    candidate.generator_model !== args.checkpoint.candidateModel
  ) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_candidate_mismatch",
      false,
    );
  }
  return candidate;
}

/**
 * Loads only opaque context IDs plus curriculum metadata. It deliberately does
 * not read profiles, email, names, submissions, feedback lines, or student text.
 */
export async function prepareWorksheetCompletion(args: {
  admin: SupabaseAdminClient;
  assignmentId: string;
  jobId: string;
  queueMessageId: number | string;
  workerId: string;
  entityVersion: number;
  apiKey: string | null;
  model: string;
  criticModel?: string;
  fetchImpl?: typeof fetch;
  criticFetchImpl?: typeof fetch;
  provider?: ChatCompletionProvider;
  secondaryProvider?: GeminiSecondaryProvider | null;
  providerLifecycleHooks?: WorksheetProviderLifecycleHooks;
  providerCallKeyPrefix?: string;
  checkpointStore?: WorksheetCheckpointStore;
}): Promise<WorksheetCompletionPayload> {
  const context = await loadGenerationContext(args.admin, args.assignmentId);
  if (!context) {
    throw new WorksheetGenerationError(
      "worksheet_assignment_unavailable",
      true,
    );
  }
  if (!context.batch_id || !context.batch_name || !context.worksheet_level) {
    throw new WorksheetGenerationError(
      "worksheet_class_context_required",
      false,
    );
  }
  const assignment: AssignmentContext = {
    id: context.assignment_id,
    workspace_id: context.workspace_id,
    grammar_topic_id: context.grammar_topic_id,
    practice_test_id: context.attached_practice_test_id,
    status: context.assignment_status,
  };
  if (!["unlocked", "in_progress"].includes(assignment.status)) {
    throw new WorksheetGenerationError("worksheet_assignment_inactive", false);
  }

  const topic: TopicRow = {
    id: assignment.grammar_topic_id,
    name: context.topic_name,
    slug: context.topic_slug,
    level: context.topic_level,
    description: context.topic_description ?? "",
  };
  const level = resolveWorksheetLevel(context.worksheet_level);
  const reusableId = context.reusable_practice_test_id;
  if (assignment.practice_test_id) {
    if (!reusableId) {
      throw new WorksheetGenerationError(
        "worksheet_attached_not_approved",
        false,
      );
    }
    return reusableWorksheetPayload(reusableId);
  }
  if (context.certified_template_revision_id) {
    return certifiedBankWorksheetPayload({
      templateRevisionId: context.certified_template_revision_id,
      fallbackReason: "approved_bank_preferred",
    });
  }
  if (reusableId) return reusableWorksheetPayload(reusableId);
  const lease = {
    admin: args.admin,
    jobId: args.jobId,
    queueMessageId: args.queueMessageId,
    workerId: args.workerId,
    entityVersion: args.entityVersion,
  };
  const checkpointStore = args.checkpointStore ?? durableCheckpointStore;
  const checkpoint = await checkpointStore.load(lease);
  const primaryRejection = checkpointRejectedCandidate(
    checkpoint?.primaryRejection,
  );
  if (checkpoint?.primaryRejection != null && !primaryRejection) {
    throw new WorksheetGenerationError(
      "worksheet_checkpoint_rejection_invalid",
      false,
    );
  }
  const checkpointRejections: WorksheetRejectedCandidate[] = primaryRejection
    ? [primaryRejection]
    : [];
  if (checkpoint?.stage === "completion") {
    const completion = checkpointCompletionPayload(checkpoint);
    if (!completion.validation.independent_model) {
      checkpointRejections.push({
        attempt_number: completion.validation.attempt_count,
        provider: completion.generation_source,
        model: completion.generator_model,
        rejection_reasons: completion.validation.rejection_reasons,
        candidate: completion,
      });
      // A certified revision can be published after the rejected completion
      // was durably checkpointed but before this lease resumes. Refresh the
      // exact assignment context before replaying that private rejection so a
      // crash in this narrow window cannot hide newly available material.
      const refreshedRevision = await refreshedCertifiedRevision({
        admin: args.admin,
        assignmentId: args.assignmentId,
        original: context,
      });
      if (refreshedRevision) {
        return certifiedBankWorksheetPayload({
          templateRevisionId: refreshedRevision,
          fallbackReason: "candidates_rejected",
          rejectedCandidates: checkpointRejections,
        });
      }
    }
    return completion;
  }

  const worksheetTopic: WorksheetTopic = {
    name: topic.name,
    slug: topic.slug,
    description: topic.description,
  };
  const difficulty = chooseDifficulty(level);
  const criticModel = args.criticModel ?? DEEPSEEK_V1_FLASH_MODEL;
  let candidate: GeneratedWorksheetCompletion;
  let candidateAttempt: 1 | 2;
  const stageDeadlineAt = Date.now() + WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS;
  try {
    if (!checkpoint) {
      candidateAttempt = 1;
      candidate = await generatePrimaryWorksheetCandidate({
        apiKey: args.apiKey,
        generatorModel: args.model,
        topic: worksheetTopic,
        level,
        difficulty,
        generateFetchImpl: args.fetchImpl,
        provider: args.provider,
        secondaryProvider: args.secondaryProvider,
        providerLifecycleHooks: args.providerLifecycleHooks,
        providerCallKeyPrefix: args.providerCallKeyPrefix,
        deadlineAt: stageDeadlineAt,
      });
      const candidateSha256 = await worksheetCandidateSha256(candidate);
      await checkpointStore.saveCandidate({
        ...lease,
        candidateAttempt,
        candidateSha256,
        candidate,
      });
    } else if (checkpoint.stage === "primary_fallback_generation") {
      if (!checkpoint.primaryFailureCode) {
        throw new WorksheetGenerationError(
          "worksheet_checkpoint_fallback_reason_invalid",
          false,
        );
      }
      candidateAttempt = 1;
      candidate = await generatePrimaryFallbackWorksheetCandidate({
        secondaryProvider: args.secondaryProvider,
        topic: worksheetTopic,
        level,
        difficulty,
        primaryFailureCode: checkpoint.primaryFailureCode,
        providerLifecycleHooks: args.providerLifecycleHooks,
        providerCallKeyPrefix: args.providerCallKeyPrefix,
        deadlineAt: stageDeadlineAt,
      });
      const candidateSha256 = await worksheetCandidateSha256(candidate);
      await checkpointStore.saveCandidate({
        ...lease,
        candidateAttempt,
        candidateSha256,
        candidate,
      });
    } else if (checkpoint.stage === "repair_generation") {
      if (!primaryRejection) {
        throw new WorksheetGenerationError(
          "worksheet_checkpoint_rejection_invalid",
          false,
        );
      }
      candidateAttempt = 2;
      const repairCandidate = await generateRepairWorksheetCandidate({
        secondaryProvider: args.secondaryProvider,
        topic: worksheetTopic,
        level,
        difficulty,
        revisionFeedback: primaryRejection.rejection_reasons,
        providerLifecycleHooks: args.providerLifecycleHooks,
        providerCallKeyPrefix: args.providerCallKeyPrefix,
        deadlineAt: stageDeadlineAt,
        repairSalvagePlan: buildWorksheetRepairSalvagePlan(primaryRejection) ??
          undefined,
      });
      // The deterministic generator contract starts every standalone
      // candidate at attempt one. A durable repair is candidate slot two, and
      // the private checkpoint independently enforces that binding before it
      // persists any provider content.
      candidate = {
        ...repairCandidate,
        validation: {
          ...repairCandidate.validation,
          attempt_count: 2,
        },
      };
      const candidateSha256 = await worksheetCandidateSha256(candidate);
      await checkpointStore.saveCandidate({
        ...lease,
        candidateAttempt,
        candidateSha256,
        candidate,
      });
    } else {
      candidateAttempt = checkpoint.candidateAttempt as 1 | 2;
      candidate = await checkpointCandidate({
        checkpoint,
        level,
        difficulty,
        topicSlug: worksheetTopic.slug,
      });
    }

    const completed = await validateWorksheetCandidateWithDualCritics({
      apiKey: args.apiKey,
      criticModel,
      topic: worksheetTopic,
      level,
      difficulty,
      candidate,
      candidateAttempt,
      criticFetchImpl: args.criticFetchImpl ?? args.fetchImpl,
      provider: args.provider,
      secondaryProvider: args.secondaryProvider,
      providerLifecycleHooks: args.providerLifecycleHooks,
      providerCallKeyPrefix: args.providerCallKeyPrefix,
      deadlineAt: stageDeadlineAt,
      persistedCritics: checkpoint?.criticEvidence,
      onCriticEvidence: async (evidence, usage) => {
        await checkpointStore.saveCriticEvidence({
          ...lease,
          candidateAttempt,
          candidateSha256: evidence.candidate_sha256,
          evidence,
          usage,
        });
      },
    });
    if (!completed.validation.independent_model && candidateAttempt === 1) {
      throw new WorksheetRepairContinuation({
        attempt_number: 1,
        provider: completed.generation_source,
        model: completed.generator_model,
        rejection_reasons: completed.validation.rejection_reasons,
        candidate: completed,
      });
    }
    await checkpointStore.saveCompletion({
      ...lease,
      completion: completed,
    });

    if (!completed.validation.independent_model) {
      const refreshedRevision = await refreshedCertifiedRevision({
        admin: args.admin,
        assignmentId: args.assignmentId,
        original: context,
      });
      if (refreshedRevision) {
        return certifiedBankWorksheetPayload({
          templateRevisionId: refreshedRevision,
          fallbackReason: "candidates_rejected",
          rejectedCandidates: [
            ...checkpointRejections,
            {
              attempt_number: completed.validation.attempt_count,
              provider: completed.generation_source,
              model: completed.generator_model,
              rejection_reasons: completed.validation.rejection_reasons,
              candidate: completed,
            },
          ],
        });
      }
    }
    return completed;
  } catch (error) {
    if (error instanceof WorksheetRepairContinuation) throw error;
    const refreshedRevision = await refreshedCertifiedRevision({
      admin: args.admin,
      assignmentId: args.assignmentId,
      original: context,
    });
    if (refreshedRevision) {
      return certifiedBankWorksheetPayload({
        templateRevisionId: refreshedRevision,
        fallbackReason: certifiedBankReasonForGenerationFailure(error),
        ...(checkpointRejections.length > 0
          ? { rejectedCandidates: checkpointRejections }
          : {}),
      });
    }
    if (!checkpoint && isPrimaryGeneratorFallbackEligible(error)) {
      throw new WorksheetPrimaryFallbackContinuation(error.safeCode);
    }
    throw error;
  }
}
