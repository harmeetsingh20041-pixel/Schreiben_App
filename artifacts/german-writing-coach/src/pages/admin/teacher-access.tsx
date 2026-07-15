import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  UserRoundCog,
  Users,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AdminMfaReauthDialog } from "@/components/admin-mfa-reauth-dialog";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { isPublicAppError } from "@/lib/appError";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  decideBatchWritingLimit,
  listBatchWritingLimitRequests,
  type BatchWritingLimitRequestCursor,
  type BatchWritingLimitRequestItem,
  type BatchWritingLimitRequestStatus,
  type BatchWritingLimitRequestStatusFilter,
} from "@/services/batchWritingLimitService";
import {
  decideTeacherAccess,
  disableTeacherAccess,
  getTeacherOnboardingHealth,
  listTeacherAccessRequests,
  updateTeacherWorkspaceLimit,
  type TeacherAccessCursor,
  type TeacherAccessInventoryItem,
  type TeacherAccessStatus,
} from "@/services/teacherAccessService";

const PAGE_SIZE = 25;
const EMPTY_INVENTORY_ITEMS: TeacherAccessInventoryItem[] = [];
const EMPTY_WRITING_LIMIT_ITEMS: BatchWritingLimitRequestItem[] = [];

function formatDate(value: string | null) {
  if (!value) return "Not available";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusBadge(status: TeacherAccessStatus) {
  if (status === "approved") return "default" as const;
  if (status === "pending") return "secondary" as const;
  if (status === "disabled") return "destructive" as const;
  return "outline" as const;
}

function writingLimitStatusBadge(status: BatchWritingLimitRequestStatus) {
  if (status === "approved") return "default" as const;
  if (status === "pending") return "secondary" as const;
  return "outline" as const;
}

function parseWorkspaceLimit(value: string, currentCount: number) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) &&
    limit >= Math.max(1, currentCount) &&
    limit <= 100
    ? limit
    : null;
}

export default function AdminTeacherAccessPage() {
  const { toast } = useToast();
  const { refreshAccess } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<TeacherAccessStatus | "all">(
    "all",
  );
  const [cursorTrail, setCursorTrail] = useState<
    Array<TeacherAccessCursor | null>
  >([null]);
  const [writingLimitStatusFilter, setWritingLimitStatusFilter] =
    useState<BatchWritingLimitRequestStatusFilter>("pending");
  const [writingLimitCursorTrail, setWritingLimitCursorTrail] = useState<
    Array<BatchWritingLimitRequestCursor | null>
  >([null]);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingFreshAction, setPendingFreshAction] = useState<{
    key: string;
    action: () => Promise<void>;
    fallback: string;
  } | null>(null);
  const cursor = cursorTrail[cursorTrail.length - 1] ?? null;
  const writingLimitCursor =
    writingLimitCursorTrail[writingLimitCursorTrail.length - 1] ?? null;

  useEffect(() => {
    setCursorTrail([null]);
  }, [statusFilter]);

  useEffect(() => {
    setWritingLimitCursorTrail([null]);
  }, [writingLimitStatusFilter]);

  const healthQuery = useQuery({
    queryKey: appQueryKeys.teacherAccessHealth(),
    queryFn: getTeacherOnboardingHealth,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const inventoryQuery = useQuery({
    queryKey: appQueryKeys.teacherAccessInventoryPage({
      status: statusFilter,
      pageSize: PAGE_SIZE,
      cursor,
    }),
    queryFn: () =>
      listTeacherAccessRequests({
        status: statusFilter === "all" ? null : statusFilter,
        pageSize: PAGE_SIZE,
        cursor,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const writingLimitQuery = useQuery({
    queryKey: appQueryKeys.batchWritingLimitRequestsPage({
      status: writingLimitStatusFilter,
      pageSize: PAGE_SIZE,
      cursor: writingLimitCursor,
    }),
    queryFn: () =>
      listBatchWritingLimitRequests({
        status: writingLimitStatusFilter,
        pageSize: PAGE_SIZE,
        cursor: writingLimitCursor,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const items = inventoryQuery.data?.items ?? EMPTY_INVENTORY_ITEMS;
  const writingLimitItems =
    writingLimitQuery.data?.items ?? EMPTY_WRITING_LIMIT_ITEMS;

  useEffect(() => {
    setLimits((current) => {
      let next = current;
      for (const item of items) {
        if (next[item.applicant_user_id] === undefined) {
          if (next === current) next = { ...current };
          next[item.applicant_user_id] = String(
            item.entitlement_max_workspaces ??
              item.approved_max_workspaces ??
              Math.max(1, item.privileged_workspace_count),
          );
        }
      }
      return next;
    });
  }, [items]);

  const integrityWarningCount = useMemo(() => {
    const health = healthQuery.data;
    return health
      ? health.owned_workspace_without_active_access_count +
          health.privileged_membership_without_active_access_count
      : 0;
  }, [healthQuery.data]);

  async function refreshAdminData() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: appQueryKeys.teacherAccessInventory(),
      }),
      queryClient.invalidateQueries({
        queryKey: appQueryKeys.teacherAccessHealth(),
      }),
      queryClient.invalidateQueries({
        queryKey: appQueryKeys.batchWritingLimitRequests(),
      }),
    ]);
  }

  async function runAction(
    key: string,
    action: () => Promise<void>,
    alreadyRetried = false,
    fallback = "The teacher-access action could not be completed.",
  ) {
    setBusyAction(key);
    setActionError(null);
    let awaitingFreshAuthentication = false;
    try {
      await action();
      await refreshAdminData();
    } catch (error) {
      if (
        isPublicAppError(error) &&
        error.code === "data_fresh_reauthentication_required" &&
        !alreadyRetried
      ) {
        awaitingFreshAuthentication = true;
        setPendingFreshAction({ key, action, fallback });
        return;
      }
      if (isPublicAppError(error) && error.code === "data_mfa_required") {
        setActionError(
          "Two-factor setup changed. Refresh account access, then complete MFA before retrying.",
        );
        await refreshAccess();
        return;
      }
      setActionError(formatErrorMessage(error, fallback));
      await refreshAdminData();
    } finally {
      if (!awaitingFreshAuthentication) setBusyAction(null);
    }
  }

  async function retryPendingAction() {
    const pending = pendingFreshAction;
    if (!pending) return;
    await runAction(pending.key, pending.action, true, pending.fallback);
    setPendingFreshAction(null);
  }

  function cancelPendingAction() {
    setPendingFreshAction(null);
    setBusyAction(null);
  }

  async function approve(item: TeacherAccessInventoryItem) {
    const limit = parseWorkspaceLimit(
      limits[item.applicant_user_id] ?? "1",
      item.privileged_workspace_count,
    );
    if (!item.request_id || item.request_revision === null || limit === null) {
      setActionError(
        `Choose a workspace limit from ${Math.max(1, item.privileged_workspace_count)} to 100.`,
      );
      return;
    }
    await runAction(`approve:${item.applicant_user_id}`, async () => {
      await decideTeacherAccess({
        requestId: item.request_id!,
        decision: "approved",
        expectedRevision: item.request_revision!,
        workspaceLimit: limit,
      });
      toast({
        title: "Teacher access approved",
        description:
          "The account's teaching area is ready, so they can create their first class.",
      });
    });
  }

  async function reject(item: TeacherAccessInventoryItem) {
    if (!item.request_id || item.request_revision === null) return;
    await runAction(`reject:${item.applicant_user_id}`, async () => {
      await decideTeacherAccess({
        requestId: item.request_id!,
        decision: "rejected",
        expectedRevision: item.request_revision!,
      });
      toast({ title: "Teacher access request rejected" });
    });
  }

  async function saveLimit(item: TeacherAccessInventoryItem) {
    const limit = parseWorkspaceLimit(
      limits[item.applicant_user_id] ?? "",
      item.privileged_workspace_count,
    );
    if (item.entitlement_revision === null || limit === null) {
      setActionError(
        `Choose a workspace limit from ${Math.max(1, item.privileged_workspace_count)} to 100.`,
      );
      return;
    }
    await runAction(`limit:${item.applicant_user_id}`, async () => {
      await updateTeacherWorkspaceLimit({
        userId: item.applicant_user_id,
        expectedEntitlementRevision: item.entitlement_revision!,
        workspaceLimit: limit,
      });
      toast({
        title: "Workspace limit updated",
        description: `This teacher can use up to ${limit} workspace${limit === 1 ? "" : "s"}.`,
      });
    });
  }

  async function disable(item: TeacherAccessInventoryItem) {
    if (item.entitlement_revision === null) return;
    await runAction(`disable:${item.applicant_user_id}`, async () => {
      const result = await disableTeacherAccess({
        userId: item.applicant_user_id,
        expectedEntitlementRevision: item.entitlement_revision!,
      });
      toast({
        title: "Teacher access disabled",
        description: `${result.transferred_workspace_count} owned workspace${result.transferred_workspace_count === 1 ? " was" : "s were"} transferred safely.`,
      });
    });
  }

  async function decideWritingLimit(
    item: BatchWritingLimitRequestItem,
    decision: "approved" | "rejected",
  ) {
    await runAction(
      `writing-limit:${decision}:${item.request_id}`,
      async () => {
        const result = await decideBatchWritingLimit({
          requestId: item.request_id,
          decision,
          expectedRevision: item.request_revision,
        });
        toast({
          title:
            decision === "approved"
              ? "Daily writing limit approved"
              : "Daily writing limit request rejected",
          description:
            decision === "approved"
              ? `${item.batch_name} now allows ${result.current_writing_daily_limit} evaluated writings per student each day.`
              : `${item.batch_name} remains at ${result.current_writing_daily_limit} evaluated writings per student each day.`,
        });
      },
      false,
      "The daily writing-limit request could not be completed.",
    );
  }

  const healthError = healthQuery.error
    ? formatErrorMessage(
        healthQuery.error,
        "Teacher-onboarding health could not be loaded.",
      )
    : null;
  const inventoryError = inventoryQuery.error
    ? formatErrorMessage(
        inventoryQuery.error,
        "Teacher access requests could not be loaded.",
      )
    : null;
  const writingLimitError = writingLimitQuery.error
    ? formatErrorMessage(
        writingLimitQuery.error,
        "Daily writing-limit requests could not be loaded.",
      )
    : null;

  return (
    <div className="container mx-auto max-w-6xl space-y-8 px-4 py-8 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Platform administration
          </div>
          <h1 className="mt-2 text-3xl font-serif tracking-tight sm:text-4xl">
            Teacher access
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Approve verified accounts, manage workspace access, and review class
            writing-limit requests.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refreshAdminData()}
          disabled={
            healthQuery.isFetching ||
            inventoryQuery.isFetching ||
            writingLimitQuery.isFetching
          }
        >
          {healthQuery.isFetching ||
          inventoryQuery.isFetching ||
          writingLimitQuery.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      {healthError && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {healthError}
        </p>
      )}

      <section aria-labelledby="access-health-heading" className="space-y-3">
        <h2 id="access-health-heading" className="text-xl font-semibold">
          Access health
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HealthCard
            label="Pending requests"
            value={healthQuery.data?.pending_request_count}
            icon={
              <Users className="h-5 w-5 text-amber-700" aria-hidden="true" />
            }
          />
          <HealthCard
            label="Active teachers"
            value={healthQuery.data?.active_entitlement_count}
            icon={
              <UserCheck
                className="h-5 w-5 text-emerald-700"
                aria-hidden="true"
              />
            }
          />
          <HealthCard
            label="Inactive access"
            value={healthQuery.data?.inactive_or_expired_entitlement_count}
            icon={
              <UserRoundCog
                className="h-5 w-5 text-muted-foreground"
                aria-hidden="true"
              />
            }
          />
          <HealthCard
            label="Integrity warnings"
            value={healthQuery.data ? integrityWarningCount : undefined}
            icon={
              integrityWarningCount > 0 ? (
                <AlertTriangle
                  className="h-5 w-5 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2
                  className="h-5 w-5 text-emerald-700"
                  aria-hidden="true"
                />
              )
            }
            warning={integrityWarningCount > 0}
          />
        </div>
      </section>

      {actionError && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <section
        aria-labelledby="writing-limit-requests-heading"
        className="space-y-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FilePenLine
                className="h-5 w-5 text-primary"
                aria-hidden="true"
              />
              <h2
                id="writing-limit-requests-heading"
                className="text-xl font-semibold"
              >
                Daily writing-limit requests
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Approvals affect only the named class. Each number is the daily
              evaluated-writing allowance for one student.
            </p>
            {writingLimitQuery.data && (
              <p className="mt-1 text-sm text-muted-foreground">
                {writingLimitQuery.data.total_count} matching request
                {writingLimitQuery.data.total_count === 1 ? "" : "s"} · Page{" "}
                {writingLimitCursorTrail.length}
              </p>
            )}
          </div>
          <Select
            value={writingLimitStatusFilter}
            onValueChange={(value) =>
              setWritingLimitStatusFilter(
                value as BatchWritingLimitRequestStatusFilter,
              )
            }
          >
            <SelectTrigger
              className="w-full sm:w-64"
              aria-label="Filter daily writing-limit requests"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending requests</SelectItem>
              <SelectItem value="approved">Approved requests</SelectItem>
              <SelectItem value="rejected">Rejected requests</SelectItem>
              <SelectItem value="all">All requests</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {writingLimitError ? (
          <Card>
            <CardContent
              className="py-10 text-center text-sm text-destructive"
              role="alert"
            >
              {writingLimitError}
            </CardContent>
          </Card>
        ) : writingLimitQuery.isPending ? (
          <Card>
            <CardContent
              className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading daily writing-limit requests...
            </CardContent>
          </Card>
        ) : writingLimitItems.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="font-medium">No matching writing-limit requests</p>
              <p className="mt-1 text-sm text-muted-foreground">
                New teacher requests will appear here automatically.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {writingLimitItems.map((item) => (
              <WritingLimitRequestCard
                key={item.request_id}
                item={item}
                busyDecision={
                  busyAction === `writing-limit:approved:${item.request_id}`
                    ? "approved"
                    : busyAction === `writing-limit:rejected:${item.request_id}`
                      ? "rejected"
                      : null
                }
                onApprove={() => void decideWritingLimit(item, "approved")}
                onReject={() => void decideWritingLimit(item, "rejected")}
              />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            aria-label="Previous daily writing-limit requests page"
            onClick={() =>
              setWritingLimitCursorTrail((trail) => trail.slice(0, -1))
            }
            disabled={
              writingLimitCursorTrail.length === 1 ||
              writingLimitQuery.isFetching
            }
          >
            <ChevronLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {writingLimitCursorTrail.length}
          </span>
          <Button
            type="button"
            variant="outline"
            aria-label="Next daily writing-limit requests page"
            onClick={() => {
              const nextCursor = writingLimitQuery.data?.next_cursor;
              if (nextCursor) {
                setWritingLimitCursorTrail((trail) => [...trail, nextCursor]);
              }
            }}
            disabled={
              writingLimitQuery.isFetching ||
              !writingLimitQuery.data?.has_more ||
              !writingLimitQuery.data.next_cursor
            }
          >
            Next
            <ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </section>

      <section
        aria-labelledby="teacher-inventory-heading"
        className="space-y-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="teacher-inventory-heading"
              className="text-xl font-semibold"
            >
              Accounts
            </h2>
            <p className="text-sm text-muted-foreground">
              Page {cursorTrail.length}. Newest updates appear first.
            </p>
          </div>
          <Select
            value={statusFilter}
            onValueChange={(value) =>
              setStatusFilter(value as TeacherAccessStatus | "all")
            }
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label="Filter teacher access"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teacher accounts</SelectItem>
              <SelectItem value="pending">Pending requests</SelectItem>
              <SelectItem value="approved">Approved teachers</SelectItem>
              <SelectItem value="rejected">Rejected requests</SelectItem>
              <SelectItem value="disabled">Disabled access</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {inventoryError ? (
          <Card>
            <CardContent
              className="py-10 text-center text-sm text-destructive"
              role="alert"
            >
              {inventoryError}
            </CardContent>
          </Card>
        ) : inventoryQuery.isPending ? (
          <Card>
            <CardContent
              className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading teacher accounts...
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="font-medium">No matching teacher accounts</p>
              <p className="mt-1 text-sm text-muted-foreground">
                New requests will appear here automatically.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {items.map((item) => {
              const itemBusy =
                busyAction?.endsWith(item.applicant_user_id) ?? false;
              const limit = limits[item.applicant_user_id] ?? "1";
              const minimumLimit = Math.max(1, item.privileged_workspace_count);
              return (
                <Card
                  key={item.page_cursor_id}
                  className="shadow-sm"
                  data-testid="teacher-access-account"
                  data-applicant-user-id={item.applicant_user_id}
                >
                  <CardContent className="space-y-5 p-5 sm:p-6">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold">
                            {item.applicant_name ?? "Unnamed account"}
                          </h3>
                          <Badge variant={statusBadge(item.request_status)}>
                            {item.request_status}
                          </Badge>
                          {item.entitlement_active && (
                            <Badge variant="outline">Access active</Badge>
                          )}
                        </div>
                        <p className="mt-1 break-all text-sm text-muted-foreground">
                          {item.applicant_email ?? "Email unavailable"}
                        </p>
                      </div>
                      <div className="text-sm text-muted-foreground lg:text-right">
                        <p>
                          {item.privileged_workspace_count} current workspace
                          {item.privileged_workspace_count === 1 ? "" : "s"}
                        </p>
                        <p>Updated {formatDate(item.updated_at)}</p>
                      </div>
                    </div>

                    {item.request_status === "pending" &&
                    item.request_id &&
                    item.request_revision !== null ? (
                      <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 md:flex-row md:items-end md:justify-between">
                        <div className="w-full max-w-52 space-y-2">
                          <Label
                            htmlFor={`approval-limit-${item.applicant_user_id}`}
                          >
                            Workspace limit
                          </Label>
                          <Input
                            id={`approval-limit-${item.applicant_user_id}`}
                            type="number"
                            inputMode="numeric"
                            min={minimumLimit}
                            max={100}
                            value={limit}
                            onChange={(event) =>
                              setLimits((current) => ({
                                ...current,
                                [item.applicant_user_id]: event.target.value,
                              }))
                            }
                            disabled={itemBusy}
                          />
                          <p className="text-xs text-muted-foreground">
                            Start with 1 for a normal pilot teacher.
                          </p>
                        </div>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reject(item)}
                            disabled={itemBusy}
                          >
                            Reject
                          </Button>
                          <Button
                            type="button"
                            onClick={() => void approve(item)}
                            disabled={itemBusy}
                          >
                            {busyAction ===
                              `approve:${item.applicant_user_id}` && (
                              <Loader2
                                className="mr-2 h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
                            )}
                            Approve teacher
                          </Button>
                        </div>
                      </div>
                    ) : item.entitlement_active &&
                      item.entitlement_revision !== null ? (
                      <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 md:flex-row md:items-end md:justify-between">
                        <div className="w-full max-w-52 space-y-2">
                          <Label
                            htmlFor={`active-limit-${item.applicant_user_id}`}
                          >
                            Workspace limit
                          </Label>
                          <Input
                            id={`active-limit-${item.applicant_user_id}`}
                            type="number"
                            inputMode="numeric"
                            min={minimumLimit}
                            max={100}
                            value={limit}
                            onChange={(event) =>
                              setLimits((current) => ({
                                ...current,
                                [item.applicant_user_id]: event.target.value,
                              }))
                            }
                            disabled={itemBusy}
                          />
                        </div>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                variant="destructive"
                                disabled={itemBusy}
                              >
                                Disable access
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Disable teacher access?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  This immediately removes teacher permissions.
                                  Any workspace they own is transferred to your
                                  admin account so student history and work
                                  remain available.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>
                                  Keep access
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => void disable(item)}
                                >
                                  Disable teacher
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void saveLimit(item)}
                            disabled={itemBusy}
                          >
                            {busyAction ===
                              `limit:${item.applicant_user_id}` && (
                              <Loader2
                                className="mr-2 h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
                            )}
                            Save limit
                          </Button>
                        </div>
                      </div>
                    ) : item.entitlement_revision !== null &&
                      item.privileged_workspace_count > 0 ? (
                      <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-medium">
                            Inactive access still has workspace authority
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Access already fails closed. Finish offboarding to
                            transfer ownership and remove the remaining
                            privileged membership rows.
                          </p>
                        </div>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="destructive"
                              disabled={itemBusy}
                            >
                              Finish offboarding
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Finish teacher offboarding?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                The account is already denied teacher access.
                                This transfers owned workspaces to your admin
                                account and removes residual owner or teacher
                                memberships.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => void disable(item)}
                              >
                                Finish offboarding
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    ) : (
                      <p className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                        {item.request_status === "rejected"
                          ? "The applicant can submit a fresh request if access should be reconsidered."
                          : "Access is inactive. The account owner can submit a new request when needed."}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCursorTrail((trail) => trail.slice(0, -1))}
            disabled={cursorTrail.length === 1 || inventoryQuery.isFetching}
          >
            <ChevronLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {cursorTrail.length}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const nextCursor = inventoryQuery.data?.next_cursor;
              if (nextCursor) setCursorTrail((trail) => [...trail, nextCursor]);
            }}
            disabled={
              inventoryQuery.isFetching ||
              !inventoryQuery.data?.has_more ||
              !inventoryQuery.data.next_cursor
            }
          >
            Next
            <ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </section>
      <AdminMfaReauthDialog
        open={pendingFreshAction !== null}
        onCancel={cancelPendingAction}
        onVerified={retryPendingAction}
      />
    </div>
  );
}

function WritingLimitRequestCard({
  item,
  busyDecision,
  onApprove,
  onReject,
}: {
  item: BatchWritingLimitRequestItem;
  busyDecision: "approved" | "rejected" | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isPending = item.request_status === "pending";
  const busy = busyDecision !== null;
  return (
    <Card
      className="shadow-sm"
      data-testid="batch-writing-limit-request"
      data-request-id={item.request_id}
    >
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{item.batch_name}</h3>
              <Badge variant={writingLimitStatusBadge(item.request_status)}>
                {item.request_status}
              </Badge>
              {!item.batch_active && (
                <Badge variant="outline">Class inactive</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {item.workspace_name}
            </p>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              Requested by {item.requester_name ?? "Unnamed teacher"}
              {item.requester_email ? ` · ${item.requester_email}` : ""}
            </p>
          </div>
          <div className="text-sm text-muted-foreground lg:text-right">
            <p>Requested {formatDate(item.requested_at)}</p>
            {item.decided_at && <p>Decided {formatDate(item.decided_at)}</p>}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current daily limit
            </p>
            <p className="mt-1 text-2xl font-serif">
              {item.current_writing_daily_limit}
            </p>
            <p className="text-sm text-muted-foreground">
              evaluated writings per student
            </p>
          </div>
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Requested daily limit
            </p>
            <p className="mt-1 text-2xl font-serif">
              {item.requested_writing_daily_limit}
            </p>
            <p className="text-sm text-muted-foreground">
              evaluated writings per student
            </p>
          </div>
        </div>

        {isPending ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {item.batch_active
                ? "Approval changes only this class."
                : "This class is inactive, so the request cannot be approved."}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                aria-label={`Reject writing-limit request for ${item.batch_name}`}
                disabled={busy}
                onClick={onReject}
              >
                {busyDecision === "rejected" && (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Reject
              </Button>
              <Button
                type="button"
                aria-label={`Approve writing-limit request for ${item.batch_name}`}
                disabled={busy || !item.batch_active}
                onClick={onApprove}
              >
                {busyDecision === "approved" && (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Approve limit
              </Button>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
            This request has been {item.request_status} and cannot be changed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HealthCard({
  icon,
  label,
  value,
  warning = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  warning?: boolean;
}) {
  return (
    <Card
      className={
        warning ? "border-destructive/30 bg-destructive/5" : "shadow-sm"
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p
          className="text-3xl font-serif"
          aria-label={`${label}: ${value ?? "loading"}`}
        >
          {value ?? "..."}
        </p>
      </CardContent>
    </Card>
  );
}
