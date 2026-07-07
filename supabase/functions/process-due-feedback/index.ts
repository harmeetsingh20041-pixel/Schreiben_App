import {
  cleanString,
  corsHeaders,
  createAdminClient,
  createRequestId,
  durationMs,
  FeedbackHttpError,
  jsonResponse,
  logFunctionEvent,
  prepareSubmissionFeedback,
} from "../_shared/writing-feedback.ts";

const DEFAULT_BATCH_LIMIT = 5;
const MAX_BATCH_LIMIT = 5;

function parseLimit(value: string | null) {
  const parsed = Number(value ?? DEFAULT_BATCH_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_LIMIT;
  return Math.min(parsed, MAX_BATCH_LIMIT);
}

Deno.serve(async (req) => {
  const requestId = createRequestId();
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const expectedSecret = Deno.env.get("PROCESS_FEEDBACK_SECRET");
  if (!expectedSecret) {
    logFunctionEvent({
      request_id: requestId,
      function: "process-due-feedback",
      stage: "config",
      status: "failed",
      safe_error_code: "missing_process_secret",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Feedback processor secret is not configured." }, 503);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerSecret = authHeader.replace(/^Bearer\s+/i, "").trim();
  const headerSecret = cleanString(req.headers.get("x-process-feedback-secret"));
  if (headerSecret !== expectedSecret && bearerSecret !== expectedSecret) {
    logFunctionEvent({
      request_id: requestId,
      function: "process-due-feedback",
      stage: "auth",
      status: "failed",
      safe_error_code: "invalid_process_secret",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    logFunctionEvent({
      request_id: requestId,
      function: "process-due-feedback",
      stage: "config",
      status: "failed",
      safe_error_code: "admin_client_config_failed",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Feedback processor is not configured." }, 500);
  }

  const limit = parseLimit(new URL(req.url).searchParams.get("limit"));
  const nowIso = new Date().toISOString();

  const { data: dueSubmissions, error: dueError } = await admin
    .from("submissions")
    .select("id, feedback_scheduled_at, feedback_mode")
    .eq("status", "submitted")
    .in("feedback_mode", ["immediate", "automatic_delayed"])
    .not("feedback_scheduled_at", "is", null)
    .lte("feedback_scheduled_at", nowIso)
    .order("feedback_scheduled_at", { ascending: true })
    .limit(limit);

  if (dueError) {
    logFunctionEvent({
      request_id: requestId,
      function: "process-due-feedback",
      stage: "load_due_submissions",
      status: "failed",
      safe_error_code: "due_submission_query_failed",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Could not load due submissions." }, 500);
  }

  logFunctionEvent({
    request_id: requestId,
    function: "process-due-feedback",
    stage: "load_due_submissions",
    status: "succeeded",
    detail: `due_count=${dueSubmissions?.length ?? 0}; limit=${limit}`,
  });

  const results = [];
  for (const submission of dueSubmissions ?? []) {
    try {
      const result = await prepareSubmissionFeedback({
        admin,
        submissionId: submission.id,
        requireTeacherAccess: false,
        source: "due_processor",
        requestId,
      });
      results.push({
        submission_id: submission.id,
        status: result.status,
        line_count: result.line_count,
        already_processed: Boolean(result.already_processed),
        already_processing: Boolean(result.already_processing),
      });
    } catch (error) {
      const status = error instanceof FeedbackHttpError ? error.status : 500;
      logFunctionEvent({
        request_id: requestId,
        function: "process-due-feedback",
        stage: "prepare_submission",
        status: "failed",
        submission_id: submission.id,
        safe_error_code: `feedback_http_${status}`,
      });
      results.push({
        submission_id: submission.id,
        status: "failed",
        error_status: status,
        error: "Feedback could not be prepared.",
      });
    }
  }

  logFunctionEvent({
    request_id: requestId,
    function: "process-due-feedback",
    stage: "response",
    status: "succeeded",
    duration_ms: durationMs(startedAt),
    detail: `due_count=${dueSubmissions?.length ?? 0}; processed_count=${results.filter((result) => result.status === "checked" || result.status === "needs_review").length}`,
  });

  return jsonResponse({
    checked_at: nowIso,
    due_count: dueSubmissions?.length ?? 0,
    processed_count: results.filter((result) => result.status === "checked" || result.status === "needs_review").length,
    results,
  });
});
