import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ChatCompletionProvider } from "./chat-completion-provider.ts";
import {
  ChatCompletionProviderConfigurationError,
  ChatCompletionProviderResponseError,
  DEEPSEEK_V1_FLASH_MODEL,
  DEEPSEEK_V1_PRO_MODEL,
  GEMINI_V1_ANSWER_MODEL,
  GEMINI_V1_CRITIC_MODEL,
  GEMINI_V1_STRONG_MODEL,
  type GeminiSecondaryProvider,
} from "./chat-completion-provider.ts";
import {
  adjudicateGeminiRecoveryCandidate,
  adjudicateWritingCandidate,
  buildWritingSystemHold,
  canonicalJsonSha256,
  canonicalJsonText,
  sha256Text,
  WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS,
  WRITING_FLASH_CANDIDATE_TIMEOUT_MS,
  WRITING_GEMINI_CRITIC_CONTRACT_RETRY_TIMEOUT_MS,
  WRITING_GEMINI_CRITIC_TIMEOUT_MS,
  WRITING_GEMINI_FINAL_CRITIC_TIMEOUT_MS,
  WRITING_GEMINI_RECOVERY_GENERATOR_TIMEOUT_MS,
  WRITING_INDEPENDENT_FAST_BUDGET_MS,
  WRITING_INDEPENDENT_TOTAL_BUDGET_MS,
  WRITING_PRO_ADJUDICATOR_TIMEOUT_MS,
  WritingAdjudicationError,
} from "./writing-adjudication.ts";
import {
  buildFeedbackInputLines,
  buildWritingReleaseProjection,
  type FeedbackInputLine,
  type FeedbackPayload,
  reconstructCorrectedText,
  validateFeedbackPayload,
  type WritingProviderCall,
  type WritingProviderUsage,
} from "./writing-feedback.ts";

type LifecycleEvent =
  | { phase: "before"; value: WritingProviderCall }
  | { phase: "usage"; value: WritingProviderUsage }
  | { phase: "not_called"; value: WritingProviderCall };

function lifecycleRecorder() {
  const events: LifecycleEvent[] = [];
  return {
    events,
    onBeforeProviderCall: async (value: WritingProviderCall) => {
      events.push({ phase: "before", value });
    },
    onProviderUsage: async (value: WritingProviderUsage) => {
      events.push({ phase: "usage", value });
    },
    onProviderNotCalled: async (value: WritingProviderCall) => {
      events.push({ phase: "not_called", value });
    },
  };
}

type ProviderReply = {
  status?: number;
  model: string;
  content?: string;
  finishReason?: string;
};

function queuedProvider(
  replies: ProviderReply[],
  requests: Array<Record<string, unknown>> = [],
  providerName = "test-provider",
): ChatCompletionProvider {
  return {
    providerName,
    endpoint: "https://provider.example.test/chat/completions",
    async complete(payload) {
      requests.push(payload);
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected provider call.");
      if ((reply.status ?? 200) !== 200) {
        return new Response("{}", { status: reply.status });
      }
      return Response.json({
        model: reply.model,
        provider_model_version: reply.model,
        choices: [
          {
            finish_reason: reply.finishReason ?? "stop",
            message: { content: reply.content ?? "{}" },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  };
}

async function recoveryAdjudicationArgs(
  base: Awaited<ReturnType<typeof fixture>>,
  deepSeekProvider: ChatCompletionProvider,
) {
  return {
    candidate: base.candidate,
    inputLines: base.inputLines,
    targetLevel: "A2",
    questionTitle: "",
    questionPrompt: "",
    questionTopic: "",
    mode: "free_text",
    contextSha256: base.contextSha256,
    originalTextSha256: base.originalTextSha256,
    generatorModel: GEMINI_V1_STRONG_MODEL,
    deepSeekProvider,
    proModel: DEEPSEEK_V1_PRO_MODEL,
    deadlineAt: Date.now() + WRITING_INDEPENDENT_TOTAL_BUDGET_MS,
    validateFeedback: validateFeedbackPayload,
    buildReleaseProjection: (
      feedback: FeedbackPayload,
      acceptedModel: string,
    ) =>
      buildWritingReleaseProjection(base.inputLines, feedback, acceptedModel),
  };
}

function critic(provider: ChatCompletionProvider): GeminiSecondaryProvider {
  return {
    answerModel: GEMINI_V1_ANSWER_MODEL,
    criticModel: GEMINI_V1_CRITIC_MODEL,
    strongModel: GEMINI_V1_STRONG_MODEL,
    provider,
  };
}

function validFeedback(inputLines: FeedbackInputLine[]): FeedbackPayload {
  return validateFeedbackPayload(
    {
      overall_summary: "The writing is correct.",
      level_detected: "A2",
      score_summary: {
        correct_lines: inputLines.length,
        acceptable_lines: 0,
        minor_issues: 0,
        major_issues: 0,
        needs_review: 0,
      },
      grammar_topics: [],
      lines: inputLines.map((line) => ({
        line_number: line.line_number,
        source_start: line.source_start,
        source_end: line.source_end,
        original_line: line.text,
        corrected_line: line.text,
        status: "correct",
        changed_parts: [],
        short_explanation: "",
        detailed_explanation: "",
        grammar_topic: "",
      })),
    },
    inputLines,
  );
}

function criticDecision(args: {
  contextSha256: string;
  originalTextSha256: string;
  candidateFeedbackSha256: string;
  candidateReleaseSha256: string;
  verdict?: "approved" | "disagreed" | "uncertain";
}) {
  const verdict = args.verdict ?? "approved";
  const approved = verdict === "approved";
  return {
    schema_version: 2,
    context_sha256: args.contextSha256,
    original_text_sha256: args.originalTextSha256,
    candidate_feedback_sha256: args.candidateFeedbackSha256,
    candidate_release_sha256: args.candidateReleaseSha256,
    verdict,
    checks: {
      no_overcorrection: approved,
      corrections_correct: true,
      explanations_correct: true,
      edit_descriptions_precise: true,
      topics_correct: true,
      level_correct: true,
    },
    disputes: approved ? [] : [{ reason: "overcorrection", line_numbers: [1] }],
  };
}

async function finalCriticDecision(args: {
  base: Awaited<ReturnType<typeof fixture>>;
  firstCritic: ReturnType<typeof criticDecision>;
  adjudicator: Record<string, unknown>;
  resolvedFeedback: FeedbackPayload;
  verdict?: "approved" | "disagreed" | "uncertain";
}) {
  const verdict = args.verdict ?? "approved";
  const approved = verdict === "approved";
  const resolutionReason = String(args.adjudicator.resolution_reason);
  const acceptedModel = resolutionReason === "candidate_upheld"
    ? DEEPSEEK_V1_FLASH_MODEL
    : DEEPSEEK_V1_PRO_MODEL;
  return {
    schema_version: 2,
    context_sha256: args.base.contextSha256,
    original_text_sha256: args.base.originalTextSha256,
    candidate_feedback_sha256: args.base.candidateFeedbackSha256,
    candidate_release_sha256: args.base.candidateReleaseSha256,
    critic_decision_sha256: await canonicalJsonSha256(args.firstCritic),
    adjudicator_decision_sha256: await canonicalJsonSha256(args.adjudicator),
    resolved_feedback_sha256: await canonicalJsonSha256(args.resolvedFeedback),
    final_feedback_sha256: await canonicalJsonSha256(
      buildWritingReleaseProjection(
        args.base.inputLines,
        args.resolvedFeedback,
        acceptedModel,
      ),
    ),
    verdict,
    checks: {
      no_overcorrection: approved,
      corrections_correct: true,
      explanations_correct: true,
      edit_descriptions_precise: true,
      topics_correct: true,
      level_correct: true,
    },
    disputes: approved ? [] : [{ reason: "overcorrection", line_numbers: [1] }],
  };
}

async function fixture() {
  const original = "Ich lerne Deutsch.\n\nHeute übe ich.";
  const inputLines = buildFeedbackInputLines(original);
  const candidate = validFeedback(inputLines);
  return {
    original,
    inputLines,
    candidate,
    contextSha256: "a".repeat(64),
    originalTextSha256: await sha256Text(original),
    candidateFeedbackSha256: await canonicalJsonSha256(candidate),
    candidateReleaseSha256: await canonicalJsonSha256(
      buildWritingReleaseProjection(
        inputLines,
        candidate,
        DEEPSEEK_V1_FLASH_MODEL,
      ),
    ),
  };
}

const impreciseArticleCaseSummary =
  "The writing is mostly correct for A2, with one minor issue where the dative article is missing after 'mit'.";
const preciseArticleCaseSummary =
  "The writing is mostly correct for A2. Line 3 uses the wrong article form after 'mit': use dative 'der' instead of 'die'.";

function articleCaseFeedback(
  inputLines: FeedbackInputLine[],
  overallSummary: string,
) {
  const issueLine = inputLines[2];
  const sourceStart = issueLine.source_start + issueLine.text.indexOf("die");
  const correctedLine = "Danach spreche ich mit der Patientin.";
  const correctedStart = correctedLine.indexOf("der");
  return validateFeedbackPayload(
    {
      overall_summary: overallSummary,
      level_detected: "A2",
      score_summary: {
        correct_lines: 2,
        acceptable_lines: 0,
        minor_issues: 1,
        major_issues: 0,
        needs_review: 0,
      },
      grammar_topics: [
        {
          topic: "dativ",
          count: 1,
          severity: "minor",
          simple_explanation: "Use 'der' instead of 'die' after 'mit'.",
        },
      ],
      lines: [
        ...inputLines.slice(0, 2).map((line) => ({
          line_number: line.line_number,
          source_start: line.source_start,
          source_end: line.source_end,
          original_line: line.text,
          corrected_line: line.text,
          status: "correct",
          changed_parts: [],
          short_explanation: "",
          detailed_explanation: "",
          grammar_topic: "",
        })),
        {
          line_number: issueLine.line_number,
          source_start: issueLine.source_start,
          source_end: issueLine.source_end,
          original_line: issueLine.text,
          corrected_line: correctedLine,
          status: "minor_issue",
          changed_parts: [
            {
              from: "die",
              to: "der",
              reason:
                "After 'mit', the feminine article needs the dative form 'der'.",
              source_start: sourceStart,
              source_end: sourceStart + 3,
              corrected_start: correctedStart,
              corrected_end: correctedStart + 3,
            },
          ],
          short_explanation: "Use 'der' instead of 'die' after 'mit'.",
          detailed_explanation:
            "The preposition 'mit' takes dative, so the feminine article changes from 'die' to 'der'.",
          grammar_topic: "dativ",
        },
      ],
    },
    inputLines,
  );
}

async function articleCaseFixture(overallSummary: string) {
  const original =
    "Am 12.07.2026 beginnt meine Schicht um 7.30 Uhr.\nIch dokumentiere z.B. 2,5 ml.\n\nDanach spreche ich mit die Patientin.";
  const inputLines = buildFeedbackInputLines(original);
  const candidate = articleCaseFeedback(inputLines, overallSummary);
  return {
    original,
    inputLines,
    candidate,
    contextSha256: "9".repeat(64),
    originalTextSha256: await sha256Text(original),
    candidateFeedbackSha256: await canonicalJsonSha256(candidate),
    candidateReleaseSha256: await canonicalJsonSha256(
      buildWritingReleaseProjection(
        inputLines,
        candidate,
        DEEPSEEK_V1_FLASH_MODEL,
      ),
    ),
  };
}

function adjudicationArgs(
  base: Awaited<ReturnType<typeof fixture>>,
  geminiSecondary: GeminiSecondaryProvider | null,
  deepSeekProvider?: ChatCompletionProvider,
) {
  return {
    candidate: base.candidate,
    inputLines: base.inputLines,
    targetLevel: "A2",
    questionTitle: "",
    questionPrompt: "",
    questionTopic: "",
    mode: "free_text",
    contextSha256: base.contextSha256,
    originalTextSha256: base.originalTextSha256,
    generatorModel: DEEPSEEK_V1_FLASH_MODEL,
    geminiSecondary,
    deepSeekProvider,
    proModel: DEEPSEEK_V1_PRO_MODEL,
    deadlineAt: Date.now() + WRITING_INDEPENDENT_TOTAL_BUDGET_MS,
    validateFeedback: validateFeedbackPayload,
    buildReleaseProjection: (
      feedback: FeedbackPayload,
      acceptedModel: string,
    ) =>
      buildWritingReleaseProjection(base.inputLines, feedback, acceptedModel),
  };
}

Deno.test(
  "canonical writing evidence hashes are stable across object key order",
  async () => {
    assertEquals(
      canonicalJsonText({ z: 1, a: { y: true, x: ["ä", null] } }),
      '{"a":{"x":["ä",null],"y":true},"z":1}',
    );
    assertEquals(
      await canonicalJsonSha256({ b: 2, a: 1 }),
      await canonicalJsonSha256({ a: 1, b: 2 }),
    );
  },
);

Deno.test(
  "canonical evidence hashing rejects PostgreSQL-unsafe strings",
  async () => {
    for (
      const unsafeText of [
        "Unsafe\u0000text",
        "Unsafe\ud800text",
        "Unsafe\udc00text",
      ]
    ) {
      let failure: unknown;
      try {
        await canonicalJsonSha256({ unsafeText });
      } catch (error) {
        failure = error;
      }
      assert(
        failure instanceof Error &&
          failure.message.includes("PostgreSQL-unsafe"),
        "Unsafe strings must fail before evidence can reach PostgreSQL JSONB.",
      );
    }
  },
);

async function disagreedDecisionFor(
  base: Awaited<ReturnType<typeof fixture>>,
  generatorModel = DEEPSEEK_V1_FLASH_MODEL,
) {
  return criticDecision({
    contextSha256: base.contextSha256,
    originalTextSha256: base.originalTextSha256,
    candidateFeedbackSha256: base.candidateFeedbackSha256,
    candidateReleaseSha256: await canonicalJsonSha256(
      buildWritingReleaseProjection(
        base.inputLines,
        base.candidate,
        generatorModel,
      ),
    ),
    verdict: "disagreed",
  });
}

async function proDecisionFor(
  base: Awaited<ReturnType<typeof fixture>>,
  firstCritic: ReturnType<typeof criticDecision>,
  options: {
    verdict?: "resolved" | "system_hold";
    resolutionReason?:
      | "candidate_upheld"
      | "candidate_revised"
      | "insufficient_evidence"
      | "critic_disagreement_unresolved";
    feedback?: unknown;
  } = {},
) {
  const verdict = options.verdict ?? "resolved";
  return {
    schema_version: 1,
    context_sha256: base.contextSha256,
    original_text_sha256: base.originalTextSha256,
    candidate_feedback_sha256: base.candidateFeedbackSha256,
    candidate_release_sha256: firstCritic.candidate_release_sha256,
    critic_decision_sha256: await canonicalJsonSha256(firstCritic),
    verdict,
    resolution_reason: options.resolutionReason ??
      (verdict === "system_hold"
        ? "insufficient_evidence"
        : "candidate_upheld"),
    feedback: verdict === "system_hold"
      ? null
      : (options.feedback ?? base.candidate),
  };
}

Deno.test(
  "Gemini approval still releases validated DeepSeek Flash feedback",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(criticDecision(base)),
        }], requests)),
      ),
    );
    assertEquals(result.evidence.reason_code, "critic_approved");
    assertEquals(result.evidence.decision, "accepted_model_feedback");
    assertEquals(result.acceptedModel, DEEPSEEK_V1_FLASH_MODEL);
    assertEquals(requests.length, 1);
  },
);

Deno.test(
  "missing or invalid Gemini configuration cannot discard valid DeepSeek feedback",
  async () => {
    const base = await fixture();
    const missing = await adjudicateWritingCandidate(
      adjudicationArgs(base, null),
    );
    assertEquals(missing.evidence.reason_code, "critic_advisory_unavailable");
    assertEquals(missing.evidence.decision, "accepted_model_feedback");
    assertEquals(missing.evidence.critic_provider, null);
    assertEquals(missing.evidence.critic_verdict, null);
    assertEquals(missing.evidence.critic_decision_sha256, null);
    assertEquals(
      missing.evidence.final_feedback_sha256,
      base.candidateReleaseSha256,
    );

    const requests: Array<Record<string, unknown>> = [];
    const invalid = await adjudicateWritingCandidate(
      adjudicationArgs(base, {
        ...critic(queuedProvider([], requests)),
        criticModel: "gemini-invalid-model" as typeof GEMINI_V1_CRITIC_MODEL,
      }),
    );
    assertEquals(invalid.evidence.reason_code, "critic_advisory_unavailable");
    assertEquals(invalid.evidence.critic_provider, null);
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "malformed Gemini decisions retry once with a distinct key then remain advisory",
  async () => {
    const base = await fixture();
    const lifecycle = lifecycleRecorder();
    const requests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate({
      ...adjudicationArgs(
        base,
        critic(queuedProvider([
          { model: GEMINI_V1_CRITIC_MODEL, content: "{}" },
          { model: GEMINI_V1_CRITIC_MODEL, content: "{}" },
        ], requests)),
      ),
      providerCallKeyPrefix: "writing:advisory:v1:attempt1",
      ...lifecycle,
    });
    assertEquals(result.evidence.reason_code, "critic_advisory_unavailable");
    assertEquals(result.evidence.critic_provider, "gemini");
    assertEquals(result.evidence.critic_verdict, null);
    assertEquals(result.evidence.critic_decision_sha256, null);
    assertEquals(requests.length, 2);
    assertEquals(
      lifecycle.events.filter(({ phase }) => phase === "before")
        .map(({ value }) => value.call_key),
      [
        "writing:advisory:v1:attempt1:gemini.routine-critique",
        "writing:advisory:v1:attempt1:gemini.routine-critique-retry",
      ],
    );
  },
);

Deno.test(
  "Gemini transport errors retry once and remain advisory after two failures",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([
          { status: 425, model: GEMINI_V1_CRITIC_MODEL },
          { status: 503, model: GEMINI_V1_CRITIC_MODEL },
        ], requests)),
      ),
    );
    assertEquals(result.evidence.reason_code, "critic_advisory_unavailable");
    assertEquals(result.evidence.decision, "accepted_model_feedback");
    assertEquals(requests.length, 2);
  },
);

Deno.test(
  "valid Gemini dissent cannot veto a valid DeepSeek Pro candidate",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base, DEEPSEEK_V1_PRO_MODEL);
    const deepSeekRequests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate({
      ...adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(decision),
        }])),
        queuedProvider([], deepSeekRequests),
      ),
      generatorModel: DEEPSEEK_V1_PRO_MODEL,
    });
    assertEquals(result.evidence.reason_code, "pro_authority_accepted");
    assertEquals(result.acceptedModel, DEEPSEEK_V1_PRO_MODEL);
    assertEquals(result.evidence.critic_verdict, "disagreed");
    assertEquals(result.evidence.adjudicator_provider, null);
    assertEquals(result.evidence.final_critic_provider, null);
    assertEquals(deepSeekRequests.length, 0);
  },
);

Deno.test(
  "valid Pro adjudication releases directly without final Gemini",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    for (const revised of [false, true]) {
      const feedback = structuredClone(base.candidate);
      if (revised) {
        feedback.overall_summary = "The Pro-reviewed writing is correct.";
      }
      const proDecision = await proDecisionFor(base, decision, {
        resolutionReason: revised ? "candidate_revised" : "candidate_upheld",
        feedback,
      });
      const geminiRequests: Array<Record<string, unknown>> = [];
      const deepSeekRequests: Array<Record<string, unknown>> = [];
      const result = await adjudicateWritingCandidate(
        adjudicationArgs(
          base,
          critic(queuedProvider([{
            model: GEMINI_V1_CRITIC_MODEL,
            content: JSON.stringify(decision),
          }], geminiRequests)),
          queuedProvider([{
            model: DEEPSEEK_V1_PRO_MODEL,
            content: JSON.stringify(proDecision),
          }], deepSeekRequests),
        ),
      );
      assertEquals(result.evidence.reason_code, "adjudicator_resolved");
      assertEquals(result.evidence.decision, "accepted_model_feedback");
      assertEquals(
        result.acceptedModel,
        revised ? DEEPSEEK_V1_PRO_MODEL : DEEPSEEK_V1_FLASH_MODEL,
      );
      assertEquals(result.evidence.adjudicator_verdict, "resolved");
      assertEquals(result.evidence.final_critic_provider, null);
      assertEquals(geminiRequests.length, 1);
      assertEquals(deepSeekRequests.length, 1);
    }
  },
);

Deno.test(
  "one malformed Pro contract receives exactly one distinct-key retry",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    const proDecision = await proDecisionFor(base, decision);
    const lifecycle = lifecycleRecorder();
    const result = await adjudicateWritingCandidate({
      ...adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(decision),
        }])),
        queuedProvider([
          { model: DEEPSEEK_V1_PRO_MODEL, content: "{}" },
          {
            model: DEEPSEEK_V1_PRO_MODEL,
            content: JSON.stringify(proDecision),
          },
        ]),
      ),
      providerCallKeyPrefix: "writing:pro-retry:v1:attempt1",
      ...lifecycle,
    });
    assertEquals(result.evidence.reason_code, "adjudicator_resolved");
    assertEquals(
      lifecycle.events.filter(({ phase, value }) =>
        phase === "before" && value.provider === "deepseek"
      ).map(({ value }) => value.call_key),
      [
        "writing:pro-retry:v1:attempt1:deepseek.pro-adjudication",
        "writing:pro-retry:v1:attempt1:deepseek.pro-adjudication-retry",
      ],
    );
  },
);

Deno.test(
  "second Pro technical failure is retryable and never becomes a hold",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    let failure: unknown;
    try {
      await adjudicateWritingCandidate(
        adjudicationArgs(
          base,
          critic(queuedProvider([{
            model: GEMINI_V1_CRITIC_MODEL,
            content: JSON.stringify(decision),
          }])),
          queuedProvider([
            { model: DEEPSEEK_V1_PRO_MODEL, content: "{}" },
            { model: DEEPSEEK_V1_PRO_MODEL, content: "{}" },
          ]),
        ),
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof WritingAdjudicationError);
    assertEquals(
      (failure as WritingAdjudicationError).safeCode,
      "writing_adjudicator_contract_retry_exhausted",
    );
    assertEquals((failure as WritingAdjudicationError).retryable, true);
  },
);

Deno.test(
  "only genuinely uninterpretable Pro evidence remains private",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    const hold = await proDecisionFor(base, decision, {
      verdict: "system_hold",
      resolutionReason: "insufficient_evidence",
    });
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(decision),
        }])),
        queuedProvider([{
          model: DEEPSEEK_V1_PRO_MODEL,
          content: JSON.stringify(hold),
        }]),
      ),
    );
    assertEquals(result.evidence.reason_code, "adjudicator_unresolved");
    assertEquals(result.evidence.decision, "system_hold");
    assertEquals(result.evidence.adjudicator_verdict, "system_hold");
  },
);

Deno.test(
  "repairable Pro disagreement holds are rejected and retried",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    const invalid = await proDecisionFor(base, decision, {
      verdict: "system_hold",
      resolutionReason: "critic_disagreement_unresolved",
    });
    let failure: unknown;
    try {
      await adjudicateWritingCandidate(
        adjudicationArgs(
          base,
          critic(queuedProvider([{
            model: GEMINI_V1_CRITIC_MODEL,
            content: JSON.stringify(decision),
          }])),
          queuedProvider([
            { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(invalid) },
            { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(invalid) },
          ]),
        ),
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof WritingAdjudicationError);
    assertEquals(
      (failure as WritingAdjudicationError).safeCode,
      "writing_adjudicator_contract_retry_exhausted",
    );
  },
);

Deno.test(
  "Pro feedback still must pass exact source validation on both attempts",
  async () => {
    const base = await fixture();
    const decision = await disagreedDecisionFor(base);
    const invalidFeedback = structuredClone(base.candidate);
    invalidFeedback.lines[0].source_start += 1;
    const invalid = await proDecisionFor(base, decision, {
      resolutionReason: "candidate_revised",
      feedback: invalidFeedback,
    });
    let failure: unknown;
    try {
      await adjudicateWritingCandidate(
        adjudicationArgs(
          base,
          critic(queuedProvider([{
            model: GEMINI_V1_CRITIC_MODEL,
            content: JSON.stringify(decision),
          }])),
          queuedProvider([
            { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(invalid) },
            { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(invalid) },
          ]),
        ),
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof WritingAdjudicationError);
    assertEquals(
      (failure as WritingAdjudicationError).safeCode,
      "writing_adjudicator_contract_retry_exhausted",
    );
  },
);

Deno.test(
  "unresolved candidates are retryable before any advisory release",
  async () => {
    const base = await fixture();
    const unresolved = structuredClone(base.candidate);
    unresolved.lines[0].status = "unclear";
    unresolved.lines[0].short_explanation =
      "The intended meaning cannot be determined.";
    unresolved.lines[0].detailed_explanation =
      "The intended meaning cannot be determined from this unit.";
    unresolved.score_summary.correct_lines -= 1;
    unresolved.score_summary.needs_review += 1;
    let failure: unknown;
    try {
      await adjudicateWritingCandidate({
        ...adjudicationArgs(base, null),
        candidate: validateFeedbackPayload(unresolved, base.inputLines),
      });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof WritingAdjudicationError);
    assertEquals(
      (failure as WritingAdjudicationError).safeCode,
      "writing_candidate_unresolved",
    );
    assertEquals((failure as WritingAdjudicationError).retryable, true);
  },
);

Deno.test(
  "spend rejection remains authoritative and dispatches no advisory call",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    let failure: unknown;
    try {
      await adjudicateWritingCandidate({
        ...adjudicationArgs(
          base,
          critic(queuedProvider([{
            model: GEMINI_V1_CRITIC_MODEL,
            content: JSON.stringify(criticDecision(base)),
          }], requests)),
        ),
        providerCallKeyPrefix: "writing:spend:v1:attempt1",
        onBeforeProviderCall: async () => {
          throw { retryable: false };
        },
        onProviderUsage: async () => undefined,
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof WritingAdjudicationError);
    assertEquals(
      (failure as WritingAdjudicationError).safeCode,
      "writing_spend_accounting_failed",
    );
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "invalid and truncated Gemini envelopes each receive one bounded retry",
  async () => {
    for (
      const firstReply of [
        { model: "unexpected-model", content: "{}" },
        { model: GEMINI_V1_CRITIC_MODEL, finishReason: "length" },
      ]
    ) {
      const base = await fixture();
      const requests: Array<Record<string, unknown>> = [];
      const result = await adjudicateWritingCandidate(
        adjudicationArgs(
          base,
          critic(queuedProvider([
            firstReply,
            {
              model: GEMINI_V1_CRITIC_MODEL,
              content: JSON.stringify(criticDecision(base)),
            },
          ], requests)),
        ),
      );
      assertEquals(result.evidence.reason_code, "critic_approved");
      assertEquals(requests.length, 2);
    }
  },
);

Deno.test(
  "Gemini authentication failure is advisory after one bounded retry",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([
          { status: 401, model: GEMINI_V1_CRITIC_MODEL },
          { status: 401, model: GEMINI_V1_CRITIC_MODEL },
        ], requests)),
      ),
    );
    assertEquals(result.evidence.reason_code, "critic_advisory_unavailable");
    assertEquals(result.evidence.decision, "accepted_model_feedback");
    assertEquals(requests.length, 2);
  },
);

Deno.test(
  "wrong-form article precision dispute is repaired by Pro without final Gemini",
  async () => {
    const base = await articleCaseFixture(impreciseArticleCaseSummary);
    const criticValue = criticDecision({ ...base, verdict: "disagreed" });
    criticValue.checks.no_overcorrection = true;
    criticValue.checks.edit_descriptions_precise = false;
    criticValue.disputes = [
      { reason: "imprecise_edit_description", line_numbers: [3] },
    ];
    const repaired = articleCaseFeedback(
      base.inputLines,
      preciseArticleCaseSummary,
    );
    const proValue = {
      schema_version: 1,
      context_sha256: base.contextSha256,
      original_text_sha256: base.originalTextSha256,
      candidate_feedback_sha256: base.candidateFeedbackSha256,
      candidate_release_sha256: base.candidateReleaseSha256,
      critic_decision_sha256: await canonicalJsonSha256(criticValue),
      verdict: "resolved",
      resolution_reason: "candidate_revised",
      feedback: repaired,
    };
    const proRequests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(criticValue),
        }])),
        queuedProvider([{
          model: DEEPSEEK_V1_PRO_MODEL,
          content: JSON.stringify(proValue),
        }], proRequests),
      ),
    );
    assertEquals(result.evidence.reason_code, "adjudicator_resolved");
    assertEquals(result.feedback.overall_summary, preciseArticleCaseSummary);
    assertEquals(result.acceptedModel, DEEPSEEK_V1_PRO_MODEL);
    const messages = proRequests[0].messages as Array<{
      role: string;
      content: string;
    }>;
    const systemPrompt =
      messages.find(({ role }) => role === "system")?.content ?? "";
    assert(systemPrompt.includes("never a missing article"));
    assert(systemPrompt.includes("repair every affected changed_part"));
  },
);

Deno.test(
  "Pro hash mismatch receives one retry and a valid second decision releases",
  async () => {
    const base = await fixture();
    const criticValue = await disagreedDecisionFor(base);
    const valid = await proDecisionFor(base, criticValue);
    const invalid = {
      ...valid,
      candidate_feedback_sha256: "c".repeat(64),
    };
    const requests: Array<Record<string, unknown>> = [];
    const result = await adjudicateWritingCandidate(
      adjudicationArgs(
        base,
        critic(queuedProvider([{
          model: GEMINI_V1_CRITIC_MODEL,
          content: JSON.stringify(criticValue),
        }])),
        queuedProvider([
          { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(invalid) },
          { model: DEEPSEEK_V1_PRO_MODEL, content: JSON.stringify(valid) },
        ], requests),
      ),
    );
    assertEquals(result.evidence.reason_code, "adjudicator_resolved");
    assertEquals(requests.length, 2);
  },
);

Deno.test(
  "DeepSeek recovery critic still rejects imprecise wrong-form wording",
  async () => {
    const base = await articleCaseFixture(impreciseArticleCaseSummary);
    const candidateReleaseSha256 = await canonicalJsonSha256(
      buildWritingReleaseProjection(
        base.inputLines,
        base.candidate,
        GEMINI_V1_STRONG_MODEL,
      ),
    );
    const decision = criticDecision({
      contextSha256: base.contextSha256,
      originalTextSha256: base.originalTextSha256,
      candidateFeedbackSha256: base.candidateFeedbackSha256,
      candidateReleaseSha256,
      verdict: "disagreed",
    });
    decision.checks.no_overcorrection = true;
    decision.checks.edit_descriptions_precise = false;
    decision.disputes = [
      { reason: "imprecise_edit_description", line_numbers: [3] },
    ];
    const result = await adjudicateGeminiRecoveryCandidate(
      await recoveryAdjudicationArgs(
        base,
        queuedProvider(
          [{
            model: DEEPSEEK_V1_PRO_MODEL,
            content: JSON.stringify(decision),
          }],
          [],
          "deepseek",
        ),
      ),
    );
    assertEquals(result.evidence.reason_code, "critic_disagreed");
    assertEquals(result.evidence.decision, "system_hold");
    assertEquals(result.evidence.critic_provider, "deepseek");
  },
);

Deno.test(
  "Gemini recovery accepts only a DeepSeek-named cross-provider critic",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const sameFamilyProvider = queuedProvider([], requests, "gemini");
    const result = await adjudicateGeminiRecoveryCandidate(
      await recoveryAdjudicationArgs(base, sameFamilyProvider),
    );

    assertEquals(result.acceptedModel, null);
    assertEquals(result.evidence.decision, "system_hold");
    assertEquals(result.evidence.reason_code, "critic_not_configured");
    assertEquals(result.evidence.generator_provider, "gemini");
    assertEquals(result.evidence.critic_provider, null);
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "Gemini recovery critic disagreement, uncertainty, hash drift, wrong model, and auth all hold",
  async () => {
    for (
      const testCase of [
        { kind: "disagreed", expected: "critic_disagreed" },
        { kind: "uncertain", expected: "critic_uncertain" },
        { kind: "hash", expected: "critic_hash_mismatch" },
        { kind: "model", expected: "critic_invalid" },
        { kind: "auth", expected: "critic_authentication_failed" },
      ] as const
    ) {
      const base = await fixture();
      const candidateReleaseSha256 = await canonicalJsonSha256(
        buildWritingReleaseProjection(
          base.inputLines,
          base.candidate,
          GEMINI_V1_STRONG_MODEL,
        ),
      );
      const verdict =
        testCase.kind === "disagreed" || testCase.kind === "uncertain"
          ? testCase.kind
          : "approved";
      const decision = criticDecision({
        contextSha256: base.contextSha256,
        originalTextSha256: base.originalTextSha256,
        candidateFeedbackSha256: base.candidateFeedbackSha256,
        candidateReleaseSha256: testCase.kind === "hash"
          ? "f".repeat(64)
          : candidateReleaseSha256,
        verdict,
      });
      const provider = queuedProvider(
        [
          {
            status: testCase.kind === "auth" ? 401 : 200,
            model: testCase.kind === "model"
              ? DEEPSEEK_V1_FLASH_MODEL
              : DEEPSEEK_V1_PRO_MODEL,
            content: JSON.stringify(decision),
          },
        ],
        [],
        "deepseek",
      );
      const result = await adjudicateGeminiRecoveryCandidate(
        await recoveryAdjudicationArgs(base, provider),
      );

      assertEquals(result.acceptedModel, null, testCase.kind);
      assertEquals(result.evidence.decision, "system_hold", testCase.kind);
      assertEquals(
        result.evidence.reason_code,
        testCase.expected,
        testCase.kind,
      );
      assertEquals(result.evidence.accepted_provider, null, testCase.kind);
      assert(
        result.feedback.lines.every(
          (line) =>
            line.status === "unclear" &&
            line.corrected_line === line.original_line,
        ),
        testCase.kind,
      );
    }
  },
);

Deno.test(
  "Gemini recovery accepts a valid DeepSeek critic response after the former twelve-second ceiling",
  async () => {
    const base = await fixture();
    const candidateReleaseSha256 = await canonicalJsonSha256(
      buildWritingReleaseProjection(
        base.inputLines,
        base.candidate,
        GEMINI_V1_STRONG_MODEL,
      ),
    );
    const decision = criticDecision({
      contextSha256: base.contextSha256,
      originalTextSha256: base.originalTextSha256,
      candidateFeedbackSha256: base.candidateFeedbackSha256,
      candidateReleaseSha256,
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider: ChatCompletionProvider = {
      providerName: "deepseek",
      endpoint: "https://provider.example.test/chat/completions",
      complete: (payload, options) => {
        requestBodies.push(payload);
        return new Promise<Response>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            resolve(Response.json({
              model: DEEPSEEK_V1_PRO_MODEL,
              provider_model_version: DEEPSEEK_V1_PRO_MODEL,
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: JSON.stringify(decision) },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 3_500,
                total_tokens: 3_600,
                prompt_tokens_details: { cached_tokens: 0 },
                completion_tokens_details: { reasoning_tokens: 3_200 },
              },
            }));
          }, 12_250);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeoutId);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };

    const startedAt = Date.now();
    const result = await adjudicateGeminiRecoveryCandidate(
      await recoveryAdjudicationArgs(base, provider),
    );
    const elapsedMs = Date.now() - startedAt;

    assertEquals(result.evidence.reason_code, "recovery_critic_approved");
    assertEquals(result.acceptedModel, GEMINI_V1_STRONG_MODEL);
    assertEquals(requestBodies.length, 1);
    assertEquals(requestBodies[0].max_tokens, 4_000);
    assertEquals(requestBodies[0].thinking, { type: "enabled" });
    assertEquals(requestBodies[0].reasoning_effort, "high");
    assert(elapsedMs >= 12_000, `critic returned too early: ${elapsedMs}ms`);
    assert(
      elapsedMs < WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS,
      `critic exceeded its bounded timeout: ${elapsedMs}ms`,
    );
  },
);

Deno.test(
  "Gemini recovery deadline expires before a paid critic call",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const provider = queuedProvider([], requests, "deepseek");
    let caught: unknown;
    try {
      await adjudicateGeminiRecoveryCandidate({
        ...(await recoveryAdjudicationArgs(base, provider)),
        deadlineAt: Date.now() - 1,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof WritingAdjudicationError);
    assertEquals(
      (caught as WritingAdjudicationError).safeCode,
      "writing_adjudication_deadline_exceeded",
    );
    assertEquals((caught as WritingAdjudicationError).retryable, true);
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "a local recovery-critic rejection releases before any provider dispatch",
  async () => {
    const base = await fixture();
    const lifecycle = lifecycleRecorder();
    const provider: ChatCompletionProvider = {
      providerName: "deepseek",
      endpoint: "https://provider.example.test/chat/completions",
      async complete() {
        throw new ChatCompletionProviderConfigurationError();
      },
    };
    const result = await adjudicateGeminiRecoveryCandidate({
      ...(await recoveryAdjudicationArgs(base, provider)),
      providerCallKeyPrefix: "writing:recovery-local:v1:attempt1",
      onBeforeProviderCall: lifecycle.onBeforeProviderCall,
      onProviderUsage: lifecycle.onProviderUsage,
      onProviderNotCalled: lifecycle.onProviderNotCalled,
    });

    const expectedCall = {
      provider: "deepseek",
      requested_model: DEEPSEEK_V1_PRO_MODEL,
      call_purpose: "writing_adjudication",
      call_key:
        "writing:recovery-local:v1:attempt1:deepseek.pro-recovery-critique",
    } as const;
    assertEquals(result.evidence.reason_code, "critic_not_configured");
    assertEquals(result.evidence.decision, "system_hold");
    assertEquals(lifecycle.events, [
      { phase: "before", value: expectedCall },
      { phase: "not_called", value: expectedCall },
    ]);
  },
);

Deno.test(
  "only documented Gemini critic 400 and 500 responses release as unbilled",
  async () => {
    for (const status of [400, 500] as const) {
      const base = await fixture();
      const releases: Array<{ call: WritingProviderCall; reason: string }> = [];
      try {
        await adjudicateWritingCandidate({
          ...adjudicationArgs(
            base,
            critic(
              queuedProvider(
                [
                  {
                    status,
                    model: GEMINI_V1_CRITIC_MODEL,
                  },
                ],
                [],
                "gemini",
              ),
            ),
          ),
          providerCallKeyPrefix: `writing:critic-unbilled:v1:s${status}`,
          onBeforeProviderCall: async () => undefined,
          onProviderUsage: async () => undefined,
          onProviderNotCalled: async (call, reason) => {
            releases.push({ call, reason });
          },
        });
      } catch {
        // Gemini 500 remains retryable; the unbilled evidence still releases
        // only this exact reservation.
      }
      assertEquals(
        releases,
        [
          {
            call: {
              provider: "gemini",
              requested_model: GEMINI_V1_CRITIC_MODEL,
              call_purpose: "writing_critique",
              call_key:
                `writing:critic-unbilled:v1:s${status}:gemini.routine-critique`,
            },
            reason: "request_failed_unbilled",
          },
        ],
        `Gemini ${status}`,
      );
    }
  },
);

Deno.test(
  "Gemini recovery critic outage and in-flight timeout retry without release",
  async () => {
    const base = await fixture();
    for (const testCase of ["http", "timeout"] as const) {
      let notCalledReleases = 0;
      const provider: ChatCompletionProvider = testCase === "http"
        ? queuedProvider(
          [
            {
              status: 503,
              model: DEEPSEEK_V1_PRO_MODEL,
            },
          ],
          [],
          "deepseek",
        )
        : {
          providerName: "deepseek",
          endpoint: "https://provider.example.test/chat/completions",
          complete: (_payload, options) =>
            new Promise<Response>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        };
      let caught: unknown;
      try {
        await adjudicateGeminiRecoveryCandidate({
          ...(await recoveryAdjudicationArgs(base, provider)),
          deadlineAt: Date.now() + (testCase === "timeout" ? 5 : 5_000),
          providerCallKeyPrefix: `writing:unknown-usage:v1:${testCase}`,
          onBeforeProviderCall: async () => undefined,
          onProviderUsage: async () => undefined,
          onProviderNotCalled: async () => {
            notCalledReleases += 1;
          },
        });
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof WritingAdjudicationError, testCase);
      assertEquals(
        (caught as WritingAdjudicationError).safeCode,
        testCase === "http"
          ? "writing_critic_http_503"
          : "writing_critic_timeout",
        testCase,
      );
      assertEquals((caught as WritingAdjudicationError).retryable, true);
      assertEquals(notCalledReleases, 0, testCase);
    }
  },
);

Deno.test(
  "DeepSeek recovery critic resource interruption retries as provider unavailability",
  async () => {
    const base = await fixture();
    let notCalledReleases = 0;
    let caught: unknown;
    try {
      await adjudicateGeminiRecoveryCandidate({
        ...(await recoveryAdjudicationArgs(
          base,
          queuedProvider(
            [
              {
                model: DEEPSEEK_V1_PRO_MODEL,
                finishReason: "insufficient_system_resource",
              },
            ],
            [],
            "deepseek",
          ),
        )),
        providerCallKeyPrefix: "writing:resource-interruption:v1:attempt1",
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async () => undefined,
        onProviderNotCalled: async () => {
          notCalledReleases += 1;
        },
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof WritingAdjudicationError);
    assertEquals(
      (caught as WritingAdjudicationError).safeCode,
      "writing_critic_unavailable",
    );
    assertEquals((caught as WritingAdjudicationError).retryable, true);
    assertEquals(notCalledReleases, 0);
    assert(
      caught instanceof ChatCompletionProviderResponseError === false,
      "The transport failure must be normalized at the domain boundary.",
    );
  },
);

Deno.test(
  "Gemini recovery spend rejection cannot call or release the critic",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const provider = queuedProvider([], requests, "deepseek");
    let caught: unknown;
    try {
      await adjudicateGeminiRecoveryCandidate({
        ...(await recoveryAdjudicationArgs(base, provider)),
        providerCallKeyPrefix: "writing:recovery-spend:v1:attempt1",
        onBeforeProviderCall: async () => {
          throw { retryable: false };
        },
        onProviderUsage: async () => undefined,
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof WritingAdjudicationError);
    assertEquals(
      (caught as WritingAdjudicationError).safeCode,
      "writing_spend_accounting_failed",
    );
    assertEquals((caught as WritingAdjudicationError).retryable, false);
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "Gemini recovery usage-accounting failure prevents release after transport",
  async () => {
    const base = await fixture();
    const candidateReleaseSha256 = await canonicalJsonSha256(
      buildWritingReleaseProjection(
        base.inputLines,
        base.candidate,
        GEMINI_V1_STRONG_MODEL,
      ),
    );
    const requests: Array<Record<string, unknown>> = [];
    const provider = queuedProvider(
      [
        {
          model: DEEPSEEK_V1_PRO_MODEL,
          content: JSON.stringify(
            criticDecision({
              contextSha256: base.contextSha256,
              originalTextSha256: base.originalTextSha256,
              candidateFeedbackSha256: base.candidateFeedbackSha256,
              candidateReleaseSha256,
            }),
          ),
        },
      ],
      requests,
      "deepseek",
    );
    let caught: unknown;
    try {
      await adjudicateGeminiRecoveryCandidate({
        ...(await recoveryAdjudicationArgs(base, provider)),
        providerCallKeyPrefix: "writing:recovery-usage:v1:attempt1",
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async () => {
          throw { retryable: true };
        },
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof WritingAdjudicationError);
    assertEquals(
      (caught as WritingAdjudicationError).safeCode,
      "writing_spend_accounting_failed",
    );
    assertEquals((caught as WritingAdjudicationError).retryable, true);
    assertEquals(requests.length, 1);
  },
);

Deno.test(
  "writing recovery rejects a prefix that cannot fit its spend identity",
  async () => {
    const base = await fixture();
    const requests: Array<Record<string, unknown>> = [];
    const provider = queuedProvider([], requests, "deepseek");
    let caught: unknown;
    try {
      await adjudicateGeminiRecoveryCandidate({
        ...(await recoveryAdjudicationArgs(base, provider)),
        providerCallKeyPrefix: "a".repeat(75),
        onBeforeProviderCall: async () => undefined,
        onProviderUsage: async () => undefined,
        onProviderNotCalled: async () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof WritingAdjudicationError);
    assertEquals(
      (caught as WritingAdjudicationError).safeCode,
      "writing_spend_accounting_failed",
    );
    assertEquals(requests.length, 0);
  },
);

Deno.test(
  "fast and rare disputed writing paths keep their hard budgets",
  () => {
    assertEquals(WRITING_FLASH_CANDIDATE_TIMEOUT_MS, 20_000);
    assertEquals(WRITING_GEMINI_CRITIC_TIMEOUT_MS, 13_000);
    assertEquals(WRITING_GEMINI_CRITIC_CONTRACT_RETRY_TIMEOUT_MS, 7_000);
    assertEquals(WRITING_PRO_ADJUDICATOR_TIMEOUT_MS, 19_000);
    assertEquals(WRITING_GEMINI_FINAL_CRITIC_TIMEOUT_MS, 13_000);
    assertEquals(WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS, 35_000);
    assert(WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS > 12_000);
    assert(WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS < 36_000);
    assertEquals(WRITING_GEMINI_RECOVERY_GENERATOR_TIMEOUT_MS, 20_000);
    assertEquals(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS +
        WRITING_GEMINI_CRITIC_TIMEOUT_MS +
        WRITING_PRO_ADJUDICATOR_TIMEOUT_MS +
        WRITING_GEMINI_FINAL_CRITIC_TIMEOUT_MS,
      65_000,
    );
    assert(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS + WRITING_GEMINI_CRITIC_TIMEOUT_MS <
        WRITING_INDEPENDENT_FAST_BUDGET_MS,
    );
    assert(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS +
          WRITING_GEMINI_CRITIC_TIMEOUT_MS +
          WRITING_GEMINI_CRITIC_CONTRACT_RETRY_TIMEOUT_MS <
        WRITING_INDEPENDENT_FAST_BUDGET_MS,
    );
    assert(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS +
          WRITING_GEMINI_CRITIC_TIMEOUT_MS +
          WRITING_PRO_ADJUDICATOR_TIMEOUT_MS +
          WRITING_GEMINI_FINAL_CRITIC_TIMEOUT_MS <
        WRITING_INDEPENDENT_TOTAL_BUDGET_MS,
    );
    assertEquals(WRITING_INDEPENDENT_TOTAL_BUDGET_MS, 135_000);
    assertEquals(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS +
        WRITING_PRO_ADJUDICATOR_TIMEOUT_MS +
        WRITING_GEMINI_RECOVERY_GENERATOR_TIMEOUT_MS +
        WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS,
      94_000,
    );
    assert(
      WRITING_FLASH_CANDIDATE_TIMEOUT_MS +
          WRITING_PRO_ADJUDICATOR_TIMEOUT_MS +
          WRITING_GEMINI_RECOVERY_GENERATOR_TIMEOUT_MS +
          WRITING_DEEPSEEK_RECOVERY_CRITIC_TIMEOUT_MS <
        WRITING_INDEPENDENT_TOTAL_BUDGET_MS,
    );
  },
);

Deno.test(
  "system hold preserves exact offsets, units, separators, and paragraphs",
  async () => {
    const base = await fixture();
    const result = await buildWritingSystemHold({
      inputLines: base.inputLines,
      targetLevel: "A2",
      contextSha256: base.contextSha256,
      originalTextSha256: base.originalTextSha256,
      generatorProvider: "deepseek",
      generatorModel: DEEPSEEK_V1_FLASH_MODEL,
      reason: "generator_invalid",
    });
    assertEquals(
      reconstructCorrectedText(base.inputLines, result.feedback.lines),
      base.original,
    );
    assertEquals(
      result.feedback.lines.map((line) => ({
        start: line.source_start,
        end: line.source_end,
        original: line.original_line,
        corrected: line.corrected_line,
      })),
      base.inputLines.map((line) => ({
        start: line.source_start,
        end: line.source_end,
        original: line.text,
        corrected: line.text,
      })),
    );
  },
);
