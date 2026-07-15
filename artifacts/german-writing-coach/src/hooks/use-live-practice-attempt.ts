import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";

export const PRACTICE_FALLBACK_POLL_WINDOW_MS = 5 * 60_000;
export const PRACTICE_CONNECTED_SAFETY_POLL_INTERVAL_MS = 30_000;
export const PRACTICE_FALLBACK_POLL_BACKOFF_MS = [
  5_000, 10_000, 20_000, 30_000,
] as const;

interface PracticePollWindow {
  startedAt: number;
  until: number;
}

function createPracticePollWindow(
  windowMs: number,
  now = Date.now(),
): PracticePollWindow {
  return { startedAt: now, until: now + windowMs };
}

export function getPracticePollBackoff(attempt: number) {
  const index = Math.min(
    Math.max(0, Math.trunc(attempt)),
    PRACTICE_FALLBACK_POLL_BACKOFF_MS.length - 1,
  );
  return PRACTICE_FALLBACK_POLL_BACKOFF_MS[index];
}

export function isLivePracticeEvaluationStatus(
  status: string | null | undefined,
) {
  return status === "pending" || status === "queued" || status === "evaluating";
}

export function isKickablePracticeEvaluationStatus(
  status: string | null | undefined,
) {
  return status === "queued" || status === "evaluating";
}

/**
 * Keeps one status request in flight at a time, backs requests off, and removes
 * every timer at the end of a finite window. Returning to the tab starts a new
 * finite window so a long provider retry can still recover without a reload.
 */
export function useBoundedPracticeRefresh(args: {
  enabled: boolean;
  onRefresh: () => Promise<void> | void;
  intervalMs?: number;
  windowMs?: number;
}) {
  const windowMs = args.windowMs ?? PRACTICE_FALLBACK_POLL_WINDOW_MS;
  const fixedIntervalMs = args.intervalMs
    ? Math.max(1_000, Math.trunc(args.intervalMs))
    : null;
  const refreshRef = useRef(args.onRefresh);
  const enabledRef = useRef(args.enabled);
  const attemptRef = useRef(0);
  const inFlightRef = useRef(false);
  const trailingRefreshRef = useRef(false);
  const mountedRef = useRef(true);
  const [timerVersion, setTimerVersion] = useState(0);
  const [pollWindow, setPollWindow] = useState(() =>
    createPracticePollWindow(windowMs),
  );
  const pollUntilRef = useRef(pollWindow.until);
  const [pollingExpired, setPollingExpired] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  refreshRef.current = args.onRefresh;
  enabledRef.current = args.enabled;
  pollUntilRef.current = pollWindow.until;

  const restartPolling = useCallback(() => {
    attemptRef.current = 0;
    setPollingExpired(false);
    setPollWindow(createPracticePollWindow(windowMs));
  }, [windowMs]);

  const refreshNow = useCallback(async function runRefresh() {
    if (inFlightRef.current) {
      trailingRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    if (mountedRef.current) setIsRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
      const shouldRunTrailing =
        trailingRefreshRef.current &&
        mountedRef.current &&
        enabledRef.current &&
        Date.now() < pollUntilRef.current;
      trailingRefreshRef.current = false;
      if (shouldRunTrailing) {
        queueMicrotask(() => {
          if (
            mountedRef.current &&
            enabledRef.current &&
            Date.now() < pollUntilRef.current
          ) {
            void runRefresh().catch(() => undefined);
          }
        });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      trailingRefreshRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!args.enabled) {
      trailingRefreshRef.current = false;
      setPollingExpired(false);
      return;
    }
    restartPolling();
  }, [args.enabled, restartPolling]);

  useEffect(() => {
    if (!args.enabled) return;

    const resumePolling = () => {
      restartPolling();
      void refreshNow().catch(() => undefined);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") resumePolling();
    };

    window.addEventListener("focus", resumePolling);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", resumePolling);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [args.enabled, refreshNow, restartPolling]);

  useEffect(() => {
    if (!args.enabled || pollingExpired) return;

    const now = Date.now();
    if (now >= pollWindow.until) {
      setPollingExpired(true);
      return;
    }

    const delay = Math.min(
      fixedIntervalMs ?? getPracticePollBackoff(attemptRef.current),
      pollWindow.until - now,
    );
    let disposed = false;
    const deadlineTimeoutId = window.setTimeout(() => {
      if (!disposed) setPollingExpired(true);
    }, pollWindow.until - now);
    const timeoutId = window.setTimeout(() => {
      if (disposed) return;
      if (Date.now() >= pollWindow.until) {
        setPollingExpired(true);
        return;
      }

      attemptRef.current += 1;
      void refreshNow().catch(() => undefined);
      setTimerVersion((version) => version + 1);
    }, delay);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      window.clearTimeout(deadlineTimeoutId);
    };
  }, [
    args.enabled,
    fixedIntervalMs,
    pollWindow.until,
    pollingExpired,
    refreshNow,
    timerVersion,
  ]);

  return {
    isRefreshing,
    pollingExpired,
    pollingUntil: pollWindow.until,
    refreshNow,
    restartPolling,
  };
}

export function useLivePracticeAttempt(args: {
  attemptId?: string | null;
  enabled: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const refreshRef = useRef(args.onRefresh);
  const [connected, setConnected] = useState(false);
  refreshRef.current = args.onRefresh;

  const fallback = useBoundedPracticeRefresh({
    enabled: Boolean(args.enabled && args.attemptId),
    intervalMs: connected
      ? PRACTICE_CONNECTED_SAFETY_POLL_INTERVAL_MS
      : undefined,
    onRefresh: () => refreshRef.current(),
  });

  useEffect(() => {
    if (!args.enabled || !args.attemptId) {
      setConnected(false);
      return;
    }

    const client = getSupabaseClient();
    if (!client) return;

    let disposed = false;
    setConnected(false);

    const channel = client
      .channel(
        `practice-attempt-state:${args.attemptId}:${crypto.randomUUID()}`,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "api",
          table: "practice_attempt_status_events",
          filter: `id=eq.${args.attemptId}`,
        },
        () => {
          void fallback.refreshNow().catch(() => undefined);
        },
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          setConnected(true);
          // Catch a terminal update that landed between the initial detail read
          // and the subscription acknowledgement.
          void fallback.refreshNow().catch(() => undefined);
          return;
        }
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setConnected(false);
          fallback.restartPolling();
        }
      });

    return () => {
      disposed = true;
      setConnected(false);
      void client.removeChannel(channel);
    };
  }, [
    args.attemptId,
    args.enabled,
    fallback.refreshNow,
    fallback.restartPolling,
  ]);

  return { connected, ...fallback };
}
