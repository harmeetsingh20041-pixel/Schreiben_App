import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseAuditLedger,
  parseSeverityRegister,
  verifyAuditLedger,
  type AuditLedgerFinding,
  type AuditSeverityEntry,
} from "./verify-audit-ledger.js";

const ledgerHeader = `
| ID | Phase | Finding | Owner | Status | Required regression test | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
`;

function finding(
  id: string,
  status: AuditLedgerFinding["status"],
): AuditLedgerFinding {
  return {
    id,
    phase: "1",
    finding: "A meaningful launch finding.",
    owner: "Security",
    status,
    regressionTest: "A meaningful regression test must pass.",
    evidence: "A dated and reviewable evidence record exists.",
  };
}

const severities: AuditSeverityEntry[] = [
  {
    id: "SEC-001",
    severity: "P0",
    rationale: "Critical authorization boundary.",
  },
  {
    id: "OPS-001",
    severity: "P2",
    rationale: "Recoverable product usability issue.",
  },
];

function findingIds(prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`,
  );
}

const originalFindingIds = [
  ...findingIds("SEC", 14),
  ...findingIds("WRITE", 21),
  ...findingIds("PRACTICE", 22),
  ...findingIds("OPS", 14),
];

const addedFindingIds = [
  "SEC-015",
  "SEC-016",
  "SEC-017",
  "SEC-018",
  "SEC-019",
  "SEC-020",
  "WRITE-022",
  "WRITE-023",
  "WRITE-024",
  "WRITE-025",
  "WRITE-026",
  "WRITE-027",
  "WRITE-028",
  "WRITE-029",
  "WRITE-030",
  "WRITE-031",
  "PRACTICE-023",
  "PRACTICE-024",
  "PRACTICE-025",
  "PRACTICE-026",
  "PRACTICE-027",
  "PRACTICE-028",
  "PRACTICE-029",
  "PRACTICE-030",
  "PRACTICE-031",
  "PRACTICE-032",
  "PRACTICE-033",
  "PRACTICE-034",
  "PRACTICE-035",
  "PRACTICE-036",
  "PRACTICE-037",
  "PRACTICE-038",
  "PRACTICE-039",
  "PRACTICE-040",
  "PRACTICE-041",
  "PRACTICE-042",
  "PRACTICE-043",
  "PRACTICE-044",
  "PRACTICE-045",
  "OPS-015",
  "OPS-016",
  "OPS-017",
  "OPS-018",
  "OPS-019",
  "OPS-020",
  "OPS-021",
  "OPS-022",
  "OPS-023",
  "OPS-024",
  "OPS-025",
  "OPS-026",
  "OPS-027",
  "OPS-028",
  "OPS-029",
  "OPS-030",
  "OPS-031",
  "OPS-032",
  "OPS-033",
  "OPS-034",
  "OPS-035",
  "OPS-036",
  "OPS-037",
  "OPS-038",
  "OPS-039",
  "OPS-040",
  "OPS-041",
  "OPS-042",
];

test("parses the seven-column audit ledger and rejects duplicate IDs", () => {
  const errors: string[] = [];
  const findings = parseAuditLedger(
    `${ledgerHeader}| SEC-001 | 1 | Students can gain authority. | Security | In progress | Student escalation is rejected by the database. | Migration and database test are pending runtime. |\n| SEC-001 | 1 | Duplicate row is forbidden. | Security | Verified | Duplicate detection must fail closed. | Duplicate evidence must not be accepted. |`,
    errors,
  );

  assert.equal(findings.length, 1);
  assert(errors.some((error) => error.includes("duplicates SEC-001")));
});

test("requires exact ledger and severity-register reconciliation", () => {
  const errors: string[] = [];
  const report = verifyAuditLedger(
    [finding("SEC-001", "Verified")],
    severities,
    "consistency",
    errors,
  );

  assert.equal(report.ok, false);
  assert(report.errors.some((error) => error.includes("OPS-001")));
});

test("consistency mode reports unresolved severity without pretending launch readiness", () => {
  const report = verifyAuditLedger(
    [finding("SEC-001", "In progress"), finding("OPS-001", "Foundation")],
    severities,
  );

  assert.equal(report.ok, true);
  assert.equal(report.unresolved_count, 2);
  assert.equal(report.unresolved_p0_count, 1);
  assert.equal(report.unresolved_p1_count, 0);
  assert.deepEqual(report.severity_count, { P0: 1, P1: 0, P2: 1 });
});

test("launch mode blocks every unresolved finding, including P2", () => {
  const report = verifyAuditLedger(
    [finding("SEC-001", "Verified"), finding("OPS-001", "In progress")],
    severities,
    "launch",
  );

  assert.equal(report.ok, false);
  assert.equal(report.unresolved_count, 1);
  assert.deepEqual(report.unresolved_ids, ["OPS-001"]);
  assert(report.errors.some((error) => error.includes("Launch is blocked")));
});

test("launch mode passes only after every classified finding is Verified", () => {
  const report = verifyAuditLedger(
    [finding("SEC-001", "Verified"), finding("OPS-001", "Verified")],
    severities,
    "launch",
  );

  assert.equal(report.ok, true);
  assert.equal(report.unresolved_count, 0);
  assert.deepEqual(report.errors, []);
});

test("rejects malformed or weak severity entries", () => {
  const errors: string[] = [];
  const parsed = parseSeverityRegister(
    {
      schema_version: 1,
      findings: [
        { id: "SEC-001", severity: "P9", rationale: "bad" },
        { id: "SEC-001", severity: "P0", rationale: "Duplicate entry." },
      ],
    },
    errors,
  );

  assert.deepEqual(parsed, []);
  assert(errors.some((error) => error.includes("invalid severity")));
  assert(errors.some((error) => error.includes("duplicates SEC-001")));
});

test("the repository ledger preserves the original 71 and classifies all 138 audit findings", async () => {
  const [ledger, register] = await Promise.all([
    readFile(
      new URL("../../docs/V1_AUDIT_TRACEABILITY.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../quality/v1-audit-severity.json", import.meta.url),
      "utf8",
    ),
  ]);
  const errors: string[] = [];
  const findings = parseAuditLedger(ledger, errors);
  const entries = parseSeverityRegister(JSON.parse(register), errors);
  const report = verifyAuditLedger(findings, entries, "consistency", errors);

  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(originalFindingIds.length, 71);
  assert.equal(addedFindingIds.length, 67);
  const expectedIds = [...originalFindingIds, ...addedFindingIds].sort();
  assert.deepEqual(findings.map((finding) => finding.id).sort(), expectedIds);
  assert.deepEqual(entries.map((entry) => entry.id).sort(), expectedIds);
  assert.equal(report.finding_count, 138);
  assert.equal(entries.length, 138);
  assert.equal(
    report.severity_count.P0 +
      report.severity_count.P1 +
      report.severity_count.P2,
    138,
  );
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  for (const id of [
    "PRACTICE-024",
    "PRACTICE-025",
    "PRACTICE-039",
    "OPS-019",
    "OPS-020",
    "OPS-021",
    "OPS-022",
    "OPS-038",
    "OPS-039",
  ]) {
    assert.notEqual(
      findingById.get(id)?.status,
      "Verified",
      `${id} must retain its explicit external evidence gate.`,
    );
  }
  assert.equal(
    findingById.get("PRACTICE-039")?.status,
    "In progress",
    "PRACTICE-039 must stay blocked until real no-bank generation and a certified production bank are proven.",
  );
  assert.equal(
    findingById.get("OPS-038")?.status,
    "In progress",
    "OPS-038 must stay blocked until the applicant/admin frontend and real-browser journey are proven.",
  );
  assert(
    report.unresolved_count > 0,
    "The local ledger must not claim unearned launch certification.",
  );
});
