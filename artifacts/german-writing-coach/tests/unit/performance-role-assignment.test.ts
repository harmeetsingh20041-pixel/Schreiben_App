import { describe, expect, it } from "vitest";
import { indexPerformanceAccountsByRole } from "../e2e/performance-role-assignment";

describe("performance account role assignment", () => {
  it("maps reversed credential labels by detected role without retrying either account", () => {
    const studentSession = { slot: "TEACHER", signInAttempts: 1 };
    const teacherSession = { slot: "STUDENT", signInAttempts: 1 };

    const byRole = indexPerformanceAccountsByRole([
      { role: "student", value: studentSession },
      { role: "teacher", value: teacherSession },
    ]);

    expect(byRole.teacher).toBe(teacherSession);
    expect(byRole.student).toBe(studentSession);
    expect(byRole.teacher.signInAttempts).toBe(1);
    expect(byRole.student.signInAttempts).toBe(1);
  });

  it("fails closed when the two accounts do not resolve to distinct roles", () => {
    expect(() =>
      indexPerformanceAccountsByRole([
        { role: "student", value: { slot: "TEACHER" } },
        { role: "student", value: { slot: "STUDENT" } },
      ]),
    ).toThrow(/exactly one detected teacher and one detected student/);
  });
});
