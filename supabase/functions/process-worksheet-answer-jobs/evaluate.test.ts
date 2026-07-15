import {
  evaluateLoadedWorksheetAnswers,
  type LoadedAssignment,
  type LoadedAttempt,
  type LoadedQuestion,
  type LoadedTopic,
  type LoadedWorksheet,
  prepareWorksheetAnswerCompletion,
  WORKSHEET_ANSWER_EVALUATOR_CONTRACT_VERSION,
  WORKSHEET_ANSWER_PROMPT_CONTRACT_VERSION,
  WorksheetAnswerEvaluationError,
  type WorksheetAnswerAdjudicationCheckpoint,
  type WorksheetAnswerProviderCall,
  type WorksheetAnswerCheckpointStore,
  type WorksheetAnswerProviderCheckpoint,
  type WorksheetAnswerProviderUsage,
} from "./evaluate.ts";
import type { SupabaseAdminClient } from "../_shared/writing-feedback.ts";
import {
  type ChatCompletionProvider,
  ChatCompletionProviderConfigurationError,
  ChatCompletionProviderResponseError,
  createOptionalGeminiSecondaryProvider,
  DEEPSEEK_V1_FLASH_MODEL,
  DEEPSEEK_V1_PRO_MODEL,
  GEMINI_V1_ANSWER_MODEL,
  GEMINI_V1_CRITIC_MODEL,
  GEMINI_V1_STRONG_MODEL,
  type GeminiSecondaryProvider,
} from "../_shared/chat-completion-provider.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const questionId = "44444444-4444-4444-8444-444444444444";
const secondQuestionId = "45454545-4545-4545-8545-454545454545";
const attempt: LoadedAttempt = {
  id: "11111111-1111-4111-8111-111111111111",
  practice_test_id: "22222222-2222-4222-8222-222222222222",
  assignment_id: "33333333-3333-4333-8333-333333333333",
  workspace_id: "66666666-6666-4666-8666-666666666666",
  student_id: "77777777-7777-4777-8777-777777777777",
  answers: [{ question_id: questionId, answer: "Ich helfe dem Mann." }],
  status: "submitted",
  evaluation_status: "evaluating",
  evaluation_version: 1,
};
const assignment: LoadedAssignment = {
  id: "33333333-3333-4333-8333-333333333333",
  grammar_topic_id: "55555555-5555-4555-8555-555555555555",
  practice_test_id: "22222222-2222-4222-8222-222222222222",
  latest_attempt_id: attempt.id,
  status: "completed",
};
const topic: LoadedTopic = {
  name: "Dativ",
  slug: "dativ",
  level: "A2",
  description: "Dative articles.",
};
const worksheet: LoadedWorksheet = {
  title: "Dativ üben",
  level: "A2",
  difficulty: "medium",
};

function semanticQuestion(
  overrides: Partial<LoadedQuestion> = {},
): LoadedQuestion {
  return {
    id: questionId,
    question_number: 1,
    question_type: "transformation",
    evaluation_mode: "open_evaluation",
    prompt: "Rewrite the sentence with helfen.",
    correct_answer: "Ich helfe dem Mann.",
    accepted_answers: [],
    rubric: {
      criteria: ["Use helfen with a correct dative object."],
      sample_answer: "Ich helfe dem Mann.",
    },
    answer_contract_version: 1,
    explanation: "Use the dative after helfen.",
    ...overrides,
  };
}

type ReviewJson = {
  question_ref: string;
  review_status: string;
  points_awarded: number;
  max_points: number;
  feedback_text: string;
  corrected_answer: string | null;
  model_answer: string | null;
  short_reason: string;
};

function reviewJson(overrides: Partial<ReviewJson> = {}): ReviewJson {
  return {
    question_ref: "q1",
    review_status: "correct",
    points_awarded: 1,
    max_points: 1,
    feedback_text: "Die Antwort verwendet die Zielgrammatik richtig.",
    corrected_answer: null,
    model_answer: "Ich helfe dem Mann.",
    short_reason: "Alle Bewertungskriterien sind erfüllt.",
    ...overrides,
  };
}

function completionEnvelope(model: string, reviews: ReviewJson[]) {
  return {
    model,
    provider_model_version: model,
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify({ reviews }) },
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function resourceInterruptedEnvelope(model: string) {
  return {
    ...completionEnvelope(model, []),
    choices: [
      {
        finish_reason: "insufficient_system_resource",
        message: { content: null },
      },
    ],
  };
}

function proEnvelope(
  payload: Record<string, unknown>,
  selectedEvidence:
    | "deepseek"
    | "gemini"
    | null
    | Array<"deepseek" | "gemini" | null>,
  shortReason?: string,
) {
  const messages = payload.messages as Array<{ content?: unknown }>;
  const prompt = String(messages.at(-1)?.content ?? "");
  const deepSeekHash = prompt.match(
    /"deepseek_result_sha256":"([0-9a-f]{64})"/,
  )?.[1];
  const geminiHash = prompt.match(
    /"gemini_result_sha256":"([0-9a-f]{64})"/,
  )?.[1];
  assert(
    deepSeekHash && geminiHash,
    "Pro prompt must bind both evidence hashes.",
  );
  return {
    model: DEEPSEEK_V1_PRO_MODEL,
    provider_model_version: DEEPSEEK_V1_PRO_MODEL,
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            deepseek_result_sha256: deepSeekHash,
            gemini_result_sha256: geminiHash,
            resolutions: (Array.isArray(selectedEvidence)
              ? selectedEvidence
              : [selectedEvidence]
            ).map((selection, index) => ({
              question_ref: `q${index + 1}`,
              resolution_status: selection ? "resolved" : "uncertain",
              selected_evidence: selection,
              short_reason:
                shortReason ??
                (selection
                  ? "Die ausgewählte Bewertung erfüllt die Kriterien."
                  : "Die Abweichung kann nicht sicher geklärt werden."),
            })),
          }),
        },
      },
    ],
    usage: {
      prompt_tokens: 180,
      completion_tokens: 30,
      total_tokens: 210,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function provider(
  providerName: "deepseek" | "gemini",
  complete: ChatCompletionProvider["complete"],
): ChatCompletionProvider {
  return {
    providerName,
    endpoint:
      providerName === "deepseek"
        ? "https://api.deepseek.com/chat/completions"
        : "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    complete,
  };
}

function deepSeekProvider(
  args: {
    flash?: ReviewJson[] | Response;
    proSelection?: "deepseek" | "gemini" | null;
    proSelections?: Array<"deepseek" | "gemini" | null>;
    proShortReason?: string;
    proResponse?: Response;
    inspectProPayload?: (payload: Record<string, unknown>) => void;
    calls?: string[];
  } = {},
) {
  return provider("deepseek", async (payload) => {
    const model = String(payload.model);
    args.calls?.push(model);
    if (model === DEEPSEEK_V1_PRO_MODEL) {
      args.inspectProPayload?.(payload);
      if (args.proResponse) return args.proResponse;
      return Response.json(
        proEnvelope(
          payload,
          args.proSelections ?? args.proSelection ?? null,
          args.proShortReason,
        ),
      );
    }
    if (args.flash instanceof Response) return args.flash;
    return Response.json(
      completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, args.flash ?? [reviewJson()]),
    );
  });
}

function geminiEvaluator(
  value: ReviewJson[] | Response = [reviewJson()],
  calls?: string[],
): GeminiSecondaryProvider {
  return {
    answerModel: GEMINI_V1_ANSWER_MODEL,
    criticModel: GEMINI_V1_CRITIC_MODEL,
    strongModel: GEMINI_V1_STRONG_MODEL,
    provider: provider("gemini", async (payload) => {
      calls?.push(String(payload.model));
      if (value instanceof Response) return value;
      return Response.json(completionEnvelope(GEMINI_V1_ANSWER_MODEL, value));
    }),
  };
}

function evaluationArgs(overrides: Record<string, unknown> = {}) {
  return {
    attempt,
    assignment,
    topic,
    worksheet,
    questions: [semanticQuestion()],
    model: DEEPSEEK_V1_FLASH_MODEL,
    provider: deepSeekProvider(),
    geminiSecondary: geminiEvaluator(),
    ...overrides,
  };
}

function memoryCheckpointStore() {
  let evidenceSha256: string | null = null;
  let evaluatorContractVersion: number | null = null;
  let promptContractVersion: number | null = null;
  let adjudicationCheckpoint: WorksheetAnswerAdjudicationCheckpoint | null =
    null;
  const rows = new Map<"deepseek" | "gemini", WorksheetAnswerProviderCheckpoint>();
  const assertContractVersions = (
    evaluatorVersion: number,
    promptVersion: number,
  ) => {
    if (
      evaluatorVersion !== WORKSHEET_ANSWER_EVALUATOR_CONTRACT_VERSION ||
      promptVersion !== WORKSHEET_ANSWER_PROMPT_CONTRACT_VERSION ||
      (evaluatorContractVersion !== null &&
        evaluatorContractVersion !== evaluatorVersion) ||
      (promptContractVersion !== null &&
        promptContractVersion !== promptVersion)
    ) {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_answer_checkpoint_replay_mismatch",
        false,
      );
    }
  };
  const checkpointStore: WorksheetAnswerCheckpointStore = {
    load: async ({
      evidenceSha256: expected,
      deepSeekModel,
      geminiModel,
      evaluatorContractVersion: expectedEvaluatorContractVersion,
      promptContractVersion: expectedPromptContractVersion,
    }) => {
      assertContractVersions(
        expectedEvaluatorContractVersion,
        expectedPromptContractVersion,
      );
      if (evidenceSha256 !== null && evidenceSha256 !== expected) {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      for (const row of rows.values()) {
        const expectedModel = row.provider === "deepseek"
          ? deepSeekModel
          : geminiModel;
        if (row.model !== expectedModel || row.evidenceSha256 !== expected) {
          throw new WorksheetAnswerEvaluationError(
            "worksheet_answer_checkpoint_replay_mismatch",
            false,
          );
        }
      }
      return [...rows.values()];
    },
    save: async (row) => {
      assertContractVersions(
        row.evaluatorContractVersion,
        row.promptContractVersion,
      );
      if (evidenceSha256 !== null && evidenceSha256 !== row.evidenceSha256) {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      evidenceSha256 = row.evidenceSha256;
      const current = rows.get(row.provider);
      const {
        usage: _usage,
        evaluatorContractVersion: _evaluatorContractVersion,
        promptContractVersion: _promptContractVersion,
        ...next
      } = row;
      if (current && JSON.stringify(current) !== JSON.stringify(next)) {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      evaluatorContractVersion = row.evaluatorContractVersion;
      promptContractVersion = row.promptContractVersion;
      rows.set(row.provider, next);
    },
    loadAdjudication: async ({
      evidenceSha256: expected,
      model,
      evaluatorContractVersion: expectedEvaluatorContractVersion,
      promptContractVersion: expectedPromptContractVersion,
    }) => {
      assertContractVersions(
        expectedEvaluatorContractVersion,
        expectedPromptContractVersion,
      );
      if (
        adjudicationCheckpoint &&
        (adjudicationCheckpoint.evidenceSha256 !== expected ||
          adjudicationCheckpoint.model !== model)
      ) {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      return adjudicationCheckpoint;
    },
    saveAdjudication: async (row) => {
      assertContractVersions(
        row.evaluatorContractVersion,
        row.promptContractVersion,
      );
      const {
        usage: _usage,
        evaluatorContractVersion: _evaluatorContractVersion,
        promptContractVersion: _promptContractVersion,
        ...next
      } = row;
      if (
        adjudicationCheckpoint &&
        JSON.stringify(adjudicationCheckpoint) !== JSON.stringify(next)
      ) {
        throw new WorksheetAnswerEvaluationError(
          "worksheet_answer_checkpoint_replay_mismatch",
          false,
        );
      }
      evaluatorContractVersion = row.evaluatorContractVersion;
      promptContractVersion = row.promptContractVersion;
      adjudicationCheckpoint = next;
    },
  };
  return {
    checkpointStore,
    rows,
    get adjudicationCheckpoint() {
      return adjudicationCheckpoint;
    },
  };
}

async function expectEvaluationError(
  promise: Promise<unknown>,
  expected: {
    reason: WorksheetAnswerEvaluationError["needsReviewReason"];
    retryable: boolean;
    outage?: boolean;
  },
) {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof WorksheetAnswerEvaluationError,
      "Expected a structured worksheet evaluation error.",
    );
    assertEquals(error.needsReviewReason, expected.reason);
    assertEquals(error.retryable, expected.retryable);
    assertEquals(
      error.providerOutageRecoveryEligible,
      expected.outage ?? false,
    );
    return error;
  }
  throw new Error("Expected worksheet evaluation to fail.");
}

Deno.test(
  "objective-only work remains local and carries no adjudication",
  async () => {
    let called = false;
    let usageRecorded = false;
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      questions: [
        semanticQuestion({
          question_type: "multiple_choice",
          evaluation_mode: "local_exact",
          correct_answer: "dem",
          accepted_answers: ["dem"],
          rubric: null,
        }),
      ],
      provider: provider("deepseek", async () => {
        called = true;
        throw new Error("Provider must not run.");
      }),
      geminiSecondary: null,
      onProviderUsage: async () => {
        usageRecorded = true;
      },
    });
    assertEquals(result, {
      schema_version: 1,
      mode: "not_needed",
      evaluator_model: null,
      reviews: [],
      adjudication: null,
    });
    assertEquals(called, false);
    assertEquals(usageRecorded, false);
  },
);

Deno.test(
  "blank semantic answers use truthful local system provenance",
  async () => {
    let called = false;
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      attempt: {
        ...attempt,
        answers: [{ question_id: questionId, answer: "   " }],
      },
      provider: provider("deepseek", async () => {
        called = true;
        throw new Error("Provider must not run for a blank answer.");
      }),
      geminiSecondary: null,
    });
    assertEquals(result.reviews[0]?.evaluator_source, "system");
    assertEquals(result.reviews[0]?.points_awarded, 0);
    assertEquals(
      result.reviews[0]?.feedback_text,
      "Für diese Aufgabe wurde keine Antwort abgegeben.",
    );
    assertEquals(result.reviews[0]?.short_reason, "Keine Antwort abgegeben.");
    assertEquals(result.adjudication, null);
    assertEquals(called, false);
  },
);

Deno.test(
  "more than three semantic questions fail before any provider call",
  async () => {
    let called = false;
    const questions = [0, 1, 2, 3].map((index) =>
      semanticQuestion({
        id: `${index + 1}`.repeat(8) + "-4444-4444-8444-444444444444",
        question_number: index + 1,
      }),
    );
    try {
      await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        questions,
        provider: provider("deepseek", async () => {
          called = true;
          return Response.json({});
        }),
      });
    } catch (error) {
      assert(
        error instanceof WorksheetAnswerEvaluationError,
        "Expected a structured semantic-question limit failure.",
      );
      assertEquals(
        error.safeCode,
        "worksheet_flexible_question_limit_exceeded",
      );
      assertEquals(error.retryable, false);
      assertEquals(called, false);
      return;
    }
    throw new Error("Expected four semantic questions to be rejected.");
  },
);

Deno.test(
  "matching independent verdicts auto-finalize with pinned hashes",
  async () => {
    const calls: string[] = [];
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeekProvider({ calls }),
      geminiSecondary: geminiEvaluator([reviewJson()], calls),
    });
    assertEquals(
      calls.sort(),
      [DEEPSEEK_V1_FLASH_MODEL, GEMINI_V1_ANSWER_MODEL].sort(),
    );
    assertEquals(result.evaluator_model, DEEPSEEK_V1_FLASH_MODEL);
    assertEquals(result.reviews[0]?.evaluator_source, "deepseek");
    assertEquals(result.adjudication?.adjudication_mode, "agreement");
    assertEquals(result.adjudication?.selected_provider_source, "deepseek");
    assertEquals(result.adjudication?.selected_question_sources, [
      {
        question_id: questionId,
        provider_source: "deepseek",
      },
    ]);
    assertEquals(result.adjudication?.deepseek_result_sha256.length, 64);
    assertEquals(result.adjudication?.gemini_result_sha256.length, 64);
    assertEquals(result.adjudication?.pro_model, null);
  },
);

Deno.test(
  "DeepSeek checkpoint is reused when Gemini transiently fails",
  async () => {
    const { checkpointStore, rows } = memoryCheckpointStore();
    let deepSeekCalls = 0;
    let geminiCalls = 0;
    const deepSeek = provider("deepseek", async () => {
      deepSeekCalls += 1;
      return Response.json(
        completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [reviewJson()]),
      );
    });
    const gemini: GeminiSecondaryProvider = {
      ...geminiEvaluator(),
      provider: provider("gemini", async () => {
        geminiCalls += 1;
        return geminiCalls === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : Response.json(
              completionEnvelope(GEMINI_V1_ANSWER_MODEL, [reviewJson()]),
            );
      }),
    };

    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeek,
        geminiSecondary: gemini,
        checkpointStore,
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );
    assertEquals(deepSeekCalls, 1);
    assertEquals(geminiCalls, 1);
    assertEquals(rows.has("deepseek"), true);
    assertEquals(rows.has("gemini"), false);

    const completed = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeek,
      geminiSecondary: gemini,
      checkpointStore,
    });
    assertEquals(completed.adjudication?.adjudication_mode, "agreement");
    assertEquals(deepSeekCalls, 1);
    assertEquals(geminiCalls, 2);
    assertEquals(rows.size, 2);
  },
);

Deno.test(
  "durable verdict save owns usage finalization for one atomic commit",
  async () => {
    const memory = memoryCheckpointStore();
    let reservations = 0;
    let separateUsageFinalizations = 0;
    const checkpointedProviders: string[] = [];
    const checkpointStore: WorksheetAnswerCheckpointStore = {
      load: memory.checkpointStore.load,
      save: async (row) => {
        checkpointedProviders.push(row.usage.provider);
        await memory.checkpointStore.save(row);
      },
      loadAdjudication: memory.checkpointStore.loadAdjudication,
      saveAdjudication: memory.checkpointStore.saveAdjudication,
    };
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      checkpointStore,
      onBeforeProviderCall: async () => {
        reservations += 1;
      },
      onProviderNotCalled: async () => undefined,
      onProviderUsage: async () => {
        separateUsageFinalizations += 1;
      },
    });
    assertEquals(result.adjudication?.adjudication_mode, "agreement");
    assertEquals(reservations, 2);
    assertEquals(checkpointedProviders.sort(), ["deepseek", "gemini"]);
    assertEquals(separateUsageFinalizations, 0);
  },
);

Deno.test(
  "durable Pro checkpoint owns exact adjudication usage atomically",
  async () => {
    const memory = memoryCheckpointStore();
    const reservations: WorksheetAnswerProviderCall[] = [];
    let proUsage: WorksheetAnswerProviderUsage | null = null;
    let separateUsageFinalizations = 0;
    const checkpointStore: WorksheetAnswerCheckpointStore = {
      load: memory.checkpointStore.load,
      save: memory.checkpointStore.save,
      loadAdjudication: memory.checkpointStore.loadAdjudication,
      saveAdjudication: async (row) => {
        proUsage = row.usage;
        await memory.checkpointStore.saveAdjudication(row);
      },
    };
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });

    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: "gemini",
      }),
      checkpointStore,
      usageCallKeyPrefix: "job:durable-pro:v1:attempt1",
      onBeforeProviderCall: async (call) => {
        reservations.push(call);
      },
      onProviderNotCalled: async () => undefined,
      onProviderUsage: async () => {
        separateUsageFinalizations += 1;
      },
    });

    assertEquals(result.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(reservations.length, 3);
    assertEquals(separateUsageFinalizations, 0);
    assertEquals(proUsage, {
      provider: "deepseek",
      requested_model: DEEPSEEK_V1_PRO_MODEL,
      provider_model_version: DEEPSEEK_V1_PRO_MODEL,
      input_tokens: 180,
      output_tokens: 30,
      cached_input_tokens: 0,
      uncached_input_tokens: 180,
      call_purpose: "worksheet_answer_adjudication",
      call_key: "job:durable-pro:v1:attempt1:deepseek:adjudication",
    });
    assertEquals(
      memory.adjudicationCheckpoint?.verdictSha256,
      result.adjudication?.pro_result_sha256,
    );
  },
);

Deno.test(
  "invalid durable Pro payload settles known usage without a checkpoint",
  async () => {
    const memory = memoryCheckpointStore();
    const finalizedUsage: WorksheetAnswerProviderUsage[] = [];
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const invalidProResponse = Response.json({
      model: DEEPSEEK_V1_PRO_MODEL,
      provider_model_version: DEEPSEEK_V1_PRO_MODEL,
      choices: [{
        finish_reason: "stop",
        message: { content: "{}" },
      }],
      usage: {
        prompt_tokens: 180,
        completion_tokens: 30,
        total_tokens: 210,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });

    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [incorrect],
          proResponse: invalidProResponse,
        }),
        checkpointStore: memory.checkpointStore,
        onBeforeProviderCall: async () => undefined,
        onProviderNotCalled: async () => undefined,
        onProviderUsage: async (usage) => {
          finalizedUsage.push(usage);
        },
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: false,
      },
    );

    assertEquals(finalizedUsage, [{
      provider: "deepseek",
      requested_model: DEEPSEEK_V1_PRO_MODEL,
      provider_model_version: DEEPSEEK_V1_PRO_MODEL,
      input_tokens: 180,
      output_tokens: 30,
      cached_input_tokens: 0,
      uncached_input_tokens: 180,
      call_purpose: "worksheet_answer_adjudication",
      call_key: `attempt:${attempt.id}:v${attempt.evaluation_version}:deepseek:adjudication`,
    }]);
    assertEquals(memory.rows.size, 2);
    assertEquals(memory.adjudicationCheckpoint, null);
  },
);

Deno.test(
  "DeepSeek Pro disagreement checkpoint is reused without provider redispatch",
  async () => {
    const memory = memoryCheckpointStore();
    const calls: string[] = [];
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const args = evaluationArgs({
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: "gemini",
        calls,
      }),
      geminiSecondary: geminiEvaluator([reviewJson()], calls),
      checkpointStore: memory.checkpointStore,
    });

    const first = await evaluateLoadedWorksheetAnswers(args);
    const callsAfterFirstCompletion = [...calls];
    const second = await evaluateLoadedWorksheetAnswers(args);

    assertEquals(first.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(second.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(
      second.adjudication?.pro_result_sha256,
      first.adjudication?.pro_result_sha256,
    );
    assertEquals(calls, callsAfterFirstCompletion);
    assertEquals(
      calls.filter((model) => model === DEEPSEEK_V1_FLASH_MODEL).length,
      1,
    );
    assertEquals(
      calls.filter((model) => model === GEMINI_V1_ANSWER_MODEL).length,
      1,
    );
    assertEquals(
      calls.filter((model) => model === DEEPSEEK_V1_PRO_MODEL).length,
      1,
    );
    assertEquals(memory.rows.size, 2);
    assert(memory.adjudicationCheckpoint, "Expected a durable Pro checkpoint.");
  },
);

Deno.test(
  "lost Pro checkpoint save response is recovered without a second Pro call",
  async () => {
    const memory = memoryCheckpointStore();
    const calls: string[] = [];
    let loseFirstSaveResponse = true;
    let adjudicationSaves = 0;
    const checkpointStore: WorksheetAnswerCheckpointStore = {
      load: memory.checkpointStore.load,
      save: memory.checkpointStore.save,
      loadAdjudication: memory.checkpointStore.loadAdjudication,
      saveAdjudication: async (row) => {
        adjudicationSaves += 1;
        await memory.checkpointStore.saveAdjudication(row);
        if (loseFirstSaveResponse) {
          loseFirstSaveResponse = false;
          throw new WorksheetAnswerEvaluationError(
            "worksheet_answer_checkpoint_unavailable",
            true,
          );
        }
      },
    };
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const args = evaluationArgs({
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: "gemini",
        calls,
      }),
      geminiSecondary: geminiEvaluator([reviewJson()], calls),
      checkpointStore,
    });

    try {
      await evaluateLoadedWorksheetAnswers(args);
      throw new Error("Expected the simulated lost save response to fail.");
    } catch (error) {
      assert(
        error instanceof WorksheetAnswerEvaluationError,
        "Expected the checkpoint error to remain structured.",
      );
      assertEquals(error.safeCode, "worksheet_answer_checkpoint_unavailable");
      assertEquals(error.retryable, true);
    }

    const recovered = await evaluateLoadedWorksheetAnswers(args);
    assertEquals(recovered.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(adjudicationSaves, 1);
    assertEquals(
      calls.filter((model) => model === DEEPSEEK_V1_PRO_MODEL).length,
      1,
    );
    assertEquals(calls.length, 3);
  },
);

Deno.test(
  "uncertain durable Pro checkpoint replays fail closed without redispatch",
  async () => {
    const memory = memoryCheckpointStore();
    const calls: string[] = [];
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const args = evaluationArgs({
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: null,
        calls,
      }),
      geminiSecondary: geminiEvaluator([reviewJson()], calls),
      checkpointStore: memory.checkpointStore,
    });

    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers(args),
      {
        reason: "semantic_adjudication_disagreement",
        retryable: false,
      },
    );
    const callsAfterFirstFailure = [...calls];
    assertEquals(
      memory.adjudicationCheckpoint?.payload.resolutions[0]
        ?.resolution_status,
      "uncertain",
    );

    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers(args),
      {
        reason: "semantic_adjudication_disagreement",
        retryable: false,
      },
    );
    assertEquals(calls, callsAfterFirstFailure);
    assertEquals(
      calls.filter((model) => model === DEEPSEEK_V1_PRO_MODEL).length,
      1,
    );
  },
);

Deno.test(
  "Gemini checkpoint is reused when DeepSeek transiently fails",
  async () => {
    const { checkpointStore, rows } = memoryCheckpointStore();
    let deepSeekCalls = 0;
    let geminiCalls = 0;
    const deepSeek = provider("deepseek", async () => {
      deepSeekCalls += 1;
      return deepSeekCalls === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : Response.json(
            completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [reviewJson()]),
          );
    });
    const gemini: GeminiSecondaryProvider = {
      ...geminiEvaluator(),
      provider: provider("gemini", async () => {
        geminiCalls += 1;
        return Response.json(
          completionEnvelope(GEMINI_V1_ANSWER_MODEL, [reviewJson()]),
        );
      }),
    };

    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeek,
        geminiSecondary: gemini,
        checkpointStore,
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );
    assertEquals(deepSeekCalls, 1);
    assertEquals(geminiCalls, 1);
    assertEquals(rows.has("deepseek"), false);
    assertEquals(rows.has("gemini"), true);

    const completed = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeek,
      geminiSecondary: gemini,
      checkpointStore,
    });
    assertEquals(completed.adjudication?.adjudication_mode, "agreement");
    assertEquals(deepSeekCalls, 2);
    assertEquals(geminiCalls, 1);
    assertEquals(rows.size, 2);
  },
);

Deno.test(
  "changed answer evidence cannot replay a prior provider checkpoint",
  async () => {
    const { checkpointStore } = memoryCheckpointStore();
    let deepSeekCalls = 0;
    let geminiCalls = 0;
    const deepSeek = provider("deepseek", async () => {
      deepSeekCalls += 1;
      return Response.json(
        completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [reviewJson()]),
      );
    });
    const gemini: GeminiSecondaryProvider = {
      ...geminiEvaluator(),
      provider: provider("gemini", async () => {
        geminiCalls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      }),
    };
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeek,
        geminiSecondary: gemini,
        checkpointStore,
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );

    try {
      await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        attempt: {
          ...attempt,
          answers: [{ question_id: questionId, answer: "Ich helfe den Mann." }],
        },
        provider: deepSeek,
        geminiSecondary: gemini,
        checkpointStore,
      });
    } catch (error) {
      assert(
        error instanceof WorksheetAnswerEvaluationError,
        "Expected a structured checkpoint mismatch.",
      );
      assertEquals(
        error.safeCode,
        "worksheet_answer_checkpoint_replay_mismatch",
      );
      assertEquals(error.retryable, false);
      assertEquals(deepSeekCalls, 1);
      assertEquals(geminiCalls, 1);
      return;
    }
    throw new Error("Expected changed answer evidence to fail closed.");
  },
);

Deno.test(
  "one checkpoint survives five outage redeliveries without finalizing alone",
  async () => {
    const { checkpointStore, rows } = memoryCheckpointStore();
    let deepSeekCalls = 0;
    let geminiCalls = 0;
    const deepSeek = provider("deepseek", async () => {
      deepSeekCalls += 1;
      return Response.json(
        completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [reviewJson()]),
      );
    });
    const gemini: GeminiSecondaryProvider = {
      ...geminiEvaluator(),
      provider: provider("gemini", async () => {
        geminiCalls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      }),
    };

    for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
      await expectEvaluationError(
        evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          provider: deepSeek,
          geminiSecondary: gemini,
          checkpointStore,
        }),
        {
          reason: "semantic_single_provider_incomplete",
          retryable: true,
          outage: true,
        },
      );
    }
    assertEquals(deepSeekCalls, 1);
    assertEquals(geminiCalls, 5);
    assertEquals(rows.has("deepseek"), true);
    assertEquals(rows.has("gemini"), false);
    assertEquals(rows.size, 1);
  },
);

Deno.test(
  "matching scores with malformed German require Pro to select clean feedback",
  async () => {
    const calls: string[] = [];
    const malformedGerman = reviewJson({
      feedback_text: "Die Subjekt ist in diesem Satz richtig.",
      short_reason: "Die Subjekt passt zur Verbform.",
    });
    const cleanGerman = reviewJson({
      feedback_text: "Das Subjekt passt in diesem Satz zur Verbform.",
      short_reason: "Das Subjekt und die Verbform stimmen überein.",
    });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeekProvider({
        flash: [malformedGerman],
        proSelection: "gemini",
        inspectProPayload: (payload) => {
          const messages = payload.messages as Array<{ content?: unknown }>;
          const prompt = String(messages.at(-1)?.content ?? "");
          assert(
            prompt.includes(malformedGerman.feedback_text) &&
              prompt.includes(cleanGerman.feedback_text),
            "Pro did not receive both student-facing feedback candidates.",
          );
          assert(
            prompt.includes('"student_feedback_language_invalid":true'),
            "Pro did not receive the deterministic language-quality signal.",
          );
        },
        calls,
      }),
      geminiSecondary: geminiEvaluator([cleanGerman], calls),
    });

    assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), true);
    assertEquals(result.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(result.adjudication?.selected_provider_source, "gemini");
    assertEquals(result.reviews[0]?.evaluator_source, "gemini");
    assertEquals(result.reviews[0]?.feedback_text, cleanGerman.feedback_text);
    assertEquals(result.reviews[0]?.short_reason, cleanGerman.short_reason);
  },
);

Deno.test(
  "common high-confidence English feedback cannot auto-release",
  async () => {
    for (const feedbackText of [
      "Good job.",
      "Well done.",
      "Everything is right.",
      "The answer is correct.",
      "Correct.",
      "You are correct.",
      "Excellent work.",
      "The verb is correct.",
      "You're right; it's perfect.",
      "You’re right; it’s perfect.",
      "Good.",
      "Try again.",
      "Please try again.",
      "Nice job.",
      "Needs improvement.",
      "Awesome.",
      "Outstanding work.",
      "Almost there.",
      "Keep trying.",
      "Not quite.",
    ]) {
      const calls: string[] = [];
      const cleanGerman = reviewJson({
        feedback_text: "Die Antwort erfüllt die Zielgrammatik.",
        short_reason: "Alle Bewertungskriterien sind erfüllt.",
      });
      const result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [
            reviewJson({
              feedback_text: feedbackText,
              short_reason: "Die Punktzahl wurde korrekt bestimmt.",
            }),
          ],
          proSelection: "gemini",
          calls,
        }),
        geminiSecondary: geminiEvaluator([cleanGerman], calls),
      });

      assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), true);
      assertEquals(result.reviews[0]?.evaluator_source, "gemini");
      assertEquals(result.reviews[0]?.feedback_text, cleanGerman.feedback_text);
    }
  },
);

Deno.test(
  "unambiguously malformed German grammar terms cannot auto-release",
  async () => {
    for (const feedbackText of [
      "Der Verb ist richtig gewählt.",
      "Eine Adjektiv steht vor dem Nomen.",
      "Die Objekt steht im Akkusativ.",
      "Das Satz ist korrekt.",
      "Ein Antwort ist vollständig.",
    ]) {
      const calls: string[] = [];
      const cleanGerman = reviewJson({
        feedback_text: "Die Antwort erfüllt die Zielgrammatik.",
        short_reason: "Alle Bewertungskriterien sind erfüllt.",
      });
      const result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [
            reviewJson({
              feedback_text: feedbackText,
              short_reason: "Die Punktzahl wurde korrekt bestimmt.",
            }),
          ],
          proSelection: "gemini",
          calls,
        }),
        geminiSecondary: geminiEvaluator([cleanGerman], calls),
      });

      assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), true);
      assertEquals(result.reviews[0]?.evaluator_source, "gemini");
    }
  },
);

Deno.test(
  "uncertain language-quality adjudication remains private",
  async () => {
    const malformedGerman = reviewJson({
      feedback_text: "Die Subjekt ist in diesem Satz richtig.",
      short_reason: "Die Subjekt passt zur Verbform.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [malformedGerman],
          proSelection: null,
        }),
        geminiSecondary: geminiEvaluator([reviewJson()]),
      }),
      {
        reason: "semantic_adjudication_disagreement",
        retryable: false,
      },
    );
  },
);

Deno.test(
  "common quoted learner errors and Unicode compounds do not create Pro work",
  async () => {
    const feedbackTexts = [
      "Die Form „die Subjekt“ ist falsch; richtig heißt es „das Subjekt“.",
      "Die Form “die Subjekt” ist falsch; richtig heißt es “das Subjekt”.",
      "Die Form »die Subjekt« ist falsch; richtig heißt es »das Subjekt«.",
      "Die Form ›die Subjekt‹ ist falsch; richtig heißt es ›das Subjekt‹.",
      "Die Form ‘die Subjekt’ ist falsch; richtig heißt es ‘das Subjekt’.",
      "Die Form 'die Subjekt' ist falsch; richtig heißt es 'das Subjekt'.",
      "Die Form `die Subjekt` ist falsch; richtig heißt es `das Subjekt`.",
      "Die englische Wendung “the answer” wird hier nur zitiert.",
      "Die englische Wendung 'You're right' wird hier nur zitiert.",
      "Die englische Wendung ‘You’re right’ wird hier nur zitiert.",
      "Der Ortsname “Nice” wird hier nur zitiert.",
      ...[
        "-",
        "\u00ad",
        "\u2010",
        "\u2011",
        "\u2012",
        "\u2013",
        "\u2014",
        "\u2015",
        "\u2043",
        "\u2212",
        "\u2e3a",
        "\u2e3b",
        "\ufe58",
        "\ufe63",
        "\uff0d",
      ].map((dash) => `Die Subjekt${dash}Verb${dash}Kongruenz stimmt.`),
    ];

    for (const feedbackText of feedbackTexts) {
      const calls: string[] = [];
      const explanatoryGerman = reviewJson({
        feedback_text: feedbackText,
        short_reason: "Das grammatische Geschlecht wird korrekt erklärt.",
      });
      const result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [explanatoryGerman],
          calls,
        }),
        geminiSecondary: geminiEvaluator([explanatoryGerman], calls),
      });

      assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), false);
      assertEquals(result.adjudication?.adjudication_mode, "agreement");
      assertEquals(
        result.reviews[0]?.feedback_text,
        explanatoryGerman.feedback_text,
      );
    }
  },
);

Deno.test(
  "valid German case forms and plurals remain on the clean agreement path",
  async () => {
    for (const feedbackText of [
      "Das Subjekt und das Verb stimmen überein.",
      "Dem Verb folgt ein korrektes Objekt.",
      "Ein Adjektiv beschreibt das Nomen.",
      "Der Satz ist korrekt aufgebaut.",
      "Die Antwort ist vollständig.",
      "Mit einer Antwort ist die Aufgabe abgeschlossen.",
      "Die Subjekte und die Verben stimmen überein.",
      "Was du geschrieben hast, zeigt, was du verstanden hast.",
      "All das ist richtig.",
      "Der Job ist gut beschrieben.",
      "Fast richtig, bitte weiterüben.",
      "Noch nicht ganz, aber fast.",
    ]) {
      const calls: string[] = [];
      const review = reviewJson({
        feedback_text: feedbackText,
        short_reason: "Die Grammatik wird korrekt erklärt.",
      });
      const result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [review], calls }),
        geminiSecondary: geminiEvaluator([review], calls),
      });

      assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), false);
      assertEquals(result.adjudication?.adjudication_mode, "agreement");
      assertEquals(result.reviews[0]?.feedback_text, feedbackText);
    }
  },
);

Deno.test(
  "Pro cannot release provider evidence whose student-facing German is invalid",
  async () => {
    const malformedGerman = reviewJson({
      feedback_text: "Die Subjekt ist in diesem Satz richtig.",
      short_reason: "Die Subjekt passt zur Verbform.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [malformedGerman],
          proSelection: "deepseek",
        }),
        geminiSecondary: geminiEvaluator([reviewJson()]),
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: false,
      },
    );
  },
);

Deno.test(
  "native Gemini transport integrates with semantic answer validation",
  async () => {
    const secret = "gemini-test-secret-must-not-leak";
    let requestUrl = "";
    let requestBody = "";
    let requestKey = "";
    const secondary = createOptionalGeminiSecondaryProvider({
      apiKey: secret,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = String(init?.body ?? "");
        requestKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
        return Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({ reviews: [reviewJson()] }),
                  },
                ],
              },
            },
          ],
          modelVersion: GEMINI_V1_ANSWER_MODEL,
          usageMetadata: {
            promptTokenCount: 90,
            candidatesTokenCount: 30,
            totalTokenCount: 120,
          },
        });
      },
    });
    assert(secondary, "Expected a configured native Gemini provider.");
    assertEquals(secondary.answerModel, GEMINI_V1_ANSWER_MODEL);
    assertEquals(secondary.provider.providerName, "gemini");

    const usage: WorksheetAnswerProviderUsage[] = [];
    let result;
    try {
      result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        geminiSecondary: secondary,
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async (entry) => {
          usage.push(entry);
        },
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      throw new Error(
        `Native integration failed: ${
          error instanceof WorksheetAnswerEvaluationError
            ? `${error.safeCode}/${error.needsReviewReason}`
            : String(error)
        }; dispatched=${Boolean(requestUrl)}`,
      );
    }

    assertEquals(result.mode, "evaluated");
    assert(
      requestUrl.includes(encodeURIComponent(GEMINI_V1_ANSWER_MODEL)),
      "The native endpoint did not bind the pinned answer model.",
    );
    assertEquals(requestKey, secret);
    assertEquals(requestUrl.includes(secret), false);
    assertEquals(requestBody.includes(secret), false);
    const nativeBody = JSON.parse(requestBody) as Record<string, unknown>;
    const generationConfig = nativeBody.generationConfig as Record<
      string,
      unknown
    >;
    assertEquals(generationConfig.responseMimeType, "application/json");
    assert(
      typeof generationConfig.responseJsonSchema === "object",
      "Native structured-output schema was not sent.",
    );
    const geminiUsage = usage.find((entry) => entry.provider === "gemini");
    assertEquals(geminiUsage?.input_tokens, 90);
    assertEquals(geminiUsage?.output_tokens, 30);
  },
);

Deno.test(
  "every billed evaluator envelope reports provider-neutral usage",
  async () => {
    const usage: WorksheetAnswerProviderUsage[] = [];
    const lifecycle: Array<{
      stage: "before" | "usage";
      identity: WorksheetAnswerProviderCall;
    }> = [];
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      usageCallKeyPrefix: "job:test:v1:attempt1",
      onBeforeProviderCall: async (call) => {
        lifecycle.push({ stage: "before", identity: call });
      },
      onProviderUsage: async (entry) => {
        usage.push(entry);
        lifecycle.push({
          stage: "usage",
          identity: {
            provider: entry.provider,
            requested_model: entry.requested_model,
            call_purpose: entry.call_purpose,
            call_key: entry.call_key,
          },
        });
      },
      onProviderNotCalled: async () => undefined,
    });

    assertEquals(result.mode, "evaluated");
    assertEquals(
      usage
        .map((entry) => ({
          provider: entry.provider,
          requested_model: entry.requested_model,
          provider_model_version: entry.provider_model_version,
          input_tokens: entry.input_tokens,
          output_tokens: entry.output_tokens,
          call_purpose: entry.call_purpose,
          call_key: entry.call_key,
        }))
        .sort((left, right) => left.provider.localeCompare(right.provider)),
      [
        {
          provider: "deepseek",
          requested_model: DEEPSEEK_V1_FLASH_MODEL,
          provider_model_version: DEEPSEEK_V1_FLASH_MODEL,
          input_tokens: 120,
          output_tokens: 40,
          call_purpose: "worksheet_answer_evaluation",
          call_key: "job:test:v1:attempt1:deepseek:evaluation",
        },
        {
          provider: "gemini",
          requested_model: GEMINI_V1_ANSWER_MODEL,
          provider_model_version: GEMINI_V1_ANSWER_MODEL,
          input_tokens: 120,
          output_tokens: 40,
          call_purpose: "worksheet_answer_evaluation",
          call_key: "job:test:v1:attempt1:gemini:evaluation",
        },
      ],
    );
    for (const entry of usage) {
      const identity = {
        provider: entry.provider,
        requested_model: entry.requested_model,
        call_purpose: entry.call_purpose,
        call_key: entry.call_key,
      };
      const beforeIndex = lifecycle.findIndex(
        (event) =>
          event.stage === "before" &&
          JSON.stringify(event.identity) === JSON.stringify(identity),
      );
      const usageIndex = lifecycle.findIndex(
        (event) =>
          event.stage === "usage" &&
          JSON.stringify(event.identity) === JSON.stringify(identity),
      );
      assert(beforeIndex >= 0, "Missing pre-dispatch spend authorization.");
      assert(
        usageIndex > beforeIndex,
        "Usage finalization occurred before spend authorization.",
      );
    }
    const lastBeforeIndex = lifecycle.reduce(
      (last, event, index) => (event.stage === "before" ? index : last),
      -1,
    );
    const firstUsageIndex = lifecycle.findIndex(
      (event) => event.stage === "usage",
    );
    assert(
      firstUsageIndex > lastBeforeIndex,
      "A provider dispatched before both evaluation reservations succeeded.",
    );
  },
);

Deno.test(
  "a billed Pro disagreement reports separate adjudication usage",
  async () => {
    const usage: WorksheetAnswerProviderUsage[] = [];
    const before: WorksheetAnswerProviderCall[] = [];
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: "gemini",
      }),
      usageCallKeyPrefix: "job:test:v1:attempt2",
      onBeforeProviderCall: async (call) => {
        before.push(call);
      },
      onProviderUsage: async (entry) => {
        usage.push(entry);
      },
      onProviderNotCalled: async () => undefined,
    });

    assertEquals(result.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(
      usage.find(
        (entry) => entry.call_purpose === "worksheet_answer_adjudication",
      ),
      {
        provider: "deepseek",
        requested_model: DEEPSEEK_V1_PRO_MODEL,
        provider_model_version: DEEPSEEK_V1_PRO_MODEL,
        input_tokens: 180,
        output_tokens: 30,
        cached_input_tokens: 0,
        uncached_input_tokens: 180,
        call_purpose: "worksheet_answer_adjudication",
        call_key: "job:test:v1:attempt2:deepseek:adjudication",
      },
    );
    const proUsage = usage.find(
      (entry) => entry.call_purpose === "worksheet_answer_adjudication",
    );
    const proBefore = before.find(
      (entry) => entry.call_purpose === "worksheet_answer_adjudication",
    );
    assert(proUsage && proBefore, "Missing Pro accounting lifecycle events.");
    assertEquals(proBefore, {
      provider: proUsage.provider,
      requested_model: proUsage.requested_model,
      call_purpose: proUsage.call_purpose,
      call_key: proUsage.call_key,
    });
  },
);

Deno.test(
  "usage is recorded before invalid provider content is rejected",
  async () => {
    const usage: WorksheetAnswerProviderUsage[] = [];
    const contradiction = reviewJson({ points_awarded: 0 });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [contradiction] }),
        geminiSecondary: geminiEvaluator([contradiction]),
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async (entry) => {
          usage.push(entry);
        },
        onProviderNotCalled: async () => undefined,
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: true,
      },
    );
    assertEquals(usage.length, 2);
  },
);

Deno.test(
  "usage-accounting failure fails closed before answer persistence",
  async () => {
    try {
      await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async () => {
          throw new Error("ledger unavailable");
        },
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      assert(
        error instanceof WorksheetAnswerEvaluationError,
        "Expected a structured accounting failure.",
      );
      assertEquals(error.safeCode, "worksheet_spend_accounting_failed");
      assertEquals(error.retryable, true);
      assertEquals(error.needsReviewReason, null);
      return;
    }
    throw new Error("Expected usage-accounting failure to stop completion.");
  },
);

Deno.test(
  "non-retryable spend rejection prevents every provider dispatch",
  async () => {
    const providerCalls: string[] = [];
    const before: WorksheetAnswerProviderCall[] = [];
    const released: Array<{
      call: WorksheetAnswerProviderCall;
      reason: "provider_not_called" | "request_failed_unbilled";
    }> = [];
    try {
      await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ calls: providerCalls }),
        geminiSecondary: geminiEvaluator([reviewJson()], providerCalls),
        onBeforeProviderCall: async (call) => {
          before.push(call);
          if (call.provider === "gemini") {
            throw {
              safeCode: "ai_spend_budget_exceeded",
              retryable: false,
            };
          }
        },
        onProviderNotCalled: async (call, reason) => {
          released.push({ call, reason });
        },
        onProviderUsage: async () => undefined,
      });
    } catch (error) {
      assert(
        error instanceof WorksheetAnswerEvaluationError,
        "Expected a structured spend rejection.",
      );
      assertEquals(error.safeCode, "worksheet_spend_accounting_failed");
      assertEquals(error.retryable, false);
      assertEquals(providerCalls, []);
      assertEquals(before.map((entry) => entry.provider).sort(), [
        "deepseek",
        "gemini",
      ]);
      assertEquals(released, [
        {
          call: before.find((entry) => entry.provider === "deepseek"),
          reason: "provider_not_called",
        },
      ]);
      return;
    }
    throw new Error("Expected spend rejection to stop provider dispatch.");
  },
);

function answerLifecycleRecorder() {
  const before: WorksheetAnswerProviderCall[] = [];
  const usage: WorksheetAnswerProviderUsage[] = [];
  const released: Array<{
    call: WorksheetAnswerProviderCall;
    reason: string;
  }> = [];
  return {
    before,
    usage,
    released,
    onBeforeProviderCall: async (call: WorksheetAnswerProviderCall) => {
      before.push(call);
    },
    onProviderUsage: async (entry: WorksheetAnswerProviderUsage) => {
      usage.push(entry);
    },
    onProviderNotCalled: async (
      call: WorksheetAnswerProviderCall,
      reason: "provider_not_called" | "request_failed_unbilled",
    ) => {
      released.push({ call, reason });
    },
  };
}

Deno.test(
  "answer-provider lifecycle hooks are all-or-none before the reservation barrier",
  async () => {
    const providerCalls: string[] = [];
    let failure: unknown;
    try {
      await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ calls: providerCalls }),
        geminiSecondary: geminiEvaluator([reviewJson()], providerCalls),
        onBeforeProviderCall: async () => undefined,
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof WorksheetAnswerEvaluationError,
      "Partial lifecycle configuration must fail with a stable error.",
    );
    assertEquals(failure.safeCode, "worksheet_spend_accounting_failed");
    assertEquals(failure.retryable, false);
    assertEquals(providerCalls, []);
  },
);

Deno.test(
  "both answer evaluators release only proven local pre-dispatch configuration failures",
  async () => {
    for (const failingProvider of ["deepseek", "gemini"] as const) {
      const lifecycle = answerLifecycleRecorder();
      const deepseek =
        failingProvider === "deepseek"
          ? provider("deepseek", async () => {
              throw new ChatCompletionProviderConfigurationError();
            })
          : deepSeekProvider();
      const gemini =
        failingProvider === "gemini"
          ? {
              ...geminiEvaluator(),
              provider: provider("gemini", async () => {
                throw new ChatCompletionProviderConfigurationError();
              }),
            }
          : geminiEvaluator();
      try {
        await evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          provider: deepseek,
          geminiSecondary: gemini,
          onBeforeProviderCall: lifecycle.onBeforeProviderCall,
          onProviderUsage: lifecycle.onProviderUsage,
          onProviderNotCalled: lifecycle.onProviderNotCalled,
        });
      } catch {
        // One required evaluator failed locally before transport.
      }
      assertEquals(lifecycle.released, [
        {
          call: lifecycle.before.find(
            (call) =>
              call.provider === failingProvider &&
              call.call_purpose === "worksheet_answer_evaluation",
          ),
          reason: "provider_not_called",
        },
      ]);
    }
  },
);

Deno.test(
  "only documented Gemini 400 and 500 answer responses release as unbilled",
  async () => {
    for (const status of [400, 500] as const) {
      const lifecycle = answerLifecycleRecorder();
      try {
        await evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          geminiSecondary: geminiEvaluator(new Response("{}", { status })),
          onBeforeProviderCall: lifecycle.onBeforeProviderCall,
          onProviderUsage: lifecycle.onProviderUsage,
          onProviderNotCalled: lifecycle.onProviderNotCalled,
        });
      } catch {
        // A required independent evaluator failed; settlement is asserted.
      }
      assertEquals(lifecycle.released, [
        {
          call: lifecycle.before.find((call) => call.provider === "gemini"),
          reason: "request_failed_unbilled",
        },
      ]);
    }
  },
);

Deno.test(
  "dispatched answer-evaluation failures remain conservatively reserved",
  async () => {
    const malformedUsageEnvelope = completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [
      reviewJson(),
    ]);
    malformedUsageEnvelope.usage.completion_tokens = -1;
    const cases: Array<{
      name: string;
      primary?: ChatCompletionProvider;
      secondary?: GeminiSecondaryProvider;
      failFinalization?: boolean;
    }> = [
      {
        name: "deepseek_http",
        primary: provider(
          "deepseek",
          async () => new Response("{}", { status: 503 }),
        ),
      },
      {
        name: "gemini_other_http",
        secondary: geminiEvaluator(new Response("{}", { status: 503 })),
      },
      {
        name: "network",
        primary: provider("deepseek", async () => {
          throw new Error("network unavailable");
        }),
      },
      {
        name: "abort",
        primary: provider("deepseek", async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
      },
      {
        name: "redirect",
        primary: provider("deepseek", async () => {
          throw new ChatCompletionProviderResponseError("redirect_rejected");
        }),
      },
      {
        name: "oversize",
        primary: provider(
          "deepseek",
          async () =>
            new Response("{}", {
              status: 200,
              headers: { "content-length": "600000" },
            }),
        ),
      },
      {
        name: "malformed_2xx",
        primary: provider(
          "deepseek",
          async () => new Response("{", { status: 200 }),
        ),
      },
      {
        name: "invalid_usage",
        primary: provider("deepseek", async () =>
          Response.json(malformedUsageEnvelope),
        ),
      },
      { name: "finalization", failFinalization: true },
    ];

    for (const testCase of cases) {
      const lifecycle = answerLifecycleRecorder();
      try {
        await evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          provider: testCase.primary ?? deepSeekProvider(),
          geminiSecondary: testCase.secondary ?? geminiEvaluator(),
          onBeforeProviderCall: lifecycle.onBeforeProviderCall,
          onProviderUsage: testCase.failFinalization
            ? async () => {
                throw { retryable: true };
              }
            : lifecycle.onProviderUsage,
          onProviderNotCalled: lifecycle.onProviderNotCalled,
        });
      } catch {
        // All listed cases occur after dispatch and must stay conservative.
      }
      assertEquals(lifecycle.released, []);
    }
  },
);

Deno.test(
  "the answer adjudicator releases local configuration failures but never dispatched failures",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const run = async (
      proComplete: (payload: Record<string, unknown>) => Promise<Response>,
      failFinalization = false,
    ) => {
      let proCalls = 0;
      const lifecycle = answerLifecycleRecorder();
      const primary = provider("deepseek", async (payload) => {
        if (String(payload.model) === DEEPSEEK_V1_FLASH_MODEL) {
          return Response.json(
            completionEnvelope(DEEPSEEK_V1_FLASH_MODEL, [incorrect]),
          );
        }
        proCalls += 1;
        return await proComplete(payload);
      });
      try {
        await evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          provider: primary,
          onBeforeProviderCall: lifecycle.onBeforeProviderCall,
          onProviderUsage: failFinalization
            ? async (usage) => {
                lifecycle.usage.push(usage);
                if (usage.call_purpose === "worksheet_answer_adjudication") {
                  throw { retryable: true };
                }
              }
            : lifecycle.onProviderUsage,
          onProviderNotCalled: lifecycle.onProviderNotCalled,
        });
      } catch {
        // The disputed answer cannot finalize without the Pro result.
      }
      assertEquals(proCalls, 1);
      return lifecycle;
    };

    const localFailure = await run(async () => {
      throw new ChatCompletionProviderConfigurationError();
    });
    assertEquals(localFailure.released, [
      {
        call: localFailure.before.find(
          (call) => call.call_purpose === "worksheet_answer_adjudication",
        ),
        reason: "provider_not_called",
      },
    ]);

    const dispatchedCases: Array<{
      name: string;
      run(payload: Record<string, unknown>): Promise<Response>;
      failFinalization?: boolean;
    }> = [
      ...[400, 401, 403, 429, 500, 503].map((status) => ({
        name: `http_${status}`,
        run: async () => new Response("{}", { status }),
      })),
      {
        name: "network",
        run: async () => {
          throw new Error("network unavailable");
        },
      },
      {
        name: "abort",
        run: async () => {
          throw new DOMException("Aborted", "AbortError");
        },
      },
      {
        name: "redirect",
        run: async () => {
          throw new ChatCompletionProviderResponseError("redirect_rejected");
        },
      },
      {
        name: "oversize",
        run: async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": "600000" },
          }),
      },
      { name: "malformed_2xx", run: async () => new Response("{") },
      {
        name: "invalid_usage",
        run: async (payload) => {
          const envelope = proEnvelope(payload, "gemini");
          envelope.usage.completion_tokens = -1;
          return Response.json(envelope);
        },
      },
      {
        name: "domain_invalid_after_usage",
        run: async () =>
          Response.json({
            model: DEEPSEEK_V1_PRO_MODEL,
            provider_model_version: DEEPSEEK_V1_PRO_MODEL,
            choices: [
              {
                finish_reason: "stop",
                message: { content: "{}" },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              prompt_tokens_details: { cached_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          }),
      },
      {
        name: "finalization",
        run: async (payload) => Response.json(proEnvelope(payload, "gemini")),
        failFinalization: true,
      },
    ];
    for (const testCase of dispatchedCases) {
      const lifecycle = await run(testCase.run, testCase.failFinalization);
      assertEquals(lifecycle.released, []);
    }
  },
);

Deno.test(
  "valid alternative word order receives dual-confirmed full credit",
  async () => {
    const answer = "Am Abend liest er ein Buch.";
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      attempt: {
        ...attempt,
        answers: [{ question_id: questionId, answer }],
      },
      questions: [
        semanticQuestion({
          question_type: "word_order",
          prompt: "Form a correct main clause beginning with Am Abend.",
          correct_answer: "Er liest am Abend ein Buch.",
          rubric: {
            criteria: ["Accept grammatical verb-second alternatives."],
            sample_answer: "Er liest am Abend ein Buch.",
          },
        }),
      ],
      provider: deepSeekProvider({
        flash: [reviewJson({ model_answer: answer })],
      }),
      geminiSecondary: geminiEvaluator([reviewJson({ model_answer: answer })]),
    });
    assertEquals(result.reviews[0]?.review_status, "correct");
    assertEquals(result.reviews[0]?.points_awarded, 1);
  },
);

Deno.test(
  "punctuation and capitalization target errors cannot receive incidental-error credit",
  async () => {
    const cases: Array<{
      topic: LoadedTopic;
      worksheet: LoadedWorksheet;
      studentAnswer: string;
      targetAnswer: string;
      forbiddenStatus: "minor_punctuation" | "capitalization_issue";
      forbiddenPoints: 1 | 0.5;
      strictInstruction: string;
    }> = [
      {
        topic: {
          name: "Zeichensetzung",
          slug: "punctuation",
          level: "A2",
          description: "Satzzeichen gezielt anwenden.",
        },
        worksheet: {
          title: "Zeichensetzung üben",
          level: "A2",
          difficulty: "medium",
        },
        studentAnswer: "Kommst du.",
        targetAnswer: "Kommst du?",
        forbiddenStatus: "minor_punctuation",
        forbiddenPoints: 1,
        strictInstruction: "never minor_punctuation",
      },
      {
        topic: {
          name: "Großschreibung",
          slug: "capitalization",
          level: "A2",
          description: "Nomen korrekt großschreiben.",
        },
        worksheet: {
          title: "Großschreibung üben",
          level: "A2",
          difficulty: "medium",
        },
        studentAnswer: "Die pflege ist wichtig.",
        targetAnswer: "Die Pflege ist wichtig.",
        forbiddenStatus: "capitalization_issue",
        forbiddenPoints: 0.5,
        strictInstruction: "never capitalization_issue",
      },
    ];

    for (const testCase of cases) {
      const payloads: Array<{
        source: "deepseek" | "gemini";
        payload: Record<string, unknown>;
      }> = [];
      const forbiddenReview = reviewJson({
        review_status: testCase.forbiddenStatus,
        points_awarded: testCase.forbiddenPoints,
        corrected_answer: testCase.targetAnswer,
        model_answer: testCase.targetAnswer,
        feedback_text: "Die Zielstelle muss noch korrigiert werden.",
        short_reason: "Die Zielregel ist noch nicht richtig angewendet.",
      });
      const captureProvider = (source: "deepseek" | "gemini", model: string) =>
        provider(source, async (payload) => {
          payloads.push({ source, payload });
          return Response.json(completionEnvelope(model, [forbiddenReview]));
        });
      const secondary: GeminiSecondaryProvider = {
        answerModel: GEMINI_V1_ANSWER_MODEL,
        criticModel: GEMINI_V1_CRITIC_MODEL,
        strongModel: GEMINI_V1_STRONG_MODEL,
        provider: captureProvider("gemini", GEMINI_V1_ANSWER_MODEL),
      };

      await expectEvaluationError(
        evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          topic: testCase.topic,
          worksheet: testCase.worksheet,
          attempt: {
            ...attempt,
            answers: [
              { question_id: questionId, answer: testCase.studentAnswer },
            ],
          },
          questions: [
            semanticQuestion({
              prompt: "Korrigiere die vollständige Antwort.",
              correct_answer: testCase.targetAnswer,
              rubric: {
                criteria: ["Wende die Zielregel vollständig korrekt an."],
                sample_answer: testCase.targetAnswer,
              },
            }),
          ],
          provider: captureProvider("deepseek", DEEPSEEK_V1_FLASH_MODEL),
          geminiSecondary: secondary,
        }),
        {
          reason: "semantic_provider_quality_invalid",
          retryable: true,
        },
      );

      assertEquals(payloads.length, 2);
      for (const entry of payloads) {
        const messages = entry.payload.messages as Array<{ content?: unknown }>;
        const prompt = messages
          .map((message) => String(message.content ?? ""))
          .join("\n");
        assert(
          prompt.includes(testCase.strictInstruction),
          `${entry.source} is missing target-topic scoring instructions.`,
        );
      }
      const geminiPayload = payloads.find(
        (entry) => entry.source === "gemini",
      )?.payload;
      const responseFormat = geminiPayload?.response_format as
        | Record<string, unknown>
        | undefined;
      const jsonSchema = responseFormat?.json_schema as
        | Record<string, unknown>
        | undefined;
      const schema = jsonSchema?.schema as Record<string, unknown> | undefined;
      const properties = schema?.properties as
        | Record<string, unknown>
        | undefined;
      const reviews = properties?.reviews as
        | Record<string, unknown>
        | undefined;
      const items = reviews?.items as Record<string, unknown> | undefined;
      const reviewProperties = items?.properties as
        | Record<string, unknown>
        | undefined;
      const reviewStatus = reviewProperties?.review_status as
        | Record<string, unknown>
        | undefined;
      const allowedStatuses = reviewStatus?.enum as unknown[] | undefined;
      assert(
        Array.isArray(allowedStatuses) &&
          !allowedStatuses.includes(testCase.forbiddenStatus),
        "Gemini's strict schema must exclude the target-topic shortcut status.",
      );
    }
  },
);

Deno.test(
  "target-topic strictness preserves unrelated incidental-error statuses",
  async () => {
    const cases: Array<{
      topic: LoadedTopic;
      review: ReviewJson;
      expectedPoints: number;
    }> = [
      {
        topic: {
          name: "Zeichensetzung",
          slug: "punctuation",
          level: "A2",
          description: "Satzzeichen gezielt anwenden.",
        },
        review: reviewJson({
          review_status: "capitalization_issue",
          points_awarded: 0.5,
          corrected_answer: "Kommst du?",
          model_answer: "Kommst du?",
          feedback_text:
            "Das Satzzeichen stimmt; schreibe den Satzanfang noch groß.",
          short_reason: "Nur die Großschreibung am Satzanfang fehlt.",
        }),
        expectedPoints: 0.5,
      },
      {
        topic: {
          name: "Großschreibung",
          slug: "capitalization",
          level: "A2",
          description: "Nomen korrekt großschreiben.",
        },
        review: reviewJson({
          review_status: "minor_punctuation",
          points_awarded: 1,
          corrected_answer: "Die Pflege ist wichtig.",
          model_answer: "Die Pflege ist wichtig.",
          feedback_text:
            "Die Großschreibung stimmt; ergänze noch den Schlusspunkt.",
          short_reason: "Nur der nicht geprüfte Schlusspunkt fehlt.",
        }),
        expectedPoints: 1,
      },
    ];

    for (const testCase of cases) {
      const result = await evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        topic: testCase.topic,
        provider: deepSeekProvider({ flash: [testCase.review] }),
        geminiSecondary: geminiEvaluator([testCase.review]),
      });
      assertEquals(
        result.reviews[0]?.review_status,
        testCase.review.review_status,
      );
      assertEquals(result.reviews[0]?.points_awarded, testCase.expectedPoints);
    }
  },
);

Deno.test(
  "valid preposition alternative receives dual-confirmed full credit",
  async () => {
    const answer = "Ich warte auf den Bus.";
    const review = reviewJson({ model_answer: answer });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      attempt: {
        ...attempt,
        answers: [{ question_id: questionId, answer }],
      },
      questions: [
        semanticQuestion({
          question_type: "mini_writing",
          prompt: "Write a sentence using warten auf.",
          correct_answer: "Wir warten auf den Zug.",
          rubric: {
            criteria: ["Use warten auf with a correct accusative object."],
            sample_answer: "Wir warten auf den Zug.",
          },
        }),
      ],
      provider: deepSeekProvider({ flash: [review] }),
      geminiSecondary: geminiEvaluator([review]),
    });
    assertEquals(result.reviews[0]?.review_status, "correct");
    assertEquals(result.reviews[0]?.points_awarded, 1);
  },
);

Deno.test(
  "schema-valid semantic disagreement is resolved by hash-bound Pro",
  async () => {
    const calls: string[] = [];
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
      short_reason: "Die Dativanforderung ist nicht erfüllt.",
    });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: deepSeekProvider({
        flash: [incorrect],
        proSelection: "gemini",
        calls,
      }),
      geminiSecondary: geminiEvaluator([reviewJson()], calls),
    });
    assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), true);
    assertEquals(result.evaluator_model, GEMINI_V1_ANSWER_MODEL);
    assertEquals(result.reviews[0]?.evaluator_source, "gemini");
    assertEquals(result.reviews[0]?.review_status, "correct");
    assertEquals(result.adjudication?.adjudication_mode, "pro_resolved");
    assertEquals(result.adjudication?.selected_provider_source, "gemini");
    assertEquals(result.adjudication?.selected_question_sources, [
      {
        question_id: questionId,
        provider_source: "gemini",
      },
    ]);
    assertEquals(result.adjudication?.pro_result_sha256?.length, 64);
  },
);

Deno.test(
  "Pro can resolve different disputed questions from different providers",
  async () => {
    const deepSeekIncorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    const deepSeekCorrect = reviewJson({
      question_ref: "q2",
      model_answer: "Wir danken der Lehrerin.",
    });
    const geminiCorrect = reviewJson();
    const geminiIncorrect = reviewJson({
      question_ref: "q2",
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Wir danken der Lehrerin.",
      model_answer: "Wir danken der Lehrerin.",
    });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      attempt: {
        ...attempt,
        answers: [
          { question_id: questionId, answer: "Ich helfe dem Mann." },
          { question_id: secondQuestionId, answer: "Wir danken der Lehrerin." },
        ],
      },
      questions: [
        semanticQuestion(),
        semanticQuestion({
          id: secondQuestionId,
          question_number: 2,
          prompt: "Rewrite the sentence with danken.",
          correct_answer: "Wir danken der Lehrerin.",
          rubric: {
            criteria: ["Use danken with a correct dative object."],
            sample_answer: "Wir danken der Lehrerin.",
          },
        }),
      ],
      provider: deepSeekProvider({
        flash: [deepSeekIncorrect, deepSeekCorrect],
        proSelections: ["gemini", "deepseek"],
      }),
      geminiSecondary: geminiEvaluator([geminiCorrect, geminiIncorrect]),
    });

    assertEquals(
      result.evaluator_model,
      `deepseek-v4-flash+${GEMINI_V1_ANSWER_MODEL}`,
    );
    assertEquals(
      result.reviews.map((review) => review.evaluator_source),
      ["gemini", "deepseek"],
    );
    assertEquals(result.adjudication?.selected_provider_source, "mixed");
    assertEquals(result.adjudication?.selected_question_sources, [
      { question_id: questionId, provider_source: "gemini" },
      { question_id: secondQuestionId, provider_source: "deepseek" },
    ]);
  },
);

Deno.test(
  "uncertain Pro adjudication remains private for teacher review",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [incorrect], proSelection: null }),
      }),
      {
        reason: "semantic_adjudication_disagreement",
        retryable: false,
      },
    );
  },
);

Deno.test(
  "invalid Pro resolution remains private rather than auto-finalizing",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [incorrect],
          proResponse: Response.json({
            model: DEEPSEEK_V1_PRO_MODEL,
            choices: [
              {
                finish_reason: "stop",
                message: { content: "{}" },
              },
            ],
          }),
        }),
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: false,
      },
    );
  },
);

Deno.test(
  "a transient Pro failure uses an ordinary bounded retry",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [incorrect],
          proResponse: new Response(null, { status: 503 }),
        }),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
      },
    );
  },
);

Deno.test(
  "a resource-interrupted Pro adjudication uses an ordinary bounded retry",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [incorrect],
          proResponse: Response.json(
            resourceInterruptedEnvelope(DEEPSEEK_V1_PRO_MODEL),
          ),
        }),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
      },
    );
  },
);

Deno.test(
  "one successful evaluator plus one transient failure cannot finalize",
  async () => {
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: new Response(null, { status: 503 }),
        }),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );
  },
);

Deno.test(
  "DeepSeek resource interruption cannot finalize one-provider evidence",
  async () => {
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: Response.json(
            resourceInterruptedEnvelope(DEEPSEEK_V1_FLASH_MODEL),
          ),
        }),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );
  },
);

Deno.test(
  "a Gemini deadline abort cannot auto-finalize one-provider evidence",
  async () => {
    const timedOutGemini: GeminiSecondaryProvider = {
      answerModel: GEMINI_V1_ANSWER_MODEL,
      criticModel: GEMINI_V1_CRITIC_MODEL,
      strongModel: GEMINI_V1_STRONG_MODEL,
      provider: provider(
        "gemini",
        (_payload, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    };
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        geminiSecondary: timedOutGemini,
        secondaryTimeoutMs: 1,
        totalProviderTimeoutMs: 10,
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
        outage: true,
      },
    );
  },
);

Deno.test(
  "delayed usage accounting cannot overrun the total provider deadline",
  async () => {
    let usageRecords = 0;
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        providerTimeoutMs: 5,
        secondaryTimeoutMs: 5,
        totalProviderTimeoutMs: 5,
        onBeforeProviderCall: () => Promise.resolve(),
        onProviderUsage: async () => {
          usageRecords += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        onProviderNotCalled: () => Promise.resolve(),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
      },
    );
    assertEquals(usageRecords, 2);
  },
);

Deno.test(
  "Pro adjudication reserves its bounded usage-accounting slack",
  async () => {
    const calls: string[] = [];
    const malformedGerman = reviewJson({
      feedback_text: "Die Subjekt ist in diesem Satz richtig.",
      short_reason: "Die Subjekt passt zur Verbform.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: [malformedGerman],
          proSelection: "gemini",
          calls,
        }),
        geminiSecondary: geminiEvaluator([reviewJson()], calls),
        totalProviderTimeoutMs: 4_000,
        onBeforeProviderCall: () => Promise.resolve(),
        onProviderUsage: () => Promise.resolve(),
        onProviderNotCalled: () => Promise.resolve(),
      }),
      {
        reason: "semantic_single_provider_incomplete",
        retryable: true,
      },
    );
    assertEquals(calls.includes(DEEPSEEK_V1_PRO_MODEL), false);
    assertEquals(
      calls.sort(),
      [DEEPSEEK_V1_FLASH_MODEL, GEMINI_V1_ANSWER_MODEL].sort(),
    );
  },
);

Deno.test(
  "true dual transient failure alone enters provider-outage recovery",
  async () => {
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: new Response(null, { status: 503 }),
        }),
        geminiSecondary: geminiEvaluator(new Response(null, { status: 503 })),
      }),
      {
        reason: null,
        retryable: true,
        outage: true,
      },
    );
  },
);

Deno.test(
  "invalid schema-valid scoring is bounded and never returns a result",
  async () => {
    const contradiction = reviewJson({ points_awarded: 0 });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [contradiction] }),
        geminiSecondary: geminiEvaluator([contradiction]),
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: true,
      },
    );
  },
);

Deno.test(
  "mismatched native Gemini model provenance fails closed",
  async () => {
    const envelope = completionEnvelope(GEMINI_V1_ANSWER_MODEL, [reviewJson()]);
    envelope.provider_model_version = "gemini-unpinned-model";
    let usageRecorded = false;
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        geminiSecondary: geminiEvaluator(Response.json(envelope)),
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async (usage) => {
          if (usage.provider === "gemini") usageRecorded = true;
        },
        onProviderNotCalled: async () => undefined,
      }),
      {
        reason: "semantic_provider_output_invalid",
        retryable: true,
      },
    );
    assertEquals(usageRecorded, false);
  },
);

Deno.test(
  "missing independent adjudicator fails closed with a distinct reason",
  async () => {
    const calls: string[] = [];
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ calls }),
        geminiSecondary: null,
      }),
      {
        reason: "semantic_adjudicator_not_configured",
        retryable: false,
      },
    );
    assertEquals(calls, []);
  },
);

Deno.test(
  "provider authentication defects never enter outage recovery",
  async () => {
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({
          flash: new Response(null, { status: 401 }),
        }),
      }),
      {
        reason: "semantic_provider_authentication_failed",
        retryable: false,
      },
    );
  },
);

Deno.test(
  "correct verdicts cannot contain an unexplained rewrite",
  async () => {
    const unsafe = reviewJson({ corrected_answer: "Ich helfe der Frau." });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [unsafe] }),
        geminiSecondary: geminiEvaluator([unsafe]),
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: true,
      },
    );
  },
);

Deno.test(
  "student feedback cannot reveal Gemini or internal AI processing",
  async () => {
    const unsafe = reviewJson({
      feedback_text:
        "Gemini hat diese Antwort mit einem internen Prompt bewertet.",
    });
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ flash: [unsafe] }),
        geminiSecondary: geminiEvaluator([unsafe]),
      }),
      {
        reason: "semantic_provider_quality_invalid",
        retryable: true,
      },
    );
  },
);

Deno.test(
  "Flash evaluator text rejects PostgreSQL-unsafe Unicode",
  async () => {
    const unsafeValues = [
      "unsafe\u0000text",
      "unsafe\ud800text",
      "unsafe\udc00text",
    ];
    const fields = [
      "feedback_text",
      "corrected_answer",
      "model_answer",
      "short_reason",
    ] as const;

    for (const field of fields) {
      for (const unsafeValue of unsafeValues) {
        const unsafe = reviewJson({ [field]: unsafeValue });
        await expectEvaluationError(
          evaluateLoadedWorksheetAnswers({
            ...evaluationArgs(),
            provider: deepSeekProvider({ flash: [unsafe] }),
            geminiSecondary: geminiEvaluator([unsafe]),
          }),
          {
            reason: "semantic_provider_output_invalid",
            retryable: true,
          },
        );
      }
    }
  },
);

Deno.test(
  "Pro adjudicator reasons reject PostgreSQL-unsafe Unicode",
  async () => {
    const incorrect = reviewJson({
      review_status: "incorrect",
      points_awarded: 0,
      corrected_answer: "Ich helfe dem Mann.",
    });
    for (const unsafeValue of [
      "unsafe\u0000reason",
      "unsafe\ud800reason",
      "unsafe\udc00reason",
    ]) {
      await expectEvaluationError(
        evaluateLoadedWorksheetAnswers({
          ...evaluationArgs(),
          provider: deepSeekProvider({
            flash: [incorrect],
            proSelection: "gemini",
            proShortReason: unsafeValue,
          }),
        }),
        {
          reason: "semantic_provider_quality_invalid",
          retryable: false,
        },
      );
    }
  },
);

Deno.test(
  "semantic prompts use generic refs and never database identities",
  async () => {
    const prompts: string[] = [];
    const payloads: Array<{ name: "deepseek" | "gemini"; body: unknown }> = [];
    const capture = (
      name: "deepseek" | "gemini",
      model: string,
    ): ChatCompletionProvider =>
      provider(name, async (payload) => {
        prompts.push(JSON.stringify(payload));
        payloads.push({ name, body: payload });
        return Response.json(completionEnvelope(model, [reviewJson()]));
      });
    const result = await evaluateLoadedWorksheetAnswers({
      ...evaluationArgs(),
      provider: capture("deepseek", DEEPSEEK_V1_FLASH_MODEL),
      geminiSecondary: {
        answerModel: GEMINI_V1_ANSWER_MODEL,
        criticModel: GEMINI_V1_CRITIC_MODEL,
        strongModel: GEMINI_V1_STRONG_MODEL,
        provider: capture("gemini", GEMINI_V1_ANSWER_MODEL),
      },
    });
    assertEquals(result.mode, "evaluated");
    for (const prompt of prompts) {
      assert(!prompt.includes(attempt.id), "Attempt id leaked into a prompt.");
      assert(
        !prompt.includes(attempt.student_id),
        "Student id leaked into a prompt.",
      );
      assert(!prompt.includes(questionId), "Question id leaked into a prompt.");
      assert(
        prompt.includes("question_ref") && prompt.includes("q1"),
        "Generic q1 ref missing.",
      );
      assert(
        prompt.includes("clear, concise German"),
        "Student-facing German-language feedback contract is missing.",
      );
    }
    const geminiPayload = payloads.find((entry) => entry.name === "gemini")
      ?.body as Record<string, unknown> | undefined;
    assert(geminiPayload, "Expected the independent Gemini request.");
    assertEquals(geminiPayload.model, GEMINI_V1_ANSWER_MODEL);
    assertEquals(
      (geminiPayload.response_format as Record<string, unknown>)?.type,
      "json_schema",
    );
    assertEquals(geminiPayload.reasoning_effort, "minimal");
    assertEquals(Object.hasOwn(geminiPayload, "store"), false);
  },
);

Deno.test(
  "a Pro model cannot be substituted into the Flash evaluator role",
  async () => {
    let called = false;
    const secondaryCalls: string[] = [];
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        model: DEEPSEEK_V1_PRO_MODEL,
        provider: provider("deepseek", async () => {
          called = true;
          return Response.json({});
        }),
        geminiSecondary: geminiEvaluator([reviewJson()], secondaryCalls),
      }),
      {
        reason: "semantic_provider_configuration_failed",
        retryable: false,
      },
    );
    assertEquals(called, false);
    assertEquals(secondaryCalls, []);
  },
);

Deno.test(
  "a retired Gemini model cannot be substituted into the answer role",
  async () => {
    let called = false;
    const primaryCalls: string[] = [];
    const invalidSecondary = {
      answerModel: "gemini-3.5-flash",
      criticModel: GEMINI_V1_CRITIC_MODEL,
      strongModel: GEMINI_V1_STRONG_MODEL,
      provider: provider("gemini", async () => {
        called = true;
        return Response.json({});
      }),
    } as unknown as GeminiSecondaryProvider;
    await expectEvaluationError(
      evaluateLoadedWorksheetAnswers({
        ...evaluationArgs(),
        provider: deepSeekProvider({ calls: primaryCalls }),
        geminiSecondary: invalidSecondary,
      }),
      {
        reason: "semantic_adjudicator_not_configured",
        retryable: false,
      },
    );
    assertEquals(called, false);
    assertEquals(primaryCalls, []);
  },
);

Deno.test(
  "answer preparation loads and rechecks through api RPCs",
  async () => {
    const calls: Array<{ schema: string; name: string }> = [];
    const admin = {
      schema: (schema: string) => ({
        rpc: async (name: string) => {
          calls.push({ schema, name });
          if (name === "get_worksheet_answer_evaluation_context") {
            return {
              data: [
                {
                  attempt_id: attempt.id,
                  practice_test_id: attempt.practice_test_id,
                  assignment_id: assignment.id,
                  workspace_id: attempt.workspace_id,
                  student_id: attempt.student_id,
                  answers: attempt.answers,
                  attempt_status: attempt.status,
                  evaluation_status: attempt.evaluation_status,
                  evaluation_version: attempt.evaluation_version,
                  assignment_grammar_topic_id: assignment.grammar_topic_id,
                  assignment_practice_test_id: assignment.practice_test_id,
                  assignment_latest_attempt_id: assignment.latest_attempt_id,
                  assignment_status: assignment.status,
                  topic_name: topic.name,
                  topic_slug: topic.slug,
                  topic_level: topic.level,
                  topic_description: topic.description,
                  worksheet_title: worksheet.title,
                  worksheet_level: worksheet.level,
                  worksheet_difficulty: worksheet.difficulty,
                  questions: [
                    {
                      id: questionId,
                      question_number: 1,
                      question_type: "multiple_choice",
                      evaluation_mode: "local_exact",
                      prompt: "Choose the correct article.",
                      correct_answer: "dem",
                      accepted_answers: ["dem"],
                      rubric: null,
                      answer_contract_version: 1,
                      explanation: "Dative masculine article.",
                    },
                  ],
                  student_membership_active: true,
                },
              ],
              error: null,
            };
          }
          if (name === "is_worksheet_answer_evaluation_current") {
            return { data: true, error: null };
          }
          throw new Error(`Unexpected RPC ${name}`);
        },
      }),
    } as unknown as SupabaseAdminClient;

    const result = await prepareWorksheetAnswerCompletion({
      admin,
      attemptId: attempt.id,
      expectedVersion: attempt.evaluation_version,
      model: DEEPSEEK_V1_FLASH_MODEL,
    });
    assertEquals(result.mode, "not_needed");
    assertEquals(result.adjudication, null);
    assertEquals(calls, [
      { schema: "api", name: "get_worksheet_answer_evaluation_context" },
      { schema: "api", name: "is_worksheet_answer_evaluation_current" },
    ]);
  },
);
