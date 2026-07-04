import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId, LEVEL_OPTIONS } from "@/lib/workspaceData";
import { listWorkspaceBatches, type WorkspaceBatch } from "@/services/batchService";
import { assignStudentToBatch, inviteStudentByEmail, listStudentInvitations, listWorkspaceStudents, removeStudentBatchAssignment, type StudentInvitation, type WorkspaceStudent } from "@/services/studentService";
import { MOCK_BATCHES, MOCK_STUDENTS } from "@/data/mockData";
import { Eye, Search, UserPlus, X } from "lucide-react";

function statusBadgeClass(status: string) {
  const classes: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    accepted: "bg-green-50 text-green-700 border-green-200",
    cancelled: "bg-muted text-muted-foreground",
    expired: "bg-destructive/10 text-destructive border-destructive/20",
  };
  return classes[status] ?? "bg-muted";
}

export default function TeacherStudents() {
  const searchParams = new URLSearchParams(useSearch());
  const initialBatch = searchParams.get("batch") || "all";
  const { authMode, user, workspaceMemberships } = useAuth();
  const { toast } = useToast();
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const useRealData = authMode === "supabase" && Boolean(user);

  const [search, setSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState(initialBatch);
  const [levelFilter, setLevelFilter] = useState("all");
  const [batches, setBatches] = useState<WorkspaceBatch[]>([]);
  const [students, setStudents] = useState<WorkspaceStudent[]>([]);
  const [invitations, setInvitations] = useState<StudentInvitation[]>([]);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBatchId, setInviteBatchId] = useState("none");

  const loadStudents = async () => {
    if (!useRealData) return;
    if (!workspaceId) {
      setError("No workspace found. Create a workspace before managing students.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const [nextBatches, nextStudents, nextInvitations] = await Promise.all([
        listWorkspaceBatches(workspaceId),
        listWorkspaceStudents(workspaceId),
        listStudentInvitations(workspaceId),
      ]);
      setBatches(nextBatches);
      setStudents(nextStudents);
      setInvitations(nextInvitations);
    } catch (loadError) {
      setError(formatErrorMessage(loadError, "Unable to load students."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStudents();
  }, [useRealData, workspaceId]);

  const mockBatchMap = new Map(MOCK_BATCHES.map((batch) => [batch.id, batch]));
  const displayBatches = useRealData ? batches : MOCK_BATCHES.map((batch) => ({
    id: batch.id,
    workspace_id: "mock",
    name: batch.name,
    level: batch.level ?? "A2",
    description: null,
    is_active: true,
    created_by: null,
    created_at: "",
    updated_at: "",
    student_count: batch.student_count,
    submission_count: batch.submission_count,
  } as WorkspaceBatch));

  const displayStudents = useMemo(() => {
    const source = useRealData
      ? students
      : MOCK_STUDENTS.map((student) => {
          const batch = mockBatchMap.get(student.batchId);
          return {
            id: student.id,
            name: student.name,
            email: student.email,
            membership_id: student.id,
            batches: batch
              ? [{ id: student.batchId, batch_id: student.batchId, batch_name: batch.name, level: batch.level ?? "A2" }]
              : [],
            total_submissions: student.total_submissions,
            last_active: student.last_active,
          } as WorkspaceStudent;
        });

    return source.filter((student) => {
      const query = search.toLowerCase();
      const matchesSearch =
        student.name.toLowerCase().includes(query) ||
        student.email.toLowerCase().includes(query);
      const matchesBatch =
        batchFilter === "all" || student.batches.some((batch) => batch.batch_id === batchFilter);
      const matchesLevel =
        levelFilter === "all" || student.batches.some((batch) => batch.level === levelFilter);
      return matchesSearch && matchesBatch && matchesLevel;
    });
  }, [batchFilter, levelFilter, mockBatchMap, search, students, useRealData]);

  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");

  const sendInvite = async () => {
    if (!inviteEmail.trim()) {
      toast({ title: "Email required", description: "Enter the student's email address." });
      return;
    }

    try {
      await inviteStudentByEmail(inviteEmail, inviteBatchId === "none" ? null : inviteBatchId);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteBatchId("none");
      await loadStudents();
      toast({ title: "Invitation saved", description: "Pending invitations are listed below." });
    } catch (inviteError) {
      toast({
        title: "Could not invite student",
        description: formatErrorMessage(inviteError, "Please try again."),
      });
    }
  };

  const assignBatch = async (studentId: string, batchId: string) => {
    if (!workspaceId || batchId === "none") return;
    try {
      await assignStudentToBatch(workspaceId, studentId, batchId);
      await loadStudents();
    } catch (assignError) {
      toast({
        title: "Could not assign batch",
        description: formatErrorMessage(assignError, "Please try again."),
      });
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    try {
      await removeStudentBatchAssignment(assignmentId);
      await loadStudents();
    } catch (removeError) {
      toast({
        title: "Could not remove assignment",
        description: formatErrorMessage(removeError, "Please try again."),
      });
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Students</h1>
          <p className="text-muted-foreground mt-1">Manage invitations, batch assignments, and student progress.</p>
        </div>
        {useRealData && (
          <Button onClick={() => setInviteOpen(true)} className="shadow-md">
            <UserPlus className="w-4 h-4 mr-2" />
            Invite Student
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px_160px] gap-4 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search students..."
            className="pl-9 bg-card"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select value={batchFilter} onValueChange={setBatchFilter}>
          <SelectTrigger className="bg-card">
            <SelectValue placeholder="Filter by Batch" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Batches</SelectItem>
            {displayBatches.map((batch) => (
              <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card className="shadow-sm mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Assigned Batches</TableHead>
              <TableHead className="hidden md:table-cell">Submissions</TableHead>
              <TableHead className="hidden sm:table-cell">Last Active</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  Loading students...
                </TableCell>
              </TableRow>
            ) : displayStudents.length > 0 ? (
              displayStudents.map((student) => (
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
                          {useRealData && (
                            <button
                              type="button"
                              className="ml-1 rounded-sm hover:text-destructive"
                              onClick={() => removeAssignment(batch.id)}
                              aria-label={`Remove ${batch.batch_name}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                    </div>
                    {useRealData && displayBatches.length > 0 && (
                      <div className="mt-2 max-w-56">
                        <Select value="none" onValueChange={(value) => assignBatch(student.id, value)}>
                          <SelectTrigger className="h-8 text-xs bg-card">
                            <SelectValue placeholder="Assign batch" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Assign batch</SelectItem>
                            {displayBatches.map((batch) => (
                              <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{student.total_submissions}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">{student.last_active}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/teacher/submissions?student=${student.id}`}>
                      <Button variant="ghost" size="sm" className="text-primary hover:text-primary hover:bg-primary/10">
                        <Eye className="w-4 h-4 mr-2" /> View Work
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12">
                  <h2 className="text-lg font-semibold mb-2">Invite your first student</h2>
                  <p className="text-muted-foreground mb-4">Students appear here after accepting an invitation or when their account already exists.</p>
                  {useRealData && <Button onClick={() => setInviteOpen(true)}>Invite Student</Button>}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {useRealData && (
        <Card className="shadow-sm">
          <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Pending Invitations</CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            {pendingInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <div className="space-y-3">
                {pendingInvitations.map((invitation) => (
                  <div key={invitation.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-4">
                    <div>
                      <p className="font-medium">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {invitation.batch_name ? `${invitation.batch_name} · ${invitation.batch_level}` : "Workspace invitation"}
                      </p>
                    </div>
                    <Badge variant="outline" className={statusBadgeClass(invitation.status)}>{invitation.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Invite Student</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="student-email">Student email</Label>
              <Input
                id="student-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="student@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Batch</Label>
              <Select value={inviteBatchId} onValueChange={setInviteBatchId}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional batch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Workspace only</SelectItem>
                  {displayBatches.map((batch) => (
                    <SelectItem key={batch.id} value={batch.id}>{batch.name} · {batch.level}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={sendInvite}>Save Invitation</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
