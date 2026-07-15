import {
  certifiedBankReasonForGenerationFailure,
  prepareWorksheetCompletion,
  resolveWorksheetLevel,
} from "./prepare.ts";
import {
  type GeneratedWorksheetCompletion,
  type WorksheetCriticEvidence,
  WorksheetGenerationError,
  type WorksheetProviderCallIdentity,
  type WorksheetProviderLifecycleHooks,
} from "../_shared/worksheet-generation.ts";
import { createOptionalGeminiSecondaryProvider } from "../_shared/chat-completion-provider.ts";
import type { SupabaseAdminClient } from "../_shared/writing-feedback.ts";
import {
  type WorksheetGenerationCheckpoint,
  WorksheetPrimaryFallbackContinuation,
  WorksheetRepairContinuation,
} from "./checkpoint.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

const activeLease = {
  jobId: "71111111-1111-4111-8111-111111111111",
  queueMessageId: "42",
  workerId: "72222222-2222-4222-8222-222222222222",
  entityVersion: 1,
  checkpointStore: {
    load: async () => null,
    saveCandidate: async () => undefined,
    saveCriticEvidence: async () => undefined,
    saveCompletion: async () => undefined,
  },
};

function worksheetCurriculumFromRequest(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    messages?: Array<{ content?: string }>;
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
  };
  const user =
    body.messages?.[1]?.content ??
    body.contents
      ?.flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? "")
      .join("\n") ??
    "";
  const startMarker = "UNTRUSTED_CURRICULUM_CONTEXT_JSON:\n";
  const endMarker = "\nEND_UNTRUSTED_CURRICULUM_CONTEXT_JSON";
  const start = user.indexOf(startMarker) + startMarker.length;
  const end = user.indexOf(endMarker, start);
  if (start < startMarker.length || end <= start) {
    throw new Error("Worksheet request is missing its inert curriculum value.");
  }
  return JSON.parse(user.slice(start, end)) as {
    level: string;
    topic: { name: string; slug: string; description: string };
    accepted_question_fragments?: Array<{ question_number: number }>;
    quarantined_question_numbers?: number[];
  };
}

type PrepareCheckpointStore = NonNullable<
  Parameters<typeof prepareWorksheetCompletion>[0]["checkpointStore"]
>;

const resumableAssignmentId = "91111111-1111-4111-8111-111111111111";
const resumableWorkspaceId = "92222222-2222-4222-8222-222222222222";
const resumableTopicId = "93333333-3333-4333-8333-333333333333";

function resumableQuestion(
  number: number,
  type: string,
  prompt: string,
  answer: string,
  options: string[] = [],
) {
  const localExact = ["multiple_choice", "fill_blank"].includes(type);
  return {
    question_number: number,
    question_type: type,
    evaluation_mode: localExact ? "local_exact" : "open_evaluation",
    prompt,
    options,
    correct_answer: answer,
    accepted_answers: localExact ? [answer] : [],
    rubric: localExact
      ? null
      : {
          criteria: [
            "The response must use the requested structure correctly.",
          ],
          sample_answer: answer,
        },
    explanation: `Explanation for exercise number ${number}.`,
  };
}

function resumableProviderWorksheet() {
  return {
    title: "Akkusativ im Alltag",
    level: "A1",
    difficulty: "easy",
    mini_lesson: {
      short_explanation: "The accusative marks the direct object.",
      key_rule: "Masculine der changes to den in the accusative.",
      correct_examples: ["Ich sehe den Hund.", "Sie kauft einen Apfel."],
      common_mistake_warning:
        "Check the role of the noun before choosing an article.",
      what_to_revise: "Review masculine articles in direct-object phrases.",
    },
    questions: [
      resumableQuestion(
        1,
        "multiple_choice",
        "Choose the article: Ich sehe ___ Hund.",
        "den",
        ["der", "den", "dem"],
      ),
      resumableQuestion(
        2,
        "multiple_choice",
        "Choose the article: Er kauft ___ Apfel.",
        "einen",
        ["ein", "einen", "einem"],
      ),
      resumableQuestion(
        3,
        "fill_blank",
        "Wortbank: [einen, einem, einer]. Ergänze: Wir haben ___ Tisch.",
        "einen",
      ),
      resumableQuestion(
        4,
        "fill_blank",
        "Wortbank: [einen, einem, einer]. Ergänze: Sie braucht ___ Stuhl.",
        "einen",
      ),
      resumableQuestion(
        5,
        "fill_blank",
        "Wortbank: [den, dem, der]. Ergänze: Ich finde ___ Schlüssel.",
        "den",
      ),
      resumableQuestion(
        6,
        "sentence_correction",
        "Correct the full sentence: Ich sehe der Mann.",
        "Ich sehe den Mann.",
      ),
      resumableQuestion(
        7,
        "transformation",
        "Rewrite with the noun Hund: Ich sehe die Katze.",
        "Ich sehe den Hund.",
      ),
      resumableQuestion(
        8,
        "word_order",
        "Build the full sentence from: den Ball - das Kind - sieht",
        "Das Kind sieht den Ball.",
      ),
    ],
  };
}

function resumableMcqSafeProviderWorksheet() {
  const worksheet = resumableProviderWorksheet();
  worksheet.title = "Akkusativ sicher auswählen";
  worksheet.questions = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    const answer = number % 2 === 0 ? "einen" : "den";
    return resumableQuestion(
      number,
      "multiple_choice",
      `Aufgabe ${number}: Wähle den eindeutigen maskulinen Akkusativartikel für das direkte Objekt.`,
      answer,
      answer === "den" ? ["der", "den", "dem"] : ["ein", "einen", "einem"],
    );
  });
  return worksheet;
}

function resumableRejectedCompletion(): GeneratedWorksheetCompletion {
  const worksheet = resumableProviderWorksheet();
  return {
    schema_version: 1,
    mode: "generated",
    generation_source: "gemini",
    generator_model: "gemini-3.1-flash-lite",
    title: worksheet.title,
    level: "A1",
    difficulty: "easy",
    description: "Targeted accusative practice.",
    mini_lesson: worksheet.mini_lesson,
    questions: worksheet.questions as GeneratedWorksheetCompletion["questions"],
    source_mix: { mode: "gemini", deepseek_count: 0, gemini_count: 8 },
    validation: {
      deterministic: true,
      independent_model: false,
      critic_model: "deepseek-v4-flash",
      candidate_sha256: "a".repeat(64),
      critics: { deepseek: null, gemini: null },
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
      rejection_reasons: [
        "ambiguity_free: question 4 permits two valid answers.",
      ],
    },
  };
}

function resumableProviderUsage() {
  return {
    prompt_tokens: 30,
    completion_tokens: 10,
    total_tokens: 40,
  };
}

function resumableDeepSeekGenerationResponse(
  worksheet = resumableMcqSafeProviderWorksheet(),
) {
  return Response.json({
    model: "deepseek-v4-pro",
    usage: resumableProviderUsage(),
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify(worksheet),
        },
      },
    ],
  });
}

function resumableGeminiResponse(model: string, content: string) {
  return Response.json({
    modelVersion: model,
    candidates: [
      {
        index: 0,
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: content }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 30,
      candidatesTokenCount: 10,
      totalTokenCount: 40,
    },
  });
}

function resumableGeminiGenerationResponse(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
  };
  const userPrompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
  return resumableGeminiResponse(
    "gemini-3.1-flash-lite",
    JSON.stringify(
      userPrompt.includes("WORKSHEET_GENERATION_PROFILE:\nmcq_safe")
        ? resumableMcqSafeProviderWorksheet()
        : resumableProviderWorksheet(),
    ),
  );
}

function resumableCandidateHash(init?: RequestInit) {
  const candidateSha256 = String(init?.body ?? "").match(/[a-f0-9]{64}/)?.[0];
  if (!candidateSha256) {
    throw new Error("Expected a candidate hash in the critic request.");
  }
  return candidateSha256;
}

function resumableCriticChecks(approved: boolean) {
  return {
    ambiguity_free: approved,
    no_answer_leakage: true,
    duplicate_free: true,
    level_fit: true,
    topic_fit: true,
    type_balance: true,
    scoring_safe: true,
  };
}

function resumableCriticContentChecks() {
  return {
    mini_lesson_scope_accurate: true,
    learner_cues_semantically_aligned: true,
    examples_rubrics_consistent: true,
  };
}

function resumableCriticContent(
  init: RequestInit | undefined,
  approved: boolean,
) {
  return JSON.stringify({
    candidate_sha256: resumableCandidateHash(init),
    approved,
    checks: resumableCriticChecks(approved),
    content_checks: resumableCriticContentChecks(),
    rejection_reasons: approved
      ? []
      : ["ambiguity_free: question 4 permits two valid answers."],
  });
}

function resumableDeepSeekCriticResponse(
  init: RequestInit | undefined,
  approved: boolean,
) {
  return Response.json({
    model: "deepseek-v4-flash",
    usage: resumableProviderUsage(),
    choices: [
      {
        finish_reason: "stop",
        message: { content: resumableCriticContent(init, approved) },
      },
    ],
  });
}

function resumableGeminiRequestKind(
  init?: RequestInit,
): "generation" | "critique" {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    systemInstruction?: { parts?: Array<{ text?: string }> };
    generationConfig?: {
      responseJsonSchema?: { properties?: Record<string, unknown> };
    };
  };
  const properties =
    body.generationConfig?.responseJsonSchema?.properties ?? {};
  if (
    Object.hasOwn(properties, "candidate_sha256") &&
    Object.hasOwn(properties, "approved")
  ) {
    return "critique";
  }
  if (
    Object.hasOwn(properties, "title") &&
    Object.hasOwn(properties, "questions")
  ) {
    return "generation";
  }
  if (
    body.generationConfig?.responseJsonSchema === undefined &&
    body.systemInstruction?.parts?.some((part) =>
      part.text?.includes("You design German-language practice worksheets"),
    )
  ) {
    return "generation";
  }
  throw new Error("Unrecognized Gemini worksheet request schema.");
}

function resumableAdmin(args?: { certifiedRevisionId?: () => string | null }) {
  return {
    schema: (schema: string) => ({
      rpc: async (name: string, rpcArgs: Record<string, unknown>) => {
        assertEquals(schema, "api");
        assertEquals(name, "get_worksheet_generation_context");
        assertEquals(rpcArgs.target_assignment_id, resumableAssignmentId);
        return {
          data: [
            {
              assignment_id: resumableAssignmentId,
              workspace_id: resumableWorkspaceId,
              grammar_topic_id: resumableTopicId,
              attached_practice_test_id: null,
              assignment_status: "unlocked",
              batch_id: "94444444-4444-4444-8444-444444444444",
              batch_name: "A1 Resumable Class",
              worksheet_level: "A1",
              topic_name: "Akkusativ",
              topic_slug: "akkusativ",
              topic_level: "A1",
              topic_description: "Direct objects and masculine article forms.",
              reusable_practice_test_id: null,
              certified_template_revision_id:
                args?.certifiedRevisionId?.() ?? null,
            },
          ],
          error: null,
        };
      },
    }),
  } as unknown as SupabaseAdminClient;
}

function resumableCheckpoint(args: {
  stage: WorksheetGenerationCheckpoint["stage"];
  candidateAttempt: 1 | 2 | null;
  candidate?: GeneratedWorksheetCompletion | null;
  candidateSha256?: string | null;
  primaryFailureCode?: WorksheetGenerationCheckpoint["primaryFailureCode"];
  primaryRejection?: unknown;
  completionPayload?: unknown;
  criticEvidence?: WorksheetGenerationCheckpoint["criticEvidence"];
}): WorksheetGenerationCheckpoint {
  const candidate = args.candidate ?? null;
  return {
    jobId: activeLease.jobId,
    assignmentId: resumableAssignmentId,
    entityVersion: activeLease.entityVersion,
    stage: args.stage,
    candidateAttempt: args.candidateAttempt,
    candidateProvider: candidate?.generation_source ?? null,
    candidateModel: candidate?.generator_model ?? null,
    candidateSha256: args.candidateSha256 ?? null,
    candidate,
    primaryFailureCode: args.primaryFailureCode ?? null,
    primaryRejection: args.primaryRejection ?? null,
    completionPayload: args.completionPayload ?? null,
    criticEvidence: args.criticEvidence ?? {
      deepseek: null,
      gemini: null,
    },
  };
}

function withResumableCriticEvidence(
  checkpoint: WorksheetGenerationCheckpoint | null,
  write: {
    candidateAttempt: 1 | 2;
    candidateSha256: string;
    evidence: WorksheetCriticEvidence;
  },
) {
  assert(checkpoint, "Critic evidence requires a persisted candidate.");
  assertEquals(checkpoint.candidateAttempt, write.candidateAttempt);
  assertEquals(checkpoint.candidateSha256, write.candidateSha256);
  return {
    ...checkpoint,
    criticEvidence: {
      ...checkpoint.criticEvidence,
      [write.evidence.provider]: write.evidence,
    },
  } satisfies WorksheetGenerationCheckpoint;
}

function callKeyCounts(calls: readonly WorksheetProviderCallIdentity[]) {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.call_key, (counts.get(call.call_key) ?? 0) + 1);
  }
  return counts;
}

function currentCheckpointStage(
  checkpoint: WorksheetGenerationCheckpoint | null,
) {
  return checkpoint?.stage ?? null;
}

function requireResumableCheckpoint(
  checkpoint: WorksheetGenerationCheckpoint | null,
) {
  if (!checkpoint) throw new Error("Expected one resumable checkpoint.");
  return checkpoint;
}

Deno.test("the immutable assignment level is accepted", () => {
  assertEquals(resolveWorksheetLevel("B2"), "B2");
});

Deno.test(
  "certified-bank fallback reasons distinguish outages from invalid content",
  () => {
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError("worksheet_provider_timeout", true),
      ),
      "provider_unavailable",
    );
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError("worksheet_fallback_invalid_json", true),
      ),
      "provider_exhausted",
    );
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError("worksheet_ambiguous_answer", true),
      ),
      "provider_exhausted",
    );
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError(
          "worksheet_dual_critics_timeout",
          true,
          true,
        ),
      ),
      "provider_unavailable",
    );
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError("worksheet_critic_timeout", true, false),
      ),
      "provider_unavailable",
    );
    assertEquals(
      certifiedBankReasonForGenerationFailure(
        new WorksheetGenerationError(
          "worksheet_fallback_critic_unavailable",
          true,
          false,
        ),
      ),
      "provider_unavailable",
    );
  },
);

Deno.test(
  "a missing assignment snapshot fails permanently before provider work",
  () => {
    let failure: unknown;
    try {
      resolveWorksheetLevel("A1_A2");
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof WorksheetGenerationError &&
        failure.safeCode === "worksheet_class_context_required" &&
        !failure.retryable,
      "A missing frozen class context must be a permanent pre-provider failure.",
    );
  },
);

Deno.test(
  "missing primary configuration skips Gemini and remains privately held without a bank revision",
  async () => {
    let secondaryCalls = 0;
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () => {
        secondaryCalls += 1;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const admin = {
      schema: () => ({
        rpc: async () => ({
          data: [
            {
              assignment_id: "61111111-1111-4111-8111-111111111111",
              workspace_id: "62222222-2222-4222-8222-222222222222",
              grammar_topic_id: "63333333-3333-4333-8333-333333333333",
              attached_practice_test_id: null,
              assignment_status: "unlocked",
              batch_id: "64444444-4444-4444-8444-444444444444",
              batch_name: "A1 Failover Class",
              worksheet_level: "A1",
              topic_name: "Akkusativ",
              topic_slug: "akkusativ",
              topic_level: "A1",
              topic_description: "Direct objects.",
              reusable_practice_test_id: null,
            },
          ],
          error: null,
        }),
      }),
    } as unknown as SupabaseAdminClient;

    let failure: unknown;
    try {
      await prepareWorksheetCompletion({
        ...activeLease,
        admin,
        assignmentId: "61111111-1111-4111-8111-111111111111",
        apiKey: null,
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        secondaryProvider,
      });
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof WorksheetGenerationError &&
        failure.safeCode === "worksheet_provider_not_configured" &&
        !failure.retryable,
      "Missing primary configuration must stay private for operator repair.",
    );
    assertEquals(secondaryCalls, 0);
  },
);

Deno.test(
  "missing primary configuration uses only a newly eligible exact-context bank revision",
  async () => {
    const revisionId = "65555555-5555-4555-8555-555555555555";
    let contextCalls = 0;
    let secondaryCalls = 0;
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () => {
        secondaryCalls += 1;
        throw new Error(
          "Gemini must not run after missing primary configuration.",
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const admin = {
      schema: () => ({
        rpc: async () => {
          contextCalls += 1;
          return {
            data: [
              {
                assignment_id: "65111111-1111-4111-8111-111111111111",
                workspace_id: "65222222-2222-4222-8222-222222222222",
                grammar_topic_id: "65333333-3333-4333-8333-333333333333",
                attached_practice_test_id: null,
                assignment_status: "unlocked",
                batch_id: "65444444-4444-4444-8444-444444444444",
                batch_name: "A2 Bank Class",
                worksheet_level: "A2",
                topic_name: "Wechselpräpositionen",
                topic_slug: "two-way-prepositions",
                topic_level: "A2",
                topic_description: "Location and direction.",
                reusable_practice_test_id: null,
                certified_template_revision_id:
                  contextCalls === 1 ? null : revisionId,
              },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseAdminClient;

    const result = await prepareWorksheetCompletion({
      ...activeLease,
      admin,
      assignmentId: "65111111-1111-4111-8111-111111111111",
      apiKey: null,
      model: "deepseek-v4-pro",
      criticModel: "deepseek-v4-flash",
      secondaryProvider,
    });

    assertEquals(result.mode, "certified_bank");
    if (result.mode === "certified_bank") {
      assertEquals(result.template_revision_id, revisionId);
      assertEquals(result.fallback_reason, "provider_exhausted");
    }
    assertEquals(contextCalls, 2);
    assertEquals(secondaryCalls, 0);
  },
);

Deno.test(
  "generation context and approved reuse load through the api facade",
  async () => {
    const assignmentId = "11111111-1111-4111-8111-111111111111";
    const reusableId = "22222222-2222-4222-8222-222222222222";
    const calls: Array<{ schema: string; name: string; args: unknown }> = [];
    const admin = {
      schema: (schema: string) => ({
        rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push({ schema, name, args });
          return {
            data: [
              {
                assignment_id: assignmentId,
                workspace_id: "33333333-3333-4333-8333-333333333333",
                grammar_topic_id: "44444444-4444-4444-8444-444444444444",
                attached_practice_test_id: null,
                assignment_status: "unlocked",
                batch_id: "55555555-5555-4555-8555-555555555555",
                batch_name: "A1 Class",
                worksheet_level: "A1",
                topic_name: "Dativ",
                topic_slug: "dativ",
                topic_level: "A1_A2",
                topic_description: "Dative forms.",
                reusable_practice_test_id: reusableId,
              },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseAdminClient;

    const result = await prepareWorksheetCompletion({
      ...activeLease,
      admin,
      assignmentId,
      apiKey: "unused-for-reuse",
      model: "deepseek-v4-pro",
      fetchImpl: async () => {
        throw new Error("Approved reuse must not call the provider.");
      },
    });

    assertEquals(result.mode, "reuse");
    if (result.mode === "reuse") {
      assertEquals(result.reusable_practice_test_id, reusableId);
    }
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.schema, "api");
    assertEquals(calls[0]?.name, "get_worksheet_generation_context");
  },
);

Deno.test(
  "an unseen exact-context certified bank revision is preferred without provider work",
  async () => {
    const revisionId = "26666666-6666-4666-8666-666666666666";
    let providerCalled = false;
    const admin = {
      schema: () => ({
        rpc: async () => ({
          data: [
            {
              assignment_id: "21111111-1111-4111-8111-111111111111",
              workspace_id: "22222222-2222-4222-8222-222222222222",
              grammar_topic_id: "23333333-3333-4333-8333-333333333333",
              attached_practice_test_id: null,
              assignment_status: "unlocked",
              batch_id: "24444444-4444-4444-8444-444444444444",
              batch_name: "A2 Bank Class",
              worksheet_level: "A2",
              topic_name: "Präpositionen",
              topic_slug: "prepositions",
              topic_level: "A1_A2",
              topic_description: "Fixed prepositional phrases.",
              reusable_practice_test_id: "25555555-5555-4555-8555-555555555555",
              certified_template_revision_id: revisionId,
            },
          ],
          error: null,
        }),
      }),
    } as unknown as SupabaseAdminClient;

    const result = await prepareWorksheetCompletion({
      ...activeLease,
      admin,
      assignmentId: "21111111-1111-4111-8111-111111111111",
      apiKey: "unused",
      model: "deepseek-v4-pro",
      fetchImpl: async () => {
        providerCalled = true;
        throw new Error("Certified bank preference must not call a provider.");
      },
    });

    assertEquals(result.mode, "certified_bank");
    if (result.mode === "certified_bank") {
      assertEquals(result.template_revision_id, revisionId);
      assertEquals(result.fallback_reason, "approved_bank_preferred");
      assertEquals(result.rejected_candidates.length, 0);
    }
    assertEquals(providerCalled, false);
  },
);

Deno.test(
  "a provider outage uses a newly eligible exact-context bank revision",
  async () => {
    const revisionId = "36666666-6666-4666-8666-666666666666";
    let contextCalls = 0;
    const admin = {
      schema: () => ({
        rpc: async () => {
          contextCalls += 1;
          return {
            data: [
              {
                assignment_id: "31111111-1111-4111-8111-111111111111",
                workspace_id: "32222222-2222-4222-8222-222222222222",
                grammar_topic_id: "33333333-3333-4333-8333-333333333333",
                attached_practice_test_id: null,
                assignment_status: "unlocked",
                batch_id: "34444444-4444-4444-8444-444444444444",
                batch_name: "B1 Bank Class",
                worksheet_level: "B1",
                topic_name: "Nebensätze",
                topic_slug: "subordinate-clauses",
                topic_level: "B1",
                topic_description: "Subordinate clause word order.",
                reusable_practice_test_id: null,
                certified_template_revision_id:
                  contextCalls === 1 ? null : revisionId,
              },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseAdminClient;
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () =>
        new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");

    const result = await prepareWorksheetCompletion({
      ...activeLease,
      admin,
      assignmentId: "31111111-1111-4111-8111-111111111111",
      apiKey: "provider-key",
      model: "deepseek-v4-pro",
      criticModel: "deepseek-v4-flash",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      secondaryProvider,
    });

    assertEquals(result.mode, "certified_bank");
    if (result.mode === "certified_bank") {
      assertEquals(result.template_revision_id, revisionId);
      assertEquals(result.fallback_reason, "provider_unavailable");
    }
    assertEquals(contextCalls, 2);
  },
);

Deno.test(
  "a historical assignment without a frozen class stops before provider work",
  async () => {
    let providerCalled = false;
    const admin = {
      schema: () => ({
        rpc: async () => ({
          data: [
            {
              assignment_id: "11111111-1111-4111-8111-111111111111",
              workspace_id: "33333333-3333-4333-8333-333333333333",
              grammar_topic_id: "44444444-4444-4444-8444-444444444444",
              attached_practice_test_id: null,
              assignment_status: "unlocked",
              batch_id: null,
              batch_name: null,
              worksheet_level: null,
              topic_name: "Shared topic",
              topic_slug: "shared-topic",
              topic_level: "A1_A2",
              topic_description: "Historical fixture.",
              reusable_practice_test_id: null,
            },
          ],
          error: null,
        }),
      }),
    } as unknown as SupabaseAdminClient;

    let failure: unknown;
    try {
      await prepareWorksheetCompletion({
        ...activeLease,
        admin,
        assignmentId: "11111111-1111-4111-8111-111111111111",
        apiKey: "provider-key",
        model: "deepseek-v4-pro",
        fetchImpl: async () => {
          providerCalled = true;
          return new Response("unavailable", { status: 503 });
        },
      });
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof WorksheetGenerationError &&
        failure.safeCode === "worksheet_class_context_required" &&
        !failure.retryable,
      "Missing class context must be held for a teacher without retrying a provider.",
    );
    assertEquals(providerCalled, false);
  },
);

Deno.test(
  "provider failure never assigns a cross-level fallback worksheet",
  async () => {
    const assignmentId = "11111111-1111-4111-8111-111111111111";
    const excludedPersonalData = [
      "PII-Student-Asha",
      "pii-student@example.invalid",
      "+91-90000-00000",
      "Patient record: insulin dosage",
      "Meine private Beispieladresse ist Geheimweg 7.",
    ];

    for (const level of ["A1", "A2", "B1", "B2"] as const) {
      let providerCalls = 0;
      let providerBody = "";
      const admin = {
        schema: (schema: string) => ({
          rpc: async (name: string) => {
            assertEquals(schema, "api");
            assertEquals(name, "get_worksheet_generation_context");
            return {
              data: [
                {
                  assignment_id: assignmentId,
                  workspace_id: "33333333-3333-4333-8333-333333333333",
                  grammar_topic_id: "44444444-4444-4444-8444-444444444444",
                  attached_practice_test_id: null,
                  assignment_status: "unlocked",
                  batch_id: "55555555-5555-4555-8555-555555555555",
                  batch_name: `${level} Class`,
                  worksheet_level: level,
                  topic_name: `Topic ${level}`,
                  topic_slug: `topic-${level.toLowerCase()}`,
                  topic_level: "A1_A2",
                  topic_description: `Curriculum metadata for ${level}.`,
                  reusable_practice_test_id: null,
                  student_name: excludedPersonalData[0],
                  student_email: excludedPersonalData[1],
                  student_phone: excludedPersonalData[2],
                  medical_context: excludedPersonalData[3],
                  student_writing: excludedPersonalData[4],
                },
              ],
              error: null,
            };
          },
        }),
      } as unknown as SupabaseAdminClient;
      const secondaryProvider = createOptionalGeminiSecondaryProvider({
        apiKey: "gemini-test-key",
        fetchImpl: (async () =>
          new Response("unavailable", { status: 503 })) as typeof fetch,
      });
      assert(
        secondaryProvider,
        "Expected configured Gemini secondary provider.",
      );

      let failure: unknown;
      try {
        await prepareWorksheetCompletion({
          ...activeLease,
          admin,
          assignmentId,
          apiKey: "provider-key",
          model: "deepseek-v4-pro",
          criticModel: "deepseek-v4-flash",
          fetchImpl: async (_input, init) => {
            providerCalls += 1;
            providerBody = String(init?.body ?? "");
            return new Response("unavailable", { status: 503 });
          },
          secondaryProvider,
        });
      } catch (error) {
        failure = error;
      }

      assert(
        failure instanceof WorksheetPrimaryFallbackContinuation &&
          failure.safeCode === "worksheet_provider_unavailable",
        `${level} must move to a fresh durable fallback stage instead of receiving cross-level content.`,
      );
      assertEquals(providerCalls, 1);
      assertEquals(
        worksheetCurriculumFromRequest({ body: providerBody }).level,
        level,
      );
      assert(
        !/system_fallback|gemini_count[^0]/i.test(providerBody),
        "The provider path must not manufacture or relabel fallback content.",
      );
      for (const personalValue of excludedPersonalData) {
        assert(
          !providerBody.includes(personalValue),
          "The provider request must exclude every injected personal-data and writing sentinel.",
        );
      }
    }
  },
);

Deno.test(
  "a malformed primary response gets one durable fallback stage without inline Gemini",
  async () => {
    let contextCalls = 0;
    let geminiCalls = 0;
    const admin = {
      schema: () => ({
        rpc: async () => {
          contextCalls += 1;
          return {
            data: [
              {
                assignment_id: "81111111-1111-4111-8111-111111111111",
                workspace_id: "82222222-2222-4222-8222-222222222222",
                grammar_topic_id: "83333333-3333-4333-8333-333333333333",
                attached_practice_test_id: null,
                assignment_status: "unlocked",
                batch_id: "84444444-4444-4444-8444-444444444444",
                batch_name: "A2 Malformed Response Class",
                worksheet_level: "A2",
                topic_name: "Satzbau",
                topic_slug: "sentence-structure",
                topic_level: "A2",
                topic_description: "Main-clause word order.",
                reusable_practice_test_id: null,
                certified_template_revision_id: null,
              },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseAdminClient;
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () => {
        geminiCalls += 1;
        throw new Error("Gemini must run only after durable requeue.");
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");

    let failure: unknown;
    try {
      await prepareWorksheetCompletion({
        ...activeLease,
        admin,
        assignmentId: "81111111-1111-4111-8111-111111111111",
        apiKey: "provider-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => new Response("not-json"),
        secondaryProvider,
      });
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof WorksheetPrimaryFallbackContinuation &&
        failure.safeCode === "worksheet_provider_response_invalid",
      "Malformed primary output must enter the bounded alternate-provider stage.",
    );
    assertEquals(contextCalls, 2);
    assertEquals(geminiCalls, 0);
  },
);

Deno.test(
  "a deterministic-invalid DeepSeek-safe candidate advances durably without inline Gemini",
  async () => {
    let geminiCalls = 0;
    const invalidSafe = resumableMcqSafeProviderWorksheet();
    invalidSafe.questions[0]!.options = ["den", "den", "dem"];
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () => {
        geminiCalls += 1;
        throw new Error("Gemini must run only after durable requeue.");
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");

    let failure: unknown;
    try {
      await prepareWorksheetCompletion({
        ...activeLease,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(invalidSafe),
        secondaryProvider,
      });
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof WorksheetPrimaryFallbackContinuation &&
        failure.safeCode === "worksheet_duplicate_options",
      "A deterministic MCQ contract failure must enter the fresh Gemini-safe stage.",
    );
    assertEquals(geminiCalls, 0);
  },
);

Deno.test(
  "a shared topic uses the A1 then B2 assignment snapshots without membership aggregation",
  async () => {
    const generatedLevels: string[] = [];
    const contexts = [
      {
        batch_id: "51111111-1111-4111-8111-111111111111",
        batch_name: "A1 Class",
        worksheet_level: "A1",
      },
      {
        batch_id: "52222222-2222-4222-8222-222222222222",
        batch_name: "B2 Class",
        worksheet_level: "B2",
      },
    ];
    const admin = {
      schema: () => ({
        rpc: async (_name: string, rpcArgs: Record<string, unknown>) => {
          const assignmentId = String(rpcArgs.target_assignment_id ?? "");
          const contextIndex = assignmentId.endsWith("1") ? 0 : 1;
          const context = contexts[contextIndex];
          return {
            data: [
              {
                assignment_id: `53333333-3333-4333-8333-33333333333${
                  contextIndex + 1
                }`,
                workspace_id: "54444444-4444-4444-8444-444444444444",
                grammar_topic_id: "55555555-5555-4555-8555-555555555555",
                attached_practice_test_id: null,
                assignment_status: "unlocked",
                ...context,
                topic_name: "Shared word order",
                topic_slug: "shared-word-order",
                topic_level: "A1_A2",
                topic_description: "Shared curriculum topic.",
                reusable_practice_test_id: null,
              },
            ],
            error: null,
          };
        },
      }),
    } as unknown as SupabaseAdminClient;

    for (let index = 0; index < contexts.length; index += 1) {
      const secondaryProvider = createOptionalGeminiSecondaryProvider({
        apiKey: "gemini-test-key",
        fetchImpl: (async () =>
          new Response("unavailable", { status: 503 })) as typeof fetch,
      });
      assert(
        secondaryProvider,
        "Expected configured Gemini secondary provider.",
      );
      let failure: unknown;
      try {
        await prepareWorksheetCompletion({
          ...activeLease,
          admin,
          assignmentId: `53333333-3333-4333-8333-33333333333${index + 1}`,
          apiKey: "provider-key",
          model: "deepseek-v4-pro",
          criticModel: "deepseek-v4-flash",
          fetchImpl: async (_input, init) => {
            generatedLevels.push(worksheetCurriculumFromRequest(init).level);
            return new Response("unavailable", { status: 503 });
          },
          secondaryProvider,
        });
      } catch (error) {
        failure = error;
      }
      assert(
        failure instanceof WorksheetPrimaryFallbackContinuation,
        "The provider fixture should enter durable fallback only after receiving the frozen context.",
      );
    }

    assertEquals(generatedLevels.join(","), "A1,B2");
  },
);

Deno.test(
  "a persisted primary candidate resumes at critique and completion replays without regeneration",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let crashAfterCandidate = true;
    let deepSeekGenerationCalls = 0;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    const authorizedCalls: WorksheetProviderCallIdentity[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async (call) => {
        authorizedCalls.push(call);
      },
      onProviderUsage: async () => undefined,
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        assertEquals(resumableGeminiRequestKind(init), "critique");
        geminiCriticCalls += 1;
        return resumableGeminiResponse(
          "gemini-3.1-flash-lite",
          resumableCriticContent(init, true),
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");

    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        assertEquals(
          write.candidate.validation.attempt_count,
          write.candidateAttempt,
        );
        checkpoint = resumableCheckpoint({
          stage:
            write.candidateAttempt === 1
              ? "primary_critique"
              : "repair_critique",
          candidateAttempt: write.candidateAttempt,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
        if (crashAfterCandidate) {
          crashAfterCandidate = false;
          throw new WorksheetGenerationError(
            "worksheet_checkpoint_unavailable",
            true,
          );
        }
      },
      saveCriticEvidence: async (write) => {
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: write.completion.validation.attempt_count,
          candidate: write.completion,
          candidateSha256: write.completion.validation.candidate_sha256,
          completionPayload: write.completion,
        });
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => {
          deepSeekGenerationCalls += 1;
          return resumableDeepSeekGenerationResponse();
        },
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_resume",
      });

    let persistedFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      persistedFailure = error;
    }
    assert(
      persistedFailure instanceof WorksheetGenerationError &&
        persistedFailure.safeCode === "worksheet_checkpoint_unavailable",
      "The fixture must stop after durably persisting its primary candidate.",
    );
    assertEquals(currentCheckpointStage(checkpoint), "primary_critique");
    assertEquals(deepSeekGenerationCalls, 1);
    assertEquals(deepSeekCriticCalls, 0);
    assertEquals(geminiCriticCalls, 0);

    const completed = await invoke();
    assertEquals(completed.mode, "generated");
    if (completed.mode === "generated") {
      assertEquals(completed.validation.independent_model, true);
      assertEquals(completed.validation.attempt_count, 1);
    }
    assertEquals(currentCheckpointStage(checkpoint), "completion");
    assertEquals(deepSeekGenerationCalls, 1);
    assertEquals(deepSeekCriticCalls, 1);
    assertEquals(geminiCriticCalls, 1);

    const replayed = await invoke();
    assertEquals(replayed.mode, "generated");
    if (replayed.mode === "generated") {
      assertEquals(
        replayed.validation.candidate_sha256,
        completed.mode === "generated"
          ? completed.validation.candidate_sha256
          : null,
      );
    }
    assertEquals(deepSeekGenerationCalls, 1);
    assertEquals(deepSeekCriticCalls, 1);
    assertEquals(geminiCriticCalls, 1);

    const counts = callKeyCounts(authorizedCalls);
    assertEquals(counts.size, 3);
    assertEquals(
      counts.get("prepare_resume:candidate_1:deepseek:mcq_safe_generation"),
      1,
    );
    assertEquals(counts.get("prepare_resume:candidate_1:deepseek:critique"), 1);
    assertEquals(counts.get("prepare_resume:candidate_1:gemini:critique"), 1);
  },
);

Deno.test(
  "DeepSeek critic success survives Gemini outage and is billed and called exactly once across recovery",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let deepSeekGenerationCalls = 0;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    let completionWrites = 0;
    const authorizedCalls: WorksheetProviderCallIdentity[] = [];
    const usageCallKeys: string[] = [];
    const atomicUsageCallKeys: string[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async (call) => {
        authorizedCalls.push(call);
      },
      onProviderUsage: async (usage) => {
        usageCallKeys.push(usage.call_key);
      },
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        geminiCriticCalls += 1;
        return geminiCriticCalls === 1
          ? new Response("temporary", { status: 503 })
          : resumableGeminiResponse(
              "gemini-3.1-flash-lite",
              resumableCriticContent(init, true),
            );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async (write) => {
        atomicUsageCallKeys.push(write.usage.call_key);
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async (write) => {
        completionWrites += 1;
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: 1,
          completionPayload: write.completion,
        });
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => {
          deepSeekGenerationCalls += 1;
          return resumableDeepSeekGenerationResponse();
        },
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_partial_deepseek",
      });

    let firstFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      firstFailure = error;
    }
    assert(
      firstFailure instanceof WorksheetGenerationError &&
        firstFailure.safeCode === "worksheet_dual_critics_unavailable" &&
        firstFailure.retryable,
      "A missing Gemini verdict must remain a bounded private retry.",
    );
    const partial = requireResumableCheckpoint(checkpoint);
    assert(
      partial.criticEvidence.deepseek !== null,
      "DeepSeek evidence was lost.",
    );
    assertEquals(partial.criticEvidence.gemini, null);
    assertEquals(completionWrites, 0);

    const completed = await invoke();
    assertEquals(completed.mode, "generated");
    if (completed.mode === "generated") {
      assertEquals(completed.validation.independent_model, true);
    }
    assertEquals(deepSeekGenerationCalls, 1);
    assertEquals(deepSeekCriticCalls, 1);
    assertEquals(geminiCriticCalls, 2);
    assertEquals(completionWrites, 1);
    assertEquals(
      authorizedCalls.filter((call) =>
        call.call_key.endsWith(":deepseek:critique"),
      ).length,
      1,
    );
    assertEquals(
      usageCallKeys.filter((key) => key.endsWith(":deepseek:critique")).length,
      0,
    );
    assertEquals(
      atomicUsageCallKeys.filter((key) => key.endsWith(":deepseek:critique"))
        .length,
      1,
    );
  },
);

Deno.test(
  "Gemini critic success survives DeepSeek outage and is billed and called exactly once across recovery",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    let completionWrites = 0;
    const authorizedCalls: WorksheetProviderCallIdentity[] = [];
    const usageCallKeys: string[] = [];
    const atomicUsageCallKeys: string[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async (call) => {
        authorizedCalls.push(call);
      },
      onProviderUsage: async (usage) => {
        usageCallKeys.push(usage.call_key);
      },
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        geminiCriticCalls += 1;
        return resumableGeminiResponse(
          "gemini-3.1-flash-lite",
          resumableCriticContent(init, true),
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async (write) => {
        atomicUsageCallKeys.push(write.usage.call_key);
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async (write) => {
        completionWrites += 1;
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: 1,
          completionPayload: write.completion,
        });
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(),
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return deepSeekCriticCalls === 1
            ? new Response("temporary", { status: 503 })
            : resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_partial_gemini",
      });

    let firstFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      firstFailure = error;
    }
    assert(
      firstFailure instanceof WorksheetGenerationError &&
        firstFailure.safeCode === "worksheet_dual_critics_unavailable" &&
        firstFailure.retryable,
      "A missing DeepSeek verdict must remain a bounded private retry.",
    );
    const partial = requireResumableCheckpoint(checkpoint);
    assertEquals(partial.criticEvidence.deepseek, null);
    assert(partial.criticEvidence.gemini !== null, "Gemini evidence was lost.");
    assertEquals(completionWrites, 0);

    const completed = await invoke();
    assertEquals(completed.mode, "generated");
    if (completed.mode === "generated") {
      assertEquals(completed.validation.independent_model, true);
    }
    assertEquals(deepSeekCriticCalls, 2);
    assertEquals(geminiCriticCalls, 1);
    assertEquals(completionWrites, 1);
    assertEquals(
      authorizedCalls.filter((call) =>
        call.call_key.endsWith(":gemini:critique"),
      ).length,
      1,
    );
    assertEquals(
      usageCallKeys.filter((key) => key.endsWith(":gemini:critique")).length,
      0,
    );
    assertEquals(
      atomicUsageCallKeys.filter((key) => key.endsWith(":gemini:critique"))
        .length,
      1,
    );
  },
);

Deno.test(
  "stale partial critic candidate evidence cannot replay or finalize",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    let completionWrites = 0;
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        geminiCriticCalls += 1;
        return geminiCriticCalls === 1
          ? new Response("temporary", { status: 503 })
          : resumableGeminiResponse(
              "gemini-3.1-flash-lite",
              resumableCriticContent(init, true),
            );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async (write) => {
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async () => {
        completionWrites += 1;
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(),
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerCallKeyPrefix: "prepare_partial_mismatch",
      });

    try {
      await invoke();
    } catch {
      // Expected: only the DeepSeek critic completed.
    }
    const partial = requireResumableCheckpoint(checkpoint);
    const evidence = partial.criticEvidence.deepseek as Record<string, unknown>;
    const deepSeekCallsBeforeReplay = deepSeekCriticCalls;
    const geminiCallsBeforeReplay = geminiCriticCalls;
    for (const staleEvidence of [
      { ...evidence, candidate_sha256: "c".repeat(64) },
      { ...evidence, model: "deepseek-v4-pro" },
      { ...evidence, verdict_sha256: "d".repeat(64) },
    ]) {
      checkpoint = {
        ...partial,
        criticEvidence: {
          ...partial.criticEvidence,
          deepseek: staleEvidence,
        },
      };
      let mismatch: unknown;
      try {
        await invoke();
      } catch (error) {
        mismatch = error;
      }
      assert(
        mismatch instanceof WorksheetGenerationError &&
          mismatch.safeCode ===
            "worksheet_checkpoint_critic_evidence_mismatch" &&
          !mismatch.retryable,
        "Candidate, model, and verdict-hash mismatches must fail closed before provider replay.",
      );
    }
    assertEquals(deepSeekCriticCalls, deepSeekCallsBeforeReplay);
    assertEquals(geminiCriticCalls, geminiCallsBeforeReplay);
    assertEquals(completionWrites, 0);
  },
);

Deno.test(
  "checkpoint RPC failure repeats only the uncommitted critic and never finalizes one-sided evidence",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let failFirstDeepSeekCheckpoint = true;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    let completionWrites = 0;
    const usageCallKeys: string[] = [];
    const atomicUsageCallKeys: string[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async () => undefined,
      onProviderUsage: async (usage) => {
        usageCallKeys.push(usage.call_key);
      },
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        geminiCriticCalls += 1;
        return resumableGeminiResponse(
          "gemini-3.1-flash-lite",
          resumableCriticContent(init, true),
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async (write) => {
        atomicUsageCallKeys.push(write.usage.call_key);
        if (
          write.evidence.provider === "deepseek" &&
          failFirstDeepSeekCheckpoint
        ) {
          failFirstDeepSeekCheckpoint = false;
          throw new WorksheetGenerationError(
            "worksheet_checkpoint_unavailable",
            true,
          );
        }
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async (write) => {
        completionWrites += 1;
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: 1,
          completionPayload: write.completion,
        });
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(),
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_partial_db_failure",
      });

    let checkpointFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      checkpointFailure = error;
    }
    assert(
      checkpointFailure instanceof WorksheetGenerationError &&
        checkpointFailure.safeCode === "worksheet_checkpoint_unavailable" &&
        checkpointFailure.retryable,
      "A lost checkpoint acknowledgement must stay a bounded retry.",
    );
    const partial = requireResumableCheckpoint(checkpoint);
    assertEquals(partial.criticEvidence.deepseek, null);
    assert(
      partial.criticEvidence.gemini !== null,
      "Healthy Gemini evidence should survive independently.",
    );
    assertEquals(completionWrites, 0);

    const completed = await invoke();
    assertEquals(completed.mode, "generated");
    assertEquals(deepSeekCriticCalls, 2);
    assertEquals(geminiCriticCalls, 1);
    assertEquals(completionWrites, 1);
    assertEquals(
      usageCallKeys.filter((key) => key.endsWith(":deepseek:critique")).length,
      0,
    );
    assertEquals(
      usageCallKeys.filter((key) => key.endsWith(":gemini:critique")).length,
      0,
    );
    assertEquals(
      atomicUsageCallKeys.filter((key) => key.endsWith(":deepseek:critique"))
        .length,
      2,
    );
    assertEquals(
      atomicUsageCallKeys.filter((key) => key.endsWith(":gemini:critique"))
        .length,
      1,
    );
  },
);

Deno.test(
  "a committed atomic critic save survives a lost RPC response without a second provider call",
  async () => {
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let loseFirstDeepSeekResponse = true;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    let completionWrites = 0;
    const atomicUsageCallKeys: string[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async () => undefined,
      onProviderUsage: async () => undefined,
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        geminiCriticCalls += 1;
        return resumableGeminiResponse(
          "gemini-3.1-flash-lite",
          resumableCriticContent(init, true),
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async (write) => {
        atomicUsageCallKeys.push(write.usage.call_key);
        checkpoint = withResumableCriticEvidence(checkpoint, write);
        if (
          write.evidence.provider === "deepseek" &&
          loseFirstDeepSeekResponse
        ) {
          loseFirstDeepSeekResponse = false;
          throw new WorksheetGenerationError(
            "worksheet_checkpoint_unavailable",
            true,
          );
        }
      },
      saveCompletion: async (write) => {
        completionWrites += 1;
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: 1,
          completionPayload: write.completion,
        });
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(),
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, true);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_partial_lost_response",
      });

    let lostResponse: unknown;
    try {
      await invoke();
    } catch (error) {
      lostResponse = error;
    }
    assert(
      lostResponse instanceof WorksheetGenerationError &&
        lostResponse.safeCode === "worksheet_checkpoint_unavailable" &&
        lostResponse.retryable,
      "A committed save with a lost response must be retried from durable state.",
    );
    const partial = requireResumableCheckpoint(checkpoint);
    assert(
      partial.criticEvidence.deepseek !== null,
      "DeepSeek commit was lost.",
    );
    assert(partial.criticEvidence.gemini !== null, "Gemini commit was lost.");
    assertEquals(completionWrites, 0);

    const completed = await invoke();
    assertEquals(completed.mode, "generated");
    assertEquals(deepSeekCriticCalls, 1);
    assertEquals(geminiCriticCalls, 1);
    assertEquals(completionWrites, 1);
    assertEquals(atomicUsageCallKeys.length, 2);
  },
);

Deno.test(
  "a rejected completion checkpoint refreshes newly certified exact-context material before replay",
  async () => {
    const bankRevisionId = "96666666-6666-4666-8666-666666666666";
    const rejectedCompletion = resumableRejectedCompletion();
    let generationContextLoads = 0;
    let providerCalls = 0;
    const checkpoint = resumableCheckpoint({
      stage: "completion",
      candidateAttempt: 2,
      candidate: rejectedCompletion,
      candidateSha256: rejectedCompletion.validation.candidate_sha256,
      completionPayload: rejectedCompletion,
    });
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async () => {
        throw new Error("A completion replay must not persist a candidate.");
      },
      saveCriticEvidence: async () => {
        throw new Error(
          "A completion replay must not persist critic evidence.",
        );
      },
      saveCompletion: async () => {
        throw new Error("A completion replay must not persist again.");
      },
    };
    const completion = await prepareWorksheetCompletion({
      ...activeLease,
      checkpointStore,
      admin: resumableAdmin({
        certifiedRevisionId: () => {
          generationContextLoads += 1;
          return generationContextLoads >= 2 ? bankRevisionId : null;
        },
      }),
      assignmentId: resumableAssignmentId,
      apiKey: "deepseek-test-key",
      model: "deepseek-v4-pro",
      provider: {
        providerName: "deepseek",
        endpoint: "https://api.deepseek.com/chat/completions",
        complete: async () => {
          providerCalls += 1;
          throw new Error("Provider generation must not repeat.");
        },
      },
    });

    assertEquals(generationContextLoads, 2);
    assertEquals(providerCalls, 0);
    assertEquals(completion.mode, "certified_bank");
    if (completion.mode === "certified_bank") {
      assertEquals(completion.template_revision_id, bankRevisionId);
      assertEquals(completion.fallback_reason, "candidates_rejected");
      assertEquals(completion.rejected_candidates.length, 1);
      assertEquals(
        completion.rejected_candidates[0]?.candidate,
        rejectedCompletion,
      );
    }
  },
);

Deno.test(
  "durable fallback and repair stages never repeat generation and use the exact-context bank after two rejections",
  async () => {
    const bankRevisionId = "95555555-5555-4555-8555-555555555555";
    let bankAvailable = false;
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    const crashAfterCandidateAttempts = new Set<1 | 2>([1, 2]);
    let deepSeekGenerationCalls = 0;
    let deepSeekCriticCalls = 0;
    let geminiGenerationCalls = 0;
    let geminiCriticCalls = 0;
    const authorizedCalls: WorksheetProviderCallIdentity[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async (call) => {
        authorizedCalls.push(call);
      },
      onProviderUsage: async () => undefined,
      onProviderNotCalled: async () => undefined,
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async (_input, init) => {
        if (resumableGeminiRequestKind(init) === "generation") {
          geminiGenerationCalls += 1;
          const curriculum = worksheetCurriculumFromRequest(init);
          if (geminiGenerationCalls === 1) {
            assertEquals(curriculum.accepted_question_fragments, undefined);
            assertEquals(curriculum.quarantined_question_numbers, undefined);
          } else {
            assertEquals(
              curriculum.accepted_question_fragments
                ?.map((question) => question.question_number)
                .join(","),
              "1,2,3,5,6,7,8",
            );
            assertEquals(
              curriculum.quarantined_question_numbers?.join(","),
              "4",
            );
          }
          return resumableGeminiGenerationResponse(init);
        }
        geminiCriticCalls += 1;
        return resumableGeminiResponse(
          "gemini-3.1-flash-lite",
          resumableCriticContent(init, false),
        );
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");

    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage:
            write.candidateAttempt === 1
              ? "primary_critique"
              : "repair_critique",
          candidateAttempt: write.candidateAttempt,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
          primaryFailureCode: checkpoint?.primaryFailureCode,
          primaryRejection: checkpoint?.primaryRejection,
        });
        if (crashAfterCandidateAttempts.delete(write.candidateAttempt)) {
          throw new WorksheetGenerationError(
            "worksheet_checkpoint_unavailable",
            true,
          );
        }
      },
      saveCriticEvidence: async (write) => {
        checkpoint = withResumableCriticEvidence(checkpoint, write);
      },
      saveCompletion: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "completion",
          candidateAttempt: write.completion.validation.attempt_count,
          candidate: write.completion,
          candidateSha256: write.completion.validation.candidate_sha256,
          primaryFailureCode: checkpoint?.primaryFailureCode,
          primaryRejection: checkpoint?.primaryRejection,
          completionPayload: write.completion,
        });
        bankAvailable = true;
      },
    };
    const invoke = () =>
      prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin({
          certifiedRevisionId: () => (bankAvailable ? bankRevisionId : null),
        }),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => {
          deepSeekGenerationCalls += 1;
          return new Response("unavailable", { status: 503 });
        },
        criticFetchImpl: async (_input, init) => {
          deepSeekCriticCalls += 1;
          return resumableDeepSeekCriticResponse(init, false);
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_recovery",
      });

    let fallbackContinuation: unknown;
    try {
      await invoke();
    } catch (error) {
      fallbackContinuation = error;
    }
    assert(
      fallbackContinuation instanceof WorksheetPrimaryFallbackContinuation &&
        fallbackContinuation.safeCode === "worksheet_provider_unavailable",
      "The primary outage must request one durable alternate-provider stage.",
    );
    checkpoint = resumableCheckpoint({
      stage: "primary_fallback_generation",
      candidateAttempt: 1,
      primaryFailureCode: "worksheet_provider_unavailable",
    });

    let fallbackPersistenceFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      fallbackPersistenceFailure = error;
    }
    assert(
      fallbackPersistenceFailure instanceof WorksheetGenerationError &&
        fallbackPersistenceFailure.safeCode ===
          "worksheet_checkpoint_unavailable",
      `The fallback candidate must survive a failure immediately after persistence; received ${
        fallbackPersistenceFailure instanceof Error
          ? `${fallbackPersistenceFailure.name}: ${
              (fallbackPersistenceFailure as WorksheetGenerationError)
                .safeCode ?? fallbackPersistenceFailure.message
            }`
          : String(fallbackPersistenceFailure)
      }.`,
    );
    assertEquals(currentCheckpointStage(checkpoint), "primary_critique");

    let repairContinuation: unknown;
    try {
      await invoke();
    } catch (error) {
      repairContinuation = error;
    }
    assert(
      repairContinuation instanceof WorksheetRepairContinuation,
      "A first semantic rejection must request one durable repair stage.",
    );
    checkpoint = resumableCheckpoint({
      stage: "repair_generation",
      candidateAttempt: 2,
      primaryFailureCode: checkpoint?.primaryFailureCode,
      primaryRejection: repairContinuation.rejectedCandidate,
    });

    let repairPersistenceFailure: unknown;
    try {
      await invoke();
    } catch (error) {
      repairPersistenceFailure = error;
    }
    assert(
      repairPersistenceFailure instanceof WorksheetGenerationError &&
        repairPersistenceFailure.safeCode ===
          "worksheet_checkpoint_unavailable",
      "The repair candidate must survive a failure immediately after persistence.",
    );
    assertEquals(currentCheckpointStage(checkpoint), "repair_critique");

    const fallback = await invoke();
    assertEquals(fallback.mode, "certified_bank");
    if (fallback.mode === "certified_bank") {
      assertEquals(fallback.template_revision_id, bankRevisionId);
      assertEquals(fallback.fallback_reason, "candidates_rejected");
      assertEquals(fallback.rejected_candidates.length, 2);
    }
    assertEquals(currentCheckpointStage(checkpoint), "completion");
    assert(
      checkpoint?.completionPayload != null &&
        (checkpoint.completionPayload as GeneratedWorksheetCompletion)
          .validation.independent_model === false,
      "The rejected repair must remain private completion evidence for quarantine.",
    );
    assertEquals(deepSeekGenerationCalls, 1);
    assertEquals(geminiGenerationCalls, 2);
    assertEquals(deepSeekCriticCalls, 2);
    assertEquals(geminiCriticCalls, 2);

    const expectedKeys = [
      "prepare_recovery:candidate_1:deepseek:mcq_safe_generation",
      "prepare_recovery:candidate_1:gemini:outage_safe_generation",
      "prepare_recovery:candidate_1:deepseek:critique",
      "prepare_recovery:candidate_1:gemini:critique",
      "prepare_recovery:candidate_2:gemini:mcq_safe_repair",
      "prepare_recovery:candidate_2:deepseek:critique",
      "prepare_recovery:candidate_2:gemini:critique",
    ];
    const counts = callKeyCounts(authorizedCalls);
    assertEquals(counts.size, expectedKeys.length);
    for (const key of expectedKeys) assertEquals(counts.get(key), 1);
  },
);

Deno.test(
  "post-response spend settlement consumes the 85-second stage budget before critic transport",
  async () => {
    const originalDateNow = Date.now;
    let nowMs = 1_000;
    Date.now = () => nowMs;
    let checkpoint: WorksheetGenerationCheckpoint | null = null;
    let deepSeekCriticCalls = 0;
    let geminiCriticCalls = 0;
    const authorizedCalls: WorksheetProviderCallIdentity[] = [];
    const releasedCalls: WorksheetProviderCallIdentity[] = [];
    const lifecycleHooks: WorksheetProviderLifecycleHooks = {
      onBeforeProviderCall: async (call) => {
        authorizedCalls.push(call);
      },
      onProviderUsage: async (usage) => {
        if (usage.call_key.endsWith(":deepseek:mcq_safe_generation")) {
          nowMs += 85_001;
        }
      },
      onProviderNotCalled: async (call) => {
        releasedCalls.push(call);
      },
    };
    const secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
      fetchImpl: (async () => {
        geminiCriticCalls += 1;
        throw new Error("Critic transport must not begin after the deadline.");
      }) as typeof fetch,
    });
    assert(secondaryProvider, "Expected configured Gemini secondary provider.");
    const checkpointStore: PrepareCheckpointStore = {
      load: async () => checkpoint,
      saveCandidate: async (write) => {
        checkpoint = resumableCheckpoint({
          stage: "primary_critique",
          candidateAttempt: 1,
          candidate: write.candidate,
          candidateSha256: write.candidateSha256,
        });
      },
      saveCriticEvidence: async () => {
        throw new Error(
          "A deadline-exhausted pass must not save critic evidence.",
        );
      },
      saveCompletion: async () => {
        throw new Error("A deadline-exhausted pass must not save completion.");
      },
    };

    let failure: unknown;
    try {
      await prepareWorksheetCompletion({
        ...activeLease,
        checkpointStore,
        admin: resumableAdmin(),
        assignmentId: resumableAssignmentId,
        apiKey: "deepseek-test-key",
        model: "deepseek-v4-pro",
        criticModel: "deepseek-v4-flash",
        fetchImpl: async () => resumableDeepSeekGenerationResponse(),
        criticFetchImpl: async () => {
          deepSeekCriticCalls += 1;
          throw new Error(
            "Critic transport must not begin after the deadline.",
          );
        },
        secondaryProvider,
        providerLifecycleHooks: lifecycleHooks,
        providerCallKeyPrefix: "prepare_budget",
      });
    } catch (error) {
      failure = error;
    } finally {
      Date.now = originalDateNow;
    }

    assert(
      failure instanceof WorksheetGenerationError &&
        failure.safeCode === "worksheet_provider_deadline_exceeded" &&
        failure.retryable,
      "Settlement time must consume the same bounded stage deadline.",
    );
    assertEquals(currentCheckpointStage(checkpoint), "primary_critique");
    assertEquals(deepSeekCriticCalls, 0);
    assertEquals(geminiCriticCalls, 0);
    assertEquals(authorizedCalls.length, 1);
    assertEquals(
      authorizedCalls[0]?.call_key,
      "prepare_budget:candidate_1:deepseek:mcq_safe_generation",
    );
    assertEquals(releasedCalls.length, 0);
  },
);
