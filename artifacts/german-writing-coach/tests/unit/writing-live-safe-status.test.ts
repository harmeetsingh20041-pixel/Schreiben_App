// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  classifyWritingLiveSafeStatus,
  parsePrivateNumericRow,
  parseWritingLiveSafeStatus,
  WRITING_LIVE_STATUS_VALUE_COUNT,
  type WritingLiveSafeStatus,
} from "../e2e/fixtures/writing-live-safe-status";

const pendingRetry: WritingLiveSafeStatus = {
  submissionCount: 1,
  exactScope: true,
  evaluationQueued: true,
  evaluationProcessing: false,
  evaluationReady: false,
  evaluationNeedsReview: false,
  evaluationFailed: false,
  releaseHeld: true,
  releaseScheduled: false,
  releaseReleased: false,
  jobCount: 1,
  jobQueued: false,
  jobProcessing: false,
  jobRetry: true,
  jobSucceeded: false,
  jobDead: false,
  attemptCount: 1,
  hasError: true,
  retryDue: false,
  retryScheduled: true,
  activeLease: false,
  adjudicationCount: 0,
  adjudicationAccepted: false,
  adjudicationSystemHold: false,
  adjudicationReasonOrdinal: 0,
  jobErrorOrdinal: 0,
};

const needsReviewWithReason = (
  adjudicationReasonOrdinal: number,
): WritingLiveSafeStatus => ({
  ...pendingRetry,
  evaluationQueued: false,
  evaluationNeedsReview: true,
  adjudicationCount: 1,
  adjudicationSystemHold: true,
  adjudicationReasonOrdinal,
});

const systemHoldReasons = [
  ["generator_not_configured", 4],
  ["generator_authentication_failed", 5],
  ["generator_not_primary", 6],
  ["generator_invalid", 7],
  ["critic_not_configured", 8],
  ["critic_authentication_failed", 9],
  ["critic_invalid", 10],
  ["critic_hash_mismatch", 11],
  ["critic_disagreed", 12],
  ["critic_uncertain", 13],
  ["adjudicator_not_configured", 14],
  ["adjudicator_authentication_failed", 15],
  ["adjudicator_invalid", 16],
  ["adjudicator_hash_mismatch", 17],
  ["adjudicator_unresolved", 18],
  ["final_critic_not_configured", 19],
  ["final_critic_authentication_failed", 20],
  ["final_critic_invalid", 21],
  ["final_critic_hash_mismatch", 22],
  ["final_critic_disagreed", 23],
  ["final_critic_uncertain", 24],
] as const;

describe("live-writing safe status", () => {
  it("parses one exact safe_numbers JSON object or a legacy raw row", () => {
    expect(parsePrivateNumericRow('[{"safe_numbers":"1|0|-1"}]\n', 3)).toEqual([
      1, 0, -1,
    ]);
    expect(parsePrivateNumericRow("1|0|-1\n", 3)).toEqual([1, 0, -1]);
  });

  it("rejects JSON framing, shape, key, type, and numeric-contract drift", () => {
    expect(
      parsePrivateNumericRow('Connected\n[{"safe_numbers":"1|0"}]\n', 2),
    ).toBeNull();
    expect(parsePrivateNumericRow("1|0\n1|0\n", 2)).toBeNull();
    expect(parsePrivateNumericRow("[]", 2)).toBeNull();
    expect(
      parsePrivateNumericRow(
        '[{"safe_numbers":"1|0"},{"safe_numbers":"1|0"}]',
        2,
      ),
    ).toBeNull();
    expect(parsePrivateNumericRow('{"safe_numbers":"1|0"}', 2)).toBeNull();
    expect(parsePrivateNumericRow('[{"other":"1|0"}]', 2)).toBeNull();
    expect(
      parsePrivateNumericRow('[{"safe_numbers":"1|0","extra":0}]', 2),
    ).toBeNull();
    expect(parsePrivateNumericRow('[{"safe_numbers":10}]', 2)).toBeNull();
    expect(parsePrivateNumericRow("1|ready\n", 2)).toBeNull();
    expect(parsePrivateNumericRow("1|0.5\n", 2)).toBeNull();
    expect(parsePrivateNumericRow("1|0\n", 3)).toBeNull();
    expect(
      parsePrivateNumericRow(`${Number.MAX_SAFE_INTEGER + 1}|0\n`, 2),
    ).toBeNull();
  });

  it("maps the fixed 26-number database contract without accepting text states", () => {
    const values = [
      1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0,
    ];
    expect(values).toHaveLength(WRITING_LIVE_STATUS_VALUE_COUNT);
    expect(parseWritingLiveSafeStatus(values)).toEqual(pendingRetry);
    expect(
      parseWritingLiveSafeStatus([
        ...values.slice(0, 22),
        2,
        ...values.slice(23),
      ]),
    ).toBeNull();
    expect(parseWritingLiveSafeStatus([...values.slice(0, -1), 41])).toBeNull();
    expect(parseWritingLiveSafeStatus(values.slice(1))).toBeNull();
  });

  it("allows a bounded retry instead of treating an error flag as terminal", () => {
    expect(classifyWritingLiveSafeStatus(pendingRetry)).toEqual({
      state: "pending",
    });
    expect(
      classifyWritingLiveSafeStatus({
        ...pendingRetry,
        retryDue: true,
        retryScheduled: false,
      }),
    ).toEqual({ state: "pending" });
  });

  it.each([1, 2, 3])(
    "accepts the exact released terminal state with adjudication reason %i",
    (adjudicationReasonOrdinal) => {
      expect(
        classifyWritingLiveSafeStatus({
          ...pendingRetry,
          evaluationQueued: false,
          evaluationReady: true,
          releaseHeld: false,
          releaseReleased: true,
          jobRetry: false,
          jobSucceeded: true,
          hasError: false,
          retryScheduled: false,
          adjudicationCount: 1,
          adjudicationAccepted: true,
          adjudicationReasonOrdinal,
        }),
      ).toEqual({ state: "ready" });
    },
  );

  it("rejects terminal feedback without exact accepted adjudication evidence", () => {
    const terminal = {
      ...pendingRetry,
      evaluationQueued: false,
      evaluationReady: true,
      releaseHeld: false,
      releaseReleased: true,
      jobRetry: false,
      jobSucceeded: true,
      hasError: false,
      retryScheduled: false,
    };
    expect(classifyWritingLiveSafeStatus(terminal)).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_terminal_adjudication_invalid",
    });
    expect(
      classifyWritingLiveSafeStatus({
        ...terminal,
        adjudicationCount: 1,
        adjudicationSystemHold: true,
        adjudicationReasonOrdinal: 7,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_terminal_adjudication_invalid",
    });
  });

  it.each([
    [
      "failed evaluation",
      {
        evaluationQueued: false,
        evaluationFailed: true,
        jobErrorOrdinal: 1,
      },
      "writing_live_fixture_feedback_failed_provider_timeout",
    ],
    [
      "closed spend-accounting diagnostic",
      {
        evaluationQueued: false,
        evaluationFailed: true,
        jobErrorOrdinal: 26,
      },
      "writing_live_fixture_feedback_failed_ai_spend_contract_invalid",
    ],
    [
      "dead job",
      { jobRetry: false, jobDead: true, retryScheduled: false },
      "writing_live_fixture_job_dead",
    ],
    [
      "scheduled immediate feedback",
      { releaseHeld: false, releaseScheduled: true },
      "writing_live_fixture_feedback_scheduled",
    ],
    [
      "ready feedback still held",
      { evaluationQueued: false, evaluationReady: true },
      "writing_live_fixture_feedback_held",
    ],
  ])("fails early on %s", (_name, overrides, safeCode) => {
    expect(
      classifyWritingLiveSafeStatus({ ...pendingRetry, ...overrides }),
    ).toEqual({ state: "failed", safeCode });
  });

  it.each(systemHoldReasons)(
    "reports the closed adjudication reason %s without evidence text",
    (reason, ordinal) => {
      expect(
        classifyWritingLiveSafeStatus(needsReviewWithReason(ordinal)),
      ).toEqual({
        state: "failed",
        safeCode: `writing_live_fixture_feedback_needs_review_${reason}`,
      });
    },
  );

  it("distinguishes missing and invalid needs-review evidence", () => {
    expect(
      classifyWritingLiveSafeStatus({
        ...pendingRetry,
        evaluationQueued: false,
        evaluationNeedsReview: true,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_feedback_needs_review_evidence_missing",
    });
    expect(
      classifyWritingLiveSafeStatus({
        ...needsReviewWithReason(12),
        adjudicationAccepted: true,
        adjudicationSystemHold: false,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_feedback_needs_review_evidence_invalid",
    });
    expect(classifyWritingLiveSafeStatus(needsReviewWithReason(1))).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_feedback_needs_review_evidence_invalid",
    });
  });

  it("fails closed on scope, state, and retry-contract contradictions", () => {
    expect(
      classifyWritingLiveSafeStatus({
        ...pendingRetry,
        exactScope: false,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_status_scope_invalid",
    });
    expect(
      classifyWritingLiveSafeStatus({
        ...pendingRetry,
        retryDue: true,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_status_contract_invalid",
    });
    expect(
      classifyWritingLiveSafeStatus({
        ...pendingRetry,
        adjudicationCount: 1,
        adjudicationAccepted: true,
        adjudicationReasonOrdinal: 4,
      }),
    ).toEqual({
      state: "failed",
      safeCode: "writing_live_fixture_status_contract_invalid",
    });
  });
});
