import type {
  WorksheetProviderCallIdentity,
  WorksheetProviderLifecycleHooks,
} from "../_shared/worksheet-generation.ts";

export const WORKSHEET_DIAGNOSTIC_STAGES = [
  "primary_generation",
  "primary_fallback_generation",
  "primary_critique",
  "repair_generation",
  "repair_critique",
] as const;

export const WORKSHEET_STAGE_DIAGNOSTIC_FIELDS = [
  "stage",
  "generation_source",
  "elapsed_ms",
  "safe_error_code",
] as const;

export type WorksheetDiagnosticStage =
  (typeof WORKSHEET_DIAGNOSTIC_STAGES)[number];

export type WorksheetStageDiagnostic = {
  stage: WorksheetDiagnosticStage;
  generation_source?: "deepseek" | "gemini";
  elapsed_ms: number;
  safe_error_code: string | null;
};

type PendingStage = {
  stage: WorksheetDiagnosticStage;
  attempt: 1 | 2;
  startedAt: number;
  endedAt: number | null;
  generationSource: "deepseek" | "gemini" | null;
  pendingCalls: Set<string>;
  safeErrorCode: string | null;
};

function attemptForCall(call: WorksheetProviderCallIdentity): 1 | 2 {
  return call.call_key.includes(":candidate_2:") ? 2 : 1;
}

function stageForCall(call: WorksheetProviderCallIdentity): {
  stage: WorksheetDiagnosticStage;
  attempt: 1 | 2;
} {
  const attempt = attemptForCall(call);
  if (call.call_purpose === "worksheet_generation") {
    if (
      attempt === 1 &&
      call.provider === "gemini"
    ) {
      return { stage: "primary_fallback_generation", attempt };
    }
    return {
      stage: attempt === 1 ? "primary_generation" : "repair_generation",
      attempt,
    };
  }
  return {
    stage: attempt === 1 ? "primary_critique" : "repair_critique",
    attempt,
  };
}

function boundedElapsed(startedAt: number, endedAt: number) {
  const elapsed = Math.max(0, Math.round(endedAt - startedAt));
  return Number.isSafeInteger(elapsed) ? elapsed : Number.MAX_SAFE_INTEGER;
}

function safeCode(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "worksheet_diagnostic_failed"
  );
}

export function createWorksheetStageDiagnosticRecorder(
  now: () => number = Date.now,
) {
  const overallStartedAt = now();
  const stages = new Map<WorksheetDiagnosticStage, PendingStage>();
  const calls = new Map<
    string,
    { stage: WorksheetDiagnosticStage; attempt: 1 | 2 }
  >();
  const candidateSources = new Map<1 | 2, "deepseek" | "gemini">();

  function ensureStage(stage: WorksheetDiagnosticStage, attempt: 1 | 2) {
    const existing = stages.get(stage);
    if (existing) return existing;
    const created: PendingStage = {
      stage,
      attempt,
      startedAt: now(),
      endedAt: null,
      generationSource: candidateSources.get(attempt) ?? null,
      pendingCalls: new Set(),
      safeErrorCode: null,
    };
    stages.set(stage, created);
    return created;
  }

  function before(call: WorksheetProviderCallIdentity) {
    const identity = stageForCall(call);
    const stage = ensureStage(identity.stage, identity.attempt);
    if (call.call_purpose === "worksheet_generation") {
      // A secondary availability call supersedes the failed transport inside
      // the same logical generation stage. Keep the original stage start so
      // elapsed time still includes the primary failure.
      stage.pendingCalls.clear();
      stage.endedAt = null;
      stage.safeErrorCode = null;
      stage.generationSource = null;
      candidateSources.delete(identity.attempt);
    } else {
      stage.generationSource = candidateSources.get(identity.attempt) ?? null;
    }
    stage.pendingCalls.add(call.call_key);
    calls.set(call.call_key, identity);
  }

  function finish(
    call: WorksheetProviderCallIdentity,
    errorCode: string | null,
  ) {
    const identity = calls.get(call.call_key) ?? stageForCall(call);
    const stage = ensureStage(identity.stage, identity.attempt);
    if (call.call_purpose === "worksheet_generation" && errorCode === null) {
      candidateSources.set(identity.attempt, call.provider);
      stage.generationSource = call.provider;
    } else if (call.call_purpose === "worksheet_critique") {
      stage.generationSource = candidateSources.get(identity.attempt) ?? null;
    }
    stage.pendingCalls.delete(call.call_key);
    if (errorCode !== null) stage.safeErrorCode = safeCode(errorCode);
    if (stage.pendingCalls.size === 0) stage.endedAt = now();
  }

  const hooks: WorksheetProviderLifecycleHooks = {
    async onBeforeProviderCall(call) {
      before(call);
    },
    async onProviderUsage(usage) {
      finish(usage, null);
    },
    async onProviderNotCalled(call, reason) {
      finish(call, reason);
    },
  };

  function markFailure(errorCode: string) {
    const normalized = safeCode(errorCode);
    const open = [...stages.values()].filter(
      (stage) => stage.pendingCalls.size > 0 || stage.endedAt === null,
    );
    if (open.length > 0) {
      for (const stage of open) {
        stage.safeErrorCode = normalized;
        stage.endedAt = now();
        stage.pendingCalls.clear();
      }
      return;
    }
    const last = [...stages.values()].at(-1);
    if (last) {
      last.safeErrorCode = normalized;
      return;
    }
    stages.set("primary_generation", {
      stage: "primary_generation",
      attempt: 1,
      startedAt: overallStartedAt,
      endedAt: now(),
      generationSource: null,
      pendingCalls: new Set(),
      safeErrorCode: normalized,
    });
  }

  function snapshot(): WorksheetStageDiagnostic[] {
    const observedAt = now();
    return WORKSHEET_DIAGNOSTIC_STAGES.flatMap((stageName) => {
      const stage = stages.get(stageName);
      if (!stage) return [];
      const diagnostic: WorksheetStageDiagnostic = {
        stage: stage.stage,
        ...(stage.generationSource
          ? { generation_source: stage.generationSource }
          : {}),
        elapsed_ms: boundedElapsed(
          stage.startedAt,
          stage.endedAt ?? observedAt,
        ),
        safe_error_code: stage.safeErrorCode,
      };
      return [diagnostic];
    });
  }

  return { hooks, markFailure, snapshot };
}
