import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { formatErrorMessage } from "@/lib/workspaceData";
import { requestJoinBatchByCode } from "@/services/studentService";
import { cn } from "@/lib/utils";

export function StudentJoinClassDialog({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { authMode, role, user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (authMode !== "supabase" || role !== "student" || !user) return null;

  const submitJoinCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!joinCode.trim()) {
      toast({
        title: "Class code required",
        description: "Enter the code your teacher shared.",
      });
      return;
    }

    setSubmitting(true);
    try {
      const result = await requestJoinBatchByCode(joinCode);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentBatchAssignments(user.id),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentJoinRequests(user.id),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentAssignedQuestions(user.id),
        }),
      ]);
      setJoinCode("");
      setOpen(false);
      toast(
        result.status === "approved"
          ? {
              title: "Already joined",
              description: `You already have access to ${result.batch_name}.`,
            }
          : {
              title: "Request sent",
              description: "Waiting for teacher approval.",
            },
      );
    } catch (error) {
      toast({
        title: "Could not request class",
        description: formatErrorMessage(error, "Check the code and try again."),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(compact ? "w-full justify-start" : "", className)}
        >
          <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
          Join another class
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join another class</DialogTitle>
          <DialogDescription>
            Enter the class code from your teacher. Your teacher must approve
            every request before you get access.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submitJoinCode}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="shell-class-code">
              Class code
            </label>
            <Input
              id="shell-class-code"
              value={joinCode}
              onChange={(event) =>
                setJoinCode(event.target.value.toUpperCase())
              }
              autoComplete="off"
              className="font-mono tracking-wider"
              placeholder="Enter class code"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Request access"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
