import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const processor = await readFile(
  new URL(
    "../../supabase/functions/process-worksheet-answer-jobs/processor.ts",
    import.meta.url,
  ),
  "utf8",
);

const scheduleMigration = await readFile(
  new URL(
    "../../supabase/migrations/20260713121600_drain_practice_cycle_transitions.sql",
    import.meta.url,
  ),
  "utf8",
);

const transitionMigration = await readFile(
  new URL(
    "../../supabase/migrations/20260712151111_gate_low_cefr_productive_practice.sql",
    import.meta.url,
  ),
  "utf8",
);

test("answer completion commits before one bounded best-effort transition drain", () => {
  assert.match(
    processor,
    /complete_worksheet_answer_adjudication[\s\S]*stage: "complete"[\s\S]*process_practice_cycle_transition_jobs[\s\S]*max_jobs: PRACTICE_CYCLE_TRANSITION_BATCH_SIZE/,
  );
  assert.match(processor, /PRACTICE_CYCLE_TRANSITION_BATCH_SIZE = 10/);
  assert.match(
    processor,
    /catch \{[\s\S]*stage: "practice_transition"[\s\S]*status: "failed"[\s\S]*safe_error_code: "practice_transition_drain_failed"[\s\S]*return \{ claimed: true, outcome: "completed"/,
  );
});

test("database recovery drains the private transition outbox every 30 seconds", () => {
  assert.match(scheduleMigration, /create extension if not exists pg_cron/);
  assert.match(
    scheduleMigration,
    /cron\.schedule\([\s\S]*'drain-practice-cycle-transitions-every-30-seconds'[\s\S]*'30 seconds'[\s\S]*select app_private\.process_practice_cycle_transition_jobs\(50\);/,
  );
  assert.match(
    scheduleMigration,
    /cron\.unschedule\([\s\S]*'drain-practice-cycle-transitions-every-30-seconds'/,
  );
  assert.doesNotMatch(
    scheduleMigration,
    /net\.http|functions\/v1|service_role|process_recovery_secret/i,
  );
});

test("recurrence remains idempotent and one transition row exists per assignment revision", () => {
  assert.match(
    transitionMigration,
    /on conflict \(assignment_id, status_revision\) do nothing/,
  );
  assert.match(
    transitionMigration,
    /where job\.processed_at is null[\s\S]*job\.failure_count < 3[\s\S]*for update skip locked/,
  );
  assert.match(
    transitionMigration,
    /selected_assignment\.status_revision > selected_job\.status_revision[\s\S]*set processed_at = now\(\)/,
  );
});
