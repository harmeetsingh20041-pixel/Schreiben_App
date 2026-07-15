import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  getSubmissionIssueLabel,
  SubmissionStatusBadge,
} from "@/components/submission-status-badge";
import {
  getWeaknessBadgeClass,
  getWeaknessLabel,
} from "@/services/grammarStatsService";
import {
  formatTeacherIssueCount,
  getTeacherPracticeBadgeClass,
  getTeacherPracticeLabel,
  isTeacherSupportRecommended,
} from "@/services/teacherReadModelService";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { createTeacherDashboardQueries } from "@/lib/dashboardQueries";
import type { WorkspaceBatchOption } from "@/services/batchService";
import {
  Users,
  FileText,
  CheckCircle,
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Loader2,
} from "lucide-react";

export default function TeacherDashboard() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();

  const [batchFilter, setBatchFilter] = useState("all");
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [batchSearch, setBatchSearch] = useState("");
  const [debouncedBatchSearch, setDebouncedBatchSearch] = useState("");
  const [selectedBatch, setSelectedBatch] =
    useState<WorkspaceBatchOption | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedBatchSearch(batchSearch.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [batchSearch]);

  const dashboardQueries = createTeacherDashboardQueries(
    workspaceId ?? "inactive-workspace",
    batchFilter === "all" ? null : batchFilter,
    debouncedBatchSearch,
  );
  const queryEnabled = Boolean(user) && Boolean(workspaceId);
  const batchesQuery = useInfiniteQuery({
    ...dashboardQueries.batches,
    enabled: queryEnabled,
    placeholderData: keepPreviousData,
  });
  const summaryQuery = useQuery({
    ...dashboardQueries.summary,
    enabled: queryEnabled,
  });
  const submissionsQuery = useQuery({
    ...dashboardQueries.submissions,
    enabled: queryEnabled,
    placeholderData: keepPreviousData,
  });

  const batchSearchIsSettled =
    batchSearch.trim() === debouncedBatchSearch &&
    !batchesQuery.isPlaceholderData;
  const batches = useMemo(
    () =>
      batchSearchIsSettled
        ? (batchesQuery.data?.pages.flatMap((page) => page.items) ?? [])
        : [],
    [batchSearchIsSettled, batchesQuery.data],
  );
  const batchOptionsPage = batchesQuery.data?.pages[0];
  const dashboardSummary = summaryQuery.data;
  const realFilteredSubmissions = submissionsQuery.data?.items ?? [];
  const attentionItems = dashboardSummary?.attention_items ?? [];
  const summaryLoading = queryEnabled && summaryQuery.isPending;
  const batchCountLoading = queryEnabled && !batchOptionsPage;
  const firstQueryError = [
    batchesQuery.isError && !batchesQuery.data ? batchesQuery.error : null,
    summaryQuery.error,
    submissionsQuery.error,
  ].find(Boolean);
  const error = !workspaceId
    ? "No workspace found. Create a workspace before viewing the dashboard."
    : firstQueryError
      ? formatErrorMessage(
          firstQueryError,
          "Unable to load all dashboard data.",
        )
      : null;

  const totalStudents = dashboardSummary?.student_count ?? 0;
  const totalBatches = batchOptionsPage?.unfiltered_total_count ?? 0;
  const filteredBatchTotal = batchOptionsPage?.total_count ?? 0;
  const totalQuestions = dashboardSummary?.question_count ?? 0;
  const totalPendingAccess = dashboardSummary?.pending_join_request_count ?? 0;

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2 text-foreground">
            Teacher Overview
          </h1>
          <p className="text-muted-foreground tracking-wide">
            Monitor student progress and recent submissions.
          </p>
        </div>
        <div className="w-full md:w-72">
          <Popover open={batchPickerOpen} onOpenChange={setBatchPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={batchPickerOpen}
                aria-label="Filter overview by class"
                className="w-full justify-between bg-card font-normal"
              >
                <span className="truncate">
                  {batchFilter === "all"
                    ? "All classes"
                    : (selectedBatch?.name ?? "Selected class")}
                </span>
                <ChevronsUpDown className="opacity-50" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(22rem,calc(100vw-2rem))] p-0"
              align="end"
            >
              <Command shouldFilter={false} label="Search classes">
                <CommandInput
                  value={batchSearch}
                  onValueChange={setBatchSearch}
                  placeholder="Search classes..."
                />
                <CommandList>
                  <CommandGroup>
                    <CommandItem
                      value="all-classes"
                      onSelect={() => {
                        setBatchFilter("all");
                        setSelectedBatch(null);
                        setBatchSearch("");
                        setBatchPickerOpen(false);
                      }}
                    >
                      <Check
                        className={
                          batchFilter === "all" ? "opacity-100" : "opacity-0"
                        }
                        aria-hidden="true"
                      />
                      All classes
                    </CommandItem>
                    {batches.map((batch) => (
                      <CommandItem
                        key={batch.id}
                        value={batch.id}
                        onSelect={() => {
                          setBatchFilter(batch.id);
                          setSelectedBatch(batch);
                          setBatchSearch("");
                          setBatchPickerOpen(false);
                        }}
                      >
                        <Check
                          className={
                            batchFilter === batch.id
                              ? "opacity-100"
                              : "opacity-0"
                          }
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {batch.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {batch.level}
                          {batch.is_active ? "" : " · Archived"}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>

                {batchesQuery.isError && !batchesQuery.isFetchNextPageError ? (
                  <div
                    className="space-y-2 px-3 py-4 text-center text-sm"
                    role="alert"
                  >
                    <p className="text-destructive">
                      Classes could not be loaded.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void batchesQuery.refetch()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : !batchSearchIsSettled || batchesQuery.isPending ? (
                  <div
                    className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Searching classes...
                  </div>
                ) : filteredBatchTotal === 0 ? (
                  <p
                    className="px-3 py-4 text-center text-sm text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    No classes match your search.
                  </p>
                ) : null}

                {batchesQuery.hasNextPage && batchSearchIsSettled && (
                  <div className="border-t p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      onClick={() => void batchesQuery.fetchNextPage()}
                      onKeyDown={(event) => event.stopPropagation()}
                      disabled={batchesQuery.isFetchingNextPage}
                      aria-busy={batchesQuery.isFetchingNextPage}
                    >
                      {batchesQuery.isFetchingNextPage ? (
                        <>
                          <Loader2
                            className="animate-spin"
                            aria-hidden="true"
                          />
                          Loading more...
                        </>
                      ) : (
                        `Load more (${batches.length} of ${filteredBatchTotal})`
                      )}
                    </Button>
                    {batchesQuery.isFetchNextPageError && (
                      <p
                        className="mt-1 text-center text-xs text-destructive"
                        role="alert"
                      >
                        More classes could not be loaded. Try again.
                      </p>
                    )}
                  </div>
                )}
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">
            {error}
          </CardContent>
        </Card>
      )}

      <OnboardingChecklist role="teacher" />

      <div className="grid grid-cols-1 gap-6 mb-12 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                  Students
                </p>
                <h3 className="text-3xl font-serif text-foreground">
                  {summaryLoading ? "..." : totalStudents}
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                  Writing Tasks
                </p>
                <h3 className="text-3xl font-serif text-foreground">
                  {summaryLoading ? "..." : totalQuestions}
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-[#2E7D32]/20 bg-[#2E7D32]/5 flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-[#2E7D32]" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                  Classes
                </p>
                <h3 className="text-3xl font-serif text-foreground">
                  {batchCountLoading ? "..." : totalBatches}
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-accent/20 bg-accent/5 rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-accent/20 bg-accent/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                  Pending Access
                </p>
                <h3
                  className="text-lg font-serif text-foreground truncate mt-1"
                  aria-live="polite"
                >
                  {summaryLoading ? "..." : totalPendingAccess}
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">
            Recent Submissions
          </h2>
          {submissionsQuery.isPending || submissionsQuery.isPlaceholderData ? (
            <Card
              className="border-dashed shadow-sm border-border rounded-xl"
              aria-busy="true"
            >
              <CardContent
                className="p-8 text-center text-sm text-muted-foreground"
                role="status"
              >
                Loading recent submissions...
              </CardContent>
            </Card>
          ) : submissionsQuery.isError ? (
            <Card className="border-destructive/30 bg-destructive/5 shadow-sm rounded-xl">
              <CardContent
                className="p-8 text-center text-sm text-destructive"
                role="alert"
              >
                Recent submissions could not be loaded. Refresh and try again.
              </CardContent>
            </Card>
          ) : realFilteredSubmissions.length === 0 ? (
            <Card className="border-dashed shadow-sm border-border rounded-xl">
              <CardContent className="p-8 text-center">
                <h3 className="text-lg font-medium mb-2">No submissions yet</h3>
                <p className="text-sm text-muted-foreground">
                  Writing submissions will appear here after students submit
                  work.
                </p>
              </CardContent>
            </Card>
          ) : (
            realFilteredSubmissions.slice(0, 5).map((submission) => (
              <Card
                key={submission.id}
                className="hover:border-primary/40 transition-all duration-300 shadow-sm border-border rounded-xl"
              >
                <CardContent className="p-6">
                  <div className="flex justify-between items-start mb-4 gap-4">
                    <div>
                      <h4 className="font-medium text-foreground">
                        {submission.student_name ?? "Student"}
                      </h4>
                      <p className="text-xs font-mono text-muted-foreground mt-0.5">
                        {new Date(submission.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <SubmissionStatusBadge
                      status={submission.status}
                      feedbackMode={submission.feedback_mode}
                      feedbackScheduledAt={submission.feedback_scheduled_at}
                    />
                  </div>
                  <div className="mt-4">
                    <p className="text-sm font-medium text-foreground mb-1 line-clamp-1">
                      {submission.question_title}
                    </p>
                    <p className="text-sm text-foreground/80 mb-5 line-clamp-2 leading-relaxed italic border-l-2 border-border/50 pl-4">
                      {submission.original_text}
                    </p>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-medium text-foreground">
                        {getSubmissionIssueLabel(submission)}
                      </span>
                      <Link
                        href={`/teacher/submission/${submission.id}`}
                        className="text-sm text-primary font-medium hover:underline flex items-center group"
                      >
                        Review{" "}
                        <span className="ml-1 transition-transform group-hover:translate-x-1">
                          -&gt;
                        </span>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">
            Needs Attention
          </h2>
          <Card className="shadow-sm border-border rounded-xl">
            <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
              <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Grammar Focus Areas
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 space-y-5">
              {summaryQuery.isPending ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Loading grammar focus areas...
                </p>
              ) : summaryQuery.isError ? (
                <p className="text-sm text-destructive">
                  Grammar focus areas could not be loaded.
                </p>
              ) : attentionItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No grammar focus areas yet.
                </p>
              ) : (
                attentionItems.map((stat) => {
                  const assignment = stat.active_practice;
                  return (
                    <div
                      key={stat.id}
                      className="space-y-2 rounded-lg border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {stat.topic_name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {stat.student_name ?? "Student"}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={getWeaknessBadgeClass(
                            stat.weakness_level,
                            stat.practice_unlocked,
                          )}
                        >
                          {getWeaknessLabel(
                            stat.weakness_level,
                            stat.practice_unlocked,
                          )}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatTeacherIssueCount(stat)}
                      </p>
                      {assignment && (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={getTeacherPracticeBadgeClass(
                                assignment,
                              )}
                            >
                              {getTeacherPracticeLabel(assignment)}
                            </Badge>
                            {assignment.worksheet_title && (
                              <span className="text-xs text-muted-foreground truncate">
                                {assignment.worksheet_title}
                              </span>
                            )}
                          </div>
                          {isTeacherSupportRecommended(assignment) && (
                            <p className="text-xs font-medium text-orange-700 dark:text-orange-300">
                              Teacher support recommended
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
