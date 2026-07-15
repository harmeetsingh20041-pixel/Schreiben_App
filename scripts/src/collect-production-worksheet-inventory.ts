import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProductionCanonicalWorksheetBankRow,
  ProductionModelValidatedWorksheetCacheRow,
  ProductionWorksheetInventoryEvidence,
  ProductionWorksheetInventoryRow,
} from "./verify-production-worksheet-inventory.js";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;

export const PRODUCTION_WORKSHEET_INVENTORY_QUERY = `with worksheet_inventory as (
  select
    test.id::text as revision_id,
    test.level::text as level,
    test.generation_source::text as generation_source,
    test.generator_model::text as generator_model,
    test.approval_source::text as approval_source,
    test.created_by_ai,
    test.teacher_reviewed,
    test.visibility::text as visibility,
    test.quality_status::text as quality_status,
    app_private.practice_test_content_sha256(test.id) as content_sha256,
    coalesce((
      select count(*) > 0 and bool_and(question.answer_contract_version = 1)
      from public.practice_test_questions as question
      where question.practice_test_id = test.id
    ), false) as answer_contract_v1,
    (
      exists (
        select 1
        from public.student_practice_assignments as assignment
        where assignment.practice_test_id = test.id
      )
      or exists (
        select 1
        from public.practice_test_attempts as attempt
        where attempt.practice_test_id = test.id
      )
    ) as has_student_use,
    (
      (
        test.worksheet_model_cache_revision_id is not null
        and test.approval_source = 'independent_model_validation'
        and app_private.practice_worksheet_model_cache_revision_is_current(
          test.worksheet_model_cache_revision_id
        )
        and test.model_cache_content_sha256
          = app_private.practice_test_content_sha256(test.id)
      )
      or (
        test.generation_source in ('deepseek', 'gemini')
        and (
          (
            test.generation_source = 'deepseek'
            and test.generator_model = 'deepseek-v4-pro'
          )
          or (
            test.generation_source = 'gemini'
            and test.generator_model in (
              'gemini-3.5-flash',
              'gemini-3.1-flash-lite'
            )
          )
        )
        and coalesce(test.generation_metadata #>> '{validation,critic_model}', '') in (
          'deepseek-v4-flash',
          'gemini-2.5-flash',
          'gemini-3.5-flash',
          'gemini-3.1-flash-lite'
        )
        and coalesce(test.generation_metadata #>> '{validation,critic_model}', '')
          <> coalesce(test.generator_model, '')
        and coalesce(test.generation_metadata #>> '{validation,deterministic}', 'false') = 'true'
        and coalesce(test.generation_metadata #>> '{validation,independent_model}', 'false') = 'true'
        and coalesce(jsonb_array_length(test.generation_metadata #> '{validation,rejection_reasons}'), 0) = 0
      )
    ) as system_validation_passed,
    test.reviewed_by is not null as reviewed_by_present,
    test.reviewed_at is not null as reviewed_at_present,
    test.worksheet_model_cache_revision_id::text
      as worksheet_model_cache_revision_id,
    test.model_cache_content_sha256::text as model_cache_content_sha256
  from public.practice_tests as test
), classified as (
  select
    inventory.*,
    case
      when inventory.visibility = 'workspace'
        and inventory.quality_status = 'approved'
        and inventory.generation_source <> 'system_fallback'
        and inventory.answer_contract_v1
        then 'reusable'
      when inventory.visibility = 'private'
        and inventory.quality_status = 'needs_review'
        then 'quarantined'
      when inventory.visibility = 'private'
        and inventory.quality_status = 'failed'
        then 'retired'
      when inventory.has_student_use
        then 'historical_only'
      else 'unresolved'
    end as disposition
  from worksheet_inventory as inventory
), canonical_immutable_controls as (
  select (
    exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_templates'
        and trigger.tgname = 'practice_worksheet_templates_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_template_revisions'
        and trigger.tgname = 'practice_worksheet_template_revisions_guard'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_template_questions'
        and trigger.tgname = 'practice_worksheet_template_questions_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_template_reviews'
        and trigger.tgname = 'practice_worksheet_template_reviews_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_template_releases'
        and trigger.tgname = 'practice_worksheet_template_releases_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
  ) as controls_present
), canonical_bank as (
  select
    revision.id::text as revision_id,
    template.id::text as template_id,
    template.template_key::text as template_key,
    template.level::text as level,
    topic.slug::text as topic_slug,
    revision.state::text as state,
    revision.content_sha256::text as content_sha256,
    app_private.practice_worksheet_template_revision_sha256(revision.id)
      as recomputed_content_sha256,
    review.id::text as review_id,
    review.reviewer_id::text as reviewer_id,
    review.decision::text as review_decision,
    coalesce(
      app_private.worksheet_review_checklist_is_complete(review.checklist),
      false
    ) as review_checklist_complete,
    review.content_sha256::text as review_content_sha256,
    review.reviewed_at::text as reviewed_at,
    coalesce(
      reviewer.active
      and reviewer.can_certify
      and length(btrim(reviewer.qualification)) between 8 and 500
      and reviewer.verified_at <= review.reviewed_at
      and (
        reviewer.expires_at is null
        or reviewer.expires_at > greatest(review.reviewed_at, current_timestamp)
      ),
      false
    ) as reviewer_qualified,
    release.id::text as bank_release_id,
    release.review_id::text as release_review_id,
    release.released_by::text as released_by,
    release.content_sha256::text as release_content_sha256,
    release.released_at::text as released_at,
    coalesce(
      releaser.active
      and releaser.can_release
      and length(btrim(releaser.qualification)) between 8 and 500
      and releaser.verified_at <= release.released_at
      and (
        releaser.expires_at is null
        or releaser.expires_at > greatest(release.released_at, current_timestamp)
      ),
      false
    ) as releaser_qualified,
    immutable.controls_present as immutable_controls_present
  from app_private.practice_worksheet_template_revisions as revision
  join app_private.practice_worksheet_templates as template
    on template.id = revision.template_id
  join public.grammar_topics as topic
    on topic.id = template.grammar_topic_id
  left join app_private.practice_worksheet_template_reviews as review
    on review.revision_id = revision.id
  left join app_private.practice_worksheet_bank_reviewers as reviewer
    on reviewer.user_id = review.reviewer_id
  left join app_private.practice_worksheet_template_releases as release
    on release.revision_id = revision.id
  left join app_private.practice_worksheet_bank_reviewers as releaser
    on releaser.user_id = release.released_by
  cross join canonical_immutable_controls as immutable
  where revision.state = 'released'
), model_cache_immutable_controls as (
  select (
    exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_model_cache_revisions'
        and trigger.tgname = 'practice_worksheet_model_cache_revisions_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_model_cache_questions'
        and trigger.tgname = 'practice_worksheet_model_cache_questions_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'app_private'
        and relation.relname = 'practice_worksheet_model_cache_withdrawals'
        and trigger.tgname = 'practice_worksheet_model_cache_withdrawals_immutable'
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
    )
  ) as controls_present
), model_validated_cache as (
  select
    revision.id::text as revision_id,
    revision.level::text as level,
    topic.slug::text as topic_slug,
    revision.difficulty::text as difficulty,
    revision.generator_provider::text as generator_provider,
    revision.generator_model::text as generator_model,
    revision.validation_profile::text as validation_profile,
    coalesce(
      revision.validation_metadata ->> 'deterministic' = 'true'
      and app_private.model_cache_validation_checks_pass(
        revision.validation_metadata -> 'checks'
      )
      and case
        when jsonb_typeof(
          revision.validation_metadata -> 'rejection_reasons'
        ) = 'array'
          then jsonb_array_length(
            revision.validation_metadata -> 'rejection_reasons'
          ) = 0
        else false
      end,
      false
    ) as deterministic_validation_passed,
    coalesce(
      revision.validation_metadata ->> 'independent_model' = 'true'
      and revision.validation_metadata ->> 'candidate_sha256'
        = revision.candidate_sha256
      and revision.validation_metadata #>> '{critics,deepseek,provider}'
        = revision.primary_critic_provider
      and revision.validation_metadata #>> '{critics,deepseek,model}'
        = revision.primary_critic_model
      and revision.validation_metadata #>> '{critics,deepseek,candidate_sha256}'
        = revision.candidate_sha256
      and revision.validation_metadata #>> '{critics,deepseek,approved}' = 'true'
      and app_private.model_cache_validation_checks_pass(
        revision.validation_metadata #> '{critics,deepseek,checks}'
      )
      and case
        when jsonb_typeof(
          revision.validation_metadata #> '{critics,deepseek,rejection_reasons}'
        ) = 'array'
          then jsonb_array_length(
            revision.validation_metadata #> '{critics,deepseek,rejection_reasons}'
          ) = 0
        else false
      end
      and revision.validation_metadata #>> '{critics,deepseek,verdict_sha256}'
        = revision.primary_verdict_sha256
      and app_private.worksheet_critic_verdict_sha256(
        revision.validation_metadata #> '{critics,deepseek}'
      ) = revision.primary_verdict_sha256
      and revision.validation_metadata #>> '{critics,gemini,provider}'
        = revision.secondary_critic_provider
      and revision.validation_metadata #>> '{critics,gemini,model}'
        = revision.secondary_critic_model
      and revision.validation_metadata #>> '{critics,gemini,candidate_sha256}'
        = revision.candidate_sha256
      and revision.validation_metadata #>> '{critics,gemini,approved}' = 'true'
      and app_private.model_cache_validation_checks_pass(
        revision.validation_metadata #> '{critics,gemini,checks}'
      )
      and case
        when jsonb_typeof(
          revision.validation_metadata #> '{critics,gemini,rejection_reasons}'
        ) = 'array'
          then jsonb_array_length(
            revision.validation_metadata #> '{critics,gemini,rejection_reasons}'
          ) = 0
        else false
      end
      and revision.validation_metadata #>> '{critics,gemini,verdict_sha256}'
        = revision.secondary_verdict_sha256
      and app_private.worksheet_critic_verdict_sha256(
        revision.validation_metadata #> '{critics,gemini}'
      ) = revision.secondary_verdict_sha256,
      false
    ) as independent_model_validation_passed,
    revision.source_practice_test_id::text as source_practice_test_id,
    revision.source_completion_job_id::text as source_completion_job_id,
    revision.candidate_sha256::text as candidate_sha256,
    revision.primary_critic_provider::text as primary_critic_provider,
    revision.primary_critic_model::text as primary_critic_model,
    revision.primary_verdict_sha256::text as primary_verdict_sha256,
    revision.secondary_critic_provider::text as secondary_critic_provider,
    revision.secondary_critic_model::text as secondary_critic_model,
    revision.secondary_verdict_sha256::text as secondary_verdict_sha256,
    revision.content_sha256::text as content_sha256,
    app_private.practice_worksheet_model_cache_revision_sha256(revision.id)
      as recomputed_content_sha256,
    revision.promoted_at::text as promoted_at,
    exists (
      select 1
      from app_private.practice_worksheet_model_cache_withdrawals as withdrawal
      where withdrawal.revision_id = revision.id
    ) as withdrawn,
    app_private.practice_worksheet_model_cache_revision_is_current(revision.id)
      as is_current,
    immutable.controls_present as immutable_controls_present
  from app_private.practice_worksheet_model_cache_revisions as revision
  join public.grammar_topics as topic
    on topic.id = revision.grammar_topic_id
  cross join model_cache_immutable_controls as immutable
)
select jsonb_build_object(
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'revision_id', classified.revision_id,
      'level', classified.level,
      'generation_source', classified.generation_source,
      'generator_model', classified.generator_model,
      'approval_source', classified.approval_source,
      'created_by_ai', classified.created_by_ai,
      'teacher_reviewed', classified.teacher_reviewed,
      'visibility', classified.visibility,
      'quality_status', classified.quality_status,
      'content_sha256', classified.content_sha256,
      'answer_contract_v1', classified.answer_contract_v1,
      'has_student_use', classified.has_student_use,
      'system_validation_passed', classified.system_validation_passed,
      'reviewed_by_present', classified.reviewed_by_present,
      'reviewed_at_present', classified.reviewed_at_present,
      'worksheet_model_cache_revision_id', classified.worksheet_model_cache_revision_id,
      'model_cache_content_sha256', classified.model_cache_content_sha256,
      'disposition', classified.disposition
    ) order by classified.revision_id)
    from classified
  ), '[]'::jsonb),
  'canonical_bank', coalesce((
    select jsonb_agg(jsonb_build_object(
      'revision_id', canonical.revision_id,
      'template_id', canonical.template_id,
      'template_key', canonical.template_key,
      'level', canonical.level,
      'topic_slug', canonical.topic_slug,
      'state', canonical.state,
      'content_sha256', canonical.content_sha256,
      'recomputed_content_sha256', canonical.recomputed_content_sha256,
      'review_id', canonical.review_id,
      'reviewer_id', canonical.reviewer_id,
      'review_decision', canonical.review_decision,
      'review_checklist_complete', canonical.review_checklist_complete,
      'review_content_sha256', canonical.review_content_sha256,
      'reviewed_at', canonical.reviewed_at,
      'reviewer_qualified', canonical.reviewer_qualified,
      'bank_release_id', canonical.bank_release_id,
      'release_review_id', canonical.release_review_id,
      'released_by', canonical.released_by,
      'release_content_sha256', canonical.release_content_sha256,
      'released_at', canonical.released_at,
      'releaser_qualified', canonical.releaser_qualified,
      'immutable_controls_present', canonical.immutable_controls_present
    ) order by canonical.revision_id)
    from canonical_bank as canonical
  ), '[]'::jsonb),
  'model_validated_cache', coalesce((
    select jsonb_agg(jsonb_build_object(
      'revision_id', cache.revision_id,
      'level', cache.level,
      'topic_slug', cache.topic_slug,
      'difficulty', cache.difficulty,
      'generator_provider', cache.generator_provider,
      'generator_model', cache.generator_model,
      'validation_profile', cache.validation_profile,
      'deterministic_validation_passed', cache.deterministic_validation_passed,
      'independent_model_validation_passed', cache.independent_model_validation_passed,
      'source_practice_test_id', cache.source_practice_test_id,
      'source_completion_job_id', cache.source_completion_job_id,
      'candidate_sha256', cache.candidate_sha256,
      'primary_critic_provider', cache.primary_critic_provider,
      'primary_critic_model', cache.primary_critic_model,
      'primary_verdict_sha256', cache.primary_verdict_sha256,
      'secondary_critic_provider', cache.secondary_critic_provider,
      'secondary_critic_model', cache.secondary_critic_model,
      'secondary_verdict_sha256', cache.secondary_verdict_sha256,
      'content_sha256', cache.content_sha256,
      'recomputed_content_sha256', cache.recomputed_content_sha256,
      'promoted_at', cache.promoted_at,
      'withdrawn', cache.withdrawn,
      'is_current', cache.is_current,
      'immutable_controls_present', cache.immutable_controls_present
    ) order by cache.revision_id)
    from model_validated_cache as cache
  ), '[]'::jsonb)
) as inventory;`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstRecord(value: unknown) {
  if (Array.isArray(value) && isRecord(value[0])) return value[0];
  if (isRecord(value)) {
    if (Array.isArray(value.data) && isRecord(value.data[0]))
      return value.data[0];
    if (Array.isArray(value.result) && isRecord(value.result[0]))
      return value.result[0];
  }
  return null;
}

const rowKeys = [
  "revision_id",
  "level",
  "generation_source",
  "generator_model",
  "approval_source",
  "created_by_ai",
  "teacher_reviewed",
  "visibility",
  "quality_status",
  "content_sha256",
  "answer_contract_v1",
  "has_student_use",
  "system_validation_passed",
  "reviewed_by_present",
  "reviewed_at_present",
  "worksheet_model_cache_revision_id",
  "model_cache_content_sha256",
  "disposition",
] as const;

const modelValidatedCacheRowKeys = [
  "revision_id",
  "level",
  "topic_slug",
  "difficulty",
  "generator_provider",
  "generator_model",
  "validation_profile",
  "deterministic_validation_passed",
  "independent_model_validation_passed",
  "source_practice_test_id",
  "source_completion_job_id",
  "candidate_sha256",
  "primary_critic_provider",
  "primary_critic_model",
  "primary_verdict_sha256",
  "secondary_critic_provider",
  "secondary_critic_model",
  "secondary_verdict_sha256",
  "content_sha256",
  "recomputed_content_sha256",
  "promoted_at",
  "withdrawn",
  "is_current",
  "immutable_controls_present",
] as const;

const canonicalBankRowKeys = [
  "revision_id",
  "template_id",
  "template_key",
  "level",
  "topic_slug",
  "state",
  "content_sha256",
  "recomputed_content_sha256",
  "review_id",
  "reviewer_id",
  "review_decision",
  "review_checklist_complete",
  "review_content_sha256",
  "reviewed_at",
  "reviewer_qualified",
  "bank_release_id",
  "release_review_id",
  "released_by",
  "release_content_sha256",
  "released_at",
  "releaser_qualified",
  "immutable_controls_present",
] as const;

/** Keep only the fixed content-free inventory fields returned by the query. */
export function sanitizeCollectedWorksheetRows(value: unknown) {
  const first = firstRecord(value);
  const inventory = first && isRecord(first.inventory) ? first.inventory : null;
  const rows = inventory && Array.isArray(inventory.rows) ? inventory.rows : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const sanitized = Object.fromEntries(rowKeys.map((key) => [key, row[key]]));
    if (Object.values(sanitized).some((entry) => entry === undefined))
      return [];
    return [sanitized as unknown as ProductionWorksheetInventoryRow];
  });
}

/** Keep only content-free certification and hash-chain fields for the bank. */
export function sanitizeCollectedCanonicalBankRows(value: unknown) {
  const first = firstRecord(value);
  const inventory = first && isRecord(first.inventory) ? first.inventory : null;
  const rows =
    inventory && Array.isArray(inventory.canonical_bank)
      ? inventory.canonical_bank
      : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const sanitized = Object.fromEntries(
      canonicalBankRowKeys.map((key) => [key, row[key]]),
    );
    if (Object.values(sanitized).some((entry) => entry === undefined))
      return [];
    return [sanitized as unknown as ProductionCanonicalWorksheetBankRow];
  });
}

/** Keep only content-free provider, critic, hash, and lifecycle cache fields. */
export function sanitizeCollectedModelValidatedCacheRows(value: unknown) {
  const first = firstRecord(value);
  const inventory = first && isRecord(first.inventory) ? first.inventory : null;
  const rows =
    inventory && Array.isArray(inventory.model_validated_cache)
      ? inventory.model_validated_cache
      : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const sanitized = Object.fromEntries(
      modelValidatedCacheRowKeys.map((key) => [key, row[key]]),
    );
    if (Object.values(sanitized).some((entry) => entry === undefined))
      return [];
    return [sanitized as unknown as ProductionModelValidatedWorksheetCacheRow];
  });
}

export async function collectProductionWorksheetInventory(input: {
  accessToken: string;
  appRelease: string;
  projectRef: string;
  collectedAt?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!input.accessToken.trim())
    throw new Error("SUPABASE_ACCESS_TOKEN is required.");
  if (!RELEASE_PATTERN.test(input.appRelease))
    throw new Error("Release id is invalid.");
  if (!PROJECT_REF_PATTERN.test(input.projectRef))
    throw new Error("Project ref is invalid.");
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(collectedAt)))
    throw new Error("Collection time is invalid.");

  const response = await (input.fetchImpl ?? fetch)(
    `https://api.supabase.com/v1/projects/${input.projectRef}/database/query/read-only`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: PRODUCTION_WORKSHEET_INVENTORY_QUERY }),
    },
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Production worksheet inventory query failed.");
  }
  const value = (await response.json()) as unknown;
  const rows = sanitizeCollectedWorksheetRows(value);
  const canonicalBank = sanitizeCollectedCanonicalBankRows(value);
  const modelValidatedCache = sanitizeCollectedModelValidatedCacheRows(value);
  const first = firstRecord(value);
  const rawInventory =
    first && isRecord(first.inventory) ? first.inventory : null;
  const rawRows =
    rawInventory && Array.isArray(rawInventory.rows) ? rawInventory.rows : null;
  const rawCanonicalBank =
    rawInventory && Array.isArray(rawInventory.canonical_bank)
      ? rawInventory.canonical_bank
      : null;
  const rawModelValidatedCache =
    rawInventory && Array.isArray(rawInventory.model_validated_cache)
      ? rawInventory.model_validated_cache
      : null;
  if (
    !rawRows ||
    !rawCanonicalBank ||
    !rawModelValidatedCache ||
    rows.length !== rawRows.length ||
    canonicalBank.length !== rawCanonicalBank.length ||
    modelValidatedCache.length !== rawModelValidatedCache.length
  ) {
    throw new Error("Production worksheet inventory response is malformed.");
  }
  return {
    schema_version: 4,
    hash_origin: "db_recomputed_v1",
    app_release: input.appRelease,
    project_ref: input.projectRef,
    collected_at: collectedAt,
    rows,
    canonical_bank: canonicalBank,
    model_validated_cache: modelValidatedCache,
  } satisfies ProductionWorksheetInventoryEvidence;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const appRelease = argument("--release");
  const projectRef = argument("--project-ref");
  const output = argument("--output");
  if (!appRelease || !projectRef || !output) {
    throw new Error(
      "Usage: worksheet-inventory:collect -- --release <release> --project-ref <ref> --output <production-inventory.json>",
    );
  }
  const evidence = await collectProductionWorksheetInventory({
    accessToken: process.env.SUPABASE_ACCESS_TOKEN ?? "",
    appRelease,
    projectRef,
  });
  const handle = await open(resolve(output), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, rows: evidence.rows.length, model_validated_cache: evidence.model_validated_cache.length, output: resolve(output) })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Worksheet inventory collection failed."}\n`,
    );
    process.exitCode = 1;
  });
}
