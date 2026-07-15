import {
  buildFeedbackInputLines,
  type FeedbackPayload,
  type WritingProviderCall,
} from "../_shared/writing-feedback.ts";
import type { WritingAdjudicationResult } from "../_shared/writing-adjudication.ts";
import {
  articleFormRegressionPassed,
  boundedWritingDiagnosticCode,
  createWritingFullDiagnosticOutput,
  createWritingFullDiagnosticRecorder,
  WRITING_FULL_DIAGNOSTIC_FIELDS,
  WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT,
  WRITING_FULL_DIAGNOSTIC_STAGE_FIELDS,
} from "./writing-full-diagnostic.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

function call(
  callKey: string,
  purpose: WritingProviderCall["call_purpose"],
  provider: WritingProviderCall["provider"],
): WritingProviderCall {
  return {
    provider,
    requested_model: "not_exposed",
    call_purpose: purpose,
    call_key: callKey,
  };
}

function acceptedResult(overallSummary: string): {
  result: WritingAdjudicationResult;
  inputLines: ReturnType<typeof buildFeedbackInputLines>;
} {
  const inputLines = buildFeedbackInputLines(
    WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT,
  );
  const feedback: FeedbackPayload = {
    feedback_contract_version: 2,
    overall_summary: overallSummary,
    level_detected: "A2",
    score_summary: {
      correct_lines: inputLines.length - 1,
      acceptable_lines: 0,
      minor_issues: 1,
      major_issues: 0,
      needs_review: 0,
    },
    grammar_topics: [
      {
        topic: "dativ",
        count: 1,
        minor_count: 1,
        major_count: 0,
        severity: "minor",
        simple_explanation:
          "Nach mit steht der Dativ; die Artikelform wird zu der.",
      },
    ],
    lines: inputLines.map((line) => {
      const affected = line.text === "Danach spreche ich mit die Patientin.";
      return {
        line_number: line.line_number,
        source_start: line.source_start,
        source_end: line.source_end,
        original_line: line.text,
        corrected_line: affected
          ? "Danach spreche ich mit der Patientin."
          : line.text,
        status: affected ? ("minor_issue" as const) : ("correct" as const),
        changed_parts: affected
          ? [
            {
              from: "die",
              to: "der",
              reason: "Die vorhandene Artikelform muss im Dativ der lauten.",
              grammar_topics: ["dativ"],
              severity: "minor",
              source_start: line.source_start + 24,
              source_end: line.source_start + 27,
              corrected_start: line.source_start + 24,
              corrected_end: line.source_start + 27,
            },
          ]
          : [],
        short_explanation: affected
          ? "Nach mit braucht der vorhandene Artikel die Dativform der."
          : "Der Satz ist korrekt.",
        detailed_explanation: affected
          ? "Mit regiert den Dativ, deshalb wird die Artikelform die zu der."
          : "Keine Änderung nötig.",
        grammar_topic: affected ? "dativ" : "",
      };
    }),
  };
  return {
    inputLines,
    result: {
      feedback,
      acceptedModel: "not_exposed",
      evidence: {
        schema_version: 2,
        decision: "accepted_model_feedback",
        reason_code: "critic_approved",
        context_sha256: "a".repeat(64),
        original_text_sha256: "b".repeat(64),
        final_feedback_sha256: "c".repeat(64),
        generator_provider: "deepseek",
        generator_model: "not_exposed",
        candidate_feedback_sha256: "d".repeat(64),
        candidate_release_sha256: "e".repeat(64),
        critic_provider: "gemini",
        critic_model: "not_exposed",
        critic_verdict: "approved",
        critic_decision_sha256: "f".repeat(64),
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
        accepted_model: "not_exposed",
      },
    },
  };
}

Deno.test(
  "writing full diagnostic records only bounded stage/provider provenance",
  async () => {
    const recorder = createWritingFullDiagnosticRecorder();
    const calls = [
      call("diagnostic:flash", "writing_generation", "deepseek"),
      call("diagnostic:critic", "writing_critique", "gemini"),
      call("diagnostic:adjudicator", "writing_adjudication", "deepseek"),
      call("diagnostic:final", "writing_final_critique", "gemini"),
    ];
    await recorder.onBeforeProviderCall(calls[0]);
    await recorder.onProviderUsage({
      ...calls[0],
      provider_model_version: "not_exposed",
      input_tokens: 12,
      output_tokens: 34,
    });
    await recorder.onBeforeProviderCall(calls[1]);
    await recorder.onProviderNotCalled(calls[2], "request_failed_unbilled");
    await recorder.onProviderNotCalled(calls[3], "provider_not_called");

    assertEquals(recorder.snapshot(), [
      { stage: "generation", provider: "deepseek" },
      { stage: "critique", provider: "gemini" },
    ]);
    assert(
      !recorder.overflowed(),
      "A skipped stage must not consume the dispatch bound.",
    );
    await recorder.onBeforeProviderCall(calls[2]);
    await recorder.onBeforeProviderCall(calls[3]);
    assertEquals(recorder.snapshot(), [
      { stage: "generation", provider: "deepseek" },
      { stage: "critique", provider: "gemini" },
      { stage: "adjudication", provider: "deepseek" },
      { stage: "final_critique", provider: "gemini" },
    ]);
    await recorder.onBeforeProviderCall(
      call("diagnostic:fifth", "writing_generation", "deepseek"),
    );
    assert(!recorder.overflowed(), "A bounded fifth stage must be recorded.");
    await recorder.onBeforeProviderCall(
      call("diagnostic:sixth", "writing_critique", "gemini"),
    );
    assert(!recorder.overflowed(), "A bounded sixth stage must be recorded.");
    await recorder.onBeforeProviderCall(
      call("diagnostic:actual-overflow", "writing_generation", "deepseek"),
    );
    assert(
      recorder.overflowed(),
      "A seventh dispatched call must fail closed.",
    );
  },
);

Deno.test(
  "writing full diagnostic output has an exact content-free allowlist",
  () => {
    const output = createWritingFullDiagnosticOutput({
      accepted: true,
      safeCode: `Critic Approved ${"private".repeat(30)}`,
      startedAt: 100,
      endedAt: 148.6,
      stages: [{ stage: "generation", provider: "deepseek" }],
      articleFormRegressionPassed: true,
    });
    assertEquals(Object.keys(output), WRITING_FULL_DIAGNOSTIC_FIELDS);
    assertEquals(
      Object.keys(output.stages[0]),
      WRITING_FULL_DIAGNOSTIC_STAGE_FIELDS,
    );
    assert(output.safe_code.length <= 80, "The safe code must be bounded.");
    assertEquals(output.total_elapsed_ms, 49);
    const serialized = JSON.stringify(output).toLowerCase();
    for (
      const forbidden of [
        "prompt",
        "patientin",
        "corrected",
        "explanation",
        "hash",
        "token",
        "model",
        "body",
        "error",
      ]
    ) {
      assert(
        !serialized.includes(forbidden),
        `Leaked forbidden field: ${forbidden}`,
      );
    }
    assertEquals(
      boundedWritingDiagnosticCode("Provider timeout: private details"),
      "provider_timeout_private_details",
    );
  },
);

Deno.test(
  "article-form regression requires an accepted release with precise wording",
  () => {
    const precise = acceptedResult(
      "Die vorhandene Artikelform nach mit muss im Dativ angepasst werden.",
    );
    assert(
      articleFormRegressionPassed(precise),
      "A precise die-to-der release must pass.",
    );

    const imprecise = acceptedResult(
      "Nach mit fehlt der passende Dativartikel.",
    );
    assert(
      !articleFormRegressionPassed(imprecise),
      "A summary that calls the present article missing must fail closed.",
    );

    for (
      const summary of [
        "Der Dativartikel ist nicht vorhanden.",
        "Der Artikel wurde ausgelassen.",
        "Hier steht kein passender Artikel.",
        "Der Artikel steht nicht nach mit.",
      ]
    ) {
      assert(
        !articleFormRegressionPassed(acceptedResult(summary)),
        `A bounded missing-article equivalent must fail: ${summary}`,
      );
    }
  },
);
