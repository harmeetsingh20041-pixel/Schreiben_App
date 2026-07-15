import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const validatorPath = join(here, "verify-candidates.mjs");
const sourcePath = join(here, "candidates.jsonl");
const sourceRows = (await readFile(sourcePath, "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse);

const runValidator = async (rows) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-a1-corpus-"),
  );
  const candidatePath = join(temporaryDirectory, "candidates.jsonl");
  try {
    await writeFile(
      candidatePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return spawnSync(
      process.execPath,
      [validatorPath, "--file", candidatePath],
      { encoding: "utf8" },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const cloneRows = () => structuredClone(sourceRows);

test("accepts the checked-in 150-case A1 candidate corpus", async () => {
  const result = await runValidator(cloneRows());
  assert.equal(result.status, 0, result.stdout || result.stderr);
});

test("rejects a missing matrix identity", async () => {
  const rows = cloneRows();
  rows.splice(40, 1);
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects fabricated review or actual-outcome evidence", async () => {
  const rows = cloneRows();
  rows[0].reviewer = {
    reviewer_id: "fake-reviewer",
    qualification: "fabricated",
    reviewed_at: "2026-01-01T00:00:00.000Z",
  };
  rows[1].actual_disposition = "accepted_feedback";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects source or corrected offset drift", async () => {
  const rows = cloneRows();
  rows[10].expected_feedback.changes[0].source_start += 1;
  rows[20].expected_feedback.changes[0].corrected_end -= 1;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("uses runtime Unicode-code-point offsets after an emoji", async () => {
  const rows = cloneRows();
  const emojiCase = rows[78];
  const expectedChange = emojiCase.expected_feedback.changes[0];
  const utf16Index = emojiCase.input_text.indexOf(expectedChange.original_text);
  const unicodeIndex = Array.from(
    emojiCase.input_text.slice(0, utf16Index),
  ).length;
  assert.equal(expectedChange.source_start, unicodeIndex);
  assert.notEqual(utf16Index, unicodeIndex);

  expectedChange.source_start = utf16Index;
  expectedChange.source_end = utf16Index + expectedChange.original_text.length;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects a corrected span moved to an unrelated duplicate token", async () => {
  const rows = cloneRows();
  const duplicateCorrectedTokenCase = rows[79];
  const expectedChange =
    duplicateCorrectedTokenCase.expected_feedback.changes[0];
  const firstOccurrence = Array.from(
    duplicateCorrectedTokenCase.expected_feedback.corrected_text.slice(
      0,
      duplicateCorrectedTokenCase.expected_feedback.corrected_text.indexOf(
        expectedChange.corrected_text,
      ),
    ),
  ).length;
  expectedChange.corrected_start = firstOccurrence;
  expectedChange.corrected_end =
    firstOccurrence + Array.from(expectedChange.corrected_text).length;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects duplicate writing input", async () => {
  const rows = cloneRows();
  rows[1].input_text = rows[0].input_text;
  rows[1].expected_feedback.corrected_text = rows[0].input_text;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects PII-like content in nested candidate metadata", async () => {
  const rows = cloneRows();
  rows[140].hold_fixture.candidate_failure =
    "Send the invalid candidate to student@example.com before holding it.";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects scheme-less URLs and domestic phone numbers", async () => {
  const rows = cloneRows();
  rows[140].hold_fixture.candidate_failure =
    "Send the invalid candidate to www.example.de or call 030 12345678 before holding it.";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects textual review or certification attestations", async () => {
  const rows = cloneRows();
  rows[10].expected_feedback.changes[0].explanation =
    "Reviewed and approved by a qualified German reviewer as the final correction.";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects topic-mapping drift", async () => {
  const rows = cloneRows();
  rows[110].expected_topic_slugs = ["nominativ"];
  rows[110].expected_feedback.changes[0].grammar_topic = "nominativ";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects hold-variant quota drift", async () => {
  const rows = cloneRows();
  rows[140].hold_variant = "unmapped_topic";
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects hold variants swapped across incompatible failure semantics", async () => {
  const rows = cloneRows();
  const firstVariant = rows[140].hold_variant;
  rows[140].hold_variant = rows[148].hold_variant;
  rows[148].hold_variant = firstVariant;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});

test("rejects a prompt-injection case without the resistance expectation", async () => {
  const rows = cloneRows();
  rows[130].expected_adversarial_instruction_resisted = false;
  const result = await runValidator(rows);
  assert.notEqual(result.status, 0);
});
