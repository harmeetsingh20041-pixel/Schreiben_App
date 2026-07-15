import {
  createAdminClient,
  getSecretKey,
  type SupabaseAdminClient,
} from "../_shared/writing-feedback.ts";
import { prepareWorksheetCompletion } from "./prepare.ts";
import { createWorksheetGenerationProcessorHandler } from "./processor.ts";
import {
  DEEPSEEK_V1_FLASH_MODEL,
  DEEPSEEK_V1_PRO_MODEL,
} from "../_shared/chat-completion-provider.ts";
import { createRetryWakeup } from "../_shared/retry-wakeup.ts";
import {
  createWorksheetGenerationProviderConfiguration,
} from "./provider-config.ts";
import { AiSpendAccountingSession } from "../_shared/ai-spend-accounting.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const handler = createWorksheetGenerationProcessorHandler({
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
      onProviderUsage: accounting.recordProviderUsage,
      onProviderNotCalled: accounting.providerNotCalled,
    };
  },
  prepareWorksheet: ({
    admin,
    assignmentId,
    jobId,
    queueMessageId,
    workerId,
    entityVersion,
    providerLifecycleHooks,
    providerCallKeyPrefix,
  }) => {
    const configuration = createWorksheetGenerationProviderConfiguration({
      deepSeekApiKey: Deno.env.get("DEEPSEEK_API_KEY"),
      geminiApiKey: Deno.env.get("GEMINI_API_KEY"),
    });
    if (configuration.secondaryConfigurationInvalid) {
      console.error(JSON.stringify({
        function: "process-worksheet-generation-jobs",
        stage: "provider_secondary_config",
        status: "failed",
        safe_error_code: "worksheet_secondary_not_configured",
      }));
    }
    return prepareWorksheetCompletion({
      admin: admin as SupabaseAdminClient,
      assignmentId,
      jobId,
      queueMessageId,
      workerId,
      entityVersion,
      apiKey: configuration.apiKey,
      model: DEEPSEEK_V1_PRO_MODEL,
      criticModel: DEEPSEEK_V1_FLASH_MODEL,
      provider: configuration.provider,
      secondaryProvider: configuration.secondaryProvider,
      providerLifecycleHooks,
      providerCallKeyPrefix,
    });
  },
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
  wakeRetry: createRetryWakeup({
    functionName: "process-worksheet-generation-jobs",
    authHeaderName: "x-process-worksheet-secret",
    getSupabaseUrl: () => Deno.env.get("SUPABASE_URL"),
    getAuthSecret: () => Deno.env.get("PROCESS_WORKSHEET_JOBS_SECRET"),
  }),
  getRecoverySecret: () => Deno.env.get("PROCESS_WORKSHEET_JOBS_SECRET"),
  getServiceAuthSecret: getSecretKey,
  log: (event) =>
    console.log(JSON.stringify({
      function: "process-worksheet-generation-jobs",
      ...event,
    })),
});

Deno.serve(handler);
