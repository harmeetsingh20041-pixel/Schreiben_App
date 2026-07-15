import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { STUDENT_GRAMMAR_STATS_PAGE_SIZE } from "@/services/grammarStatsService";

const mocks = vi.hoisted(() => ({
  eventHandler: null as ((payload: unknown) => void) | null,
  statusHandler: null as ((status: string) => void) | null,
  on: vi.fn(),
  subscribe: vi.fn(),
  removeChannel: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabaseClient", () => {
  const channel = {
    on: (...args: unknown[]) => {
      mocks.on(...args);
      mocks.eventHandler = args[2] as (payload: unknown) => void;
      return channel;
    },
    subscribe: (handler: (status: string) => void) => {
      mocks.subscribe(handler);
      mocks.statusHandler = handler;
      return channel;
    },
  };
  return {
    getSupabaseClient: () => ({
      channel: vi.fn(() => channel),
      removeChannel: mocks.removeChannel,
    }),
  };
});

import {
  PRACTICE_UNLOCK_FALLBACK_POLL_INTERVAL_MS,
  PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS,
  PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS,
  shouldRefreshPracticeFromSubmissionEvent,
  usePracticeUnlockRealtime,
} from "@/hooks/use-practice-unlock-realtime";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";

describe("released-feedback practice refresh", () => {
  beforeEach(() => {
    mocks.eventHandler = null;
    mocks.statusHandler = null;
    mocks.on.mockClear();
    mocks.subscribe.mockClear();
    mocks.removeChannel.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts only the active learner's newly released status event", () => {
    expect(shouldRefreshPracticeFromSubmissionEvent({
      new: { workspace_id: workspaceId, student_id: studentId, release_status: "released" },
    }, workspaceId, studentId)).toBe(true);
    expect(shouldRefreshPracticeFromSubmissionEvent({
      new: { workspace_id: workspaceId, student_id: studentId, release_status: "held" },
    }, workspaceId, studentId)).toBe(false);
    expect(shouldRefreshPracticeFromSubmissionEvent({
      new: { workspace_id: workspaceId, student_id: "other", release_status: "released" },
    }, workspaceId, studentId)).toBe(false);
  });

  it("invalidates focus topics and assignments on subscription catch-up and release", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { unmount } = renderHook(() => usePracticeUnlockRealtime({
      enabled: true,
      workspaceId,
      studentId,
    }), { wrapper });

    await waitFor(() => expect(mocks.statusHandler).not.toBeNull());
    await act(async () => {
      mocks.statusHandler?.("SUBSCRIBED");
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: appQueryKeys.studentGrammarStats(
        workspaceId,
        studentId,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
      ),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: appQueryKeys.studentPracticeAssignments(workspaceId, studentId),
    });

    invalidate.mockClear();
    await act(async () => {
      mocks.eventHandler?.({
        new: { workspace_id: workspaceId, student_id: studentId, release_status: "released" },
      });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));

    invalidate.mockClear();
    await act(async () => {
      mocks.eventHandler?.({
        new: { workspace_id: workspaceId, student_id: studentId, release_status: "held" },
      });
    });
    expect(invalidate).not.toHaveBeenCalled();

    unmount();
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("uses a finite five-second fast window", () => {
    expect(PRACTICE_UNLOCK_FALLBACK_POLL_INTERVAL_MS).toBe(5_000);
    expect(PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS).toBe(120_000);
  });

  it("continues one low-frequency refresh after the fast fallback expires", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { unmount } = renderHook(() => usePracticeUnlockRealtime({
      enabled: true,
      workspaceId,
      studentId,
    }), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS);
    });
    const callsAtFastExpiry = invalidate.mock.calls.length;
    expect(callsAtFastExpiry).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS - 1,
      );
    });
    expect(invalidate).toHaveBeenCalledTimes(callsAtFastExpiry);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invalidate).toHaveBeenCalledTimes(callsAtFastExpiry + 2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS,
      );
    });
    expect(invalidate).toHaveBeenCalledTimes(callsAtFastExpiry + 4);

    unmount();
  });

  it("pauses lifecycle refresh while hidden and restarts on visibility", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { unmount } = renderHook(() => usePracticeUnlockRealtime({
      enabled: true,
      workspaceId,
      studentId,
    }), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRACTICE_UNLOCK_FALLBACK_POLL_WINDOW_MS);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const callsWhileHidden = invalidate.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PRACTICE_UNLOCK_LIFECYCLE_POLL_INTERVAL_MS * 2,
      );
    });
    expect(invalidate).toHaveBeenCalledTimes(callsWhileHidden);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(invalidate.mock.calls.length).toBeGreaterThan(callsWhileHidden);

    unmount();
  });
});
