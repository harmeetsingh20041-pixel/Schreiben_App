import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ChatCompletionProviderConfigurationError,
  ChatCompletionProviderResponseError,
  createNativeGeminiChatProvider,
  createOpenAiCompatibleChatProvider,
  createOptionalGeminiSecondaryProvider,
  DeepSeekV1ModelRoleError,
  GEMINI_V1_ANSWER_MODEL,
  GEMINI_V1_CRITIC_MODEL,
  GEMINI_V1_STRONG_MODEL,
  GeminiV1ModelRoleError,
  readBoundedChatCompletionJson,
  requireDeepSeekV1ModelRole,
  requireGeminiV1ModelRole,
  validateChatCompletionResponseEnvelope,
  validateChatCompletionResponseEnvelopeWithMetadata,
} from "./chat-completion-provider.ts";

Deno.test(
  "provider boundary sends an OpenAI-compatible request without changing its payload",
  async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = createOpenAiCompatibleChatProvider({
      apiKey: "secret-test-key",
      providerName: "deepseek",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response('{"choices":[]}', { status: 200 });
      },
    });

    await provider.complete({ model: "deepseek-v4-flash", stream: false });

    assertEquals(provider.providerName, "deepseek");
    assertEquals(requestUrl, "https://api.deepseek.com/chat/completions");
    assertEquals(requestInit?.method, "POST");
    assertEquals(requestInit?.redirect, "error");
    assertEquals(
      (requestInit?.headers as Record<string, string>).Authorization,
      "Bearer secret-test-key",
    );
    assertEquals(JSON.parse(String(requestInit?.body)), {
      model: "deepseek-v4-flash",
      stream: false,
    });
  },
);

Deno.test(
  "provider boundary supports a replaceable compatible base path",
  async () => {
    let requestUrl = "";
    const provider = createOpenAiCompatibleChatProvider({
      apiKey: "another-key",
      providerName: "compatible_provider",
      baseUrl: "https://models.example.test/v1",
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return new Response("{}", { status: 200 });
      },
    });

    await provider.complete({ model: "model-id" });
    assertEquals(requestUrl, "https://models.example.test/v1/chat/completions");
  },
);

Deno.test(
  "provider boundary rejects insecure or credential-bearing endpoints",
  () => {
    for (const baseUrl of [
      "http://api.example.test/v1",
      "https://user:password@api.example.test/v1",
      "https://api.example.test/v1?tenant=secret",
    ]) {
      assertThrows(
        () => createOpenAiCompatibleChatProvider({ apiKey: "key", baseUrl }),
        ChatCompletionProviderConfigurationError,
      );
    }
  },
);

Deno.test(
  "provider boundary rejects malformed payloads before transport",
  async () => {
    const provider = createOpenAiCompatibleChatProvider({
      apiKey: "key",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    await assertRejects(
      async () => provider.complete([] as unknown as Record<string, unknown>),
      ChatCompletionProviderConfigurationError,
    );
  },
);

Deno.test(
  "provider boundary refuses redirect responses without forwarding credentials",
  async () => {
    const provider = createOpenAiCompatibleChatProvider({
      apiKey: "key",
      fetchImpl: async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://redirect.example.test/collect" },
        }),
    });

    try {
      await provider.complete({ model: "model-id" });
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "redirect_rejected");
      assertEquals(error.retryable, false);
      return;
    }
    throw new Error("Redirecting provider response was unexpectedly accepted.");
  },
);

Deno.test(
  "bounded reader preserves an ordinary valid provider body",
  async () => {
    const body = await readBoundedChatCompletionJson(
      Response.json({ choices: [{ message: { content: "{}" } }] }),
      { maxBytes: 1_024 },
    );
    assertEquals(body, { choices: [{ message: { content: "{}" } }] });
  },
);

Deno.test(
  "bounded reader rejects chunked bytes before an unbounded body is allocated",
  async () => {
    const chunks = [
      new TextEncoder().encode('{"padding":"'),
      new TextEncoder().encode("x".repeat(64)),
      new TextEncoder().encode('"}'),
    ];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }),
    );

    await assertRejects(
      () => readBoundedChatCompletionJson(response, { maxBytes: 32 }),
      ChatCompletionProviderResponseError,
    );
  },
);

Deno.test(
  "bounded reader maps malformed JSON to a stable retryable failure",
  async () => {
    try {
      await readBoundedChatCompletionJson(new Response("not-json"));
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "invalid_body");
      assertEquals(error.safeCode, "chat_provider_response_invalid");
      assertEquals(error.retryable, true);
      return;
    }
    throw new Error("Malformed provider JSON was unexpectedly accepted.");
  },
);

Deno.test(
  "bounded reader cancels a body that never completes after headers",
  async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('{"choices":['));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    setTimeout(() => controller.abort(), 10);

    try {
      await readBoundedChatCompletionJson(response, {
        signal: controller.signal,
        maxBytes: 1_024,
      });
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "timeout");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(cancelled, true);
      return;
    }
    throw new Error("Stalled provider body was unexpectedly accepted.");
  },
);

Deno.test(
  "response envelope accepts one complete choice from the requested model",
  () => {
    assertEquals(
      validateChatCompletionResponseEnvelope(
        {
          model: "deepseek-v4-flash",
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"ok":true}' },
            },
          ],
        },
        "deepseek-v4-flash",
      ),
      '{"ok":true}',
    );
  },
);

Deno.test(
  "response envelope classifies DeepSeek length output as retryable truncation without retaining content",
  () => {
    const privatePartialContent = '{"private_student_text":"nicht speichern"';
    try {
      validateChatCompletionResponseEnvelope(
        {
          model: "deepseek-v4-flash",
          choices: [
            {
              finish_reason: "length",
              message: { content: privatePartialContent },
            },
          ],
        },
        "deepseek-v4-flash",
      );
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "output_truncated");
      assertEquals(error.safeCode, "chat_provider_output_truncated");
      assertEquals(error.retryable, true);
      assertEquals(String(error).includes(privatePartialContent), false);
      return;
    }
    throw new Error("Length-truncated DeepSeek output was accepted.");
  },
);

Deno.test(
  "response envelope rejects incomplete, filtered, ambiguous, or mismatched output",
  () => {
    const validChoice = {
      finish_reason: "stop",
      message: { content: '{"ok":true}' },
    };
    for (const envelope of [
      { model: "deepseek-v4-flash", choices: [] },
      { model: "deepseek-v4-flash", choices: [validChoice, validChoice] },
      {
        model: "deepseek-v4-flash",
        choices: [{ ...validChoice, finish_reason: "content_filter" }],
      },
      {
        model: "deepseek-v4-flash",
        choices: [{ ...validChoice, finish_reason: "tool_calls" }],
      },
      { model: "deepseek-v4-pro", choices: [validChoice] },
    ]) {
      assertThrows(
        () =>
          validateChatCompletionResponseEnvelope(envelope, "deepseek-v4-flash"),
        ChatCompletionProviderResponseError,
      );
    }
  },
);

Deno.test(
  "response envelope classifies DeepSeek resource interruption as retryable availability",
  () => {
    try {
      validateChatCompletionResponseEnvelope(
        {
          model: "deepseek-v4-flash",
          choices: [
            {
              finish_reason: "insufficient_system_resource",
              message: { content: null },
            },
          ],
        },
        "deepseek-v4-flash",
      );
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "insufficient_system_resource");
      assertEquals(
        error.safeCode,
        "chat_provider_insufficient_system_resource",
      );
      assertEquals(error.retryable, true);
      return;
    }
    throw new Error("Resource-interrupted provider output was accepted.");
  },
);

Deno.test(
  "metadata validator accepts documented minimal and cache-aware DeepSeek usage",
  () => {
    const completion = {
      model: "deepseek-v4-flash",
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"ok":true}' },
        },
      ],
    };
    assertEquals(
      validateChatCompletionResponseEnvelopeWithMetadata(
        {
          ...completion,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        },
        "deepseek-v4-flash",
      ),
      {
        content: '{"ok":true}',
        providerModelVersion: "deepseek-v4-flash",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          thinkingTokens: 0,
          cachedInputTokens: null,
          uncachedInputTokens: null,
        },
      },
    );
    assertEquals(
      validateChatCompletionResponseEnvelopeWithMetadata(
        {
          ...completion,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 30,
            prompt_cache_miss_tokens: 70,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
        "deepseek-v4-flash",
      ).usage,
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        thinkingTokens: 5,
        cachedInputTokens: 30,
        uncachedInputTokens: 70,
      },
    );
    assertEquals(
      validateChatCompletionResponseEnvelopeWithMetadata(
        {
          ...completion,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 30 },
            prompt_cache_hit_tokens: 30,
            prompt_cache_miss_tokens: 70,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
        "deepseek-v4-flash",
      ).usage,
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        thinkingTokens: 5,
        cachedInputTokens: 30,
        uncachedInputTokens: 70,
      },
    );
  },
);

Deno.test("V1 model roles allow only their pinned DeepSeek identifiers", () => {
  assertEquals(
    requireDeepSeekV1ModelRole("deepseek-v4-flash", "flash"),
    "deepseek-v4-flash",
  );
  assertEquals(
    requireDeepSeekV1ModelRole("deepseek-v4-pro", "pro"),
    "deepseek-v4-pro",
  );
  assertThrows(
    () => requireDeepSeekV1ModelRole("deepseek-v4-pro", "flash"),
    DeepSeekV1ModelRoleError,
  );
  assertThrows(
    () => requireDeepSeekV1ModelRole("deepseek-chat", "pro"),
    DeepSeekV1ModelRoleError,
  );
});

function geminiPayload(model: string, overrides: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: "Return verified JSON only." },
      { role: "user", content: "Review this German exercise." },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test_contract",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
    reasoning_effort: "low",
    max_completion_tokens: 512,
    store: false,
    stream: false,
    ...overrides,
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) delete payload[key];
  }
  return payload;
}

function nativeGeminiSuccess(
  model: string,
  content = '{"ok":true}',
  overrides: Record<string, unknown> = {},
) {
  return {
    modelVersion: model,
    candidates: [
      {
        index: 0,
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: content }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 21,
      thoughtsTokenCount: 3,
      cachedContentTokenCount: 2,
    },
    ...overrides,
  };
}

Deno.test(
  "Gemini V1 roles allow only the reviewed stable model identifier",
  () => {
    assertEquals(
      requireGeminiV1ModelRole(GEMINI_V1_ANSWER_MODEL, "answer"),
      "gemini-3.1-flash-lite",
    );
    assertEquals(
      requireGeminiV1ModelRole(GEMINI_V1_CRITIC_MODEL, "critic"),
      "gemini-3.1-flash-lite",
    );
    assertEquals(
      requireGeminiV1ModelRole(GEMINI_V1_STRONG_MODEL, "strong"),
      "gemini-3.1-flash-lite",
    );
    assertThrows(
      () => requireGeminiV1ModelRole("gemini-flash-latest", "strong"),
      GeminiV1ModelRoleError,
    );
    assertThrows(
      () => requireGeminiV1ModelRole("gemini-3.5-flash", "critic"),
      GeminiV1ModelRoleError,
    );
    assertEquals(GEMINI_V1_ANSWER_MODEL, GEMINI_V1_CRITIC_MODEL);
    assertEquals(GEMINI_V1_CRITIC_MODEL, GEMINI_V1_STRONG_MODEL);
  },
);

Deno.test(
  "optional Gemini secondary is absent without a secret and exposes all pinned roles with one",
  () => {
    assertEquals(createOptionalGeminiSecondaryProvider({}), null);
    assertEquals(
      createOptionalGeminiSecondaryProvider({ apiKey: "   " }),
      null,
    );
    const secondary = createOptionalGeminiSecondaryProvider({
      apiKey: "gemini-test-key",
    });
    if (!secondary) throw new Error("Secondary provider was not created.");
    assertEquals(secondary.answerModel, GEMINI_V1_ANSWER_MODEL);
    assertEquals(secondary.criticModel, GEMINI_V1_CRITIC_MODEL);
    assertEquals(secondary.strongModel, GEMINI_V1_STRONG_MODEL);
    assertEquals(secondary.provider.providerName, "gemini");
  },
);

Deno.test(
  "native Gemini transport translates the reviewed payload subset and normalizes provenance plus usage",
  async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = createNativeGeminiChatProvider({
      apiKey: "gemini-test-key",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json(nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL));
      },
    });

    const response = await provider.complete(
      geminiPayload(GEMINI_V1_CRITIC_MODEL, {
        messages: [
          { role: "system", content: "System contract." },
          { role: "user", content: "First turn." },
          { role: "assistant", content: '{"draft":true}' },
          { role: "user", content: "Audit the draft." },
        ],
      }),
    );

    assertEquals(
      requestUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    assertEquals(requestInit?.method, "POST");
    assertEquals(requestInit?.redirect, "error");
    const headers = requestInit?.headers as Record<string, string>;
    assertEquals(headers["x-goog-api-key"], "gemini-test-key");
    assertEquals("Authorization" in headers, false);

    const body = JSON.parse(String(requestInit?.body));
    assertEquals(body.systemInstruction, {
      parts: [{ text: "System contract." }],
    });
    assertEquals(body.contents, [
      { role: "user", parts: [{ text: "First turn." }] },
      { role: "model", parts: [{ text: '{"draft":true}' }] },
      { role: "user", parts: [{ text: "Audit the draft." }] },
    ]);
    assertEquals(body.generationConfig, {
      candidateCount: 1,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      maxOutputTokens: 512,
      thinkingConfig: { includeThoughts: false, thinkingLevel: "low" },
    });

    const normalized = await readBoundedChatCompletionJson(response);
    assertEquals(
      validateChatCompletionResponseEnvelopeWithMetadata(
        normalized,
        GEMINI_V1_CRITIC_MODEL,
      ),
      {
        content: '{"ok":true}',
        providerModelVersion: GEMINI_V1_CRITIC_MODEL,
        usage: {
          inputTokens: 11,
          outputTokens: 10,
          totalTokens: 21,
          thinkingTokens: 3,
          cachedInputTokens: 2,
          uncachedInputTokens: 9,
        },
      },
    );
  },
);

Deno.test(
  "Gemini cache evidence distinguishes omitted metadata from an explicit zero",
  async () => {
    for (const [cachedContentTokenCount, expected] of [
      [undefined, { cachedInputTokens: null, uncachedInputTokens: null }],
      [0, { cachedInputTokens: 0, uncachedInputTokens: 11 }],
    ] as const) {
      const usageMetadata: Record<string, unknown> = {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 21,
        thoughtsTokenCount: 3,
      };
      if (cachedContentTokenCount !== undefined) {
        usageMetadata.cachedContentTokenCount = cachedContentTokenCount;
      }
      const provider = createNativeGeminiChatProvider({
        apiKey: "key",
        fetchImpl: async () =>
          Response.json(
            nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, '{"ok":true}', {
              usageMetadata,
            }),
          ),
      });
      const normalized = await readBoundedChatCompletionJson(
        await provider.complete(geminiPayload(GEMINI_V1_CRITIC_MODEL)),
      );
      const metadata = validateChatCompletionResponseEnvelopeWithMetadata(
        normalized,
        GEMINI_V1_CRITIC_MODEL,
      );
      assertEquals(
        metadata.usage.cachedInputTokens,
        expected.cachedInputTokens,
      );
      assertEquals(
        metadata.usage.uncachedInputTokens,
        expected.uncachedInputTokens,
      );
    }
  },
);

Deno.test(
  "native Gemini transport accepts a valid opaque thought signature without returning it",
  async () => {
    const thoughtSignature = "AQIDBAU=";
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () =>
        Response.json(
          nativeGeminiSuccess(GEMINI_V1_STRONG_MODEL, '{"ok":true}', {
            candidates: [
              {
                index: 0,
                finishReason: "STOP",
                content: {
                  role: "model",
                  parts: [{ text: '{"ok":true}', thoughtSignature }],
                },
              },
            ],
          }),
        ),
    });

    const response = await provider.complete(
      geminiPayload(GEMINI_V1_STRONG_MODEL),
    );
    const normalizedText = await response.text();
    const normalized = JSON.parse(normalizedText);

    assertEquals(normalizedText.includes(thoughtSignature), false);
    assertEquals(normalized.choices[0].message, {
      role: "assistant",
      content: '{"ok":true}',
    });
    assertEquals(
      Object.prototype.hasOwnProperty.call(
        normalized.choices[0].message,
        "thoughtSignature",
      ),
      false,
    );
  },
);

Deno.test(
  "native Gemini transport rejects malformed thought signatures and all other part fields",
  async () => {
    const invalidParts: Array<Record<string, unknown>> = [
      { text: '{"ok":true}', thoughtSignature: "" },
      { text: '{"ok":true}', thoughtSignature: 123 },
      { text: '{"ok":true}', thoughtSignature: "not-base64" },
      { text: '{"ok":true}', thoughtSignature: "AB==" },
      { text: '{"ok":true}', thoughtSignature: "AQIDBAU" },
      { text: '{"ok":true}', thoughtSignature: "AQID BAU=" },
      {
        text: '{"ok":true}',
        thoughtSignature: "AQIDBAU=",
        unexpectedMetadata: true,
      },
    ];

    for (const part of invalidParts) {
      const provider = createNativeGeminiChatProvider({
        apiKey: "key",
        fetchImpl: async () =>
          Response.json(
            nativeGeminiSuccess(GEMINI_V1_STRONG_MODEL, '{"ok":true}', {
              candidates: [
                {
                  index: 0,
                  finishReason: "STOP",
                  content: { role: "model", parts: [part] },
                },
              ],
            }),
          ),
      });

      await assertRejects(
        () => provider.complete(geminiPayload(GEMINI_V1_STRONG_MODEL)),
        ChatCompletionProviderResponseError,
      );
    }
  },
);

Deno.test(
  "native Gemini transport maps economical Flash-Lite thinking controls for every pinned role",
  async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const model = url.includes(GEMINI_V1_ANSWER_MODEL)
          ? GEMINI_V1_ANSWER_MODEL
          : GEMINI_V1_STRONG_MODEL;
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json(nativeGeminiSuccess(model));
      },
    });

    await provider.complete(
      geminiPayload(GEMINI_V1_ANSWER_MODEL, {
        reasoning_effort: "none",
      }),
    );
    await provider.complete(
      geminiPayload(GEMINI_V1_STRONG_MODEL, {
        reasoning_effort: "high",
      }),
    );

    assertEquals(
      (requests[0].body.generationConfig as Record<string, unknown>)
        .thinkingConfig,
      { includeThoughts: false, thinkingLevel: "low" },
    );
    assertEquals(
      (requests[1].body.generationConfig as Record<string, unknown>)
        .thinkingConfig,
      { includeThoughts: false, thinkingLevel: "high" },
    );
    assertEquals(
      "temperature" in
        (requests[1].body.generationConfig as Record<string, unknown>),
      false,
    );
  },
);

Deno.test(
  "native Gemini transport converts only the known safe OpenAI JSON-schema differences",
  async () => {
    let requestBody: Record<string, unknown> = {};
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json(nativeGeminiSuccess(GEMINI_V1_ANSWER_MODEL));
      },
    });
    await provider.complete(
      geminiPayload(GEMINI_V1_ANSWER_MODEL, {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer_contract",
            strict: true,
            schema: {
              type: "object",
              properties: {
                score: { type: "number", const: 1 },
                corrected: {
                  anyOf: [
                    {
                      type: "string",
                      pattern: "^[a-z]+$",
                      minLength: 1,
                      maxLength: 100,
                    },
                    { type: "null" },
                  ],
                },
              },
              required: ["score", "corrected"],
              additionalProperties: false,
            },
          },
        },
      }),
    );

    const generationConfig = requestBody.generationConfig as Record<
      string,
      unknown
    >;
    assertEquals(generationConfig.responseJsonSchema, {
      type: "object",
      properties: {
        score: { type: "number", enum: [1] },
        corrected: { type: ["string", "null"] },
      },
      required: ["score", "corrected"],
      additionalProperties: false,
    });
  },
);

Deno.test(
  "native Gemini transport supports JSON-object mode without inventing a schema",
  async () => {
    let requestBody: Record<string, unknown> = {};
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json(nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL));
      },
    });
    await provider.complete(
      geminiPayload(GEMINI_V1_CRITIC_MODEL, {
        response_format: { type: "json_object" },
        reasoning_effort: undefined,
        thinking: { type: "disabled" },
        max_completion_tokens: undefined,
        max_tokens: 200,
      }),
    );
    const generationConfig = requestBody.generationConfig as Record<
      string,
      unknown
    >;
    assertEquals(generationConfig.responseMimeType, "application/json");
    assertEquals("responseJsonSchema" in generationConfig, false);
    assertEquals(generationConfig.thinkingConfig, {
      includeThoughts: false,
      thinkingLevel: "low",
    });
  },
);

Deno.test(
  "native Gemini transport rejects unsupported request fields and unsafe shapes before fetch",
  async () => {
    let fetched = false;
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () => {
        fetched = true;
        return Response.json(nativeGeminiSuccess(GEMINI_V1_STRONG_MODEL));
      },
    });
    const invalidPayloads = [
      geminiPayload(GEMINI_V1_STRONG_MODEL, { stream: true }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, { store: true }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, { tools: [] }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, { temperature: 0.2 }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, {
        max_tokens: 100,
      }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, {
        messages: [{ role: "user", content: "No system instruction." }],
      }),
      geminiPayload(GEMINI_V1_STRONG_MODEL, {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "bad_schema",
            strict: true,
            schema: { type: "object", oneOf: [] },
          },
        },
      }),
    ];
    for (const payload of invalidPayloads) {
      await assertRejects(
        () => provider.complete(payload),
        ChatCompletionProviderConfigurationError,
      );
    }
    assertEquals(fetched, false);
    await assertRejects(
      () => provider.complete(geminiPayload("gemini-flash-latest")),
      GeminiV1ModelRoleError,
    );
  },
);

Deno.test(
  "native Gemini transport preserves non-success HTTP status for domain retry classification",
  async () => {
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    const response = await provider.complete(
      geminiPayload(GEMINI_V1_CRITIC_MODEL),
    );
    assertEquals(response.status, 429);
  },
);

Deno.test(
  "native Gemini transport rejects redirects before a second host can receive its key",
  async () => {
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://collector.example.test" },
        }),
    });
    await assertRejects(
      () => provider.complete(geminiPayload(GEMINI_V1_CRITIC_MODEL)),
      ChatCompletionProviderResponseError,
    );
  },
);

Deno.test(
  "native Gemini transport classifies MAX_TOKENS as retryable truncation without retaining content",
  async () => {
    const privatePartialContent = '{"private_student_text":"nicht speichern"';
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () =>
        Response.json(
          nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, privatePartialContent, {
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: {
                  role: "model",
                  parts: [{ text: privatePartialContent }],
                },
              },
            ],
          }),
        ),
    });
    try {
      await provider.complete(geminiPayload(GEMINI_V1_CRITIC_MODEL));
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "output_truncated");
      assertEquals(error.safeCode, "chat_provider_output_truncated");
      assertEquals(error.retryable, true);
      assertEquals(String(error).includes(privatePartialContent), false);
      return;
    }
    throw new Error("MAX_TOKENS Gemini output was accepted.");
  },
);

Deno.test(
  "native Gemini transport rejects blocked, incomplete, ambiguous, malformed, or model-mismatched success envelopes",
  async () => {
    const invalidResponses = [
      nativeGeminiSuccess("gemini-wrong-model"),
      nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, '{"ok":true}', {
        candidates: [],
        promptFeedback: { blockReason: "SAFETY" },
      }),
      nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, '{"ok":true}', {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ text: '{"ok":true}' }, { text: "extra" }],
            },
          },
        ],
      }),
      nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, "not-json"),
      nativeGeminiSuccess(GEMINI_V1_CRITIC_MODEL, '{"ok":true}', {
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: -1,
          totalTokenCount: 4,
        },
      }),
    ];
    for (const invalid of invalidResponses) {
      const provider = createNativeGeminiChatProvider({
        apiKey: "key",
        fetchImpl: async () => Response.json(invalid),
      });
      await assertRejects(
        () => provider.complete(geminiPayload(GEMINI_V1_CRITIC_MODEL)),
        ChatCompletionProviderResponseError,
      );
    }
  },
);

Deno.test(
  "native Gemini transport rejects an oversized success body before normalization",
  async () => {
    const provider = createNativeGeminiChatProvider({
      apiKey: "key",
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(512 * 1024 + 1) },
        }),
    });
    try {
      await provider.complete(geminiPayload(GEMINI_V1_CRITIC_MODEL));
    } catch (error) {
      if (!(error instanceof ChatCompletionProviderResponseError)) throw error;
      assertEquals(error.kind, "response_too_large");
      return;
    }
    throw new Error("Oversized Gemini response was unexpectedly accepted.");
  },
);

Deno.test(
  "metadata envelope validator rejects missing, negative, contradictory, or mismatched metering",
  () => {
    const base = {
      model: GEMINI_V1_CRITIC_MODEL,
      provider_model_version: GEMINI_V1_CRITIC_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"ok":true}' },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    };
    for (const envelope of [
      { ...base, usage: undefined },
      {
        ...base,
        usage: { ...base.usage, completion_tokens: -1 },
      },
      {
        ...base,
        usage: { ...base.usage, total_tokens: 4 },
      },
      {
        ...base,
        usage: {
          ...base.usage,
          prompt_tokens_details: undefined,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 5,
        },
      },
      {
        ...base,
        usage: {
          ...base.usage,
          prompt_cache_hit_tokens: 2,
          prompt_cache_miss_tokens: 8,
        },
      },
      { ...base, provider_model_version: "gemini-unpinned-model" },
    ]) {
      assertThrows(
        () =>
          validateChatCompletionResponseEnvelopeWithMetadata(
            envelope,
            GEMINI_V1_CRITIC_MODEL,
          ),
        ChatCompletionProviderResponseError,
      );
    }
  },
);

Deno.test(
  "native provider failures never retain the Gemini secret",
  async () => {
    const secret = "gemini-secret-must-not-leak";
    const provider = createNativeGeminiChatProvider({
      apiKey: secret,
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    });
    try {
      await provider.complete(geminiPayload(GEMINI_V1_ANSWER_MODEL));
    } catch (error) {
      assertEquals(String(error).includes(secret), false);
      assertEquals(provider.providerName, "gemini");
      return;
    }
    throw new Error("Expected the mocked network failure.");
  },
);
