import {
  createAdminClient,
  getSecretKey,
  type SupabaseAdminClient,
} from "../_shared/writing-feedback.ts";
import { prepareWorksheetAnswerCompletion } from "./evaluate.ts";
import { createWorksheetAnswerProcessorHandler } from "./processor.ts";
import {
  type ChatCompletionProvider,
  createOpenAiCompatibleChatProvider,
  createOptionalGeminiSecondaryProvider,
  DEEPSEEK_V1_FLASH_MODEL,
  type GeminiSecondaryProvider,
} from "../_shared/chat-completion-provider.ts";
import { createRetryWakeup } from "../_shared/retry-wakeup.ts";
import { AiSpendAccountingSession } from "../_shared/ai-spend-accounting.ts";
import { createWorksheetAnswerCheckpointStore } from "./checkpoint.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const handler = createWorksheetAnswerProcessorHandler({
  createAdminClient,
  createProviderLifecycleHooks: ({
    admin,
    jobId,
    entityVersion,
    attemptNumber,
  }) => {
    const accounting = new AiSpendAccountingSession({
      client: admin,
      jobId,
      entityVersion,
      attemptNumber,
    });
    return {
      onBeforeProviderCall: accounting.beforeProviderCall,
      onProviderNotCalled: accounting.providerNotCalled,
      onProviderUsage: accounting.recordProviderUsage,
    };
  },
  evaluateAttempt: ({
    admin,
    jobId,
    queueMessageId,
    workerId,
    attemptId,
    entityVersion,
    providerLifecycleHooks,
    providerCallKeyPrefix,
  }) => {
    const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
    let provider: ChatCompletionProvider | undefined;
    if (apiKey) {
      try {
        provider = createOpenAiCompatibleChatProvider({
          apiKey,
          providerName: "deepseek",
          baseUrl: "https://api.deepseek.com",
        });
      } catch {
        provider = undefined;
      }
    }
    let geminiSecondary: GeminiSecondaryProvider | null = null;
    try {
      geminiSecondary = createOptionalGeminiSecondaryProvider({
        apiKey: Deno.env.get("GEMINI_API_KEY"),
      });
    } catch {
      console.error(JSON.stringify({
        function: "process-worksheet-answer-jobs",
        stage: "secondary_provider_config",
        status: "failed",
        safe_error_code: "worksheet_secondary_not_configured",
      }));
    }
    return prepareWorksheetAnswerCompletion({
      admin: admin as SupabaseAdminClient,
      attemptId,
      expectedVersion: entityVersion,
      apiKey,
      model: DEEPSEEK_V1_FLASH_MODEL,
      provider,
      geminiSecondary,
      usageCallKeyPrefix: providerCallKeyPrefix,
      checkpointStore: createWorksheetAnswerCheckpointStore({
        admin,
        jobId,
        queueMessageId,
        workerId,
        attemptId,
        entityVersion,
      }),
      onBeforeProviderCall: providerLifecycleHooks?.onBeforeProviderCall,
      onProviderNotCalled: providerLifecycleHooks?.onProviderNotCalled,
      onProviderUsage: providerLifecycleHooks?.onProviderUsage,
    });
  },
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
  wakeRetry: createRetryWakeup({
    functionName: "process-worksheet-answer-jobs",
    authHeaderName: "x-process-worksheet-answer-secret",
    getSupabaseUrl: () => Deno.env.get("SUPABASE_URL"),
    getAuthSecret: () =>
      Deno.env.get("PROCESS_WORKSHEET_ANSWER_JOBS_SECRET") ??
        Deno.env.get("PROCESS_WORKSHEET_JOBS_SECRET"),
  }),
  getRecoverySecret: () =>
    Deno.env.get("PROCESS_WORKSHEET_ANSWER_JOBS_SECRET") ??
      Deno.env.get("PROCESS_WORKSHEET_JOBS_SECRET"),
  getServiceAuthSecret: getSecretKey,
  log: (event) =>
    console.log(JSON.stringify({
      function: "process-worksheet-answer-jobs",
      ...event,
    })),
});

Deno.serve(handler);
