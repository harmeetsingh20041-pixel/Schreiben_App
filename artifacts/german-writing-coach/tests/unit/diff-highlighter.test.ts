import { describe, expect, it } from "vitest";
import { getDiffWords } from "@/utils/diffHighlighter";

function reconstructedOriginal(chunks: ReturnType<typeof getDiffWords>) {
  return chunks.filter((chunk) => chunk.type !== "added").map((chunk) => chunk.text).join("");
}

function reconstructedCorrection(chunks: ReturnType<typeof getDiffWords>) {
  return chunks.filter((chunk) => chunk.type !== "removed").map((chunk) => chunk.text).join("");
}

describe("getDiffWords", () => {
  it("aligns a removed repeated word without corrupting later words", () => {
    const chunks = getDiffWords("ich ich gehe heute", "ich gehe heute");

    expect(reconstructedOriginal(chunks)).toBe("ich ich gehe heute");
    expect(reconstructedCorrection(chunks)).toBe("ich gehe heute");
    expect(chunks.filter((chunk) => chunk.type === "removed")).toEqual([
      { type: "removed", text: "ich " },
    ]);
  });

  it("aligns an inserted repeated word without producing undefined chunks", () => {
    const chunks = getDiffWords("Ich gehe heute", "Ich gehe gehe heute");

    expect(reconstructedOriginal(chunks)).toBe("Ich gehe heute");
    expect(reconstructedCorrection(chunks)).toBe("Ich gehe gehe heute");
    expect(chunks.every((chunk) => chunk.text.length > 0)).toBe(true);
  });

  it("preserves punctuation and repeated whitespace exactly", () => {
    const original = "Hallo ,  ich komme um 7.30 Uhr.";
    const corrected = "Hallo, ich komme um 7.30 Uhr.";
    const chunks = getDiffWords(original, corrected);

    expect(reconstructedOriginal(chunks)).toBe(original);
    expect(reconstructedCorrection(chunks)).toBe(corrected);
  });

  it("exposes a missing sentence space without changing either string", () => {
    const original = "Ich gehe.Dann komme ich.";
    const corrected = "Ich gehe. Dann komme ich.";
    const chunks = getDiffWords(original, corrected);

    expect(reconstructedOriginal(chunks)).toBe(original);
    expect(reconstructedCorrection(chunks)).toBe(corrected);
    expect(chunks.some((chunk) => chunk.type === "added" && chunk.text === " ")).toBe(true);
  });

  it("returns no chunks for two empty strings", () => {
    expect(getDiffWords("", "")).toEqual([]);
  });

  it("falls back to a bounded linear diff for adversarial long input", () => {
    const original = "a ".repeat(6_000);
    const corrected = "b ".repeat(6_000);
    const startedAt = performance.now();
    const chunks = getDiffWords(original, corrected);

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(reconstructedOriginal(chunks)).toBe(original);
    expect(reconstructedCorrection(chunks)).toBe(corrected);
  });
});
