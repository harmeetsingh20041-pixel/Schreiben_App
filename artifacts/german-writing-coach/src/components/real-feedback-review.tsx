import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ThumbsUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDiffWords } from "@/utils/diffHighlighter";
import type {
  WritingFeedback,
  WritingFeedbackLine,
  WritingSubmission,
} from "@/services/submissionService";

interface RealFeedbackReviewProps {
  submission: WritingSubmission;
  feedback: WritingFeedback;
}

function HighlightedDiff({
  original,
  corrected,
}: {
  original: string;
  corrected: string;
}) {
  const diffs = getDiffWords(original, corrected);
  const removed = diffs
    .filter((chunk) => chunk.type === "removed")
    .map((chunk) => chunk.text.trim())
    .filter(Boolean);
  const added = diffs
    .filter((chunk) => chunk.type === "added")
    .map((chunk) => chunk.text.trim())
    .filter(Boolean);
  const removedDescription = removed.map((value) => `“${value}”`).join(", ");
  const addedDescription = added.map((value) => `“${value}”`).join(", ");
  const changeDescription =
    removed.length > 0 && added.length > 0
      ? `Correction: replace ${removedDescription} with ${addedDescription}. Corrected sentence: ${corrected}`
      : removed.length > 0
        ? `Correction: remove ${removedDescription}. Corrected sentence: ${corrected}`
        : added.length > 0
          ? `Correction: add ${addedDescription}. Corrected sentence: ${corrected}`
          : `Corrected sentence: ${corrected}`;

  return (
    <div
      role="group"
      aria-label={changeDescription}
      className="leading-relaxed whitespace-pre-wrap"
    >
      <span aria-hidden="true">
        {diffs.map((chunk, i) => {
          if (chunk.type === "unchanged")
            return <span key={i}>{chunk.text}</span>;
          if (chunk.type === "removed") {
            return (
              <span
                key={i}
                className="mx-0.5 rounded border border-red-200 bg-red-50 px-1 py-0.5 text-red-800 line-through"
              >
                {chunk.text}
              </span>
            );
          }
          if (chunk.type === "added") {
            return (
              <span key={i}>
                {diffs[i - 1]?.type === "removed" && (
                  <span className="mx-1 text-muted-foreground">→</span>
                )}
                <span className="mx-0.5 rounded border border-emerald-200 bg-emerald-50 px-1 py-0.5 font-medium text-emerald-800">
                  {chunk.text}
                </span>
              </span>
            );
          }
          return null;
        })}
      </span>
    </div>
  );
}

const statusConfig = {
  correct: {
    icon: CheckCircle2,
    color: "text-emerald-800",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    label: "Correct",
  },
  acceptable_for_level: {
    icon: ThumbsUp,
    color: "text-sky-800",
    bg: "bg-sky-50",
    border: "border-sky-200",
    label: "Good for Level",
  },
  acceptable_a1_a2: {
    icon: ThumbsUp,
    color: "text-sky-800",
    bg: "bg-sky-50",
    border: "border-sky-200",
    label: "Good for Level",
  },
  minor_issue: {
    icon: AlertTriangle,
    color: "text-amber-800",
    bg: "bg-amber-50",
    border: "border-amber-200",
    label: "Small Issue",
  },
  major_issue: {
    icon: AlertOctagon,
    color: "text-red-800",
    bg: "bg-red-50",
    border: "border-red-200",
    label: "Major Issue",
  },
  unclear: {
    icon: AlertCircle,
    color: "text-slate-600",
    bg: "bg-slate-50",
    border: "border-slate-200",
    label: "Needs Review",
  },
} satisfies Record<
  WritingFeedbackLine["status"],
  {
    icon: typeof CheckCircle2;
    color: string;
    bg: string;
    border: string;
    label: string;
  }
>;

export function RealFeedbackReview({
  submission,
  feedback,
}: RealFeedbackReviewProps) {
  const [detailed, setDetailed] = useState(false);
  const stats = useMemo(
    () => ({
      correct: feedback.lines.filter((line) => line.status === "correct")
        .length,
      good: feedback.lines.filter(
        (line) =>
          line.status === "acceptable_for_level" ||
          line.status === "acceptable_a1_a2",
      ).length,
      minor: feedback.lines.filter((line) => line.status === "minor_issue")
        .length,
      major: feedback.lines.filter((line) => line.status === "major_issue")
        .length,
      unclear: feedback.lines.filter((line) => line.status === "unclear")
        .length,
    }),
    [feedback.lines],
  );

  const topicLabelBySlug = useMemo(
    () =>
      new Map(
        feedback.grammar_topics.map((topic) => [topic.topic_slug, topic.topic]),
      ),
    [feedback.grammar_topics],
  );
  const lineTopicLabels = useCallback((line: WritingFeedbackLine) => {
    const spanTopics = [...new Set(
      line.changed_parts.flatMap((part) => part.grammar_topics),
    )];
    if (spanTopics.length > 0) {
      return spanTopics.map((topic) => topicLabelBySlug.get(topic) ?? topic);
    }
    return line.grammar_topic ? [line.grammar_topic] : [];
  }, [topicLabelBySlug]);

  const grammarGroups = useMemo(
    () =>
      feedback.lines.reduce(
        (acc, line) => {
          if (
            line.status !== "correct" &&
            line.status !== "acceptable_for_level" &&
            line.status !== "acceptable_a1_a2"
          ) {
            for (const topic of lineTopicLabels(line)) {
              if (!acc[topic]) acc[topic] = [];
              acc[topic].push(line);
            }
          }
          return acc;
        },
        {} as Record<string, WritingFeedbackLine[]>,
      ),
    [feedback.lines, lineTopicLabels],
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="bg-muted/30 pb-4 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Original Submission
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-foreground leading-relaxed whitespace-pre-wrap">
              {submission.original_text}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="bg-primary/5 pb-4 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-primary">
              Corrected Version
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-foreground leading-relaxed whitespace-pre-wrap">
              {submission.corrected_text}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-primary text-primary-foreground shadow-sm rounded-xl overflow-hidden border-none">
        <div className="p-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
            <h2 className="text-2xl font-serif tracking-tight">
              Feedback Summary
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              {submission.level_detected && (
                <Badge
                  variant="outline"
                  className="bg-primary-foreground/10 border-primary-foreground/20 text-primary-foreground font-medium"
                >
                  Level: {submission.level_detected}
                </Badge>
              )}
              <Badge
                variant="outline"
                className="bg-primary-foreground/10 border-primary-foreground/20 text-primary-foreground font-medium"
              >
                {feedback.lines.length} lines checked
              </Badge>
            </div>
          </div>
          <p className="text-lg text-primary-foreground/90 leading-relaxed mb-8 max-w-3xl">
            {submission.overall_summary}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 pt-6 border-t border-primary-foreground/20">
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.correct}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">
                Correct
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.good}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">
                Good for Level
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.minor}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">
                Small Issues
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1 text-red-100">
                {stats.major}
              </span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground">
                Major Issues
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.unclear}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">
                Needs Review
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Tabs defaultValue="line-by-line" className="w-full">
        <TabsList
          aria-label="Feedback views"
          className="w-full max-w-full justify-start overflow-x-auto border-b border-border rounded-none bg-transparent h-auto p-0 mb-8 space-x-3 sm:space-x-6"
        >
          <TabsTrigger
            value="line-by-line"
            className="shrink-0 data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base"
          >
            Line-by-line
          </TabsTrigger>
          <TabsTrigger
            value="original-vs-corrected"
            className="shrink-0 data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base"
          >
            Original vs Corrected
          </TabsTrigger>
          <TabsTrigger
            value="grammar-topics"
            className="shrink-0 data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base"
          >
            Grammar Topics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="line-by-line" className="space-y-6">
          <div className="flex justify-end mb-4">
            <div className="flex items-center space-x-3 bg-card border border-border px-4 py-2 rounded-lg shadow-sm">
              <Switch
                id="detailed-mode"
                checked={detailed}
                onCheckedChange={setDetailed}
              />
              <Label
                htmlFor="detailed-mode"
                className="font-medium cursor-pointer text-sm tracking-wide"
              >
                Detailed Explanations
              </Label>
            </div>
          </div>
          {feedback.lines.map((line) => {
            const conf = statusConfig[line.status];
            const Icon = conf.icon;
            const explanation =
              line.status === "correct"
                ? "Correct. No correction needed."
                : line.status === "acceptable_for_level" ||
                    line.status === "acceptable_a1_a2"
                  ? "This is good for your level. No need to make it more complicated."
                  : line.short_explanation || "Review this sentence.";
            const topics = lineTopicLabels(line);

            return (
              <Card
                key={line.id}
                className="overflow-hidden border border-border shadow-sm rounded-xl"
              >
                <div
                  className={`px-5 py-3 border-b ${conf.border} ${conf.bg} flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between`}
                >
                  <div
                    className={`flex items-center gap-2 font-medium ${conf.color} text-sm tracking-wide uppercase`}
                  >
                    <Icon className="w-4 h-4" />
                    {conf.label}
                  </div>
                  <Badge
                    variant="outline"
                    className="bg-background border-border text-xs text-muted-foreground font-mono"
                  >
                    Line {line.line_number}{" "}
                    {topics.length > 0 && `• ${topics.join(", ")}`}
                  </Badge>
                </div>

                <CardContent className="p-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
                    <div className="p-6 bg-muted/30">
                      <p className="text-foreground text-lg leading-relaxed whitespace-pre-wrap break-words">
                        {line.original_line}
                      </p>
                    </div>
                    <div className="p-6 bg-card">
                      {line.status === "correct" ||
                      line.status === "acceptable_for_level" ||
                      line.status === "acceptable_a1_a2" ? (
                        <p className="text-foreground text-lg leading-relaxed whitespace-pre-wrap break-words">
                          {line.corrected_line}
                        </p>
                      ) : (
                        <div className="text-lg leading-relaxed">
                          <HighlightedDiff
                            original={line.original_line}
                            corrected={line.corrected_line}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="p-6 bg-card border-t border-border/60">
                    <div className="flex gap-4 items-start">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5 border border-primary/20">
                        <span className="text-primary font-serif font-semibold text-sm">
                          Tip
                        </span>
                      </div>
                      <div className="pt-1">
                        <p className="text-foreground font-medium mb-1 leading-relaxed">
                          {explanation}
                        </p>
                        {detailed && line.changed_parts.length > 0 && (
                          <div className="mt-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                            {line.changed_parts.map((part, index) => (
                              <div
                                key={`${line.id}-${index}`}
                                className="text-sm bg-muted/40 p-4 rounded-lg border border-border/50"
                              >
                                <div className="font-mono text-xs mb-2 bg-card px-2.5 py-1.5 rounded inline-block border border-border/80 shadow-sm">
                                  <span className="sr-only">
                                    Replace “{part.from}” with “{part.to}”.
                                  </span>
                                  <span aria-hidden="true">
                                    <span className="line-through text-red-800">
                                      {part.from}
                                    </span>
                                    <span className="text-muted-foreground mx-2">
                                      -&gt;
                                    </span>
                                    <span className="text-emerald-800 font-medium">
                                      {part.to}
                                    </span>
                                  </span>
                                </div>
                                <p className="text-muted-foreground">
                                  {part.reason}
                                </p>
                                {part.grammar_topics.length > 0 && (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {part.grammar_topics.map((topic) => (
                                      <Badge key={topic} variant="secondary">
                                        {topicLabelBySlug.get(topic) ?? topic}
                                      </Badge>
                                    ))}
                                    {part.severity && (
                                      <Badge variant="outline">
                                        {part.severity === "major" ? "Major issue" : "Minor issue"}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {detailed &&
                          line.detailed_explanation &&
                          line.changed_parts.length === 0 && (
                            <p className="mt-3 text-sm text-muted-foreground">
                              {line.detailed_explanation}
                            </p>
                          )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="original-vs-corrected">
          <Card className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                  Original
                </h3>
                <div className="space-y-2">
                  {feedback.lines.map((line) => {
                    const conf = statusConfig[line.status];
                    return (
                      <div
                        key={line.id}
                        className={`p-3 rounded border ${conf.bg} ${conf.border}`}
                      >
                        {line.original_line}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                  Corrected
                </h3>
                <div className="space-y-2">
                  {feedback.lines.map((line) => {
                    const conf = statusConfig[line.status];
                    return (
                      <div
                        key={line.id}
                        className={`p-3 rounded border ${conf.bg} ${conf.border}`}
                      >
                        {line.corrected_line}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="grammar-topics">
          {feedback.grammar_topics.length === 0 &&
          Object.keys(grammarGroups).length === 0 ? (
            <Card className="p-12 text-center text-muted-foreground border-dashed bg-muted/30">
              No specific grammar issues identified in this submission.
            </Card>
          ) : (
            <div className="space-y-6">
              {feedback.grammar_topics.map((topic) => (
                <Card key={topic.id} className="shadow-sm border-border">
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-lg flex items-center gap-2">
                      {topic.topic}
                      <Badge variant="secondary" className="ml-2 font-mono">
                        {topic.count}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-6">
                    <p className="text-foreground leading-relaxed">
                      {topic.simple_explanation || "Review this grammar topic."}
                    </p>
                  </CardContent>
                </Card>
              ))}
              {Object.entries(grammarGroups)
                .filter(
                  ([topic]) =>
                    !feedback.grammar_topics.some(
                      (item) => item.topic === topic,
                    ),
                )
                .map(([topic, lines]) => (
                  <Card key={topic} className="shadow-sm border-border">
                    <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                      <CardTitle className="text-lg flex items-center gap-2">
                        {topic}
                        <Badge variant="secondary" className="ml-2 font-mono">
                          {lines.length}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-6 space-y-4">
                      {lines.map((line) => (
                        <div
                          key={line.id}
                          className="bg-card border border-border rounded-lg p-4"
                        >
                          <HighlightedDiff
                            original={line.original_line}
                            corrected={line.corrected_line}
                          />
                          <p className="text-sm text-muted-foreground mt-3 pt-3 border-t border-border/50">
                            {line.short_explanation}
                          </p>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
