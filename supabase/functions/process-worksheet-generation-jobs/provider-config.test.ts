import { createWorksheetGenerationProviderConfiguration } from "./provider-config.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

Deno.test(
  "missing DeepSeek configuration is carried to the bank-or-hold path",
  () => {
    const configuration = createWorksheetGenerationProviderConfiguration({
      deepSeekApiKey: null,
      geminiApiKey: "gemini-test-key",
    });

    assertEquals(configuration.apiKey, null);
    assertEquals(configuration.provider, undefined);
    assert(
      configuration.secondaryProvider,
      "Expected the mandatory Gemini secondary provider.",
    );
    assertEquals(
      configuration.secondaryProvider.answerModel,
      "gemini-3.1-flash-lite",
    );
    assertEquals(
      configuration.secondaryProvider.criticModel,
      "gemini-3.1-flash-lite",
    );
    assertEquals(
      configuration.secondaryProvider.strongModel,
      "gemini-3.1-flash-lite",
    );
    assertEquals(
      configuration.secondaryProvider.provider.providerName,
      "gemini",
    );
  },
);

Deno.test(
  "missing both worksheet providers can still use the certified bank",
  () => {
    const configuration = createWorksheetGenerationProviderConfiguration({
      deepSeekApiKey: null,
      geminiApiKey: null,
    });

    assertEquals(configuration.apiKey, null);
    assertEquals(configuration.provider, undefined);
    assertEquals(configuration.secondaryProvider, null);
    assertEquals(configuration.secondaryConfigurationInvalid, false);
  },
);

Deno.test(
  "malformed DeepSeek configuration cannot spend through Gemini",
  () => {
    const malformedKey = "x".repeat(501);
    const configuration = createWorksheetGenerationProviderConfiguration({
      deepSeekApiKey: malformedKey,
      geminiApiKey: "gemini-test-key",
    });

    assertEquals(configuration.apiKey, null);
    assertEquals(configuration.provider, undefined);
    assert(
      configuration.secondaryProvider,
      "Expected the mandatory Gemini critic.",
    );
  },
);

Deno.test(
  "invalid optional Gemini configuration never breaks a healthy primary",
  () => {
    const configuration = createWorksheetGenerationProviderConfiguration({
      deepSeekApiKey: "deepseek-test-key",
      geminiApiKey: "x".repeat(501),
    });

    assert(configuration.provider, "Expected the healthy primary provider.");
    assertEquals(configuration.secondaryProvider, null);
    assertEquals(configuration.secondaryConfigurationInvalid, true);
  },
);
