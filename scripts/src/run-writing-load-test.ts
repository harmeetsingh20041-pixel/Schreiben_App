import { randomUUID } from "node:crypto";
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleepWithTimer } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RawPerformanceEvidenceRow } from "./verify-release-gates.js";

export const LOAD_GENERATOR_VERSION = "schreiben-load-v1" as const;
export const MINIMUM_LOAD_ACTORS = 20;
export const MAXIMUM_LOAD_ACTORS = 50;
export const DEFAULT_JOB_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CONFIRMATION_ENVIRONMENT_VARIABLE = "SCHREIBEN_PRODUCTION_LOAD_CONFIRM";
const SCENARIO_PURPOSE = "isolated-production-writing-load-test";
const MAXIMUM_AUTHORIZATION_WINDOW_MS = 2 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const VIRTUAL_USER_ID_PATTERN = /^virtual-user-(?:0[1-9]|[1-4][0-9]|50)$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

const SYNTHETIC_WRITING =
  "Dies ist ein vollständig synthetischer Text für den autorisierten Schreiben-Lasttest. " +
  "Er enthält keine Angaben zu echten Schülerinnen oder Schülern. " +
  "Die Anwendung soll diese Probe zuverlässig annehmen und auswerten.";

type JsonRecord = Record<string, unknown>;
type WritingSourceType = "workspace_question" | "global_question";

export type WritingLoadActor = {
  virtual_user_id: string;
  access_token: string;
  batch_id: string;
  source_type: WritingSourceType;
  source_id: string;
  authorized_for_load_test: true;
};

export type WritingLoadScenario = {
  schema_version: 1;
  environment: "production";
  purpose: typeof SCENARIO_PURPOSE;
  isolated_test_data: true;
  project_ref: string;
  supabase_url: string;
  anon_key: string;
  load_attestation_id: string;
  authorized_from: string;
  authorized_until: string;
  actors: WritingLoadActor[];
};

type ValidatedActor = WritingLoadActor & {
  subject: string;
  expires_at_ms: number;
};

export type ValidatedWritingLoadScenario = Omit<
  WritingLoadScenario,
  "actors"
> & {
  actors: ValidatedActor[];
};

export type LoadHarnessDependencies = {
  fetch: typeof fetch;
  now: () => Date;
  monotonicNow: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  randomUUID: () => string;
  pollIntervalMs: number;
  jobTimeoutMs: number;
  requestTimeoutMs: number;
};

export type WritingLoadResult = {
  run_id: string;
  load_attestation_id: string;
  actor_count: number;
  evidence: RawPerformanceEvidenceRow[];
};

export type LoadCommandResult =
  | {
      mode: "validation_only";
      actor_count: number;
      load_attestation_id: string;
    }
  | {
      mode: "executed";
      actor_count: number;
      load_attestation_id: string;
      row_count: number;
    };

type LoadCommandOptions = {
  scenarioPath: string;
  outputPath?: string;
  execute: boolean;
};

type SubmissionAcknowledgement = {
  submission_id: string;
  evaluation_status: "queued" | "processing";
  release_status: "held";
  release_at: null;
};

type SubmissionStatus = {
  submission_id: string;
  evaluation_status:
    | "queued"
    | "processing"
    | "ready"
    | "needs_review"
    | "failed";
  release_status: "held" | "scheduled" | "released";
  feedback_started_at: string | null;
  feedback_completed_at: string | null;
};

type VirtualUserResult = {
  virtual_user_id: string;
  virtual_user_started_at: string;
  acknowledgement_observed_at: string;
  acknowledgement_ms: number;
  job_start_observed_at: string;
  job_start_ms: number;
  completion_observed_at: string;
  completion_ms: number;
};

export class LoadHarnessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LoadHarnessError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new LoadHarnessError(
      "scenario_invalid",
      `${label} contains unsupported fields.`,
    );
  }
}

function requiredString(value: JsonRecord, key: string, label: string) {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new LoadHarnessError("scenario_invalid", `${label} requires ${key}.`);
  }
  return candidate;
}

function parseUtcTimestamp(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new LoadHarnessError(
      "scenario_invalid",
      `${label} must be a valid UTC timestamp.`,
    );
  }
  return value;
}

function parseJwtPayload(token: string, label: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new LoadHarnessError(
      "scenario_invalid",
      `${label} access token is not a JWT.`,
    );
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new LoadHarnessError(
      "scenario_invalid",
      `${label} access token has an invalid payload.`,
    );
  }
}

function validateProductionUrl(projectRef: string, rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LoadHarnessError(
      "scenario_invalid",
      "supabase_url must be a valid URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${projectRef}.supabase.co` ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "supabase_url must be the HTTPS root of the attested Supabase project.",
    );
  }
  return `https://${url.hostname}`;
}

export function validateWritingLoadScenario(
  value: unknown,
  now = new Date(),
): ValidatedWritingLoadScenario {
  if (!isRecord(value)) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario must be a JSON object.",
    );
  }
  hasOnlyKeys(
    value,
    [
      "schema_version",
      "environment",
      "purpose",
      "isolated_test_data",
      "project_ref",
      "supabase_url",
      "anon_key",
      "load_attestation_id",
      "authorized_from",
      "authorized_until",
      "actors",
    ],
    "Load scenario",
  );
  if (value.schema_version !== 1) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario must use schema_version 1.",
    );
  }
  if (value.environment !== "production") {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario must explicitly target production.",
    );
  }
  if (value.purpose !== SCENARIO_PURPOSE) {
    throw new LoadHarnessError(
      "scenario_invalid",
      `Load scenario purpose must be ${SCENARIO_PURPOSE}.`,
    );
  }
  if (value.isolated_test_data !== true) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario must attest that every actor and resource is isolated test data.",
    );
  }

  const projectRef = requiredString(value, "project_ref", "Load scenario");
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario has an invalid project_ref.",
    );
  }
  const supabaseUrl = validateProductionUrl(
    projectRef,
    requiredString(value, "supabase_url", "Load scenario"),
  );
  const anonKey = requiredString(value, "anon_key", "Load scenario");
  let browserKeySafe = anonKey.startsWith("sb_publishable_");
  if (!browserKeySafe && anonKey.split(".").length === 3) {
    try {
      browserKeySafe = parseJwtPayload(anonKey, "Browser key").role === "anon";
    } catch {
      browserKeySafe = false;
    }
  }
  if (
    anonKey.length < 20 ||
    anonKey.length > 8_192 ||
    /\s/.test(anonKey) ||
    anonKey.startsWith("sb_secret_") ||
    !browserKeySafe
  ) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario has an invalid anon_key.",
    );
  }
  const attestationId = requiredString(
    value,
    "load_attestation_id",
    "Load scenario",
  );
  if (!OPAQUE_ID_PATTERN.test(attestationId)) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario has an invalid load_attestation_id.",
    );
  }

  const authorizedFrom = parseUtcTimestamp(
    value.authorized_from,
    "authorized_from",
  );
  const authorizedUntil = parseUtcTimestamp(
    value.authorized_until,
    "authorized_until",
  );
  const authorizedFromMs = Date.parse(authorizedFrom);
  const authorizedUntilMs = Date.parse(authorizedUntil);
  if (
    authorizedUntilMs <= authorizedFromMs ||
    authorizedUntilMs - authorizedFromMs > MAXIMUM_AUTHORIZATION_WINDOW_MS
  ) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "The production authorization window must be positive and no longer than two hours.",
    );
  }

  if (!Array.isArray(value.actors)) {
    throw new LoadHarnessError(
      "scenario_invalid",
      "Load scenario actors must be an array.",
    );
  }
  if (
    value.actors.length < MINIMUM_LOAD_ACTORS ||
    value.actors.length > MAXIMUM_LOAD_ACTORS
  ) {
    throw new LoadHarnessError(
      "scenario_actor_count_invalid",
      `Load scenario requires ${MINIMUM_LOAD_ACTORS}–${MAXIMUM_LOAD_ACTORS} isolated actors.`,
    );
  }

  const actors = value.actors.map((actorValue, index): ValidatedActor => {
    const label = `Actor ${index + 1}`;
    if (!isRecord(actorValue)) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} must be an object.`,
      );
    }
    hasOnlyKeys(
      actorValue,
      [
        "virtual_user_id",
        "access_token",
        "batch_id",
        "source_type",
        "source_id",
        "authorized_for_load_test",
      ],
      label,
    );
    const virtualUserId = requiredString(actorValue, "virtual_user_id", label);
    if (!VIRTUAL_USER_ID_PATTERN.test(virtualUserId)) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} must use a content-free virtual_user_id from virtual-user-01 through virtual-user-50.`,
      );
    }
    const accessToken = requiredString(actorValue, "access_token", label);
    if (accessToken.length > 8_192 || /\s/.test(accessToken)) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} has an invalid access token.`,
      );
    }
    const batchId = requiredString(actorValue, "batch_id", label);
    const sourceId = requiredString(actorValue, "source_id", label);
    if (!UUID_PATTERN.test(batchId) || !UUID_PATTERN.test(sourceId)) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} requires valid batch_id and source_id UUIDs.`,
      );
    }
    const sourceType = actorValue.source_type;
    if (
      sourceType !== "workspace_question" &&
      sourceType !== "global_question"
    ) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} has an invalid source_type.`,
      );
    }
    if (actorValue.authorized_for_load_test !== true) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} must attest that its actor, batch, and source are authorized for this load test.`,
      );
    }

    const payload = parseJwtPayload(accessToken, label);
    const subject = payload.sub;
    const issuer = payload.iss;
    const role = payload.role;
    const expiresAtSeconds = payload.exp;
    if (
      typeof subject !== "string" ||
      !UUID_PATTERN.test(subject) ||
      issuer !== `${supabaseUrl}/auth/v1` ||
      role !== "authenticated" ||
      typeof expiresAtSeconds !== "number" ||
      !Number.isSafeInteger(expiresAtSeconds)
    ) {
      throw new LoadHarnessError(
        "scenario_invalid",
        `${label} access token does not match the attested authenticated project.`,
      );
    }
    if (expiresAtSeconds * 1_000 <= now.getTime()) {
      throw new LoadHarnessError(
        "scenario_token_expired",
        `${label} access token has expired.`,
      );
    }

    return {
      virtual_user_id: virtualUserId,
      access_token: accessToken,
      batch_id: batchId,
      source_type: sourceType,
      source_id: sourceId,
      authorized_for_load_test: true,
      subject,
      expires_at_ms: expiresAtSeconds * 1_000,
    };
  });

  for (const [values, description] of [
    [actors.map((actor) => actor.virtual_user_id), "virtual_user_id"],
    [actors.map((actor) => actor.subject), "authenticated actor"],
    [actors.map((actor) => actor.access_token), "access token"],
  ] as const) {
    if (new Set(values).size !== actors.length) {
      throw new LoadHarnessError(
        "scenario_actors_not_distinct",
        `Every isolated actor must have a distinct ${description}.`,
      );
    }
  }

  return {
    schema_version: 1,
    environment: "production",
    purpose: SCENARIO_PURPOSE,
    isolated_test_data: true,
    project_ref: projectRef,
    supabase_url: supabaseUrl,
    anon_key: anonKey,
    load_attestation_id: attestationId,
    authorized_from: authorizedFrom,
    authorized_until: authorizedUntil,
    actors,
  };
}

function defaultDependencies(): LoadHarnessDependencies {
  return {
    fetch,
    now: () => new Date(),
    monotonicNow: () => performance.now(),
    sleep: async (milliseconds, signal) => {
      await sleepWithTimer(milliseconds, undefined, { signal });
    },
    randomUUID,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function loadError(code: string, virtualUserId: string) {
  const messages: Record<string, string> = {
    unauthorized: "authentication or authorization was rejected",
    network_unavailable: "a required request was unavailable",
    invalid_response: "a required endpoint returned an invalid response",
    submit_rejected: "the writing submission was rejected",
    submission_lost: "the accepted submission could not be read back safely",
    processor_kick_failed: "the immediate writing worker kick was rejected",
    scenario_not_immediate:
      "the assigned class is not configured for immediate feedback",
    evaluation_failed: "the writing evaluation entered the failed state",
    job_indefinite: "the writing evaluation exceeded the recovery threshold",
    run_cancelled:
      "the load run was cancelled after another virtual user failed",
  };
  return new LoadHarnessError(
    code,
    `${virtualUserId}: ${messages[code] ?? "the load run failed"}.`,
  );
}

async function fetchJsonWithTimeout(
  dependencies: LoadHarnessDependencies,
  input: string,
  init: RequestInit,
  runSignal: AbortSignal,
  virtualUserId: string,
) {
  if (runSignal.aborted) throw loadError("run_cancelled", virtualUserId);
  const controller = new AbortController();
  const abortFromRun = () => controller.abort();
  runSignal.addEventListener("abort", abortFromRun, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.requestTimeoutMs,
  );
  timeout.unref?.();
  try {
    const response = await dependencies.fetch(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const body = await responseJson(response);
    return { response, body };
  } catch (error) {
    if (error instanceof LoadHarnessError) throw error;
    if (runSignal.aborted) throw loadError("run_cancelled", virtualUserId);
    throw loadError("network_unavailable", virtualUserId);
  } finally {
    clearTimeout(timeout);
    runSignal.removeEventListener("abort", abortFromRun);
  }
}

async function responseJson(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) {
    throw new LoadHarnessError(
      "invalid_response",
      "A required endpoint returned an oversized response.",
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new LoadHarnessError(
      "invalid_response",
      "A required endpoint returned invalid JSON.",
    );
  }
}

function serverErrorCode(value: unknown) {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  return value.code;
}

function assertAuthorizedResponse(
  response: Response,
  body: unknown,
  virtualUserId: string,
) {
  const code = serverErrorCode(body);
  if (
    response.status === 401 ||
    response.status === 403 ||
    code === "42501" ||
    code === "28000" ||
    code === "PGRST301"
  ) {
    throw loadError("unauthorized", virtualUserId);
  }
}

function actorHeaders(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
) {
  return {
    Accept: "application/json",
    apikey: scenario.anon_key,
    Authorization: `Bearer ${actor.access_token}`,
    "Content-Type": "application/json",
    "X-Client-Info": LOAD_GENERATOR_VERSION,
  };
}

function actorApiHeaders(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
) {
  return {
    ...actorHeaders(scenario, actor),
    "Accept-Profile": "api",
    "Content-Profile": "api",
  };
}

async function attestActorSession(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
  dependencies: LoadHarnessDependencies,
) {
  const controller = new AbortController();
  const { response, body } = await fetchJsonWithTimeout(
    dependencies,
    `${scenario.supabase_url}/auth/v1/user`,
    {
      method: "GET",
      headers: actorHeaders(scenario, actor),
    },
    controller.signal,
    actor.virtual_user_id,
  );
  assertAuthorizedResponse(response, body, actor.virtual_user_id);
  if (!response.ok || !isRecord(body) || body.id !== actor.subject) {
    throw loadError("unauthorized", actor.virtual_user_id);
  }
}

function oneRow(value: unknown): JsonRecord | null {
  if (Array.isArray(value)) {
    return value.length === 1 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

function parseAcknowledgement(
  value: unknown,
  virtualUserId: string,
): SubmissionAcknowledgement {
  const row = oneRow(value);
  if (
    row &&
    typeof row.submission_id === "string" &&
    UUID_PATTERN.test(row.submission_id) &&
    (row.evaluation_status === "queued" ||
      row.evaluation_status === "processing") &&
    (row.release_status === "scheduled" || row.release_at !== null)
  ) {
    throw loadError("scenario_not_immediate", virtualUserId);
  }
  if (
    !row ||
    typeof row.submission_id !== "string" ||
    !UUID_PATTERN.test(row.submission_id) ||
    (row.evaluation_status !== "queued" &&
      row.evaluation_status !== "processing") ||
    row.release_status !== "held" ||
    row.release_at !== null
  ) {
    throw loadError("invalid_response", virtualUserId);
  }
  return row as unknown as SubmissionAcknowledgement;
}

function parseStatus(
  value: unknown,
  expectedSubmissionId: string,
  virtualUserId: string,
): SubmissionStatus {
  const root = oneRow(value);
  const submission = root && isRecord(root.submission) ? root.submission : null;
  const evaluationStatus = submission?.evaluation_status;
  const releaseStatus = submission?.release_status;
  const startedAt = submission?.feedback_started_at;
  const completedAt = submission?.feedback_completed_at;
  const validNullableTimestamp = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "string" && Number.isFinite(Date.parse(candidate)));
  if (
    root?.schema_version !== 1 ||
    !submission ||
    submission.id !== expectedSubmissionId ||
    !["queued", "processing", "ready", "needs_review", "failed"].includes(
      typeof evaluationStatus === "string" ? evaluationStatus : "",
    ) ||
    !["held", "scheduled", "released"].includes(
      typeof releaseStatus === "string" ? releaseStatus : "",
    ) ||
    !validNullableTimestamp(startedAt) ||
    !validNullableTimestamp(completedAt)
  ) {
    throw loadError("submission_lost", virtualUserId);
  }
  return {
    submission_id: expectedSubmissionId,
    evaluation_status:
      evaluationStatus as SubmissionStatus["evaluation_status"],
    release_status: releaseStatus as SubmissionStatus["release_status"],
    feedback_started_at: startedAt as string | null,
    feedback_completed_at: completedAt as string | null,
  };
}

function roundedDuration(milliseconds: number) {
  return Math.max(0, Math.round(milliseconds));
}

async function submitWriting(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
  dependencies: LoadHarnessDependencies,
  signal: AbortSignal,
) {
  const { response, body } = await fetchJsonWithTimeout(
    dependencies,
    `${scenario.supabase_url}/rest/v1/rpc/submit_writing`,
    {
      method: "POST",
      headers: actorApiHeaders(scenario, actor),
      body: JSON.stringify({
        batch_id: actor.batch_id,
        source_type: actor.source_type,
        source_id: actor.source_id,
        text: SYNTHETIC_WRITING,
      }),
    },
    signal,
    actor.virtual_user_id,
  );
  assertAuthorizedResponse(response, body, actor.virtual_user_id);
  if (!response.ok) throw loadError("submit_rejected", actor.virtual_user_id);
  return parseAcknowledgement(body, actor.virtual_user_id);
}

async function kickWritingWorker(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
  dependencies: LoadHarnessDependencies,
  signal: AbortSignal,
) {
  const { response, body } = await fetchJsonWithTimeout(
    dependencies,
    `${scenario.supabase_url}/functions/v1/kick-writing-jobs`,
    {
      method: "POST",
      headers: actorHeaders(scenario, actor),
      body: "{}",
    },
    signal,
    actor.virtual_user_id,
  );
  assertAuthorizedResponse(response, body, actor.virtual_user_id);
  if (
    response.status !== 202 ||
    !isRecord(body) ||
    body.status !== "accepted"
  ) {
    throw loadError("processor_kick_failed", actor.virtual_user_id);
  }
}

async function getSubmissionStatus(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
  submissionId: string,
  dependencies: LoadHarnessDependencies,
  signal: AbortSignal,
) {
  const { response, body } = await fetchJsonWithTimeout(
    dependencies,
    `${scenario.supabase_url}/rest/v1/rpc/get_submission_detail`,
    {
      method: "POST",
      headers: actorApiHeaders(scenario, actor),
      body: JSON.stringify({ target_submission_id: submissionId }),
    },
    signal,
    actor.virtual_user_id,
  );
  assertAuthorizedResponse(response, body, actor.virtual_user_id);
  if (response.status === 404) {
    throw loadError("submission_lost", actor.virtual_user_id);
  }
  if (!response.ok) throw loadError("submission_lost", actor.virtual_user_id);
  return parseStatus(body, submissionId, actor.virtual_user_id);
}

async function runVirtualUser(
  scenario: ValidatedWritingLoadScenario,
  actor: ValidatedActor,
  dependencies: LoadHarnessDependencies,
  signal: AbortSignal,
): Promise<VirtualUserResult> {
  const virtualUserStartedAt = dependencies.now().toISOString();
  const startedMonotonic = dependencies.monotonicNow();
  const acknowledgement = await submitWriting(
    scenario,
    actor,
    dependencies,
    signal,
  );
  const acknowledgementObservedAt = dependencies.now().toISOString();
  const acknowledgementMs = roundedDuration(
    dependencies.monotonicNow() - startedMonotonic,
  );

  await kickWritingWorker(scenario, actor, dependencies, signal);

  let jobStartObservedAt: string | null = null;
  let jobStartMs: number | null = null;
  while (
    dependencies.monotonicNow() - startedMonotonic <=
    dependencies.jobTimeoutMs
  ) {
    const status = await getSubmissionStatus(
      scenario,
      actor,
      acknowledgement.submission_id,
      dependencies,
      signal,
    );
    const observedAt = dependencies.now().toISOString();
    const elapsedMs = roundedDuration(
      dependencies.monotonicNow() - startedMonotonic,
    );

    if (
      jobStartMs === null &&
      (status.feedback_started_at !== null ||
        status.evaluation_status !== "queued")
    ) {
      jobStartMs = elapsedMs;
      jobStartObservedAt = observedAt;
    }
    if (status.release_status === "scheduled") {
      throw loadError("scenario_not_immediate", actor.virtual_user_id);
    }
    if (status.evaluation_status === "failed") {
      throw loadError("evaluation_failed", actor.virtual_user_id);
    }
    if (
      status.evaluation_status === "ready" ||
      status.evaluation_status === "needs_review"
    ) {
      if (status.feedback_completed_at === null) {
        throw loadError("invalid_response", actor.virtual_user_id);
      }
      if (
        status.evaluation_status === "ready" &&
        status.release_status !== "released"
      ) {
        throw loadError("scenario_not_immediate", actor.virtual_user_id);
      }
      return {
        virtual_user_id: actor.virtual_user_id,
        virtual_user_started_at: virtualUserStartedAt,
        acknowledgement_observed_at: acknowledgementObservedAt,
        acknowledgement_ms: acknowledgementMs,
        job_start_observed_at: jobStartObservedAt ?? observedAt,
        job_start_ms: jobStartMs ?? elapsedMs,
        completion_observed_at: observedAt,
        completion_ms: elapsedMs,
      };
    }

    try {
      await dependencies.sleep(dependencies.pollIntervalMs, signal);
    } catch {
      throw loadError("run_cancelled", actor.virtual_user_id);
    }
  }
  throw loadError("job_indefinite", actor.virtual_user_id);
}

function opaqueId(prefix: string, uuid: string) {
  if (!UUID_PATTERN.test(uuid)) {
    throw new LoadHarnessError(
      "evidence_invalid",
      "The load generator could not create a valid opaque evidence identifier.",
    );
  }
  return `${prefix}_${uuid.replaceAll("-", "")}`;
}

function evidenceRow(args: {
  eventId: string;
  observedAt: string;
  reportingDay: string;
  runId: string;
  metric: RawPerformanceEvidenceRow["metric"];
  durationMs: number;
  concurrentUsers: number;
  virtualUserId: string;
  virtualUserStartedAt: string;
  attestationId: string;
  inputChars?: number;
}): RawPerformanceEvidenceRow {
  return {
    schema_version: 1,
    event_id: args.eventId,
    observed_at: args.observedAt,
    reporting_day: args.reportingDay,
    environment: "production",
    source: "synthetic",
    run_id: args.runId,
    metric: args.metric,
    duration_ms: args.durationMs,
    concurrent_users: args.concurrentUsers,
    virtual_user_id: args.virtualUserId,
    virtual_user_started_at: args.virtualUserStartedAt,
    load_attestation_id: args.attestationId,
    load_generator_version: LOAD_GENERATOR_VERSION,
    ...(args.inputChars === undefined ? {} : { input_chars: args.inputChars }),
  };
}

function buildEvidence(
  results: VirtualUserResult[],
  runId: string,
  attestationId: string,
  dependencies: LoadHarnessDependencies,
) {
  const reportingDays = new Set(
    results.flatMap((result) => [
      result.virtual_user_started_at.slice(0, 10),
      result.acknowledgement_observed_at.slice(0, 10),
      result.job_start_observed_at.slice(0, 10),
      result.completion_observed_at.slice(0, 10),
    ]),
  );
  if (reportingDays.size !== 1) {
    throw new LoadHarnessError(
      "run_crossed_utc_day",
      "The load run crossed a UTC day boundary and cannot produce release evidence.",
    );
  }
  const reportingDay = [...reportingDays][0]!;
  const starts = results.map((result) =>
    Date.parse(result.virtual_user_started_at),
  );
  if (Math.max(...starts) - Math.min(...starts) > 2_000) {
    throw new LoadHarnessError(
      "run_not_synchronized",
      "Virtual-user submissions did not start within the two-second evidence window.",
    );
  }

  return results.flatMap((result) => [
    evidenceRow({
      eventId: opaqueId("event", dependencies.randomUUID()),
      observedAt: result.acknowledgement_observed_at,
      reportingDay,
      runId,
      metric: "submission_acknowledgement_ms",
      durationMs: result.acknowledgement_ms,
      concurrentUsers: results.length,
      virtualUserId: result.virtual_user_id,
      virtualUserStartedAt: result.virtual_user_started_at,
      attestationId,
    }),
    evidenceRow({
      eventId: opaqueId("event", dependencies.randomUUID()),
      observedAt: result.job_start_observed_at,
      reportingDay,
      runId,
      metric: "immediate_job_start_ms",
      durationMs: result.job_start_ms,
      concurrentUsers: results.length,
      virtualUserId: result.virtual_user_id,
      virtualUserStartedAt: result.virtual_user_started_at,
      attestationId,
    }),
    evidenceRow({
      eventId: opaqueId("event", dependencies.randomUUID()),
      observedAt: result.completion_observed_at,
      reportingDay,
      runId,
      metric: "feedback_completion_ms",
      durationMs: result.completion_ms,
      concurrentUsers: results.length,
      virtualUserId: result.virtual_user_id,
      virtualUserStartedAt: result.virtual_user_started_at,
      attestationId,
      inputChars: SYNTHETIC_WRITING.length,
    }),
  ]);
}

export async function executeProductionWritingLoad(
  scenarioValue: unknown,
  suppliedDependencies: Partial<LoadHarnessDependencies> = {},
): Promise<WritingLoadResult> {
  const dependencies = {
    ...defaultDependencies(),
    ...suppliedDependencies,
  };
  if (
    dependencies.pollIntervalMs < 1 ||
    dependencies.jobTimeoutMs < 1 ||
    dependencies.requestTimeoutMs < 1
  ) {
    throw new LoadHarnessError(
      "harness_configuration_invalid",
      "Load harness timing configuration is invalid.",
    );
  }
  const scenario = validateWritingLoadScenario(
    scenarioValue,
    dependencies.now(),
  );
  const nowMs = dependencies.now().getTime();
  if (
    nowMs < Date.parse(scenario.authorized_from) ||
    nowMs > Date.parse(scenario.authorized_until)
  ) {
    throw new LoadHarnessError(
      "authorization_window_closed",
      "The attested production load-test authorization window is not active.",
    );
  }
  const minimumTokenExpiry =
    nowMs + dependencies.jobTimeoutMs + dependencies.requestTimeoutMs;
  if (minimumTokenExpiry > Date.parse(scenario.authorized_until)) {
    throw new LoadHarnessError(
      "authorization_window_too_short",
      "The remaining authorization window must cover the complete load-test timeout.",
    );
  }
  if (
    scenario.actors.some((actor) => actor.expires_at_ms <= minimumTokenExpiry)
  ) {
    throw new LoadHarnessError(
      "scenario_token_expires_too_soon",
      "Every actor token must remain valid beyond the complete load-test timeout.",
    );
  }

  // Authenticate every distinct actor before the synchronized write barrier.
  // If any preflight fails, no submission has been created.
  await Promise.all(
    scenario.actors.map((actor) =>
      attestActorSession(scenario, actor, dependencies),
    ),
  );

  const runController = new AbortController();
  let firstFailure: LoadHarnessError | null = null;
  const tasks = scenario.actors.map(async (actor) => {
    try {
      return await runVirtualUser(
        scenario,
        actor,
        dependencies,
        runController.signal,
      );
    } catch (error) {
      const failure =
        error instanceof LoadHarnessError
          ? error
          : loadError("invalid_response", actor.virtual_user_id);
      if (failure.code !== "run_cancelled" && firstFailure === null) {
        firstFailure = failure;
        runController.abort();
      }
      throw failure;
    }
  });
  const settled = await Promise.allSettled(tasks);
  if (firstFailure) throw firstFailure;
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw new LoadHarnessError(
      "load_run_failed",
      "The synchronized production load run failed.",
    );
  }
  const results = settled.map(
    (result) => (result as PromiseFulfilledResult<VirtualUserResult>).value,
  );
  if (results.length !== scenario.actors.length) {
    throw new LoadHarnessError(
      "submission_lost",
      "The load run did not return one terminal result per isolated actor.",
    );
  }

  const runId = opaqueId("run", dependencies.randomUUID());
  const evidence = buildEvidence(
    results,
    runId,
    scenario.load_attestation_id,
    dependencies,
  );
  const expectedVirtualUsers = new Set(
    scenario.actors.map((actor) => actor.virtual_user_id),
  );
  const requiredMetrics = new Set<RawPerformanceEvidenceRow["metric"]>([
    "submission_acknowledgement_ms",
    "immediate_job_start_ms",
    "feedback_completion_ms",
  ]);
  if (
    evidence.length !== scenario.actors.length * 3 ||
    new Set(evidence.map((row) => row.event_id)).size !== evidence.length ||
    evidence.some(
      (row) =>
        !row.virtual_user_id ||
        !expectedVirtualUsers.has(row.virtual_user_id) ||
        row.run_id !== runId ||
        row.load_attestation_id !== scenario.load_attestation_id ||
        row.load_generator_version !== LOAD_GENERATOR_VERSION ||
        row.concurrent_users !== scenario.actors.length ||
        !Number.isFinite(row.duration_ms) ||
        row.duration_ms < 0 ||
        !row.virtual_user_started_at ||
        Date.parse(row.virtual_user_started_at) > Date.parse(row.observed_at),
    ) ||
    [...expectedVirtualUsers].some((virtualUserId) => {
      const rows = evidence.filter(
        (row) => row.virtual_user_id === virtualUserId,
      );
      return (
        rows.length !== requiredMetrics.size ||
        new Set(rows.map((row) => row.metric)).size !== requiredMetrics.size ||
        rows.some((row) => !requiredMetrics.has(row.metric))
      );
    })
  ) {
    throw new LoadHarnessError(
      "evidence_invalid",
      "The load run could not produce a complete, unique evidence set.",
    );
  }
  return {
    run_id: runId,
    load_attestation_id: scenario.load_attestation_id,
    actor_count: scenario.actors.length,
    evidence,
  };
}

function isPathInside(parent: string, candidate: string) {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function readExternalScenario(
  scenarioPath: string,
  repositoryRoot: string,
) {
  if (!isAbsolute(scenarioPath)) {
    throw new LoadHarnessError(
      "scenario_path_unsafe",
      "The scenario path must be absolute and outside the Git repository.",
    );
  }
  const [resolvedScenario, resolvedRepository] = await Promise.all([
    realpath(scenarioPath),
    realpath(repositoryRoot),
  ]);
  if (isPathInside(resolvedRepository, resolvedScenario)) {
    throw new LoadHarnessError(
      "scenario_path_unsafe",
      "The credential-bearing scenario must remain outside the Git repository.",
    );
  }
  const details = await stat(resolvedScenario);
  if (!details.isFile()) {
    throw new LoadHarnessError(
      "scenario_path_unsafe",
      "The scenario path must refer to a regular file.",
    );
  }
  if (details.size > 1_000_000) {
    throw new LoadHarnessError(
      "scenario_path_unsafe",
      "The external scenario is unexpectedly large.",
    );
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new LoadHarnessError(
      "scenario_path_unsafe",
      "The credential-bearing scenario must be readable and writable only by its owner (mode 0600).",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolvedScenario, "utf8")) as unknown;
  } catch {
    throw new LoadHarnessError(
      "scenario_invalid",
      "The external load scenario is not valid JSON.",
    );
  }
  return value;
}

export function parseLoadCommandArguments(argv: string[]): LoadCommandOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--" && index === 0) {
      continue;
    }
    if (argument === "--execute") {
      if (execute) {
        throw new LoadHarnessError(
          "arguments_invalid",
          "The load harness received a duplicate execution flag.",
        );
      }
      execute = true;
      continue;
    }
    if (argument !== "--scenario" && argument !== "--output") {
      throw new LoadHarnessError(
        "arguments_invalid",
        "The load harness received an unsupported argument.",
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new LoadHarnessError(
        "arguments_invalid",
        `${argument} requires a value.`,
      );
    }
    if (values.has(argument)) {
      throw new LoadHarnessError(
        "arguments_invalid",
        "The load harness received a duplicate option.",
      );
    }
    values.set(argument, value);
    index += 1;
  }
  const scenarioPath = values.get("--scenario");
  if (!scenarioPath) {
    throw new LoadHarnessError(
      "arguments_invalid",
      "Usage: load:writing:production -- --scenario <absolute-external-path> [--execute --output <new-jsonl-path>]",
    );
  }
  const outputPath = values.get("--output");
  if (execute && !outputPath) {
    throw new LoadHarnessError(
      "arguments_invalid",
      "An execution requires --output so evidence is written as a new file.",
    );
  }
  if (!execute && outputPath) {
    throw new LoadHarnessError(
      "arguments_invalid",
      "--output is accepted only together with --execute.",
    );
  }
  return { scenarioPath, outputPath, execute };
}

async function reserveEvidenceFile(outputPath: string) {
  const absoluteOutput = isAbsolute(outputPath)
    ? outputPath
    : resolve(process.cwd(), outputPath);
  try {
    const handle = await open(absoluteOutput, "wx", 0o600);
    return { absoluteOutput, handle };
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === "string" ? error.code : null;
    throw new LoadHarnessError(
      code === "EEXIST" ? "evidence_target_exists" : "evidence_write_failed",
      code === "EEXIST"
        ? "The evidence target already exists; production evidence is never overwritten."
        : "The evidence target could not be reserved as a new file.",
    );
  }
}

async function removeUncommittedEvidence(
  handle: FileHandle,
  absoluteOutput: string,
) {
  try {
    await handle.close();
  } catch {
    // Preserve the original load failure.
  }
  try {
    await unlink(absoluteOutput);
  } catch {
    // A crash-safe empty reservation may require manual cleanup, but it cannot
    // be mistaken for qualifying JSONL evidence.
  }
}

export async function runLoadCommand(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  suppliedDependencies: Partial<LoadHarnessDependencies> = {},
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
): Promise<LoadCommandResult> {
  const options = parseLoadCommandArguments(argv);
  const value = await readExternalScenario(
    options.scenarioPath,
    repositoryRoot,
  );
  const dependencies = { ...defaultDependencies(), ...suppliedDependencies };
  const scenario = validateWritingLoadScenario(value, dependencies.now());

  // Validation is deliberately the default. It reads and checks the external
  // scenario but performs no network request and writes no evidence.
  if (!options.execute) {
    return {
      mode: "validation_only",
      actor_count: scenario.actors.length,
      load_attestation_id: scenario.load_attestation_id,
    };
  }
  if (
    environment[CONFIRMATION_ENVIRONMENT_VARIABLE] !==
    scenario.load_attestation_id
  ) {
    throw new LoadHarnessError(
      "execution_not_confirmed",
      `Set ${CONFIRMATION_ENVIRONMENT_VARIABLE} to the scenario load_attestation_id for this authorized window.`,
    );
  }
  const reservation = await reserveEvidenceFile(options.outputPath!);
  try {
    const result = await executeProductionWritingLoad(value, dependencies);
    const source = `${result.evidence.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await reservation.handle.writeFile(source, { encoding: "utf8" });
    await reservation.handle.sync();
    await reservation.handle.close();
    return {
      mode: "executed",
      actor_count: result.actor_count,
      load_attestation_id: result.load_attestation_id,
      row_count: result.evidence.length,
    };
  } catch (error) {
    await removeUncommittedEvidence(
      reservation.handle,
      reservation.absoluteOutput,
    );
    throw error instanceof LoadHarnessError
      ? error
      : new LoadHarnessError(
          "evidence_write_failed",
          "The complete evidence set could not be committed safely.",
        );
  }
}

async function main() {
  const result = await runLoadCommand(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    if (error instanceof LoadHarnessError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error("load_harness_failed: The production load harness failed.");
    }
    process.exitCode = 1;
  });
}
