export type PerformanceRole = "teacher" | "student";

export type DetectedPerformanceAccount<T> = {
  role: PerformanceRole;
  value: T;
};

export function indexPerformanceAccountsByRole<T>(
  accounts: readonly DetectedPerformanceAccount<T>[],
): Record<PerformanceRole, T> {
  const teachers = accounts.filter((account) => account.role === "teacher");
  const students = accounts.filter((account) => account.role === "student");
  if (accounts.length !== 2 || teachers.length !== 1 || students.length !== 1) {
    throw new Error(
      "The performance run requires exactly one detected teacher and one detected student.",
    );
  }
  return {
    teacher: teachers[0].value,
    student: students[0].value,
  };
}
