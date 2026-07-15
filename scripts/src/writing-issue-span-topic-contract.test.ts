import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

test("writing feedback v2 keeps issue topics authoritative from provider to release", async () => {
  const [feedback, adjudication, migration, databaseTest] = await Promise.all([
    readFile(
      resolve(
        ROOT,
        "supabase/functions/_shared/writing-feedback.ts",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/functions/_shared/writing-adjudication.ts",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713072032_writing_issue_span_topics.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/tests/database/phase_13u_writing_issue_span_topics_test.sql",
      ),
      "utf8",
    ),
  ]);

  assert.match(feedback, /feedback_contract_version:\s*2/);
  assert.match(feedback, /grammar_topics:\s*string\[\]/);
  assert.match(feedback, /severity:\s*"minor"\s*\|\s*"major"\s*\|\s*null/);
  assert.match(
    feedback,
    /Every issue span requires mapped grammar topics and severity/,
  );
  assert.match(feedback, /part\.grammar_topics\.length === 0/);
  assert.match(feedback, /part\.severity === "major"/);
  assert.match(feedback, /minor_count:\s*topicFeedbackIssues\.filter/);
  assert.match(feedback, /major_count:\s*topicFeedbackIssues\.filter/);
  assert.doesNotMatch(
    feedback,
    /required:\s*\[[^\]]*"score_summary"[^\]]*\]/s,
  );

  assert.match(adjudication, /grammar_topics/);
  assert.match(adjudication, /severity/);
  assert.match(adjudication, /Every distinct edit must be a distinct span/);

  assert.match(migration, /prepare_writing_issue_span_topics/);
  assert.match(migration, /finalize_writing_issue_span_topics/);
  assert.match(migration, /writing_feedback_v2_span_topic_unmapped/);
  assert.match(migration, /writing_feedback_v2_topic_limit_exceeded/);
  assert.match(migration, /writing_feedback_content_requires_review/);
  assert.match(migration, /writing_feedback_incomplete_private_draft/);
  assert.match(
    migration,
    /char_length\(coalesce\(part_item ->> 'reason', ''\)\) > 4000/,
  );
  assert.match(
    migration,
    /jsonb_array_length\(part_item -> 'grammar_topics'\) not between 1 and 6/,
  );
  assert.match(
    migration,
    /count\(\*\) filter \(\s*where issue\.span_severity = 'minor'/,
  );
  assert.match(
    migration,
    /count\(\*\) filter \(\s*where issue\.span_severity = 'major'/,
  );
  assert.match(migration, /writing_evaluation_context_sha256/);
  assert.match(
    migration,
    /revoke all on function app_private\.prepare_writing_issue_span_topics\(\)/,
  );
  assert.match(
    migration,
    /revoke all on function app_private\.finalize_writing_issue_span_topics\(\)/,
  );

  assert.match(databaseTest, /select plan\(35\)/);
  assert.match(
    databaseTest,
    /one sentence derives article case and word-order/,
  );
  assert.match(databaseTest, /three separate same-topic spans count as three/);
  assert.match(databaseTest, /fixed Edge-compatible v2 hash/);
  assert.match(databaseTest, /due scheduled recovery path auto-releases/);
  assert.match(databaseTest, /authorized teacher upgrades a real v1 draft/);
  assert.match(databaseTest, /save unfinished span metadata as a private working copy/);
  assert.match(databaseTest, /release RPC rejects incomplete private working copies/);
  assert.match(
    databaseTest,
    /student feedback lines and derived topic summaries remain release-gated/,
  );
});

test("teacher feedback editing classifies every exact correction span", async () => {
  const [service, editor, review] = await Promise.all([
    readFile(
      resolve(
        ROOT,
        "artifacts/german-writing-coach/src/services/feedbackReviewService.ts",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "artifacts/german-writing-coach/src/components/teacher-feedback-draft-editor.tsx",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "artifacts/german-writing-coach/src/components/real-feedback-review.tsx",
      ),
      "utf8",
    ),
  ]);

  assert.match(service, /feedback_contract_version:\s*2/);
  assert.match(service, /grammar_topics:\s*part\.grammar_topics/);
  assert.match(
    service,
    /topics and severity for every correction span/,
  );
  assert.match(service, /minor_count/);
  assert.match(service, /major_count/);
  assert.match(service, /validationMode: "private_draft" \| "release"/);
  assert.match(editor, /Correction \{partIndex \+ 1\}/);
  assert.match(editor, /Issue severity/);
  assert.match(editor, /Reason for this exact correction/);
  assert.match(editor, /MAX_CORRECTION_REASON_CHARACTERS/);
  assert.match(editor, /MAX_CORRECTION_TOPICS/);
  assert.match(editor, /6 of 6 grammar topics selected/);
  assert.match(editor, /Grammar topics for line \$\{line\.line_number\}, correction/);
  assert.match(editor, /truncateToCodePoints/);
  assert.match(review, /lineTopicLabels/);
  assert.match(review, /part\.grammar_topics/);
});
