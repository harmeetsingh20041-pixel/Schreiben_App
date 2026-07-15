import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  applyRebalancedChoiceOrderToRaw,
  choiceOrderDistribution,
  expectedAnswerIndex,
  parseVisibleWordBank,
  rebalanceWorksheetChoiceOrder,
  worksheetChoiceOrderErrors,
} from "./worksheet-choice-order.js";

function fixture() {
  const multipleChoice = [1, 2, 3].map((questionNumber) => ({
    question_number: questionNumber,
    question_type: "multiple_choice",
    evaluation_mode: "local_exact",
    prompt: `Question ${questionNumber} has enough prompt text.`,
    options: ["correct", "wrong b", "wrong c"],
    correct_answer: "correct",
    accepted_answers: ["correct"],
  }));
  const fillBlank = [4, 5, 6].map((questionNumber) => ({
    question_number: questionNumber,
    question_type: "fill_blank",
    evaluation_mode: "local_exact",
    prompt: `Bedeutung: eindeutige Form. Wortbank: [correct | wrong b | wrong c]. Ergänze: Das ist ___ .`,
    options: [],
    correct_answer: "correct",
    accepted_answers: ["correct"],
  }));
  return {
    draft_metadata: {
      template_key: "v1-a1-choice-order-test-r1",
      authoring_status: "draft_unapproved",
      certification_status: "not_certified",
      approval_status: "unapproved",
    },
    title: "Choice-order fixture",
    questions: [...multipleChoice, ...fillBlank],
  };
}

test("deterministically rebalances collapsed answers and is idempotent", () => {
  const original = fixture();
  const originalErrors = worksheetChoiceOrderErrors(original);
  assert.ok(originalErrors.length >= 4);

  const first = rebalanceWorksheetChoiceOrder(original).worksheet;
  const second = rebalanceWorksheetChoiceOrder(first).worksheet;
  assert.deepEqual(second, first);
  assert.deepEqual(worksheetChoiceOrderErrors(first), []);

  const questions = first.questions as Array<{
    question_type: string;
    prompt: string;
    options: string[];
    correct_answer: string;
  }>;
  const multipleChoicePositions = questions
    .filter((question) => question.question_type === "multiple_choice")
    .map((question) => question.options.indexOf(question.correct_answer));
  const bankPositions = questions
    .filter((question) => question.question_type === "fill_blank")
    .map((question) => {
      const bank = parseVisibleWordBank(question.prompt);
      return bank?.choices.indexOf(question.correct_answer);
    });
  assert.deepEqual(new Set(multipleChoicePositions).size, 3);
  assert.deepEqual(new Set(bankPositions).size, 3);
  assert.equal(
    (first.draft_metadata as Record<string, unknown>).approval_status,
    "unapproved",
  );
});

test("uses template-seeded permutations instead of an obvious fixed sequence", () => {
  const sequences = [
    "v1-a1-choice-order-test-r1",
    "v1-a2-articles-r1",
    "v1-b1-dativ-r1",
    "v1-b2-coherence-r2",
    "v1-a2-genitiv-r1",
  ].map((templateKey) =>
    [0, 1, 2].map((ordinal) =>
      expectedAnswerIndex({
        templateKey,
        kind: "multiple_choice",
        ordinal,
        choiceCount: 3,
      }),
    ),
  );
  for (const sequence of sequences) {
    assert.deepEqual([...sequence].sort(), [0, 1, 2]);
  }
  assert.ok(new Set(sequences.map((sequence) => sequence.join(","))).size >= 3);
  assert.ok(sequences.some((sequence) => sequence.join(",") !== "0,1,2"));
});

test("distribution validation rejects first-position collapse", () => {
  const second = fixture();
  second.draft_metadata.template_key = "v1-a1-choice-order-test-r2";
  const report = choiceOrderDistribution([fixture(), second]);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /position-collapsed/);
});

test("raw rewriting preserves surrounding pretty and compact JSON layout", () => {
  const original = fixture();
  const rebalanced = rebalanceWorksheetChoiceOrder(original).worksheet;
  for (const raw of [
    `${JSON.stringify(original, null, 2)}\n`,
    JSON.stringify(original),
  ]) {
    const rewritten = applyRebalancedChoiceOrderToRaw(
      raw,
      original,
      rebalanced,
    );
    assert.deepEqual(JSON.parse(rewritten), rebalanced);
    assert.equal(rewritten.endsWith("\n"), raw.endsWith("\n"));
  }
});

test("all checked-in drafts use the deterministic launch choice order", async () => {
  const root = new URL("../../quality/worksheet-bank/drafts/", import.meta.url);
  let files = 0;
  const errors: string[] = [];
  const worksheets: unknown[] = [];
  for (const level of ["a1", "a2", "b1", "b2"]) {
    const directory = new URL(`${level}/`, root);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      files += 1;
      const value = JSON.parse(
        await readFile(new URL(name, directory), "utf8"),
      ) as unknown;
      worksheets.push(value);
      errors.push(...worksheetChoiceOrderErrors(value));
    }
  }
  assert.equal(files, 184);
  assert.deepEqual(errors, []);
  const distribution = choiceOrderDistribution(worksheets);
  assert.equal(distribution.ok, true);
  assert.deepEqual(distribution.errors, []);
  assert.deepEqual(
    distribution.buckets.map((bucket) => ({
      kind: bucket.kind,
      choiceCount: bucket.choiceCount,
      total: bucket.total,
    })),
    [
      { kind: "multiple_choice", choiceCount: 3, total: 316 },
      { kind: "multiple_choice", choiceCount: 4, total: 553 },
      { kind: "word_bank", choiceCount: 2, total: 27 },
      { kind: "word_bank", choiceCount: 3, total: 603 },
      { kind: "word_bank", choiceCount: 4, total: 33 },
    ],
  );
});
