import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  constrainWritingInput,
  V1_WRITING_MAX_CHARACTERS,
  V1_WRITING_MAX_FEEDBACK_UNITS,
  writingUnicodeCharacterCount,
} from "@/lib/writingInputContract";

describe("V1 writing input contract", () => {
  it("publishes the same 4,000-character and 40-unit launch limits as the database", () => {
    expect(V1_WRITING_MAX_CHARACTERS).toBe(4_000);
    expect(V1_WRITING_MAX_FEEDBACK_UNITS).toBe(40);
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(writingUnicodeCharacterCount("ä🙂e\u0301")).toBe(4);
    expect("ä🙂e\u0301".length).toBe(5);
  });

  it("accepts exactly 4,000 Unicode characters and rejects the whole 4,001st-character edit", () => {
    const exact = "🙂".repeat(4_000);
    const accepted = constrainWritingInput("", exact);
    const capped = constrainWritingInput(exact, `${exact}a`);

    expect(accepted).toEqual({ value: exact, wasLimited: false });
    expect(capped.value).toBe(exact);
    expect(capped.wasLimited).toBe(true);
    expect(writingUnicodeCharacterCount(capped.value)).toBe(4_000);
  });

  it("never truncates an oversized paste into text that autosave could persist", () => {
    const current = "Meine Arbeit";
    const pasted = "🙂".repeat(4_001);

    expect(constrainWritingInput(current, pasted)).toEqual({
      value: current,
      wasLimited: true,
    });
  });

  it("lets a legacy oversized draft shrink without silently truncating it", () => {
    const current = "a".repeat(4_100);
    const shortened = "a".repeat(4_050);
    const sameLengthEdit = `b${"a".repeat(4_099)}`;

    expect(constrainWritingInput(current, shortened)).toEqual({
      value: shortened,
      wasLimited: false,
    });
    expect(constrainWritingInput(current, sameLengthEdit)).toEqual({
      value: sameLengthEdit,
      wasLimited: false,
    });
    expect(constrainWritingInput(current, `${current}a`)).toEqual({
      value: current,
      wasLimited: true,
    });
  });

  it("routes the student editor through the Unicode limiter and visible maximum counter", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/write.tsx"),
      "utf8",
    );

    expect(source).toContain("handleWritingChange(e.target.value)");
    expect(source).toContain("writingCharacterCount");
    expect(source).toContain("V1_WRITING_MAX_CHARACTERS.toLocaleString()");
    expect(source).toContain("V1_WRITING_MAX_FEEDBACK_UNITS");
  });
});
