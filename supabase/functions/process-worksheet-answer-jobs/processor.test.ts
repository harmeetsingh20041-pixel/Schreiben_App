import {
  createWorksheetAnswerProcessorHandler,
  processOneWorksheetAnswerJob,
  PRACTICE_CYCLE_TRANSITION_BATCH_SIZE,
  WORKSHEET_ANSWER_BATCH_SIZE,
  WORKSHEET_ANSWER_QUEUE,
  WORKSHEET_ANSWER_VISIBILITY_SECONDS,
  type WorksheetAnswerProviderLifecycleHooks,
  type WorksheetAnswerWorkerClient,
} from "./processor.ts";
import {
  type WorksheetAnswerCompletionPayload,
  WorksheetAnswerEvaluationError,
} from "./evaluate.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const noOpAnswerLifecycleHooks: WorksheetAnswerProviderLifecycleHooks = {
  onBeforeProviderCall: async () => undefined,
  onProviderNotCalled: async () => undefined,
  onProviderUsage: async () => undefined,
};
const requiredAnswerAccounting = {
  createProviderLifecycleHooks: () => noOpAnswerLifecycleHooks,
};

const jobId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const questionId = "33333333-3333-4333-8333-333333333333";
const workerId = "44444444-4444-4444-8444-444444444444";
const modernServiceSecret = `sb_secret_${"s".repeat(32)}`;
const claim = {
  job_id: jobId,
  queue_message_id: "42",
  entity_id: attemptId,
  entity_version: 2,
  attempt_number: 1,
  lease_expires_at: "2026-07-10T12:00:00.000Z",
};
const retryTransition = {
  job_id: jobId,
  status: "retry",
  attempt_count: 1,
  next_attempt_at: "2026-07-10T12:00:05.000Z",
};
const evaluated: WorksheetAnswerCompletionPayload = {
  schema_version: 1,
  mode: "evaluated",
  evaluator_model: "deepseek-v4-flash",
  reviews: [{
    question_id: questionId,
    review_status: "correct",
    points_awarded: 1,
    max_points: 1,
    evaluator_source: "deepseek",
    feedback_text: "Correct.",
    corrected_answer: null,
    model_answer: null,
    short_reason: "The target form is correct.",
  }],
  adjudication: {
    schema_version: 2,
    deepseek_model: "deepseek-v4-flash",
    gemini_model: "gemini-3.1-flash-lite",
    adjudication_mode: "agreement",
    selected_provider_source: "deepseek",
    selected_question_sources: [{
      question_id: questionId,
      provider_source: "deepseek",
    }],
    deepseek_result_sha256: "a".repeat(64),
    gemini_result_sha256: "b".repeat(64),
    pro_model: null,
    pro_result_sha256: null,
  },
};
const notNeeded: WorksheetAnswerCompletionPayload = {
  schema_version: 1,
  mode: "not_needed",
  evaluator_model: null,
  reviews: [],
  adjudication: null,
};

function client(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<
    { data: unknown; error: null | { code?: string; message?: string } }
  >,
): WorksheetAnswerWorkerClient {
  return {
    schema: (schema: string) => {
      assertEquals(schema, "api");
      return { rpc: implementation };
    },
  };
}

Deno.test("apikey-only modern service secret claims only the fixed answer queue", async () => {
  let background: Promise<unknown> | null = null;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    return { data: [], error: null };
  });
  const handler = createWorksheetAnswerProcessorHandler({
    ...requiredAnswerAccounting,
    createAdminClient: () => admin,
    evaluateAttempt: async () => notNeeded,
    waitUntil: (promise) => {
      background = promise;
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
        attempt_id: "caller_attempt",
        batch_size: 10,
      }),
    }),
  );
  assertEquals(response.status, 202);
  assert(background, "Expected background processing to be scheduled.");
  await background;
  assertEquals(calls[0], {
    name: "claim_async_jobs",
    args: {
      target_queue_name: WORKSHEET_ANSWER_QUEUE,
      worker_id: workerId,
      batch_size: WORKSHEET_ANSWER_BATCH_SIZE,
      visibility_timeout_seconds: WORKSHEET_ANSWER_VISIBILITY_SECONDS,
    },
  });
});

Deno.test("semantic result completes through one transactional RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const factoryContexts: Array<{
    jobId: string;
    entityVersion: number;
    attemptNumber: number;
    admin: WorksheetAnswerWorkerClient;
  }> = [];
  const hooks: WorksheetAnswerProviderLifecycleHooks = {
    onBeforeProviderCall: async () => undefined,
    onProviderNotCalled: async () => undefined,
    onProviderUsage: async () => undefined,
  };
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_answer_adjudication") {
      return { data: { completed: true }, error: null };
    }
    if (name === "process_practice_cycle_transition_jobs") {
      return {
        data: { attempted: 1, succeeded: 1, failed: 0 },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-2",
    createProviderLifecycleHooks: (context) => {
      factoryContexts.push(context);
      return hooks;
    },
    evaluateAttempt: async (args) => {
      assertEquals(args.jobId, jobId);
      assertEquals(args.jobAttemptNumber, 1);
      assertEquals(args.queueMessageId, "42");
      assertEquals(args.workerId, workerId);
      assertEquals(args.attemptId, attemptId);
      assertEquals(args.entityVersion, 2);
      assert(
        args.providerLifecycleHooks === hooks,
        "Spend lifecycle hooks were not propagated.",
      );
      assertEquals(args.providerCallKeyPrefix, "worksheet_answer:message_42");
      return evaluated;
    },
    log: () => undefined,
  });
  assertEquals(result, { claimed: true, outcome: "completed", job_id: jobId });
  assertEquals(factoryContexts.length, 1);
  assertEquals(factoryContexts[0]?.jobId, jobId);
  assertEquals(factoryContexts[0]?.entityVersion, 2);
  assertEquals(factoryContexts[0]?.attemptNumber, 1);
  assert(
    factoryContexts[0]?.admin === admin,
    "Accounting session received the wrong worker client.",
  );
  const { adjudication, ...completionResult } = evaluated;
  assertEquals(calls[1], {
    name: "complete_worksheet_answer_adjudication",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      result: completionResult,
      adjudication,
    },
  });
  assertEquals(calls.map((call) => call.name), [
    "claim_async_jobs",
    "complete_worksheet_answer_adjudication",
    "process_practice_cycle_transition_jobs",
  ]);
  assertEquals(calls[2]?.args, {
    max_jobs: PRACTICE_CYCLE_TRANSITION_BATCH_SIZE,
  });
});

Deno.test("objective-only no-op is finalized without review writes", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_answer_adjudication") {
      return { data: { completed: true }, error: null };
    }
    if (name === "process_practice_cycle_transition_jobs") {
      return {
        data: { attempted: 1, succeeded: 1, failed: 0 },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-3",
    evaluateAttempt: async () => notNeeded,
    log: () => undefined,
  });
  assertEquals(result.outcome, "completed");
  const { adjudication, ...completionResult } = notNeeded;
  assertEquals(calls[1]?.args.result, completionResult);
  assertEquals(calls[1]?.args.adjudication, adjudication);
  assertEquals(calls[2], {
    name: "process_practice_cycle_transition_jobs",
    args: { max_jobs: PRACTICE_CYCLE_TRANSITION_BATCH_SIZE },
  });
  assertEquals(calls.length, 3);
});

Deno.test("transition drain RPC errors preserve the committed worksheet result", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_answer_adjudication") {
      return { data: { completed: true }, error: null };
    }
    if (name === "process_practice_cycle_transition_jobs") {
      return {
        data: null,
        error: { code: "57014", message: "must-not-leak" },
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-transition-rpc-error",
    evaluateAttempt: async () => evaluated,
    log: (event) => logs.push(event),
  });

  assertEquals(result, { claimed: true, outcome: "completed", job_id: jobId });
  assertEquals(calls.map((call) => call.name), [
    "claim_async_jobs",
    "complete_worksheet_answer_adjudication",
    "process_practice_cycle_transition_jobs",
  ]);
  const transitionLog = logs.find((event) =>
    event.stage === "practice_transition"
  );
  assertEquals(transitionLog?.status, "failed");
  assertEquals(
    transitionLog?.safe_error_code,
    "practice_transition_drain_failed",
  );
  assertEquals(JSON.stringify(logs).includes("must-not-leak"), false);
});

Deno.test("transition drain throws without undoing committed scoring", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const admin = client(async (name) => {
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_answer_adjudication") {
      return { data: { completed: true }, error: null };
    }
    if (name === "process_practice_cycle_transition_jobs") {
      throw new Error("must-not-leak");
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-transition-rpc-throw",
    evaluateAttempt: async () => evaluated,
    log: (event) => logs.push(event),
  });

  assertEquals(result.outcome, "completed");
  const transitionLog = logs.find((event) =>
    event.stage === "practice_transition"
  );
  assertEquals(transitionLog?.status, "failed");
  assertEquals(
    transitionLog?.safe_error_code,
    "practice_transition_drain_failed",
  );
  assertEquals(JSON.stringify(logs).includes("must-not-leak"), false);
});

Deno.test("spend lifecycle construction failure prevents answer evaluation", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let evaluated = false;
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "fail_async_job") {
      return { data: { status: "dead" }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-accounting-factory-failure",
    createProviderLifecycleHooks: () => {
      throw { retryable: false, secret: "must-not-leak" };
    },
    evaluateAttempt: async () => {
      evaluated = true;
      return notNeeded;
    },
    log: () => undefined,
  });

  assertEquals(result.outcome, "failed");
  assertEquals(evaluated, false);
  assertEquals(calls[1], {
    name: "fail_async_job",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      error_code: "worksheet_spend_accounting_failed",
      retryable: false,
    },
  });
  assertEquals(JSON.stringify(calls).includes("must-not-leak"), false);
});

Deno.test("transient provider failure schedules a bounded retry", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "fail_async_job") {
      return { data: [retryTransition], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-4",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_provider_timeout",
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
  assertEquals(calls[1], {
    name: "fail_async_job",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      error_code: "worksheet_provider_timeout",
      retryable: true,
    },
  });
});

Deno.test("unresolved adjudication transitions directly to private needs_review", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "hold_worksheet_answer_for_review") {
      return { data: { evaluation_status: "needs_review" }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-needs-review",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_semantic_adjudication_disagreement",
        false,
        false,
        false,
        "semantic_adjudication_disagreement",
      );
    },
    log: () => undefined,
  });
  assertEquals(result.outcome, "needs_review");
  assertEquals(calls[1], {
    name: "hold_worksheet_answer_for_review",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      reason_code: "semantic_adjudication_disagreement",
    },
  });
});

Deno.test("invalid semantic output retries twice and holds on attempt three", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") {
      return { data: [{ ...claim, attempt_number: 3 }], error: null };
    }
    if (name === "hold_worksheet_answer_for_review") {
      return { data: { evaluation_status: "needs_review" }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-invalid-exhausted",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_semantic_provider_output_invalid",
        true,
        false,
        false,
        "semantic_provider_output_invalid",
      );
    },
    log: () => undefined,
  });
  assertEquals(result.outcome, "needs_review");
  assertEquals(calls[1]?.name, "hold_worksheet_answer_for_review");
  assertEquals(
    calls.some((call) => call.name === "defer_async_job_for_provider_outage"),
    false,
  );
});

Deno.test("dual-provider answer outage uses the bounded recovery lane", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "defer_async_job_for_provider_outage") {
      return {
        data: [{
          ...retryTransition,
          attempt_count: 0,
          next_attempt_at: "2026-07-10T12:01:00.000Z",
          outage_retry_count: 1,
        }],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-dual-provider-outage",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_secondary_unavailable",
        true,
        false,
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
  assertEquals(calls[1], {
    name: "defer_async_job_for_provider_outage",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      outage_reason: "dual_provider_outage_unavailable",
    },
  });
});

Deno.test("one-sided outage keeps recovery and its checkpoint beyond three redeliveries", async () => {
  let delivery = 0;
  let checkpointPresent = true;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") {
      delivery += 1;
      return {
        data: [{
          ...claim,
          queue_message_id: String(41 + delivery),
          attempt_number: delivery,
        }],
        error: null,
      };
    }
    if (name === "defer_async_job_for_provider_outage") {
      if (delivery <= 4) {
        return {
          data: [{
            job_id: jobId,
            status: "retry",
            attempt_count: delivery,
            next_attempt_at: `2026-07-10T12:0${delivery}:00.000Z`,
            outage_retry_count: delivery,
            outage_deadline_at: "2026-07-11T12:00:00.000Z",
            outage_exhausted: false,
          }],
          error: null,
        };
      }
      checkpointPresent = false;
      return {
        data: [{
          job_id: jobId,
          status: "dead",
          attempt_count: 4,
          next_attempt_at: null,
          outage_retry_count: 4,
          outage_deadline_at: "2026-07-11T12:00:00.000Z",
          outage_exhausted: true,
        }],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const outcomes: string[] = [];
  for (let redelivery = 1; redelivery <= 5; redelivery += 1) {
    const result = await processOneWorksheetAnswerJob({
      ...requiredAnswerAccounting,
      admin,
      workerId,
      requestId: `request-one-sided-outage-${redelivery}`,
      evaluateAttempt: async () => {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_single_provider_timeout",
          true,
          false,
          true,
          "semantic_single_provider_incomplete",
        );
      },
      log: () => undefined,
    });
    outcomes.push(result.outcome);
    if (redelivery <= 4) {
      assertEquals(checkpointPresent, true);
    }
  }

  assertEquals(outcomes, [
    "retry_scheduled",
    "retry_scheduled",
    "retry_scheduled",
    "retry_scheduled",
    "failed",
  ]);
  assertEquals(
    calls.filter((call) => call.name === "defer_async_job_for_provider_outage")
      .length,
    5,
  );
  assertEquals(
    calls.filter((call) => call.name === "defer_async_job_for_provider_outage")
      .every((call) =>
        call.args.outage_reason === "dual_provider_outage_timeout"
      ),
    true,
  );
  assertEquals(
    calls.filter((call) => call.name === "hold_worksheet_answer_for_review")
      .length,
    0,
  );
  assertEquals(
    calls.filter((call) => call.name === "fail_async_job").length,
    0,
  );
  assertEquals(checkpointPresent, false);
});

Deno.test("one-sided outage deadline exhaustion fails terminally without teacher review", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") {
      return { data: [{ ...claim, attempt_number: 8 }], error: null };
    }
    if (name === "defer_async_job_for_provider_outage") {
      return {
        data: [{
          job_id: jobId,
          status: "dead",
          attempt_count: 7,
          next_attempt_at: null,
          outage_retry_count: 2,
          outage_deadline_at: "2026-07-10T11:59:59.000Z",
          outage_exhausted: true,
        }],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-one-sided-outage-deadline",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_single_provider_unavailable",
        true,
        false,
        true,
        "semantic_single_provider_incomplete",
      );
    },
    log: () => undefined,
  });

  assertEquals(result.outcome, "failed");
  assertEquals(calls[1]?.name, "defer_async_job_for_provider_outage");
  assertEquals(
    calls[1]?.args.outage_reason,
    "dual_provider_outage_unavailable",
  );
  assertEquals(
    calls.some((call) => call.name === "hold_worksheet_answer_for_review"),
    false,
  );
});

Deno.test("worker logs never include provider payloads, answers, secrets, or raw errors", async () => {
  const sensitive =
    "student@example.test Ich helfe dem Mann. sk-live-secret raw-provider-body";
  const events: unknown[] = [];
  const admin = client(async (name) => {
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "fail_async_job") {
      return { data: [retryTransition], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-private-log",
    evaluateAttempt: async () => {
      throw new Error(sensitive);
    },
    log: (event) => events.push(event),
  });

  assertEquals(result.outcome, "retry_scheduled");
  const serialized = JSON.stringify(events);
  for (const forbidden of sensitive.split(" ")) {
    assert(
      !serialized.includes(forbidden),
      `Worker log leaked forbidden content: ${forbidden}`,
    );
  }
  assert(
    serialized.includes("worksheet_answer_evaluation_failed"),
    "Worker log must retain only the stable safe failure code.",
  );
});

Deno.test("answer retry keeps waitUntil alive through its authenticated wakeup", async () => {
  let background: Promise<unknown> | null = null;
  const wakeups: unknown[] = [];
  const admin = client(async (name) => {
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "fail_async_job") {
      return { data: [retryTransition], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const handler = createWorksheetAnswerProcessorHandler({
    ...requiredAnswerAccounting,
    createAdminClient: () => admin,
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_provider_timeout",
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
  assert(background, "Answer retry was not registered with waitUntil.");
  await background;
  assertEquals(wakeups, [{
    jobId,
    attemptCount: 1,
    nextAttemptAt: "2026-07-10T12:00:05.000Z",
  }]);
});

Deno.test("permanent invalid-attempt failure goes directly to dead handling", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "fail_async_job") {
      return { data: { status: "dead" }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-5",
    evaluateAttempt: async () => {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_attempt_ineligible",
        false,
      );
    },
    log: () => undefined,
  });
  assertEquals(result.outcome, "failed");
  assertEquals(calls[1]?.args.retryable, false);
});

Deno.test("permanent completion rejection does not repeat semantic evaluation", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") return { data: [claim], error: null };
    if (name === "complete_worksheet_answer_adjudication") {
      return {
        data: null,
        error: { code: "22023", message: "review payload rejected" },
      };
    }
    if (name === "fail_async_job") {
      return { data: { status: "dead" }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const result = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-5b",
    evaluateAttempt: async () => evaluated,
    log: () => undefined,
  });

  assertEquals(result.outcome, "failed");
  assertEquals(calls[2]?.args.retryable, false);
  assertEquals(
    calls[2]?.args.error_code,
    "worksheet_answer_completion_rejected",
  );
});

Deno.test("atomic finalization failure retries and redelivery completes without partial writes", async () => {
  let delivery = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = client(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_async_jobs") {
      delivery += 1;
      return {
        data: [{
          ...claim,
          queue_message_id: delivery === 1 ? "42" : "43",
          attempt_number: delivery,
        }],
        error: null,
      };
    }
    if (name === "complete_worksheet_answer_adjudication") {
      return delivery === 1
        ? { data: null, error: { message: "transaction rolled back" } }
        : { data: { completed: true }, error: null };
    }
    if (name === "process_practice_cycle_transition_jobs") {
      return {
        data: { attempted: 1, succeeded: 1, failed: 0 },
        error: null,
      };
    }
    if (name === "fail_async_job") {
      return { data: [retryTransition], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const first = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-6a",
    evaluateAttempt: async () => evaluated,
    log: () => undefined,
  });
  const second = await processOneWorksheetAnswerJob({
    ...requiredAnswerAccounting,
    admin,
    workerId,
    requestId: "request-6b",
    evaluateAttempt: async () => evaluated,
    log: () => undefined,
  });

  assertEquals(first.outcome, "retry_scheduled");
  assertEquals(second.outcome, "completed");
  assertEquals(
    calls.filter((call) => call.name === "fail_async_job").length,
    1,
  );
  assertEquals(
    calls.filter((call) =>
      call.name === "complete_worksheet_answer_adjudication"
    )
      .length,
    2,
  );
  assertEquals(
    calls.filter((call) =>
      ![
        "claim_async_jobs",
        "complete_worksheet_answer_adjudication",
        "fail_async_job",
        "process_practice_cycle_transition_jobs",
      ].includes(call.name)
    ).length,
    0,
  );
});
