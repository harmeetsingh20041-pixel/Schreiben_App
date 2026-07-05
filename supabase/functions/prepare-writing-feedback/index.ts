import {
  cleanString,
  corsHeaders,
  createAdminClient,
  FeedbackHttpError,
  jsonResponse,
  prepareSubmissionFeedback,
} from "../_shared/writing-feedback.ts";

Deno.serve(async (req) => {
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
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  if (!submissionId) {
    return jsonResponse({ error: "Submission id is required." }, 400);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error("prepare-writing-feedback config error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Feedback service is not configured." }, 500);
  }

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }

  try {
    const result = await prepareSubmissionFeedback({
      admin,
      submissionId,
      callerId: userData.user.id,
      requireTeacherAccess: true,
      source: "manual",
    });

    return jsonResponse(result);
  } catch (error) {
    const status = error instanceof FeedbackHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Feedback could not be prepared.";
    return jsonResponse({ error: message }, status);
  }
});
