import {
  createWorksheetGenerationProcessorHandler,
  processOneWorksheetGenerationJob,
  WORKSHEET_GENERATION_BATCH_SIZE,
  WORKSHEET_GENERATION_LEASE_OVERHEAD_MS,
  WORKSHEET_GENERATION_QUEUE,
  WORKSHEET_GENERATION_VISIBILITY_SECONDS,
  type WorksheetWorkerClient,
  type WorksheetWorkerEvent,
} from "./processor.ts";
import {
  type GeneratedWorksheetCompletion,
  WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS,
  type WorksheetCompletionPayload,
  WorksheetGenerationError,
  type WorksheetProviderLifecycleHooks,
} from "../_shared/worksheet-generation.ts";
import {
  WorksheetPrimaryFallbackContinuation,
  WorksheetRepairContinuation,
} from "./checkpoint.ts";
import {
  retryScheduleFromWorksheetStageContinuation,
  retryWakeupDelayMs,
} from "../_shared/retry-wakeup.ts";

Deno.test(
  "worksheet generation lease covers both provider passes with bounded recovery",
  () => {
    const leaseMs = WORKSHEET_GENERATION_VISIBILITY_SECONDS * 1_000;
    const requiredMs =
      WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS +
      WORKSHEET_GENERATION_LEASE_OVERHEAD_MS;
    if (leaseMs < requiredMs || leaseMs >= requiredMs + 1_000) {
      throw new Error(
        "Worksheet generation visibility must derive from the bounded provider deadline plus persistence overhead.",
      );
    }
  },
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const noOpGenerationLifecycleHooks: WorksheetProviderLifecycleHooks = {
  onBeforeProviderCall: async () => undefined,
  onProviderUsage: async () => undefined,
  onProviderNotCalled: async () => undefined,
};
const requiredGenerationAccounting = {
  createProviderLifecycleHooks: () => noOpGenerationLifecycleHooks,
};

const jobId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const reusableId = "44444444-4444-4444-8444-444444444444";
const rescuedPracticeTestId = "55555555-5555-4555-8555-555555555555";
const cachedPracticeTestId = "66666666-6666-4666-8666-666666666666";
const modernServiceSecret = `sb_secret_${"s".repeat(32)}`;
const claim = {
  job_id: jobId,
  queue_message_id: "42",
  entity_id: assignmentId,
  entity_version: 4,
  attempt_number: 1,
  lease_expires_at: "2026-07-10T12:00:00.000Z",
};
const retryTransition = {
  job_id: jobId,
  status: "retry",
  attempt_count: 1,
  next_attempt_at: "2026-07-10T12:00:05.000Z",
};
const certifiedBankMiss = {
  schema_version: 1,
  rescued: false,
  assignment_id: assignmentId,
  practice_test_id: null,
};
const modelCacheMiss = {
  schema_version: 1,
  rescued: false,
  assignment_id: assignmentId,
  practice_test_id: null,
};
const reuse: WorksheetCompletionPayload = {
  schema_version: 1,
  mode: "reuse",
  reusable_practice_test_id: reusableId,
};
const generated: GeneratedWorksheetCompletion = {
  schema_version: 1,
  mode: "generated",
  generation_source: "deepseek",
  generator_model: "deepseek-v4-pro",
  title: "Dativ sicher anwenden",
  level: "A2",
  difficulty: "medium",
  description: "Practice the dative.",
  mini_lesson: {
    short_explanation: "Practice the dative.",
    key_rule: "Use dem with masculine and neuter nouns.",
    correct_examples: ["Ich helfe dem Mann."],
    common_mistake_warning: "Do not use den here.",
    what_to_revise: "Review dative articles.",
  },
  questions: [
    {
      question_number: 1,
      question_type: "multiple_choice",
      evaluation_mode: "local_exact",
      prompt: "Choose the article: Ich sehe ___ Mann.",
      options: ["der", "den", "dem"],
      correct_answer: "den",
      accepted_answers: ["den"],
      rubric: null,
      explanation: "The direct object uses den.",
    },
    {
      question_number: 2,
      question_type: "multiple_choice",
      evaluation_mode: "local_exact",
      prompt: "Choose the article: Ich helfe ___ Mann.",
      options: ["der", "den", "dem"],
      correct_answer: "dem",
      accepted_answers: ["dem"],
      rubric: null,
      explanation: "Helfen takes the dative.",
    },
    ...[3, 4, 5, 6].map((number) => ({
      question_number: number,
      question_type: "fill_blank" as const,
      evaluation_mode: "local_exact" as const,
      prompt: `Wortbank: [den, dem, der]. Ergänze: Satz ${number} hat ___ Mann.`,
      options: [],
      correct_answer: "den",
      accepted_answers: ["den"],
      rubric: null,
      explanation: "Use the required article form.",
    })),
    {
      question_number: 7,
      question_type: "sentence_correction",
      evaluation_mode: "open_evaluation",
      prompt: "Correct the full sentence: Ich helfe den Mann.",
      options: [],
      correct_answer: "Ich helfe dem Mann.",
      accepted_answers: [],
      rubric: {
        criteria: ["Use helfen with a grammatically correct dative object."],
        sample_answer: "Ich helfe dem Mann.",
      },
      explanation: "Helfen requires the dative.",
    },
    {
      question_number: 8,
      question_type: "transformation",
      evaluation_mode: "open_evaluation",
      prompt: "Rewrite the sentence with the receiver first.",
      options: [],
      correct_answer: "Dem Mann gebe ich das Buch.",
      accepted_answers: [],
      rubric: {
        criteria: ["Keep the receiver in the dative and preserve the meaning."],
        sample_answer: "Dem Mann gebe ich das Buch.",
      },
      explanation: "The receiver remains in the dative.",
    },
    {
      question_number: 9,
      question_type: "word_order",
      evaluation_mode: "open_evaluation",
      prompt: "Build the sentence: dem Mann - ich - helfe - heute",
      options: [],
      correct_answer: "Ich helfe dem Mann heute.",
      accepted_answers: [],
      rubric: {
        criteria: [
          "Use a valid German clause with the conjugated verb in position two.",
        ],
        sample_answer: "Ich helfe dem Mann heute.",
      },
      explanation: "The conjugated verb is in position two.",
    },
  ],
  source_mix: { mode: "deepseek", deepseek_count: 9, gemini_count: 0 },
  validation: {
    deterministic: true,
    independent_model: false,
    critic_model: "deepseek-v4-flash",
    candidate_sha256: "a".repeat(64),
    critics: {
      deepseek: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        candidate_sha256: "a".repeat(64),
        approved: false,
        checks: {
          ambiguity_free: false,
          no_answer_leakage: true,
          duplicate_free: true,
          level_fit: true,
          topic_fit: true,
          type_balance: true,
          scoring_safe: true,
        },
        content_checks: {
          mini_lesson_scope_accurate: true,
          learner_cues_semantically_aligned: true,
          examples_rubrics_consistent: true,
        },
        rejection_reasons: ["One exact-scored question is ambiguous."],
        verdict_sha256: "b".repeat(64),
      },
      gemini: {
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
        candidate_sha256: "a".repeat(64),
        approved: true,
        checks: {
          ambiguity_free: true,
          no_answer_leakage: true,
          duplicate_free: true,
          level_fit: true,
          topic_fit: true,
          type_balance: true,
          scoring_safe: true,
        },
        content_checks: {
          mini_lesson_scope_accurate: true,
          learner_cues_semantically_aligned: true,
          examples_rubrics_consistent: true,
        },
        rejection_reasons: [],
        verdict_sha256: "c".repeat(64),
      },
    },
    attempt_count: 2,
    checks: {
      ambiguity_free: false,
      no_answer_leakage: true,
      duplicate_free: true,
      level_fit: true,
      topic_fit: true,
      type_balance: true,
      scoring_safe: true,
    },
    content_checks: {
      mini_lesson_scope_accurate: true,
      learner_cues_semantically_aligned: true,
      examples_rubrics_consistent: true,
    },
    rejection_reasons: ["One exact-scored question is ambiguous."],
  },
};

function admin(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: null | { message?: string } }>,
): WorksheetWorkerClient {
  return {
    schema: (schema: string) => {
      assertEquals(schema, "api");
      return {
        rpc: (name: string, args: Record<string, unknown>) => {
          const request = implementation(name, args);
          return Object.assign(request, {
            abortSignal: async (_signal: AbortSignal) => await request,
          });
        },
      };
    },
  };
}

Deno.test(
  "apikey-only modern service secret schedules the fixed generation queue claim",
  async () => {
    let task: Promise<unknown> | null = null;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      return { data: [], error: null };
    });
    const handler = createWorksheetGenerationProcessorHandler({
      ...requiredGenerationAccounting,
      createAdminClient: () => client,
      prepareWorksheet: async () => reuse,
      waitUntil: (promise) => {
        task = promise;
      },
      getServiceAuthSecret: () => modernServiceSecret,
      createRequestId: () => "request-1",
      createWorkerId: () => workerId,
      log: () => undefined,
    });
    const response = await handler(
      new Request("https://example.test/process", {
        method: "POST",
        headers: { apikey: modernServiceSecret },
        body: JSON.stringify({
          queue_name: "caller_queue",
          entity_id: "caller-entity",
          batch_size: 10,
        }),
      }),
    );
    assertEquals(response.status, 202);
    assert(task, "Background job was not scheduled.");
    await task;
    assertEquals(calls[0], {
      name: "claim_async_jobs",
      args: {
        target_queue_name: WORKSHEET_GENERATION_QUEUE,
        worker_id: workerId,
        batch_size: WORKSHEET_GENERATION_BATCH_SIZE,
        visibility_timeout_seconds: WORKSHEET_GENERATION_VISIBILITY_SECONDS,
      },
    });
  },
);

Deno.test(
  "approved reuse completes through the single transactional RPC",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "complete_worksheet_generation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-2",
      prepareWorksheet: async ({ assignmentId: claimedId }) => {
        assertEquals(claimedId, assignmentId);
        return reuse;
      },
      log: () => undefined,
    });
    assertEquals(result, {
      claimed: true,
      outcome: "completed",
      job_id: jobId,
    });
    assertEquals(calls[1], {
      name: "complete_worksheet_generation",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        worksheet: reuse,
      },
    });
  },
);

Deno.test(
  "claimed job context and lifecycle hooks reach worksheet preparation",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "complete_worksheet_generation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const hooks = {
      onBeforeProviderCall: async () => undefined,
      onProviderUsage: async () => undefined,
      onProviderNotCalled: async () => undefined,
    };
    const factoryContexts: Record<string, unknown>[] = [];
    const prepareContexts: Record<string, unknown>[] = [];

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-lifecycle-context",
      createProviderLifecycleHooks: (context) => {
        factoryContexts.push(context);
        return hooks;
      },
      prepareWorksheet: async (context) => {
        prepareContexts.push(context);
        return reuse;
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "completed");
    const factoryContext = factoryContexts[0];
    assert(factoryContext, "Expected lifecycle factory context.");
    assertEquals(factoryContext.jobId, jobId);
    assertEquals(factoryContext.entityVersion, 4);
    assertEquals(factoryContext.attemptNumber, 1);
    assert(
      factoryContext.admin === client,
      "Spend lifecycle factory must receive the claimed worker client.",
    );
    const prepareContext = prepareContexts[0];
    assert(prepareContext, "Expected worksheet preparation context.");
    assertEquals(prepareContext.jobId, jobId);
    assertEquals(prepareContext.queueMessageId, "42");
    assertEquals(prepareContext.workerId, workerId);
    assertEquals(prepareContext.entityVersion, 4);
    assertEquals(prepareContext.attemptNumber, 1);
    assertEquals(
      prepareContext.providerCallKeyPrefix,
      `worksheet_generation:job_${jobId}`,
    );
    assert(
      prepareContext.providerLifecycleHooks === hooks,
      "The exact paired lifecycle hooks must reach every provider call.",
    );
  },
);

Deno.test(
  "lifecycle factory failure is content-free and prevents preparation",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let prepareCalls = 0;
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "fail_async_job") {
        return { data: { status: "dead" }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-lifecycle-failure",
      createProviderLifecycleHooks: () => {
        throw { safeCode: "private_budget_code", retryable: false };
      },
      prepareWorksheet: async () => {
        prepareCalls += 1;
        return reuse;
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "failed");
    assertEquals(prepareCalls, 0);
    assertEquals(calls[2], {
      name: "try_complete_current_model_cache_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "provider_exhausted",
        rejected_candidates: [],
      },
    });
    assertEquals(calls[3], {
      name: "fail_async_job",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        error_code: "worksheet_spend_accounting_failed",
        retryable: false,
      },
    });
  },
);

Deno.test(
  "validated generated worksheet uses the same completion RPC",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "complete_worksheet_generation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-3",
      prepareWorksheet: async () => generated,
      log: () => undefined,
    });
    assertEquals(result.outcome, "completed");
    assertEquals(calls[3]?.args.worksheet, generated);
    assert(
      !("assignment_id" in generated),
      "Completion content must not override the claimed assignment.",
    );
  },
);

Deno.test(
  "dual rejection attaches a newly current certified worksheet before quarantine",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return {
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: rescuedPracticeTestId,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-dual-rejection-bank-rescue",
      prepareWorksheet: async () => generated,
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "completed",
      job_id: jobId,
    });
    assertEquals(calls.length, 2);
    assertEquals(calls[1], {
      name: "try_complete_current_certified_worksheet_bank_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "candidates_rejected",
        rejected_candidates: [
          {
            attempt_number: 2,
            provider: generated.generation_source,
            model: generated.generator_model,
            rejection_reasons: generated.validation.rejection_reasons,
            candidate: generated,
          },
        ],
      },
    });
  },
);

Deno.test(
  "dual rejection attaches current model cache before quarantine when the certified bank misses",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return {
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: cachedPracticeTestId,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-dual-rejection-cache-rescue",
      prepareWorksheet: async () => generated,
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "completed",
      job_id: jobId,
    });
    assertEquals(calls, [
      {
        name: "claim_async_jobs",
        args: {
          target_queue_name: WORKSHEET_GENERATION_QUEUE,
          worker_id: workerId,
          batch_size: WORKSHEET_GENERATION_BATCH_SIZE,
          visibility_timeout_seconds: WORKSHEET_GENERATION_VISIBILITY_SECONDS,
        },
      },
      {
        name: "try_complete_current_certified_worksheet_bank_fallback",
        args: {
          target_job_id: jobId,
          target_queue_message_id: "42",
          target_worker_id: workerId,
          target_fallback_reason: "candidates_rejected",
          rejected_candidates: [
            {
              attempt_number: 2,
              provider: generated.generation_source,
              model: generated.generator_model,
              rejection_reasons: generated.validation.rejection_reasons,
              candidate: generated,
            },
          ],
        },
      },
      {
        name: "try_complete_current_model_cache_fallback",
        args: {
          target_job_id: jobId,
          target_queue_message_id: "42",
          target_worker_id: workerId,
          target_fallback_reason: "candidates_rejected",
          rejected_candidates: [
            {
              attempt_number: 2,
              provider: generated.generation_source,
              model: generated.generator_model,
              rejection_reasons: generated.validation.rejection_reasons,
              candidate: generated,
            },
          ],
        },
      },
    ]);
    assert(
      calls.every((call) => call.name !== "complete_worksheet_generation"),
      "A current validated cache hit must prevent rejected content from being quarantined as the student outcome.",
    );
  },
);

Deno.test(
  "provider retry exhaustion attaches current certified material before terminal failure",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return {
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: rescuedPracticeTestId,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-provider-exhaustion-bank-rescue",
      prepareWorksheet: async () => {
        throw new WorksheetGenerationError("worksheet_repair_exhausted", false);
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "completed");
    assertEquals(calls.length, 2);
    assertEquals(calls[1], {
      name: "try_complete_current_certified_worksheet_bank_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "provider_exhausted",
        rejected_candidates: [],
      },
    });
    assert(
      calls.every(
        (call) => call.name !== "try_complete_current_model_cache_fallback",
      ),
      "A certified-bank rescue must finish the job without consulting model cache.",
    );
  },
);

Deno.test(
  "model cache rescues provider exhaustion only after the certified bank misses",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return {
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: cachedPracticeTestId,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-provider-exhaustion-cache-rescue",
      prepareWorksheet: async () => {
        throw new WorksheetGenerationError("worksheet_repair_exhausted", false);
      },
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "completed",
      job_id: jobId,
    });
    assertEquals(calls, [
      {
        name: "claim_async_jobs",
        args: {
          target_queue_name: WORKSHEET_GENERATION_QUEUE,
          worker_id: workerId,
          batch_size: WORKSHEET_GENERATION_BATCH_SIZE,
          visibility_timeout_seconds: WORKSHEET_GENERATION_VISIBILITY_SECONDS,
        },
      },
      {
        name: "try_complete_current_certified_worksheet_bank_fallback",
        args: {
          target_job_id: jobId,
          target_queue_message_id: "42",
          target_worker_id: workerId,
          target_fallback_reason: "provider_exhausted",
          rejected_candidates: [],
        },
      },
      {
        name: "try_complete_current_model_cache_fallback",
        args: {
          target_job_id: jobId,
          target_queue_message_id: "42",
          target_worker_id: workerId,
          target_fallback_reason: "provider_exhausted",
          rejected_candidates: [],
        },
      },
    ]);
  },
);

Deno.test(
  "model cache rescue retains rejected-candidate evidence after bank rescue misses",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let cacheAttempts = 0;
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "complete_worksheet_generation") {
        return { data: null, error: { message: "invalid", code: "22023" } };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        cacheAttempts += 1;
        if (cacheAttempts === 1) {
          return { data: modelCacheMiss, error: null };
        }
        return {
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: cachedPracticeTestId,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-rejection-cache-rescue",
      prepareWorksheet: async () => generated,
      log: () => undefined,
    });

    assertEquals(result.outcome, "completed");
    assertEquals(calls.length, 6);
    assertEquals(calls[5], {
      name: "try_complete_current_model_cache_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "candidates_rejected",
        rejected_candidates: [
          {
            attempt_number: 2,
            provider: generated.generation_source,
            model: generated.generator_model,
            rejection_reasons: generated.validation.rejection_reasons,
            candidate: generated,
          },
        ],
      },
    });
  },
);

Deno.test(
  "model cache miss, malformed success, RPC error, and throw preserve durable failure",
  async () => {
    const variants: Array<{
      name: string;
      run: () => Promise<{
        data: unknown;
        error: null | { message?: string };
      }>;
    }> = [
      {
        name: "miss",
        run: async () => ({ data: modelCacheMiss, error: null }),
      },
      {
        name: "wrong assignment",
        run: async () => ({
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: "77777777-7777-4777-8777-777777777777",
            practice_test_id: cachedPracticeTestId,
          },
          error: null,
        }),
      },
      {
        name: "invalid practice test",
        run: async () => ({
          data: {
            schema_version: 1,
            rescued: true,
            assignment_id: assignmentId,
            practice_test_id: "not-a-uuid",
          },
          error: null,
        }),
      },
      {
        name: "RPC error",
        run: async () => ({
          data: null,
          error: { message: "private cache error" },
        }),
      },
      {
        name: "throw",
        run: async () => {
          throw new Error("private cache throw");
        },
      },
    ];

    for (const variant of variants) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const client = admin(async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_async_jobs") return { data: [claim], error: null };
        if (name === "try_complete_current_certified_worksheet_bank_fallback") {
          return { data: certifiedBankMiss, error: null };
        }
        if (name === "try_complete_current_model_cache_fallback") {
          return await variant.run();
        }
        if (name === "fail_async_job") {
          return { data: { status: "dead" }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      });

      const result = await processOneWorksheetGenerationJob({
        ...requiredGenerationAccounting,
        admin: client,
        workerId,
        requestId: `request-cache-${variant.name}`,
        prepareWorksheet: async () => {
          throw new WorksheetGenerationError(
            "worksheet_repair_exhausted",
            false,
          );
        },
        log: () => undefined,
      });

      assertEquals(result.outcome, "failed");
      assertEquals(
        calls.map((call) => call.name),
        [
          "claim_async_jobs",
          "try_complete_current_certified_worksheet_bank_fallback",
          "try_complete_current_model_cache_fallback",
          "fail_async_job",
        ],
      );
    }
  },
);

Deno.test(
  "worksheet worker logs never contain generated educational content",
  async () => {
    const events: WorksheetWorkerEvent[] = [];
    const client = admin(async (name) => {
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "complete_worksheet_generation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-content-safe-log",
      prepareWorksheet: async () => generated,
      log: (event) => events.push(event),
    });

    assertEquals(result.outcome, "completed");
    const serializedEvents = JSON.stringify(events);
    for (const sensitiveText of [
      generated.title,
      generated.questions[0].prompt,
      generated.questions[0].correct_answer,
    ]) {
      assert(
        !serializedEvents.includes(sensitiveText),
        "Worker logs must contain only safe operational metadata.",
      );
    }
  },
);

Deno.test(
  "retryable preparation failure transitions through fail_async_job",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "fail_async_job") {
        return { data: [retryTransition], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-4",
      prepareWorksheet: async () => {
        throw new WorksheetGenerationError(
          "worksheet_provider_unavailable",
          true,
        );
      },
      log: () => undefined,
    });
    assertEquals(result, {
      claimed: true,
      outcome: "retry_scheduled",
      job_id: jobId,
      retry_wakeup: {
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T12:00:05.000Z",
      },
    });
    assertEquals(calls[2], {
      name: "try_complete_current_model_cache_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "provider_exhausted",
        rejected_candidates: [],
      },
    });
    assertEquals(calls[3], {
      name: "fail_async_job",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        error_code: "worksheet_provider_unavailable",
        retryable: true,
      },
    });
  },
);

Deno.test(
  "primary timeout advances atomically to a fresh fallback stage",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "advance_worksheet_generation_fallback") {
        return {
          data: [
            {
              job_id: jobId,
              status: "retry",
              stage: "primary_fallback_generation",
              attempt_count: 1,
              next_attempt_at: "2026-07-10T12:00:00.000Z",
              replayed: false,
            },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-primary-fallback-continuation",
      prepareWorksheet: async () => {
        throw new WorksheetPrimaryFallbackContinuation(
          "worksheet_provider_timeout",
        );
      },
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "retry_scheduled",
      job_id: jobId,
      retry_wakeup: {
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T12:00:00.000Z",
        wakeupKind: "stage_continuation",
      },
    });
    assertEquals(calls.length, 2);
    assertEquals(calls[1], {
      name: "advance_worksheet_generation_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        expected_entity_version: 4,
        primary_failure_code: "worksheet_provider_timeout",
      },
    });
  },
);

Deno.test(
  "first semantic rejection advances atomically to the durable repair stage",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "advance_worksheet_generation_repair") {
        return {
          data: [
            {
              job_id: jobId,
              status: "retry",
              stage: "repair_generation",
              attempt_count: 1,
              next_attempt_at: "2026-07-10T12:00:00.000Z",
              replayed: false,
            },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const firstRejectedCandidate = {
      ...generated,
      validation: { ...generated.validation, attempt_count: 1 as const },
    };
    const rejectedCandidate = {
      attempt_number: 1 as const,
      provider: "deepseek" as const,
      model: "deepseek-v4-pro",
      rejection_reasons: firstRejectedCandidate.validation.rejection_reasons,
      candidate: firstRejectedCandidate,
    };

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-repair-continuation",
      prepareWorksheet: async () => {
        throw new WorksheetRepairContinuation(rejectedCandidate);
      },
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "retry_scheduled",
      job_id: jobId,
      retry_wakeup: {
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T12:00:00.000Z",
        wakeupKind: "stage_continuation",
      },
    });
    assertEquals(calls.length, 2);
    assertEquals(calls[1]?.name, "advance_worksheet_generation_repair");
    assertEquals(calls[1]?.args.target_job_id, jobId);
    assertEquals(calls[1]?.args.target_queue_message_id, "42");
    assertEquals(calls[1]?.args.worker_id, workerId);
    assertEquals(calls[1]?.args.expected_entity_version, 4);
    assertEquals(
      calls[1]?.args.rejected_candidate_payload,
      rejectedCandidate.candidate,
    );
  },
);

Deno.test(
  "an exact repair continuation at the ordinary cap is kicked immediately for its fifth claim",
  () => {
    const nextAttemptAt = "2026-07-10T12:00:00.000Z";
    const schedule = retryScheduleFromWorksheetStageContinuation(
      [
        {
          job_id: jobId,
          status: "retry",
          stage: "repair_generation",
          attempt_count: 4,
          next_attempt_at: nextAttemptAt,
          replayed: false,
        },
      ],
      jobId,
      "repair_generation",
    );
    assert(schedule, "The exact attempt-four repair continuation was dropped.");
    assertEquals(retryWakeupDelayMs(schedule, Date.parse(nextAttemptAt)), 250);
    assertEquals(
      retryWakeupDelayMs(
        { jobId, attemptCount: 4, nextAttemptAt },
        Date.parse(nextAttemptAt),
      ),
      null,
    );
  },
);

Deno.test(
  "dual-provider generation outage uses the bounded recovery lane",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "defer_async_job_for_provider_outage") {
        return {
          data: [
            {
              ...retryTransition,
              attempt_count: 0,
              next_attempt_at: "2026-07-10T12:01:00.000Z",
              outage_retry_count: 1,
            },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-dual-provider-outage",
      prepareWorksheet: async () => {
        throw new WorksheetGenerationError(
          "worksheet_fallback_timeout",
          true,
          true,
        );
      },
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "retry_scheduled",
      job_id: jobId,
    });
    assertEquals(calls[2], {
      name: "try_complete_current_model_cache_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "provider_unavailable",
        rejected_candidates: [],
      },
    });
    assertEquals(calls[3], {
      name: "defer_async_job_for_provider_outage",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        outage_reason: "dual_provider_outage_timeout",
      },
    });
  },
);

Deno.test(
  "generation retry keeps waitUntil alive through its authenticated wakeup",
  async () => {
    let background: Promise<unknown> | null = null;
    const wakeups: unknown[] = [];
    const client = admin(async (name) => {
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "fail_async_job") {
        return { data: [retryTransition], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const handler = createWorksheetGenerationProcessorHandler({
      ...requiredGenerationAccounting,
      createAdminClient: () => client,
      prepareWorksheet: async () => {
        throw new WorksheetGenerationError(
          "worksheet_provider_unavailable",
          true,
        );
      },
      waitUntil: (promise) => {
        background = promise;
      },
      wakeRetry: async (schedule) => {
        wakeups.push(schedule);
        return "invoked";
      },
      getServiceAuthSecret: () => "service-secret",
      createRequestId: () => "request-retry-wakeup",
      createWorkerId: () => workerId,
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/process", {
        method: "POST",
        headers: { Authorization: "Bearer service-secret" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 202);
    assert(background, "Generation retry was not registered with waitUntil.");
    await background;
    assertEquals(wakeups, [
      {
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T12:00:05.000Z",
      },
    ]);
  },
);

Deno.test(
  "permanent completion contract rejection is not retried",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = admin(async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_async_jobs") return { data: [claim], error: null };
      if (name === "try_complete_current_certified_worksheet_bank_fallback") {
        return { data: certifiedBankMiss, error: null };
      }
      if (name === "try_complete_current_model_cache_fallback") {
        return { data: modelCacheMiss, error: null };
      }
      if (name === "complete_worksheet_generation") {
        return { data: null, error: { message: "invalid", code: "22023" } };
      }
      if (name === "fail_async_job") {
        return { data: { status: "dead" }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId: "request-contract-rejection",
      prepareWorksheet: async () => generated,
      log: () => undefined,
    });
    assertEquals(result.outcome, "failed");
    assertEquals(calls[5], {
      name: "try_complete_current_model_cache_fallback",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        target_worker_id: workerId,
        target_fallback_reason: "candidates_rejected",
        rejected_candidates: [
          {
            attempt_number: 2,
            provider: generated.generation_source,
            model: generated.generator_model,
            rejection_reasons: generated.validation.rejection_reasons,
            candidate: generated,
          },
        ],
      },
    });
    assertEquals(calls[6]?.args.error_code, "worksheet_completion_rejected");
    assertEquals(calls[6]?.args.retryable, false);
  },
);

Deno.test("idempotent completion is accepted on redelivery", async () => {
  let completionCount = 0;
  let failureCount = 0;
  const client = admin(async (name) => {
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_generation") {
      completionCount += 1;
      return {
        data:
          completionCount === 1
            ? { completed: true }
            : { already_completed: true },
        error: null,
      };
    }
    if (name === "fail_async_job") {
      failureCount += 1;
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  for (const requestId of ["request-5a", "request-5b"]) {
    const result = await processOneWorksheetGenerationJob({
      ...requiredGenerationAccounting,
      admin: client,
      workerId,
      requestId,
      prepareWorksheet: async () => reuse,
      log: () => undefined,
    });
    assertEquals(result.outcome, "completed");
  }
  assertEquals(completionCount, 2);
  assertEquals(failureCount, 0);
});
