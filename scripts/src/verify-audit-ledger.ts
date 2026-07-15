import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const allowedStatuses = [
  "Open",
  "In progress",
  "Foundation",
  "Verified",
] as const;
const allowedSeverities = ["P0", "P1", "P2"] as const;

export type AuditStatus = (typeof allowedStatuses)[number];
export type AuditSeverity = (typeof allowedSeverities)[number];

export type AuditLedgerFinding = {
  id: string;
  phase: string;
  finding: string;
  owner: string;
  status: AuditStatus;
  regressionTest: string;
  evidence: string;
};

export type AuditSeverityEntry = {
  id: string;
  severity: AuditSeverity;
  rationale: string;
};

export type AuditLedgerReport = {
  ok: boolean;
  mode: "consistency" | "launch";
  errors: string[];
  finding_count: number;
  severity_count: Record<AuditSeverity, number>;
  status_count: Record<AuditStatus, number>;
  unresolved_count: number;
  unresolved_p0_count: number;
  unresolved_p1_count: number;
  unresolved_ids: string[];
};

type SeverityRegister = {
  schema_version: 1;
  findings: AuditSeverityEntry[];
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const defaultLedgerPath = resolve(
  repositoryRoot,
  "docs/V1_AUDIT_TRACEABILITY.md",
);
const defaultRegisterPath = resolve(
  repositoryRoot,
  "quality/v1-audit-severity.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAuditStatus(value: string): value is AuditStatus {
  return allowedStatuses.includes(value as AuditStatus);
}

function isAuditSeverity(value: unknown): value is AuditSeverity {
  return (
    typeof value === "string" &&
    allowedSeverities.includes(value as AuditSeverity)
  );
}

function isFindingId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SEC|WRITE|PRACTICE|OPS)-\d{3}$/.test(value)
  );
}

function isMeaningful(value: string) {
  return (
    value.trim().length >= 8 &&
    !/^(?:tbd|todo|none|n\/a|pending)$/i.test(value.trim())
  );
}

export function parseAuditLedger(
  markdown: string,
  errors: string[] = [],
): AuditLedgerFinding[] {
  const findings: AuditLedgerFinding[] = [];
  const seen = new Set<string>();

  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    if (!/^\| (?:SEC|WRITE|PRACTICE|OPS)-\d{3} \|/u.test(line)) continue;

    const fields = line
      .split("|")
      .slice(1, -1)
      .map((field) => field.trim());
    const lineLabel = `Ledger line ${index + 1}`;
    if (fields.length !== 7) {
      errors.push(`${lineLabel} must contain exactly seven finding columns.`);
      continue;
    }

    const [id, phase, finding, owner, status, regressionTest, evidence] =
      fields;
    if (!isFindingId(id)) {
      errors.push(`${lineLabel} has an invalid finding ID.`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${lineLabel} duplicates ${id}.`);
      continue;
    }
    seen.add(id);

    if (!/^\d+(?:\/\d+|\+)?$/u.test(phase)) {
      errors.push(`${id} has an invalid phase value.`);
    }
    if (!isMeaningful(finding)) errors.push(`${id} has no meaningful finding.`);
    if (
      owner.trim().length < 2 ||
      /^(?:tbd|todo|none|n\/a)$/i.test(owner.trim())
    ) {
      errors.push(`${id} has no meaningful owner.`);
    }
    if (!isAuditStatus(status)) errors.push(`${id} has an invalid status.`);
    if (!isMeaningful(regressionTest)) {
      errors.push(`${id} has no meaningful required regression test.`);
    }
    if (!isMeaningful(evidence)) {
      errors.push(`${id} has no meaningful evidence record.`);
    }

    if (isAuditStatus(status)) {
      findings.push({
        id,
        phase,
        finding,
        owner,
        status,
        regressionTest,
        evidence,
      });
    }
  }

  if (findings.length === 0) {
    errors.push("The audit ledger contains no recognized findings.");
  }
  return findings;
}

export function parseSeverityRegister(
  input: unknown,
  errors: string[] = [],
): AuditSeverityEntry[] {
  if (!isRecord(input) || input.schema_version !== 1) {
    errors.push("The severity register must use schema_version 1.");
    return [];
  }
  if (!Array.isArray(input.findings)) {
    errors.push("The severity register must contain a findings array.");
    return [];
  }

  const entries: AuditSeverityEntry[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.findings.entries()) {
    const label = `Severity entry ${index + 1}`;
    if (!isRecord(value)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const keys = Object.keys(value);
    const unexpected = keys.filter(
      (key) => !["id", "severity", "rationale"].includes(key),
    );
    if (unexpected.length > 0) {
      errors.push(
        `${label} contains unsupported fields: ${unexpected.join(", ")}.`,
      );
    }
    if (!isFindingId(value.id)) {
      errors.push(`${label} has an invalid finding ID.`);
      continue;
    }
    if (seen.has(value.id)) {
      errors.push(`${label} duplicates ${value.id}.`);
      continue;
    }
    seen.add(value.id);
    if (!isAuditSeverity(value.severity)) {
      errors.push(`${value.id} has an invalid severity.`);
      continue;
    }
    if (typeof value.rationale !== "string" || !isMeaningful(value.rationale)) {
      errors.push(`${value.id} has no meaningful severity rationale.`);
      continue;
    }
    entries.push({
      id: value.id,
      severity: value.severity,
      rationale: value.rationale,
    });
  }
  return entries;
}

export function verifyAuditLedger(
  findings: AuditLedgerFinding[],
  severities: AuditSeverityEntry[],
  mode: "consistency" | "launch" = "consistency",
  inheritedErrors: string[] = [],
): AuditLedgerReport {
  const errors = [...inheritedErrors];
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const severityById = new Map(severities.map((entry) => [entry.id, entry]));

  for (const id of findingById.keys()) {
    if (!severityById.has(id))
      errors.push(`${id} has no severity classification.`);
  }
  for (const id of severityById.keys()) {
    if (!findingById.has(id)) {
      errors.push(`${id} is classified but missing from the audit ledger.`);
    }
  }

  const severityCount: Record<AuditSeverity, number> = { P0: 0, P1: 0, P2: 0 };
  const statusCount: Record<AuditStatus, number> = {
    Open: 0,
    "In progress": 0,
    Foundation: 0,
    Verified: 0,
  };
  const unresolvedIds: string[] = [];
  let unresolvedP0Count = 0;
  let unresolvedP1Count = 0;

  for (const finding of findings) {
    statusCount[finding.status] += 1;
    const severity = severityById.get(finding.id)?.severity;
    if (severity) severityCount[severity] += 1;
    if (finding.status === "Verified") continue;
    unresolvedIds.push(finding.id);
    if (severity === "P0") unresolvedP0Count += 1;
    if (severity === "P1") unresolvedP1Count += 1;
  }

  unresolvedIds.sort();
  if (mode === "launch" && unresolvedIds.length > 0) {
    errors.push(
      `Launch is blocked: ${unresolvedIds.length} audit finding(s) are not Verified (${unresolvedP0Count} P0, ${unresolvedP1Count} P1).`,
    );
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    finding_count: findings.length,
    severity_count: severityCount,
    status_count: statusCount,
    unresolved_count: unresolvedIds.length,
    unresolved_p0_count: unresolvedP0Count,
    unresolved_p1_count: unresolvedP1Count,
    unresolved_ids: unresolvedIds,
  };
}

type CliOptions = {
  ledgerPath: string;
  registerPath: string;
  reportOutput?: string;
  mode: "consistency" | "launch";
};

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    ledgerPath: defaultLedgerPath,
    registerPath: defaultRegisterPath,
    mode: "consistency",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--launch") {
      options.mode = "launch";
      continue;
    }
    const next = argv[index + 1];
    if (["--ledger", "--register", "--report-output"].includes(argument)) {
      if (!next || next.startsWith("--")) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === "--ledger") options.ledgerPath = resolve(next);
      if (argument === "--register") options.registerPath = resolve(next);
      if (argument === "--report-output") options.reportOutput = resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [markdown, registerText] = await Promise.all([
    readFile(options.ledgerPath, "utf8"),
    readFile(options.registerPath, "utf8"),
  ]);
  const errors: string[] = [];
  const findings = parseAuditLedger(markdown, errors);
  let registerValue: unknown;
  try {
    registerValue = JSON.parse(registerText) as SeverityRegister;
  } catch {
    errors.push("The severity register is not valid JSON.");
  }
  const severities = parseSeverityRegister(registerValue, errors);
  const report = verifyAuditLedger(findings, severities, options.mode, errors);

  if (options.reportOutput) {
    await writeFile(
      options.reportOutput,
      `${JSON.stringify(report, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Audit verification failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
