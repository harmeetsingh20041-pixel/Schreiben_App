import {
  createAdminClient,
  evaluateSubmissionFeedbackDraft,
  getSecretKey,
  type SupabaseAdminClient,
} from "../_shared/writing-feedback.ts";
import { createRetryWakeup } from "../_shared/retry-wakeup.ts";
import { AiSpendAccountingSession } from "../_shared/ai-spend-accounting.ts";
import { createProcessWritingJobsHandler } from "./processor.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const handler = createProcessWritingJobsHandler({
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
      providerCallKeyPrefix: "writing",
      onBeforeProviderCall: accounting.beforeProviderCall,
      onProviderUsage: accounting.recordProviderUsage,
      onProviderNotCalled: accounting.providerNotCalled,
    };
  },
  evaluateSubmission: ({
    admin,
    submissionId,
    requestId,
    providerCallKeyPrefix,
    onBeforeProviderCall,
    onProviderUsage,
    onProviderNotCalled,
  }) =>
    evaluateSubmissionFeedbackDraft({
      admin: admin as SupabaseAdminClient,
      submissionId,
      requestId,
      providerCallKeyPrefix,
      onBeforeProviderCall,
      onProviderUsage,
      onProviderNotCalled,
    }),
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
  wakeRetry: createRetryWakeup({
    functionName: "process-writing-jobs",
    authHeaderName: "x-process-writing-secret",
    getSupabaseUrl: () => Deno.env.get("SUPABASE_URL"),
    getAuthSecret: () =>
      Deno.env.get("PROCESS_WRITING_JOBS_SECRET") ??
        Deno.env.get("PROCESS_FEEDBACK_SECRET"),
  }),
  getRecoverySecret: () =>
    Deno.env.get("PROCESS_WRITING_JOBS_SECRET") ??
      Deno.env.get("PROCESS_FEEDBACK_SECRET"),
  getServiceAuthSecret: getSecretKey,
  // Browser sessions use kick-writing-jobs. This worker accepts only the
  // service key or the dedicated recovery secret.
  log: (event) =>
    console.log(
      JSON.stringify({
        function: "process-writing-jobs",
        ...event,
      }),
    ),
});

Deno.serve(handler as (req: Request) => Response | Promise<Response>);
