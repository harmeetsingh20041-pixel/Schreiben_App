import { describe, expect, it, vi } from "vitest";
import { preloadTeacherDashboardForPath } from "@/App";

describe("Teacher Overview route chunk preload", () => {
  it("starts the Overview chunk before protected-route authorization finishes", async () => {
    const module = { default: () => null };
    const loader = vi.fn(async () => module);

    await preloadTeacherDashboardForPath("/teacher/dashboard", loader as never);
    await preloadTeacherDashboardForPath(
      "/app/teacher/dashboard/",
      loader as never,
    );

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not preload Overview code for unrelated routes", () => {
    const loader = vi.fn();

    expect(
      preloadTeacherDashboardForPath("/student/dashboard", loader as never),
    ).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});
