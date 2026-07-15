/**
 * Bounded provider transports for DeepSeek's OpenAI-compatible API and the
 * native Gemini GenerateContent API.
 *
 * Product code owns prompts, release decisions, retries, and domain schema
 * validation. This module owns endpoint/auth transport plus the deliberately
 * small request/response compatibility boundary used by those product flows.
 * Raw Gemini payloads, API keys, and thinking content never leave this module.
 */

export type ChatCompletionPayload = Record<string, unknown>;

export const CHAT_COMPLETION_MAX_RESPONSE_BYTES = 512 * 1024;

// V1 model changes are code releases and require evaluator/worksheet gold-set
// revalidation; environment variables must not override these role bindings.
export const DEEPSEEK_V1_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_V1_PRO_MODEL = "deepseek-v4-pro";

// Secondary roles are deliberately code-pinned. Changing any identifier is a
// release change and requires the full evaluator/worksheet gold-set bake-off.
export const GEMINI_V1_ANSWER_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_V1_CRITIC_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_V1_STRONG_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_GENERATE_CONTENT_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

const GEMINI_GENERATE_CONTENT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_MAX_REQUEST_BYTES = 1024 * 1024;
const GEMINI_MAX_OUTPUT_TOKENS = 16_384;

export type DeepSeekV1ModelRole = "flash" | "pro";
export type GeminiV1ModelRole = "answer" | "critic" | "strong";
export type GeminiV1Model =
  | typeof GEMINI_V1_ANSWER_MODEL
  | typeof GEMINI_V1_CRITIC_MODEL
  | typeof GEMINI_V1_STRONG_MODEL;

type GeminiV1ModelByRole = {
  answer: typeof GEMINI_V1_ANSWER_MODEL;
  critic: typeof GEMINI_V1_CRITIC_MODEL;
  strong: typeof GEMINI_V1_STRONG_MODEL;
};

export type ChatCompletionResponseFailureKind =
  | "timeout"
  | "insufficient_system_resource"
  | "output_truncated"
  | "response_too_large"
  | "invalid_body"
  | "redirect_rejected";

export interface ChatCompletionProvider {
  readonly providerName: string;
  readonly endpoint: string;
  complete(
    payload: ChatCompletionPayload,
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
}

export type GeminiSecondaryProvider = Readonly<{
  answerModel: typeof GEMINI_V1_ANSWER_MODEL;
  criticModel: typeof GEMINI_V1_CRITIC_MODEL;
  strongModel: typeof GEMINI_V1_STRONG_MODEL;
  provider: ChatCompletionProvider;
}>;

export class ChatCompletionProviderConfigurationError extends Error {
  readonly safeCode = "chat_provider_configuration_invalid";

  constructor() {
    super("Chat-completion provider configuration is invalid.");
    this.name = "ChatCompletionProviderConfigurationError";
  }
}

export class DeepSeekV1ModelRoleError extends Error {
  readonly safeCode = "chat_provider_model_not_pinned";
  readonly retryable = false;

  constructor() {
    super("The configured DeepSeek model does not match its V1 role.");
    this.name = "DeepSeekV1ModelRoleError";
  }
}

export class GeminiV1ModelRoleError extends Error {
  readonly safeCode = "chat_provider_model_not_pinned";
  readonly retryable = false;

  constructor() {
    super("The configured Gemini model does not match its V1 role.");
    this.name = "GeminiV1ModelRoleError";
  }
}

export function requireDeepSeekV1ModelRole(
  model: string,
  role: DeepSeekV1ModelRole,
) {
  const expected =
    role === "flash" ? DEEPSEEK_V1_FLASH_MODEL : DEEPSEEK_V1_PRO_MODEL;
  if (model !== expected) throw new DeepSeekV1ModelRoleError();
  return expected;
}

export function requireGeminiV1ModelRole<R extends GeminiV1ModelRole>(
  model: string,
  role: R,
): GeminiV1ModelByRole[R] {
  const expected = {
    answer: GEMINI_V1_ANSWER_MODEL,
    critic: GEMINI_V1_CRITIC_MODEL,
    strong: GEMINI_V1_STRONG_MODEL,
  }[role];
  if (model !== expected) throw new GeminiV1ModelRoleError();
  return expected as GeminiV1ModelByRole[R];
}

const responseFailureCodes: Record<ChatCompletionResponseFailureKind, string> =
  {
    timeout: "chat_provider_timeout",
    insufficient_system_resource: "chat_provider_insufficient_system_resource",
    output_truncated: "chat_provider_output_truncated",
    response_too_large: "chat_provider_response_too_large",
    invalid_body: "chat_provider_response_invalid",
    redirect_rejected: "chat_provider_redirect_rejected",
  };

/**
 * Stable transport/body failure emitted before any domain-specific parsing.
 * Raw provider bodies and transport errors are deliberately not retained.
 */
export class ChatCompletionProviderResponseError extends Error {
  readonly kind: ChatCompletionResponseFailureKind;
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(kind: ChatCompletionResponseFailureKind) {
    super("Chat-completion provider response could not be consumed safely.");
    this.name = "ChatCompletionProviderResponseError";
    this.kind = kind;
    this.safeCode = responseFailureCodes[kind];
    this.retryable = kind !== "redirect_rejected";
  }
}

function isRedirectResponse(response: Response) {
  return (
    response.redirected || (response.status >= 300 && response.status < 400)
  );
}

export function assertChatCompletionResponseNotRedirected(response: Response) {
  if (isRedirectResponse(response)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ChatCompletionProviderResponseError("redirect_rejected");
  }
}

function timeoutFailure() {
  return new ChatCompletionProviderResponseError("timeout");
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  if (!signal) return await reader.read();
  if (signal.aborted) throw timeoutFailure();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(timeoutFailure());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Consume a provider response without ever materializing more than maxBytes.
 * The caller's signal remains authoritative for both headers and every body
 * chunk. JSON parsing happens only after the bounded UTF-8 body is complete.
 */
export async function readBoundedChatCompletionJson(
  response: Response,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<unknown> {
  assertChatCompletionResponseNotRedirected(response);
  const maxBytes = options.maxBytes ?? CHAT_COMPLETION_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (response.bodyUsed || !response.body) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      void response.body.cancel().catch(() => undefined);
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
    if (Number(contentLength) > maxBytes) {
      void response.body.cancel().catch(() => undefined);
      throw new ChatCompletionProviderResponseError("response_too_large");
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, options.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new ChatCompletionProviderResponseError("invalid_body");
      }
      if (value.byteLength > maxBytes - totalBytes) {
        throw new ChatCompletionProviderResponseError("response_too_large");
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }

    if (totalBytes === 0) {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ChatCompletionProviderResponseError) throw error;
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw timeoutFailure();
    }
    throw new ChatCompletionProviderResponseError("invalid_body");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read can remain pending until cancellation settles.
    }
  }
}

function validatedChatCompletionEnvelope(
  value: unknown,
  expectedModel: string,
) {
  if (!expectedModel || expectedModel.length > 100) {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.model !== expectedModel) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const choice = envelope.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const choiceRecord = choice as Record<string, unknown>;
  if (choiceRecord.finish_reason === "insufficient_system_resource") {
    throw new ChatCompletionProviderResponseError(
      "insufficient_system_resource",
    );
  }
  if (choiceRecord.finish_reason === "length") {
    throw new ChatCompletionProviderResponseError("output_truncated");
  }
  if (choiceRecord.finish_reason !== "stop") {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const message = choiceRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  return { content, envelope };
}

export type ChatCompletionResponseMetadata = Readonly<{
  content: string;
  providerModelVersion: string;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    thinkingTokens: number;
    cachedInputTokens: number | null;
    uncachedInputTokens: number | null;
  }>;
}>;

function responseMetadataCount(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  return value as number;
}

/**
 * Validate a complete normalized provider envelope including the exact model
 * version and token accounting required by the server-side spend ledger.
 */
export function validateChatCompletionResponseEnvelopeWithMetadata(
  value: unknown,
  expectedModel: string,
): ChatCompletionResponseMetadata {
  const { content, envelope } = validatedChatCompletionEnvelope(
    value,
    expectedModel,
  );
  const providerModelVersion =
    envelope.provider_model_version ?? envelope.model;
  if (
    typeof providerModelVersion !== "string" ||
    !providerModelVersion ||
    providerModelVersion.length > 100
  ) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  // If a provider supplies an explicit version separate from the normalized
  // role identifier, it must still be the pinned model used by this release.
  if (
    envelope.provider_model_version !== undefined &&
    providerModelVersion !== expectedModel
  ) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }

  if (
    !envelope.usage ||
    typeof envelope.usage !== "object" ||
    Array.isArray(envelope.usage)
  ) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  const usage = envelope.usage as Record<string, unknown>;
  const inputTokens = responseMetadataCount(usage.prompt_tokens);
  const outputTokens = responseMetadataCount(usage.completion_tokens);
  const totalTokens = responseMetadataCount(usage.total_tokens);

  const promptDetails = usage.prompt_tokens_details;
  const hasCacheHit = usage.prompt_cache_hit_tokens !== undefined;
  const hasCacheMiss = usage.prompt_cache_miss_tokens !== undefined;
  let cachedInputTokens: number | null = null;
  let uncachedInputTokens: number | null = null;
  if (promptDetails !== undefined) {
    if (!isPlainRecord(promptDetails)) {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
    cachedInputTokens = responseMetadataCount(promptDetails.cached_tokens);
    uncachedInputTokens = inputTokens - cachedInputTokens;
    const legacyCacheHitTokens = hasCacheHit
      ? responseMetadataCount(usage.prompt_cache_hit_tokens)
      : null;
    const legacyCacheMissTokens = hasCacheMiss
      ? responseMetadataCount(usage.prompt_cache_miss_tokens)
      : null;
    if (
      (legacyCacheHitTokens !== null &&
        legacyCacheHitTokens !== cachedInputTokens) ||
      (legacyCacheMissTokens !== null &&
        legacyCacheMissTokens !== uncachedInputTokens)
    ) {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
  } else if (hasCacheHit || hasCacheMiss) {
    const cacheHitTokens = hasCacheHit
      ? responseMetadataCount(usage.prompt_cache_hit_tokens)
      : null;
    const cacheMissTokens = hasCacheMiss
      ? responseMetadataCount(usage.prompt_cache_miss_tokens)
      : null;
    cachedInputTokens = cacheHitTokens ?? inputTokens - cacheMissTokens!;
    uncachedInputTokens = cacheMissTokens ?? inputTokens - cacheHitTokens!;
    if (
      cachedInputTokens < 0 ||
      uncachedInputTokens < 0 ||
      cachedInputTokens + uncachedInputTokens !== inputTokens
    ) {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
  }

  const completionDetails = usage.completion_tokens_details;
  let thinkingTokens = 0;
  if (completionDetails !== undefined) {
    if (!isPlainRecord(completionDetails)) {
      throw new ChatCompletionProviderResponseError("invalid_body");
    }
    thinkingTokens =
      completionDetails.reasoning_tokens === undefined
        ? 0
        : responseMetadataCount(completionDetails.reasoning_tokens);
  }
  const minimumTotal = inputTokens + outputTokens;
  if (
    !Number.isSafeInteger(minimumTotal) ||
    (cachedInputTokens !== null && cachedInputTokens > inputTokens) ||
    (uncachedInputTokens !== null && uncachedInputTokens > inputTokens) ||
    thinkingTokens > outputTokens ||
    totalTokens < minimumTotal
  ) {
    throw new ChatCompletionProviderResponseError("invalid_body");
  }
  return {
    content,
    providerModelVersion,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      thinkingTokens,
      cachedInputTokens,
      uncachedInputTokens,
    },
  };
}

/**
 * Compatibility helper for callers that do not yet finalize provider usage.
 * New metered paths should use the metadata variant above.
 */
export function validateChatCompletionResponseEnvelope(
  value: unknown,
  expectedModel: string,
) {
  return validatedChatCompletionEnvelope(value, expectedModel).content;
}

function safeProviderName(value: string | null | undefined) {
  const name = (value ?? "deepseek").trim().toLowerCase();
  if (!name || name.length > 40 || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return name;
}

function chatCompletionEndpoint(value: string | null | undefined) {
  const raw = (value ?? "https://api.deepseek.com").trim();
  let base: URL;
  try {
    base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  } catch {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return new URL("chat/completions", base).toString();
}

export function createOpenAiCompatibleChatProvider(args: {
  apiKey: string;
  providerName?: string | null;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): ChatCompletionProvider {
  const apiKey = args.apiKey.trim();
  if (!apiKey || apiKey.length > 500) {
    throw new ChatCompletionProviderConfigurationError();
  }
  const providerName = safeProviderName(args.providerName);
  const endpoint = chatCompletionEndpoint(args.baseUrl);
  const fetchImpl = args.fetchImpl ?? fetch;

  return Object.freeze({
    providerName,
    endpoint,
    async complete(
      payload: ChatCompletionPayload,
      options: { signal?: AbortSignal } = {},
    ) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ChatCompletionProviderConfigurationError();
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      assertChatCompletionResponseNotRedirected(response);
      return response;
    },
  });
}

type JsonRecord = Record<string, unknown>;
type GeminiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

const geminiPayloadKeys = new Set([
  "model",
  "messages",
  "response_format",
  "reasoning_effort",
  "thinking",
  "max_completion_tokens",
  "max_tokens",
  "temperature",
  "store",
  "stream",
]);

function isPlainRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value: unknown): asserts value is JsonRecord {
  if (!isPlainRecord(value)) {
    throw new ChatCompletionProviderConfigurationError();
  }
}

function assertExactKeys(value: JsonRecord, allowed: ReadonlySet<string>) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ChatCompletionProviderConfigurationError();
    }
  }
}

function assertJsonValue(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 50_000 || depth > 80) {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ChatCompletionProviderConfigurationError();
    }
    return;
  }
  if (!value || typeof value !== "object") {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (state.seen.has(value)) {
    throw new ChatCompletionProviderConfigurationError();
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, state, depth + 1);
  } else {
    assertPlainRecord(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new ChatCompletionProviderConfigurationError();
      }
      assertJsonValue(value[key], state, depth + 1);
    }
  }
  state.seen.delete(value);
}

const geminiJsonSchemaKeys = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "format",
  // These OpenAI-schema constraints are handled explicitly below because the
  // native Gemini subset does not currently accept them.
  "anyOf",
  "pattern",
  "minLength",
  "maxLength",
]);
const geminiJsonSchemaTypes = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

function geminiSchemaInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return value as number;
}

function normalizeGeminiJsonSchema(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
  depth = 0,
): JsonRecord {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 60) {
    throw new ChatCompletionProviderConfigurationError();
  }
  assertPlainRecord(value);
  if (state.seen.has(value)) {
    throw new ChatCompletionProviderConfigurationError();
  }
  state.seen.add(value);
  try {
    assertExactKeys(value, geminiJsonSchemaKeys);

    if (value.anyOf !== undefined) {
      if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) {
        throw new ChatCompletionProviderConfigurationError();
      }
      const nullBranches = value.anyOf.filter(
        (branch) =>
          isPlainRecord(branch) &&
          branch.type === "null" &&
          Reflect.ownKeys(branch).length === 1,
      );
      const valueBranches = value.anyOf.filter(
        (branch) =>
          !(
            isPlainRecord(branch) &&
            branch.type === "null" &&
            Reflect.ownKeys(branch).length === 1
          ),
      );
      if (nullBranches.length !== 1 || valueBranches.length !== 1) {
        throw new ChatCompletionProviderConfigurationError();
      }
      const wrapperKeys = Reflect.ownKeys(value).filter(
        (key) => key !== "anyOf" && key !== "title" && key !== "description",
      );
      if (wrapperKeys.length !== 0) {
        throw new ChatCompletionProviderConfigurationError();
      }
      const normalized = normalizeGeminiJsonSchema(
        valueBranches[0],
        state,
        depth + 1,
      );
      if (typeof normalized.type !== "string" || normalized.type === "null") {
        throw new ChatCompletionProviderConfigurationError();
      }
      const result: JsonRecord = {
        ...normalized,
        type: [normalized.type, "null"],
      };
      if (typeof value.title === "string" && value.title) {
        result.title = value.title;
      } else if (value.title !== undefined) {
        throw new ChatCompletionProviderConfigurationError();
      }
      if (typeof value.description === "string" && value.description) {
        result.description = value.description;
      } else if (value.description !== undefined) {
        throw new ChatCompletionProviderConfigurationError();
      }
      return result;
    }

    const result: JsonRecord = {};
    const rawType = value.type;
    if (typeof rawType !== "string" || !geminiJsonSchemaTypes.has(rawType)) {
      throw new ChatCompletionProviderConfigurationError();
    }
    result.type = rawType;

    for (const key of ["title", "description"] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== "string" || !value[key]) {
          throw new ChatCompletionProviderConfigurationError();
        }
        result[key] = value[key];
      }
    }
    if (value.format !== undefined) {
      if (
        typeof value.format !== "string" ||
        !["date-time", "date", "time"].includes(value.format)
      ) {
        throw new ChatCompletionProviderConfigurationError();
      }
      result.format = value.format;
    }

    if (value.enum !== undefined && value.const !== undefined) {
      throw new ChatCompletionProviderConfigurationError();
    }
    const rawEnum = value.const !== undefined ? [value.const] : value.enum;
    if (rawEnum !== undefined) {
      if (
        !Array.isArray(rawEnum) ||
        rawEnum.length < 1 ||
        rawEnum.length > 500
      ) {
        throw new ChatCompletionProviderConfigurationError();
      }
      assertJsonValue(rawEnum, { seen: new WeakSet(), nodes: 0 });
      result.enum = rawEnum;
    }

    if (value.properties !== undefined) {
      if (rawType !== "object") {
        throw new ChatCompletionProviderConfigurationError();
      }
      assertPlainRecord(value.properties);
      if (Reflect.ownKeys(value.properties).length > 500) {
        throw new ChatCompletionProviderConfigurationError();
      }
      const properties: JsonRecord = {};
      for (const key of Reflect.ownKeys(value.properties)) {
        if (
          typeof key !== "string" ||
          !key ||
          key.length > 128 ||
          typeof value.properties[key] === "undefined"
        ) {
          throw new ChatCompletionProviderConfigurationError();
        }
        properties[key] = normalizeGeminiJsonSchema(
          value.properties[key],
          state,
          depth + 1,
        );
      }
      result.properties = properties;
    }
    if (value.required !== undefined) {
      if (
        rawType !== "object" ||
        !Array.isArray(value.required) ||
        value.required.some((item) => typeof item !== "string" || !item) ||
        new Set(value.required).size !== value.required.length
      ) {
        throw new ChatCompletionProviderConfigurationError();
      }
      result.required = [...value.required];
    }
    if (value.additionalProperties !== undefined) {
      if (rawType !== "object") {
        throw new ChatCompletionProviderConfigurationError();
      }
      if (typeof value.additionalProperties === "boolean") {
        result.additionalProperties = value.additionalProperties;
      } else {
        result.additionalProperties = normalizeGeminiJsonSchema(
          value.additionalProperties,
          state,
          depth + 1,
        );
      }
    }
    if (value.items !== undefined) {
      if (rawType !== "array") {
        throw new ChatCompletionProviderConfigurationError();
      }
      result.items = normalizeGeminiJsonSchema(value.items, state, depth + 1);
    }
    if (value.prefixItems !== undefined) {
      if (rawType !== "array" || !Array.isArray(value.prefixItems)) {
        throw new ChatCompletionProviderConfigurationError();
      }
      result.prefixItems = value.prefixItems.map((item) =>
        normalizeGeminiJsonSchema(item, state, depth + 1),
      );
    }
    for (const key of ["minItems", "maxItems"] as const) {
      if (value[key] !== undefined) {
        if (rawType !== "array") {
          throw new ChatCompletionProviderConfigurationError();
        }
        result[key] = geminiSchemaInteger(value[key]);
      }
    }
    if (
      typeof result.minItems === "number" &&
      typeof result.maxItems === "number" &&
      result.minItems > result.maxItems
    ) {
      throw new ChatCompletionProviderConfigurationError();
    }
    for (const key of ["minimum", "maximum"] as const) {
      if (value[key] !== undefined) {
        if (
          (rawType !== "number" && rawType !== "integer") ||
          typeof value[key] !== "number" ||
          !Number.isFinite(value[key])
        ) {
          throw new ChatCompletionProviderConfigurationError();
        }
        result[key] = value[key];
      }
    }
    if (
      typeof result.minimum === "number" &&
      typeof result.maximum === "number" &&
      result.minimum > result.maximum
    ) {
      throw new ChatCompletionProviderConfigurationError();
    }

    // Gemini does not accept these OpenAI JSON-Schema constraints. Validate
    // their input shape, then rely on the existing deterministic domain parser
    // for the same limits after generation.
    if (value.pattern !== undefined && typeof value.pattern !== "string") {
      throw new ChatCompletionProviderConfigurationError();
    }
    for (const key of ["minLength", "maxLength"] as const) {
      if (value[key] !== undefined) geminiSchemaInteger(value[key]);
    }
    if (
      typeof value.minLength === "number" &&
      typeof value.maxLength === "number" &&
      value.minLength > value.maxLength
    ) {
      throw new ChatCompletionProviderConfigurationError();
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function pinnedGeminiModel(value: unknown): GeminiV1Model {
  if (
    value === GEMINI_V1_ANSWER_MODEL ||
    value === GEMINI_V1_CRITIC_MODEL ||
    value === GEMINI_V1_STRONG_MODEL
  ) {
    return value;
  }
  throw new GeminiV1ModelRoleError();
}

function geminiMaxOutputTokens(payload: JsonRecord) {
  const hasCompletionTokens = Reflect.has(payload, "max_completion_tokens");
  const hasTokens = Reflect.has(payload, "max_tokens");
  if (hasCompletionTokens === hasTokens) {
    throw new ChatCompletionProviderConfigurationError();
  }
  const value = hasCompletionTokens
    ? payload.max_completion_tokens
    : payload.max_tokens;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GEMINI_MAX_OUTPUT_TOKENS
  ) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return value as number;
}

function geminiMessages(payload: JsonRecord) {
  if (!Array.isArray(payload.messages) || payload.messages.length < 1) {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (payload.messages.length > 32) {
    throw new ChatCompletionProviderConfigurationError();
  }

  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }> = [];
  let totalTextLength = 0;

  for (const [index, rawMessage] of payload.messages.entries()) {
    assertPlainRecord(rawMessage);
    assertExactKeys(rawMessage, new Set(["role", "content"]));
    if (typeof rawMessage.content !== "string" || !rawMessage.content.trim()) {
      throw new ChatCompletionProviderConfigurationError();
    }
    totalTextLength += rawMessage.content.length;
    if (totalTextLength > 750_000) {
      throw new ChatCompletionProviderConfigurationError();
    }

    if (rawMessage.role === "system") {
      if (index !== 0 || systemInstruction) {
        throw new ChatCompletionProviderConfigurationError();
      }
      systemInstruction = { parts: [{ text: rawMessage.content }] };
      continue;
    }
    if (rawMessage.role !== "user" && rawMessage.role !== "assistant") {
      throw new ChatCompletionProviderConfigurationError();
    }
    contents.push({
      role: rawMessage.role === "assistant" ? "model" : "user",
      parts: [{ text: rawMessage.content }],
    });
  }

  if (!systemInstruction || contents.length < 1) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return { systemInstruction, contents };
}

function geminiResponseFormat(value: unknown) {
  assertPlainRecord(value);
  if (value.type === "json_object") {
    assertExactKeys(value, new Set(["type"]));
    return { responseMimeType: "application/json" };
  }
  if (value.type !== "json_schema") {
    throw new ChatCompletionProviderConfigurationError();
  }
  assertExactKeys(value, new Set(["type", "json_schema"]));
  assertPlainRecord(value.json_schema);
  assertExactKeys(value.json_schema, new Set(["name", "strict", "schema"]));
  if (
    typeof value.json_schema.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.json_schema.name) ||
    value.json_schema.strict !== true ||
    !isPlainRecord(value.json_schema.schema)
  ) {
    throw new ChatCompletionProviderConfigurationError();
  }
  const responseJsonSchema = normalizeGeminiJsonSchema(
    value.json_schema.schema,
    {
      seen: new WeakSet(),
      nodes: 0,
    },
  );
  return {
    responseMimeType: "application/json",
    responseJsonSchema,
  };
}

function geminiReasoningEffort(payload: JsonRecord): GeminiReasoningEffort {
  const rawEffort = payload.reasoning_effort;
  let effort: GeminiReasoningEffort | undefined;
  if (rawEffort !== undefined) {
    if (
      rawEffort !== "none" &&
      rawEffort !== "minimal" &&
      rawEffort !== "low" &&
      rawEffort !== "medium" &&
      rawEffort !== "high"
    ) {
      throw new ChatCompletionProviderConfigurationError();
    }
    effort = rawEffort;
  }

  if (payload.thinking !== undefined) {
    assertPlainRecord(payload.thinking);
    assertExactKeys(payload.thinking, new Set(["type"]));
    if (
      payload.thinking.type !== "disabled" &&
      payload.thinking.type !== "enabled"
    ) {
      throw new ChatCompletionProviderConfigurationError();
    }
    const thinkingEffort: GeminiReasoningEffort =
      payload.thinking.type === "disabled" ? "none" : "high";
    const compatible =
      effort === undefined ||
      effort === thinkingEffort ||
      (thinkingEffort === "none" && effort === "minimal") ||
      (thinkingEffort === "high" && effort === "medium");
    if (!compatible) throw new ChatCompletionProviderConfigurationError();
    effort ??= thinkingEffort;
  }

  if (!effort) throw new ChatCompletionProviderConfigurationError();
  return effort;
}

function geminiThinkingConfig(
  model: GeminiV1Model,
  effort: GeminiReasoningEffort,
) {
  if (model === GEMINI_V1_ANSWER_MODEL) {
    const thinkingLevel =
      effort === "none" || effort === "minimal" ? "low" : effort;
    return { includeThoughts: false, thinkingLevel };
  }
  const thinkingLevel = effort === "none" ? "minimal" : effort;
  return { includeThoughts: false, thinkingLevel };
}

function toNativeGeminiPayload(payload: ChatCompletionPayload) {
  assertPlainRecord(payload);
  assertExactKeys(payload, geminiPayloadKeys);
  const model = pinnedGeminiModel(payload.model);
  if (payload.stream !== undefined && payload.stream !== false) {
    throw new ChatCompletionProviderConfigurationError();
  }
  if (payload.store !== undefined && payload.store !== false) {
    throw new ChatCompletionProviderConfigurationError();
  }
  const { systemInstruction, contents } = geminiMessages(payload);
  const generationConfig: JsonRecord = {
    candidateCount: 1,
    ...geminiResponseFormat(payload.response_format),
    maxOutputTokens: geminiMaxOutputTokens(payload),
    thinkingConfig: geminiThinkingConfig(model, geminiReasoningEffort(payload)),
  };

  if (payload.temperature !== undefined) {
    // Gemini 3.x uses model-calibrated sampling for all pinned V1 roles.
    throw new ChatCompletionProviderConfigurationError();
  }

  const nativePayload = { systemInstruction, contents, generationConfig };
  const serialized = JSON.stringify(nativePayload);
  if (
    new TextEncoder().encode(serialized).byteLength > GEMINI_MAX_REQUEST_BYTES
  ) {
    throw new ChatCompletionProviderConfigurationError();
  }
  return { model, nativePayload, serialized };
}

function responseFailure(): never {
  throw new ChatCompletionProviderResponseError("invalid_body");
}

function responseRecord(value: unknown): JsonRecord {
  if (!isPlainRecord(value)) responseFailure();
  return value;
}

function usageCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) responseFailure();
  return value as number;
}

function validGeminiThoughtSignature(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  try {
    // Protobuf `bytes` fields use canonical padded base64 in JSON. Round-trip
    // validation also rejects encodings with non-zero discarded bits.
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function normalizedGeminiResponse(
  value: unknown,
  expectedModel: GeminiV1Model,
) {
  const envelope = responseRecord(value);
  if (envelope.modelVersion !== expectedModel) responseFailure();
  if (isPlainRecord(envelope.promptFeedback)) {
    const blockReason = envelope.promptFeedback.blockReason;
    if (
      blockReason !== undefined &&
      blockReason !== "BLOCK_REASON_UNSPECIFIED"
    ) {
      responseFailure();
    }
  }
  if (!Array.isArray(envelope.candidates) || envelope.candidates.length !== 1) {
    responseFailure();
  }
  const candidate = responseRecord(envelope.candidates[0]);
  if (candidate.finishReason === "MAX_TOKENS") {
    throw new ChatCompletionProviderResponseError("output_truncated");
  }
  if (candidate.finishReason !== "STOP") responseFailure();
  if (candidate.index !== undefined && candidate.index !== 0) responseFailure();
  const content = responseRecord(candidate.content);
  if (content.role !== "model") responseFailure();
  if (!Array.isArray(content.parts) || content.parts.length !== 1) {
    responseFailure();
  }
  const part = responseRecord(content.parts[0]);
  if (
    Reflect.ownKeys(part).some(
      (key) => key !== "text" && key !== "thoughtSignature",
    )
  ) {
    responseFailure();
  }
  if (
    Object.prototype.hasOwnProperty.call(part, "thoughtSignature") &&
    !validGeminiThoughtSignature(part.thoughtSignature)
  ) {
    responseFailure();
  }
  if (typeof part.text !== "string" || !part.text.trim()) responseFailure();
  try {
    const parsed = JSON.parse(part.text);
    if (!isPlainRecord(parsed)) responseFailure();
  } catch (error) {
    if (error instanceof ChatCompletionProviderResponseError) throw error;
    responseFailure();
  }

  const usageMetadata = responseRecord(envelope.usageMetadata);
  const promptTokens = usageCount(usageMetadata.promptTokenCount);
  const candidateTokens = usageCount(usageMetadata.candidatesTokenCount);
  const totalTokens = usageCount(usageMetadata.totalTokenCount);
  const cachedInputTokens =
    usageMetadata.cachedContentTokenCount === undefined
      ? null
      : usageCount(usageMetadata.cachedContentTokenCount);
  const thinkingTokens =
    usageMetadata.thoughtsTokenCount === undefined
      ? 0
      : usageCount(usageMetadata.thoughtsTokenCount);
  const completionTokens = candidateTokens + thinkingTokens;
  if (
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(promptTokens + completionTokens) ||
    (cachedInputTokens !== null && cachedInputTokens > promptTokens) ||
    totalTokens < promptTokens + completionTokens
  ) {
    responseFailure();
  }
  const usage: JsonRecord = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    completion_tokens_details: {
      reasoning_tokens: thinkingTokens,
    },
  };
  // Gemini omits cachedContentTokenCount when it has no cache evidence. Keep
  // that absence distinct from an explicit provider-reported zero so the
  // spend ledger can conservatively finalize null/null as a full cache miss.
  if (cachedInputTokens !== null) {
    usage.prompt_tokens_details = { cached_tokens: cachedInputTokens };
  }

  return {
    object: "chat.completion",
    model: expectedModel,
    provider_model_version: envelope.modelVersion,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: part.text },
      },
    ],
    usage,
  };
}

/**
 * Native Gemini transport with an intentionally narrow OpenAI-style input and
 * output envelope. This lets domain code migrate incrementally while keeping
 * authentication, model provenance, structured output, and safety semantics
 * native to Gemini rather than relying on a beta compatibility endpoint.
 */
export function createNativeGeminiChatProvider(args: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ChatCompletionProvider {
  const apiKey = args.apiKey.trim();
  if (!apiKey || apiKey.length > 500) {
    throw new ChatCompletionProviderConfigurationError();
  }
  const fetchImpl = args.fetchImpl ?? fetch;

  return Object.freeze({
    providerName: "gemini",
    endpoint: GEMINI_GENERATE_CONTENT_ENDPOINT,
    async complete(
      payload: ChatCompletionPayload,
      options: { signal?: AbortSignal } = {},
    ) {
      const { model, serialized } = toNativeGeminiPayload(payload);
      const endpoint = `${GEMINI_GENERATE_CONTENT_BASE_URL}${model}:generateContent`;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: serialized,
        signal: options.signal,
      });
      assertChatCompletionResponseNotRedirected(response);
      if (!response.ok) return response;

      const nativeJson = await readBoundedChatCompletionJson(response, {
        signal: options.signal,
        maxBytes: CHAT_COMPLETION_MAX_RESPONSE_BYTES,
      });
      const normalized = normalizedGeminiResponse(nativeJson, model);
      const body = JSON.stringify(normalized);
      if (
        new TextEncoder().encode(body).byteLength >
        CHAT_COMPLETION_MAX_RESPONSE_BYTES
      ) {
        throw new ChatCompletionProviderResponseError("response_too_large");
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

/**
 * Build the optional Gemini secondary bundle. The secret stays only inside the
 * request closure, and absence preserves the caller's explicit hold behavior.
 */
export function createOptionalGeminiSecondaryProvider(args: {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}): GeminiSecondaryProvider | null {
  const apiKey = args.apiKey?.trim();
  if (!apiKey) return null;
  return Object.freeze({
    answerModel: GEMINI_V1_ANSWER_MODEL,
    criticModel: GEMINI_V1_CRITIC_MODEL,
    strongModel: GEMINI_V1_STRONG_MODEL,
    provider: createNativeGeminiChatProvider({
      apiKey,
      fetchImpl: args.fetchImpl,
    }),
  });
}
