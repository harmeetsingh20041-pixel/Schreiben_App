import * as Sentry from "@sentry/react";
import { launchConfig } from "@/lib/launchConfig";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|apikey|api_key|x-api-key|token|secret|password|email|name|prompt|original_text|answer|student_answer|correct_answer|feedback_text|auth)/i;
const TECHNICAL_ERROR_PATTERN =
  /(edge function returned|non-2xx|deepseek|provider|model|stack trace|violates row-level security|jwt|postgres|duplicate key|invalid input syntax|pgrst|supabase is not configured|api key|service role|secret)/i;

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Redacted]";
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const scrubbed: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[Redacted]"
      : scrubValue(nestedValue, depth + 1);
  }
  return scrubbed;
}

function hashIdentifier(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `u_${(hash >>> 0).toString(16)}`;
}

export function initMonitoring() {
  if (!launchConfig.sentryDsn) return;

  Sentry.init({
    dsn: launchConfig.sentryDsn,
    environment: launchConfig.sentryEnvironment || import.meta.env.MODE,
    release: launchConfig.appRelease || undefined,
    sendDefaultPii: false,
    integrations: launchConfig.enableSentryReplay
      ? [
          Sentry.replayIntegration({
            maskAllText: true,
            maskAllInputs: true,
            blockAllMedia: true,
          }),
        ]
      : [],
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: launchConfig.enableSentryReplay ? 0.01 : 0,
    beforeSend(event) {
      return scrubValue(event) as typeof event;
    },
  });

  Sentry.setTag("release", launchConfig.appRelease || "local");
}

export function setMonitoringContext(context: {
  role?: string | null;
  route?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
}) {
  if (!launchConfig.sentryDsn) return;
  Sentry.setTag("role", context.role ?? "anonymous");
  Sentry.setTag("route", context.route ?? "unknown");
  if (context.workspaceId) Sentry.setTag("workspace_id", context.workspaceId);
  if (context.userId) {
    Sentry.setUser({ id: hashIdentifier(context.userId) });
  } else {
    Sentry.setUser(null);
  }
}

export function captureSafeException(error: unknown, extra?: Record<string, unknown>) {
  if (!launchConfig.sentryDsn) return;
  Sentry.captureException(error, {
    extra: scrubValue(extra ?? {}) as Record<string, unknown>,
  });
}

export function isTechnicalErrorMessage(message: string) {
  return TECHNICAL_ERROR_PATTERN.test(message);
}
