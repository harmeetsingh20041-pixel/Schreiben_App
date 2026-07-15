import {
  createWorksheetStageDiagnosticRecorder,
  WORKSHEET_DIAGNOSTIC_STAGES,
  WORKSHEET_STAGE_DIAGNOSTIC_FIELDS,
} from "./worksheet-stage-diagnostic.ts";
import type { WorksheetProviderCallIdentity } from "../_shared/worksheet-generation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

function providerCall(args: {
  provider: "deepseek" | "gemini";
  purpose: "worksheet_generation" | "worksheet_critique";
  key: string;
}): WorksheetProviderCallIdentity {
  return {
    provider: args.provider,
    requested_model: "not_exposed",
    call_purpose: args.purpose,
    call_key: args.key,
  };
}

function providerUsage(call: WorksheetProviderCallIdentity) {
  return {
    ...call,
    provider_model_version: "not_exposed",
    input_tokens: 1,
    output_tokens: 1,
  };
}

function assertContentFreeShape(value: unknown) {
  assert(Array.isArray(value), "Diagnostic output must be an array.");
  const allowedFields = new Set<string>(WORKSHEET_STAGE_DIAGNOSTIC_FIELDS);
  for (const row of value) {
    assert(
      row && typeof row === "object" && !Array.isArray(row),
      "Every diagnostic row must be an object.",
    );
    const record = row as Record<string, unknown>;
    assertEquals(
      Object.keys(record).filter((key) => !allowedFields.has(key)),
      [],
    );
    assert(
      WORKSHEET_DIAGNOSTIC_STAGES.includes(record.stage as never),
      "Unknown worksheet diagnostic stage.",
    );
    assert(
      record.generation_source === undefined ||
        record.generation_source === "deepseek" ||
        record.generation_source === "gemini",
      "Generation source must be absent or use the exact provider allowlist.",
    );
    assert(
      Number.isSafeInteger(record.elapsed_ms) &&
        (record.elapsed_ms as number) >= 0,
      "Elapsed time must be a non-negative safe integer.",
    );
    assert(
      record.safe_error_code === null ||
        typeof record.safe_error_code === "string",
      "Safe error code must be null or a string.",
    );
  }
  assert(
    !/(?:prompt|candidate|question|answer|hash|model|body|rejection)/i.test(
      JSON.stringify(value),
    ),
    "Stage diagnostics must remain content-free.",
  );
}

Deno.test(
  "worksheet stage diagnostics expose exact content-free resumable stages",
  async () => {
    let clock = 1_000;
    const recorder = createWorksheetStageDiagnosticRecorder(() => clock);
    const primaryGeneration = providerCall({
      provider: "deepseek",
      purpose: "worksheet_generation",
      key: "worksheet_diagnostic:candidate_1:deepseek:mcq_safe_generation",
    });
    await recorder.hooks.onBeforeProviderCall(primaryGeneration);
    clock = 1_125;
    await recorder.hooks.onProviderUsage(providerUsage(primaryGeneration));

    const primaryDeepSeekCritic = providerCall({
      provider: "deepseek",
      purpose: "worksheet_critique",
      key: "worksheet_diagnostic:candidate_1:deepseek:critique",
    });
    const primaryGeminiCritic = providerCall({
      provider: "gemini",
      purpose: "worksheet_critique",
      key: "worksheet_diagnostic:candidate_1:gemini:critique",
    });
    clock = 1_200;
    await Promise.all([
      recorder.hooks.onBeforeProviderCall(primaryDeepSeekCritic),
      recorder.hooks.onBeforeProviderCall(primaryGeminiCritic),
    ]);
    clock = 1_275;
    await recorder.hooks.onProviderUsage(providerUsage(primaryDeepSeekCritic));
    clock = 1_320;
    await recorder.hooks.onProviderUsage(providerUsage(primaryGeminiCritic));

    const repairGeneration = providerCall({
      provider: "gemini",
      purpose: "worksheet_generation",
      key: "worksheet_diagnostic:candidate_2:gemini:revision_generation",
    });
    clock = 1_400;
    await recorder.hooks.onBeforeProviderCall(repairGeneration);
    clock = 1_540;
    await recorder.hooks.onProviderUsage(providerUsage(repairGeneration));

    const repairDeepSeekCritic = providerCall({
      provider: "deepseek",
      purpose: "worksheet_critique",
      key: "worksheet_diagnostic:candidate_2:deepseek:critique",
    });
    const repairGeminiCritic = providerCall({
      provider: "gemini",
      purpose: "worksheet_critique",
      key: "worksheet_diagnostic:candidate_2:gemini:critique",
    });
    clock = 1_600;
    await Promise.all([
      recorder.hooks.onBeforeProviderCall(repairDeepSeekCritic),
      recorder.hooks.onBeforeProviderCall(repairGeminiCritic),
    ]);
    clock = 1_675;
    await recorder.hooks.onProviderUsage(providerUsage(repairDeepSeekCritic));
    clock = 1_710;
    await recorder.hooks.onProviderUsage(providerUsage(repairGeminiCritic));

    const diagnostics = recorder.snapshot();
    assertContentFreeShape(diagnostics);
    assertEquals(diagnostics, [
      {
        stage: "primary_generation",
        generation_source: "deepseek",
        elapsed_ms: 125,
        safe_error_code: null,
      },
      {
        stage: "primary_critique",
        generation_source: "deepseek",
        elapsed_ms: 120,
        safe_error_code: null,
      },
      {
        stage: "repair_generation",
        generation_source: "gemini",
        elapsed_ms: 140,
        safe_error_code: null,
      },
      {
        stage: "repair_critique",
        generation_source: "gemini",
        elapsed_ms: 110,
        safe_error_code: null,
      },
    ]);
  },
);

Deno.test(
  "worksheet stage diagnostics identify failures without exposing failed payloads",
  async () => {
    let clock = 5_000;
    const recorder = createWorksheetStageDiagnosticRecorder(() => clock);
    const generation = providerCall({
      provider: "deepseek",
      purpose: "worksheet_generation",
      key: "worksheet_diagnostic:candidate_1:deepseek:mcq_safe_generation",
    });
    await recorder.hooks.onBeforeProviderCall(generation);
    clock = 5_750;
    recorder.markFailure("worksheet_provider_timeout:upstream detail");

    const diagnostics = recorder.snapshot();
    assertContentFreeShape(diagnostics);
    assertEquals(diagnostics, [
      {
        stage: "primary_generation",
        elapsed_ms: 750,
        safe_error_code: "worksheet_provider_timeout_upstream_detail",
      },
    ]);
  },
);

Deno.test(
  "worksheet fallback stages report only the successful Gemini-safe candidate source",
  async () => {
    for (
      const fallback of [
        {
          key: "worksheet_diagnostic:candidate_1:gemini:outage_safe_generation",
          failure: "worksheet_provider_timeout",
        },
        {
          key: "worksheet_diagnostic:candidate_1:gemini:mcq_safe_generation",
          failure: "worksheet_duplicate_options",
        },
      ]
    ) {
      let clock = 9_000;
      const recorder = createWorksheetStageDiagnosticRecorder(() => clock);
      const deepSeekAttempt = providerCall({
        provider: "deepseek",
        purpose: "worksheet_generation",
        key: "worksheet_diagnostic:candidate_1:deepseek:mcq_safe_generation",
      });
      await recorder.hooks.onBeforeProviderCall(deepSeekAttempt);

      clock = 9_400;
      recorder.markFailure(fallback.failure);
      const geminiFallback = providerCall({
        provider: "gemini",
        purpose: "worksheet_generation",
        key: fallback.key,
      });
      await recorder.hooks.onBeforeProviderCall(geminiFallback);
      clock = 9_725;
      await recorder.hooks.onProviderUsage(providerUsage(geminiFallback));

      const diagnostics = recorder.snapshot();
      assertContentFreeShape(diagnostics);
      assertEquals(diagnostics, [
        {
          stage: "primary_generation",
          elapsed_ms: 400,
          safe_error_code: fallback.failure,
        },
        {
          stage: "primary_fallback_generation",
          generation_source: "gemini",
          elapsed_ms: 325,
          safe_error_code: null,
        },
      ]);
    }
  },
);
