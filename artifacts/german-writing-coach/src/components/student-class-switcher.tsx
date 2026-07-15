import { useStudentClass } from "@/lib/studentClassContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function StudentClassSwitcher({
  className,
  id,
  showLabel = false,
}: {
  className?: string;
  id: string;
  showLabel?: boolean;
}) {
  const {
    activeAssignment,
    activeBatchId,
    assignments,
    isLoading,
    selectActiveBatch,
  } = useStudentClass();

  if (isLoading) {
    return (
      <span
        className={cn("text-sm text-muted-foreground", className)}
        role="status"
      >
        Loading classes...
      </span>
    );
  }

  if (assignments.length === 0) return null;

  if (assignments.length === 1 && activeAssignment) {
    return (
      <div className={cn("min-w-0 text-sm", className)}>
        {showLabel && (
          <span className="mr-1 text-muted-foreground">Active class:</span>
        )}
        <span className="font-medium text-foreground">
          {activeAssignment.batch_name} · {activeAssignment.level}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {showLabel && (
        <label className="block text-sm font-medium" htmlFor={id}>
          Active class
        </label>
      )}
      <Select value={activeBatchId ?? ""} onValueChange={selectActiveBatch}>
        <SelectTrigger
          id={id}
          aria-label="Active class"
          className="w-full bg-card"
        >
          <SelectValue placeholder="Choose a class" />
        </SelectTrigger>
        <SelectContent>
          {assignments.map((assignment) => (
            <SelectItem key={assignment.id} value={assignment.batch_id}>
              {assignment.batch_name} · {assignment.level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
