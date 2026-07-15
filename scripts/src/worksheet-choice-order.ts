import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ChoiceKind = "multiple_choice" | "word_bank";

type DraftQuestion = {
  question_number?: unknown;
  question_type?: unknown;
  evaluation_mode?: unknown;
  prompt?: unknown;
  options?: unknown;
  correct_answer?: unknown;
};

type DraftWorksheet = {
  draft_metadata?: {
    template_key?: unknown;
  };
  questions?: unknown;
};

type WordBank = {
  choices: string[];
  prefix: string;
  suffix: string;
  separator: string;
};

export type ChoiceOrderChange = {
  questionNumber: number;
  kind: ChoiceKind;
  previousAnswerIndex: number;
  expectedAnswerIndex: number;
};

export type ChoiceOrderResult = {
  worksheet: DraftWorksheet;
  changes: ChoiceOrderChange[];
};

export type ChoicePositionBucket = {
  kind: ChoiceKind;
  choiceCount: number;
  total: number;
  positions: number[];
};

export type ChoicePositionDistribution = {
  ok: boolean;
  buckets: ChoicePositionBucket[];
  errors: string[];
};

const contractVersion = "schreiben-v1-choice-order-v1";
const wordBankPattern =
  /((?:closed\s+)?(?:word\s+bank|word\s+list|wortbank|wortliste)\s*[:：]?\s*)(\[([^\]]+)\]|\(([^)]+)\))/iu;

function normalize(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/\s+/g, " ");
}

function asWorksheet(value: unknown): DraftWorksheet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worksheet draft must be an object.");
  }
  return value as DraftWorksheet;
}

function worksheetTemplateKey(worksheet: DraftWorksheet) {
  const templateKey = worksheet.draft_metadata?.template_key;
  if (typeof templateKey !== "string" || !templateKey.trim()) {
    throw new Error("Worksheet draft needs draft_metadata.template_key.");
  }
  return templateKey;
}

function worksheetQuestions(worksheet: DraftWorksheet) {
  if (!Array.isArray(worksheet.questions)) {
    throw new Error("Worksheet draft needs a questions array.");
  }
  return worksheet.questions as DraftQuestion[];
}

function separatorFor(body: string) {
  if (body.includes("|")) return " | ";
  if (body.includes(";")) return "; ";
  if (body.includes(",")) return ", ";
  if (body.includes("/")) return " / ";
  return null;
}

export function parseVisibleWordBank(prompt: string): WordBank | null {
  const match = wordBankPattern.exec(prompt);
  if (!match) return null;
  const body = match[3] ?? match[4] ?? "";
  const separator = separatorFor(body);
  if (!separator) return null;
  const splitter = separator.trim();
  const choices = body
    .split(splitter)
    .map((choice) => choice.normalize("NFC").trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (
    choices.length < 2 ||
    new Set(choices.map(normalize)).size !== choices.length
  ) {
    return null;
  }
  const bank = match[2];
  const bankStart = prompt.indexOf(bank, match.index);
  return {
    choices,
    prefix: prompt.slice(0, bankStart + 1),
    suffix: prompt.slice(bankStart + bank.length - 1),
    separator,
  };
}

function deterministicPermutation(args: {
  templateKey: string;
  kind: ChoiceKind;
  choiceCount: number;
  epoch: number;
}) {
  const positions = Array.from(
    { length: args.choiceCount },
    (_, index) => index,
  );
  for (let index = positions.length - 1; index > 0; index -= 1) {
    const draw = createHash("sha256")
      .update(
        `${contractVersion}:${args.templateKey}:${args.kind}:${args.choiceCount}:${args.epoch}:${index}`,
      )
      .digest()
      .readUInt32BE(0);
    const target = draw % (index + 1);
    [positions[index], positions[target]] = [
      positions[target],
      positions[index],
    ];
  }
  return positions;
}

export function expectedAnswerIndex(args: {
  templateKey: string;
  kind: ChoiceKind;
  ordinal: number;
  choiceCount: number;
}) {
  if (!Number.isInteger(args.ordinal) || args.ordinal < 0) {
    throw new Error("Choice ordinal must be a non-negative integer.");
  }
  if (!Number.isInteger(args.choiceCount) || args.choiceCount < 2) {
    throw new Error("Choice count must be at least two.");
  }
  const epoch = Math.floor(args.ordinal / args.choiceCount);
  const positionInEpoch = args.ordinal % args.choiceCount;
  return deterministicPermutation({
    templateKey: args.templateKey,
    kind: args.kind,
    choiceCount: args.choiceCount,
    epoch,
  })[positionInEpoch];
}

function answerIndex(choices: string[], answer: string) {
  const answerKey = normalize(answer);
  const matches = choices
    .map(normalize)
    .map((choice, index) => (choice === answerKey ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new Error(
      `Canonical answer must occur exactly once in its choices; received ${matches.length}.`,
    );
  }
  return matches[0];
}

function rotateToIndex(
  choices: string[],
  currentIndex: number,
  targetIndex: number,
) {
  const shift =
    (currentIndex - targetIndex + choices.length) % choices.length;
  return [...choices.slice(shift), ...choices.slice(0, shift)];
}

function changedPrompt(bank: WordBank, choices: string[]) {
  return `${bank.prefix}${choices.join(bank.separator)}${bank.suffix}`;
}

export function rebalanceWorksheetChoiceOrder(
  value: unknown,
): ChoiceOrderResult {
  const worksheet = structuredClone(asWorksheet(value));
  const templateKey = worksheetTemplateKey(worksheet);
  const questions = worksheetQuestions(worksheet).sort(
    (left, right) =>
      Number(left.question_number ?? 0) - Number(right.question_number ?? 0),
  );
  const changes: ChoiceOrderChange[] = [];
  const multipleChoiceOrdinals = new Map<number, number>();
  const wordBankOrdinals = new Map<number, number>();
  const nextOrdinal = (ordinals: Map<number, number>, choiceCount: number) => {
    const ordinal = ordinals.get(choiceCount) ?? 0;
    ordinals.set(choiceCount, ordinal + 1);
    return ordinal;
  };

  for (const question of questions) {
    const questionNumber = Number(question.question_number);
    if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
      throw new Error(`${templateKey} contains an invalid question_number.`);
    }
    if (typeof question.correct_answer !== "string") {
      throw new Error(`${templateKey}:Q${questionNumber} needs correct_answer.`);
    }

    if (question.question_type === "multiple_choice") {
      if (!Array.isArray(question.options)) {
        throw new Error(`${templateKey}:Q${questionNumber} needs options.`);
      }
      const choices = question.options.map((option) => {
        if (typeof option !== "string") {
          throw new Error(
            `${templateKey}:Q${questionNumber} options must be strings.`,
          );
        }
        return option;
      });
      const previousAnswerIndex = answerIndex(
        choices,
        question.correct_answer,
      );
      const targetAnswerIndex = expectedAnswerIndex({
        templateKey,
        kind: "multiple_choice",
        ordinal: nextOrdinal(multipleChoiceOrdinals, choices.length),
        choiceCount: choices.length,
      });
      question.options = rotateToIndex(
        choices,
        previousAnswerIndex,
        targetAnswerIndex,
      );
      if (previousAnswerIndex !== targetAnswerIndex) {
        changes.push({
          questionNumber,
          kind: "multiple_choice",
          previousAnswerIndex,
          expectedAnswerIndex: targetAnswerIndex,
        });
      }
    }

    if (
      question.question_type === "fill_blank" &&
      question.evaluation_mode === "local_exact" &&
      typeof question.prompt === "string"
    ) {
      const bank = parseVisibleWordBank(question.prompt);
      if (!bank) continue;
      const previousAnswerIndex = answerIndex(
        bank.choices,
        question.correct_answer,
      );
      const targetAnswerIndex = expectedAnswerIndex({
        templateKey,
        kind: "word_bank",
        ordinal: nextOrdinal(wordBankOrdinals, bank.choices.length),
        choiceCount: bank.choices.length,
      });
      const choices = rotateToIndex(
        bank.choices,
        previousAnswerIndex,
        targetAnswerIndex,
      );
      question.prompt = changedPrompt(bank, choices);
      if (previousAnswerIndex !== targetAnswerIndex) {
        changes.push({
          questionNumber,
          kind: "word_bank",
          previousAnswerIndex,
          expectedAnswerIndex: targetAnswerIndex,
        });
      }
    }
  }

  return { worksheet, changes };
}

export function worksheetChoiceOrderErrors(value: unknown) {
  const original = asWorksheet(value);
  const templateKey = worksheetTemplateKey(original);
  const result = rebalanceWorksheetChoiceOrder(original);
  return result.changes.map(
    (change) =>
      `${templateKey}:Q${change.questionNumber} ${change.kind} canonical answer is at position ${change.previousAnswerIndex + 1}; deterministic launch order requires position ${change.expectedAnswerIndex + 1}.`,
  );
}

function worksheetChoicePositions(value: unknown) {
  const worksheet = asWorksheet(value);
  const templateKey = worksheetTemplateKey(worksheet);
  const positions: Array<{
    templateKey: string;
    kind: ChoiceKind;
    choiceCount: number;
    answerIndex: number;
  }> = [];

  for (const question of worksheetQuestions(worksheet)) {
    const questionNumber = Number(question.question_number);
    if (typeof question.correct_answer !== "string") {
      throw new Error(`${templateKey}:Q${questionNumber} needs correct_answer.`);
    }
    if (question.question_type === "multiple_choice") {
      if (!Array.isArray(question.options)) {
        throw new Error(`${templateKey}:Q${questionNumber} needs options.`);
      }
      const choices = question.options.map((option) => {
        if (typeof option !== "string") {
          throw new Error(
            `${templateKey}:Q${questionNumber} options must be strings.`,
          );
        }
        return option;
      });
      positions.push({
        templateKey,
        kind: "multiple_choice",
        choiceCount: choices.length,
        answerIndex: answerIndex(choices, question.correct_answer),
      });
      continue;
    }
    if (
      question.question_type === "fill_blank" &&
      question.evaluation_mode === "local_exact" &&
      typeof question.prompt === "string"
    ) {
      const bank = parseVisibleWordBank(question.prompt);
      if (!bank) continue;
      positions.push({
        templateKey,
        kind: "word_bank",
        choiceCount: bank.choices.length,
        answerIndex: answerIndex(bank.choices, question.correct_answer),
      });
    }
  }
  return positions;
}

export function choiceOrderDistribution(
  worksheets: readonly unknown[],
): ChoicePositionDistribution {
  const buckets = new Map<string, ChoicePositionBucket>();
  for (const worksheet of worksheets) {
    for (const position of worksheetChoicePositions(worksheet)) {
      const key = `${position.kind}:${position.choiceCount}`;
      const bucket = buckets.get(key) ?? {
        kind: position.kind,
        choiceCount: position.choiceCount,
        total: 0,
        positions: Array(position.choiceCount).fill(0) as number[],
      };
      bucket.total += 1;
      bucket.positions[position.answerIndex] += 1;
      buckets.set(key, bucket);
    }
  }

  const sortedBuckets = [...buckets.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.choiceCount - right.choiceCount,
  );
  const errors: string[] = [];
  for (const bucket of sortedBuckets) {
    // Tiny samples cannot prove a distribution. Once there are two complete
    // answer-position cycles, require every position to stay within 50% of the
    // uniform expectation. This catches first-option collapse without forcing
    // fragile exact counts for future additions to the worksheet bank.
    if (bucket.total < bucket.choiceCount * 2) continue;
    const expected = bucket.total / bucket.choiceCount;
    const minimum = Math.floor(expected * 0.5);
    const maximum = Math.ceil(expected * 1.5);
    if (
      bucket.positions.some(
        (count) => count < minimum || count > maximum,
      )
    ) {
      errors.push(
        `${bucket.kind} choices of size ${bucket.choiceCount} are position-collapsed: [${bucket.positions.join(
          ", ",
        )}] across ${bucket.total} questions; each position must stay between ${minimum} and ${maximum}.`,
      );
    }
  }
  return { ok: errors.length === 0, buckets: sortedBuckets, errors };
}

function findJsonStringEnd(raw: string, start: number) {
  if (raw[start] !== '"') throw new Error("Expected a JSON string.");
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") {
      index += 1;
      continue;
    }
    if (raw[index] === '"') return index + 1;
  }
  throw new Error("Unterminated JSON string.");
}

function findJsonArrayEnd(raw: string, start: number) {
  if (raw[start] !== "[") throw new Error("Expected a JSON array.");
  let depth = 0;
  let inString = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("Unterminated JSON array.");
}

function propertyValueStart(
  raw: string,
  sectionStart: number,
  sectionEnd: number,
  property: string,
) {
  const expression = new RegExp(`"${property}"\\s*:`,'g');
  expression.lastIndex = sectionStart;
  const match = expression.exec(raw);
  if (!match || match.index >= sectionEnd) {
    throw new Error(`Question section is missing ${property}.`);
  }
  let index = expression.lastIndex;
  while (/\s/u.test(raw[index] ?? "")) index += 1;
  return index;
}

function questionSections(raw: string) {
  const expression = /"question_number"\s*:\s*(\d+)/gu;
  const starts: Array<{ number: number; start: number }> = [];
  for (const match of raw.matchAll(expression)) {
    starts.push({ number: Number(match[1]), start: match.index ?? 0 });
  }
  return starts.map((entry, index) => ({
    ...entry,
    end: starts[index + 1]?.start ?? raw.length,
  }));
}

function formattedArrayLike(raw: string, start: number, values: string[]) {
  const end = findJsonArrayEnd(raw, start);
  const existing = raw.slice(start, end);
  if (!existing.includes("\n")) return JSON.stringify(values);
  const lineStart = raw.lastIndexOf("\n", start) + 1;
  const propertyIndent = raw.slice(lineStart, start).match(/^\s*/u)?.[0] ?? "";
  const itemIndent = `${propertyIndent}  `;
  return `[\n${itemIndent}${values
    .map((value) => JSON.stringify(value))
    .join(`,\n${itemIndent}`)}\n${propertyIndent}]`;
}

type RawEdit = { start: number; end: number; value: string };

export function applyRebalancedChoiceOrderToRaw(
  raw: string,
  originalValue: unknown,
  rebalancedValue: unknown,
) {
  const original = asWorksheet(originalValue);
  const rebalanced = asWorksheet(rebalancedValue);
  const originalQuestions = new Map(
    worksheetQuestions(original).map((question) => [
      Number(question.question_number),
      question,
    ]),
  );
  const rebalancedQuestions = new Map(
    worksheetQuestions(rebalanced).map((question) => [
      Number(question.question_number),
      question,
    ]),
  );
  const edits: RawEdit[] = [];

  for (const section of questionSections(raw)) {
    const before = originalQuestions.get(section.number);
    const after = rebalancedQuestions.get(section.number);
    if (!before || !after) continue;
    if (JSON.stringify(before.options) !== JSON.stringify(after.options)) {
      const start = propertyValueStart(
        raw,
        section.start,
        section.end,
        "options",
      );
      const end = findJsonArrayEnd(raw, start);
      edits.push({
        start,
        end,
        value: formattedArrayLike(
          raw,
          start,
          after.options as string[],
        ),
      });
    }
    if (before.prompt !== after.prompt) {
      const start = propertyValueStart(
        raw,
        section.start,
        section.end,
        "prompt",
      );
      const end = findJsonStringEnd(raw, start);
      edits.push({
        start,
        end,
        value: JSON.stringify(after.prompt),
      });
    }
  }

  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.value}${current.slice(edit.end)}`,
      raw,
    );
}

async function jsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return jsonFiles(path);
      return extname(entry.name) === ".json" ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

async function main(argv = process.argv.slice(2)) {
  const directoryFlag = argv.indexOf("--dir");
  const directory =
    directoryFlag >= 0
      ? resolve(argv[directoryFlag + 1] ?? "")
      : fileURLToPath(
          new URL("../../quality/worksheet-bank/drafts/", import.meta.url),
        );
  const write = argv.includes("--write");
  if (argv.some((arg) => !["--dir", "--write", "--check"].includes(arg)) && directoryFlag < 0) {
    throw new Error(
      "Usage: worksheet-choice-order --dir <draft-directory> [--check|--write]",
    );
  }
  const files = await jsonFiles(directory);
  let changedFiles = 0;
  let changedQuestions = 0;
  const errors: string[] = [];
  const inspectedWorksheets: unknown[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const beforeErrors = worksheetChoiceOrderErrors(parsed);
    if (beforeErrors.length > 0) {
      changedFiles += 1;
      changedQuestions += beforeErrors.length;
    }
    if (write && beforeErrors.length > 0) {
      const result = rebalanceWorksheetChoiceOrder(parsed);
      const rewritten = applyRebalancedChoiceOrderToRaw(
        raw,
        parsed,
        result.worksheet,
      );
      await writeFile(file, rewritten, "utf8");
      const verified = JSON.parse(await readFile(file, "utf8")) as unknown;
      errors.push(...worksheetChoiceOrderErrors(verified));
      inspectedWorksheets.push(verified);
    } else if (!write) {
      errors.push(...beforeErrors);
      inspectedWorksheets.push(parsed);
    } else {
      inspectedWorksheets.push(parsed);
    }
  }

  const distribution = choiceOrderDistribution(inspectedWorksheets);
  errors.push(...distribution.errors);

  const report = {
    ok: errors.length === 0,
    mode: write ? "write" : "check",
    files: files.length,
    changed_files: changedFiles,
    changed_questions: changedQuestions,
    distribution: distribution.buckets,
    errors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
