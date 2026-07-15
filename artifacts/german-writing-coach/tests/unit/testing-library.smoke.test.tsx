import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

function TestForm() {
  const [name, setName] = useState("");

  return (
    <form>
      <label htmlFor="student-name">Student name</label>
      <input
        id="student-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <output aria-live="polite">{name}</output>
    </form>
  );
}

describe("Testing Library foundation", () => {
  it("renders and interacts through accessible labels", async () => {
    const user = userEvent.setup();
    render(<TestForm />);

    await user.type(screen.getByLabelText("Student name"), "Lena");

    expect(screen.getByRole("status")).toHaveTextContent("Lena");
  });
});
