import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

type Level = "A1" | "A2" | "B1" | "B2";
type Difficulty = "easy" | "medium" | "hard";
type WorksheetSource = "manual_import" | "teacher_created";
type EvaluationMode = "local_exact" | "open_evaluation";

type MiniLesson = {
  short_explanation: string;
  key_rule: string;
  correct_examples: string[];
  common_mistake_warning: string;
  what_to_revise: string;
};

type ImportQuestion = {
  question_number: number;
  question_type: string;
  prompt: string;
  options: string[];
  correct_answer: string;
  explanation: string;
  evaluation_mode: EvaluationMode;
};

type WorksheetImport = {
  title: string;
  level: Level;
  grammar_topic: {
    slug?: string;
    name?: string;
  };
  difficulty: Difficulty;
  visibility: "workspace" | "private";
  source: WorksheetSource;
  source_label?: string;
  tags: string[];
  mini_lesson: MiniLesson;
  questions: ImportQuestion[];
};

type CliArgs = {
  file: string;
  workspaceId: string;
  createdBy: string | null;
  dryRun: boolean;
  linkedDb: boolean;
};

type TopicRow = {
  id: string;
  slug: string;
  name: string;
  level: string;
};

type PracticeTestRow = {
  id: string;
};

const levels = new Set(["A1", "A2", "B1", "B2"]);
const difficulties = new Set(["easy", "medium", "hard"]);
const sources = new Set(["manual_import", "teacher_created"]);
const localExactTypes = new Set([
  "multiple_choice",
  "fill_blank",
  "sentence_correction",
  "word_order",
  "transformation",
  "rewrite_sentence",
]);

function usage(): never {
  throw new Error([
    "Usage:",
    "  pnpm --dir scripts import:practice-worksheet -- --file <json> --workspace-id <uuid> [--created-by <profile-id>] [--dry-run]",
  ].join("\n"));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    file: "",
    workspaceId: "",
    createdBy: process.env.PRACTICE_IMPORT_CREATED_BY || null,
    dryRun: false,
    linkedDb: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--workspace-id") {
      args.workspaceId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--created-by") {
      args.createdBy = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--linked-db") {
      args.linkedDb = true;
      continue;
    }
    usage();
  }

  if (!args.file || !args.workspaceId) usage();
  return args;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, maxLength = 1000) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePromptKey(value: string) {
  return normalizeText(value).replace(/[_\W]+/g, "");
}

function normalizeQuestionType(value: unknown) {
  const raw = cleanString(value, 60).toLowerCase().replace(/[\s-]+/g, "_");
  return raw === "correction" ? "sentence_correction" : raw;
}

function containsForbiddenStudentText(value: string) {
  return /\b(deepseek|ai model|language model|chatgpt|answer key|scoring metadata|automatic ai correction)\b/i.test(value);
}

function normalizeForSequence(value: string) {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}äöüß]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskFillBlankPrompt(prompt: string) {
  return prompt
    .replace(/_{2,}|\[blank\]|\(\s*blank\s*\)/gi, " ")
    .replace(/\s+/g, " ");
}

function promptContainsExactAnswer(prompt: string, correctAnswer: string) {
  const normalizedPrompt = normalizeForSequence(maskFillBlankPrompt(prompt));
  const normalizedAnswer = normalizeForSequence(correctAnswer);
  if (!normalizedPrompt || !normalizedAnswer) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(normalizedAnswer)}(\\s|$)`, "u").test(normalizedPrompt);
}

function extractWordOrderChunks(prompt: string) {
  if (!prompt.includes("/")) return [];
  return prompt
    .split("/")
    .map((chunk, index) => {
      const withoutLeadIn = index === 0 ? chunk.replace(/^.*:/, "") : chunk;
      return withoutLeadIn
        .replace(/[.!?]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter(Boolean);
}

function assertNoForbiddenText(label: string, values: string[]) {
  const combined = values.join(" ");
  if (containsForbiddenStudentText(combined)) {
    throw new Error(`${label} contains forbidden student-facing internal text.`);
  }
}

function validateMiniLesson(value: unknown): MiniLesson {
  const record = asRecord(value, "mini_lesson");
  const miniLesson = {
    short_explanation: cleanString(record.short_explanation, 500),
    key_rule: cleanString(record.key_rule, 400),
    correct_examples: Array.isArray(record.correct_examples)
      ? record.correct_examples.map((example) => cleanString(example, 180)).filter(Boolean).slice(0, 2)
      : [],
    common_mistake_warning: cleanString(record.common_mistake_warning, 300),
    what_to_revise: cleanString(record.what_to_revise, 300),
  };

  if (!miniLesson.short_explanation || !miniLesson.key_rule || miniLesson.correct_examples.length === 0) {
    throw new Error("mini_lesson must include short_explanation, key_rule, and at least one correct example.");
  }
  assertNoForbiddenText("mini_lesson", [
    miniLesson.short_explanation,
    miniLesson.key_rule,
    ...miniLesson.correct_examples,
    miniLesson.common_mistake_warning,
    miniLesson.what_to_revise,
  ]);
  return miniLesson;
}

function validateOptions(value: unknown, questionNumber: number) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Question ${questionNumber}: options must be an array of plain strings.`);
  }
  const options = value.map((option) => {
    if (typeof option !== "string") {
      throw new Error(`Question ${questionNumber}: options must not contain objects or hidden metadata.`);
    }
    const cleaned = cleanString(option, 160);
    if (!cleaned) throw new Error(`Question ${questionNumber}: options must not contain blank strings.`);
    return cleaned;
  });
  if (new Set(options.map(normalizeText)).size !== options.length) {
    throw new Error(`Question ${questionNumber}: options must not be duplicated.`);
  }
  assertNoForbiddenText(`Question ${questionNumber} options`, options);
  return options;
}

function validateLocalExactQuestion(question: ImportQuestion) {
  if (!localExactTypes.has(question.question_type)) {
    throw new Error(`Question ${question.question_number}: ${question.question_type} is not a local_exact question type.`);
  }
  if (!question.correct_answer) {
    throw new Error(`Question ${question.question_number}: local_exact questions need a correct_answer.`);
  }

  if (question.question_type === "multiple_choice") {
    if (question.options.length < 3 || question.options.length > 6) {
      throw new Error(`Question ${question.question_number}: multiple_choice needs 3-6 options.`);
    }
    const matchCount = question.options
      .map(normalizeText)
      .filter((option) => option === normalizeText(question.correct_answer)).length;
    if (matchCount !== 1) {
      throw new Error(`Question ${question.question_number}: multiple_choice correct answer must appear exactly once.`);
    }
  }

  if (question.question_type === "fill_blank") {
    const blankCount = (question.prompt.match(/_{2,}|\[blank\]|\(\s*blank\s*\)/gi) ?? []).length;
    if (blankCount !== 1) {
      throw new Error(`Question ${question.question_number}: fill_blank must include exactly one blank.`);
    }
    if (/\b_{2,}\s*[\[(]\s*(der|den|dem|des|die|das|ein|eine|einen|einem|einer|eines|kein|keine|keinen|keinem|keiner|keines)\s*[\])]/i.test(question.prompt)) {
      throw new Error(`Question ${question.question_number}: fill_blank leaks an article answer in parentheses.`);
    }
    if (promptContainsExactAnswer(question.prompt, question.correct_answer)) {
      throw new Error(`Question ${question.question_number}: fill_blank prompt contains the correct answer.`);
    }
  }

  if (question.question_type === "word_order") {
    const chunks = extractWordOrderChunks(question.prompt);
    if (chunks.length < 6) {
      throw new Error(`Question ${question.question_number}: word_order needs at least 6 meaningful chunks.`);
    }
    if (/\b(starting with|starts with|begin with|begins with|start sentence with|fang.*an|beginn.*mit)\b/i.test(question.prompt)) {
      throw new Error(`Question ${question.question_number}: word_order must not include a starting hint.`);
    }
    if (normalizeForSequence(chunks.join(" ")) === normalizeForSequence(question.correct_answer)) {
      throw new Error(`Question ${question.question_number}: word_order chunks are already in final order.`);
    }
  }
}

function validateQuestion(value: unknown, index: number): ImportQuestion {
  const record = asRecord(value, `questions[${index}]`);
  const questionNumber = Number(record.question_number ?? index + 1);
  if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
    throw new Error(`Question ${index + 1}: question_number must be a positive integer.`);
  }

  const question = {
    question_number: questionNumber,
    question_type: normalizeQuestionType(record.question_type ?? record.type),
    prompt: cleanString(record.prompt, 800),
    options: validateOptions(record.options, questionNumber),
    correct_answer: cleanString(record.correct_answer ?? record.answer_key ?? record.answer, 500),
    explanation: cleanString(record.explanation, 600),
    evaluation_mode: cleanString(record.evaluation_mode, 40) as EvaluationMode,
  };

  if (!question.prompt || question.prompt.length < 12) {
    throw new Error(`Question ${question.question_number}: prompt is too short.`);
  }
  if (!question.explanation) {
    throw new Error(`Question ${question.question_number}: explanation is required.`);
  }
  assertNoForbiddenText(`Question ${question.question_number}`, [
    question.prompt,
    question.explanation,
    ...question.options,
  ]);

  if (question.evaluation_mode === "local_exact") {
    validateLocalExactQuestion(question);
  } else if (question.evaluation_mode === "open_evaluation") {
    if (!["fill_blank", "sentence_correction", "transformation", "rewrite_sentence", "mini_writing"].includes(question.question_type)) {
      throw new Error(`Question ${question.question_number}: ${question.question_type} cannot use open_evaluation.`);
    }
    if (question.question_type === "mini_writing" && question.correct_answer !== "manual_review") {
      throw new Error(`Question ${question.question_number}: mini_writing imports should use correct_answer = "manual_review".`);
    }
    if (question.question_type !== "mini_writing" && question.correct_answer === "manual_review") {
      throw new Error(`Question ${question.question_number}: open text imports need a canonical/sample answer unless they are mini_writing.`);
    }
  } else {
    throw new Error(`Question ${question.question_number}: evaluation_mode must be local_exact or open_evaluation.`);
  }

  return question;
}

function validateWorksheet(value: unknown): WorksheetImport {
  const record = asRecord(value, "worksheet");
  const topic = asRecord(record.grammar_topic, "grammar_topic");
  const level = cleanString(record.level, 2);
  const difficulty = cleanString(record.difficulty, 12);
  const source = cleanString(record.source, 40);
  const visibility = cleanString(record.visibility, 20) || "workspace";

  if (!levels.has(level)) throw new Error("level must be A1, A2, B1, or B2.");
  if (!difficulties.has(difficulty)) throw new Error("difficulty must be easy, medium, or hard.");
  if (!sources.has(source)) throw new Error("source must be manual_import or teacher_created.");
  if (!["workspace", "private"].includes(visibility)) {
    throw new Error("visibility must be workspace or private in the current schema.");
  }

  const worksheet = {
    title: cleanString(record.title, 120),
    level: level as Level,
    grammar_topic: {
      slug: cleanString(topic.slug, 80) || undefined,
      name: cleanString(topic.name, 120) || undefined,
    },
    difficulty: difficulty as Difficulty,
    visibility: visibility as "workspace" | "private",
    source: source as WorksheetSource,
    source_label: cleanString(record.source_label, 120) || undefined,
    tags: Array.isArray(record.tags) ? record.tags.map((tag) => cleanString(tag, 60)).filter(Boolean).slice(0, 20) : [],
    mini_lesson: validateMiniLesson(record.mini_lesson),
    questions: Array.isArray(record.questions)
      ? record.questions.map(validateQuestion)
      : [],
  };

  if (!worksheet.title) throw new Error("title is required.");
  if (!worksheet.grammar_topic.slug && !worksheet.grammar_topic.name) {
    throw new Error("grammar_topic.slug or grammar_topic.name is required.");
  }
  if (worksheet.questions.length < 2 || worksheet.questions.length > 20) {
    throw new Error("question count must be between 2 and 20.");
  }
  if (new Set(worksheet.questions.map((question) => question.question_number)).size !== worksheet.questions.length) {
    throw new Error("question_number values must be unique.");
  }
  const promptKeys = worksheet.questions.map((question) => normalizePromptKey(question.prompt));
  if (new Set(promptKeys).size !== promptKeys.length) {
    throw new Error("question prompts must not be duplicated.");
  }
  assertNoForbiddenText("worksheet", [worksheet.title]);
  return worksheet;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sqlLiteral(value: string | null) {
  if (value === null) return "null";
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.includes("$worksheet_json$")) {
    throw new Error("Import JSON contains a reserved SQL delimiter.");
  }
  return `$worksheet_json$${serialized}$worksheet_json$::jsonb`;
}

function buildLinkedDbSql(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  createdBy: string | null;
}) {
  const worksheetJson = sqlJson(args.worksheet);
  const sourceLabel = args.worksheet.source_label ?? null;
  const tags = args.worksheet.tags.join(",");
  return `
do $worksheet_import$
declare
  import_doc jsonb := ${worksheetJson};
  selected_topic_id uuid;
  saved_test_id uuid;
  requested_slug text := nullif(import_doc #>> '{grammar_topic,slug}', '');
  requested_name text := nullif(import_doc #>> '{grammar_topic,name}', '');
  target_workspace_id uuid := ${sqlLiteral(args.workspaceId)}::uuid;
  target_created_by uuid := ${args.createdBy ? `${sqlLiteral(args.createdBy)}::uuid` : "null"};
begin
  select gt.id
  into selected_topic_id
  from public.grammar_topics gt
  where (requested_slug is not null and lower(gt.slug) = lower(requested_slug))
     or (requested_name is not null and lower(gt.name) = lower(requested_name))
  order by
    case when gt.level = import_doc->>'level' then 0 when gt.level = 'A1_A2' then 1 else 2 end,
    gt.created_at asc
  limit 1;

  if selected_topic_id is null then
    raise exception 'No grammar topic matched worksheet import slug/name.';
  end if;

  select pt.id
  into saved_test_id
  from public.practice_tests pt
  where pt.workspace_id = target_workspace_id
    and pt.grammar_topic_id = selected_topic_id
    and pt.level = import_doc->>'level'
    and pt.title = import_doc->>'title'
    and pt.generation_source = import_doc->>'source'
  order by pt.created_at desc
  limit 1;

  if saved_test_id is null then
    insert into public.practice_tests (
      workspace_id,
      grammar_topic_id,
      level,
      difficulty,
      title,
      description,
      created_by_ai,
      teacher_reviewed,
      visibility,
      created_by,
      mini_lesson,
      generation_source,
      quality_status,
      quality_notes,
      reviewed_by,
      reviewed_at
    )
    values (
      target_workspace_id,
      selected_topic_id,
      import_doc->>'level',
      import_doc->>'difficulty',
      import_doc->>'title',
      import_doc #>> '{mini_lesson,short_explanation}',
      false,
      true,
      import_doc->>'visibility',
      target_created_by,
      import_doc->'mini_lesson',
      import_doc->>'source',
      'approved',
      concat_ws('; ', ${sqlLiteral(sourceLabel)}::text, ${sqlLiteral(tags)}::text, 'validated_by=practice-worksheet-import'),
      target_created_by,
      now()
    )
    returning id into saved_test_id;
  else
    update public.practice_tests
    set
      difficulty = import_doc->>'difficulty',
      description = import_doc #>> '{mini_lesson,short_explanation}',
      created_by_ai = false,
      teacher_reviewed = true,
      visibility = import_doc->>'visibility',
      created_by = target_created_by,
      updated_at = now(),
      mini_lesson = import_doc->'mini_lesson',
      quality_status = 'approved',
      quality_notes = concat_ws('; ', ${sqlLiteral(sourceLabel)}::text, ${sqlLiteral(tags)}::text, 'validated_by=practice-worksheet-import'),
      reviewed_by = target_created_by,
      reviewed_at = now()
    where id = saved_test_id;

    delete from public.practice_test_questions
    where practice_test_id = saved_test_id;
  end if;

  insert into public.practice_test_questions (
    practice_test_id,
    question_number,
    question_type,
    evaluation_mode,
    prompt,
    options,
    correct_answer,
    explanation
  )
  select
    saved_test_id,
    (question->>'question_number')::integer,
    question->>'question_type',
    coalesce(question->>'evaluation_mode', 'local_exact'),
    question->>'prompt',
    case
      when jsonb_array_length(coalesce(question->'options', '[]'::jsonb)) > 0 then question->'options'
      else null
    end,
    question->>'correct_answer',
    question->>'explanation'
  from jsonb_array_elements(import_doc->'questions') as question
  order by (question->>'question_number')::integer;
end
$worksheet_import$;

select
  pt.id as practice_test_id,
  pt.title,
  gt.name as grammar_topic_name,
  pt.level,
  pt.generation_source,
  pt.quality_status,
  count(ptq.id)::integer as question_count
from public.practice_tests pt
join public.grammar_topics gt on gt.id = pt.grammar_topic_id
left join public.practice_test_questions ptq on ptq.practice_test_id = pt.id
where pt.workspace_id = ${sqlLiteral(args.workspaceId)}::uuid
  and pt.title = ${sqlLiteral(args.worksheet.title)}
  and pt.generation_source = ${sqlLiteral(args.worksheet.source)}
group by pt.id, gt.name
order by pt.created_at desc
limit 1;
`.trim();
}

function runLinkedDbImport(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  createdBy: string | null;
}) {
  const sql = buildLinkedDbSql(args);
  const pnpm = process.env.PNPM_BIN || "pnpm";
  const result = spawnSync(pnpm, ["dlx", "supabase", "db", "query", "--linked", sql], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`supabase db query failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function getRestConfig() {
  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    restUrl: `${supabaseUrl}/rest/v1`,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
  };
}

async function requestJson<T>(
  path: string,
  options: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
    prefer?: string;
  } = {},
) {
  const config = getRestConfig();
  const url = new URL(`${config.restUrl}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...config.headers,
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function pickTopic(candidates: TopicRow[], worksheet: WorksheetImport) {
  const requestedSlug = worksheet.grammar_topic.slug ? normalizeText(worksheet.grammar_topic.slug) : "";
  const requestedName = worksheet.grammar_topic.name ? normalizeText(worksheet.grammar_topic.name) : "";
  const compatible = candidates.filter((topic) => topic.level === worksheet.level || topic.level === "A1_A2");
  const pool = compatible.length > 0 ? compatible : candidates;
  const exactSlug = pool.find((topic) => requestedSlug && normalizeText(topic.slug) === requestedSlug);
  if (exactSlug) return exactSlug;
  const exactName = pool.find((topic) => requestedName && normalizeText(topic.name) === requestedName);
  if (exactName) return exactName;
  return pool[0] ?? null;
}

async function findGrammarTopic(worksheet: WorksheetImport) {
  const orFilters = [];
  if (worksheet.grammar_topic.slug) orFilters.push(`slug.eq.${worksheet.grammar_topic.slug}`);
  if (worksheet.grammar_topic.name) orFilters.push(`name.eq.${worksheet.grammar_topic.name}`);
  const candidates = await requestJson<TopicRow[]>("grammar_topics", {
    query: {
      select: "id,slug,name,level",
      or: `(${orFilters.join(",")})`,
      limit: "10",
    },
  });
  const topic = pickTopic(candidates ?? [], worksheet);
  if (!topic) {
    throw new Error(`No grammar topic matched ${worksheet.grammar_topic.slug ?? worksheet.grammar_topic.name}.`);
  }
  return topic;
}

async function findExistingWorksheet(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  grammarTopicId: string;
}) {
  const rows = await requestJson<PracticeTestRow[]>("practice_tests", {
    query: {
      select: "id",
      workspace_id: `eq.${args.workspaceId}`,
      grammar_topic_id: `eq.${args.grammarTopicId}`,
      level: `eq.${args.worksheet.level}`,
      title: `eq.${args.worksheet.title}`,
      generation_source: `eq.${args.worksheet.source}`,
      limit: "1",
    },
  });
  return rows?.[0]?.id ?? null;
}

function buildQualityNotes(worksheet: WorksheetImport) {
  const parts = [
    worksheet.source_label ? `source_label=${worksheet.source_label}` : null,
    worksheet.tags.length > 0 ? `tags=${worksheet.tags.join(",")}` : null,
    `questions=${worksheet.questions.length}`,
    "validated_by=practice-worksheet-import",
  ].filter(Boolean);
  return parts.join("; ");
}

async function upsertWorksheet(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  createdBy: string | null;
  topic: TopicRow;
}) {
  const now = new Date().toISOString();
  const existingId = await findExistingWorksheet({
    worksheet: args.worksheet,
    workspaceId: args.workspaceId,
    grammarTopicId: args.topic.id,
  });
  const worksheetRow = {
    workspace_id: args.workspaceId,
    grammar_topic_id: args.topic.id,
    level: args.worksheet.level,
    difficulty: args.worksheet.difficulty,
    title: args.worksheet.title,
    description: args.worksheet.mini_lesson.short_explanation,
    created_by_ai: false,
    teacher_reviewed: true,
    visibility: args.worksheet.visibility,
    created_by: args.createdBy,
    updated_at: now,
    mini_lesson: args.worksheet.mini_lesson,
    generation_source: args.worksheet.source,
    quality_status: "approved",
    quality_notes: buildQualityNotes(args.worksheet),
    reviewed_by: args.createdBy,
    reviewed_at: now,
  };

  const savedRows = existingId
    ? await requestJson<PracticeTestRow[]>("practice_tests", {
      method: "PATCH",
      query: { id: `eq.${existingId}`, select: "id" },
      body: worksheetRow,
      prefer: "return=representation",
    })
    : await requestJson<PracticeTestRow[]>("practice_tests", {
      method: "POST",
      query: { select: "id" },
      body: worksheetRow,
      prefer: "return=representation",
    });
  const practiceTestId = savedRows?.[0]?.id;
  if (!practiceTestId) throw new Error("Worksheet upsert returned no practice_test id.");

  if (existingId) {
    await requestJson<null>("practice_test_questions", {
      method: "DELETE",
      query: { practice_test_id: `eq.${practiceTestId}` },
    });
  }

  await requestJson<unknown>("practice_test_questions", {
    method: "POST",
    body: args.worksheet.questions
      .sort((left, right) => left.question_number - right.question_number)
      .map((question) => ({
        practice_test_id: practiceTestId,
        question_number: question.question_number,
        question_type: question.question_type,
        evaluation_mode: question.evaluation_mode,
        prompt: question.prompt,
        options: question.options.length > 0 ? question.options : null,
        correct_answer: question.correct_answer,
        explanation: question.explanation,
      })),
  });

  return practiceTestId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawJson = await readFile(args.file, "utf8");
  const worksheet = validateWorksheet(JSON.parse(rawJson));

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      title: worksheet.title,
      level: worksheet.level,
      source: worksheet.source,
      question_count: worksheet.questions.length,
    }, null, 2));
    return;
  }

  if (args.linkedDb) {
    runLinkedDbImport({
      worksheet,
      workspaceId: args.workspaceId,
      createdBy: args.createdBy,
    });
    return;
  }

  const topic = await findGrammarTopic(worksheet);
  const practiceTestId = await upsertWorksheet({
    worksheet,
    workspaceId: args.workspaceId,
    createdBy: args.createdBy,
    topic,
  });

  console.log(JSON.stringify({
    ok: true,
    practice_test_id: practiceTestId,
    title: worksheet.title,
    grammar_topic_id: topic.id,
    grammar_topic_name: topic.name,
    level: worksheet.level,
    source: worksheet.source,
    question_count: worksheet.questions.length,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Practice worksheet import failed.";
  console.error(message);
  process.exitCode = 1;
});
