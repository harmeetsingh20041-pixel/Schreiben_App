import { beforeEach, describe, expect, it, vi } from "vitest";

const getSupabaseClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabaseClient", () => ({ getSupabaseClient }));

import {
  completeOnboardingStep,
  getOnboardingProgress,
  markOnboardingStep,
} from "@/services/onboardingService";

function progress(overrides: Record<string, unknown> = {}) {
  return {
    role: "teacher",
    revision: 0,
    steps: [
      "create_class",
      "choose_feedback_mode",
      "share_join_code",
      "review_first_submission",
    ],
    completed_steps: [],
    completed_count: 0,
    total_count: 4,
    all_complete: false,
    next_step: "create_class",
    ...overrides,
  };
}

describe("persistent onboarding service", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("parses the fixed role-scoped checklist contract", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: progress(), error: null });
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(getOnboardingProgress("workspace-1", "teacher")).resolves.toMatchObject({
      role: "teacher",
      revision: 0,
      next_step: "create_class",
    });
    expect(rpc).toHaveBeenCalledWith("get_onboarding_progress", {
      target_workspace_id: "workspace-1",
      target_role: "teacher",
    });
  });

  it("fails closed when the server mixes teacher and student steps", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: progress({ steps: ["create_class", "review_feedback"] }),
      error: null,
    });
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(getOnboardingProgress("workspace-1", "teacher")).rejects.toMatchObject({
      code: "data_invalid_response",
    });
  });

  it("does not send a step outside the active role contract", async () => {
    const rpc = vi.fn();
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(completeOnboardingStep(
      "workspace-1",
      "teacher",
      "review_feedback",
      0,
    )).rejects.toMatchObject({ code: "data_invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reloads and retries once after an optimistic revision conflict", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: progress(), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "40001" } })
      .mockResolvedValueOnce({ data: progress({ revision: 1 }), error: null })
      .mockResolvedValueOnce({
        data: progress({
          revision: 2,
          completed_steps: ["share_join_code"],
          completed_count: 1,
          next_step: "create_class",
        }),
        error: null,
      });
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(markOnboardingStep(
      "workspace-1",
      "teacher",
      "share_join_code",
    )).resolves.toMatchObject({ revision: 2, completed_steps: ["share_join_code"] });

    expect(rpc).toHaveBeenNthCalledWith(2, "complete_onboarding_step", expect.objectContaining({
      target_step: "share_join_code",
      expected_revision: 0,
    }));
    expect(rpc).toHaveBeenNthCalledWith(4, "complete_onboarding_step", expect.objectContaining({
      target_step: "share_join_code",
      expected_revision: 1,
    }));
  });
});
