import { createWorksheetAnswerCheckpointStore } from "./checkpoint.ts";
import {
  type WorksheetAnswerCompletionReview,
  WorksheetAnswerEvaluationError,
  type WorksheetAnswerProCheckpointPayload,
} from "./evaluate.ts";
import type { WorkerApiClient } from "../_shared/worker-api.ts";
import { canonicalJsonSha256 } from "../_shared/writing-adjudication.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const jobId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const questionId = "44444444-4444-4444-8444-444444444444";
const evidenceSha256 = "a".repeat(64);
const evaluatorContractVersion = 1;
const promptContractVersion = 1;
const review: WorksheetAnswerCompletionReview = {
  question_id: questionId,
  review_status: "correct",
  points_awarded: 1,
  max_points: 1,
  evaluator_source: "deepseek",
  feedback_text: "Die Antwort erfüllt die Zielgrammatik.",
  corrected_answer: null,
  model_answer: "Ich helfe dem Mann.",
  short_reason: "Alle Kriterien sind erfüllt.",
};
const usage = {
  provider: "deepseek",
  requested_model: "deepseek-v4-flash",
  provider_model_version: "deepseek-v4-flash",
  input_tokens: 120,
  output_tokens: 40,
  cached_input_tokens: 0,
  uncached_input_tokens: 120,
  call_purpose: "worksheet_answer_evaluation",
  call_key: "worksheet_answer:message_42:deepseek:evaluation",
} as const;
const proUsage = {
  provider: "deepseek",
  requested_model: "deepseek-v4-pro",
  provider_model_version: "deepseek-v4-pro",
  input_tokens: 180,
  output_tokens: 55,
  cached_input_tokens: 20,
  uncached_input_tokens: 160,
  call_purpose: "worksheet_answer_adjudication",
  call_key: "worksheet_answer:message_42:deepseek:adjudication",
} as const;

function client(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string } | null }>,
): WorkerApiClient {
  return {
    schema: (schema: string) => {
      assertEquals(schema, "api");
      return {
        rpc: (name: string, args: Record<string, unknown>) => {
          const operation = implementation(name, args);
          return Object.assign(operation, {
            abortSignal: () => operation,
          });
        },
      };
    },
  };
}

function store(admin: WorkerApiClient) {
  return createWorksheetAnswerCheckpointStore({
    admin,
    jobId,
    queueMessageId: "42",
    workerId,
    attemptId,
    entityVersion: 2,
  });
}

Deno.test("a valid private provider verdict resumes through the exact lease", async () => {
  const verdictSha256 = await canonicalJsonSha256([review]);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const checkpointStore = store(client(async (name, args) => {
    calls.push({ name, args });
    return {
      data: [{
        job_id: jobId,
        attempt_id: attemptId,
        entity_version: 2,
        evaluator_contract_version: evaluatorContractVersion,
        prompt_contract_version: promptContractVersion,
        evidence_sha256: evidenceSha256,
        provider_name: "deepseek",
        provider_model: "deepseek-v4-flash",
        verdict_sha256: verdictSha256,
        normalized_verdict: [review],
      }],
      error: null,
    };
  }));
  const rows = await checkpointStore.load({
    evidenceSha256,
    deepSeekModel: "deepseek-v4-flash",
    geminiModel: "gemini-3.1-flash-lite",
    evaluatorContractVersion,
    promptContractVersion,
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.provider, "deepseek");
  assertEquals(calls[0], {
    name: "get_worksheet_answer_provider_checkpoints",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      target_attempt_id: attemptId,
      expected_entity_version: 2,
      expected_evidence_sha256: evidenceSha256,
      expected_deepseek_model: "deepseek-v4-flash",
      expected_gemini_model: "gemini-3.1-flash-lite",
      expected_evaluator_contract_version: evaluatorContractVersion,
      expected_prompt_contract_version: promptContractVersion,
    },
  });
});

Deno.test("checkpoint hash mismatch fails closed before replay", async () => {
  const checkpointStore = store(client(async () => ({
    data: [{
      job_id: jobId,
      attempt_id: attemptId,
      entity_version: 2,
      evaluator_contract_version: evaluatorContractVersion,
      prompt_contract_version: promptContractVersion,
      evidence_sha256: evidenceSha256,
      provider_name: "deepseek",
      provider_model: "deepseek-v4-flash",
      verdict_sha256: "b".repeat(64),
      normalized_verdict: [review],
    }],
    error: null,
  })));
  try {
    await checkpointStore.load({
      evidenceSha256,
      deepSeekModel: "deepseek-v4-flash",
      geminiModel: "gemini-3.1-flash-lite",
      evaluatorContractVersion,
      promptContractVersion,
    });
  } catch (error) {
    assert(
      error instanceof WorksheetAnswerEvaluationError,
      "Expected a structured checkpoint error.",
    );
    assertEquals(error.safeCode, "worksheet_answer_checkpoint_replay_mismatch");
    assertEquals(error.retryable, false);
    return;
  }
  throw new Error("Expected hash mismatch to fail closed.");
});

Deno.test("database stale or evidence mismatch cannot become an empty checkpoint", async () => {
  const checkpointStore = store(client(async () => ({
    data: null,
    error: { code: "55000" },
  })));
  try {
    await checkpointStore.load({
      evidenceSha256,
      deepSeekModel: "deepseek-v4-flash",
      geminiModel: "gemini-3.1-flash-lite",
      evaluatorContractVersion,
      promptContractVersion,
    });
  } catch (error) {
    assert(
      error instanceof WorksheetAnswerEvaluationError,
      "Expected a structured checkpoint error.",
    );
    assertEquals(error.safeCode, "worksheet_answer_checkpoint_replay_mismatch");
    assertEquals(error.retryable, false);
    return;
  }
  throw new Error("Expected database mismatch to fail closed.");
});

Deno.test("saving a verdict is idempotently bound to provider, model, and hash", async () => {
  const verdictSha256 = await canonicalJsonSha256([review]);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const checkpointStore = store(client(async (name, args) => {
    calls.push({ name, args });
    return {
      data: [{
        provider_name: "deepseek",
        provider_model: "deepseek-v4-flash",
        evaluator_contract_version: evaluatorContractVersion,
        prompt_contract_version: promptContractVersion,
        evidence_sha256: evidenceSha256,
        verdict_sha256: verdictSha256,
        normalized_verdict: [review],
        created: true,
      }],
      error: null,
    };
  }));
  await checkpointStore.save({
    evidenceSha256,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    verdictSha256,
    reviews: [review],
    usage,
    evaluatorContractVersion,
    promptContractVersion,
  });
  assertEquals(calls[0], {
    name: "save_worksheet_answer_provider_checkpoint",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      target_attempt_id: attemptId,
      expected_entity_version: 2,
      target_evidence_sha256: evidenceSha256,
      target_provider_name: "deepseek",
      target_provider_model: "deepseek-v4-flash",
      target_verdict_sha256: verdictSha256,
      target_normalized_verdict: [review],
      target_call_key: usage.call_key,
      target_provider_model_version: usage.provider_model_version,
      target_billed_input_tokens: usage.input_tokens,
      target_billed_output_tokens: usage.output_tokens,
      target_billed_cached_input_tokens: usage.cached_input_tokens,
      target_billed_uncached_input_tokens: usage.uncached_input_tokens,
      target_evaluator_contract_version: evaluatorContractVersion,
      target_prompt_contract_version: promptContractVersion,
    },
  });
});

Deno.test("jsonb key reordering preserves every review hash through save and replay", async () => {
  const reviews: WorksheetAnswerCompletionReview[] = [
    review,
    {
      ...review,
      question_id: "55555555-5555-4555-8555-555555555555",
      review_status: "partially_correct",
      points_awarded: 0.5,
      feedback_text: "Die Kasuswahl ist noch nicht vollständig richtig.",
      corrected_answer: "Ich helfe dem Mann.",
      short_reason: "Der Dativ muss vollständig markiert sein.",
    },
    {
      ...review,
      question_id: "66666666-6666-4666-8666-666666666666",
      review_status: "incorrect",
      points_awarded: 0,
      feedback_text: "Die Antwort verwendet nicht den geforderten Dativ.",
      corrected_answer: "Ich helfe dem Mann.",
      short_reason: "Die Zielgrammatik fehlt in der Antwort.",
    },
  ];
  const reorderedReviews = reviews.map((item) =>
    Object.fromEntries(
      Object.entries(item).reverse(),
    ) as WorksheetAnswerCompletionReview
  );
  assert(
    JSON.stringify(reorderedReviews) !== JSON.stringify(reviews),
    "The regression fixture must model JSONB object-key reordering.",
  );
  const verdictSha256 = await canonicalJsonSha256(reviews);
  assertEquals(
    await canonicalJsonSha256(reorderedReviews),
    verdictSha256,
  );

  const checkpointStore = store(client(async (name, args) => {
    if (name === "save_worksheet_answer_provider_checkpoint") {
      assertEquals(args.target_verdict_sha256, verdictSha256);
      assertEquals(args.target_normalized_verdict, reviews);
      return {
        data: [{
          provider_name: "deepseek",
          provider_model: "deepseek-v4-flash",
          evaluator_contract_version: evaluatorContractVersion,
          prompt_contract_version: promptContractVersion,
          evidence_sha256: evidenceSha256,
          verdict_sha256: verdictSha256,
          normalized_verdict: reorderedReviews,
          created: true,
        }],
        error: null,
      };
    }
    assertEquals(name, "get_worksheet_answer_provider_checkpoints");
    return {
      data: [{
        job_id: jobId,
        attempt_id: attemptId,
        entity_version: 2,
        evaluator_contract_version: evaluatorContractVersion,
        prompt_contract_version: promptContractVersion,
        evidence_sha256: evidenceSha256,
        provider_name: "deepseek",
        provider_model: "deepseek-v4-flash",
        verdict_sha256: verdictSha256,
        normalized_verdict: reorderedReviews,
      }],
      error: null,
    };
  }));

  await checkpointStore.save({
    evidenceSha256,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    verdictSha256,
    reviews,
    usage,
    evaluatorContractVersion,
    promptContractVersion,
  });
  const replayed = await checkpointStore.load({
    evidenceSha256,
    deepSeekModel: "deepseek-v4-flash",
    geminiModel: "gemini-3.1-flash-lite",
    evaluatorContractVersion,
    promptContractVersion,
  });
  assertEquals(replayed.length, 1);
  assertEquals(replayed[0]?.verdictSha256, verdictSha256);
  assertEquals(
    await canonicalJsonSha256(replayed[0]?.reviews),
    verdictSha256,
  );
});

Deno.test("contract-version drift fails closed before provider verdict replay", async () => {
  const verdictSha256 = await canonicalJsonSha256([review]);
  const checkpointStore = store(client(async () => ({
    data: [{
      job_id: jobId,
      attempt_id: attemptId,
      entity_version: 2,
      evaluator_contract_version: evaluatorContractVersion,
      prompt_contract_version: 2,
      evidence_sha256: evidenceSha256,
      provider_name: "deepseek",
      provider_model: "deepseek-v4-flash",
      verdict_sha256: verdictSha256,
      normalized_verdict: [review],
    }],
    error: null,
  })));

  try {
    await checkpointStore.load({
      evidenceSha256,
      deepSeekModel: "deepseek-v4-flash",
      geminiModel: "gemini-3.1-flash-lite",
      evaluatorContractVersion,
      promptContractVersion,
    });
  } catch (error) {
    assert(
      error instanceof WorksheetAnswerEvaluationError,
      "Expected a structured checkpoint error.",
    );
    assertEquals(error.safeCode, "worksheet_answer_checkpoint_replay_mismatch");
    assertEquals(error.retryable, false);
    return;
  }
  throw new Error("Expected contract-version drift to fail closed.");
});

Deno.test("Pro adjudication survives JSONB key reordering with exact atomic usage", async () => {
  const payload: WorksheetAnswerProCheckpointPayload = {
    deepseek_result_sha256: "b".repeat(64),
    gemini_result_sha256: "c".repeat(64),
    resolutions: [{
      question_ref: "q1",
      resolution_status: "resolved",
      selected_evidence: "gemini",
      short_reason: "Die Gemini-Bewertung entspricht der Zielgrammatik.",
    }],
  };
  const reorderedPayload = {
    resolutions: payload.resolutions.map((resolution) =>
      Object.fromEntries(Object.entries(resolution).reverse())
    ),
    gemini_result_sha256: payload.gemini_result_sha256,
    deepseek_result_sha256: payload.deepseek_result_sha256,
  } as unknown as WorksheetAnswerProCheckpointPayload;
  assert(
    JSON.stringify(reorderedPayload) !== JSON.stringify(payload),
    "The regression fixture must model JSONB object-key reordering.",
  );
  const verdictSha256 = await canonicalJsonSha256(payload);
  assertEquals(await canonicalJsonSha256(reorderedPayload), verdictSha256);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const checkpointStore = store(client(async (name, args) => {
    calls.push({ name, args });
    if (name === "save_worksheet_answer_adjudication_checkpoint") {
      return {
        data: [{
          provider_name: "deepseek",
          provider_model: "deepseek-v4-pro",
          evaluator_contract_version: evaluatorContractVersion,
          prompt_contract_version: promptContractVersion,
          evidence_sha256: evidenceSha256,
          verdict_sha256: verdictSha256,
          normalized_verdict: reorderedPayload,
          created: true,
        }],
        error: null,
      };
    }
    assertEquals(name, "get_worksheet_answer_adjudication_checkpoint");
    return {
      data: [{
        job_id: jobId,
        attempt_id: attemptId,
        entity_version: 2,
        evaluator_contract_version: evaluatorContractVersion,
        prompt_contract_version: promptContractVersion,
        evidence_sha256: evidenceSha256,
        provider_name: "deepseek",
        provider_model: "deepseek-v4-pro",
        verdict_sha256: verdictSha256,
        normalized_verdict: reorderedPayload,
      }],
      error: null,
    };
  }));

  await checkpointStore.saveAdjudication({
    evidenceSha256,
    model: "deepseek-v4-pro",
    verdictSha256,
    payload,
    usage: proUsage,
    evaluatorContractVersion,
    promptContractVersion,
  });
  const replayed = await checkpointStore.loadAdjudication({
    evidenceSha256,
    model: "deepseek-v4-pro",
    evaluatorContractVersion,
    promptContractVersion,
  });

  assertEquals(replayed?.verdictSha256, verdictSha256);
  assertEquals(await canonicalJsonSha256(replayed?.payload), verdictSha256);
  assertEquals(calls[0], {
    name: "save_worksheet_answer_adjudication_checkpoint",
    args: {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      target_attempt_id: attemptId,
      expected_entity_version: 2,
      target_evidence_sha256: evidenceSha256,
      target_provider_model: "deepseek-v4-pro",
      target_verdict_sha256: verdictSha256,
      target_normalized_verdict: payload,
      target_call_key: proUsage.call_key,
      target_provider_model_version: proUsage.provider_model_version,
      target_billed_input_tokens: proUsage.input_tokens,
      target_billed_output_tokens: proUsage.output_tokens,
      target_billed_cached_input_tokens: proUsage.cached_input_tokens,
      target_billed_uncached_input_tokens: proUsage.uncached_input_tokens,
      target_evaluator_contract_version: evaluatorContractVersion,
      target_prompt_contract_version: promptContractVersion,
    },
  });
});
