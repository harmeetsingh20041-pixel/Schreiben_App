import {
  PINNED_AUTHENTICATED_SUPABASE_URL,
  PINNED_HOSTED_STAGING_APP_URL,
} from "../../../scripts/run-authenticated-playwright";

export const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
export const PINNED_HOSTED_STAGING_MANIFEST_URL = `${PINNED_HOSTED_STAGING_APP_URL}/launch-manifest.json`;
export const HOSTED_STAGING_PREFLIGHT_ERROR =
  "Hosted staging safety preflight failed before authentication.";

type ManifestFetch = (input: string, init: RequestInit) => Promise<Response>;

function validManifest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.schema_version === 1 &&
    manifest.supabase_url === PINNED_AUTHENTICATED_SUPABASE_URL &&
    manifest.supabase_project_ref === PINNED_STAGING_PROJECT_REF &&
    manifest.base_path === "/" &&
    manifest.demo_mode_enabled === false &&
    manifest.public_teacher_signup_enabled === false &&
    manifest.public_student_signup_enabled === true
  );
}

export async function validatePinnedHostedStagingManifest(
  fetchManifest: ManifestFetch = globalThis.fetch,
) {
  try {
    const response = await fetchManifest(PINNED_HOSTED_STAGING_MANIFEST_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !response.ok ||
      response.url !== PINNED_HOSTED_STAGING_MANIFEST_URL ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json") ||
      !validManifest(await response.json())
    ) {
      throw new Error(HOSTED_STAGING_PREFLIGHT_ERROR);
    }
  } catch {
    throw new Error(HOSTED_STAGING_PREFLIGHT_ERROR);
  }
}

export function assertPinnedHostedStagingPageOrigin(pageUrl: string) {
  try {
    const actual = new URL(pageUrl);
    const expected = new URL(PINNED_HOSTED_STAGING_APP_URL);
    if (actual.origin === expected.origin) return;
  } catch {
    // The stable error below deliberately excludes the untrusted URL.
  }
  throw new Error(
    "Hosted staging navigation left the repository-pinned application origin.",
  );
}
