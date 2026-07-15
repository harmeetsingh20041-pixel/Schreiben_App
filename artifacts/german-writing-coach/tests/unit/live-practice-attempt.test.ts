import { readFileSync } from "node:fs";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

import {
  isKickablePracticeEvaluationStatus,
  isLivePracticeEvaluationStatus,
  useBoundedPracticeRefresh,
  useLivePracticeAttempt,
} from "@/hooks/use-live-practice-attempt";

const worksheetPage = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/worksheet.tsx"),
  "utf8",
);
const worksheetService = readFileSync(
  path.resolve(process.cwd(), "src/services/practiceWorksheetService.ts"),
  "utf8",
);

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
    emitUpdate: () => updateListener?.(),
    emitStatus: (status: string) => statusListener?.(status),
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T08:00:00.000Z"));
  mocks.getSupabaseClient.mockReset();
  mocks.getSupabaseClient.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("durable practice-answer status contract", () => {
  it("refreshes pending work but only kicks durable queued attempts", () => {
    expect(isLivePracticeEvaluationStatus("pending")).toBe(true);
    expect(isLivePracticeEvaluationStatus("queued")).toBe(true);
    expect(isLivePracticeEvaluationStatus("evaluating")).toBe(true);
    expect(isLivePracticeEvaluationStatus("completed")).toBe(false);
    expect(isLivePracticeEvaluationStatus("failed")).toBe(false);
    expect(isKickablePracticeEvaluationStatus("pending")).toBe(false);
    expect(isKickablePracticeEvaluationStatus("queued")).toBe(true);
    expect(isKickablePracticeEvaluationStatus("evaluating")).toBe(true);
  });

  it("backs off, removes its timer at the finite deadline, and restarts on focus", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        onRefresh,
        windowMs: 16_000,
      }),
    );

    await advance(5_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.pollingExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(rendered.result.current.pollingExpired).toBe(false);
    await advance(5_000);
    expect(onRefresh).toHaveBeenCalledTimes(4);

    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts a bounded window when the page becomes visible", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const onRefresh = vi.fn(async () => undefined);
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        onRefresh,
        windowMs: 5_000,
      }),
    );

    await advance(5_000);
    expect(rendered.result.current.pollingExpired).toBe(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.pollingExpired).toBe(false);

    rendered.unmount();
    visibility.mockRestore();
  });

  it("keeps worksheet generation refreshes responsive while still stopping at its deadline", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        intervalMs: 2_000,
        onRefresh,
        windowMs: 7_000,
      }),
    );

    await advance(2_000);
    await advance(2_000);
    await advance(2_000);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    await advance(1_000);
    expect(rendered.result.current.pollingExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    rendered.unmount();
  });

  it("expires at the absolute deadline even when a status request never settles", async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => undefined));
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        intervalMs: 2_000,
        onRefresh,
        windowMs: 7_000,
      }),
    );

    await advance(7_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.pollingExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    rendered.unmount();
  });

  it("coalesces an update received during an active request into one trailing refresh", async () => {
    let resolveFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const onRefresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValue(undefined);
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        onRefresh,
        windowMs: 60_000,
      }),
    );

    await act(async () => {
      void rendered.result.current.refreshNow();
      void rendered.result.current.refreshNow();
      void rendered.result.current.refreshNow();
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await firstRequest;
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);

    rendered.unmount();
  });

  it("does not run a queued polling refresh after the absolute window expires", async () => {
    let resolveRequest!: () => void;
    const activeRequest = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const onRefresh = vi.fn(() => activeRequest);
    const rendered = renderHook(() =>
      useBoundedPracticeRefresh({
        enabled: true,
        onRefresh,
        windowMs: 5_000,
      }),
    );

    await act(async () => {
      void rendered.result.current.refreshNow();
      void rendered.result.current.refreshNow();
      await Promise.resolve();
    });
    await advance(5_000);
    expect(rendered.result.current.pollingExpired).toBe(true);

    await act(async () => {
      resolveRequest();
      await activeRequest;
      await Promise.resolve();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rendered.unmount();
  });

  it("uses Realtime while connected and starts finite fallback polling after a channel failure", async () => {
    const realtime = createRealtimeClient();
    const onRefresh = vi.fn(async () => undefined);
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    const rendered = renderHook(() =>
      useLivePracticeAttempt({
        attemptId: "attempt-1",
        enabled: true,
        onRefresh,
      }),
    );

    act(() => realtime.emitStatus("SUBSCRIBED"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => realtime.emitUpdate());
    expect(onRefresh).toHaveBeenCalledTimes(2);

    act(() => realtime.emitStatus("CHANNEL_ERROR"));
    await advance(5_000);
    expect(onRefresh).toHaveBeenCalledTimes(3);

    rendered.unmount();
    expect(realtime.client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("runs one trailing Realtime refresh when an update lands during subscription catch-up", async () => {
    let resolveCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => {
      resolveCatchUp = resolve;
    });
    const realtime = createRealtimeClient();
    const onRefresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(catchUp)
      .mockResolvedValue(undefined);
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    const rendered = renderHook(() =>
      useLivePracticeAttempt({
        attemptId: "attempt-1",
        enabled: true,
        onRefresh,
      }),
    );

    act(() => {
      realtime.emitStatus("SUBSCRIBED");
      realtime.emitUpdate();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCatchUp();
      await catchUp;
      await Promise.resolve();
    });
    await advance(0);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    rendered.unmount();
  });

  it("keeps one bounded safety poll while Realtime remains connected", async () => {
    const realtime = createRealtimeClient();
    const onRefresh = vi.fn(async () => undefined);
    mocks.getSupabaseClient.mockReturnValue(realtime.client);
    const rendered = renderHook(() =>
      useLivePracticeAttempt({
        attemptId: "attempt-1",
        enabled: true,
        onRefresh,
      }),
    );

    act(() => realtime.emitStatus("SUBSCRIBED"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    rendered.unmount();
  });

  it("keeps queued acknowledgements private and exposes safe manual refresh controls", () => {
    expect(worksheetService).toContain(
      "Practice feedback did not return a valid durable state.",
    );
    expect(worksheetService).not.toContain('data?.status ?? "completed"');
    expect(worksheetPage).toContain('title: "Feedback queued"');
    expect(worksheetPage).toContain(
      'assignment?.evaluation_status === "queued"',
    );
    expect(worksheetPage).toContain(
      "enabled: Boolean(assignment?.latest_attempt_id && hasLiveEvaluation)",
    );
    expect(worksheetPage).not.toContain(
      "enabled: Boolean(hasSubmittedForReview && hasLiveEvaluation)",
    );
    expect(worksheetPage).toContain("Refresh feedback status");
    expect(worksheetPage).toContain("Refresh status");
  });

  it("does not promise a student retry after bounded job failure", () => {
    expect(worksheetPage).toMatch(/your teacher can retry the\s+evaluation/);
    expect(worksheetPage).not.toContain(">Try again</Button>");
  });
});
