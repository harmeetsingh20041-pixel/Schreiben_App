import type { GeneratedWorksheetCompletion } from "../_shared/worksheet-generation.ts";
import type {
  WorkerApiClient,
  WorkerRpcResult,
} from "../_shared/worker-api.ts";
import {
  advanceWorksheetGenerationFallback,
  advanceWorksheetGenerationRepair,
  loadWorksheetGenerationCheckpoint,
  saveWorksheetGenerationCandidate,
  saveWorksheetGenerationCompletion,
  saveWorksheetGenerationCriticEvidence,
} from "./checkpoint.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const jobId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
const verdictHash = "b".repeat(64);
const deepSeekEvidence = {
  provider: "deepseek" as const,
  model: "deepseek-v4-flash",
  candidate_sha256: hash,
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
  verdict_sha256: verdictHash,
};
const deepSeekUsage = {
  provider: "deepseek" as const,
  requested_model: "deepseek-v4-flash",
  provider_model_version: "deepseek-v4-flash",
  input_tokens: 321,
  output_tokens: 87,
  cached_input_tokens: 120,
  uncached_input_tokens: 201,
  call_purpose: "worksheet_critique" as const,
  call_key: `worksheet_generation:job_${jobId}:candidate_1:deepseek:critique`,
};
const lease = {
  jobId,
  queueMessageId: "42",
  workerId,
  entityVersion: 3,
};

function client(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<WorkerRpcResult>,
) {
  return {
    schema(schema: string) {
      assertEquals(schema, "api");
      return {
        rpc(name: string, args: Record<string, unknown>) {
          const request = implementation(name, args);
          return Object.assign(request, {
            abortSignal: async (_signal: AbortSignal) => await request,
          });
        },
      };
    },
  } as WorkerApiClient;
}

Deno.test("an absent private checkpoint means primary generation", async () => {
  const admin = client(async (name, args) => {
    assertEquals(name, "get_worksheet_generation_checkpoint");
    assertEquals(args, {
      target_job_id: jobId,
      target_queue_message_id: "42",
      worker_id: workerId,
      expected_entity_version: 3,
    });
    return { data: [], error: null };
  });
  assertEquals(
    await loadWorksheetGenerationCheckpoint({ admin, ...lease }),
    null,
  );
});

Deno.test(
  "a repair-critique checkpoint is normalized without exposing it",
  async () => {
    const candidate = { schema_version: 1, mode: "generated" };
    const primaryRejection = { attempt_number: 1 };
    const admin = client(async () => ({
      data: [
        {
          job_id: jobId,
          assignment_id: assignmentId,
          entity_version: 3,
          stage: "repair_critique",
          candidate_attempt: 2,
          candidate_provider: "gemini",
          candidate_model: "gemini-3.1-flash-lite",
          candidate_sha256: hash,
          candidate,
          primary_rejection: primaryRejection,
          completion_payload: null,
          deepseek_critic_evidence: deepSeekEvidence,
          gemini_critic_evidence: null,
        },
      ],
      error: null,
    }));
    const checkpoint = await loadWorksheetGenerationCheckpoint({
      admin,
      ...lease,
    });
    assert(checkpoint, "Expected one normalized checkpoint.");
    assertEquals(checkpoint.stage, "repair_critique");
    assertEquals(checkpoint.candidateAttempt, 2);
    assertEquals(checkpoint.candidate, candidate);
    assertEquals(checkpoint.primaryRejection, primaryRejection);
    assertEquals(checkpoint.criticEvidence.deepseek, deepSeekEvidence);
    assertEquals(checkpoint.criticEvidence.gemini, null);
  },
);

Deno.test(
  "a repair-generation checkpoint carries slot two without content",
  async () => {
    const primaryRejection = { attempt_number: 1 };
    const admin = client(async () => ({
      data: [
        {
          job_id: jobId,
          assignment_id: assignmentId,
          entity_version: 3,
          stage: "repair_generation",
          candidate_attempt: 2,
          candidate_provider: null,
          candidate_model: null,
          candidate_sha256: null,
          candidate: null,
          primary_rejection: primaryRejection,
          completion_payload: null,
        },
      ],
      error: null,
    }));
    const checkpoint = await loadWorksheetGenerationCheckpoint({
      admin,
      ...lease,
    });
    assert(checkpoint, "Expected one normalized checkpoint.");
    assertEquals(checkpoint.stage, "repair_generation");
    assertEquals(checkpoint.candidateAttempt, 2);
    assertEquals(checkpoint.candidate, null);
    assertEquals(checkpoint.primaryRejection, primaryRejection);
  },
);

Deno.test(
  "a primary fallback checkpoint carries slot one without content",
  async () => {
    const admin = client(async () => ({
      data: [
        {
          job_id: jobId,
          assignment_id: assignmentId,
          entity_version: 3,
          stage: "primary_fallback_generation",
          candidate_attempt: 1,
          candidate_provider: null,
          candidate_model: null,
          candidate_sha256: null,
          candidate: null,
          fallback_failure_code: "worksheet_provider_timeout",
          primary_rejection: null,
          completion_payload: null,
        },
      ],
      error: null,
    }));
    const checkpoint = await loadWorksheetGenerationCheckpoint({
      admin,
      ...lease,
    });
    assert(checkpoint, "Expected one normalized checkpoint.");
    assertEquals(checkpoint.stage, "primary_fallback_generation");
    assertEquals(checkpoint.candidateAttempt, 1);
    assertEquals(checkpoint.primaryFailureCode, "worksheet_provider_timeout");
    assertEquals(checkpoint.primaryRejection, null);
  },
);

Deno.test(
  "stale generation-version evidence is rejected before replay",
  async () => {
    const admin = client(async () => ({
      data: [
        {
          job_id: jobId,
          assignment_id: assignmentId,
          entity_version: 4,
          stage: "primary_critique",
          candidate_attempt: 1,
          candidate_provider: "deepseek",
          candidate_model: "deepseek-v4-pro",
          candidate_sha256: hash,
          candidate: { schema_version: 1, mode: "generated" },
          primary_rejection: null,
          completion_payload: null,
          deepseek_critic_evidence: deepSeekEvidence,
          gemini_critic_evidence: null,
        },
      ],
      error: null,
    }));
    let failure: unknown;
    try {
      await loadWorksheetGenerationCheckpoint({ admin, ...lease });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error &&
        (failure as { safeCode?: string }).safeCode ===
          "worksheet_checkpoint_response_invalid",
      "A different entity version must never load critic evidence.",
    );
  },
);

Deno.test(
  "candidate and completion writes bind the exact active lease",
  async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const completion = {
      schema_version: 1,
      mode: "generated",
    } as GeneratedWorksheetCompletion;
    const admin = client(async (name, args) => {
      calls.push({ name, args });
      if (name === "save_worksheet_generation_candidate") {
        return {
          data: [
            {
              stage: "primary_critique",
              candidate_attempt: 1,
              candidate_sha256: hash,
              created: true,
            },
          ],
          error: null,
        };
      }
      return {
        data: [{ stage: "completion", replayed: false }],
        error: null,
      };
    });
    await saveWorksheetGenerationCandidate({
      admin,
      ...lease,
      candidateAttempt: 1,
      candidateSha256: hash,
      candidate: completion,
    });
    await saveWorksheetGenerationCompletion({
      admin,
      ...lease,
      completion,
    });
    assertEquals(
      calls.map((call) => call.name),
      [
        "save_worksheet_generation_candidate",
        "save_worksheet_generation_completion",
      ],
    );
    for (const call of calls) {
      assertEquals(call.args.target_job_id, jobId);
      assertEquals(call.args.target_queue_message_id, "42");
      assertEquals(call.args.worker_id, workerId);
      assertEquals(call.args.expected_entity_version, 3);
    }
    assertEquals(calls[0]?.args.target_candidate_attempt, 1);
    assertEquals(calls[0]?.args.target_candidate_sha256, hash);
    assertEquals(calls[0]?.args.candidate_payload, completion);
    assertEquals(calls[1]?.args.target_completion_payload, completion);
  },
);

Deno.test(
  "critic evidence and usage bind one exact candidate and active lease",
  async () => {
    const admin = client(async (name, args) => {
      assertEquals(name, "save_worksheet_generation_critic_evidence");
      assertEquals(args, {
        target_job_id: jobId,
        target_queue_message_id: "42",
        worker_id: workerId,
        expected_entity_version: 3,
        target_candidate_attempt: 1,
        target_candidate_sha256: hash,
        critic_provider: "deepseek",
        critic_model: "deepseek-v4-flash",
        target_verdict_sha256: verdictHash,
        verdict_payload: deepSeekEvidence,
        target_call_key: deepSeekUsage.call_key,
        target_provider_model_version: "deepseek-v4-flash",
        target_billed_input_tokens: 321,
        target_billed_output_tokens: 87,
        target_billed_cached_input_tokens: 120,
        target_billed_uncached_input_tokens: 201,
      });
      return {
        data: [
          {
            provider: "deepseek",
            candidate_sha256: hash,
            verdict_sha256: verdictHash,
            replayed: false,
          },
        ],
        error: null,
      };
    });
    await saveWorksheetGenerationCriticEvidence({
      admin,
      ...lease,
      candidateAttempt: 1,
      candidateSha256: hash,
      evidence: deepSeekEvidence,
      usage: deepSeekUsage,
    });
  },
);

Deno.test("the exact retry critic call identity is accepted", async () => {
  const retryCallKey = `${deepSeekUsage.call_key}_retry`;
  const admin = client(async (name, args) => {
    assertEquals(name, "save_worksheet_generation_critic_evidence");
    assertEquals(args.target_call_key, retryCallKey);
    return {
      data: [
        {
          provider: "deepseek",
          candidate_sha256: hash,
          verdict_sha256: verdictHash,
          replayed: false,
        },
      ],
      error: null,
    };
  });
  await saveWorksheetGenerationCriticEvidence({
    admin,
    ...lease,
    candidateAttempt: 1,
    candidateSha256: hash,
    evidence: deepSeekEvidence,
    usage: { ...deepSeekUsage, call_key: retryCallKey },
  });
});

Deno.test(
  "a lost RPC response can replay the exact atomic critic save",
  async () => {
    let calls = 0;
    let committedArgs: Record<string, unknown> | null = null;
    const admin = client(async (_name, args) => {
      calls += 1;
      if (calls === 1) {
        committedArgs = args;
        throw new Error("response_lost_after_commit");
      }
      assertEquals(args, committedArgs);
      return {
        data: [
          {
            provider: "deepseek",
            candidate_sha256: hash,
            verdict_sha256: verdictHash,
            replayed: true,
          },
        ],
        error: null,
      };
    });
    let firstFailure: unknown;
    try {
      await saveWorksheetGenerationCriticEvidence({
        admin,
        ...lease,
        candidateAttempt: 1,
        candidateSha256: hash,
        evidence: deepSeekEvidence,
        usage: deepSeekUsage,
      });
    } catch (error) {
      firstFailure = error;
    }
    assert(
      firstFailure instanceof Error &&
        (firstFailure as { safeCode?: string }).safeCode ===
          "worksheet_checkpoint_unavailable",
      "A lost acknowledgement must remain retryable.",
    );
    await saveWorksheetGenerationCriticEvidence({
      admin,
      ...lease,
      candidateAttempt: 1,
      candidateSha256: hash,
      evidence: deepSeekEvidence,
      usage: deepSeekUsage,
    });
    assertEquals(calls, 2);
  },
);

Deno.test(
  "critic usage mismatches fail before the checkpoint RPC",
  async () => {
    let rpcCalls = 0;
    const admin = client(async () => {
      rpcCalls += 1;
      return { data: [], error: null };
    });
    for (const usage of [
      { ...deepSeekUsage, provider: "gemini" as const },
      { ...deepSeekUsage, provider_model_version: "deepseek-v4-pro" },
      { ...deepSeekUsage, call_purpose: "worksheet_generation" as const },
      { ...deepSeekUsage, input_tokens: 320 },
      {
        ...deepSeekUsage,
        call_key: `worksheet_generation:job_${jobId}:candidate_2:deepseek:critique`,
      },
      { ...deepSeekUsage, call_key: "worksheet_generation:critic" },
    ]) {
      let failure: unknown;
      try {
        await saveWorksheetGenerationCriticEvidence({
          admin,
          ...lease,
          candidateAttempt: 1,
          candidateSha256: hash,
          evidence: deepSeekEvidence,
          usage,
        });
      } catch (error) {
        failure = error;
      }
      assert(
        failure instanceof Error &&
          (failure as { safeCode?: string }).safeCode ===
            "worksheet_checkpoint_critic_usage_invalid" &&
          !(failure as { retryable?: boolean }).retryable,
        "A mismatched usage envelope must fail permanently before persistence.",
      );
    }
    assertEquals(rpcCalls, 0);
  },
);

Deno.test(
  "critic attempts are required before the checkpoint RPC",
  async () => {
    let rpcCalls = 0;
    const admin = client(async () => {
      rpcCalls += 1;
      return { data: [], error: null };
    });
    let failure: unknown;
    try {
      await saveWorksheetGenerationCriticEvidence({
        admin,
        ...lease,
        candidateAttempt: null as never,
        candidateSha256: hash,
        evidence: deepSeekEvidence,
        usage: deepSeekUsage,
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error &&
        (failure as { safeCode?: string }).safeCode ===
          "worksheet_checkpoint_critic_usage_invalid" &&
        !(failure as { retryable?: boolean }).retryable,
      "A missing candidate attempt must fail permanently before persistence.",
    );
    assertEquals(rpcCalls, 0);
  },
);

Deno.test(
  "database critic replay or spend mismatch fails permanently",
  async () => {
    const admin = client(async () => ({
      data: null,
      error: {
        code: "55000",
        message: "worksheet_checkpoint_critic_spend_mismatch",
      },
    }));
    let failure: unknown;
    try {
      await saveWorksheetGenerationCriticEvidence({
        admin,
        ...lease,
        candidateAttempt: 1,
        candidateSha256: hash,
        evidence: deepSeekEvidence,
        usage: deepSeekUsage,
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error &&
        (failure as { safeCode?: string }).safeCode ===
          "worksheet_checkpoint_critic_evidence_mismatch" &&
        !(failure as { retryable?: boolean }).retryable,
      "A database replay or reservation mismatch must not poison the retry lane.",
    );
  },
);

Deno.test(
  "repair continuation returns only the durable retry transition",
  async () => {
    const rejectedCandidate = {
      attempt_number: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      rejection_reasons: ["Ambiguous."],
      candidate: { schema_version: 1, mode: "generated" },
    } as const;
    const transition = [
      {
        job_id: jobId,
        status: "retry",
        stage: "repair_generation",
        attempt_count: 1,
        next_attempt_at: "2026-07-12T12:00:00.000Z",
        replayed: false,
      },
    ];
    const admin = client(async (name, args) => {
      assertEquals(name, "advance_worksheet_generation_repair");
      assertEquals(
        args.rejected_candidate_payload,
        rejectedCandidate.candidate,
      );
      return { data: transition, error: null };
    });
    assertEquals(
      await advanceWorksheetGenerationRepair({
        admin,
        ...lease,
        rejectedCandidate: rejectedCandidate as never,
      }),
      transition,
    );
  },
);

Deno.test(
  "primary outage continuation returns a distinct durable retry stage",
  async () => {
    const transition = [
      {
        job_id: jobId,
        status: "retry",
        stage: "primary_fallback_generation",
        attempt_count: 1,
        next_attempt_at: "2026-07-12T12:00:00.000Z",
        replayed: false,
      },
    ];
    const admin = client(async (name, args) => {
      assertEquals(name, "advance_worksheet_generation_fallback");
      assertEquals(args.primary_failure_code, "worksheet_provider_timeout");
      return { data: transition, error: null };
    });
    assertEquals(
      await advanceWorksheetGenerationFallback({
        admin,
        ...lease,
        primaryFailureCode: "worksheet_provider_timeout",
      }),
      transition,
    );
  },
);
