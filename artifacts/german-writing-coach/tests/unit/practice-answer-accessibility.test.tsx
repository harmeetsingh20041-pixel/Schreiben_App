import { useState } from "react";
import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuestionAnswerControl } from "@/pages/student/worksheet";
import type { PracticeWorksheetQuestion } from "@/services/practiceWorksheetService";

function question(
  overrides: Partial<PracticeWorksheetQuestion>,
): PracticeWorksheetQuestion {
  return {
    id: "question-1",
    question_number: 1,
    question_type: "multiple_choice",
    prompt: "Choose one answer.",
    options: ["Option one", "Option two"],
    ...overrides,
  };
}

function ChoiceHarness() {
  const [value, setValue] = useState("");
  return (
    <main>
      <p id="question-1-prompt">Question 1. Choose one answer.</p>
      <QuestionAnswerControl
        question={question({})}
        value={value}
        disabled={false}
        labelledBy="question-1-prompt"
        onChange={setValue}
      />
    </main>
  );
}

async function expectNoAutomatedViolations() {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

describe("worksheet answer accessibility", () => {
  it("exposes choice questions as one named, keyboard-operable radio group", async () => {
    const user = userEvent.setup();
    render(<ChoiceHarness />);

    const group = screen.getByRole("radiogroup", {
      name: "Question 1. Choose one answer.",
    });
    const first = screen.getByRole("radio", { name: "Option one" });
    const second = screen.getByRole("radio", { name: "Option two" });
    expect(group).toContainElement(first);
    expect(group).toContainElement(second);
    expect(first).toHaveAttribute("aria-checked", "false");

    await user.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
    second.focus();
    await user.keyboard(" ");
    expect(second).toHaveAttribute("aria-checked", "true");
    expect(second).toHaveFocus();
    await expectNoAutomatedViolations();
  });

  it.each([
    ["fill_blank", "textbox"],
    ["mini_writing", "textbox"],
  ] as const)("names the %s answer field", async (questionType, role) => {
    render(
      <main>
        <p id="question-1-prompt">Question 1. Choose one answer.</p>
        <QuestionAnswerControl
          question={question({ question_type: questionType, options: [] })}
          value=""
          disabled={false}
          labelledBy="question-1-prompt"
          onChange={() => undefined}
        />
      </main>,
    );

    expect(
      screen.getByRole(role, { name: "Question 1. Choose one answer." }),
    ).toBeInTheDocument();
    await expectNoAutomatedViolations();
  });
});
