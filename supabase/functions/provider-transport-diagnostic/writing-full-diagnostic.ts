import type {
  FeedbackInputLine,
  WritingBeforeProviderCallHook,
  WritingProviderCall,
  WritingProviderNotCalledRecorder,
  WritingProviderUsageRecorder,
} from "../_shared/writing-feedback.ts";
import { buildWritingReleaseProjection } from "../_shared/writing-feedback.ts";
import type { WritingAdjudicationResult } from "../_shared/writing-adjudication.ts";

export const WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT =
  "Am 12.07.2026 beginnt meine Schicht um 7.30 Uhr.\n" +
  "Ich dokumentiere z.B. 2,5 ml.\n\n" +
  "Danach spreche ich mit die Patientin.";

export const WRITING_FULL_DIAGNOSTIC_FIELDS = [
  "accepted",
  "safe_code",
  "total_elapsed_ms",
  "stages",
  "article_form_regression_passed",
] as const;

export const WRITING_FULL_DIAGNOSTIC_STAGE_FIELDS = [
  "stage",
  "provider",
] as const;

export const WRITING_FULL_DIAGNOSTIC_STAGES = [
  "generation",
  "critique",
  "adjudication",
  "final_critique",
] as const;

type WritingFullDiagnosticStage =
  (typeof WRITING_FULL_DIAGNOSTIC_STAGES)[number];

export type WritingFullDiagnosticStageProvenance = {
  stage: WritingFullDiagnosticStage;
  provider: "deepseek" | "gemini";
};

export type WritingFullDiagnosticOutput = {
  accepted: boolean;
  safe_code: string;
  total_elapsed_ms: number;
  stages: WritingFullDiagnosticStageProvenance[];
  article_form_regression_passed: boolean;
};

const MAX_DIAGNOSTIC_PROVIDER_CALLS = 6;
const MAX_SAFE_CODE_CHARACTERS = 80;

function diagnosticStage(
  call: WritingProviderCall,
): WritingFullDiagnosticStage {
  if (call.call_purpose === "writing_generation") return "generation";
  if (call.call_purpose === "writing_critique") return "critique";
  if (call.call_purpose === "writing_adjudication") return "adjudication";
  return "final_critique";
}

export function boundedWritingDiagnosticCode(value: unknown) {
  if (typeof value !== "string") return "writing_diagnostic_failed";
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_SAFE_CODE_CHARACTERS) || "writing_diagnostic_failed"
  );
}

function boundedElapsed(startedAt: number, endedAt: number) {
  const elapsed = Math.max(0, Math.round(endedAt - startedAt));
  return Number.isSafeInteger(elapsed) ? elapsed : Number.MAX_SAFE_INTEGER;
}

export function createWritingFullDiagnosticRecorder() {
  const calls = new Map<string, WritingFullDiagnosticStageProvenance>();
  let overflowed = false;

  function observe(call: WritingProviderCall) {
    if (calls.has(call.call_key)) return;
    if (calls.size >= MAX_DIAGNOSTIC_PROVIDER_CALLS) {
      overflowed = true;
      return;
    }
    calls.set(call.call_key, {
      stage: diagnosticStage(call),
      provider: call.provider,
    });
  }

  const onBeforeProviderCall: WritingBeforeProviderCallHook = async (call) => {
    observe(call);
  };
  // The before hook runs immediately before the transport. Usage and
  // not-called events must not add skipped stages that were never dispatched.
  const onProviderUsage: WritingProviderUsageRecorder = async () => {};
  const onProviderNotCalled: WritingProviderNotCalledRecorder = async () => {};

  return {
    onBeforeProviderCall,
    onProviderUsage,
    onProviderNotCalled,
    overflowed: () => overflowed,
    snapshot: () => [...calls.values()],
  };
}

function describesArticleAsMissing(value: string) {
  const normalized = value.toLocaleLowerCase("de-DE");
  const refersToArticle = /\b(?:artikel|article|dativartikel)\b/u.test(
    normalized,
  );
  const saysMissing =
    /\b(?:fehlt|fehlte|fehlend(?:e|er|es|en|em)?|missing|absent)\b/u.test(
      normalized,
    ) ||
    /\b(?:kein|keine|keinen|keinem|keiner|keines|ohne)\s+(?:passend(?:e|er|es|en|em)?\s+)?artikel\b/u
      .test(
        normalized,
      ) ||
    /\b(?:artikel|article|dativartikel)\b.{0,28}\b(?:nicht\s+(?:vorhanden|da|gesetzt|geschrieben)|ausgelassen|weggelassen)\b/u
      .test(
        normalized,
      ) ||
    /\b(?:nicht\s+(?:vorhanden|da|gesetzt|geschrieben)|ausgelassen|weggelassen)\b.{0,28}\b(?:artikel|article|dativartikel)\b/u
      .test(
        normalized,
      ) ||
    /\b(?:kein|keine|keinen|keinem|keiner|keines)\s+(?:passend(?:e|er|es|en|em)?\s+)?artikel\s+(?:steht|vorhanden|gesetzt)\b/u
      .test(
        normalized,
      ) ||
    /\b(?:artikel|dativartikel)\s+(?:steht|ist)\s+nicht\b/u.test(normalized);
  return refersToArticle && saysMissing;
}

export function articleFormRegressionPassed(args: {
  result: WritingAdjudicationResult;
  inputLines: FeedbackInputLine[];
}) {
  if (
    args.result.evidence.decision !== "accepted_model_feedback" ||
    !args.result.acceptedModel
  ) {
    return false;
  }

  let release: ReturnType<typeof buildWritingReleaseProjection>;
  try {
    release = buildWritingReleaseProjection(
      args.inputLines,
      args.result.feedback,
      args.result.acceptedModel,
    );
  } catch {
    return false;
  }

  const affectedLine = release.lines.find(
    (line) => line.original_line === "Danach spreche ich mit die Patientin.",
  );
  if (
    !affectedLine ||
    affectedLine.corrected_line !== "Danach spreche ich mit der Patientin." ||
    !affectedLine.changed_parts.some(
      (part) => part.from === "die" && part.to === "der",
    )
  ) {
    return false;
  }

  const descriptions = [
    release.overall_summary,
    ...release.lines.flatMap((line) => [
      line.short_explanation,
      line.detailed_explanation,
      ...line.changed_parts.map((part) => part.reason),
    ]),
    ...release.grammar_topics.map((topic) => topic.simple_explanation),
  ];
  return descriptions.every(
    (description) => !describesArticleAsMissing(description),
  );
}

export function createWritingFullDiagnosticOutput(args: {
  accepted: boolean;
  safeCode: unknown;
  startedAt: number;
  endedAt: number;
  stages: WritingFullDiagnosticStageProvenance[];
  articleFormRegressionPassed: boolean;
}): WritingFullDiagnosticOutput {
  const stages = args.stages
    .slice(0, MAX_DIAGNOSTIC_PROVIDER_CALLS)
    .map((stage) => ({ stage: stage.stage, provider: stage.provider }));
  return {
    accepted: args.accepted,
    safe_code: boundedWritingDiagnosticCode(args.safeCode),
    total_elapsed_ms: boundedElapsed(args.startedAt, args.endedAt),
    stages,
    article_form_regression_passed: args.articleFormRegressionPassed,
  };
}
