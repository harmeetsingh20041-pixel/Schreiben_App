import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabaseClient";
import {
  getStudentSubmissionDetail,
  getTeacherSubmissionDetail,
  type WritingFeedback,
  type WritingSubmission,
  type WritingSubmissionDetail,
} from "@/services/submissionService";

export const FALLBACK_POLL_WINDOW_MS = 5 * 60_000;
export const FALLBACK_POLL_BACKOFF_MS = [
  5_000, 10_000, 20_000, 30_000,
] as const;
export const SUBMISSION_SAFETY_POLL_MS = 30_000;

// Browsers clamp larger timeouts inconsistently. A long scheduled release uses
// bounded wake-up chunks and recalculates the remaining delay without polling.
const MAX_BROWSER_TIMEOUT_MS = 2_147_000_000;

interface SubmissionDetailResult {
  submission: WritingSubmission | null;
  feedback: WritingFeedback | null;
}

interface FallbackWindow {
  startedAt: number;
  until: number;
}

type SubmissionRefreshState =
  | { kind: "active" }
  | { kind: "scheduled"; releaseAt: number }
  | { kind: "externally_mutable" }
  | { kind: "terminal" };

export const submissionQueryKeys = {
  studentDetail: (
    submissionId: string,
    studentId: string,
    workspaceId: string,
  ) =>
    ["submissions", "student", workspaceId, studentId, submissionId] as const,
  teacherDetail: (submissionId: string, workspaceId: string) =>
    ["submissions", "teacher", workspaceId, submissionId] as const,
};

function createFallbackWindow(now = Date.now()): FallbackWindow {
  return {
    startedAt: now,
    until: now + FALLBACK_POLL_WINDOW_MS,
  };
}

export function getSubmissionRefreshState(
  submission: WritingSubmission | null | undefined,
): SubmissionRefreshState {
  if (!submission) return { kind: "terminal" };

  if (submission.release_status === "released") {
    return { kind: "terminal" };
  }

  if (
    submission.evaluation_status === "queued" ||
    submission.evaluation_status === "processing"
  ) {
    return { kind: "active" };
  }

  if (
    submission.evaluation_status === "ready" &&
    submission.release_status === "scheduled" &&
    submission.release_at
  ) {
    const releaseAt = new Date(submission.release_at).getTime();
    if (Number.isFinite(releaseAt)) return { kind: "scheduled", releaseAt };
  }

  // Ready, needs-review, and failed held rows can change because another
  // teacher may release or retry them. Realtime remains the fast path, but a
  // bounded low-frequency check prevents one missed event from stranding an
  // open page indefinitely.
  if (submission.release_status === "held") {
    return { kind: "externally_mutable" };
  }

  return { kind: "terminal" };
}

export function getSubmissionPollBackoff(attempt: number) {
  const index = Math.min(
    Math.max(0, Math.trunc(attempt)),
    FALLBACK_POLL_BACKOFF_MS.length - 1,
  );
  return FALLBACK_POLL_BACKOFF_MS[index];
}

function useSubmissionRealtime(
  submissionId: string | undefined,
  queryKey: readonly unknown[],
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [fallbackWindow, setFallbackWindow] = useState(createFallbackWindow);
  const queryKeyRef = useRef(queryKey);
  const lastResumeRefetchAtRef = useRef(0);
  queryKeyRef.current = queryKey;

  const restartFallbackWindow = useCallback(() => {
    setFallbackWindow(createFallbackWindow());
  }, []);

  useEffect(() => {
    if (!enabled || !submissionId) return;

    const refetchAfterResume = () => {
      restartFallbackWindow();
      const now = Date.now();
      // Browsers commonly dispatch visibilitychange and focus together. Keep
      // the refresh immediate while coalescing that pair into one request.
      if (now - lastResumeRefetchAtRef.current < 250) return;
      lastResumeRefetchAtRef.current = now;
      void queryClient.refetchQueries(
        { queryKey: queryKeyRef.current, type: "active" },
        { cancelRefetch: false },
      );
    };
    const handleFocus = () => {
      refetchAfterResume();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refetchAfterResume();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, queryClient, restartFallbackWindow, submissionId]);

  useEffect(() => {
    if (!enabled || !submissionId) {
      setConnected(false);
      return;
    }

    const client = getSupabaseClient();
    if (!client) return;

    let disposed = false;
    setConnected(false);
    restartFallbackWindow();

    const channel = client
      .channel(`submission-state:${submissionId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "api",
          table: "submission_status_events",
          filter: `id=eq.${submissionId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
        },
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          setConnected(true);
          return;
        }
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setConnected(false);
          restartFallbackWindow();
        }
      });

    return () => {
      disposed = true;
      setConnected(false);
      void client.removeChannel(channel);
    };
  }, [enabled, queryClient, restartFallbackWindow, submissionId]);

  return { connected, fallbackWindow, restartFallbackWindow };
}

function useSubmissionFallbackPolling(args: {
  enabled: boolean;
  connected: boolean;
  isFetching: boolean;
  submission: WritingSubmission | null | undefined;
  dataUpdatedAt: number;
  fallbackWindow: FallbackWindow;
  restartFallbackWindow: () => void;
  refetch: () => Promise<unknown>;
}) {
  const attemptRef = useRef(0);
  const [timerVersion, setTimerVersion] = useState(0);
  const refreshState = getSubmissionRefreshState(args.submission);
  const refreshIdentity = args.submission
    ? `${args.submission.evaluation_status}:${args.submission.release_status}:${args.submission.release_at ?? ""}`
    : "missing";
  const previousRefreshIdentityRef = useRef(refreshIdentity);

  useEffect(() => {
    attemptRef.current = 0;
    if (previousRefreshIdentityRef.current !== refreshIdentity) {
      previousRefreshIdentityRef.current = refreshIdentity;
      args.restartFallbackWindow();
    }
  }, [
    args.fallbackWindow.startedAt,
    args.restartFallbackWindow,
    refreshIdentity,
  ]);

  useEffect(() => {
    if (!args.enabled || args.isFetching || refreshState.kind === "terminal")
      return;

    const now = Date.now();
    let delay: number;
    let startsReleaseWindow = false;

    if (refreshState.kind === "scheduled" && refreshState.releaseAt > now) {
      delay = Math.min(refreshState.releaseAt - now, MAX_BROWSER_TIMEOUT_MS);
      startsReleaseWindow = true;
    } else if (
      refreshState.kind === "externally_mutable" ||
      (refreshState.kind === "active" && args.connected)
    ) {
      if (now >= args.fallbackWindow.until) return;
      delay = Math.min(
        SUBMISSION_SAFETY_POLL_MS,
        args.fallbackWindow.until - now,
      );
    } else {
      if (now >= args.fallbackWindow.until) return;
      delay = Math.min(
        getSubmissionPollBackoff(attemptRef.current),
        args.fallbackWindow.until - now,
      );
    }

    let disposed = false;
    const timeoutId = window.setTimeout(() => {
      if (disposed) return;

      const firedAt = Date.now();
      if (
        startsReleaseWindow &&
        refreshState.kind === "scheduled" &&
        firedAt < refreshState.releaseAt
      ) {
        // The scheduled time is farther away than the browser's safe timeout
        // range. Recompute another bounded wake-up without making a request.
        setTimerVersion((version) => version + 1);
        return;
      }

      if (startsReleaseWindow) {
        attemptRef.current = 0;
        args.restartFallbackWindow();
      } else {
        if (firedAt >= args.fallbackWindow.until) return;
        attemptRef.current += 1;
      }

      void args.refetch().finally(() => {
        if (!disposed) setTimerVersion((version) => version + 1);
      });
    }, delay);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    args.connected,
    args.dataUpdatedAt,
    args.enabled,
    args.fallbackWindow.until,
    args.isFetching,
    args.refetch,
    args.restartFallbackWindow,
    refreshIdentity,
    refreshState.kind,
    refreshState.kind === "scheduled" ? refreshState.releaseAt : null,
    timerVersion,
  ]);
}

function useSubmissionDetailQuery(args: {
  queryKey: readonly unknown[];
  submissionId?: string;
  enabled: boolean;
  loadDetail: () => Promise<WritingSubmissionDetail | null>;
}) {
  const realtime = useSubmissionRealtime(
    args.submissionId,
    args.queryKey,
    args.enabled,
  );

  const query = useQuery<SubmissionDetailResult>({
    queryKey: args.queryKey,
    enabled: args.enabled && Boolean(args.submissionId),
    queryFn: async () => {
      const detail = await args.loadDetail();
      return detail ?? { submission: null, feedback: null };
    },
    staleTime: 5_000,
  });

  useSubmissionFallbackPolling({
    enabled: args.enabled && Boolean(args.submissionId),
    connected: realtime.connected,
    isFetching: query.isFetching,
    submission: query.data?.submission,
    dataUpdatedAt: query.dataUpdatedAt,
    fallbackWindow: realtime.fallbackWindow,
    restartFallbackWindow: realtime.restartFallbackWindow,
    refetch: query.refetch,
  });

  return query;
}

export function useLiveStudentSubmission(args: {
  submissionId?: string;
  studentId?: string;
  workspaceId?: string | null;
  enabled: boolean;
}) {
  const queryKey = submissionQueryKeys.studentDetail(
    args.submissionId ?? "missing",
    args.studentId ?? "missing",
    args.workspaceId ?? "missing",
  );
  return useSubmissionDetailQuery({
    queryKey,
    submissionId: args.submissionId,
    enabled:
      args.enabled && Boolean(args.studentId) && Boolean(args.workspaceId),
    loadDetail: () =>
      getStudentSubmissionDetail(
        args.submissionId!,
        args.studentId!,
        args.workspaceId!,
      ),
  });
}

export function useLiveTeacherSubmission(args: {
  submissionId?: string;
  workspaceId?: string | null;
  enabled: boolean;
}) {
  const queryKey = submissionQueryKeys.teacherDetail(
    args.submissionId ?? "missing",
    args.workspaceId ?? "missing",
  );
  return useSubmissionDetailQuery({
    queryKey,
    submissionId: args.submissionId,
    enabled: args.enabled && Boolean(args.workspaceId),
    loadDetail: () =>
      getTeacherSubmissionDetail(args.workspaceId!, args.submissionId!),
  });
}
