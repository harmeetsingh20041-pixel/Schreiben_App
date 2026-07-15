import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

describe("dialog accessibility contract", () => {
  it("keeps long dialogs inside short and narrow viewports", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Class settings</DialogTitle>
          <DialogDescription>Update the class feedback schedule.</DialogDescription>
          <div style={{ height: 1_200 }}>Long form</div>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Class settings" });
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]");
    expect(dialog).toHaveClass("w-[calc(100%-2rem)]");
    expect(dialog).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
