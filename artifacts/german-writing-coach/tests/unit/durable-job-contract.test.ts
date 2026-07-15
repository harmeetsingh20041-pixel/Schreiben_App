import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260710010000_phase_9a_durable_job_substrate.sql",
  ),
  "utf8",
);

function functionBody(qualifiedName: string) {
  const escapedName = qualifiedName.replaceAll(".", "\\.");
  const match = migration.match(
    new RegExp(
      `create or replace function ${escapedName}\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    ),
  );

  expect(match, `${qualifiedName} should exist`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("Phase 2A durable job source contract", () => {
  it("creates the three private durable queues", () => {
    expect(migration).toContain("create extension if not exists pgmq");
    for (const queueName of [
      "writing_evaluation",
      "worksheet_generation",
      "worksheet_answer_evaluation",
    ]) {
      expect(migration).toContain(`pgmq.create('${queueName}')`);
    }
    expect(migration).not.toContain("pgmq_public");
  });

  it("keeps queue messages identifier-only", () => {
    const enqueue = functionBody("app_private.enqueue_async_job");

    for (const key of ["job_id", "job_kind", "entity_id", "entity_version"]) {
      expect(enqueue).toContain(`'${key}'`);
    }
    for (const forbidden of [
      "original_text",
      "answer_text",
      "student_answer",
      "provider_response",
      "feedback",
      "error_code",
    ]) {
      expect(enqueue).not.toContain(forbidden);
    }
    expect(enqueue).toMatch(/on conflict \(idempotency_key\) do nothing/i);
  });

  it("creates the submission and writing job in one database transaction", () => {
    const createWriting = functionBody("public.create_writing_submission");
    expect(createWriting).toContain(
      "app_private.create_writing_submission_internal",
    );
    expect(createWriting).toContain("app_private.enqueue_async_job");
    expect(createWriting).toContain("evaluation_status = 'queued'");

    const submitWriting = functionBody("api.submit_writing");
    expect(submitWriting).toContain("public.create_writing_submission");
    expect(submitWriting).toContain("s.evaluation_status");
    expect(submitWriting).toContain("s.release_status");
  });

  it("enforces three bounded attempts with leases and retry backoff", () => {
    expect(migration).toMatch(/attempt_count\s+between\s+0\s+and\s+3/i);

    const claim = functionBody("public.claim_async_jobs");
    expect(claim).toContain("selected_job.attempt_count >= 3");
    expect(claim).toContain("j.attempt_count + 1");
    expect(claim).toMatch(/j\.status = 'processing' and j\.lease_expires_at <= now\(\)/);

    const fail = functionBody("public.fail_async_job");
    expect(fail).toContain("selected_job.attempt_count < 3");
    expect(fail).toMatch(/5 \* \(2 \^/);
    expect(fail).toContain("status = 'dead'");
  });

  it("exposes worker lifecycle routines only to service_role", () => {
    for (const signature of [
      "public.claim_async_jobs(text, uuid, integer, integer)",
      "public.fail_async_job(uuid, bigint, uuid, text, boolean)",
      "public.complete_writing_evaluation(uuid, bigint, uuid, jsonb)",
    ]) {
      expect(migration).toContain(`revoke all on function ${signature}`);
      expect(migration).toMatch(
        new RegExp(
          `grant execute on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+to service_role`,
          "i",
        ),
      );
    }
  });

  it("stages feedback privately before one transactional materialization", () => {
    const complete = functionBody("public.complete_writing_evaluation");
    expect(complete).toContain("insert into app_private.feedback_drafts");
    expect(complete).toContain("app_private.materialize_feedback_draft");
    expect(complete).toContain("perform pgmq.archive");

    const materialize = functionBody("app_private.materialize_feedback_draft");
    expect(materialize).toContain("insert into public.submission_lines");
    expect(materialize).toContain("insert into public.submission_grammar_topics");
    expect(materialize).toContain("release_status = 'released'");
    expect(materialize).toContain("state = 'released'");
  });
});
