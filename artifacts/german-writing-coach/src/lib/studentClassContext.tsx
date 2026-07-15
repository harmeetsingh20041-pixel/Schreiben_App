import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createStudentAccessQueries } from "@/lib/dashboardQueries";
import type { StudentBatchAssignment } from "@/services/studentService";

const ACTIVE_STUDENT_CLASS_STORAGE_PREFIX = "gwc_active_student_class";

export function studentClassStorageKey(studentId: string, workspaceId: string) {
  return `${ACTIVE_STUDENT_CLASS_STORAGE_PREFIX}:${studentId}:${workspaceId}`;
}

export function readPersistedStudentBatchId(
  storage: Pick<Storage, "getItem">,
  studentId: string,
  workspaceId: string,
) {
  try {
    return storage.getItem(studentClassStorageKey(studentId, workspaceId));
  } catch {
    return null;
  }
}

export function persistStudentBatchId(
  storage: Pick<Storage, "removeItem" | "setItem">,
  studentId: string,
  workspaceId: string,
  batchId: string | null,
) {
  const key = studentClassStorageKey(studentId, workspaceId);
  try {
    if (batchId) storage.setItem(key, batchId);
    else storage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory selection remains authoritative for the current page.
  }
}

/**
 * A sole active class is unambiguous. With multiple active classes, only a
 * still-valid explicit choice is accepted; stale/archived choices fail closed.
 */
export function resolveActiveStudentBatchId(
  assignments: StudentBatchAssignment[],
  requestedBatchId: string | null,
) {
  if (
    requestedBatchId &&
    assignments.some((assignment) => assignment.batch_id === requestedBatchId)
  ) {
    return requestedBatchId;
  }
  return assignments.length === 1 ? assignments[0].batch_id : null;
}

interface StudentClassContextValue {
  assignments: StudentBatchAssignment[];
  activeAssignment: StudentBatchAssignment | null;
  activeBatchId: string | null;
  selectionRequired: boolean;
  isLoading: boolean;
  error: unknown;
  selectActiveBatch: (batchId: string) => void;
  refetchAssignments: () => Promise<unknown>;
}

const emptyStudentClassContext: StudentClassContextValue = {
  assignments: [],
  activeAssignment: null,
  activeBatchId: null,
  selectionRequired: false,
  isLoading: false,
  error: null,
  selectActiveBatch: () => undefined,
  refetchAssignments: async () => undefined,
};

const StudentClassContext = createContext<StudentClassContextValue>(
  emptyStudentClassContext,
);

export function StudentClassProvider({ children }: { children: ReactNode }) {
  const { activeWorkspaceId: workspaceId, authMode, role, user } = useAuth();
  const studentId = user?.id ?? "inactive-student";
  const queryEnabled =
    authMode === "supabase" &&
    role === "student" &&
    Boolean(user?.id) &&
    Boolean(workspaceId);
  const accessQueries = createStudentAccessQueries(studentId);
  const assignmentsQuery = useQuery({
    ...accessQueries.assignments,
    enabled: queryEnabled,
  });
  const assignments = useMemo(
    () =>
      (assignmentsQuery.data ?? []).filter(
        (assignment) => assignment.workspace_id === workspaceId,
      ),
    [assignmentsQuery.data, workspaceId],
  );
  const contextKey =
    queryEnabled && workspaceId
      ? studentClassStorageKey(studentId, workspaceId)
      : null;
  const [selection, setSelection] = useState<{
    contextKey: string | null;
    batchId: string | null;
  }>({ contextKey: null, batchId: null });
  const requestedBatchId = contextKey
    ? selection.contextKey === contextKey
      ? selection.batchId
      : readPersistedStudentBatchId(localStorage, studentId, workspaceId!)
    : null;
  const activeBatchId = resolveActiveStudentBatchId(
    assignments,
    requestedBatchId,
  );
  const activeAssignment =
    assignments.find((assignment) => assignment.batch_id === activeBatchId) ??
    null;

  useEffect(() => {
    if (!contextKey || !workspaceId || assignmentsQuery.isPending) return;
    setSelection({ contextKey, batchId: activeBatchId });
    persistStudentBatchId(localStorage, studentId, workspaceId, activeBatchId);
  }, [
    activeBatchId,
    assignmentsQuery.isPending,
    contextKey,
    studentId,
    workspaceId,
  ]);

  const selectActiveBatch = useCallback(
    (batchId: string) => {
      if (
        !contextKey ||
        !workspaceId ||
        !assignments.some((assignment) => assignment.batch_id === batchId)
      ) {
        return;
      }
      setSelection({ contextKey, batchId });
      persistStudentBatchId(localStorage, studentId, workspaceId, batchId);
    },
    [assignments, contextKey, studentId, workspaceId],
  );

  const value = useMemo<StudentClassContextValue>(
    () => ({
      assignments,
      activeAssignment,
      activeBatchId,
      selectionRequired: assignments.length > 1 && !activeBatchId,
      isLoading: queryEnabled && assignmentsQuery.isPending,
      error: assignmentsQuery.error,
      selectActiveBatch,
      refetchAssignments: assignmentsQuery.refetch,
    }),
    [
      activeAssignment,
      activeBatchId,
      assignments,
      assignmentsQuery.error,
      assignmentsQuery.isPending,
      assignmentsQuery.refetch,
      queryEnabled,
      selectActiveBatch,
    ],
  );

  return (
    <StudentClassContext.Provider value={value}>
      {children}
    </StudentClassContext.Provider>
  );
}

export function useStudentClass() {
  return useContext(StudentClassContext);
}
