import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { isPublicAppError } from "@/lib/appError";
import {
  formatErrorMessage,
  LEVEL_OPTIONS,
  type WorkspaceLevel,
} from "@/lib/workspaceData";
import {
  createWorkspaceBatch,
  listWorkspaceBatchesPage,
  requestBatchWritingLimit,
  rotateBatchJoinCode,
  setBatchActive,
  updateWorkspaceBatch,
  type BatchFeedbackMode,
  type WorkspaceBatchCursor,
  type WorkspaceBatchStatusFilter,
  type WorkspaceBatch,
} from "@/services/batchService";
import type { ApiPage } from "@/services/apiFacade";
import { markOnboardingStep } from "@/services/onboardingService";
import { appQueryKeys, SHARED_QUERY_STALE_MS } from "@/lib/appQueryKeys";
import {
  Archive,
  CheckCircle2,
  ChevronsUpDown,
  Copy,
  Edit,
  FileText,
  KeyRound,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";

interface BatchFormState {
  name: string;
  level: WorkspaceLevel;
  description: string;
  is_active: boolean;
  join_code_enabled: boolean;
  feedback_mode: BatchFeedbackMode;
  feedback_delay_min_minutes: number;
  feedback_delay_max_minutes: number;
}

const initialForm: BatchFormState = {
  name: "",
  level: "A1",
  description: "",
  is_active: true,
  join_code_enabled: true,
  feedback_mode: "immediate",
  feedback_delay_min_minutes: 15,
  feedback_delay_max_minutes: 180,
};

function levelBadgeClass(level: string) {
  const classes: Record<string, string> = {
    A1: "border-green-300 text-green-700 bg-green-50",
    A2: "border-blue-300 text-blue-700 bg-blue-50",
    B1: "border-violet-300 text-violet-700 bg-violet-50",
    B2: "border-amber-300 text-amber-700 bg-amber-50",
  };
  return classes[level] ?? "bg-muted";
}

const feedbackModeLabels: Record<BatchFeedbackMode, string> = {
  immediate: "Immediate feedback",
  automatic_delayed: "Scheduled feedback",
  teacher_review_only: "Teacher review",
};

// prettier-ignore
const feedbackModes: readonly BatchFeedbackMode[] = ["immediate", "automatic_delayed", "teacher_review_only"];
const mandatoryApprovalDescription =
  "A code never grants access by itself. You approve each request.";
const CLASS_PAGE_SIZE = 12;

const classWizardSteps = [
  "Class details",
  "Feedback mode",
  "Schedule",
  "Enrollment",
  "Review",
] as const;

const feedbackModeDescriptions: Record<BatchFeedbackMode, string> = {
  immediate:
    "Evaluate now and release as soon as the result passes validation.",
  automatic_delayed:
    "Evaluate privately now, then release inside the delay window you choose.",
  teacher_review_only:
    "Evaluate privately now. You edit, approve, and release the result.",
};

function isDelayRangeValid(form: BatchFormState) {
  return (
    form.feedback_delay_min_minutes >= 0 &&
    form.feedback_delay_max_minutes >= form.feedback_delay_min_minutes &&
    form.feedback_delay_max_minutes <= 10080
  );
}

function feedbackModeBadgeClass(mode: BatchFeedbackMode) {
  if (mode === "immediate") return "bg-blue-50 text-blue-700 border-blue-200";
  if (mode === "automatic_delayed")
    return "bg-violet-50 text-violet-700 border-violet-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

export default function TeacherBatches() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [levelFilter, setLevelFilter] = useState<WorkspaceLevel | "all">("all");
  const [statusFilter, setStatusFilter] =
    useState<WorkspaceBatchStatusFilter>("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<WorkspaceBatch | null>(null);
  const [formData, setFormData] = useState<BatchFormState>(initialForm);
  const [wizardStep, setWizardStep] = useState(1);
  const [savingBatch, setSavingBatch] = useState(false);
  const [writingLimitBatch, setWritingLimitBatch] =
    useState<WorkspaceBatch | null>(null);
  const [requestedWritingLimit, setRequestedWritingLimit] = useState(3);
  const [savingWritingLimit, setSavingWritingLimit] = useState(false);
  const [writingLimitRefreshState, setWritingLimitRefreshState] = useState<{
    batchId: string;
    status: "refreshing" | "failed";
  } | null>(null);
  const dialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  const writingLimitOpenerRef = useRef<HTMLButtonElement | null>(null);
  const saveInFlightRef = useRef(false);
  const writingLimitInFlightRef = useRef(false);
  const firstClassAutoOpenRequestedRef = useRef(
    new URLSearchParams(window.location.search).get("create") === "first-class",
  );
  const firstClassAutoOpenedRef = useRef(false);

  const batchListQueryKey = appQueryKeys.workspaceBatchesPage({
    workspaceId: workspaceId ?? "inactive-workspace",
    status: statusFilter,
    level: levelFilter === "all" ? null : levelFilter,
    pageSize: CLASS_PAGE_SIZE,
    cursor: null,
  });
  const batchesQuery = useInfiniteQuery({
    queryKey: batchListQueryKey,
    queryFn: ({ pageParam }) =>
      listWorkspaceBatchesPage({
        workspaceId: workspaceId!,
        status: statusFilter,
        level: levelFilter === "all" ? null : levelFilter,
        pageSize: CLASS_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: null as WorkspaceBatchCursor | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.has_more) return undefined;
      const cursor = lastPage.next_cursor;
      return cursor?.created_at && cursor.id
        ? { created_at: cursor.created_at, id: cursor.id }
        : undefined;
    },
    enabled: Boolean(user) && Boolean(workspaceId),
    staleTime: SHARED_QUERY_STALE_MS,
  });
  const batches = batchesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const filteredTotal = batchesQuery.data?.pages[0]?.total_count ?? 0;
  const workspaceTotal =
    batchesQuery.data?.pages[0]?.unfiltered_total_count ?? 0;
  const loading = Boolean(workspaceId) && batchesQuery.isPending;
  const error = !workspaceId
    ? "No workspace found. Create a workspace before managing classes."
    : batchesQuery.isError && !batchesQuery.data
      ? formatErrorMessage(batchesQuery.error, "Unable to load classes.")
      : null;
  const loadMoreError = batchesQuery.isFetchNextPageError
    ? formatErrorMessage(
        batchesQuery.error,
        "More classes could not be loaded. Please try again.",
      )
    : null;

  const refreshBatches = async () => {
    if (!workspaceId) return;
    await queryClient.invalidateQueries({
      queryKey: appQueryKeys.workspaceBatches(workspaceId),
    });
  };

  const openDialog = (
    batch?: WorkspaceBatch,
    opener?: HTMLButtonElement | null,
  ) => {
    dialogOpenerRef.current =
      opener ??
      (document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : null);
    if (batch) {
      setEditingBatch(batch);
      setFormData({
        name: batch.name,
        level: batch.level,
        description: batch.description ?? "",
        is_active: batch.is_active,
        join_code_enabled: batch.join_code_enabled,
        feedback_mode: batch.feedback_mode,
        feedback_delay_min_minutes: batch.feedback_delay_min_minutes,
        feedback_delay_max_minutes: batch.feedback_delay_max_minutes,
      });
    } else {
      setEditingBatch(null);
      setFormData(initialForm);
    }
    setWizardStep(1);
    setDialogOpen(true);
  };

  useEffect(() => {
    if (
      !firstClassAutoOpenRequestedRef.current ||
      firstClassAutoOpenedRef.current ||
      !workspaceId ||
      !batchesQuery.isSuccess
    ) {
      return;
    }

    firstClassAutoOpenedRef.current = true;
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    if (workspaceTotal === 0) openDialog();
  }, [batchesQuery.isSuccess, workspaceId, workspaceTotal]);

  const advanceWizard = () => {
    if (wizardStep === 1 && !formData.name.trim()) {
      toast({
        title: "Class name required",
        description: "Give this class a clear name before continuing.",
      });
      return;
    }
    if (
      wizardStep === 3 &&
      formData.feedback_mode === "automatic_delayed" &&
      !isDelayRangeValid(formData)
    ) {
      toast({
        title: "Schedule range needs attention",
        description:
          "Use 0 or more minutes, keep maximum above minimum, and stay under 7 days.",
      });
      return;
    }
    setWizardStep((current) => Math.min(current + 1, classWizardSteps.length));
  };

  const saveBatch = async () => {
    if (!workspaceId || !user) return;
    if (!formData.name.trim()) {
      toast({
        title: "Class name required",
        description: "Give this class a clear name.",
      });
      return;
    }
    if (!isDelayRangeValid(formData)) {
      toast({
        title: "Delay range needs attention",
        description:
          "Use 0 or more minutes, keep maximum above minimum, and stay under 7 days.",
      });
      return;
    }

    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSavingBatch(true);

    try {
      if (editingBatch) {
        await updateWorkspaceBatch(workspaceId, editingBatch.id, {
          ...formData,
          name: formData.name.trim(),
          description: formData.description.trim(),
        });
      } else {
        await createWorkspaceBatch(workspaceId, user.id, {
          ...formData,
          name: formData.name.trim(),
          description: formData.description.trim(),
        });
      }
      setDialogOpen(false);
      await refreshBatches();
      toast({ title: editingBatch ? "Class updated" : "Class created" });
    } catch (saveError) {
      toast({
        title: "Could not save class",
        description: formatErrorMessage(saveError, "Please try again."),
      });
    } finally {
      saveInFlightRef.current = false;
      setSavingBatch(false);
    }
  };

  const handleFeedbackModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: BatchFeedbackMode,
  ) => {
    let nextIndex: number | null = null;
    const currentIndex = feedbackModes.indexOf(currentMode);

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % feedbackModes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + feedbackModes.length) % feedbackModes.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = feedbackModes.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = feedbackModes[nextIndex];
    setFormData((current) => ({
      ...current,
      feedback_mode: nextMode,
    }));
    document.getElementById(`feedback-mode-${nextMode}`)?.focus();
  };

  const toggleBatch = async (batch: WorkspaceBatch) => {
    if (!workspaceId) return;
    const queryKey = appQueryKeys.workspaceBatches(workspaceId);
    const nextActive = !batch.is_active;
    try {
      await setBatchActive(workspaceId, batch.id, nextActive);
      // Reflect the confirmed mutation immediately. The background refresh is
      // still authoritative, but the class must not look unchanged while that
      // read is in flight (especially when an archived filter is selected).
      queryClient.setQueryData<WorkspaceBatch[]>(queryKey, (current) =>
        current?.map((item) =>
          item.id === batch.id ? { ...item, is_active: nextActive } : item,
        ),
      );
      queryClient.setQueryData<
        InfiniteData<ApiPage<WorkspaceBatch>, WorkspaceBatchCursor | null>
      >(batchListQueryKey, (current) => {
        if (!current) return current;
        const staysVisible = statusFilter === "all";
        return {
          ...current,
          pages: current.pages.map((page) => {
            const items = staysVisible
              ? page.items.map((item) =>
                  item.id === batch.id
                    ? { ...item, is_active: nextActive }
                    : item,
                )
              : page.items.filter((item) => item.id !== batch.id);
            return {
              ...page,
              items,
              returned_count: items.length,
              total_count: staysVisible
                ? page.total_count
                : Math.max(0, page.total_count - 1),
            };
          }),
        };
      });
      await refreshBatches();
    } catch (toggleError) {
      await queryClient.invalidateQueries({ queryKey });
      toast({
        title: "Could not update class",
        description: formatErrorMessage(toggleError, "Please try again."),
      });
    }
  };

  const copyJoinCode = async (batch: WorkspaceBatch) => {
    try {
      await navigator.clipboard.writeText(batch.join_code);
      if (workspaceId) {
        try {
          await markOnboardingStep(workspaceId, "teacher", "share_join_code");
          await queryClient.invalidateQueries({
            queryKey: appQueryKeys.onboardingProgress(workspaceId, "teacher"),
          });
        } catch {
          // Copying remains successful even if checklist progress cannot refresh.
        }
      }
      toast({
        title: "Join code copied",
        description: `${batch.name}: ${batch.join_code}`,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the code and copy it manually.",
      });
    }
  };

  const rotateJoinCode = async (batch: WorkspaceBatch) => {
    try {
      const nextCode = await rotateBatchJoinCode(batch.id);
      await refreshBatches();
      toast({
        title: "Join code rotated",
        description: `${batch.name}: ${nextCode}`,
      });
    } catch (rotateError) {
      toast({
        title: "Could not rotate code",
        description: formatErrorMessage(rotateError, "Please try again."),
      });
    }
  };

  const openWritingLimitDialog = (
    batch: WorkspaceBatch,
    opener: HTMLButtonElement,
  ) => {
    if (!batch.is_active || writingLimitRefreshState?.batchId === batch.id) {
      return;
    }
    writingLimitOpenerRef.current = opener;
    setWritingLimitBatch(batch);
    setRequestedWritingLimit(
      batch.pending_writing_daily_limit ?? batch.current_writing_daily_limit,
    );
  };

  const saveWritingLimitRequest = async () => {
    if (!workspaceId || !writingLimitBatch || writingLimitInFlightRef.current) {
      return;
    }
    const previousRequestedLimit =
      writingLimitBatch.pending_writing_daily_limit;
    if (
      requestedWritingLimit === writingLimitBatch.current_writing_daily_limit ||
      requestedWritingLimit === previousRequestedLimit
    ) {
      return;
    }

    writingLimitInFlightRef.current = true;
    setSavingWritingLimit(true);
    try {
      const result = await requestBatchWritingLimit(
        workspaceId,
        writingLimitBatch.id,
        requestedWritingLimit,
        writingLimitBatch.pending_writing_limit_request_revision ?? 0,
      );
      queryClient.setQueryData<
        InfiniteData<ApiPage<WorkspaceBatch>, WorkspaceBatchCursor | null>
      >(batchListQueryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((batch) =>
              batch.id === result.batch_id
                ? {
                    ...batch,
                    current_writing_daily_limit:
                      result.current_writing_daily_limit,
                    pending_writing_limit_request_id: result.request_id,
                    pending_writing_limit_request_status: result.request_status,
                    pending_writing_daily_limit:
                      result.requested_writing_daily_limit,
                    pending_writing_limit_request_revision:
                      result.request_revision,
                  }
                : batch,
            ),
          })),
        };
      });
      setWritingLimitBatch(null);
      toast({
        title: previousRequestedLimit
          ? "Writing-limit request updated"
          : "Writing-limit request sent",
        description:
          "The current limit stays active until an administrator approves the request.",
      });
      void refreshBatches();
    } catch (requestError) {
      const requestStateChanged =
        isPublicAppError(requestError) &&
        (requestError.code === "data_conflict" ||
          requestError.code === "data_not_found");
      if (requestStateChanged) {
        const staleBatchId = writingLimitBatch.id;
        setWritingLimitBatch(null);
        setWritingLimitRefreshState({
          batchId: staleBatchId,
          status: "refreshing",
        });
        try {
          await batchesQuery.refetch({ throwOnError: true });
          setWritingLimitRefreshState(null);
          toast({
            title: "Writing-limit request changed",
            description:
              "The latest class limit is loaded. Reopen the request and review it before sending again.",
          });
        } catch {
          setWritingLimitRefreshState({
            batchId: staleBatchId,
            status: "failed",
          });
          toast({
            title: "Latest writing limit could not be loaded",
            description:
              "Reload this page before trying that writing-limit request again.",
          });
        }
        return;
      }
      toast({
        title: "Could not send writing-limit request",
        description: formatErrorMessage(requestError, "Please try again."),
      });
      void refreshBatches();
    } finally {
      writingLimitInFlightRef.current = false;
      setSavingWritingLimit(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Classes</h1>
          <p className="text-muted-foreground mt-1">
            Create classes, choose feedback timing, and share enrollment codes.
          </p>
        </div>
        <Button
          onClick={(event) => openDialog(undefined, event.currentTarget)}
          className="shadow-md"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Class
        </Button>
      </div>

      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="w-full md:w-48">
          <Select
            value={levelFilter}
            onValueChange={(value) =>
              setLevelFilter(value as WorkspaceLevel | "all")
            }
          >
            <SelectTrigger
              className="bg-card"
              aria-label="Filter classes by level"
            >
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              {LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full md:w-48">
          <Select
            value={statusFilter}
            onValueChange={(value) =>
              setStatusFilter(value as WorkspaceBatchStatusFilter)
            }
          >
            <SelectTrigger
              className="bg-card"
              aria-label="Filter classes by status"
            >
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Archived</SelectItem>
              <SelectItem value="all">All Statuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">
            {error}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent
            className="py-10 text-center text-muted-foreground"
            role="status"
          >
            Loading classes...
          </CardContent>
        </Card>
      ) : error ? null : batches.length === 0 && workspaceTotal === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <h2 className="text-xl font-semibold mb-2">
              Create your first class
            </h2>
            <p className="text-muted-foreground mb-5">
              Organize students by level from A1 through B2.
            </p>
            <Button
              onClick={(event) => openDialog(undefined, event.currentTarget)}
            >
              Create Class
            </Button>
          </CardContent>
        </Card>
      ) : batches.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <h2 className="text-xl font-semibold mb-2">
              No classes match these filters
            </h2>
            <p className="text-muted-foreground mb-5">
              Show all levels and statuses, or choose different filters.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLevelFilter("all");
                setStatusFilter("all");
              }}
            >
              Show all classes
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {batches.map((batch, i) => (
            <Card
              key={batch.id}
              className={`hover:shadow-md transition-shadow animate-in slide-in-from-bottom-4 ${!batch.is_active ? "opacity-70" : ""}`}
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <CardHeader className="pb-4 border-b border-border bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Badge
                      variant="outline"
                      className={levelBadgeClass(batch.level)}
                    >
                      {batch.level}
                    </Badge>
                    <CardTitle className="text-xl mt-3">{batch.name}</CardTitle>
                  </div>
                  {!batch.is_active && (
                    <Badge variant="secondary">Archived</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                {batch.description && (
                  <p className="text-sm text-muted-foreground mb-5 line-clamp-2">
                    {batch.description}
                  </p>
                )}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center text-muted-foreground">
                      <Users className="w-4 h-4 mr-2" />
                      <span className="text-sm">Students</span>
                    </div>
                    <span className="font-semibold">{batch.student_count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center text-muted-foreground">
                      <FileText className="w-4 h-4 mr-2" />
                      <span className="text-sm">Total Submissions</span>
                    </div>
                    <span className="font-semibold">
                      {batch.submission_count}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" />
                      <span className="text-sm">Status</span>
                    </div>
                    <span className="font-semibold">
                      {batch.is_active ? "Active" : "Archived"}
                    </span>
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">
                        Feedback timing
                      </span>
                      <Badge
                        variant="outline"
                        className={feedbackModeBadgeClass(batch.feedback_mode)}
                      >
                        {feedbackModeLabels[batch.feedback_mode]}
                      </Badge>
                    </div>
                    {batch.feedback_mode === "automatic_delayed" && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Randomized between {batch.feedback_delay_min_minutes}{" "}
                        and {batch.feedback_delay_max_minutes} minutes.
                      </p>
                    )}
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          Daily writing feedback
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Per student in this class
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          batch.pending_writing_limit_request_status ===
                          "pending"
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700"
                        }
                      >
                        {batch.pending_writing_limit_request_status ===
                        "pending"
                          ? "Under review"
                          : `${batch.current_writing_daily_limit}/day`}
                      </Badge>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {batch.pending_writing_limit_request_status === "pending"
                        ? `${batch.pending_writing_daily_limit}/day requested. The current ${batch.current_writing_daily_limit}/day limit remains active until an administrator approves the change.`
                        : batch.current_writing_daily_limit === 3
                          ? "The standard limit is 3 evaluated writings per student each day."
                          : `The approved limit is ${batch.current_writing_daily_limit} evaluated writings per student each day.`}
                    </p>
                    {!batch.is_active && (
                      <p className="mt-2 text-xs font-medium text-amber-700">
                        Reactivate this class before requesting a limit change.
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full"
                      disabled={
                        !batch.is_active ||
                        writingLimitRefreshState?.batchId === batch.id
                      }
                      aria-label={`${batch.pending_writing_limit_request_status === "pending" ? "Change pending writing limit request" : "Request a writing limit change"} for ${batch.name}`}
                      onClick={(event) =>
                        openWritingLimitDialog(batch, event.currentTarget)
                      }
                    >
                      {writingLimitRefreshState?.batchId === batch.id
                        ? writingLimitRefreshState.status === "refreshing"
                          ? "Refreshing limit..."
                          : "Reload page to retry"
                        : batch.pending_writing_limit_request_status ===
                            "pending"
                          ? "Change request"
                          : "Request change"}
                    </Button>
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          <KeyRound className="h-3.5 w-3.5" />
                          Join Code
                        </div>
                        <p className="mt-1 font-mono text-base tracking-wider text-foreground">
                          {batch.join_code}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Copy join code"
                          aria-label={`Copy join code for ${batch.name}`}
                          onClick={() => copyJoinCode(batch)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Rotate join code"
                          aria-label={`Rotate join code for ${batch.name}`}
                          onClick={() => rotateJoinCode(batch)}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge
                        variant="outline"
                        className={
                          batch.join_code_enabled
                            ? "bg-green-50 text-green-700 border-green-200"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {batch.join_code_enabled
                          ? "Code enabled"
                          : "Code disabled"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="bg-amber-50 text-amber-700 border-amber-200"
                      >
                        Approval required
                      </Badge>
                    </div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="grid grid-cols-2 gap-3 bg-muted/10 pt-4">
                <Button asChild variant="outline" className="w-full text-xs">
                  <Link href={`/teacher/students?batch=${batch.id}`}>
                    View Students
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  className="w-full text-xs"
                  onClick={(event) => openDialog(batch, event.currentTarget)}
                >
                  <Edit className="w-3 h-3 mr-1" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  className="col-span-2 text-xs"
                  onClick={() => toggleBatch(batch)}
                >
                  <Archive className="w-3 h-3 mr-1" />
                  {batch.is_active ? "Archive Class" : "Reactivate Class"}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {!loading && !error && filteredTotal > 0 && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Showing {batches.length} of {filteredTotal} filtered classes
          </p>
          {loadMoreError && (
            <p className="text-center text-sm text-destructive" role="alert">
              {loadMoreError} The classes already shown remain available.
            </p>
          )}
          {batchesQuery.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void batchesQuery.fetchNextPage()}
              disabled={batchesQuery.isFetchingNextPage}
              aria-busy={batchesQuery.isFetchingNextPage}
            >
              {batchesQuery.isFetchingNextPage
                ? "Loading more classes..."
                : loadMoreError
                  ? "Retry loading more classes"
                  : "Load more classes"}
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open || !savingBatch) setDialogOpen(open);
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-1rem)] flex-col gap-3 overflow-hidden p-4 sm:max-h-[calc(100dvh-2rem)] sm:max-w-[640px] sm:gap-4 sm:p-6"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogOpenerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editingBatch ? "Edit class" : "Create a class"}
            </DialogTitle>
            <DialogDescription>
              Step {wizardStep} of {classWizardSteps.length}:{" "}
              {classWizardSteps[wizardStep - 1]}
            </DialogDescription>
          </DialogHeader>
          <ol
            className="grid grid-cols-5 gap-2"
            aria-label="Class setup progress"
          >
            {classWizardSteps.map((step, index) => {
              const stepNumber = index + 1;
              const isCurrent = stepNumber === wizardStep;
              const isComplete = stepNumber < wizardStep;
              return (
                <li key={step} className="min-w-0">
                  <div
                    className={`h-1.5 rounded-full ${isComplete || isCurrent ? "bg-primary" : "bg-muted"}`}
                    aria-hidden="true"
                  />
                  <span
                    className={`mt-1 hidden truncate text-[11px] sm:block ${isCurrent ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                    aria-current={isCurrent ? "step" : undefined}
                  >
                    {step}
                  </span>
                </li>
              );
            })}
          </ol>

          <p className="sr-only" aria-live="polite">
            Step {wizardStep}: {classWizardSteps[wizardStep - 1]}
          </p>

          <form
            className="flex min-h-0 flex-1 flex-col"
            aria-busy={savingBatch}
            onSubmit={(event) => {
              event.preventDefault();
              if (wizardStep === classWizardSteps.length) {
                void saveBatch();
              } else {
                advanceWizard();
              }
            }}
          >
            <div
              className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-1 py-3 pr-2 sm:min-h-[300px] sm:py-4"
              data-testid="class-wizard-scroll-region"
            >
              {wizardStep === 1 && (
                <section
                  className="space-y-4"
                  aria-labelledby="class-details-heading"
                >
                  <div>
                    <h3 id="class-details-heading" className="font-semibold">
                      Name and level
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Use a name students and teachers will recognize.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="batch-name">Class name</Label>
                    <Input
                      id="batch-name"
                      autoFocus
                      required
                      value={formData.name}
                      onChange={(event) =>
                        setFormData({ ...formData, name: event.target.value })
                      }
                      placeholder="A2 Evening Class"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="batch-level">CEFR level</Label>
                    <Select
                      value={formData.level}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          level: value as WorkspaceLevel,
                        })
                      }
                    >
                      <SelectTrigger id="batch-level" aria-label="CEFR level">
                        <SelectValue placeholder="Select level" />
                      </SelectTrigger>
                      <SelectContent>
                        {LEVEL_OPTIONS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="batch-description">
                      Description{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                      id="batch-description"
                      value={formData.description}
                      onChange={(event) =>
                        setFormData({
                          ...formData,
                          description: event.target.value,
                        })
                      }
                      placeholder="Meeting time, course focus, or a note for colleagues"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <Label htmlFor="batch-active">Active class</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Students can join and submit work while the class is
                        active.
                      </p>
                    </div>
                    <Switch
                      id="batch-active"
                      checked={formData.is_active}
                      onCheckedChange={(checked) =>
                        setFormData({ ...formData, is_active: checked })
                      }
                    />
                  </div>
                </section>
              )}

              {wizardStep === 2 && (
                <section
                  className="space-y-4"
                  aria-labelledby="feedback-mode-heading"
                >
                  <div>
                    <h3 id="feedback-mode-heading" className="font-semibold">
                      Choose when students see feedback
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Evaluation starts promptly in every mode; only release
                      timing changes.
                    </p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-labelledby="feedback-mode-heading"
                    className="grid gap-3"
                  >
                    {feedbackModes.map((mode) => {
                      const selected = formData.feedback_mode === mode;
                      return (
                        <button
                          key={mode}
                          id={`feedback-mode-${mode}`}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          onClick={() =>
                            setFormData((current) => ({
                              ...current,
                              feedback_mode: mode,
                            }))
                          }
                          onKeyDown={(event) =>
                            handleFeedbackModeKeyDown(event, mode)
                          }
                          className={`rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                        >
                          <span className="flex items-center justify-between gap-3">
                            <span className="font-medium">
                              {feedbackModeLabels[mode]}
                            </span>
                            {selected && <Badge>Selected</Badge>}
                          </span>
                          <span className="mt-1 block text-sm text-muted-foreground">
                            {feedbackModeDescriptions[mode]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    If a result is uncertain or invalid, the system retries once
                    and then holds it for teacher review in every mode.
                  </p>
                </section>
              )}

              {wizardStep === 3 && (
                <section
                  className="space-y-4"
                  aria-labelledby="schedule-heading"
                >
                  <div>
                    <h3 id="schedule-heading" className="font-semibold">
                      Release schedule
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {feedbackModeDescriptions[formData.feedback_mode]}
                    </p>
                  </div>
                  {formData.feedback_mode === "automatic_delayed" ? (
                    <div className="grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="feedback-delay-min">
                          Earliest release (minutes)
                        </Label>
                        <Input
                          id="feedback-delay-min"
                          type="number"
                          min={0}
                          max={10080}
                          required
                          value={formData.feedback_delay_min_minutes}
                          onChange={(event) =>
                            setFormData({
                              ...formData,
                              feedback_delay_min_minutes: Number(
                                event.target.value,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="feedback-delay-max">
                          Latest release (minutes)
                        </Label>
                        <Input
                          id="feedback-delay-max"
                          type="number"
                          min={0}
                          max={10080}
                          required
                          value={formData.feedback_delay_max_minutes}
                          onChange={(event) =>
                            setFormData({
                              ...formData,
                              feedback_delay_max_minutes: Number(
                                event.target.value,
                              ),
                            })
                          }
                        />
                      </div>
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        Each submission receives a release time within this
                        range. The student sees that expected time while
                        waiting.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg border bg-muted/30 p-5">
                      <p className="font-medium">
                        No schedule range is needed.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {formData.feedback_mode === "immediate"
                          ? "Validated feedback releases immediately."
                          : "Feedback stays private until a teacher approves and releases it."}
                      </p>
                    </div>
                  )}
                </section>
              )}

              {wizardStep === 4 && (
                <section
                  className="space-y-4"
                  aria-labelledby="enrollment-heading"
                >
                  <div>
                    <h3 id="enrollment-heading" className="font-semibold">
                      Join code and approval
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Students request access with a private class code.
                    </p>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-4">
                    <div>
                      <Label htmlFor="batch-code-enabled">
                        Enable join code
                      </Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        You can copy or rotate the code after saving.
                      </p>
                    </div>
                    <Switch
                      id="batch-code-enabled"
                      checked={formData.join_code_enabled}
                      onCheckedChange={(checked) =>
                        setFormData({ ...formData, join_code_enabled: checked })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50/50 p-4">
                    <div>
                      <p className="text-sm font-medium">
                        Teacher approval required
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {mandatoryApprovalDescription}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-amber-200 bg-amber-50 text-amber-700"
                    >
                      Required
                    </Badge>
                  </div>
                </section>
              )}

              {wizardStep === 5 && (
                <section
                  className="space-y-4"
                  aria-labelledby="review-class-heading"
                >
                  <div>
                    <h3 id="review-class-heading" className="font-semibold">
                      Review the class setup
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      You can change these settings later.
                    </p>
                  </div>
                  <dl className="divide-y rounded-lg border">
                    <div className="grid grid-cols-[8rem_1fr] gap-3 p-3 text-sm">
                      <dt className="text-muted-foreground">Class</dt>
                      <dd className="font-medium">
                        {formData.name.trim()} · {formData.level}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[8rem_1fr] gap-3 p-3 text-sm">
                      <dt className="text-muted-foreground">Feedback</dt>
                      <dd className="font-medium">
                        {feedbackModeLabels[formData.feedback_mode]}
                      </dd>
                    </div>
                    {formData.feedback_mode === "automatic_delayed" && (
                      <div className="grid grid-cols-[8rem_1fr] gap-3 p-3 text-sm">
                        <dt className="text-muted-foreground">Release range</dt>
                        <dd>
                          {formData.feedback_delay_min_minutes}–
                          {formData.feedback_delay_max_minutes} minutes
                        </dd>
                      </div>
                    )}
                    <div className="grid grid-cols-[8rem_1fr] gap-3 p-3 text-sm">
                      <dt className="text-muted-foreground">Enrollment</dt>
                      <dd>
                        {formData.join_code_enabled
                          ? "Join code enabled; teacher approval required"
                          : "Join code disabled"}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[8rem_1fr] gap-3 p-3 text-sm">
                      <dt className="text-muted-foreground">Status</dt>
                      <dd>{formData.is_active ? "Active" : "Archived"}</dd>
                    </div>
                  </dl>
                </section>
              )}
            </div>

            <div
              className="shrink-0 border-t bg-background pt-3"
              data-testid="class-wizard-actions"
            >
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground sm:hidden">
                <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                Scroll within this step if more fields are below.
              </p>
              <DialogFooter className="mt-2 flex-row flex-wrap justify-end gap-2 sm:mt-3 sm:space-x-0">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDialogOpen(false)}
                  disabled={savingBatch}
                >
                  Cancel
                </Button>
                {wizardStep > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setWizardStep((current) => Math.max(1, current - 1))
                    }
                    disabled={savingBatch}
                  >
                    Back
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={savingBatch}
                  aria-busy={savingBatch}
                >
                  {savingBatch
                    ? editingBatch
                      ? "Saving class..."
                      : "Creating class..."
                    : wizardStep === classWizardSteps.length
                      ? editingBatch
                        ? "Save class"
                        : "Create class"
                      : "Continue"}
                </Button>
              </DialogFooter>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(writingLimitBatch)}
        onOpenChange={(open) => {
          if (!open && !savingWritingLimit) setWritingLimitBatch(null);
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            writingLimitOpenerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Daily writing limit</DialogTitle>
            <DialogDescription>
              {writingLimitBatch
                ? `Choose how many evaluated writings each student can submit daily in ${writingLimitBatch.name}.`
                : "Choose a daily writing limit."}
            </DialogDescription>
          </DialogHeader>
          {writingLimitBatch && (
            <form
              className="space-y-5"
              aria-busy={savingWritingLimit}
              onSubmit={(event) => {
                event.preventDefault();
                void saveWritingLimitRequest();
              }}
            >
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-md border bg-muted/20 p-3 text-sm">
                <dt className="text-muted-foreground">
                  Current approved limit
                </dt>
                <dd className="font-semibold">
                  {writingLimitBatch.current_writing_daily_limit}/day
                </dd>
                {writingLimitBatch.pending_writing_limit_request_status ===
                  "pending" && (
                  <>
                    <dt className="text-muted-foreground">
                      Request under review
                    </dt>
                    <dd className="font-semibold">
                      {writingLimitBatch.pending_writing_daily_limit}/day
                    </dd>
                  </>
                )}
              </dl>
              <div className="space-y-2">
                <Label htmlFor="requested-writing-limit">
                  Requested writings per student per day
                </Label>
                <Select
                  value={String(requestedWritingLimit)}
                  onValueChange={(value) =>
                    setRequestedWritingLimit(Number(value))
                  }
                  disabled={savingWritingLimit}
                >
                  <SelectTrigger
                    id="requested-writing-limit"
                    aria-label="Requested writings per student per day"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map(
                      (limit) => (
                        <SelectItem
                          key={limit}
                          value={String(limit)}
                          disabled={
                            limit ===
                            writingLimitBatch.current_writing_daily_limit
                          }
                        >
                          {limit} {limit === 1 ? "writing" : "writings"}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The current limit remains active until an administrator
                  approves this request. Approval changes this class&apos;s daily
                  writing limit for every student in the class.
                </p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setWritingLimitBatch(null)}
                  disabled={savingWritingLimit}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    savingWritingLimit ||
                    requestedWritingLimit ===
                      writingLimitBatch.current_writing_daily_limit ||
                    requestedWritingLimit ===
                      writingLimitBatch.pending_writing_daily_limit
                  }
                  aria-busy={savingWritingLimit}
                >
                  {savingWritingLimit
                    ? "Sending request..."
                    : writingLimitBatch.pending_writing_limit_request_status ===
                        "pending"
                      ? "Update request"
                      : "Send request"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
