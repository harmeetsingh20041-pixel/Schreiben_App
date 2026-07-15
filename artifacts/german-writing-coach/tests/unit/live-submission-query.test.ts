import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WritingEvaluationStatus,
  WritingReleaseStatus,
  WritingSubmission,
  WritingSubmissionDetail,
} from "@/services/submissionService";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
  getStudentSubmissionDetail: vi.fn(),
  getTeacherSubmissionDetail: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

vi.mock("@/services/submissionService", () => ({
  getStudentSubmissionDetail: mocks.getStudentSubmissionDetail,
  getTeacherSubmissionDetail: mocks.getTeacherSubmissionDetail,
}));

import {
  FALLBACK_POLL_WINDOW_MS,
  SUBMISSION_SAFETY_POLL_MS,
  useLiveStudentSubmission,
} from "@/hooks/use-live-submission";

const START_TIME = new Date("2026-07-11T08:00:00.000Z");

function submissionDetail(args: {
  evaluationStatus: WritingEvaluationStatus;
  releaseStatus: WritingReleaseStatus;
  releaseAt?: string | null;
}): WritingSubmissionDetail {
  return {
    submission: {
      id: "submission-1",
      evaluation_status: args.evaluationStatus,
      release_status: args.releaseStatus,
      release_at: args.releaseAt ?? null,
    } as WritingSubmission,
    feedback: null,
  };
}

function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return { client, Wrapper };
}

function renderStudentHook() {
  const { client, Wrapper } = queryWrapper();
  const rendered = renderHook(
    () =>
      useLiveStudentSubmission({
        submissionId: "submission-1",
        studentId: "student-1",
        workspaceId: "workspace-1",
        enabled: true,
      }),
    { wrapper: Wrapper },
  );
  return { ...rendered, client };
}

async function flushQuery() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function createRealtimeClient() {
  let updateListener: (() => void) | undefined;
  let statusListener: ((status: string) => void) | undefined;

  const channel = {
    on: vi.fn((_event: string, _filter: unknown, callback: () => void) => {
      updateListener = callback;
      return channel;
    }),
    subscribe: vi.fn((callback: (status: string) => void) => {
      statusListener = callback;
      return channel;
    }),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => undefined),
  };

  return {
    client,
    channel,
    emitUpdate: () => updateListener?.(),
    emitStatus: (status: string) => statusListener?.(status),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  mocks.getSupabaseClient.mockReturnValue(null);
  mocks.getStudentSubmissionDetail.mockReset();
  mocks.getTeacherSubmissionDetail.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("live submission status contract", () => {
  it("backs off queued fallback requests and stops at five minutes", async () => {
    mocks.getStudentSubmissionDetail.mockResolvedValue(
      submissionDetail({
        evaluationStatus: "queued",
        releaseStatus: "held",
      }),
    );
    const rendered = renderStudentHook();

    await flushQuery();
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);

    await advance(5_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(3);
    await advance(20_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(4);
    await advance(4 * FALLBACK_POLL_WINDOW_MS);
    const callsAtWindowEnd = mocks.getStudentSubmissionDetail.mock.calls.length;
    expect(callsAtWindowEnd).toBeGreaterThan(4);
    await advance(10 * FALLBACK_POLL_WINDOW_MS);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
      callsAtWindowEnd,
    );

    rendered.unmount();
    rendered.client.clear();
  });

  it("refetches immediately on focus or a visible-tab return and coalesces paired resume events", async () => {
    mocks.getStudentSubmissionDetail.mockResolvedValue(
      submissionDetail({
        evaluationStatus: "ready",
        releaseStatus: "released",
      }),
    );
    const rendered = renderStudentHook();

    await flushQuery();
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushQuery();
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);

    await advance(250);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flushQuery();
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(3);

    rendered.unmount();
    rendered.client.clear();
  });

  it("waits without polling for a future release, refetches exactly at release time, and stops when released", async () => {
    const releaseAt = new Date(
      START_TIME.getTime() + 10 * 60_000,
    ).toISOString();
    mocks.getStudentSubmissionDetail
      .mockResolvedValueOnce(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "scheduled",
          releaseAt,
        }),
      )
      .mockResolvedValue(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "released",
        }),
      );
    const rendered = renderStudentHook();

    await flushQuery();
    await advance(10 * 60_000 - 1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);
    await advance(20 * 60_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);

    rendered.unmount();
    rendered.client.clear();
  });

  it("bounds post-release polling when a scheduled row has not been released yet", async () => {
    const releaseAt = new Date(START_TIME.getTime() + 5 * 60_000).toISOString();
    mocks.getStudentSubmissionDetail.mockResolvedValue(
      submissionDetail({
        evaluationStatus: "ready",
        releaseStatus: "scheduled",
        releaseAt,
      }),
    );
    const rendered = renderStudentHook();

    await flushQuery();
    await advance(5 * 60_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);
    await advance(FALLBACK_POLL_WINDOW_MS + 10 * 60_000);
    const callsAtWindowEnd = mocks.getStudentSubmissionDetail.mock.calls.length;
    expect(callsAtWindowEnd).toBeGreaterThan(2);
    await advance(10 * FALLBACK_POLL_WINDOW_MS);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
      callsAtWindowEnd,
    );

    rendered.unmount();
    rendered.client.clear();
  });

  it.each([
    ["ready", "released"],
    ["failed", "released"],
  ] as const)(
    "does not poll terminal %s/%s submissions",
    async (evaluationStatus, releaseStatus) => {
      mocks.getStudentSubmissionDetail.mockResolvedValue(
        submissionDetail({
          evaluationStatus,
          releaseStatus,
        }),
      );
      const rendered = renderStudentHook();

      await flushQuery();
      await advance(20 * 60_000);
      expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);

      rendered.unmount();
      rendered.client.clear();
    },
  );

  it.each(["failed", "needs_review", "ready"] as const)(
    "safety-polls externally mutable held %s submissions at low frequency and stops at five minutes",
    async (evaluationStatus) => {
      mocks.getStudentSubmissionDetail.mockResolvedValue(
        submissionDetail({
          evaluationStatus,
          releaseStatus: "held",
        }),
      );
      const rendered = renderStudentHook();

      await flushQuery();
      await advance(SUBMISSION_SAFETY_POLL_MS - 1);
      expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);
      await advance(FALLBACK_POLL_WINDOW_MS + 10 * 60_000);
      const callsAtWindowEnd =
        mocks.getStudentSubmissionDetail.mock.calls.length;
      expect(callsAtWindowEnd).toBeGreaterThan(2);
      await advance(10 * FALLBACK_POLL_WINDOW_MS);
      expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
        callsAtWindowEnd,
      );

      rendered.unmount();
      rendered.client.clear();
    },
  );

  it("uses Realtime invalidation while subscribed and keeps a bounded active-state safety poll", async () => {
    const realtime = createRealtimeClient();
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    mocks.getStudentSubmissionDetail.mockResolvedValue(
      submissionDetail({
        evaluationStatus: "queued",
        releaseStatus: "held",
      }),
    );
    const rendered = renderStudentHook();

    await flushQuery();
    expect(realtime.channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "api",
        table: "submission_status_events",
        filter: "id=eq.submission-1",
      },
      expect.any(Function),
    );
    act(() => realtime.emitStatus("SUBSCRIBED"));
    await advance(SUBMISSION_SAFETY_POLL_MS - 1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);

    act(() => realtime.emitUpdate());
    await flushQuery();
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(3);

    await advance(FALLBACK_POLL_WINDOW_MS + 10 * 60_000);
    const callsAtWindowEnd = mocks.getStudentSubmissionDetail.mock.calls.length;
    await advance(10 * FALLBACK_POLL_WINDOW_MS);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
      callsAtWindowEnd,
    );

    rendered.unmount();
    expect(realtime.client.removeChannel).toHaveBeenCalledTimes(1);
    rendered.client.clear();
  });

  it("starts a fresh bounded recovery window when a queued row becomes externally mutable", async () => {
    const realtime = createRealtimeClient();
    let currentDetail = submissionDetail({
      evaluationStatus: "queued",
      releaseStatus: "held",
    });
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    mocks.getStudentSubmissionDetail.mockImplementation(async () =>
      currentDetail
    );
    const rendered = renderStudentHook();

    await flushQuery();
    act(() => realtime.emitStatus("SUBSCRIBED"));
    await advance(FALLBACK_POLL_WINDOW_MS - 10_000);

    currentDetail = submissionDetail({
      evaluationStatus: "ready",
      releaseStatus: "held",
    });
    act(() => realtime.emitUpdate());
    await flushQuery();
    const callsAfterTransition =
      mocks.getStudentSubmissionDetail.mock.calls.length;

    await advance(10_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
      callsAfterTransition,
    );
    await advance(SUBMISSION_SAFETY_POLL_MS - 10_000);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(
      callsAfterTransition + 1,
    );

    rendered.unmount();
    rendered.client.clear();
  });

  it("keeps the exact scheduled-release wake-up while Realtime is subscribed", async () => {
    const realtime = createRealtimeClient();
    const releaseAt = new Date(
      START_TIME.getTime() + 10 * 60_000,
    ).toISOString();
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    mocks.getStudentSubmissionDetail
      .mockResolvedValueOnce(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "scheduled",
          releaseAt,
        }),
      )
      .mockResolvedValue(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "released",
        }),
      );
    const rendered = renderStudentHook();

    await flushQuery();
    act(() => realtime.emitStatus("SUBSCRIBED"));
    await advance(10 * 60_000 - 1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);

    rendered.unmount();
    rendered.client.clear();
  });

  it("recovers a missed teacher-release event while Realtime remains subscribed", async () => {
    const realtime = createRealtimeClient();
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    mocks.getStudentSubmissionDetail
      .mockResolvedValueOnce(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "held",
        }),
      )
      .mockResolvedValue(
        submissionDetail({
          evaluationStatus: "ready",
          releaseStatus: "released",
        }),
      );
    const rendered = renderStudentHook();

    await flushQuery();
    act(() => realtime.emitStatus("SUBSCRIBED"));
    await advance(SUBMISSION_SAFETY_POLL_MS - 1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.getStudentSubmissionDetail).toHaveBeenCalledTimes(2);

    rendered.unmount();
    rendered.client.clear();
  });

  it("routes both detail pages through the shared live query", () => {
    const studentPage = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/submission.tsx"),
      "utf8",
    );
    const teacherPage = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/submission.tsx"),
      "utf8",
    );

    expect(studentPage).toContain("useLiveStudentSubmission");
    expect(teacherPage).toContain("useLiveTeacherSubmission");
    expect(studentPage).not.toContain("async function loadSubmission");
    expect(teacherPage).not.toContain("async function loadSubmission");
  });
});
