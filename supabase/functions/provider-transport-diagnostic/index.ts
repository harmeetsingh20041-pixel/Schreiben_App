type JsonRecord = Record<string, unknown>;

import {
  buildFeedbackInputLines,
  buildSystemPrompt,
  buildUserPrompt,
  FeedbackEvaluationError,
  generateIndependentlyAdjudicatedFeedback,
  WRITING_PROVIDER_MAX_OUTPUT_TOKENS,
} from "../_shared/writing-feedback.ts";
import {
  createOptionalGeminiSecondaryProvider,
  DEEPSEEK_V1_FLASH_MODEL,
  DEEPSEEK_V1_PRO_MODEL,
} from "../_shared/chat-completion-provider.ts";
import { sha256Text } from "../_shared/writing-adjudication.ts";
import {
  generateWorksheetWithDeepSeek,
  generateWorksheetWithSecondaryFallback,
  systemPrompt as worksheetSystemPrompt,
  userPrompt as worksheetUserPrompt,
  WORKSHEET_CRITIC_TIMEOUT_MS,
  WORKSHEET_GENERATOR_MAX_TOKENS,
  WORKSHEET_MCQ_SAFE_GENERATOR_TIMEOUT_MS,
  WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS,
  WORKSHEET_SECONDARY_CRITIC_TIMEOUT_MS,
  WorksheetGenerationError,
} from "../_shared/worksheet-generation.ts";
import {
  critiqueWorksheetWithDeepSeek,
  critiqueWorksheetWithGemini,
  generatePrimaryFallbackWorksheetCandidate,
  generatePrimaryWorksheetCandidate,
  generateRepairWorksheetCandidate,
  isPrimaryGeneratorFallbackEligible,
  validateWorksheetCandidateWithDualCritics,
} from "../_shared/worksheet-validation.ts";
import { createWorksheetStageDiagnosticRecorder } from "./worksheet-stage-diagnostic.ts";
import {
  articleFormRegressionPassed,
  createWritingFullDiagnosticOutput,
  createWritingFullDiagnosticRecorder,
  WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT,
} from "./writing-full-diagnostic.ts";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string) {
  const width = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < width; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function serviceKeys() {
  const keys = [
    Deno.env.get("PROVIDER_DIAGNOSTIC_SECRET")?.trim(),
    Deno.env.get("SUPABASE_SECRET_KEY")?.trim(),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim(),
  ];
  try {
    const configured = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
    ) as unknown;
    if (isRecord(configured)) {
      keys.push(
        ...Object.values(configured).map((value) =>
          typeof value === "string" ? value.trim() : undefined
        ),
      );
    }
  } catch {
    // A malformed platform key map must not authorize any extra credential.
  }
  return [...new Set(keys.filter((key): key is string => Boolean(key)))];
}

function sortedKeys(value: unknown) {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function safeInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function textIsJsonObject(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

async function boundedJson(response: Response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 512 * 1024) {
    return { parsed: null, oversized: true };
  }
  try {
    return { parsed: JSON.parse(text), oversized: false };
  } catch {
    return { parsed: null, oversized: false };
  }
}

function geminiSummary(model: string, response: Response, value: unknown) {
  const envelope = isRecord(value) ? value : null;
  const error = envelope && isRecord(envelope.error) ? envelope.error : null;
  const candidates = envelope && Array.isArray(envelope.candidates)
    ? envelope.candidates
    : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  const content = candidate && isRecord(candidate.content)
    ? candidate.content
    : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const firstPart = isRecord(parts[0]) ? parts[0] : null;
  const usage = envelope && isRecord(envelope.usageMetadata)
    ? envelope.usageMetadata
    : null;
  const promptFeedback = envelope && isRecord(envelope.promptFeedback)
    ? envelope.promptFeedback
    : null;
  return {
    provider: "gemini",
    requested_model: model,
    http_status: response.status,
    ok: response.ok,
    error_status: typeof error?.status === "string" ? error.status : null,
    response_json: envelope !== null,
    model_version: typeof envelope?.modelVersion === "string"
      ? envelope.modelVersion
      : null,
    candidate_count: candidates.length,
    finish_reason: typeof candidate?.finishReason === "string"
      ? candidate.finishReason
      : null,
    content_role: typeof content?.role === "string" ? content.role : null,
    part_count: parts.length,
    first_part_keys: sortedKeys(firstPart),
    text_present: typeof firstPart?.text === "string" &&
      firstPart.text.length > 0,
    text_is_json_object: textIsJsonObject(firstPart?.text),
    usage_keys: sortedKeys(usage),
    prompt_tokens: safeInteger(usage?.promptTokenCount),
    candidate_tokens: safeInteger(usage?.candidatesTokenCount),
    thought_tokens: safeInteger(usage?.thoughtsTokenCount),
    total_tokens: safeInteger(usage?.totalTokenCount),
    prompt_block_reason: typeof promptFeedback?.blockReason === "string"
      ? promptFeedback.blockReason
      : null,
  };
}

async function checkGemini(model: string, apiKey: string) {
  const thinkingConfig = model === "gemini-2.5-flash"
    ? { includeThoughts: false, thinkingBudget: 512 }
    : { includeThoughts: false, thinkingLevel: "low" };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "Return only valid JSON matching the schema." }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: "Return an object whose ok field is true." }],
          },
        ],
        generationConfig: {
          candidateCount: 1,
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          maxOutputTokens: 512,
          thinkingConfig,
        },
      }),
    },
  );
  const { parsed, oversized } = await boundedJson(response);
  return { ...geminiSummary(model, response, parsed), oversized };
}

async function checkGeminiHealth(model: string, apiKey: string) {
  try {
    return await checkGemini(model, apiKey);
  } catch {
    return {
      provider: "gemini",
      requested_model: model,
      http_status: null,
      ok: false,
      error_status: "TRANSPORT_UNAVAILABLE",
      response_json: false,
      model_version: null,
      candidate_count: 0,
      finish_reason: null,
      text_present: false,
      text_is_json_object: false,
      prompt_tokens: null,
      candidate_tokens: null,
      thought_tokens: null,
      total_tokens: null,
      prompt_block_reason: null,
      oversized: false,
    };
  }
}

function deepSeekSummary(
  label: string,
  model: string,
  response: Response,
  value: unknown,
) {
  const envelope = isRecord(value) ? value : null;
  const error = envelope && isRecord(envelope.error) ? envelope.error : null;
  const choices = envelope && Array.isArray(envelope.choices)
    ? envelope.choices
    : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;
  const parsedContent = typeof message?.content === "string"
    ? (() => {
      try {
        return JSON.parse(message.content);
      } catch {
        return null;
      }
    })()
    : null;
  const usage = envelope && isRecord(envelope.usage) ? envelope.usage : null;
  return {
    provider: "deepseek",
    diagnostic_label: label,
    requested_model: model,
    http_status: response.status,
    ok: response.ok,
    error_type: typeof error?.type === "string" ? error.type : null,
    response_json: envelope !== null,
    returned_model: typeof envelope?.model === "string" ? envelope.model : null,
    choice_count: choices.length,
    finish_reason: typeof choice?.finish_reason === "string"
      ? choice.finish_reason
      : null,
    message_keys: sortedKeys(message),
    content_present: typeof message?.content === "string" &&
      message.content.length > 0,
    content_character_count: typeof message?.content === "string"
      ? message.content.length
      : null,
    content_is_json_object: textIsJsonObject(message?.content),
    content_object_keys: sortedKeys(parsedContent),
    usage_keys: sortedKeys(usage),
    prompt_tokens: safeInteger(usage?.prompt_tokens),
    completion_tokens: safeInteger(usage?.completion_tokens),
    total_tokens: safeInteger(usage?.total_tokens),
  };
}

async function checkDeepSeek(
  label: string,
  model: string,
  apiKey: string,
  body: JsonRecord,
) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const { parsed, oversized } = await boundedJson(response);
  return { ...deepSeekSummary(label, model, response, parsed), oversized };
}

function syntheticWritingPayload(
  model: "deepseek-v4-flash" | "deepseek-v4-pro",
) {
  const originalText = WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT;
  return {
    model,
    thinking: { type: "disabled" },
    ...(model === "deepseek-v4-flash" ? { temperature: 0.2 } : {}),
    messages: [
      { role: "system", content: buildSystemPrompt("A2") },
      {
        role: "user",
        content: buildUserPrompt({
          targetLevel: "A2",
          questionTitle: "Free Writing",
          questionPrompt: "Free writing without a predefined task.",
          questionTopic: "None",
          mode: "free_text",
          inputLines: buildFeedbackInputLines(originalText),
          ...(model === "deepseek-v4-pro"
            ? {
              previousFailure:
                "The Flash response failed deterministic schema and semantic validation.",
            }
            : {}),
        }),
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: WRITING_PROVIDER_MAX_OUTPUT_TOKENS,
    stream: false,
  };
}

async function checkFullWritingPipeline(
  deepSeekApiKey: string,
  geminiApiKey: string,
) {
  const startedAt = Date.now();
  const recorder = createWritingFullDiagnosticRecorder();
  const secondaryProvider = createOptionalGeminiSecondaryProvider({
    apiKey: geminiApiKey,
  });
  if (!secondaryProvider) {
    return createWritingFullDiagnosticOutput({
      accepted: false,
      safeCode: "writing_secondary_not_configured",
      startedAt,
      endedAt: Date.now(),
      stages: recorder.snapshot(),
      articleFormRegressionPassed: false,
    });
  }

  try {
    const inputLines = buildFeedbackInputLines(
      WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT,
    );
    const originalTextSha256 = await sha256Text(
      WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT,
    );
    const contextSha256 = await sha256Text(
      JSON.stringify({
        schema_version: 1,
        target_level: "A2",
        question_title: "Free Writing",
        question_prompt: "Free writing without a predefined task.",
        question_topic: "None",
        mode: "free_text",
        original_text_sha256: originalTextSha256,
      }),
    );
    const result = await generateIndependentlyAdjudicatedFeedback({
      apiKey: deepSeekApiKey,
      flashModel: DEEPSEEK_V1_FLASH_MODEL,
      proModel: DEEPSEEK_V1_PRO_MODEL,
      requestId: "writing_full_diagnostic",
      targetLevel: "A2",
      questionTitle: "Free Writing",
      questionPrompt: "Free writing without a predefined task.",
      questionTopic: "None",
      mode: "free_text",
      inputLines,
      contextSha256,
      originalTextSha256,
      geminiSecondary: secondaryProvider,
      allowPrimaryAuthFailover: true,
      providerCallKeyPrefix: "writing_diagnostic",
      onBeforeProviderCall: recorder.onBeforeProviderCall,
      onProviderUsage: recorder.onProviderUsage,
      onProviderNotCalled: recorder.onProviderNotCalled,
    });
    const regressionPassed = articleFormRegressionPassed({
      result,
      inputLines,
    });
    const modelFeedbackAccepted =
      result.evidence.decision === "accepted_model_feedback" &&
      result.acceptedModel !== null;
    const accepted = modelFeedbackAccepted && regressionPassed &&
      !recorder.overflowed();
    return createWritingFullDiagnosticOutput({
      accepted,
      safeCode: recorder.overflowed()
        ? "writing_diagnostic_stage_overflow"
        : modelFeedbackAccepted && !regressionPassed
        ? "article_form_regression_failed"
        : result.evidence.reason_code,
      startedAt,
      endedAt: Date.now(),
      stages: recorder.snapshot(),
      articleFormRegressionPassed: regressionPassed,
    });
  } catch (error) {
    return createWritingFullDiagnosticOutput({
      accepted: false,
      safeCode: error instanceof FeedbackEvaluationError
        ? error.safeCode
        : "unexpected_diagnostic_failure",
      startedAt,
      endedAt: Date.now(),
      stages: recorder.snapshot(),
      articleFormRegressionPassed: false,
    });
  }
}

function syntheticRecoveryCriticPayload() {
  const hash = "a".repeat(64);
  return {
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    messages: [
      {
        role: "system",
        content:
          "You are the independent cross-provider German-writing recovery critic. Approve only when every correction, explanation, topic, CEFR judgment, exact original span, and release projection is correct. Never rewrite the candidate. Return only JSON.",
      },
      {
        role: "user",
        content:
          `Audit this synthetic A2 recovery candidate. Echo all four hashes exactly and return an object with context_sha256, original_text_sha256, candidate_feedback_sha256, candidate_release_sha256, verdict, reason_codes, and affected_line_numbers. Hash: ${hash}. Candidate: one correct line \"Das ist richtig.\" with offsets 0..16.`,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 1_400,
    stream: false,
  };
}

const diagnosticWorksheetTopics = {
  prepositions: {
    name: "Präpositionen",
    slug: "prepositions",
    description: "A2 prepositions in practical healthcare communication.",
  },
  sentence_structure: {
    name: "Satzbau",
    slug: "sentence-structure",
    description:
      "A2 German sentence structure in practical healthcare communication.",
  },
  capitalization: {
    name: "Groß- und Kleinschreibung",
    slug: "capitalization",
    description:
      "A2 German noun capitalization in practical healthcare communication.",
  },
} as const;

type DiagnosticWorksheetTopic = keyof typeof diagnosticWorksheetTopics;

async function checkDeepSeekWorksheet(
  apiKey: string,
  topicKey: DiagnosticWorksheetTopic,
) {
  try {
    const worksheet = await generateWorksheetWithDeepSeek({
      apiKey,
      model: "deepseek-v4-pro",
      topic: diagnosticWorksheetTopics[topicKey],
      level: "A2",
      difficulty: "medium",
      revisionFeedback: [],
      timeoutMs: WORKSHEET_MCQ_SAFE_GENERATOR_TIMEOUT_MS,
      generationProfile: "mcq_safe",
    });
    return {
      provider: "deepseek",
      diagnostic_label: `validated_worksheet_generation:${topicKey}`,
      accepted: true,
      safe_error_code: null,
      retryable: null,
      question_count: worksheet.questions.length,
      open_evaluation_count: worksheet.questions.filter(
        (question) => question.evaluation_mode === "open_evaluation",
      ).length,
      question_types: [
        ...new Set(
          worksheet.questions.map((question) => question.question_type),
        ),
      ].sort(),
    };
  } catch (error) {
    return {
      provider: "deepseek",
      diagnostic_label: `validated_worksheet_generation:${topicKey}`,
      accepted: false,
      safe_error_code: error instanceof WorksheetGenerationError
        ? error.safeCode
        : "unexpected_diagnostic_failure",
      retryable: error instanceof WorksheetGenerationError
        ? error.retryable
        : false,
      question_count: null,
      open_evaluation_count: null,
      question_types: [],
    };
  }
}

async function inspectDeepSeekWorksheetShape(
  apiKey: string,
  topicKey: DiagnosticWorksheetTopic,
) {
  const topic = diagnosticWorksheetTopics[topicKey];
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      temperature: 0.2,
      messages: [
        { role: "system", content: worksheetSystemPrompt() },
        {
          role: "user",
          content: worksheetUserPrompt({
            topic,
            level: "A2",
            difficulty: "medium",
            revisionFeedback: [],
          }),
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: WORKSHEET_GENERATOR_MAX_TOKENS,
      stream: false,
    }),
  });
  const { parsed, oversized } = await boundedJson(response);
  const envelope = isRecord(parsed) ? parsed : null;
  const choices = envelope && Array.isArray(envelope.choices)
    ? envelope.choices
    : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;
  let content: unknown = null;
  if (typeof message?.content === "string") {
    try {
      content = JSON.parse(message.content);
    } catch {
      content = null;
    }
  }
  const worksheet = isRecord(content) ? content : null;
  const questions = worksheet && Array.isArray(worksheet.questions)
    ? worksheet.questions
    : [];
  const miniLesson = worksheet && isRecord(worksheet.mini_lesson)
    ? worksheet.mini_lesson
    : null;
  const fillBlanks = questions
    .filter(
      (question) =>
        isRecord(question) && question.question_type === "fill_blank",
    )
    .map((question) => {
      const value = question as JsonRecord;
      return {
        question_number: safeInteger(value.question_number),
        prompt: typeof value.prompt === "string" ? value.prompt : null,
        correct_answer: typeof value.correct_answer === "string"
          ? value.correct_answer
          : null,
        accepted_answers: Array.isArray(value.accepted_answers)
          ? value.accepted_answers.filter((entry) => typeof entry === "string")
          : [],
        options: Array.isArray(value.options)
          ? value.options.filter((entry) => typeof entry === "string")
          : [],
      };
    });
  return {
    provider: "deepseek",
    diagnostic_label: `synthetic_worksheet_shape:${topicKey}`,
    http_status: response.status,
    ok: response.ok,
    oversized,
    question_count: questions.length,
    mini_lesson_correct_examples_count:
      miniLesson && Array.isArray(miniLesson.correct_examples)
        ? miniLesson.correct_examples.length
        : null,
    question_shapes: questions.map((question) => {
      const value = isRecord(question) ? question : null;
      const rubric = value && isRecord(value.rubric) ? value.rubric : null;
      return {
        question_number: safeInteger(value?.question_number),
        question_type: typeof value?.question_type === "string"
          ? value.question_type
          : null,
        options_count: Array.isArray(value?.options)
          ? value.options.length
          : null,
        accepted_answers_count: Array.isArray(value?.accepted_answers)
          ? value.accepted_answers.length
          : null,
        rubric_criteria_count: rubric && Array.isArray(rubric.criteria)
          ? rubric.criteria.length
          : null,
      };
    }),
    fill_blank_count: fillBlanks.length,
    fill_blanks: fillBlanks,
  };
}

async function checkGeminiWorksheetFallback(apiKey: string) {
  let providerHttpStatus: number | null = null;
  let providerErrorStatus: string | null = null;
  let providerErrorCode: number | null = null;
  let providerErrorClass: string | null = null;
  let providerErrorSummary: string | null = null;
  let providerSchemaKeywords: string[] = [];
  let providerFinishReason: string | null = null;
  let providerPartCount: number | null = null;
  let providerFirstPartKeys: string[] = [];
  let providerTextPresent: boolean | null = null;
  let providerPromptTokens: number | null = null;
  let providerCandidateTokens: number | null = null;
  let providerThoughtTokens: number | null = null;
  const secondaryProvider = createOptionalGeminiSecondaryProvider({
    apiKey,
    fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      providerHttpStatus = response.status;
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (response.ok) {
        const envelope = isRecord(body) ? body : null;
        const candidates = envelope && Array.isArray(envelope.candidates)
          ? envelope.candidates
          : [];
        const candidate = isRecord(candidates[0]) ? candidates[0] : null;
        const content = candidate && isRecord(candidate.content)
          ? candidate.content
          : null;
        const parts = content && Array.isArray(content.parts)
          ? content.parts
          : [];
        const firstPart = isRecord(parts[0]) ? parts[0] : null;
        const usage = envelope && isRecord(envelope.usageMetadata)
          ? envelope.usageMetadata
          : null;
        providerFinishReason = typeof candidate?.finishReason === "string"
          ? candidate.finishReason
          : null;
        providerPartCount = parts.length;
        providerFirstPartKeys = sortedKeys(firstPart);
        providerTextPresent = typeof firstPart?.text === "string" &&
          firstPart.text.length > 0;
        providerPromptTokens = safeInteger(usage?.promptTokenCount);
        providerCandidateTokens = safeInteger(usage?.candidatesTokenCount);
        providerThoughtTokens = safeInteger(usage?.thoughtsTokenCount);
      } else {
        const error = isRecord(body) && isRecord(body.error)
          ? body.error
          : null;
        providerErrorStatus = typeof error?.status === "string"
          ? error.status
          : null;
        providerErrorCode = safeInteger(error?.code);
        const message = typeof error?.message === "string"
          ? error.message.slice(0, 2_000)
          : "";
        providerErrorSummary = message
          .replace(/https?:\/\/\S+/gi, "[url]")
          .replace(/AIza[A-Za-z0-9_-]+/g, "[key]")
          .replace(/[A-Za-z0-9_-]{48,}/g, "[opaque]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 700) || null;
        providerErrorClass = /quota|rate.?limit|resource exhausted/i.test(
            message,
          )
          ? "quota_or_rate_limit"
          : /billing/i.test(message)
          ? "billing_required"
          : /schema|json payload|unknown name|invalid argument/i.test(message)
          ? "request_schema_rejected"
          : /model|not found/i.test(message)
          ? "model_unavailable"
          : "provider_rejected";
        providerSchemaKeywords = [
          "additionalProperties",
          "minItems",
          "maxItems",
          "anyOf",
          "prefixItems",
          "responseJsonSchema",
        ].filter((keyword) => message.includes(keyword));
      }
      return response;
    },
  });
  if (!secondaryProvider) {
    return {
      provider: "gemini",
      diagnostic_label: "validated_worksheet_fallback",
      accepted: false,
      safe_error_code: "worksheet_fallback_not_configured",
      retryable: false,
      provider_http_status: null,
      provider_error_status: null,
      provider_error_code: null,
      provider_error_class: null,
      provider_error_summary: null,
      provider_schema_keywords: [],
      provider_finish_reason: null,
      provider_part_count: null,
      provider_first_part_keys: [],
      provider_text_present: null,
      provider_prompt_tokens: null,
      provider_candidate_tokens: null,
      provider_thought_tokens: null,
    };
  }
  try {
    const worksheet = await generateWorksheetWithSecondaryFallback({
      secondaryProvider,
      topic: diagnosticWorksheetTopics.sentence_structure,
      level: "A2",
      difficulty: "medium",
      revisionFeedback: [
        "Produce one complete deterministic MCQ-safe candidate from the original curriculum context.",
      ],
      timeoutMs: WORKSHEET_MCQ_SAFE_GENERATOR_TIMEOUT_MS,
      timeoutProfile: "durable_stage",
      providerOutageRecoveryEligible: true,
      generationProfile: "mcq_safe",
    });
    return {
      provider: "gemini",
      diagnostic_label: "validated_worksheet_fallback",
      accepted: true,
      safe_error_code: null,
      retryable: null,
      provider_http_status: providerHttpStatus,
      provider_error_status: null,
      provider_error_code: null,
      provider_error_class: null,
      provider_error_summary: null,
      provider_schema_keywords: [],
      provider_finish_reason: providerFinishReason,
      provider_part_count: providerPartCount,
      provider_first_part_keys: providerFirstPartKeys,
      provider_text_present: providerTextPresent,
      provider_prompt_tokens: providerPromptTokens,
      provider_candidate_tokens: providerCandidateTokens,
      provider_thought_tokens: providerThoughtTokens,
      question_count: worksheet.questions.length,
    };
  } catch (error) {
    return {
      provider: "gemini",
      diagnostic_label: "validated_worksheet_fallback",
      accepted: false,
      safe_error_code: error instanceof WorksheetGenerationError
        ? error.safeCode
        : "unexpected_diagnostic_failure",
      retryable: error instanceof WorksheetGenerationError
        ? error.retryable
        : false,
      provider_http_status: providerHttpStatus,
      provider_error_status: providerErrorStatus,
      provider_error_code: providerErrorCode,
      provider_error_class: providerErrorClass,
      provider_error_summary: providerErrorSummary,
      provider_schema_keywords: providerSchemaKeywords,
      provider_finish_reason: providerFinishReason,
      provider_part_count: providerPartCount,
      provider_first_part_keys: providerFirstPartKeys,
      provider_text_present: providerTextPresent,
      provider_prompt_tokens: providerPromptTokens,
      provider_candidate_tokens: providerCandidateTokens,
      provider_thought_tokens: providerThoughtTokens,
      question_count: null,
    };
  }
}

async function checkFullWorksheetPipeline(
  deepSeekApiKey: string,
  geminiApiKey: string,
  topicKey: DiagnosticWorksheetTopic = "sentence_structure",
) {
  const topic = diagnosticWorksheetTopics[topicKey];
  const diagnosticLabel = `full_dual_provider_worksheet_pipeline:${topicKey}`;
  const stageDiagnostic = createWorksheetStageDiagnosticRecorder();
  const secondaryProvider = createOptionalGeminiSecondaryProvider({
    apiKey: geminiApiKey,
  });
  if (!secondaryProvider) {
    stageDiagnostic.markFailure("worksheet_secondary_not_configured");
    return {
      diagnostic_label: diagnosticLabel,
      accepted: false,
      safe_error_code: "worksheet_secondary_not_configured",
      retryable: false,
      stages: stageDiagnostic.snapshot(),
    };
  }
  try {
    const primaryDeadlineAt = Date.now() + WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS;
    let primaryCandidate;
    let primaryCriticDeadlineAt = primaryDeadlineAt;
    try {
      primaryCandidate = await generatePrimaryWorksheetCandidate({
        apiKey: deepSeekApiKey,
        generatorModel: "deepseek-v4-pro",
        topic,
        level: "A2",
        difficulty: "medium",
        secondaryProvider,
        providerLifecycleHooks: stageDiagnostic.hooks,
        providerCallKeyPrefix: "worksheet_diagnostic",
        deadlineAt: primaryDeadlineAt,
      });
    } catch (error) {
      if (!isPrimaryGeneratorFallbackEligible(error)) throw error;
      stageDiagnostic.markFailure(error.safeCode);
      primaryCriticDeadlineAt = Date.now() +
        WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS;
      primaryCandidate = await generatePrimaryFallbackWorksheetCandidate({
        secondaryProvider,
        topic,
        level: "A2",
        difficulty: "medium",
        primaryFailureCode: error.safeCode,
        providerLifecycleHooks: stageDiagnostic.hooks,
        providerCallKeyPrefix: "worksheet_diagnostic",
        deadlineAt: primaryCriticDeadlineAt,
      });
    }
    const primaryResult = await validateWorksheetCandidateWithDualCritics({
      apiKey: deepSeekApiKey,
      criticModel: "deepseek-v4-flash",
      topic,
      level: "A2",
      difficulty: "medium",
      candidate: primaryCandidate,
      candidateAttempt: 1,
      secondaryProvider,
      providerLifecycleHooks: stageDiagnostic.hooks,
      providerCallKeyPrefix: "worksheet_diagnostic",
      deadlineAt: primaryCriticDeadlineAt,
    });
    let result = primaryResult;
    if (!primaryResult.validation.independent_model) {
      const repairDeadlineAt = Date.now() +
        WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS;
      const repairCandidate = await generateRepairWorksheetCandidate({
        secondaryProvider,
        topic,
        level: "A2",
        difficulty: "medium",
        revisionFeedback: primaryResult.validation.rejection_reasons,
        providerLifecycleHooks: stageDiagnostic.hooks,
        providerCallKeyPrefix: "worksheet_diagnostic",
        deadlineAt: repairDeadlineAt,
      });
      result = await validateWorksheetCandidateWithDualCritics({
        apiKey: deepSeekApiKey,
        criticModel: "deepseek-v4-flash",
        topic,
        level: "A2",
        difficulty: "medium",
        candidate: repairCandidate,
        candidateAttempt: 2,
        secondaryProvider,
        providerLifecycleHooks: stageDiagnostic.hooks,
        providerCallKeyPrefix: "worksheet_diagnostic",
        deadlineAt: repairDeadlineAt,
      });
    }
    return {
      diagnostic_label: diagnosticLabel,
      accepted: result.validation.independent_model,
      safe_error_code: result.validation.independent_model
        ? null
        : "worksheet_candidates_rejected",
      retryable: null,
      stages: stageDiagnostic.snapshot(),
    };
  } catch (error) {
    const safeErrorCode = error instanceof WorksheetGenerationError
      ? error.safeCode
      : "unexpected_diagnostic_failure";
    stageDiagnostic.markFailure(safeErrorCode);
    return {
      diagnostic_label: diagnosticLabel,
      accepted: false,
      safe_error_code: safeErrorCode,
      retryable: error instanceof WorksheetGenerationError
        ? error.retryable
        : false,
      stages: stageDiagnostic.snapshot(),
    };
  }
}

function criticDiagnosticResult(
  provider: "deepseek" | "gemini",
  result: PromiseSettledResult<
    Awaited<ReturnType<typeof critiqueWorksheetWithDeepSeek>>
  >,
) {
  if (result.status === "fulfilled") {
    return {
      provider,
      valid: true,
      approved: result.value.approved,
      checks: result.value.checks,
      rejection_reasons: result.value.rejection_reasons,
      safe_error_code: null,
      retryable: null,
    };
  }
  return {
    provider,
    valid: false,
    approved: null,
    checks: null,
    rejection_reasons: [],
    safe_error_code: result.reason instanceof WorksheetGenerationError
      ? result.reason.safeCode
      : "unexpected_diagnostic_failure",
    retryable: result.reason instanceof WorksheetGenerationError
      ? result.reason.retryable
      : false,
  };
}

async function checkWorksheetCritics(
  deepSeekApiKey: string,
  geminiApiKey: string,
) {
  const secondaryProvider = createOptionalGeminiSecondaryProvider({
    apiKey: geminiApiKey,
  });
  if (!secondaryProvider) {
    return {
      diagnostic_label: "independent_worksheet_critics",
      candidate_valid: false,
      candidate_error: "worksheet_secondary_not_configured",
      critics: [],
    };
  }
  let candidate;
  try {
    candidate = await generateWorksheetWithDeepSeek({
      apiKey: deepSeekApiKey,
      model: "deepseek-v4-pro",
      topic: diagnosticWorksheetTopics.sentence_structure,
      level: "A2",
      difficulty: "medium",
      revisionFeedback: [],
      timeoutMs: WORKSHEET_MCQ_SAFE_GENERATOR_TIMEOUT_MS,
      generationProfile: "mcq_safe",
    });
  } catch (error) {
    return {
      diagnostic_label: "independent_worksheet_critics",
      candidate_valid: false,
      candidate_error: error instanceof WorksheetGenerationError
        ? error.safeCode
        : "unexpected_diagnostic_failure",
      critics: [],
    };
  }
  const results = await Promise.allSettled([
    critiqueWorksheetWithDeepSeek({
      apiKey: deepSeekApiKey,
      model: "deepseek-v4-flash",
      topic: diagnosticWorksheetTopics.sentence_structure,
      level: "A2",
      difficulty: "medium",
      worksheet: candidate,
      timeoutMs: WORKSHEET_CRITIC_TIMEOUT_MS,
    }),
    critiqueWorksheetWithGemini({
      secondaryProvider,
      topic: diagnosticWorksheetTopics.sentence_structure,
      level: "A2",
      difficulty: "medium",
      worksheet: candidate,
      timeoutMs: WORKSHEET_SECONDARY_CRITIC_TIMEOUT_MS,
    }),
  ]);
  return {
    diagnostic_label: "independent_worksheet_critics",
    candidate_valid: true,
    candidate_error: null,
    question_count: candidate.questions.length,
    critics: [
      criticDiagnosticResult("deepseek", results[0]),
      criticDiagnosticResult("gemini", results[1]),
    ],
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  // The gateway credential and the private diagnostic credential are
  // deliberately independent. New Supabase API keys belong in `apikey`; the
  // staging-only diagnostic may also receive a server credential through its
  // dedicated header after the gateway accepted a publishable key.
  const token = request.headers.get("x-diagnostic-key")?.trim() ||
    request.headers.get("apikey")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!serviceKeys().some((key) => constantTimeEqual(token, key))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const requestBody = await request.json().catch(() => ({}));
  const only = isRecord(requestBody) ? requestBody.only : null;
  if (
    only !== null &&
    only !== undefined &&
    only !== "worksheet" &&
    only !== "worksheet_sentence_structure" &&
    only !== "worksheet_capitalization" &&
    only !== "worksheet_secondary" &&
    only !== "worksheet_full" &&
    only !== "worksheet_capitalization_full" &&
    only !== "worksheet_critics" &&
    only !== "writing_full" &&
    only !== "gemini_health"
  ) {
    return Response.json({ error: "invalid_diagnostic_mode" }, { status: 400 });
  }
  const geminiKey = Deno.env.get("GEMINI_API_KEY")?.trim() ?? "";
  const deepSeekKey = Deno.env.get("DEEPSEEK_API_KEY")?.trim() ?? "";
  const checks: unknown[] = [];
  if (only === "writing_full") {
    if (
      !isRecord(requestBody) ||
      Object.keys(requestBody).some((key) => key !== "only")
    ) {
      return Response.json(
        { error: "invalid_diagnostic_request" },
        { status: 400 },
      );
    }
    if (!deepSeekKey || !geminiKey) {
      return Response.json(
        createWritingFullDiagnosticOutput({
          accepted: false,
          safeCode: "writing_provider_not_configured",
          startedAt: Date.now(),
          endedAt: Date.now(),
          stages: [],
          articleFormRegressionPassed: false,
        }),
      );
    }
    return Response.json(
      await checkFullWritingPipeline(deepSeekKey, geminiKey),
    );
  }
  if (only === "gemini_health") {
    if (geminiKey) {
      checks.push(
        ...await Promise.all(
          [
            "gemini-3.5-flash",
            "gemini-3-flash-preview",
            "gemini-3.1-pro-preview",
            "gemini-2.5-flash",
            "gemini-3.1-flash-lite",
          ].map((model) => checkGeminiHealth(model, geminiKey)),
        ),
      );
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet") {
    if (deepSeekKey) {
      checks.push(await checkDeepSeekWorksheet(deepSeekKey, "prepositions"));
      checks.push(
        await inspectDeepSeekWorksheetShape(deepSeekKey, "prepositions"),
      );
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_sentence_structure") {
    if (deepSeekKey) {
      checks.push(
        await checkDeepSeekWorksheet(deepSeekKey, "sentence_structure"),
      );
      checks.push(
        await inspectDeepSeekWorksheetShape(deepSeekKey, "sentence_structure"),
      );
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_capitalization") {
    if (deepSeekKey) {
      checks.push(
        await checkDeepSeekWorksheet(deepSeekKey, "capitalization"),
      );
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_secondary") {
    if (geminiKey) {
      checks.push(await checkGeminiWorksheetFallback(geminiKey));
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_full") {
    if (deepSeekKey && geminiKey) {
      checks.push(await checkFullWorksheetPipeline(deepSeekKey, geminiKey));
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_capitalization_full") {
    if (deepSeekKey && geminiKey) {
      checks.push(
        await checkFullWorksheetPipeline(
          deepSeekKey,
          geminiKey,
          "capitalization",
        ),
      );
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (only === "worksheet_critics") {
    if (deepSeekKey && geminiKey) {
      checks.push(await checkWorksheetCritics(deepSeekKey, geminiKey));
    }
    return Response.json({
      deepseek_configured: Boolean(deepSeekKey),
      gemini_configured: Boolean(geminiKey),
      checks,
    });
  }
  if (deepSeekKey) {
    checks.push(
      await checkDeepSeek("simple_flash", "deepseek-v4-flash", deepSeekKey, {
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: "Return only valid JSON." },
          { role: "user", content: 'Return {"ok":true}.' },
        ],
        response_format: { type: "json_object" },
        max_tokens: 512,
        stream: false,
      }),
    );
    checks.push(
      await checkDeepSeek(
        "writing_flash",
        "deepseek-v4-flash",
        deepSeekKey,
        syntheticWritingPayload("deepseek-v4-flash"),
      ),
    );
    checks.push(
      await checkDeepSeek(
        "writing_pro",
        "deepseek-v4-pro",
        deepSeekKey,
        syntheticWritingPayload("deepseek-v4-pro"),
      ),
    );
    checks.push(
      await checkDeepSeek(
        "recovery_critic_pro",
        "deepseek-v4-pro",
        deepSeekKey,
        syntheticRecoveryCriticPayload(),
      ),
    );
    checks.push(await checkDeepSeekWorksheet(deepSeekKey, "prepositions"));
  }
  if (geminiKey) {
    checks.push(
      ...await Promise.all(
        [
          "gemini-3.5-flash",
          "gemini-3-flash-preview",
          "gemini-3.1-pro-preview",
          "gemini-2.5-flash",
          "gemini-3.1-flash-lite",
        ].map((model) => checkGeminiHealth(model, geminiKey)),
      ),
    );
  }
  return Response.json({
    deepseek_configured: Boolean(deepSeekKey),
    gemini_configured: Boolean(geminiKey),
    checks,
  });
});
