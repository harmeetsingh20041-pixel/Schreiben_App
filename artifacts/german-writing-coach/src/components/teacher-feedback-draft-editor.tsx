import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Save, Send } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  prepareFeedbackDraftContentForSave,
  buildTeacherChangedParts,
  releaseFeedback,
  updateFeedbackDraft,
  type FeedbackDraft,
  type FeedbackDraftContent,
  type FeedbackDraftLine,
  type FeedbackTopicOption,
} from "@/services/feedbackReviewService";
import type { FeedbackLineStatus, WritingSubmission } from "@/services/submissionService";

interface TeacherFeedbackDraftEditorProps {
  submission: WritingSubmission;
  draft: FeedbackDraft;
  topicOptions: FeedbackTopicOption[];
  onChanged: () => Promise<unknown> | unknown;
  onReleased: () => Promise<unknown> | unknown;
}

const statusLabels: Array<{ value: FeedbackLineStatus; label: string }> = [
  { value: "correct", label: "Correct" },
  { value: "acceptable_for_level", label: "Acceptable for level" },
  { value: "minor_issue", label: "Minor issue" },
  { value: "major_issue", label: "Major issue" },
  { value: "unclear", label: "Needs teacher decision" },
];

const MAX_CORRECTION_TOPICS = 6;
const MAX_CORRECTION_REASON_CHARACTERS = 4_000;

function cloneContent(content: FeedbackDraftContent): FeedbackDraftContent {
  return structuredClone(content);
}

function truncateToCodePoints(value: string, maximum: number) {
  const codePoints = Array.from(value);
  return codePoints.length <= maximum
    ? value
    : codePoints.slice(0, maximum).join("");
}

function isPositive(status: FeedbackLineStatus) {
  return status === "correct"
    || status === "acceptable_for_level"
    || status === "acceptable_a1_a2";
}

export function TeacherFeedbackDraftEditor({
  submission,
  draft,
  topicOptions,
  onChanged,
  onReleased,
}: TeacherFeedbackDraftEditorProps) {
  const { toast } = useToast();
  const [serverDraft, setServerDraft] = useState(draft);
  const [content, setContent] = useState(() => cloneContent(draft.content));
  const [saving, setSaving] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerDraft(draft);
    setContent(cloneContent(draft.content));
    setError(null);
  }, [draft.id, draft.revision]);

  const hasUnclearLines = content.lines.some((line) => line.status === "unclear");
  const hasIncompleteIssueLines = content.lines.some((line) =>
    (line.status === "minor_issue" || line.status === "major_issue")
    && (
      !line.short_explanation.trim()
      || line.corrected_line === line.original_line
      || line.changed_parts.length === 0
      || line.changed_parts.some(
        (part) =>
          !part.reason.trim()
          || Array.from(part.reason).length > MAX_CORRECTION_REASON_CHARACTERS
          || part.grammar_topics.length === 0
          || part.grammar_topics.length > MAX_CORRECTION_TOPICS
          || part.severity === null,
      )
    )
  );
  const hasBlockingLines = hasUnclearLines || hasIncompleteIssueLines;
  const dirty = useMemo(
    () => JSON.stringify(content) !== JSON.stringify(serverDraft.content),
    [content, serverDraft.content],
  );

  const updateLine = (lineNumber: number, update: (line: FeedbackDraftLine) => FeedbackDraftLine) => {
    setContent((current) => ({
      ...current,
      lines: current.lines.map((line) => line.line_number === lineNumber ? update(line) : line),
    }));
  };

  const updateChangedPart = (
    lineNumber: number,
    partIndex: number,
    update: (part: FeedbackDraftLine["changed_parts"][number]) => FeedbackDraftLine["changed_parts"][number],
  ) => {
    updateLine(lineNumber, (line) => {
      const changedParts = line.changed_parts.map((part, index) =>
        index === partIndex ? update(part) : part,
      );
      const allTopics = [...new Set(changedParts.flatMap((part) => part.grammar_topics))]
        .sort();
      const status = line.status === "minor_issue" || line.status === "major_issue"
        ? changedParts.some((part) => part.severity === null)
          ? line.status
          : changedParts.some((part) => part.severity === "major")
          ? "major_issue"
          : "minor_issue"
        : line.status;
      return {
        ...line,
        status,
        grammar_topic: allTopics[0] ?? "",
        changed_parts: changedParts,
      };
    });
  };

  const persistCurrentContent = async (validationMode: "private_draft" | "release") => {
    const prepared = prepareFeedbackDraftContentForSave(
      submission.original_text,
      content,
      validationMode,
    );
    const saved = await updateFeedbackDraft(serverDraft.id, prepared, serverDraft.revision);
    setServerDraft(saved);
    setContent(cloneContent(saved.content));
    return saved;
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const saved = await persistCurrentContent("private_draft");
      toast({
        title: saved.state === "needs_review" ? "Draft saved and held" : "Feedback draft saved",
        description: saved.state === "needs_review"
          ? "It still contains an unresolved line and remains private."
          : "The latest revision is private until you approve and release it.",
      });
      try {
        await onChanged();
      } catch {
        toast({
          title: "Draft saved; refresh delayed",
          description: "Your private revision is safe. Refresh the page if the latest view does not appear automatically.",
        });
      }
    } catch (saveError) {
      const message = formatErrorMessage(saveError, "The feedback draft could not be saved.");
      setError(message);
      toast({ title: "Feedback was not saved", description: message });
    } finally {
      setSaving(false);
    }
  };

  const handleRelease = async () => {
    if (hasBlockingLines) return;
    let released = false;
    try {
      setReleasing(true);
      setError(null);
      const currentDraft = dirty ? await persistCurrentContent("release") : serverDraft;
      await releaseFeedback(submission.id, currentDraft.id);
      released = true;
      toast({
        title: "Feedback released",
        description: "The approved feedback is now visible to the student.",
      });
    } catch (releaseError) {
      const message = formatErrorMessage(releaseError, "The feedback could not be released.");
      setError(message);
      toast({ title: "Feedback was not released", description: message });
    } finally {
      setReleasing(false);
    }
    if (released) {
      try {
        await onReleased();
      } catch {
        toast({
          title: "Feedback released; refresh delayed",
          description: "The student can see the feedback. Refresh this page if its released state does not appear automatically.",
        });
      }
    }
  };

  const busy = saving || releasing;

  return (
    <div className="space-y-6">
      <Alert
        role={hasBlockingLines ? "alert" : "status"}
        className={hasBlockingLines ? "border-amber-300 bg-amber-50" : "border-primary/30 bg-primary/5"}
      >
        {hasBlockingLines ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        <AlertTitle>
          {hasBlockingLines ? "Teacher decision required" : "Private feedback draft"}
        </AlertTitle>
        <AlertDescription>
          {hasBlockingLines
            ? "Resolve every unclear line, classify every correction span with severity and at least one grammar topic, and add a student-facing explanation before release. Nothing on this page is visible to the student yet."
            : "Review and edit the draft below. The student sees it only after the approval and release action succeeds."}
        </AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Action not completed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle>Teacher feedback editor</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Version {serverDraft.version}, revision {serverDraft.revision}
            </p>
          </div>
          <Badge variant={serverDraft.state === "needs_review" ? "destructive" : "secondary"}>
            {serverDraft.state === "needs_review" ? "Held for review" : "Private draft"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="teacher-feedback-summary">Overall summary</Label>
            <Textarea
              id="teacher-feedback-summary"
              value={content.overall_summary}
              disabled={busy}
              rows={4}
              maxLength={8000}
              onChange={(event) => setContent((current) => ({
                ...current,
                overall_summary: event.target.value,
              }))}
            />
          </div>

          <div className="space-y-5">
            {content.lines.map((line) => {
              const statusId = `feedback-line-${line.line_number}-status`;
              const correctionId = `feedback-line-${line.line_number}-correction`;
              const shortExplanationId = `feedback-line-${line.line_number}-short-explanation`;
              const detailedExplanationId = `feedback-line-${line.line_number}-detailed-explanation`;
              return (
                <Card key={line.line_number} className="overflow-hidden border-border">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-base">Line {line.line_number}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-5 pt-5">
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Exact student text
                      </p>
                      <p className="whitespace-pre-wrap">{line.original_line}</p>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={statusId}>Severity and status</Label>
                        <Select
                          value={line.status === "acceptable_a1_a2" ? "acceptable_for_level" : line.status}
                          disabled={busy}
                          onValueChange={(value) => updateLine(line.line_number, (current) => {
                            const status = value as FeedbackLineStatus;
                            const positive = isPositive(status);
                            const issueSeverity = status === "major_issue"
                              ? "major"
                              : status === "minor_issue"
                                ? "minor"
                                : null;
                            return {
                              ...current,
                              status,
                              corrected_line: positive
                                ? current.original_line
                                : current.corrected_line,
                              grammar_topic: positive ? "" : current.grammar_topic,
                              changed_parts: positive
                                ? []
                                : issueSeverity
                                  ? current.changed_parts.map((part) => ({
                                      ...part,
                                      severity: issueSeverity,
                                    }))
                                  : current.changed_parts,
                            };
                          })}
                        >
                          <SelectTrigger id={statusId}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {statusLabels.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={correctionId}>Corrected text</Label>
                      <Textarea
                        id={correctionId}
                        value={line.corrected_line}
                        disabled={busy || isPositive(line.status)}
                        rows={3}
                        maxLength={4000}
                        onChange={(event) => updateLine(line.line_number, (current) => {
                          const correctedLine = event.target.value;
                          return {
                            ...current,
                            corrected_line: correctedLine,
                            changed_parts: buildTeacherChangedParts(
                              current.original_line,
                              correctedLine,
                              current.source_start,
                              current.short_explanation || current.detailed_explanation,
                              current.changed_parts,
                            ),
                          };
                        })}
                      />
                      {isPositive(line.status) && (
                        <p className="text-xs text-muted-foreground">
                          Positive lines must preserve the exact original text.
                        </p>
                      )}
                    </div>

                    {(line.status === "minor_issue" || line.status === "major_issue") && (
                      <div className="space-y-3">
                        <div>
                          <Label>Correction topics</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Classify every exact correction separately. One correction may teach more than one topic.
                          </p>
                        </div>
                        {line.changed_parts.length === 0 ? (
                          <Alert className="border-amber-300 bg-amber-50">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>
                              Enter a real correction before choosing its grammar topics.
                            </AlertDescription>
                          </Alert>
                        ) : (
                          line.changed_parts.map((part, partIndex) => {
                            const severityId = `feedback-line-${line.line_number}-part-${partIndex}-severity`;
                            const reasonId = `feedback-line-${line.line_number}-part-${partIndex}-reason`;
                            const topicLimitReached = part.grammar_topics.length >= MAX_CORRECTION_TOPICS;
                            return (
                              <div
                                key={`${line.line_number}-${part.source_start}-${part.corrected_start}-${partIndex}`}
                                className="space-y-4 rounded-md border bg-muted/20 p-4"
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <p className="text-sm font-medium">Correction {partIndex + 1}</p>
                                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                                      “{part.from || "∅"}” → “{part.to || "∅"}”
                                    </p>
                                  </div>
                                  <div className="w-full space-y-2 sm:w-44">
                                    <Label htmlFor={severityId}>Issue severity</Label>
                                    <Select
                                      value={part.severity ?? "__none__"}
                                      disabled={busy}
                                      onValueChange={(value) => updateChangedPart(
                                        line.line_number,
                                        partIndex,
                                        (current) => ({
                                          ...current,
                                          severity: value === "major" ? "major" : "minor",
                                        }),
                                      )}
                                    >
                                      <SelectTrigger id={severityId}>
                                        <SelectValue placeholder="Choose severity" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__" disabled>Choose severity</SelectItem>
                                        <SelectItem value="minor">Minor</SelectItem>
                                        <SelectItem value="major">Major</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={reasonId}>Reason for this exact correction</Label>
                                  <Textarea
                                    id={reasonId}
                                    value={part.reason}
                                    disabled={busy}
                                    rows={3}
                                    aria-describedby={`${reasonId}-help`}
                                    onChange={(event) => updateChangedPart(
                                      line.line_number,
                                      partIndex,
                                      (current) => ({
                                        ...current,
                                        reason: truncateToCodePoints(
                                          event.target.value,
                                          MAX_CORRECTION_REASON_CHARACTERS,
                                        ),
                                      }),
                                    )}
                                  />
                                  <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
                                    This explanation is shown with this correction and used in its practice-topic guidance.
                                    {" "}{Array.from(part.reason).length.toLocaleString()} / 4,000 characters.
                                  </p>
                                </div>
                                <div
                                  className="grid max-h-56 gap-2 overflow-y-auto rounded-md border bg-background p-3 sm:grid-cols-2"
                                  role="group"
                                  aria-label={`Grammar topics for line ${line.line_number}, correction ${partIndex + 1}`}
                                >
                                  {topicOptions.map((option) => {
                                    const checkboxId = `feedback-line-${line.line_number}-part-${partIndex}-topic-${option.slug}`;
                                    const checked = part.grammar_topics.includes(option.slug);
                                    return (
                                      <div key={option.slug} className="flex items-start gap-2">
                                        <Checkbox
                                          id={checkboxId}
                                          checked={checked}
                                          disabled={busy || (!checked && topicLimitReached)}
                                          onCheckedChange={(nextChecked) => updateChangedPart(
                                            line.line_number,
                                            partIndex,
                                            (current) => ({
                                              ...current,
                                              grammar_topics: nextChecked === true
                                                ? [...new Set([...current.grammar_topics, option.slug])].sort()
                                                : current.grammar_topics.filter((topic) => topic !== option.slug),
                                            }),
                                          )}
                                        />
                                        <Label htmlFor={checkboxId} className="cursor-pointer text-sm font-normal">
                                          {option.name}
                                        </Label>
                                      </div>
                                    );
                                  })}
                                </div>
                                {part.grammar_topics.length === 0 && (
                                  <p className="text-xs text-amber-700" role="status">
                                    Choose at least one grammar topic for this correction.
                                  </p>
                                )}
                                {topicLimitReached && (
                                  <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                                    6 of 6 grammar topics selected. Remove one to choose another.
                                  </p>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor={shortExplanationId}>Student-facing explanation</Label>
                      <Textarea
                        id={shortExplanationId}
                        value={line.short_explanation}
                        disabled={busy}
                        rows={3}
                        maxLength={4000}
                        onChange={(event) => updateLine(line.line_number, (current) => ({
                          ...current,
                          short_explanation: event.target.value,
                        }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={detailedExplanationId}>Detailed explanation (optional)</Label>
                      <Textarea
                        id={detailedExplanationId}
                        value={line.detailed_explanation}
                        disabled={busy}
                        rows={4}
                        maxLength={8000}
                        onChange={(event) => updateLine(line.line_number, (current) => ({
                          ...current,
                          detailed_explanation: event.target.value,
                        }))}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="flex flex-col-reverse gap-3 border-t pt-5 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !dirty}
              aria-busy={saving}
              onClick={handleSave}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {saving ? "Saving..." : "Save private draft"}
            </Button>
            <Button
              type="button"
              disabled={busy || hasBlockingLines}
              aria-busy={releasing}
              onClick={handleRelease}
            >
              {releasing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {releasing ? "Approving and releasing..." : "Approve and release"}
            </Button>
          </div>
          {hasBlockingLines && (
            <p className="text-right text-sm text-amber-700" role="status" aria-live="polite">
              Complete every unresolved issue before release.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
