import {
  type ChatCompletionProvider,
  createOpenAiCompatibleChatProvider,
  createOptionalGeminiSecondaryProvider,
  type GeminiSecondaryProvider,
} from "../_shared/chat-completion-provider.ts";

export type WorksheetGenerationProviderConfiguration = {
  apiKey: string | null;
  provider?: ChatCompletionProvider;
  secondaryProvider: GeminiSecondaryProvider | null;
  secondaryConfigurationInvalid: boolean;
};

export function createWorksheetGenerationProviderConfiguration(args: {
  deepSeekApiKey?: string | null;
  geminiApiKey?: string | null;
  deepSeekFetchImpl?: typeof fetch;
  geminiFetchImpl?: typeof fetch;
}): WorksheetGenerationProviderConfiguration {
  let secondaryProvider: GeminiSecondaryProvider | null = null;
  let secondaryConfigurationInvalid = false;
  try {
    secondaryProvider = createOptionalGeminiSecondaryProvider({
      apiKey: args.geminiApiKey,
      fetchImpl: args.geminiFetchImpl,
    });
  } catch {
    secondaryConfigurationInvalid = true;
  }

  let apiKey = args.deepSeekApiKey?.trim() || null;
  let provider: ChatCompletionProvider | undefined;
  if (apiKey) {
    try {
      provider = createOpenAiCompatibleChatProvider({
        apiKey,
        providerName: "deepseek",
        baseUrl: "https://api.deepseek.com",
        fetchImpl: args.deepSeekFetchImpl,
      });
    } catch {
      apiKey = null;
    }
  }

  return {
    apiKey,
    provider,
    secondaryProvider,
    secondaryConfigurationInvalid,
  };
}
