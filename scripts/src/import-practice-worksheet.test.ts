import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCertifiedWorksheetMatrixIdentity,
  assertWorksheetArtifactEligibleForWrite,
  buildCertifiedBankLinkedDbSql,
  buildLinkedDbSql,
  main,
  validateBankCertification,
  validateWorksheet,
} from "./import-practice-worksheet";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workspaceId = "00000000-0000-4000-8000-000000000001";
const reviewerId = "00000000-0000-4000-8000-000000000002";
const draftWorksheetPath = resolve(
  repositoryRoot,
  "quality/worksheet-bank/drafts/a1/v1-a1-capitalization-r1.json",
);

function baseWorksheet() {
  return {
    title: "A2 Import Contract Test",
    level: "A2",
    grammar_topic: { slug: "prepositions", name: "Prepositions" },
    difficulty: "medium",
    visibility: "workspace",
    source: "manual_import",
    source_label: "Importer regression",
    tags: ["a2", "contract"],
    mini_lesson: {
      short_explanation: "Prepositions often belong to fixed German phrases.",
      key_rule: "Learn the preposition together with its phrase and case.",
      correct_examples: ["Ich warte auf den Bus."],
      common_mistake_warning: "Do not translate prepositions word for word.",
      what_to_revise: "Review common prepositional phrases.",
    },
    questions: [
      {
        question_number: 1,
        question_type: "multiple_choice",
        prompt: "Choose the correct option: Ich warte ___ den Bus.",
        options: ["auf", "mit", "bei"],
        correct_answer: "auf",
        explanation: "The fixed phrase is auf den Bus warten.",
        evaluation_mode: "local_exact",
      },
      {
        question_number: 2,
        question_type: "fill_blank",
        prompt:
          "Use the closed word bank [mit, bei, für]. Complete: Wir fahren ___ dem Zug.",
        options: [],
        correct_answer: "mit",
        accepted_answers: ["mit"],
        explanation: "Use mit for a means of transport.",
        evaluation_mode: "local_exact",
      },
      {
        question_number: 3,
        question_type: "sentence_correction",
        prompt: "Correct this sentence: Ich warte für den Bus.",
        options: [],
        correct_answer: "Ich warte auf den Bus.",
        rubric: {
          criteria: [
            "Replace für with auf.",
            "Preserve the intended meaning in a grammatical sentence.",
          ],
          sample_answer: "Ich warte auf den Bus.",
        },
        explanation: "Warten takes auf in this phrase.",
        evaluation_mode: "open_evaluation",
      },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bankCertification() {
  return {
    review_checklist: {
      structural_valid: true,
      ambiguity_free: true,
      no_answer_leakage: true,
      level_fit: true,
      topic_fit: true,
      type_balance: true,
      scoring_safe: true,
    },
    review_notes:
      "Qualified German-language reviewer confirmed the worksheet quality.",
    release_notes:
      "Qualified release controller approved this exact immutable revision.",
  };
}

test("normalizes the complete V1 answer contract", () => {
  const worksheet = validateWorksheet(baseWorksheet());

  assert.deepEqual(worksheet.questions[0].accepted_answers, ["auf"]);
  assert.deepEqual(worksheet.questions[1].accepted_answers, ["mit"]);
  assert.equal(
    worksheet.questions[2].rubric?.sample_answer,
    "Ich warte auf den Bus.",
  );
  assert.ok(
    worksheet.questions.every(
      (question) => question.answer_contract_version === 1,
    ),
  );
});

test("allows local exact scoring only for multiple choice and constrained fills", () => {
  for (const questionType of [
    "sentence_correction",
    "word_order",
    "transformation",
    "rewrite_sentence",
    "mini_writing",
  ]) {
    const input = baseWorksheet();
    input.questions[2] = {
      ...input.questions[2],
      question_type: questionType,
      evaluation_mode: "local_exact",
      rubric: undefined,
    };
    assert.throws(
      () => validateWorksheet(input),
      new RegExp(`${questionType} is not a local_exact question type`),
    );
  }
});

test("requires a complete, normalized accepted-answer set for exact fills", () => {
  const missing = baseWorksheet();
  delete missing.questions[1].accepted_answers;
  assert.throws(
    () => validateWorksheet(missing),
    /accepted_answers is required/,
  );

  const duplicated = baseWorksheet();
  duplicated.questions[1].accepted_answers = ["mit", " MIT "];
  assert.throws(
    () => validateWorksheet(duplicated),
    /unique after normalization/,
  );

  const missingCanonical = baseWorksheet();
  missingCanonical.questions[1].accepted_answers = ["bei"];
  assert.throws(
    () => validateWorksheet(missingCanonical),
    /must contain the canonical correct_answer/,
  );
});

test("rejects unconstrained or malformed exact fill prompts", () => {
  const generic = baseWorksheet();
  generic.questions[1].prompt =
    "Complete with one preposition: Wir fahren ___ dem Zug.";
  assert.throws(
    () => validateWorksheet(generic),
    /must name an article\/base-form constraint or provide a closed word bank/,
  );

  const missingFromBank = baseWorksheet();
  missingFromBank.questions[1].prompt =
    "Use the closed word bank [bei, für, ohne]. Complete: Wir fahren ___ dem Zug.";
  assert.throws(
    () => validateWorksheet(missingFromBank),
    /provide a closed word bank containing every accepted answer/,
  );

  const leakedAnswer = baseWorksheet();
  leakedAnswer.questions[1].prompt =
    "Use the closed word bank [mit, bei, für]. Complete: Wir fahren ___ (mit) dem Zug.";
  assert.throws(
    () => validateWorksheet(leakedAnswer),
    /leaks an accepted answer next to the blank/,
  );

  for (const marker of ["____", "[blank]", "___ and ___"]) {
    const malformed = baseWorksheet();
    malformed.questions[1].prompt = `Use the closed word bank [mit, bei, für]. Complete: Wir fahren ${marker} dem Zug.`;
    assert.throws(() => validateWorksheet(malformed), /exactly one ___ marker/);
  }
});

test("requires a real rubric and sample answer for every semantic question", () => {
  const missingRubric = baseWorksheet();
  delete missingRubric.questions[2].rubric;
  assert.throws(
    () => validateWorksheet(missingRubric),
    /rubric must be an object/,
  );

  const sentinel = baseWorksheet();
  sentinel.questions[2].correct_answer = "manual_review";
  sentinel.questions[2].rubric = {
    criteria: ["Use the target structure."],
    sample_answer: "manual_review",
  };
  assert.throws(() => validateWorksheet(sentinel), /manual-review sentinel/);

  const mismatchedSample = baseWorksheet();
  mismatchedSample.questions[2].rubric = {
    criteria: ["Use the target structure."],
    sample_answer: "Ich fahre mit dem Bus.",
  };
  assert.throws(
    () => validateWorksheet(mismatchedSample),
    /must describe the same canonical sample/,
  );

  const acceptedAnswersOnOpen = baseWorksheet();
  acceptedAnswersOnOpen.questions[2].accepted_answers = [
    "Ich warte auf den Bus.",
  ];
  assert.throws(
    () => validateWorksheet(acceptedAnswersOnOpen),
    /must use rubric criteria, not accepted_answers/,
  );

  const sentinelInPrompt = baseWorksheet();
  sentinelInPrompt.questions[2].prompt =
    "Write manual_review for this sentence correction task.";
  assert.throws(
    () => validateWorksheet(sentinelInPrompt),
    /forbidden student-facing internal text/,
  );

  const answerMetadata = baseWorksheet();
  answerMetadata.questions[2].correct_answer = {
    text: "Ich warte auf den Bus.",
  } as unknown as string;
  assert.throws(
    () => validateWorksheet(answerMetadata),
    /correct_answer must be a plain string/,
  );
});

test("enforces the maximum of three semantic questions", () => {
  const input = baseWorksheet();
  const semanticTemplate = input.questions[2];
  input.questions = [
    input.questions[0],
    input.questions[1],
    ...[0, 1, 2, 3].map((offset) => ({
      ...clone(semanticTemplate),
      question_number: offset + 3,
      prompt: `Correct sentence ${offset + 1}: Ich warte für den Bus.`,
    })),
  ];
  assert.throws(
    () => validateWorksheet(input),
    /at most 3 open_evaluation questions/,
  );
});

test("requires exact, explicit human certification metadata for bank publication", () => {
  const valid = validateBankCertification({
    ...baseWorksheet(),
    bank_certification: bankCertification(),
  });
  assert.equal(valid.review_checklist.scoring_safe, true);
  assert.match(valid.review_notes, /Qualified German-language reviewer/);

  const incomplete = bankCertification();
  delete (
    incomplete.review_checklist as Partial<typeof incomplete.review_checklist>
  ).topic_fit;
  assert.throws(
    () =>
      validateBankCertification({
        ...baseWorksheet(),
        bank_certification: incomplete,
      }),
    /exactly the seven required checks/,
  );

  const fabricated = {
    ...bankCertification(),
    review_checklist: {
      ...bankCertification().review_checklist,
      scoring_safe: false,
    },
  };
  assert.throws(
    () =>
      validateBankCertification({
        ...baseWorksheet(),
        bank_certification: fabricated,
      }),
    /all explicitly true/,
  );
});

test("refuses every explicit unapproved lifecycle status before a real write", () => {
  const statusCases = [
    ["authoring_status", "draft_unapproved"],
    ["certification_status", "not-certified"],
    ["approval_status", "UNAPPROVED"],
  ] as const;

  for (const [key, value] of statusCases) {
    assert.throws(
      () =>
        assertWorksheetArtifactEligibleForWrite({
          draft_metadata: { [key]: value },
        }),
      new RegExp(`worksheet\\.draft_metadata\\.${key} is`),
    );
  }

  assert.doesNotThrow(() =>
    assertWorksheetArtifactEligibleForWrite({
      release_metadata: {
        authoring_status: "reviewed",
        certification_status: "certified",
        approval_status: "approved",
      },
    }),
  );
});

test("rejects draft provenance that remains after lifecycle metadata is removed", () => {
  for (const artifact of [
    {
      source_label: "V1 A2 draft worksheet; unapproved and not certified",
    },
    { tags: ["a2", "prepositions", "draft"] },
    { tags: ["a2", "prepositions", "not-certified"] },
    { provenance: "Previously unapproved worksheet source" },
    {
      draft_metadata: {
        authoring_status: "reviewed",
        certification_status: "certified",
        approval_status: "approved",
      },
    },
  ]) {
    assert.throws(
      () => assertWorksheetArtifactEligibleForWrite(artifact),
      /not eligible for import or publication/,
    );
  }

  assert.doesNotThrow(() =>
    assertWorksheetArtifactEligibleForWrite({
      source_label: "Qualified launch-bank release",
      tags: ["a2", "prepositions", "certified"],
      release_metadata: {
        certification_status: "certified",
        approval_status: "approved",
      },
    }),
  );
});

test("binds certified publication to the exact matrix template, level, and topic", () => {
  const worksheet = validateWorksheet(baseWorksheet());

  assert.doesNotThrow(() =>
    assertCertifiedWorksheetMatrixIdentity({
      worksheet,
      templateKey: "v1-a2-prepositions-r1",
    }),
  );
  assert.throws(
    () =>
      assertCertifiedWorksheetMatrixIdentity({
        worksheet,
        templateKey: "v1-a2-prepositions-r99",
      }),
    /is not present in quality\/worksheet-bank\/authoring-matrix\.json/,
  );
  assert.throws(
    () =>
      assertCertifiedWorksheetMatrixIdentity({
        worksheet,
        templateKey: "v1-a1-prepositions-r1",
      }),
    /requires level A1 and grammar_topic\.slug "prepositions"/,
  );

  const wrongTopic = clone(worksheet);
  wrongTopic.grammar_topic.slug = "articles";
  assert.throws(
    () =>
      assertCertifiedWorksheetMatrixIdentity({
        worksheet: wrongTopic,
        templateKey: "v1-a2-prepositions-r1",
      }),
    /received level A2 and grammar_topic\.slug "articles"/,
  );

  const missingSlug = clone(worksheet);
  delete missingSlug.grammar_topic.slug;
  assert.throws(
    () =>
      assertCertifiedWorksheetMatrixIdentity({
        worksheet: missingSlug,
        templateKey: "v1-a2-prepositions-r1",
      }),
    /grammar_topic\.slug null/,
  );

  const missingProvenance = clone(worksheet);
  delete missingProvenance.source_label;
  assert.throws(
    () =>
      assertCertifiedWorksheetMatrixIdentity({
        worksheet: missingProvenance,
        templateKey: "v1-a2-prepositions-r1",
      }),
    /requires a release-safe source_label/,
  );
});

test("allows draft structural validation only in dry-run mode", async () => {
  const result = spawnSync(
    process.env.PNPM_BIN || "pnpm",
    [
      "--dir",
      "scripts",
      "import:practice-worksheet",
      "--file",
      draftWorksheetPath,
      "--workspace-id",
      workspaceId,
      "--dry-run",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"dry_run": true/);
  assert.match(result.stdout, /"approval_recorded": false/);
});

test("blocks an unapproved draft from workspace import and bank publication", async () => {
  await assert.rejects(
    main([
      "--file",
      draftWorksheetPath,
      "--workspace-id",
      workspaceId,
      "--created-by",
      reviewerId,
      "--linked-db",
    ]),
    /not eligible for import or publication: worksheet\.draft_metadata\.authoring_status is "draft_unapproved"/,
  );

  await assert.rejects(
    main([
      "--file",
      draftWorksheetPath,
      "--workspace-id",
      workspaceId,
      "--publish-to-bank",
      "--template-key",
      "v1-a1-capitalization-r1",
      "--bank-reviewed-by",
      reviewerId,
      "--bank-released-by",
      "00000000-0000-4000-8000-000000000003",
      "--linked-db",
    ]),
    /not eligible for import or publication: worksheet\.draft_metadata\.authoring_status is "draft_unapproved"/,
  );
});

test("builds one atomic certified publication and verified workspace clone", () => {
  const worksheet = validateWorksheet(baseWorksheet());
  const certification = validateBankCertification({
    ...baseWorksheet(),
    bank_certification: bankCertification(),
  });
  const sql = buildCertifiedBankLinkedDbSql({
    worksheet,
    certification,
    workspaceId,
    templateKey: "v1-a2-prepositions-r1",
    reviewedBy: reviewerId,
    releasedBy: "00000000-0000-4000-8000-000000000003",
  });

  assert.match(sql, /^with published as materialized \(/);
  assert.match(sql, /app_private\.publish_certified_worksheet_template\(/);
  assert.match(sql, /app_private\.clone_released_worksheet_template\(/);
  assert.match(sql, /cloned_content_sha256/);
  assert.equal(
    (sql.match(/publish_certified_worksheet_template\(/g) ?? []).length,
    1,
  );
  assert.equal(
    (sql.match(/clone_released_worksheet_template\(/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(sql, /insert into|update\s+public\.|delete from/i);

  assert.throws(
    () =>
      buildCertifiedBankLinkedDbSql({
        worksheet,
        certification,
        workspaceId,
        templateKey: "v1-a2-prepositions-r99",
        reviewedBy: reviewerId,
        releasedBy: "00000000-0000-4000-8000-000000000003",
      }),
    /is not present in quality\/worksheet-bank\/authoring-matrix\.json/,
  );

  assert.equal(
    sql,
    buildCertifiedBankLinkedDbSql({
      worksheet,
      certification,
      workspaceId,
      templateKey: "v1-a2-prepositions-r1",
      reviewedBy: reviewerId,
      releasedBy: "00000000-0000-4000-8000-000000000003",
    }),
  );
});

test("bank publication CLI refuses implicit reviewers, releasers, or approval", async () => {
  await assert.rejects(
    main([
      "--file",
      "../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json",
      "--workspace-id",
      workspaceId,
      "--publish-to-bank",
      "--template-key",
      "v1-a2-prepositions-r1",
      "--linked-db",
    ]),
    /--bank-reviewed-by and --bank-released-by are required/,
  );
});

test("builds one atomic, idempotent, revision-safe linked import", () => {
  const worksheet = validateWorksheet(baseWorksheet());
  const sql = buildLinkedDbSql({
    worksheet,
    workspaceId,
    createdBy: reviewerId,
  });

  assert.match(sql, /^do \$worksheet_import\$/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /accepted_answers,/);
  assert.match(sql, /rubric,/);
  assert.match(sql, /answer_contract_version,/);
  assert.match(sql, /import_payload_sha256=[a-f0-9]{64}/);
  assert.match(
    sql,
    /app_private\.practice_test_content_sha256\(pt\.id\) as content_sha256/,
  );
  assert.doesNotMatch(sql, /(?:^|;)\s*content_sha256=/m);
  assert.equal(
    (sql.match(/insert into public\.practice_tests \(/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(sql, /update public\.practice_tests/i);
  assert.doesNotMatch(sql, /delete from public\.practice_test_questions/i);

  const sameSql = buildLinkedDbSql({
    worksheet,
    workspaceId,
    createdBy: reviewerId,
  });
  assert.equal(sql, sameSql);

  const changed = clone(worksheet);
  changed.questions[0].explanation = "A materially revised explanation.";
  const changedSql = buildLinkedDbSql({
    worksheet: changed,
    workspaceId,
    createdBy: reviewerId,
  });
  assert.notEqual(
    sql.match(/import_payload_sha256=([a-f0-9]{64})/)?.[1],
    changedSql.match(/import_payload_sha256=([a-f0-9]{64})/)?.[1],
  );
});

test("rejects reviewerless linked approval and checks active workspace authority before insert", async () => {
  await assert.rejects(
    main([
      "--file",
      "../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json",
      "--workspace-id",
      workspaceId,
      "--linked-db",
    ]),
    /--created-by is required for --linked-db/,
  );

  const worksheet = validateWorksheet(baseWorksheet());
  const sql = buildLinkedDbSql({ worksheet, workspaceId, createdBy: null });
  const missingReviewerGuard = sql.indexOf("if target_created_by is null then");
  const membershipGuard = sql.indexOf(
    "join public.workspace_members reviewer_membership",
  );
  const worksheetInsert = sql.indexOf("insert into public.practice_tests (");

  assert.ok(missingReviewerGuard >= 0, "missing null-reviewer guard");
  assert.ok(membershipGuard >= 0, "missing reviewer-membership guard");
  assert.ok(worksheetInsert >= 0, "missing worksheet insert");
  assert.ok(
    missingReviewerGuard < membershipGuard,
    "null reviewers must fail before membership lookup",
  );
  assert.ok(
    membershipGuard < worksheetInsert,
    "reviewer authorization must run before worksheet approval insert",
  );
  assert.match(
    sql,
    /perform 1\s+from public\.profiles reviewer\s+join public\.workspace_members reviewer_membership\s+on reviewer_membership\.user_id = reviewer\.id\s+where reviewer\.id = target_created_by\s+and reviewer_membership\.workspace_id = target_workspace_id\s+and reviewer_membership\.role in \('owner', 'teacher'\)\s+for share of reviewer, reviewer_membership;\s+if not found then/,
  );
  assert.doesNotMatch(
    sql,
    /target_created_by is not null and not exists/,
    "a nullable reviewer must not bypass the authorization check",
  );
  assert.match(sql, /teacher_reviewed,[\s\S]+?'approved'/);
  assert.match(sql, /reviewed_by,[\s\S]+?target_created_by,[\s\S]+?now\(\)/);
});

test("fails closed instead of attempting a non-transactional REST write", async () => {
  await assert.rejects(
    main([
      "--file",
      "../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json",
      "--workspace-id",
      workspaceId,
    ]),
    /Non-transactional REST imports are disabled/,
  );
});

test("the documented dry-run command executes without the broken separator", async () => {
  const documentation = await readFile(
    resolve(repositoryRoot, "docs/PRACTICE_WORKSHEET_IMPORT_FORMAT.md"),
    "utf8",
  );
  assert.doesNotMatch(documentation, /import:practice-worksheet -- \\\n/);
  assert.match(
    documentation,
    /--file \.\.\/supabase\/setup\/approved_worksheets\/a2-prepositions-practice-1\.json/,
  );
  assert.match(
    documentation,
    /--created-by <active-owner-or-teacher-profile-id>/,
  );
  assert.match(documentation, /--publish-to-bank/);
  assert.doesNotMatch(documentation, /a2\.prepositions\.practice\.1/);
  assert.match(documentation, /--template-key v1-a2-prepositions-r1/);
  assert.match(
    documentation,
    /--bank-reviewed-by <qualified-reviewer-profile-id>/,
  );
  assert.match(
    documentation,
    /--bank-released-by <qualified-releaser-profile-id>/,
  );
  assert.match(documentation, /no\s+worksheet approval (?:is|was) recorded/i);

  const result = spawnSync(
    process.env.PNPM_BIN || "pnpm",
    [
      "--dir",
      "scripts",
      "import:practice-worksheet",
      "--file",
      "../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json",
      "--workspace-id",
      workspaceId,
      "--dry-run",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"dry_run": true/);
  assert.match(result.stdout, /"question_count": 9/);
  assert.match(result.stdout, /"approval_recorded": false/);
  assert.match(
    result.stdout,
    /Dry run only; no worksheet approval was recorded\./,
  );
});
