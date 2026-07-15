import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, LEVEL_OPTIONS, type WorkspaceLevel } from "@/lib/workspaceData";
import { listWorkspaceBatches, type WorkspaceBatch } from "@/services/batchService";
import {
  getWeaknessBadgeClass,
  getWeaknessLabel,
} from "@/services/grammarStatsService";
import { approveBatchJoinRequest, assignStudentToBatch, listWorkspaceJoinRequestsFilteredPage, listWorkspaceStudentsFilteredPage, offboardStudent, rejectBatchJoinRequest, removeStudentBatchAssignment, transferStudentClass, type BatchJoinRequest, type JoinRequestCursor, type WorkspaceStudent, type WorkspaceStudentCursor } from "@/services/studentService";
import {
  formatTeacherIssueCount,
  getTeacherPracticeBadgeClass,
  getTeacherPracticeLabel,
  isTeacherSupportRecommended,
} from "@/services/teacherReadModelService";
import { ArrowRightLeft, Check, Eye, KeyRound, Search, UserMinus, X, XCircle } from "lucide-react";
import { appQueryKeys, SHARED_QUERY_STALE_MS } from "@/lib/appQueryKeys";

const ROSTER_UI_PAGE_SIZE = 25;
const JOIN_REQUEST_UI_PAGE_SIZE = 10;

function statusBadgeClass(status: string) {
  const classes: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    accepted: "bg-green-50 text-green-700 border-green-200",
    approved: "bg-green-50 text-green-700 border-green-200",
    rejected: "bg-destructive/10 text-destructive border-destructive/20",
    cancelled: "bg-muted text-muted-foreground",
    expired: "bg-destructive/10 text-destructive border-destructive/20",
  };
  return classes[status] ?? "bg-muted";
}

interface OffboardingResult {
  cancelled_join_requests: number;
  membership_removed: boolean;
  removed_batch_assignments: number;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function describeOffboardingResult(result: OffboardingResult) {
  const membershipResult = result.membership_removed
    ? "Workspace membership removed."
    : "Workspace membership was already absent.";

  return [
    membershipResult,
    `${countLabel(result.removed_batch_assignments, "batch assignment")} removed.`,
    `${countLabel(result.cancelled_join_requests, "join request")} cancelled.`,
    "Historical work was preserved.",
  ].join(" ");
}

interface OffboardStudentControlProps {
  student: WorkspaceStudent;
  workspaceId: string;
  onComplete: () => Promise<void>;
}

function OffboardStudentControl({
  student,
  workspaceId,
  onComplete,
}: OffboardStudentControlProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [offboarding, setOffboarding] = useState(false);
  const offboardingRequest = useRef(false);

  const confirmOffboarding = async () => {
    if (offboardingRequest.current) return;

    offboardingRequest.current = true;
    setOffboarding(true);

    let result: Awaited<ReturnType<typeof offboardStudent>>;

    try {
      result = await offboardStudent(student.id, workspaceId);
    } catch (offboardError) {
      toast({
        title: "Could not remove student access",
        description: formatErrorMessage(offboardError, "No access was changed. Please try again."),
      });
      return;
    } finally {
      offboardingRequest.current = false;
      setOffboarding(false);
    }

    setOpen(false);
    toast({
      title: `Offboarding completed for ${student.name}`,
      description: describeOffboardingResult(result),
    });

    try {
      await onComplete();
    } catch {
      toast({
        title: "Student access was removed, but the list did not refresh",
        description: "Refresh this page to see the latest student list.",
      });
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!offboarding) setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <UserMinus className="mr-2 h-4 w-4" />
          Remove access
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {student.name} from this workspace?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This immediately removes the student's workspace membership and all current batch
                assignments, and cancels their pending join requests. They will no longer be able to
                access this workspace.
              </p>
              <p className="font-medium text-foreground">
                Historical submissions, feedback, worksheet attempts, and progress records are preserved.
              </p>
              <p>This action cannot be undone from this screen.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={offboarding}>Keep student</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={offboarding}
            aria-busy={offboarding}
            onClick={(event) => {
              event.preventDefault();
              void confirmOffboarding();
            }}
          >
            {offboarding ? "Removing access..." : "Remove student access"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface TransferStudentControlProps {
  student: WorkspaceStudent;
  workspaceId: string;
  batches: WorkspaceBatch[];
  onComplete: () => Promise<void>;
}

export function TransferStudentControl({
  student,
  workspaceId,
  batches,
  onComplete,
}: TransferStudentControlProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [sourceAssignmentId, setSourceAssignmentId] = useState("");
  const [targetBatchId, setTargetBatchId] = useState("");
  const [transferring, setTransferring] = useState(false);
  const sourceAssignment = student.batches.find((batch) => batch.id === sourceAssignmentId) ?? null;
  const targetOptions = batches.filter((batch) => (
    batch.is_active && batch.id !== sourceAssignment?.batch_id
  ));
  const canOpen = student.batches.length > 0 && batches.some((batch) => (
    batch.is_active && student.batches.some((source) => source.batch_id !== batch.id)
  ));

  async function confirmTransfer() {
    if (!sourceAssignment || !targetBatchId || transferring) return;
    try {
      setTransferring(true);
      const result = await transferStudentClass(
        workspaceId,
        student.id,
        sourceAssignment.id,
        targetBatchId,
      );
      const targetName = batches.find((batch) => batch.id === result.target_batch_id)?.name
        ?? "the selected class";
      setOpen(false);
      toast({
        title: `${student.name} transferred`,
        description: `Current access moved from ${sourceAssignment.batch_name} to ${targetName}. Historical work stays with its original class.`,
      });
      await onComplete();
    } catch (error) {
      toast({
        title: "Could not transfer student",
        description: formatErrorMessage(
          error,
          "No partial class change was saved. Refresh and try again.",
        ),
      });
    } finally {
      setTransferring(false);
    }
  }

  if (!canOpen) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (transferring) return;
        setOpen(nextOpen);
        if (nextOpen) {
          const firstSource = student.batches[0];
          setSourceAssignmentId(firstSource?.id ?? "");
          setTargetBatchId("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <ArrowRightLeft className="mr-2 h-4 w-4" />
          Transfer class
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer {student.name} between classes</DialogTitle>
          <DialogDescription>
            The current class assignment is removed and the target assignment is created in one transaction. Historical submissions and feedback keep their original class context.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor={`transfer-source-${student.id}`} className="text-sm font-medium">
              Move from
            </label>
            <Select
              value={sourceAssignmentId}
              onValueChange={(value) => {
                setSourceAssignmentId(value);
                setTargetBatchId("");
              }}
            >
              <SelectTrigger id={`transfer-source-${student.id}`}>
                <SelectValue placeholder="Choose current class" />
              </SelectTrigger>
              <SelectContent>
                {student.batches.map((batch) => (
                  <SelectItem key={batch.id} value={batch.id}>{batch.batch_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label htmlFor={`transfer-target-${student.id}`} className="text-sm font-medium">
              Move to
            </label>
            <Select value={targetBatchId} onValueChange={setTargetBatchId}>
              <SelectTrigger id={`transfer-target-${student.id}`}>
                <SelectValue placeholder="Choose active class" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((batch) => (
                  <SelectItem key={batch.id} value={batch.id}>{batch.name} · {batch.level}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={transferring} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!sourceAssignment || !targetBatchId || transferring}
            aria-busy={transferring}
            onClick={() => void confirmTransfer()}
          >
            {transferring ? "Transferring..." : "Transfer student"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TeacherStudents() {
  const searchParams = new URLSearchParams(useSearch());
  const initialBatch = searchParams.get("batch") || "all";
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [joinSearch, setJoinSearch] = useState("");
  const [debouncedJoinSearch, setDebouncedJoinSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState(initialBatch);
  const [levelFilter, setLevelFilter] = useState("all");
  const [studentCursorTrail, setStudentCursorTrail] = useState<Array<WorkspaceStudentCursor | null>>([null]);
  const [joinCursorTrail, setJoinCursorTrail] = useState<Array<JoinRequestCursor | null>>([null]);
  const studentCursor = studentCursorTrail[studentCursorTrail.length - 1] ?? null;
  const joinCursor = joinCursorTrail[joinCursorTrail.length - 1] ?? null;
  const queryEnabled = Boolean(user) && Boolean(workspaceId);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedJoinSearch(joinSearch.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [joinSearch]);

  useEffect(() => {
    setStudentCursorTrail([null]);
  }, [batchFilter, debouncedSearch, levelFilter, workspaceId]);

  useEffect(() => {
    setJoinCursorTrail([null]);
  }, [debouncedJoinSearch, workspaceId]);

  const batchesQuery = useQuery({
    queryKey: appQueryKeys.workspaceBatches(workspaceId ?? "inactive-workspace"),
    queryFn: () => listWorkspaceBatches(workspaceId!),
    enabled: queryEnabled,
    staleTime: SHARED_QUERY_STALE_MS,
  });
  const studentsQuery = useQuery({
    queryKey: appQueryKeys.workspaceStudentsPage({
      workspaceId: workspaceId ?? "inactive-workspace",
      search: debouncedSearch,
      batchId: batchFilter === "all" ? null : batchFilter,
      level: levelFilter === "all" ? null : levelFilter,
      pageSize: ROSTER_UI_PAGE_SIZE,
      cursor: studentCursor,
    }),
    queryFn: () => listWorkspaceStudentsFilteredPage({
      workspaceId: workspaceId!,
      search: debouncedSearch,
      batchId: batchFilter === "all" ? null : batchFilter,
      level: levelFilter === "all" ? null : levelFilter as WorkspaceLevel,
      pageSize: ROSTER_UI_PAGE_SIZE,
      cursor: studentCursor,
    }),
    enabled: queryEnabled,
    staleTime: SHARED_QUERY_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const joinRequestsQuery = useQuery({
    queryKey: appQueryKeys.workspaceJoinRequestsPage({
      workspaceId: workspaceId ?? "inactive-workspace",
      status: "pending",
      search: debouncedJoinSearch,
      batchId: null,
      pageSize: JOIN_REQUEST_UI_PAGE_SIZE,
      cursor: joinCursor,
    }),
    queryFn: () => listWorkspaceJoinRequestsFilteredPage({
      workspaceId: workspaceId!,
      status: "pending",
      search: debouncedJoinSearch,
      pageSize: JOIN_REQUEST_UI_PAGE_SIZE,
      cursor: joinCursor,
    }),
    enabled: queryEnabled,
    staleTime: SHARED_QUERY_STALE_MS,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const batches = batchesQuery.data ?? [];
  const studentsPage = studentsQuery.data;
  const students = studentsPage?.items ?? [];
  const joinRequestsPage = joinRequestsQuery.data;
  const joinRequests = joinRequestsPage?.items ?? [];
  const loading = queryEnabled && (
    studentsQuery.isPlaceholderData || [
    batchesQuery,
    studentsQuery,
    ].some((query) => query.isPending)
  );
  const firstQueryError = [
    batchesQuery.error,
    studentsQuery.error,
  ].find(Boolean);
  const error = !workspaceId
    ? "No workspace found. Create a workspace before managing students."
    : firstQueryError
      ? formatErrorMessage(firstQueryError, "Unable to load students.")
      : null;

  const refreshStudents = async () => {
    if (!workspaceId) return;
    setStudentCursorTrail([null]);
    setJoinCursorTrail([null]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: appQueryKeys.workspaceBatches(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: appQueryKeys.workspaceStudents(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: appQueryKeys.workspaceStudentCount(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: appQueryKeys.workspaceJoinRequests(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: appQueryKeys.teacherDashboard(workspaceId) }),
    ]);
  };

  const displayBatches = batches;
  const displayStudents = students;

  const pendingJoinRequests = joinRequests;

  const assignBatch = async (studentId: string, batchId: string) => {
    if (!workspaceId || batchId === "none") return;
    try {
      await assignStudentToBatch(workspaceId, studentId, batchId);
      await refreshStudents();
    } catch (assignError) {
      toast({
        title: "Could not assign batch",
        description: formatErrorMessage(assignError, "Please try again."),
      });
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    if (!workspaceId) return;
    try {
      await removeStudentBatchAssignment(workspaceId, assignmentId);
      await refreshStudents();
    } catch (removeError) {
      toast({
        title: "Could not remove assignment",
        description: formatErrorMessage(removeError, "Please try again."),
      });
    }
  };

  const approveJoinRequest = async (requestId: string) => {
    try {
      await approveBatchJoinRequest(requestId);
      await refreshStudents();
      toast({ title: "Join request approved", description: "The student was added to the batch." });
    } catch (approveError) {
      toast({
        title: "Could not approve request",
        description: formatErrorMessage(approveError, "Please try again."),
      });
    }
  };

  const rejectJoinRequest = async (requestId: string) => {
    try {
      await rejectBatchJoinRequest(requestId);
      await refreshStudents();
      toast({ title: "Join request rejected" });
    } catch (rejectError) {
      toast({
        title: "Could not reject request",
        description: formatErrorMessage(rejectError, "Please try again."),
      });
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Students</h1>
          <p className="text-muted-foreground mt-1">Approve batch-code requests, manage assignments, and monitor progress.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px_160px] gap-4 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search students..."
            aria-label="Search students"
            className="pl-9 bg-card"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select value={batchFilter} onValueChange={setBatchFilter}>
          <SelectTrigger className="bg-card" aria-label="Filter students by class">
            <SelectValue placeholder="Filter by Batch" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Classes</SelectItem>
            {displayBatches.filter((batch) => batch.is_active).map((batch) => (
              <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="bg-card" aria-label="Filter students by CEFR level">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            {LEVEL_OPTIONS.map((level) => (
              <SelectItem key={level} value={level}>{level}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">{error}</CardContent>
        </Card>
      )}

      <Card className="shadow-sm mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Assigned Classes</TableHead>
              <TableHead>Student Weak Areas</TableHead>
              <TableHead className="hidden md:table-cell">Submissions</TableHead>
              <TableHead className="hidden sm:table-cell">Last Active</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  <span role="status">Loading students...</span>
                </TableCell>
              </TableRow>
            ) : !workspaceId ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  <span role="alert">Select a workspace before managing students.</span>
                </TableCell>
              </TableRow>
            ) : studentsQuery.isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  <span role="alert">Student records could not be loaded. Refresh and try again.</span>
                </TableCell>
              </TableRow>
            ) : displayStudents.length > 0 ? (
              displayStudents.map((student) => {
                const studentGrammarStats = student.weak_topics;

                return (
                  <TableRow key={student.id}>
                    <TableCell>
                      <div className="font-medium">{student.name}</div>
                      <div className="text-xs text-muted-foreground">{student.email}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {student.batches.length === 0 && (
                          <Badge variant="outline" className="bg-muted">Unassigned</Badge>
                        )}
                        {student.batches.map((batch) => (
                          <Badge key={batch.id} variant="outline" className="bg-muted gap-1">
                            {batch.batch_name} · {batch.level}
                            <button
                              type="button"
                              className="ml-1 rounded-sm hover:text-destructive"
                              onClick={() => removeAssignment(batch.id)}
                              aria-label={`Remove ${batch.batch_name}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                      {displayBatches.length > 0 && (
                        <div className="mt-2 max-w-56">
                          <Select value="none" onValueChange={(value) => assignBatch(student.id, value)}>
                            <SelectTrigger className="h-8 text-xs bg-card" aria-label={`Assign class to ${student.name}`}>
                              <SelectValue placeholder="Assign batch" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Assign batch</SelectItem>
                              {displayBatches.filter((batch) => batch.is_active).map((batch) => (
                                <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-52">
                      {studentGrammarStats.length > 0 ? (
                          <div className="flex flex-col gap-1.5">
                            {studentGrammarStats.map((stat) => {
                              const assignment = stat.active_practice;
                              return (
                                <div key={stat.id} className="flex flex-col gap-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge variant="outline" className={getWeaknessBadgeClass(stat.weakness_level, stat.practice_unlocked)}>
                                      {stat.topic_name}
                                    </Badge>
                                    <span className="text-[11px] text-muted-foreground">
                                      {getWeaknessLabel(stat.weakness_level, stat.practice_unlocked)} · {formatTeacherIssueCount(stat)}
                                    </span>
                                  </div>
                                  {assignment && (
                                    <div className="space-y-1">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <Badge variant="outline" className={getTeacherPracticeBadgeClass(assignment)}>
                                          {getTeacherPracticeLabel(assignment)}
                                        </Badge>
                                        {assignment.worksheet_title && (
                                          <span className="text-[11px] text-muted-foreground truncate">{assignment.worksheet_title}</span>
                                        )}
                                      </div>
                                      {isTeacherSupportRecommended(assignment) && (
                                        <p className="text-[11px] font-medium text-orange-700 dark:text-orange-300">
                                          Teacher support recommended
                                        </p>
                                      )}
                                      <Link
                                        href={`/teacher/practice/${assignment.id}`}
                                        className="text-[11px] font-medium text-primary hover:underline"
                                      >
                                        Review worksheet and support
                                      </Link>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No focus areas yet</span>
                        )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{student.total_submissions}</TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">{student.last_active}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1 xl:flex-row xl:justify-end">
                        <Button asChild variant="ghost" size="sm" className="text-primary hover:text-primary hover:bg-primary/10">
                          <Link href={`/teacher/submissions?student=${student.id}`}>
                            <Eye className="w-4 h-4 mr-2" /> View Work
                          </Link>
                        </Button>
                        {workspaceId && (
                          <>
                            <TransferStudentControl
                              student={student}
                              workspaceId={workspaceId}
                              batches={batches}
                              onComplete={refreshStudents}
                            />
                            <OffboardStudentControl
                              student={student}
                              workspaceId={workspaceId}
                              onComplete={refreshStudents}
                            />
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <h2 className="text-lg font-semibold mb-2">
                    {debouncedSearch || batchFilter !== "all" || levelFilter !== "all"
                      ? "No students match these filters"
                      : "No students yet"}
                  </h2>
                  <p className="text-muted-foreground mb-4">
                    {debouncedSearch || batchFilter !== "all" || levelFilter !== "all"
                      ? "Change or clear the search and class filters to see other students."
                      : "Share a class code. Students appear here after you approve their join request."}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {studentsPage && studentsPage.total_count > 0 && (
        <div className="-mt-4 mb-8 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          {studentsQuery.isPlaceholderData ? (
            <p role="status" aria-live="polite">Loading student page {studentCursorTrail.length}...</p>
          ) : (
            <p>
              Showing {(studentCursorTrail.length - 1) * studentsPage.page_size + 1}–
              {Math.min(
                (studentCursorTrail.length - 1) * studentsPage.page_size + studentsPage.returned_count,
                studentsPage.total_count,
              )} of {studentsPage.total_count} matching students
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={studentCursorTrail.length === 1 || studentsQuery.isFetching}
              onClick={() => setStudentCursorTrail((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!studentsPage.has_more || studentsQuery.isFetching}
              onClick={() => {
                if (studentsPage.next_cursor) {
                  setStudentCursorTrail((current) => [...current, studentsPage.next_cursor]);
                }
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <Card className="shadow-sm mb-8">
          <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              <KeyRound className="h-4 w-4" />
              Class Code Requests
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={joinSearch}
                onChange={(event) => setJoinSearch(event.target.value)}
                placeholder="Search pending requests..."
                aria-label="Search pending class-code requests"
                className="pl-9"
              />
            </div>
            {!workspaceId ? (
              <p className="text-sm text-destructive" role="alert">Select a workspace to load class-code requests.</p>
            ) : joinRequestsQuery.isPending || joinRequestsQuery.isPlaceholderData ? (
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">Loading class-code requests...</p>
            ) : joinRequestsQuery.isError ? (
              <p className="text-sm text-destructive" role="alert">Class-code requests could not be loaded.</p>
            ) : pendingJoinRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {debouncedJoinSearch ? "No pending requests match this search." : "No pending class-code requests."}
              </p>
            ) : (
              <>
                <div className="space-y-3">
                  {pendingJoinRequests.map((request) => (
                    <div key={request.id} className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 rounded-lg border p-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{request.student_name}</p>
                          <Badge variant="outline" className={statusBadgeClass(request.status)}>{request.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{request.student_email}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {request.batch_name} · {request.batch_level} · requested {new Date(request.requested_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <Button size="sm" onClick={() => approveJoinRequest(request.id)}>
                          <Check className="h-4 w-4 mr-2" />
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => rejectJoinRequest(request.id)}>
                          <XCircle className="h-4 w-4 mr-2" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                {joinRequestsPage && joinRequestsPage.total_count > 0 && (
                  <div className="flex flex-col gap-3 border-t pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <p>
                      Showing {(joinCursorTrail.length - 1) * joinRequestsPage.page_size + 1}–
                      {Math.min(
                        (joinCursorTrail.length - 1) * joinRequestsPage.page_size + joinRequestsPage.returned_count,
                        joinRequestsPage.total_count,
                      )} of {joinRequestsPage.total_count} pending requests
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={joinCursorTrail.length === 1 || joinRequestsQuery.isFetching}
                        onClick={() => setJoinCursorTrail((current) => current.slice(0, -1))}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!joinRequestsPage.has_more || joinRequestsQuery.isFetching}
                        onClick={() => {
                          if (joinRequestsPage.next_cursor) {
                            setJoinCursorTrail((current) => [...current, joinRequestsPage.next_cursor]);
                          }
                        }}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
      </Card>

    </div>
  );
}
