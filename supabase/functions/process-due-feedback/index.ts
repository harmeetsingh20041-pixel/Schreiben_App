// Compatibility recovery endpoint. The former five-minute processor wrote
// feedback directly and nontransactionally. It now runs the same durable,
// fixed-queue worker as process-writing-jobs and cannot select an entity.
import {
  createAdminClient,
  evaluateSubmissionFeedbackDraft,
  getSecretKey,
  type SupabaseAdminClient,
} from "../_shared/writing-feedback.ts";
import { AiSpendAccountingSession } from "../_shared/ai-spend-accounting.ts";
import { createProcessWritingJobsHandler } from "../process-writing-jobs/processor.ts";

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
  getRecoverySecret: () =>
    Deno.env.get("PROCESS_WRITING_JOBS_SECRET") ??
      Deno.env.get("PROCESS_FEEDBACK_SECRET"),
  getServiceAuthSecret: getSecretKey,
  // Compatibility recovery is never browser-triggered. Only the service key or
  // an explicit recovery secret may wake this endpoint.
  log: (event) =>
    console.log(
      JSON.stringify({
        function: "process-due-feedback-compat",
        ...event,
      }),
    ),
});

Deno.serve(handler as (req: Request) => Response | Promise<Response>);
