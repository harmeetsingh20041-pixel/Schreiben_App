import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useBoundedPracticeRefresh } from "@/hooks/use-live-practice-attempt";
import { STUDENT_GRAMMAR_STATS_PAGE_SIZE } from "@/services/grammarStatsService";

export const PRACTICE_UNLOCK_FALLBACK_POLL_INTERVAL_MS = 5_000;
export const PRACTICE_UNLOCK_CONNECTED_SAFETY_POLL_INTERVAL_MS = 30_000;
export const PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS = 2 * 60_000;
export const PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function shouldRefreshPracticeFromSubmissionEvent(
  payload: unknown,
  workspaceId: string,
  studentId: string,
) {
  if (!isRecord(payload) || !isRecord(payload.new)) return false;
  return payload.new.workspace_id === workspaceId
    && payload.new.student_id === studentId
    && payload.new.release_status === "released";
}

/**
 * Realtime is the fast path from a released writing to its newly available
 * practice topic. A finite fallback closes subscription races/outages without
 * leaving the Practice page on a permanent five-second polling budget.
 */
export function usePracticeUnlockRealtime(args: {
  enabled: boolean;
  workspaceId: string;
  studentId: string;
}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const statsQueryKey = appQueryKeys.studentGrammarStats(
    args.workspaceId,
    args.studentId,
    STUDENT_GRAMMAR_STATS_PAGE_SIZE,
  );
  const assignmentsQueryKey = appQueryKeys.studentPracticeAssignments(
    args.workspaceId,
    args.studentId,
  );

  const fallback = useBoundedPracticeRefresh({
    enabled: args.enabled,
    intervalMs: connected
      ? PRACTICE_UNLOCK_CONNECTED_SAFETY_POLL_INTERVAL_MS
      : PRACTICE_UNLOCK_FALLBACK_POLL_INTERVAL_MS,
    windowMs: PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS,
    onRefresh: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statsQueryKey }),
        queryClient.invalidateQueries({ queryKey: assignmentsQueryKey }),
      ]);
    },
  });

  useEffect(() => {
    if (!args.enabled) return;
    const syncVisibility = () => {
      setPageVisible(document.visibilityState === "visible");
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [args.enabled]);

  useEffect(() => {
    if (
      !args.enabled
      || connected
      || !pageVisible
      || !fallback.pollingExpired
    ) {
      return;
    }

    // A writing provider retry can outlive the fast two-minute window. Keep a
    // single low-frequency refresh alive for the rest of the visible Practice
    // session so a Realtime outage cannot strand a later release. Focus or a
    // recovered subscription returns the hook to its normal bounded fast path.
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void fallback.refreshNow().catch(() => undefined);
      }
    }, PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [
    args.enabled,
    connected,
    fallback.pollingExpired,
    fallback.refreshNow,
    pageVisible,
  ]);

  useEffect(() => {
    if (!args.enabled) {
      setConnected(false);
      return;
    }

    const client = getSupabaseClient();
    if (!client) return;

    let disposed = false;
    setConnected(false);
    fallback.restartPolling();

    const channel = client
      .channel(
        `practice-unlock:${args.workspaceId}:${args.studentId}:${crypto.randomUUID()}`,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "api",
          table: "submission_status_events",
          filter: `workspace_id=eq.${args.workspaceId}`,
        },
        (payload) => {
          if (
            shouldRefreshPracticeFromSubmissionEvent(
              payload,
              args.workspaceId,
              args.studentId,
            )
          ) {
            void fallback.refreshNow().catch(() => undefined);
          }
        },
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          setConnected(true);
          // Catch a release committed between the initial query and the
          // subscription acknowledgement.
          void fallback.refreshNow().catch(() => undefined);
          return;
        }
        if (
          status === "CHANNEL_ERROR"
          || status === "TIMED_OUT"
          || status === "CLOSED"
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
    args.enabled,
    args.studentId,
    args.workspaceId,
    fallback.refreshNow,
    fallback.restartPolling,
  ]);

  return {
    connected,
    pollingExpired: fallback.pollingExpired,
  };
}
