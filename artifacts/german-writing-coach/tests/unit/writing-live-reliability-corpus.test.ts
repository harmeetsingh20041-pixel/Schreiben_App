import { describe, expect, it } from "vitest";
import {
  WRITING_LIVE_REGRESSION_CASES,
  WRITING_LIVE_RELIABILITY_CORPUS,
  WRITING_LIVE_TOPIC_SLUGS,
  writingLiveReliabilityCase,
} from "../e2e/fixtures/writing-live-reliability-corpus";

describe("writing live reliability corpus", () => {
  it("contains exactly five fixed cases per A1-B2 level", () => {
    expect(WRITING_LIVE_RELIABILITY_CORPUS).toHaveLength(20);
    expect(
      new Set(WRITING_LIVE_RELIABILITY_CORPUS.map((entry) => entry.id)).size,
    ).toBe(20);
    for (const level of ["A1", "A2", "B1", "B2"] as const) {
      const cases = WRITING_LIVE_RELIABILITY_CORPUS.filter(
        (entry) => entry.level === level,
      );
      expect(cases).toHaveLength(5);
      expect(
        cases.filter((entry) => entry.mistakeProfile === "correct"),
      ).toHaveLength(1);
    }
  });

  it("keeps every fictional sample within the V1 writing contract", () => {
    const closedTopics = new Set(WRITING_LIVE_TOPIC_SLUGS);
    for (const entry of WRITING_LIVE_RELIABILITY_CORPUS) {
      const words = entry.text.trim().split(/\s+/u).length;
      expect(words, entry.id).toBeGreaterThanOrEqual(50);
      expect(words, entry.id).toBeLessThanOrEqual(120);
      expect(entry.text.length, entry.id).toBeLessThanOrEqual(4_000);
      expect(entry.text, entry.id).not.toContain("\u0000");
      expect(entry.expectedIssueRange[0], entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.expectedIssueRange[1], entry.id).toBeGreaterThanOrEqual(
        entry.expectedIssueRange[0],
      );
      expect(
        entry.expectedTopics.every((topic) => closedTopics.has(topic)),
        entry.id,
      ).toBe(true);
      if (entry.mistakeProfile === "correct") {
        expect(entry.expectedIssueRange, entry.id).toEqual([0, 0]);
        expect(entry.expectedTopics, entry.id).toEqual([]);
      } else {
        expect(entry.expectedIssueRange[0], entry.id).toBeGreaterThan(0);
        expect(entry.expectedTopics.length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it("accepts only a bounded source-owned case index", () => {
    expect(writingLiveReliabilityCase(undefined).id).toBe(
      WRITING_LIVE_RELIABILITY_CORPUS[0]!.id,
    );
    expect(writingLiveReliabilityCase(" 19 ").id).toBe(
      WRITING_LIVE_RELIABILITY_CORPUS[19]!.id,
    );
    for (const invalid of ["-1", "20", "1.5", "case", "", "  "]) {
      if (invalid.trim() === "") continue;
      expect(() => writingLiveReliabilityCase(invalid)).toThrow(
        "E2E_LIVE_WRITING_CASE_INDEX",
      );
    }
  });

  it("keeps the reported A1 letter in a separate closed regression contract", () => {
    const regression =
      WRITING_LIVE_REGRESSION_CASES["a1-user-letter-regression"];
    expect(WRITING_LIVE_RELIABILITY_CORPUS).not.toContain(regression);
    expect(regression.text.trim().split(/\s+/u)).toHaveLength(92);
    expect(regression.text.split("\n")).toHaveLength(6);
    expect(regression.requiredCorrectionGroups).toHaveLength(13);
    expect(
      new Set(regression.requiredCorrectionGroups.map((group) => group.id))
        .size,
    ).toBe(13);
    expect(
      regression.requiredCorrectionGroups.every(
        (group) =>
          group.anyOf.length > 0 &&
          new Set(group.anyOf).size === group.anyOf.length,
      ),
    ).toBe(true);
    expect(regression.forbiddenUncorrectedSubstrings).toHaveLength(10);
    expect(new Set(regression.forbiddenUncorrectedSubstrings).size).toBe(10);
    expect(regression.minimumExpectedTopicHits).toBe(3);
    expect(
      writingLiveReliabilityCase(undefined, "a1-user-letter-regression"),
    ).toBe(regression);
    expect(() => writingLiveReliabilityCase(undefined, "unknown")).toThrow(
      "E2E_LIVE_WRITING_REGRESSION_ID",
    );
    expect(() =>
      writingLiveReliabilityCase("0", "a1-user-letter-regression"),
    ).toThrow("mutually exclusive");
  });
});
