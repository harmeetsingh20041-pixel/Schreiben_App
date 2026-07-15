import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  School,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  getMyTeacherStart,
  getMyTeacherAccessRequest,
  requestTeacherAccess,
  type MyTeacherAccessRequest,
} from "@/services/teacherAccessService";

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function StatusIcon({
  status,
}: {
  status: MyTeacherAccessRequest["request_status"];
}) {
  if (status === "approved") {
    return (
      <CheckCircle2 className="h-6 w-6 text-emerald-700" aria-hidden="true" />
    );
  }
  if (status === "pending") {
    return <Clock3 className="h-6 w-6 text-amber-700" aria-hidden="true" />;
  }
  return <XCircle className="h-6 w-6 text-destructive" aria-hidden="true" />;
}

function statusLabel(status: MyTeacherAccessRequest["request_status"]) {
  if (status === "approved") return "Approved";
  if (status === "pending") return "Under review";
  if (status === "rejected") return "Not approved";
  return "Access disabled";
}

export default function TeacherAccessPage() {
  const {
    activeMembershipId,
    loading: authLoading,
    needsWorkspace,
    refreshAccess,
    role,
    selectActiveMembership,
    teacherEntitled,
    user,
  } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const refreshedEntitlementRevision = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isSelectingTeachingArea, setIsSelectingTeachingArea] =
    useState(false);
  const [accessRefreshError, setAccessRefreshError] = useState<string | null>(
    null,
  );

  const statusQuery = useQuery({
    queryKey: appQueryKeys.teacherAccessSelf(),
    enabled: Boolean(user),
    queryFn: getMyTeacherAccessRequest,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const request = statusQuery.data ?? null;
  const startQuery = useQuery({
    queryKey: appQueryKeys.teacherAccessStart(),
    enabled: Boolean(user) && Boolean(request?.entitlement_active),
    queryFn: getMyTeacherStart,
  });
  const teacherStart = startQuery.data ?? null;

  useEffect(() => {
    const revision = request?.entitlement_active
      ? request.entitlement_revision
      : null;
    if (
      revision === null ||
      teacherEntitled ||
      refreshedEntitlementRevision.current === revision
    ) {
      return;
    }
    refreshedEntitlementRevision.current = revision;
    setAccessRefreshError(null);
    void refreshAccess().catch((error) => {
      setAccessRefreshError(
        formatErrorMessage(
          error,
          "Your approval is saved, but account access could not be refreshed.",
        ),
      );
    });
  }, [refreshAccess, request, teacherEntitled]);

  async function sendRequest() {
    setActionError(null);
    setIsRequesting(true);
    try {
      const result = await requestTeacherAccess(request?.request_revision ?? 0);
      queryClient.setQueryData(appQueryKeys.teacherAccessSelf(), result);
      toast({
        title: "Teacher access requested",
        description: "The platform administrator can now review your request.",
      });
    } catch (error) {
      setActionError(
        formatErrorMessage(
          error,
          "Your teacher-access request could not be sent.",
        ),
      );
      await statusQuery.refetch();
    } finally {
      setIsRequesting(false);
    }
  }

  const statusError = statusQuery.error
    ? formatErrorMessage(
        statusQuery.error,
        "Your teacher-access status could not be loaded.",
      )
    : null;
  const startError = startQuery.error
    ? formatErrorMessage(
        startQuery.error,
        "Your approval is active, but the first-class setup could not be prepared.",
      )
    : null;
  const canEnterTeaching = request?.entitlement_active && teacherEntitled;
  const teacherStartLoading =
    Boolean(request?.entitlement_active) && startQuery.isPending;
  const teachingDestination = teacherStart?.needs_first_class
    ? "/teacher/batches?create=first-class"
    : needsWorkspace
      ? "/teacher/onboarding"
      : role === "teacher"
        ? "/teacher/dashboard"
        : "/teacher/onboarding";

  async function enterTeaching(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !teacherStart ||
      activeMembershipId === teacherStart.membership_id ||
      isSelectingTeachingArea
    ) {
      return;
    }

    event.preventDefault();
    setIsSelectingTeachingArea(true);
    setAccessRefreshError(null);
    try {
      await selectActiveMembership(teacherStart.membership_id);
      setLocation(teachingDestination);
    } catch (error) {
      setAccessRefreshError(
        formatErrorMessage(
          error,
          "Your teaching area could not be selected. Refresh and try again.",
        ),
      );
    } finally {
      setIsSelectingTeachingArea(false);
    }
  }

  return (
    <div className="container mx-auto max-w-3xl space-y-7 px-4 py-8 sm:py-12">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Verified teacher onboarding
        </div>
        <h1 className="text-3xl font-serif tracking-tight sm:text-4xl">
          Teacher access
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Request access once. An administrator verifies the account, and then
          you can create your first class and start teaching.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-xl">
            <School className="h-5 w-5 text-primary" aria-hidden="true" />
            Your request
          </CardTitle>
          <CardDescription>
            Your learner access remains available while this request is
            reviewed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {statusQuery.isPending ? (
            <div
              className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading teacher-access status...
            </div>
          ) : statusError ? (
            <div className="space-y-4">
              <p
                className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                {statusError}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void statusQuery.refetch()}
                disabled={statusQuery.isFetching}
              >
                {statusQuery.isFetching ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Try again
              </Button>
            </div>
          ) : request ? (
            <div className="space-y-5">
              <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex gap-3">
                  <StatusIcon status={request.request_status} />
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">
                        {statusLabel(request.request_status)}
                      </p>
                      <Badge
                        variant={
                          request.request_status === "approved"
                            ? "default"
                            : request.request_status === "pending"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {request.request_status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {request.request_status === "pending"
                        ? "No action is needed while the administrator reviews it."
                        : request.request_status === "approved"
                          ? request.entitlement_active
                            ? "Your verified teacher access is active."
                            : "The approval record exists, but access is not currently active."
                          : request.request_status === "rejected"
                            ? "You can submit a new request if access should be reconsidered."
                            : "You can submit a new request when teaching access is needed again."}
                    </p>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground sm:text-right">
                  <p>Requested {formatDate(request.requested_at)}</p>
                  {request.decided_at && (
                    <p>Updated {formatDate(request.decided_at)}</p>
                  )}
                </div>
              </div>

              {request.entitlement_active &&
                request.entitlement_max_workspaces && (
                  <p className="text-sm text-muted-foreground">
                    Approved teaching-area limit:{" "}
                    {request.entitlement_max_workspaces}
                  </p>
                )}

              {(actionError || accessRefreshError || startError) && (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                  role="alert"
                >
                  {actionError ?? accessRefreshError ?? startError}
                </p>
              )}

              {request.request_status === "pending" ? (
                <p
                  className="text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  This page checks automatically for an administrator decision.
                </p>
              ) : canEnterTeaching && !teacherStartLoading && !startError ? (
                <Button asChild className="w-full sm:w-auto">
                  <Link
                    href={teachingDestination}
                    onClick={(event) => void enterTeaching(event)}
                  >
                    {isSelectingTeachingArea
                      ? "Opening class setup..."
                      : teacherStart?.needs_first_class
                      ? "Create your first class"
                      : needsWorkspace
                        ? "Set up teaching"
                        : "Open teacher dashboard"}
                  </Link>
                </Button>
              ) : request.entitlement_active ? (
                <Button
                  type="button"
                  onClick={() => {
                    void Promise.all([refreshAccess(), startQuery.refetch()]);
                  }}
                  disabled={authLoading || teacherStartLoading}
                >
                  {(authLoading || teacherStartLoading) && (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {teacherStartLoading
                    ? "Preparing your first class..."
                    : "Refresh approved access"}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void sendRequest()}
                  disabled={isRequesting}
                >
                  {isRequesting && (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  Request teacher access again
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="font-semibold">No teacher-access request yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Send one verified request. You do not need to email account
                  details or wait for a teacher to invite you.
                </p>
              </div>
              {actionError && (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                  role="alert"
                >
                  {actionError}
                </p>
              )}
              <Button
                type="button"
                onClick={() => void sendRequest()}
                disabled={isRequesting}
              >
                {isRequesting && (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Request teacher access
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
