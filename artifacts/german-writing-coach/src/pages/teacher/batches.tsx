import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId, LEVEL_OPTIONS, type WorkspaceLevel } from "@/lib/workspaceData";
import { createWorkspaceBatch, listWorkspaceBatches, rotateBatchJoinCode, setBatchActive, updateWorkspaceBatch, type BatchFeedbackMode, type WorkspaceBatch } from "@/services/batchService";
import { MOCK_BATCHES } from "@/data/mockData";
import { Archive, CheckCircle2, Copy, Edit, FileText, KeyRound, Plus, RefreshCw, Users } from "lucide-react";

interface BatchFormState {
  name: string;
  level: WorkspaceLevel;
  description: string;
  is_active: boolean;
  join_code_enabled: boolean;
  join_requires_approval: boolean;
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
  join_requires_approval: true,
  feedback_mode: "teacher_review_only",
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
  automatic_delayed: "Automatic delayed feedback",
  teacher_review_only: "Teacher review only",
};

function feedbackModeBadgeClass(mode: BatchFeedbackMode) {
  if (mode === "immediate") return "bg-blue-50 text-blue-700 border-blue-200";
  if (mode === "automatic_delayed") return "bg-violet-50 text-violet-700 border-violet-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

export default function TeacherBatches() {
  const { authMode, user, workspaceMemberships } = useAuth();
  const { toast } = useToast();
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const useRealData = authMode === "supabase" && Boolean(user);

  const [batches, setBatches] = useState<WorkspaceBatch[]>([]);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<WorkspaceBatch | null>(null);
  const [formData, setFormData] = useState<BatchFormState>(initialForm);

  const loadBatches = async () => {
    if (!useRealData) return;
    if (!workspaceId) {
      setError("No workspace found. Create a workspace before managing batches.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setBatches(await listWorkspaceBatches(workspaceId));
    } catch (loadError) {
      setError(formatErrorMessage(loadError, "Unable to load batches."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBatches();
  }, [useRealData, workspaceId]);

  const displayBatches = useMemo(() => {
    if (useRealData) {
      return batches.filter((batch) => {
        const matchesLevel = levelFilter === "all" || batch.level === levelFilter;
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "active" ? batch.is_active : !batch.is_active);
        return matchesLevel && matchesStatus;
      });
    }

    return MOCK_BATCHES.filter((batch) => {
      const matchesLevel = levelFilter === "all" || batch.level === levelFilter;
      return matchesLevel && statusFilter !== "inactive";
    }).map((batch) => ({
      id: batch.id,
      workspace_id: "mock",
      name: batch.name,
      level: (batch.level ?? "A2") as WorkspaceLevel,
      description: null,
      is_active: true,
      join_code: `DEMO${batch.id.toUpperCase()}`.replace(/[^A-Z0-9]/g, "").slice(0, 10),
      join_code_enabled: true,
      join_requires_approval: true,
      created_by: null,
      created_at: "",
      updated_at: "",
      student_count: batch.student_count,
      submission_count: batch.submission_count,
      feedback_mode: "teacher_review_only" as BatchFeedbackMode,
      feedback_delay_min_minutes: 15,
      feedback_delay_max_minutes: 180,
    }));
  }, [batches, levelFilter, statusFilter, useRealData]);

  const openDialog = (batch?: WorkspaceBatch) => {
    if (batch) {
      setEditingBatch(batch);
      setFormData({
        name: batch.name,
        level: batch.level,
        description: batch.description ?? "",
        is_active: batch.is_active,
        join_code_enabled: batch.join_code_enabled,
        join_requires_approval: batch.join_requires_approval,
        feedback_mode: batch.feedback_mode,
        feedback_delay_min_minutes: batch.feedback_delay_min_minutes,
        feedback_delay_max_minutes: batch.feedback_delay_max_minutes,
      });
    } else {
      setEditingBatch(null);
      setFormData(initialForm);
    }
    setDialogOpen(true);
  };

  const saveBatch = async () => {
    if (!workspaceId || !user) return;
    if (!formData.name.trim()) {
      toast({ title: "Batch name required", description: "Give this batch a clear name." });
      return;
    }
    if (
      formData.feedback_delay_min_minutes < 0 ||
      formData.feedback_delay_max_minutes < formData.feedback_delay_min_minutes ||
      formData.feedback_delay_max_minutes > 10080
    ) {
      toast({
        title: "Delay range needs attention",
        description: "Use 0 or more minutes, keep maximum above minimum, and stay under 7 days.",
      });
      return;
    }

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
      await loadBatches();
      toast({ title: editingBatch ? "Batch updated" : "Batch created" });
    } catch (saveError) {
      toast({
        title: "Could not save batch",
        description: formatErrorMessage(saveError, "Please try again."),
      });
    }
  };

  const toggleBatch = async (batch: WorkspaceBatch) => {
    if (!workspaceId) return;
    try {
      await setBatchActive(workspaceId, batch.id, !batch.is_active);
      await loadBatches();
    } catch (toggleError) {
      toast({
        title: "Could not update batch",
        description: formatErrorMessage(toggleError, "Please try again."),
      });
    }
  };

  const copyJoinCode = async (batch: WorkspaceBatch) => {
    try {
      await navigator.clipboard.writeText(batch.join_code);
      toast({ title: "Join code copied", description: `${batch.name}: ${batch.join_code}` });
    } catch {
      toast({ title: "Copy failed", description: "Select the code and copy it manually." });
    }
  };

  const rotateJoinCode = async (batch: WorkspaceBatch) => {
    try {
      const nextCode = await rotateBatchJoinCode(batch.id);
      await loadBatches();
      toast({ title: "Join code rotated", description: `${batch.name}: ${nextCode}` });
    } catch (rotateError) {
      toast({
        title: "Could not rotate code",
        description: formatErrorMessage(rotateError, "Please try again."),
      });
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Batches</h1>
          <p className="text-muted-foreground mt-1">Manage your class batches and view aggregate performance.</p>
        </div>
        {useRealData && (
          <Button onClick={() => openDialog()} className="shadow-md">
            <Plus className="w-4 h-4 mr-2" />
            Create Batch
          </Button>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="w-full md:w-48">
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="bg-card">
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
        <div className="w-full md:w-48">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="bg-card">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="all">All Statuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">Loading batches...</CardContent>
        </Card>
      ) : displayBatches.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <h2 className="text-xl font-semibold mb-2">Create your first batch</h2>
            <p className="text-muted-foreground mb-5">Organize students by level from A1 through B2.</p>
            {useRealData && <Button onClick={() => openDialog()}>Create Batch</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {displayBatches.map((batch, i) => (
            <Card key={batch.id} className={`hover:shadow-md transition-shadow animate-in slide-in-from-bottom-4 ${!batch.is_active ? "opacity-70" : ""}`} style={{ animationDelay: `${i * 50}ms` }}>
              <CardHeader className="pb-4 border-b border-border bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Badge variant="outline" className={levelBadgeClass(batch.level)}>{batch.level}</Badge>
                    <CardTitle className="text-xl mt-3">{batch.name}</CardTitle>
                  </div>
                  {!batch.is_active && <Badge variant="secondary">Inactive</Badge>}
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                {batch.description && (
                  <p className="text-sm text-muted-foreground mb-5 line-clamp-2">{batch.description}</p>
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
                    <span className="font-semibold">{batch.submission_count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center text-muted-foreground">
                      <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" />
                      <span className="text-sm">Status</span>
                    </div>
                    <span className="font-semibold">{batch.is_active ? "Active" : "Inactive"}</span>
                  </div>
                  {useRealData && (
                    <div className="rounded-md border bg-card p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Feedback timing</span>
                        <Badge variant="outline" className={feedbackModeBadgeClass(batch.feedback_mode)}>
                          {feedbackModeLabels[batch.feedback_mode]}
                        </Badge>
                      </div>
                      {batch.feedback_mode === "automatic_delayed" && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Randomized between {batch.feedback_delay_min_minutes} and {batch.feedback_delay_max_minutes} minutes.
                        </p>
                      )}
                    </div>
                  )}
                  {useRealData && (
                    <div className="rounded-md border bg-card p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                            <KeyRound className="h-3.5 w-3.5" />
                            Join Code
                          </div>
                          <p className="mt-1 font-mono text-base tracking-wider text-foreground">{batch.join_code}</p>
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
                        <Badge variant="outline" className={batch.join_code_enabled ? "bg-green-50 text-green-700 border-green-200" : "bg-muted text-muted-foreground"}>
                          {batch.join_code_enabled ? "Code enabled" : "Code disabled"}
                        </Badge>
                        <Badge variant="outline" className={batch.join_requires_approval ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-blue-50 text-blue-700 border-blue-200"}>
                          {batch.join_requires_approval ? "Approval required" : "Auto-approve"}
                        </Badge>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="grid grid-cols-2 gap-3 bg-muted/10 pt-4">
                <Link href={`/teacher/students?batch=${batch.id}`} className="w-full">
                  <Button variant="outline" className="w-full text-xs">View Students</Button>
                </Link>
                {useRealData ? (
                  <Button variant="outline" className="w-full text-xs" onClick={() => openDialog(batch)}>
                    <Edit className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                ) : (
                  <Link href={`/teacher/submissions?batch=${batch.id}`} className="w-full">
                    <Button className="w-full text-xs">Submissions</Button>
                  </Link>
                )}
                {useRealData && (
                  <Button variant="ghost" className="col-span-2 text-xs" onClick={() => toggleBatch(batch)}>
                    <Archive className="w-3 h-3 mr-1" />
                    {batch.is_active ? "Archive Batch" : "Reactivate Batch"}
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editingBatch ? "Edit Batch" : "Create Batch"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="batch-name">Batch name</Label>
              <Input
                id="batch-name"
                value={formData.name}
                onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                placeholder="Phase 4 A2 Test Batch"
              />
            </div>
            <div className="space-y-2">
              <Label>Level</Label>
              <Select value={formData.level} onValueChange={(value) => setFormData({ ...formData, level: value as WorkspaceLevel })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select level" />
                </SelectTrigger>
                <SelectContent>
                  {LEVEL_OPTIONS.map((level) => (
                    <SelectItem key={level} value={level}>{level}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="batch-description">Description</Label>
              <Textarea
                id="batch-description"
                value={formData.description}
                onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                placeholder="Optional notes for this class group"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="batch-active">Active batch</Label>
              <Switch
                id="batch-active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="batch-code-enabled">Batch code enabled</Label>
                <p className="text-xs text-muted-foreground mt-1">Students can request to join with this batch code.</p>
              </div>
              <Switch
                id="batch-code-enabled"
                checked={formData.join_code_enabled}
                onCheckedChange={(checked) => setFormData({ ...formData, join_code_enabled: checked })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="batch-approval-required">Teacher approval required</Label>
                <p className="text-xs text-muted-foreground mt-1">Keep this on unless you want instant joins.</p>
              </div>
              <Switch
                id="batch-approval-required"
                checked={formData.join_requires_approval}
                onCheckedChange={(checked) => setFormData({ ...formData, join_requires_approval: checked })}
              />
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <Label>Feedback timing</Label>
              <Select
                value={formData.feedback_mode}
                onValueChange={(value) => setFormData({ ...formData, feedback_mode: value as BatchFeedbackMode })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select timing mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="teacher_review_only">Teacher review only</SelectItem>
                  <SelectItem value="immediate">Immediate feedback</SelectItem>
                  <SelectItem value="automatic_delayed">Automatic delayed feedback</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Teacher review only keeps feedback manual. Immediate and automatic delayed modes are handled by the scheduled processor.
              </p>
            </div>
            {formData.feedback_mode === "automatic_delayed" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border p-3">
                <div className="space-y-2">
                  <Label htmlFor="feedback-delay-min">Minimum delay</Label>
                  <Input
                    id="feedback-delay-min"
                    type="number"
                    min={0}
                    max={10080}
                    value={formData.feedback_delay_min_minutes}
                    onChange={(event) => setFormData({
                      ...formData,
                      feedback_delay_min_minutes: Number(event.target.value),
                    })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="feedback-delay-max">Maximum delay</Label>
                  <Input
                    id="feedback-delay-max"
                    type="number"
                    min={0}
                    max={10080}
                    value={formData.feedback_delay_max_minutes}
                    onChange={(event) => setFormData({
                      ...formData,
                      feedback_delay_max_minutes: Number(event.target.value),
                    })}
                  />
                </div>
                <p className="sm:col-span-2 text-xs text-muted-foreground">
                  Each submission gets a different feedback time inside this range.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveBatch}>Save Batch</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
