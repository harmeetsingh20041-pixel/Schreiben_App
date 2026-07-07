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

Deno.serve(async (req) => {
  const requestId = createRequestId();
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  let submissionId = "";
  try {
    const body = await req.json();
    submissionId = cleanString(body.submission_id || body.submissionId);
  } catch {
    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "parse_request",
      status: "failed",
      safe_error_code: "invalid_body",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  if (!submissionId) {
    return jsonResponse({ error: "Submission id is required." }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "auth",
      status: "failed",
      submission_id: submissionId,
      safe_error_code: "missing_jwt",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Authentication required." }, 401);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "config",
      status: "failed",
      submission_id: submissionId,
      safe_error_code: "admin_client_config_failed",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Feedback could not be prepared. Please try again later." }, 500);
  }

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) {
    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "auth",
      status: "failed",
      submission_id: submissionId,
      safe_error_code: "invalid_jwt",
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: "Authentication required." }, 401);
  }

  try {
    const result = await prepareSubmissionFeedback({
      admin,
      submissionId,
      callerId: userData.user.id,
      requireTeacherAccess: true,
      source: "manual",
      requestId,
    });

    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "response",
      status: "succeeded",
      submission_id: submissionId,
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse(result);
  } catch (error) {
    const status = error instanceof FeedbackHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Feedback could not be prepared.";
    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "response",
      status: "failed",
      submission_id: submissionId,
      safe_error_code: `feedback_http_${status}`,
      duration_ms: durationMs(startedAt),
    });
    return jsonResponse({ error: message }, status);
  }
});
