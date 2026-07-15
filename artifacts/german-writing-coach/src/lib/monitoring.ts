import * as Sentry from "@sentry/react";
import { launchConfig } from "@/lib/launchConfig";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|apikey|api_key|x-api-key|token|secret|password|email|name|prompt|original_text|answer|student_answer|correct_answer|feedback_text|auth)/i;
const SAFE_TELEMETRY_KEY_PATTERN =
  /^(safe_error_code|status|stage|route|role|release|environment|duration_ms|attempt_number)$/i;
const TECHNICAL_ERROR_PATTERN =
  /(edge function returned|non-2xx|deepseek|provider|model|stack trace|violates row-level security|jwt|postgres|duplicate key|invalid input syntax|pgrst|supabase is not configured|api key|service role|secret)/i;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/i;
const SAFE_FUNCTION_PATTERN = /^[a-z_$][a-z0-9_.$<>-]{0,100}$/i;
const SAFE_FILE_SEGMENT_PATTERN = /^[a-z0-9_.-]{1,120}$/i;
const SAFE_EXCEPTION_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
  "AbortError",
]);

function safeTelemetryString(value: string) {
  const trimmed = value.trim().slice(0, 160);
  return /^[a-zA-Z0-9_./:@-]+$/.test(trimmed) ? trimmed : "[Redacted]";
}

const UUID_ROUTE_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeMonitoringRoute(value: string) {
  const [pathname] = value.trim().split(/[?#]/, 1);
  if (!pathname?.startsWith("/")) return "unknown";
  const normalized = pathname
    .split("/")
    .map((segment) => UUID_ROUTE_SEGMENT.test(segment) ? ":id" : segment)
    .join("/");
  return normalized ? safeTelemetryString(normalized) : "unknown";
}

export function scrubMonitoringValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Redacted]";
  if (typeof value === "string") return "[Redacted]";
  if (Array.isArray(value)) {
    return value.map((item) => scrubMonitoringValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const scrubbed: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      scrubbed[key] = "[Redacted]";
    } else if (SAFE_TELEMETRY_KEY_PATTERN.test(key)) {
      scrubbed[key] =
        typeof nestedValue === "string"
          ? key.toLowerCase() === "route"
            ? normalizeMonitoringRoute(nestedValue)
            : safeTelemetryString(nestedValue)
          : scrubMonitoringValue(nestedValue, depth + 1);
    } else {
      scrubbed[key] = scrubMonitoringValue(nestedValue, depth + 1);
    }
  }
  return scrubbed;
}

function safeErrorCategory(event: Record<string, unknown>) {
  const sources = [event.tags, event.extra, event.contexts];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      continue;
    const candidate = (source as Record<string, unknown>).safe_error_code;
    if (
      typeof candidate === "string" &&
      SAFE_ERROR_CODE_PATTERN.test(candidate)
    ) {
      return candidate.toLowerCase();
    }
  }
  return "unclassified_client_error";
}

function safeStackFilename(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  let pathname = value.split(/[?#]/, 1)[0] ?? "";
  try {
    pathname = new URL(pathname, "https://monitoring.invalid").pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (!segments.every((segment) => SAFE_FILE_SEGMENT_PATTERN.test(segment))) {
    return null;
  }
  const assetIndex = segments.lastIndexOf("assets");
  if (assetIndex >= 0 && segments[assetIndex + 1]) {
    return `/assets/${segments[assetIndex + 1]}`;
  }
  const sourceIndex = segments.lastIndexOf("src");
  if (sourceIndex >= 0) {
    return `/${segments.slice(sourceIndex, sourceIndex + 4).join("/")}`;
  }
  return null;
}

function safeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeExceptionProjection(
  event: Record<string, unknown>,
  safeErrorCode: string,
) {
  const exception = event.exception;
  if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
    return undefined;
  }
  const values = (exception as { values?: unknown }).values;
  const first =
    Array.isArray(values) && values[0] && typeof values[0] === "object"
      ? (values[0] as Record<string, unknown>)
      : null;
  if (!first) return undefined;

  const originalType = typeof first.type === "string" ? first.type : "";
  const type = SAFE_EXCEPTION_TYPES.has(originalType)
    ? originalType
    : "ClientError";
  const stacktrace = first.stacktrace;
  const originalFrames =
    stacktrace && typeof stacktrace === "object" && !Array.isArray(stacktrace)
      ? (stacktrace as { frames?: unknown }).frames
      : null;
  const frames = Array.isArray(originalFrames)
    ? originalFrames.slice(-30).flatMap((frame) => {
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          return [];
        }
        const record = frame as Record<string, unknown>;
        const filename = safeStackFilename(record.filename);
        const functionName =
          typeof record.function === "string" &&
          SAFE_FUNCTION_PATTERN.test(record.function)
            ? record.function
            : undefined;
        if (!filename && !functionName) return [];
        return [
          {
            filename: filename ?? "[Redacted]",
            function: functionName,
            lineno: safeInteger(record.lineno),
            colno: safeInteger(record.colno),
            in_app: record.in_app === true,
          },
        ];
      })
    : [];

  return {
    values: [
      {
        type,
        value: `Client error captured (${safeErrorCode})`,
        ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      },
    ],
  };
}

export function sanitizeMonitoringEvent<T extends Record<string, unknown>>(
  event: T,
): T {
  const safeErrorCode = safeErrorCategory(event);
  const safeException = safeExceptionProjection(event, safeErrorCode);
  const scrubbed = scrubMonitoringValue(event) as Record<string, unknown>;
  // Free-form exception, breadcrumb, request, and log text can contain student
  // writing even when the property name itself looks harmless. Remove those
  // channels and retain only stable tags/ids/statuses above.
  scrubbed.message =
    event.message == null ? undefined : "Client error captured";
  scrubbed.request = undefined;
  scrubbed.breadcrumbs = undefined;
  scrubbed.logentry = undefined;
  if (safeException) {
    scrubbed.exception = safeException;
    scrubbed.tags = {
      ...(scrubbed.tags && typeof scrubbed.tags === "object"
        ? (scrubbed.tags as Record<string, unknown>)
        : {}),
      safe_error_code: safeErrorCode,
    };
  }
  return scrubbed as T;
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
      return sanitizeMonitoringEvent(
        event as unknown as Record<string, unknown>,
      ) as unknown as typeof event;
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
  Sentry.setTag(
    "route",
    context.route ? normalizeMonitoringRoute(context.route) : "unknown",
  );
  // Workspace UUIDs are not required for alert grouping. Explicitly clear the
  // old tag on every transition so shared-browser errors cannot inherit it.
  Sentry.setTag("workspace_id", undefined);
  if (context.userId) {
    Sentry.setUser({ id: hashIdentifier(context.userId) });
  } else {
    Sentry.setUser(null);
  }
}

export function captureSafeException(
  error: unknown,
  extra?: Record<string, unknown>,
) {
  if (!launchConfig.sentryDsn) return;
  Sentry.captureException(error, {
    extra: scrubMonitoringValue(extra ?? {}) as Record<string, unknown>,
  });
}

export function isTechnicalErrorMessage(message: string) {
  return TECHNICAL_ERROR_PATTERN.test(message);
}
