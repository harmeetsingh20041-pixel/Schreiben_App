import {
  createProcessWritingJobsHandler,
  processOneWritingJob,
  WRITING_JOB_BATCH_SIZE,
  WRITING_QUEUE_NAME,
  WRITING_VISIBILITY_TIMEOUT_SECONDS,
  WritingJobProcessingError,
  type WritingProcessorAdminClient,
} from "./processor.ts";
import {
  FeedbackEvaluationError,
  type WritingFeedbackCompletionPayload,
} from "../_shared/writing-feedback.ts";
import {
  createRetryWakeup,
  isDurableRetryTransition,
  retryScheduleFromFailureTransition,
  retryScheduleFromProviderOutageTransition,
} from "../_shared/retry-wakeup.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const submissionId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const modernServiceSecret = `sb_secret_${"s".repeat(32)}`;

const claimedJob = {
  job_id: jobId,
  queue_message_id: "42",
  entity_id: submissionId,
  entity_version: 3,
  attempt_number: 1,
  lease_expires_at: "2026-07-10T00:30:00.000Z",
};
const retryTransition = {
  job_id: jobId,
  status: "retry",
  attempt_count: 1,
  next_attempt_at: "2026-07-10T00:00:05.000Z",
};

const feedback: WritingFeedbackCompletionPayload = {
  feedback_contract_version: 2,
  overall_summary: "Good work.",
  level_detected: "A2",
  corrected_text: "Ich gehe zur Schule.",
  ai_model: "deepseek-v4-flash",
  score_summary: {
    correct_lines: 0,
    acceptable_lines: 0,
    minor_issues: 1,
    major_issues: 0,
    needs_review: 0,
  },
  lines: [
    {
      line_number: 1,
      source_start: 0,
      source_end: 16,
      original_line: "Ich gehe Schule.",
      corrected_line: "Ich gehe zur Schule.",
      status: "minor_issue",
      changed_parts: [
        {
          from: "Schule",
          to: "zur Schule",
          reason: "Use the preposition.",
          grammar_topics: ["prepositions"],
          severity: "minor",
          source_start: 9,
          source_end: 15,
          corrected_start: 9,
          corrected_end: 19,
        },
      ],
      short_explanation: "Use zur Schule.",
      detailed_explanation: "The destination phrase is zur Schule.",
      grammar_topic: "Prepositions",
    },
  ],
  grammar_topics: [
    {
      topic: "Prepositions",
      count: 1,
      minor_count: 1,
      major_count: 0,
      severity: "minor",
      simple_explanation: "Review destination phrases.",
    },
  ],
  evaluation_evidence: {
    schema_version: 2,
    decision: "accepted_model_feedback",
    reason_code: "critic_approved",
    context_sha256: "a".repeat(64),
    original_text_sha256: "b".repeat(64),
    final_feedback_sha256: "c".repeat(64),
    generator_provider: "deepseek",
    generator_model: "deepseek-v4-flash",
    candidate_feedback_sha256: "d".repeat(64),
    candidate_release_sha256: "c".repeat(64),
    critic_provider: "gemini",
    critic_model: "gemini-3.1-flash-lite",
    critic_verdict: "approved",
    critic_decision_sha256: "e".repeat(64),
    adjudicator_provider: null,
    adjudicator_model: null,
    adjudicator_verdict: null,
    adjudicator_decision_sha256: null,
    resolved_feedback_sha256: null,
    final_critic_provider: null,
    final_critic_model: null,
    final_critic_verdict: null,
    final_critic_decision_sha256: null,
    accepted_provider: "deepseek",
    accepted_model: "deepseek-v4-flash",
  },
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "Values are not equal",
) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function createAdmin(
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: null | { code?: string; message?: string };
  }>,
): WritingProcessorAdminClient {
  return {
    schema: (schema: string) => {
      assertEquals(schema, "api", "Worker used the wrong Data API schema.");
      return { rpc };
    },
  } as unknown as WritingProcessorAdminClient;
}

function createTestProviderLifecycleHooks() {
  return {
    providerCallKeyPrefix: "writing",
    onBeforeProviderCall: async () => undefined,
    onProviderUsage: async () => undefined,
    onProviderNotCalled: async () => undefined,
  };
}

Deno.test(
  "apikey-only modern service secret returns 202 without waiting for writing evaluation",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let resolveEvaluation!: (value: WritingFeedbackCompletionPayload) => void;
    const evaluationPromise = new Promise<WritingFeedbackCompletionPayload>(
      (resolve) => {
        resolveEvaluation = resolve;
      },
    );
    let backgroundTask: Promise<unknown> | null = null;

    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "complete_writing_evaluation") {
        return { data: { completed: true }, error: null };
      }
      return { data: null, error: null };
    });
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => admin,
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: () => evaluationPromise,
      waitUntil: (promise) => {
        backgroundTask = promise;
      },
      createRequestId: () => "request-1",
      createWorkerId: () => workerId,
      getServiceAuthSecret: () => modernServiceSecret,
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-writing-jobs", {
        method: "POST",
        headers: {
          apikey: modernServiceSecret,
        },
        body: JSON.stringify({ entity_id: "caller-must-not-control-this" }),
      }),
    );

    assertEquals(response.status, 202);
    assert(
      backgroundTask,
      "Expected the worker to be registered as a background task.",
    );
    assertEquals(rpcCalls[0], {
      name: "claim_async_jobs",
      args: {
        target_queue_name: WRITING_QUEUE_NAME,
        worker_id: workerId,
        batch_size: WRITING_JOB_BATCH_SIZE,
        visibility_timeout_seconds: WRITING_VISIBILITY_TIMEOUT_SECONDS,
      },
    });

    resolveEvaluation(feedback);
    await backgroundTask;
    assertEquals(rpcCalls[1]?.name, "complete_writing_evaluation");
  },
);

Deno.test(
  "arbitrary bearer tokens are rejected before client creation or job RPC",
  async () => {
    let createdAdmin = false;
    let scheduled = false;
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => {
        createdAdmin = true;
        throw new Error("Arbitrary bearer reached client creation.");
      },
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      waitUntil: () => {
        scheduled = true;
      },
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-writing-jobs", {
        method: "POST",
        headers: { Authorization: "Bearer arbitrary-invalid-token" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 401);
    assert(!createdAdmin, "Arbitrary bearer created a Supabase client.");
    assert(!scheduled, "Arbitrary bearer scheduled a worker.");
  },
);

Deno.test(
  "publishable API keys cannot wake the internal writing worker",
  async () => {
    let createdAdmin = false;
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => {
        createdAdmin = true;
        throw new Error("Publishable key reached client creation.");
      },
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      waitUntil: () => {
        throw new Error("Inactive user scheduled a worker.");
      },
      getServiceAuthSecret: () => "service-secret",
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-writing-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-user-token",
          apikey: "publishable-key",
        },
        body: "{}",
      }),
    );

    assertEquals(response.status, 401);
    assert(!createdAdmin, "Publishable key created a Supabase client.");
  },
);

Deno.test(
  "ordinary user JWTs cannot call compatibility or canonical workers",
  async () => {
    let createdAdmin = false;
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => {
        createdAdmin = true;
        throw new Error("Ordinary user JWT reached client creation.");
      },
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      waitUntil: () => {
        throw new Error("Compatibility user kick scheduled a worker.");
      },
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-due-feedback", {
        method: "POST",
        headers: { Authorization: "Bearer valid-user-token" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 401);
    assert(!createdAdmin, "Ordinary user JWT created a Supabase client.");
  },
);

Deno.test(
  "the compatibility handler still accepts its recovery secret",
  async () => {
    const rpcCalls: string[] = [];
    let backgroundTask: Promise<unknown> | null = null;
    const admin = createAdmin(async (name) => {
      rpcCalls.push(name);
      assertEquals(name, "claim_async_jobs");
      return { data: [], error: null };
    });
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => admin,
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      waitUntil: (promise) => {
        backgroundTask = promise;
      },
      getRecoverySecret: () => "recovery-secret",
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-due-feedback", {
        method: "POST",
        headers: { "x-process-feedback-secret": "recovery-secret" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 202);
    assert(backgroundTask, "The recovery request did not schedule the worker.");
    await backgroundTask;
    assertEquals(rpcCalls, ["claim_async_jobs"]);
  },
);

Deno.test(
  "claim with no available message exits without evaluation",
  async () => {
    let evaluated = false;
    const admin = createAdmin(async (name) => {
      assertEquals(name, "claim_async_jobs");
      return { data: [], error: null };
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-2",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        evaluated = true;
        return feedback;
      },
      log: () => undefined,
    });

    assertEquals(result, { claimed: false, outcome: "no_message" });
    assert(!evaluated, "No-message claims must not call the provider.");
  },
);

Deno.test(
  "successful evaluation uses the single completion RPC contract",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "complete_writing_evaluation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-3",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "completed",
      job_id: jobId,
    });
    assertEquals(rpcCalls[1], {
      name: "complete_writing_evaluation",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        feedback,
      },
    });
    assert(
      !("needs_review" in feedback),
      "The worker must not send a trusted review state.",
    );
    assert(
      !("submission_id" in feedback),
      "The completion payload must not override the claimed entity.",
    );
  },
);

Deno.test(
  "claimed job metadata creates and threads one spend lifecycle",
  async () => {
    let lifecycleContext: Record<string, unknown> | null = null;
    let evaluationLifecycle: Record<string, unknown> | null = null;
    let threadedBefore: unknown = null;
    let threadedUsage: unknown = null;
    let threadedNotCalled: unknown = null;
    const before = async () => undefined;
    const usage = async () => undefined;
    const notCalled = async () => undefined;
    const admin = createAdmin(async (name) => {
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "complete_writing_evaluation") {
        return { data: { completed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-spend-lifecycle",
      createProviderLifecycleHooks: (context) => {
        lifecycleContext = context;
        return {
          providerCallKeyPrefix: "writing",
          onBeforeProviderCall: before,
          onProviderUsage: usage,
          onProviderNotCalled: notCalled,
        };
      },
      evaluateSubmission: async (args) => {
        evaluationLifecycle = {
          providerCallKeyPrefix: args.providerCallKeyPrefix,
          onBeforeProviderCall: args.onBeforeProviderCall,
          onProviderUsage: args.onProviderUsage,
          onProviderNotCalled: args.onProviderNotCalled,
        };
        threadedBefore = args.onBeforeProviderCall;
        threadedUsage = args.onProviderUsage;
        threadedNotCalled = args.onProviderNotCalled;
        return feedback;
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "completed");
    assertEquals(lifecycleContext, {
      admin,
      jobId,
      entityVersion: 3,
      attemptNumber: 1,
    });
    assertEquals(evaluationLifecycle, {
      providerCallKeyPrefix: "writing:message_42",
      onBeforeProviderCall: before,
      onProviderUsage: usage,
      onProviderNotCalled: notCalled,
    });
    assert(
      threadedBefore === before &&
        threadedUsage === usage &&
        threadedNotCalled === notCalled,
      "Spend lifecycle hooks were not threaded by identity.",
    );
  },
);

Deno.test(
  "retryable evaluation failure transitions through fail_async_job",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "fail_async_job") {
        return { data: [retryTransition], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-4",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new WritingJobProcessingError("provider_unavailable", true);
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
        nextAttemptAt: "2026-07-10T00:00:05.000Z",
      },
    });
    assertEquals(rpcCalls[1], {
      name: "fail_async_job",
      args: {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        error_code: "provider_unavailable",
        retryable: true,
      },
    });
  },
);

Deno.test(
  "closed spend diagnostics retain the exact accounting failure without exposing arbitrary strings",
  async () => {
    for (
      const testCase of [
        {
          diagnostic: "ai_spend_contract_invalid",
          expected: "ai_spend_contract_invalid",
        },
        {
          diagnostic: "raw_database_detail_must_not_escape",
          expected: "writing_spend_accounting_failed",
        },
      ]
    ) {
      const rpcCalls: Array<{
        name: string;
        args: Record<string, unknown>;
      }> = [];
      const admin = createAdmin(async (name, args) => {
        rpcCalls.push({ name, args });
        if (name === "claim_async_jobs") {
          return { data: [claimedJob], error: null };
        }
        if (name === "fail_async_job") {
          return {
            data: [{ ...retryTransition, status: "dead" }],
            error: null,
          };
        }
        throw new Error(`Unexpected RPC ${name}`);
      });

      await processOneWritingJob({
        admin,
        workerId,
        requestId: "request-spend-diagnostic",
        createProviderLifecycleHooks: createTestProviderLifecycleHooks,
        evaluateSubmission: async () => {
          throw new FeedbackEvaluationError(
            "writing_spend_accounting_failed",
            false,
            false,
            testCase.diagnostic,
          );
        },
        log: () => undefined,
      });

      assertEquals(rpcCalls[1]?.args.error_code, testCase.expected);
      assertEquals(rpcCalls[1]?.args.retryable, false);
    }
  },
);

Deno.test(
  "secondary-provider timeout schedules the durable writing retry",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "defer_async_job_for_provider_outage") {
        return {
          data: [
            {
              ...retryTransition,
              attempt_count: 0,
              next_attempt_at: "2026-07-10T00:01:00.000Z",
              outage_retry_count: 1,
            },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-secondary-timeout",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new FeedbackEvaluationError("provider_timeout", true, true);
      },
      log: () => undefined,
    });

    assertEquals(result, {
      claimed: true,
      outcome: "retry_scheduled",
      job_id: jobId,
      retry_wakeup: {
        jobId,
        attemptCount: 0,
        nextAttemptAt: "2026-07-10T00:01:00.000Z",
        wakeupKind: "provider_outage_first_retry",
        outageRetryCount: 1,
      },
    });
    assertEquals(rpcCalls[1], {
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
  "retry transition keeps waitUntil alive through the authenticated wakeup",
  async () => {
    let backgroundTask: Promise<unknown> | null = null;
    const wakeups: unknown[] = [];
    const admin = createAdmin(async (name) => {
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "fail_async_job") {
        return { data: [retryTransition], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => admin,
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new WritingJobProcessingError("provider_unavailable", true);
      },
      waitUntil: (promise) => {
        backgroundTask = promise;
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
      new Request("https://example.test/functions/v1/process-writing-jobs", {
        method: "POST",
        headers: { Authorization: "Bearer service-secret" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 202);
    assert(
      backgroundTask,
      "Retry processing was not registered with waitUntil.",
    );
    await backgroundTask;
    assertEquals(wakeups, [
      {
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T00:00:05.000Z",
      },
    ]);
  },
);

Deno.test(
  "first provider-outage retry keeps waitUntil alive through the writing self-wakeup",
  async () => {
    let backgroundTask: Promise<unknown> | null = null;
    const wakeups: unknown[] = [];
    const admin = createAdmin(async (name) => {
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "defer_async_job_for_provider_outage") {
        return {
          data: [{
            ...retryTransition,
            attempt_count: 0,
            next_attempt_at: "2026-07-10T00:01:00.000Z",
            outage_retry_count: 1,
          }],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const handler = createProcessWritingJobsHandler({
      createAdminClient: () => admin,
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new FeedbackEvaluationError("provider_timeout", true, true);
      },
      waitUntil: (promise) => {
        backgroundTask = promise;
      },
      wakeRetry: async (schedule) => {
        wakeups.push(schedule);
        return "invoked";
      },
      getServiceAuthSecret: () => "service-secret",
      createRequestId: () => "request-outage-wakeup",
      createWorkerId: () => workerId,
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/functions/v1/process-writing-jobs", {
        method: "POST",
        headers: { Authorization: "Bearer service-secret" },
        body: "{}",
      }),
    );

    assertEquals(response.status, 202);
    assert(
      backgroundTask,
      "Provider-outage processing was not retained by waitUntil.",
    );
    await backgroundTask;
    assertEquals(wakeups, [{
      jobId,
      attemptCount: 0,
      nextAttemptAt: "2026-07-10T00:01:00.000Z",
      wakeupKind: "provider_outage_first_retry",
      outageRetryCount: 1,
    }]);
  },
);

Deno.test("a failed retry transition never mints a self-wakeup", async () => {
  const admin = createAdmin(async (name) => {
    if (name === "claim_async_jobs") return { data: [claimedJob], error: null };
    if (name === "fail_async_job") {
      return {
        data: null,
        error: { code: "503", message: "transition unavailable" },
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWritingJob({
    admin,
    workerId,
    requestId: "request-failed-retry-transition",
    createProviderLifecycleHooks: createTestProviderLifecycleHooks,
    evaluateSubmission: async () => {
      throw new WritingJobProcessingError("provider_unavailable", true);
    },
    log: () => undefined,
  });

  assertEquals(result, { claimed: true, outcome: "failed", job_id: jobId });
});

Deno.test(
  "retry wakeup uses deterministic 5s/10s delays and sends no job payload",
  async () => {
    const delays: number[] = [];
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const wakeRetry = createRetryWakeup({
      functionName: "process-writing-jobs",
      authHeaderName: "x-process-writing-secret",
      getSupabaseUrl: () => "https://project.supabase.co",
      getAuthSecret: () => "dedicated-worker-secret",
      now: () => Date.parse("2026-07-10T00:00:00.000Z"),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(null, { status: 202 });
      },
    });

    const first = await wakeRetry({
      jobId,
      attemptCount: 1,
      nextAttemptAt: "2026-07-10T00:00:05.000Z",
    });
    const second = await wakeRetry({
      jobId,
      attemptCount: 2,
      nextAttemptAt: "2026-07-10T00:00:10.000Z",
    });

    assertEquals([first, second], ["invoked", "invoked"]);
    assertEquals(delays, [5_250, 10_250]);
    assertEquals(
      requests.map((request) => ({
        input: request.input,
        method: request.init?.method,
        body: request.init?.body,
        redirect: request.init?.redirect,
        contentType: new Headers(request.init?.headers).get("content-type"),
        workerSecret: new Headers(request.init?.headers).get(
          "x-process-writing-secret",
        ),
      })),
      [1, 2].map(() => ({
        input: "https://project.supabase.co/functions/v1/process-writing-jobs",
        method: "POST",
        body: "{}",
        redirect: "error",
        contentType: "application/json",
        workerSecret: "dedicated-worker-secret",
      })),
    );
    assert(
      requests.every(
        (request) =>
          !String(request.init?.body).includes(jobId) &&
          !request.input.includes("dedicated-worker-secret"),
      ),
      "Retry wakeup leaked job metadata or a secret outside the auth header.",
    );
  },
);

Deno.test(
  "third attempts and malformed retry transitions cannot recurse",
  async () => {
    assertEquals(
      isDurableRetryTransition(
        [
          {
            ...retryTransition,
            attempt_count: 0,
            next_attempt_at: "2026-07-10T06:00:00.000Z",
          },
        ],
        jobId,
      ),
      true,
    );
    assertEquals(
      retryScheduleFromFailureTransition(
        [
          {
            ...retryTransition,
            attempt_count: 3,
          },
        ],
        jobId,
      ),
      null,
    );
    assertEquals(
      retryScheduleFromFailureTransition(
        [
          {
            ...retryTransition,
            status: "dead",
            next_attempt_at: null,
          },
        ],
        jobId,
      ),
      null,
    );

    let fetched = false;
    let slept = false;
    const wakeRetry = createRetryWakeup({
      functionName: "process-writing-jobs",
      authHeaderName: "x-process-writing-secret",
      getSupabaseUrl: () => "https://project.supabase.co",
      getAuthSecret: () => "dedicated-worker-secret",
      sleep: async () => {
        slept = true;
      },
      fetch: async () => {
        fetched = true;
        return new Response(null, { status: 202 });
      },
    });
    const result = await wakeRetry({
      jobId,
      attemptCount: 3,
      nextAttemptAt: "2026-07-10T00:00:10.000Z",
    });
    assertEquals(result, "skipped");
    assert(!slept, "A final attempt scheduled another retry delay.");
    assert(!fetched, "A final attempt recursively invoked the worker.");
  },
);

Deno.test(
  "only the first authoritative provider-outage transition can self-wake",
  () => {
    const first = retryScheduleFromProviderOutageTransition(
      [{
        ...retryTransition,
        attempt_count: 0,
        next_attempt_at: "2026-07-10T00:01:00.000Z",
        outage_retry_count: 1,
      }],
      jobId,
    );
    assertEquals(first, {
      jobId,
      attemptCount: 0,
      nextAttemptAt: "2026-07-10T00:01:00.000Z",
      wakeupKind: "provider_outage_first_retry",
      outageRetryCount: 1,
    });

    for (
      const invalid of [
        { outage_retry_count: 2, attempt_count: 0 },
        { outage_retry_count: 1, attempt_count: 1 },
        { outage_retry_count: 1, attempt_count: 0, status: "dead" },
        { outage_retry_count: 1, attempt_count: 0, next_attempt_at: null },
      ]
    ) {
      assertEquals(
        retryScheduleFromProviderOutageTransition(
          [{ ...retryTransition, ...invalid }],
          jobId,
        ),
        null,
      );
    }
  },
);

Deno.test(
  "provider-outage wakeup is writing-only and bounded below ninety seconds",
  async () => {
    const schedule = {
      jobId,
      attemptCount: 0,
      nextAttemptAt: "2026-07-10T00:01:00.000Z",
      wakeupKind: "provider_outage_first_retry" as const,
      outageRetryCount: 1,
    };
    const delays: number[] = [];
    const writingWakeup = createRetryWakeup({
      functionName: "process-writing-jobs",
      authHeaderName: "x-process-writing-secret",
      getSupabaseUrl: () => "https://project.supabase.co",
      getAuthSecret: () => "dedicated-worker-secret",
      now: () => Date.parse("2026-07-10T00:00:00.000Z"),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      fetch: async () => new Response(null, { status: 202 }),
    });
    assertEquals(await writingWakeup(schedule), "invoked");
    assertEquals(delays, [60_250]);

    let worksheetTouched = false;
    for (
      const worker of [
        {
          functionName: "process-worksheet-generation-jobs" as const,
          authHeaderName: "x-process-worksheet-secret" as const,
        },
        {
          functionName: "process-worksheet-answer-jobs" as const,
          authHeaderName: "x-process-worksheet-answer-secret" as const,
        },
      ]
    ) {
      const worksheetWakeup = createRetryWakeup({
        ...worker,
        getSupabaseUrl: () => "https://project.supabase.co",
        getAuthSecret: () => "worksheet-secret",
        now: () => Date.parse("2026-07-10T00:00:00.000Z"),
        sleep: async () => {
          worksheetTouched = true;
        },
        fetch: async () => {
          worksheetTouched = true;
          return new Response(null, { status: 202 });
        },
      });
      assertEquals(await worksheetWakeup(schedule), "skipped");
    }
    assert(
      !worksheetTouched,
      "A writing provider-outage schedule reached a worksheet worker.",
    );

    let longDelayTouched = false;
    const longDelayWakeup = createRetryWakeup({
      functionName: "process-writing-jobs",
      authHeaderName: "x-process-writing-secret",
      getSupabaseUrl: () => "https://project.supabase.co",
      getAuthSecret: () => "dedicated-worker-secret",
      now: () => Date.parse("2026-07-10T00:00:00.000Z"),
      sleep: async () => {
        longDelayTouched = true;
      },
      fetch: async () => {
        longDelayTouched = true;
        return new Response(null, { status: 202 });
      },
    });
    assertEquals(
      await longDelayWakeup({
        ...schedule,
        nextAttemptAt: "2026-07-10T00:01:30.000Z",
      }),
      "skipped",
    );
    assert(
      !longDelayTouched,
      "A provider-outage delay exceeded ninety seconds.",
    );
  },
);

Deno.test(
  "failed retry wakeup is swallowed because the queue remains durable",
  async () => {
    const wakeRetry = createRetryWakeup({
      functionName: "process-writing-jobs",
      authHeaderName: "x-process-writing-secret",
      getSupabaseUrl: () => "https://project.supabase.co",
      getAuthSecret: () => "dedicated-worker-secret",
      now: () => Date.parse("2026-07-10T00:00:00.000Z"),
      sleep: async () => undefined,
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });
    assertEquals(
      await wakeRetry({
        jobId,
        attemptCount: 1,
        nextAttemptAt: "2026-07-10T00:00:05.000Z",
      }),
      "failed",
    );
  },
);

Deno.test(
  "permanent evaluation failure transitions without retry",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "fail_async_job") {
        return { data: { failed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-5",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new WritingJobProcessingError("invalid_submission", false);
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "failed");
    assertEquals(rpcCalls[1]?.args.retryable, false);
    assertEquals(rpcCalls[1]?.args.error_code, "invalid_submission");
  },
);

Deno.test(
  "repeated invalid provider output is held without a durable retry",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "fail_async_job") {
        return { data: { failed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-5b",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => {
        throw new FeedbackEvaluationError("feedback_invalid_after_pro", false);
      },
      log: () => undefined,
    });

    assertEquals(result.outcome, "failed");
    assertEquals(rpcCalls[1]?.args.retryable, false);
    assertEquals(rpcCalls[1]?.args.error_code, "feedback_invalid_after_pro");
  },
);

Deno.test(
  "permanent completion rejection does not repeat provider work",
  async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = createAdmin(async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "complete_writing_evaluation") {
        return {
          data: null,
          error: { code: "22023", message: "payload rejected" },
        };
      }
      if (name === "fail_async_job") {
        return { data: { failed: true }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-5c",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      log: () => undefined,
    });

    assertEquals(result.outcome, "failed");
    assertEquals(rpcCalls[2]?.args.retryable, false);
    assertEquals(rpcCalls[2]?.args.error_code, "completion_rejected");
  },
);

Deno.test(
  "idempotent completion response is accepted on redelivery",
  async () => {
    let completionCount = 0;
    let failureCount = 0;
    const admin = createAdmin(async (name) => {
      if (name === "claim_async_jobs") {
        return { data: [claimedJob], error: null };
      }
      if (name === "complete_writing_evaluation") {
        completionCount += 1;
        return {
          data: completionCount === 1
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

    const first = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-6a",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      log: () => undefined,
    });
    const second = await processOneWritingJob({
      admin,
      workerId,
      requestId: "request-6b",
      createProviderLifecycleHooks: createTestProviderLifecycleHooks,
      evaluateSubmission: async () => feedback,
      log: () => undefined,
    });

    assertEquals(first.outcome, "completed");
    assertEquals(second.outcome, "completed");
    assertEquals(completionCount, 2);
    assertEquals(failureCount, 0);
  },
);
