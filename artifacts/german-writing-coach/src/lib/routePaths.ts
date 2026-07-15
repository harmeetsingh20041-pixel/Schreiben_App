export const TEACHER_OVERVIEW_PATH = "/teacher/dashboard";

export function isTeacherOverviewPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized.endsWith(TEACHER_OVERVIEW_PATH);
}
