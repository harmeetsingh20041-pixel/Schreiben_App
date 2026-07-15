import { PublicAppError, type PublicErrorCode } from "@/lib/appError";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabaseClient";
import { isSignupEnabled } from "@/lib/launchConfig";
import { callApiRpc, parseApiArray } from "@/services/apiFacade";
import type { WorkspaceRole } from "@/types/database";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";

export type AuthRole = "student" | "teacher" | null;
export type SignupAccountType = Exclude<AuthRole, null>;
export type AuthCallbackKind = "password_recovery" | "email_confirmation";

export interface AuthCallbackState {
  version: 1;
  kind: AuthCallbackKind;
  userId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthProfile {
  id: string;
  full_name: string | null;
  email: string;
  global_role: "platform_admin" | "teacher" | "student";
}

export interface AuthWorkspaceMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  workspace_name?: string;
  workspace_slug?: string;
  created_at?: string;
}

export interface AuthSnapshot {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  workspaceMemberships: AuthWorkspaceMembership[];
  activeMembershipId: string | null;
  activeWorkspaceId: string | null;
  role: AuthRole;
  needsWorkspace: boolean;
  isPlatformAdmin: boolean;
  teacherEntitled: boolean;
  canCreateTeacherWorkspace: boolean;
}

export type MfaAssuranceLevel = "aal1" | "aal2" | null;

export interface TotpFactorSummary {
  id: string;
  friendlyName: string;
  status: "verified" | "unverified";
  createdAt: string | null;
}

export interface MfaState {
  currentLevel: MfaAssuranceLevel;
  nextLevel: MfaAssuranceLevel;
  totpFactors: TotpFactorSummary[];
  verifiedTotpFactors: TotpFactorSummary[];
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

export interface SignUpResult {
  email: string;
  requiresEmailConfirmation: boolean;
}

export interface ResolvedAuthAccess {
  workspaceMemberships: AuthWorkspaceMembership[];
  activeMembership: AuthWorkspaceMembership | null;
  role: AuthRole;
  needsWorkspace: boolean;
}

type AuthOperation =
  | "sign_in"
  | "sign_up"
  | "resend_confirmation"
  | "request_password_reset"
  | "update_password"
  | "sign_out"
  | "load_context"
  | "create_workspace"
  | "mfa";

interface TrustedAuthContextMembership {
  membership_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  role: WorkspaceRole;
  created_at: string;
}

interface TrustedAuthContextRow {
  user_id: string;
  full_name: string | null;
  email: string;
  global_role: AuthProfile["global_role"];
  teacher_entitled: boolean;
  teacher_workspace_count: number;
  teacher_workspace_limit: number;
  can_create_teacher_workspace: boolean;
  memberships: TrustedAuthContextMembership[];
}

const OPERATION_FALLBACKS: Record<
  AuthOperation,
  { code: PublicErrorCode; message: string }
> = {
  sign_in: {
    code: "auth_sign_in_failed",
    message: "We couldn't sign you in. Check your details and try again.",
  },
  sign_up: {
    code: "auth_sign_up_failed",
    message: "We couldn't create your account. Please try again.",
  },
  resend_confirmation: {
    code: "auth_confirmation_failed",
    message:
      "We couldn't resend the confirmation email. Please try again shortly.",
  },
  request_password_reset: {
    code: "auth_password_reset_failed",
    message:
      "We couldn't send a password reset email. Please try again shortly.",
  },
  update_password: {
    code: "auth_password_update_failed",
    message:
      "We couldn't update your password. Request a new reset link and try again.",
  },
  sign_out: {
    code: "auth_sign_out_failed",
    message: "We couldn't sign you out safely. Please refresh and try again.",
  },
  load_context: {
    code: "auth_context_failed",
    message: "We couldn't load your account access. Please sign in again.",
  },
  create_workspace: {
    code: "auth_workspace_failed",
    message: "We couldn't create your workspace. Please try again.",
  },
  mfa: {
    code: "auth_mfa_failed",
    message: "We couldn't verify your authenticator. Please try again.",
  },
};

const AUTH_CALLBACK_STORAGE_KEY = "gwc_auth_callback_state";
export const AUTH_CALLBACK_TTL_MS = 10 * 60 * 1000;
const AUTH_CALLBACK_CLOCK_SKEW_MS = 30 * 1000;

function readCallbackParameters(value: string) {
  const cleanValue =
    value.startsWith("#") || value.startsWith("?") ? value.slice(1) : value;
  return new URLSearchParams(cleanValue);
}

export function detectAuthCallbackIntent(
  location: Pick<Location, "pathname" | "search" | "hash">,
): AuthCallbackKind | null {
  const search = readCallbackParameters(location.search);
  const hash = readCallbackParameters(location.hash);
  if (
    search.has("error") ||
    search.has("error_code") ||
    hash.has("error") ||
    hash.has("error_code")
  ) {
    return null;
  }

  const callbackType = (
    hash.get("type") ??
    search.get("type") ??
    ""
  ).toLowerCase();
  // V1 accepts only the PKCE authorization-code callback. The Supabase client
  // rejects implicit access-token fragments when configured for PKCE, so the
  // UI must not treat an unbound legacy fragment as a successful callback.
  const hasCallbackCredential = Boolean(search.get("code"));

  if (
    location.pathname.endsWith("/auth/reset-password") &&
    hasCallbackCredential &&
    (!callbackType || callbackType === "recovery")
  ) {
    return "password_recovery";
  }
  if (
    location.pathname.endsWith("/auth/confirm") &&
    hasCallbackCredential &&
    (!callbackType ||
      ["signup", "email", "email_change", "magiclink"].includes(callbackType))
  ) {
    return "email_confirmation";
  }
  return null;
}

// Supabase starts consuming an auth redirect as soon as its browser client is
// created. Capture the intent synchronously so the later auth event can still
// be tied to the callback even if Supabase has already cleaned the URL.
let pendingAuthCallbackIntent =
  typeof window === "undefined"
    ? null
    : detectAuthCallbackIntent(window.location);

export function hasPendingAuthCallbackIntent(kind: AuthCallbackKind) {
  if (pendingAuthCallbackIntent === kind) return true;
  if (typeof window === "undefined") return false;
  return detectAuthCallbackIntent(window.location) === kind;
}

export function consumeAuthCallbackIntent(kind: AuthCallbackKind) {
  if (!hasPendingAuthCallbackIntent(kind)) return false;
  pendingAuthCallbackIntent = null;
  return true;
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  const encodedPayload = accessToken.split(".")[1];
  if (!encodedPayload || typeof globalThis.atob !== "function") return null;

  try {
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = globalThis.atob(`${normalized}${padding}`);
    const payload = JSON.parse(decoded) as unknown;
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getSessionBinding(session: Session | null) {
  if (!session?.user.id) return null;
  const payload = decodeJwtPayload(session.access_token);
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return null;
  return { userId: session.user.id, sessionId };
}

export function createAuthCallbackState(
  kind: AuthCallbackKind,
  session: Session | null,
  now = Date.now(),
): AuthCallbackState | null {
  const binding = getSessionBinding(session);
  if (!binding || !Number.isFinite(now)) return null;
  return {
    version: 1,
    kind,
    userId: binding.userId,
    sessionId: binding.sessionId,
    issuedAt: now,
    expiresAt: now + AUTH_CALLBACK_TTL_MS,
  };
}

export function isRecentEmailConfirmationSession(
  session: Session | null,
  now = Date.now(),
) {
  const confirmedAt = session?.user.email_confirmed_at;
  if (!confirmedAt) return false;
  const confirmedAtMs = Date.parse(confirmedAt);
  return (
    Number.isFinite(confirmedAtMs) &&
    confirmedAtMs <= now + AUTH_CALLBACK_CLOCK_SKEW_MS &&
    now - confirmedAtMs <= AUTH_CALLBACK_TTL_MS
  );
}

export function isAuthCallbackStateValid(
  state: unknown,
  kind: AuthCallbackKind,
  session: Session | null,
  now = Date.now(),
): state is AuthCallbackState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<AuthCallbackState>;
  const binding = getSessionBinding(session);
  if (!binding) return false;
  if (
    candidate.version !== 1 ||
    candidate.kind !== kind ||
    candidate.userId !== binding.userId ||
    candidate.sessionId !== binding.sessionId ||
    typeof candidate.issuedAt !== "number" ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.issuedAt) ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    return false;
  }
  if (
    candidate.issuedAt > now + AUTH_CALLBACK_CLOCK_SKEW_MS ||
    candidate.expiresAt <= now ||
    candidate.expiresAt <= candidate.issuedAt ||
    candidate.expiresAt - candidate.issuedAt > AUTH_CALLBACK_TTL_MS
  ) {
    return false;
  }
  if (session?.expires_at && session.expires_at * 1000 <= now) return false;
  return true;
}

export function authCallbackStatesMatch(
  left: AuthCallbackState | null,
  right: AuthCallbackState | null,
) {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.kind === right.kind &&
    left.userId === right.userId &&
    left.sessionId === right.sessionId &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt,
  );
}

export function persistAuthCallbackState(
  kind: AuthCallbackKind,
  session: Session | null,
  now = Date.now(),
) {
  const state = createAuthCallbackState(kind, session, now);
  if (!state || typeof window === "undefined") return null;
  try {
    window.sessionStorage.setItem(
      AUTH_CALLBACK_STORAGE_KEY,
      JSON.stringify(state),
    );
    return state;
  } catch {
    return null;
  }
}

export function clearAuthCallbackState() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(AUTH_CALLBACK_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in locked-down browsers. Failing closed is
    // safe because no callback state can then be restored or consumed.
  }
}

export function readStoredAuthCallbackState(
  session: Session | null,
  now = Date.now(),
) {
  if (typeof window === "undefined") return null;
  try {
    const rawState = window.sessionStorage.getItem(AUTH_CALLBACK_STORAGE_KEY);
    const state = rawState ? (JSON.parse(rawState) as unknown) : null;
    if (
      state &&
      typeof state === "object" &&
      ((state as Partial<AuthCallbackState>).kind === "password_recovery" ||
        (state as Partial<AuthCallbackState>).kind === "email_confirmation")
    ) {
      const kind = (state as AuthCallbackState).kind;
      if (isAuthCallbackStateValid(state, kind, session, now)) return state;
    }
  } catch {
    // Treat malformed or inaccessible client storage as an invalid callback.
  }
  clearAuthCallbackState();
  return null;
}

export function readAuthCallbackState(
  kind: AuthCallbackKind,
  session: Session | null,
  now = Date.now(),
) {
  const state = readStoredAuthCallbackState(session, now);
  return state?.kind === kind ? state : null;
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new PublicAppError(
      "auth_context_failed",
      "Sign-in is unavailable because the application is not configured.",
    );
  }
  return client;
}

function readAuthErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toLowerCase() : "";
}

function readAuthErrorMessage(error: unknown) {
  if (!error || typeof error !== "object" || !("message" in error)) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.toLowerCase() : "";
}

function toPublicAuthError(error: unknown, operation: AuthOperation) {
  if (error instanceof PublicAppError) return error;

  const code = readAuthErrorCode(error);
  const message = readAuthErrorMessage(error);

  if (
    code === "invalid_credentials" ||
    message.includes("invalid login credentials")
  ) {
    return new PublicAppError(
      "auth_invalid_credentials",
      "The email or password is incorrect.",
    );
  }
  if (
    code === "email_not_confirmed" ||
    message.includes("email not confirmed")
  ) {
    return new PublicAppError(
      "auth_email_unconfirmed",
      "Confirm your email before signing in.",
    );
  }
  if (code === "over_email_send_rate_limit") {
    return new PublicAppError(
      "auth_rate_limited",
      "Confirmation email capacity is temporarily busy. Please try again shortly.",
    );
  }
  if (
    code === "over_request_rate_limit" ||
    code === "too_many_requests" ||
    message.includes("rate limit")
  ) {
    return new PublicAppError(
      "auth_rate_limited",
      "Too many attempts. Wait a few minutes before trying again.",
    );
  }
  if (code === "weak_password" || message.includes("password should be")) {
    return new PublicAppError(
      "auth_weak_password",
      "Choose a stronger password with at least 8 characters.",
    );
  }
  if (code === "email_address_invalid" || message.includes("invalid email")) {
    return new PublicAppError(
      "auth_invalid_email",
      "Enter a valid email address.",
    );
  }
  if (code === "signup_disabled") {
    return new PublicAppError(
      "auth_signup_disabled",
      "Account creation is not available right now.",
    );
  }
  if (code === "same_password") {
    return new PublicAppError(
      "auth_password_update_failed",
      "Choose a password you have not used for this account.",
    );
  }
  if (
    code === "session_not_found" ||
    code === "refresh_token_not_found" ||
    code === "otp_expired" ||
    code === "reauthentication_needed" ||
    message.includes("session missing") ||
    message.includes("token has expired")
  ) {
    return new PublicAppError(
      "auth_session_expired",
      "This link has expired or was already used. Request a new one.",
    );
  }
  if (
    code === "mfa_challenge_expired" ||
    code === "mfa_verification_failed" ||
    code === "invalid_totp" ||
    message.includes("invalid totp") ||
    message.includes("invalid verification code") ||
    message.includes("challenge has expired")
  ) {
    return new PublicAppError(
      "auth_mfa_code_invalid",
      "That authenticator code is invalid or expired. Enter the current code and try again.",
    );
  }

  const fallback = OPERATION_FALLBACKS[operation];
  return new PublicAppError(fallback.code, fallback.message);
}

function getAuthRedirectUrl(path: string) {
  const basePath = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  const cleanPath = path.replace(/^\//, "");
  return new URL(`${basePath}${cleanPath}`, window.location.origin).toString();
}

function isTeacherMembership(membership: AuthWorkspaceMembership) {
  return membership.role === "owner" || membership.role === "teacher";
}

function membershipRole(
  membership: AuthWorkspaceMembership,
): Exclude<AuthRole, null> {
  return isTeacherMembership(membership) ? "teacher" : "student";
}

function membershipRank(membership: AuthWorkspaceMembership) {
  if (membership.role === "owner") return 0;
  if (membership.role === "teacher") return 1;
  return 2;
}

function sortMemberships(memberships: AuthWorkspaceMembership[]) {
  return [...memberships].sort((left, right) => {
    const rankDifference = membershipRank(left) - membershipRank(right);
    if (rankDifference !== 0) return rankDifference;
    const workspaceDifference = left.workspace_id.localeCompare(
      right.workspace_id,
    );
    return workspaceDifference || left.id.localeCompare(right.id);
  });
}

function chooseActiveMembership(
  memberships: AuthWorkspaceMembership[],
  preferredMembershipId?: string | null,
) {
  const orderedMemberships = sortMemberships(memberships);
  if (!preferredMembershipId) return orderedMemberships;

  const preferred = orderedMemberships.find(
    (membership) => membership.id === preferredMembershipId,
  );
  if (!preferred) return orderedMemberships;

  return [
    preferred,
    ...orderedMemberships.filter(
      (membership) => membership.id !== preferred.id,
    ),
  ];
}

export function resolveAuthAccess(
  memberships: AuthWorkspaceMembership[],
  preferredMembershipId: string | null | undefined,
  teacherEntitled: boolean,
  canCreateTeacherWorkspace: boolean,
): ResolvedAuthAccess {
  const workspaceMemberships = chooseActiveMembership(
    memberships,
    preferredMembershipId,
  );
  const needsWorkspace =
    canCreateTeacherWorkspace &&
    !workspaceMemberships.some(isTeacherMembership);

  // An entitled pilot teacher can also have student memberships. While that
  // teacher still needs a teacher workspace, do not let an unrelated student
  // membership win routing or become the active workspace for onboarding.
  if (needsWorkspace) {
    return {
      workspaceMemberships,
      activeMembership: null,
      role: "teacher",
      needsWorkspace: true,
    };
  }

  const activeMembership = workspaceMemberships[0] ?? null;
  return {
    workspaceMemberships,
    activeMembership,
    role: activeMembership
      ? membershipRole(activeMembership)
      : teacherEntitled
        ? "teacher"
        : "student",
    needsWorkspace: false,
  };
}

function normalizeTrustedAuthContext(
  data: unknown,
): TrustedAuthContextRow | null {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Partial<TrustedAuthContextRow>;
  if (
    typeof row.user_id !== "string" ||
    typeof row.email !== "string" ||
    !["platform_admin", "teacher", "student"].includes(
      String(row.global_role),
    ) ||
    typeof row.teacher_entitled !== "boolean" ||
    typeof row.can_create_teacher_workspace !== "boolean" ||
    typeof row.teacher_workspace_count !== "number" ||
    typeof row.teacher_workspace_limit !== "number" ||
    !Array.isArray(row.memberships) ||
    !row.memberships.every(
      (membership) =>
        membership &&
        typeof membership === "object" &&
        typeof membership.membership_id === "string" &&
        typeof membership.workspace_id === "string" &&
        typeof membership.workspace_name === "string" &&
        typeof membership.workspace_slug === "string" &&
        ["owner", "teacher", "student"].includes(String(membership.role)) &&
        typeof membership.created_at === "string",
    )
  ) {
    return null;
  }
  return row as TrustedAuthContextRow;
}

async function loadTrustedAuthContext(
  client: ReturnType<typeof requireClient>,
) {
  // The generated Database type is updated separately from migrations. Keep
  // this cast narrow so staged frontend/backend rollouts remain possible.
  const rpcClient = client as unknown as {
    rpc: (name: "get_auth_context") => Promise<{
      data: unknown;
      error: { code?: string; message?: string } | null;
    }>;
  };
  const { data, error } = await rpcClient.rpc("get_auth_context");
  if (error) {
    throw error;
  }

  const context = normalizeTrustedAuthContext(data);
  if (!context)
    throw new Error("Trusted auth context returned an invalid shape.");
  return context;
}

export function canUseSupabaseAuth() {
  return isSupabaseConfigured;
}

export async function signInWithEmailPassword(email: string, password: string) {
  const client = requireClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw toPublicAuthError(error, "sign_in");
  if (!data.session) {
    throw new PublicAppError(
      "auth_sign_in_failed",
      "We couldn't confirm your sign-in session. Please try again.",
    );
  }
  return data.session;
}

function normalizeMfaLevel(value: unknown): MfaAssuranceLevel {
  return value === "aal1" || value === "aal2" ? value : null;
}

function normalizeTotpFactor(value: unknown): TotpFactorSummary | null {
  if (!value || typeof value !== "object") return null;
  const factor = value as {
    id?: unknown;
    friendly_name?: unknown;
    status?: unknown;
    created_at?: unknown;
  };
  if (
    typeof factor.id !== "string" ||
    (factor.status !== "verified" && factor.status !== "unverified")
  ) {
    return null;
  }
  return {
    id: factor.id,
    friendlyName:
      typeof factor.friendly_name === "string" && factor.friendly_name.trim()
        ? factor.friendly_name.trim()
        : "Authenticator",
    status: factor.status,
    createdAt: typeof factor.created_at === "string" ? factor.created_at : null,
  };
}

const PRIMARY_AUTHENTICATOR_NAME = "primary authenticator";

function totpFactorTimestamp(factor: TotpFactorSummary) {
  if (!factor.createdAt) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(factor.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

/**
 * Supabase does not guarantee the order returned by listFactors. Keep the
 * product-created primary factor first, then use the oldest enrollment and
 * deterministic fallbacks so a fresh code is never silently aimed at a
 * different authenticator after a reload.
 */
export function sortTotpFactors(
  factors: TotpFactorSummary[],
): TotpFactorSummary[] {
  return [...factors].sort((left, right) => {
    const primaryDifference =
      Number(
        right.friendlyName.trim().toLowerCase() === PRIMARY_AUTHENTICATOR_NAME,
      ) -
      Number(
        left.friendlyName.trim().toLowerCase() === PRIMARY_AUTHENTICATOR_NAME,
      );
    if (primaryDifference !== 0) return primaryDifference;

    const leftTimestamp = totpFactorTimestamp(left);
    const rightTimestamp = totpFactorTimestamp(right);
    if (leftTimestamp !== rightTimestamp) {
      return leftTimestamp < rightTimestamp ? -1 : 1;
    }

    const nameDifference = left.friendlyName.localeCompare(
      right.friendlyName,
      "en",
      { sensitivity: "base" },
    );
    return nameDifference || left.id.localeCompare(right.id);
  });
}

export async function getMfaState(): Promise<MfaState> {
  const client = requireClient();
  try {
    const [assuranceResult, factorsResult] = await Promise.all([
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
      client.auth.mfa.listFactors(),
    ]);
    if (assuranceResult.error) throw assuranceResult.error;
    if (factorsResult.error) throw factorsResult.error;

    const totpFactors = sortTotpFactors(
      (factorsResult.data?.totp ?? [])
        .map(normalizeTotpFactor)
        .filter((factor): factor is TotpFactorSummary => factor !== null),
    );
    return {
      currentLevel: normalizeMfaLevel(assuranceResult.data.currentLevel),
      nextLevel: normalizeMfaLevel(assuranceResult.data.nextLevel),
      totpFactors,
      verifiedTotpFactors: totpFactors.filter(
        (factor) => factor.status === "verified",
      ),
    };
  } catch (error) {
    throw toPublicAuthError(error, "mfa");
  }
}

export async function enrollTotpFactor(
  friendlyName: string,
): Promise<TotpEnrollment> {
  const client = requireClient();
  try {
    const { data, error } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: friendlyName.trim() || "Authenticator",
    });
    if (error) throw error;
    if (
      !data?.id ||
      !data.totp?.qr_code ||
      !data.totp.secret ||
      !data.totp.uri
    ) {
      throw new Error("TOTP enrollment returned an invalid shape.");
    }
    return {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
  } catch (error) {
    throw toPublicAuthError(error, "mfa");
  }
}

export async function verifyTotpFactor(factorId: string, code: string) {
  const client = requireClient();
  try {
    const normalizedCode = code.replace(/\s+/g, "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        factorId,
      ) ||
      !/^\d{6}$/.test(normalizedCode)
    ) {
      throw new PublicAppError(
        "auth_mfa_code_invalid",
        "Enter the current six-digit code from a verified authenticator.",
      );
    }
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId,
      code: normalizedCode,
    });
    if (error) throw error;
    const { data: sessionData, error: sessionError } =
      await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) {
      throw new Error("TOTP verification did not install a session.");
    }
  } catch (error) {
    throw toPublicAuthError(error, "mfa");
  }
}

export async function cancelTotpEnrollment(factorId: string) {
  const client = requireClient();
  try {
    const { error } = await client.auth.mfa.unenroll({ factorId });
    if (error) throw error;
  } catch (error) {
    throw toPublicAuthError(error, "mfa");
  }
}

export async function signUpWithEmailPassword(params: {
  email: string;
  password: string;
  fullName?: string;
  accountType: SignupAccountType;
}): Promise<SignUpResult> {
  if (!isSignupEnabled(params.accountType)) {
    throw new PublicAppError(
      "auth_signup_disabled",
      params.accountType === "teacher"
        ? "Teacher signup is not open. Ask an administrator for access."
        : "Student signup is not open. Ask your teacher for access.",
    );
  }

  const client = requireClient();
  const normalizedEmail = params.email.trim().toLowerCase();
  const { data, error } = await client.auth.signUp({
    email: normalizedEmail,
    password: params.password,
    options: {
      emailRedirectTo: getAuthRedirectUrl("/auth/confirm"),
      // This metadata is display-only. Authorization is derived exclusively
      // from server-controlled profiles and workspace memberships.
      data: {
        full_name: params.fullName?.trim() || undefined,
      },
    },
  });
  if (error) throw toPublicAuthError(error, "sign_up");

  return {
    email: normalizedEmail,
    requiresEmailConfirmation: !data.session,
  };
}

export async function resendSignUpConfirmation(email: string) {
  const client = requireClient();
  const { error } = await client.auth.resend({
    type: "signup",
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: getAuthRedirectUrl("/auth/confirm") },
  });
  if (error) throw toPublicAuthError(error, "resend_confirmation");
}

export async function requestPasswordResetEmail(email: string) {
  const client = requireClient();
  const { error } = await client.auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
    {
      redirectTo: getAuthRedirectUrl("/auth/reset-password"),
    },
  );
  if (error) throw toPublicAuthError(error, "request_password_reset");
}

export async function updatePassword(password: string) {
  const client = requireClient();
  const { error } = await client.auth.updateUser({ password });
  if (error) throw toPublicAuthError(error, "update_password");
}

export async function completePasswordRecovery(
  password: string,
  expectedState: AuthCallbackState | null,
) {
  const currentSession = await getCurrentSession();
  const persistedState = readAuthCallbackState(
    "password_recovery",
    currentSession,
  );
  if (
    !expectedState ||
    !isAuthCallbackStateValid(
      expectedState,
      "password_recovery",
      currentSession,
    ) ||
    !authCallbackStatesMatch(expectedState, persistedState)
  ) {
    clearAuthCallbackState();
    throw new PublicAppError(
      "auth_session_expired",
      "This reset link has expired or was already used. Request a new one.",
    );
  }

  await updatePassword(password);
  clearAuthCallbackState();
}

export async function signOut() {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw toPublicAuthError(error, "sign_out");
}

export async function getCurrentSession() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw toPublicAuthError(error, "load_context");
  return data.session;
}

export async function getCurrentUser() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error) throw toPublicAuthError(error, "load_context");
  return data.user;
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
) {
  const client = getSupabaseClient();
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => data.subscription.unsubscribe();
}

export async function getAuthSnapshot(
  preferredMembershipId?: string | null,
  sessionFromAuthEvent?: Session | null,
): Promise<AuthSnapshot> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      session: null,
      user: null,
      profile: null,
      workspaceMemberships: [],
      activeMembershipId: null,
      activeWorkspaceId: null,
      role: null,
      needsWorkspace: false,
      isPlatformAdmin: false,
      teacherEntitled: false,
      canCreateTeacherWorkspace: false,
    };
  }

  try {
    // INITIAL_SESSION and the other Supabase auth events already carry the
    // session selected by the auth client. Re-reading it immediately can wait
    // on the same initialization lock and delay the first protected request.
    // The event session grants no role by itself: get_auth_context remains the
    // server authority below, and its user id must still match exactly.
    const session =
      sessionFromAuthEvent === undefined
        ? await getCurrentSession()
        : sessionFromAuthEvent;
    if (!session) {
      return {
        session: null,
        user: null,
        profile: null,
        workspaceMemberships: [],
        activeMembershipId: null,
        activeWorkspaceId: null,
        role: null,
        needsWorkspace: false,
        isPlatformAdmin: false,
        teacherEntitled: false,
        canCreateTeacherWorkspace: false,
      };
    }

    // The authenticated RPC is the authority for role and membership routing.
    // It validates the session JWT in PostgREST, so a forged or expired local
    // session cannot produce trusted context. Reuse the session's user object
    // only after the RPC succeeds and its server-derived user id matches; this
    // removes a redundant Auth HTTP request from every application bootstrap
    // without trusting user_metadata or locally decoded roles.
    const trustedContext = await loadTrustedAuthContext(client);
    const user = session.user;
    if (trustedContext.user_id !== user.id) {
      throw new Error(
        "Trusted auth context did not match the authenticated user.",
      );
    }
    const trustedProfile: AuthProfile = {
      id: trustedContext.user_id,
      full_name: trustedContext.full_name,
      email: trustedContext.email,
      global_role: trustedContext.global_role,
    };
    const memberships: AuthWorkspaceMembership[] =
      trustedContext.memberships.map((membership) => ({
        id: membership.membership_id,
        workspace_id: membership.workspace_id,
        user_id: trustedContext.user_id,
        role: membership.role,
        workspace_name: membership.workspace_name,
        workspace_slug: membership.workspace_slug,
        created_at: membership.created_at,
      }));
    const teacherEntitled = trustedContext.teacher_entitled;
    const canCreateTeacherWorkspace =
      trustedContext.can_create_teacher_workspace;
    const isPlatformAdmin = trustedContext.global_role === "platform_admin";

    const resolvedAccess = resolveAuthAccess(
      memberships,
      preferredMembershipId,
      teacherEntitled,
      canCreateTeacherWorkspace,
    );

    return {
      session,
      user,
      profile: trustedProfile,
      workspaceMemberships: resolvedAccess.workspaceMemberships,
      activeMembershipId: resolvedAccess.activeMembership?.id ?? null,
      activeWorkspaceId: resolvedAccess.activeMembership?.workspace_id ?? null,
      role: resolvedAccess.role,
      needsWorkspace: resolvedAccess.needsWorkspace,
      isPlatformAdmin,
      teacherEntitled,
      canCreateTeacherWorkspace,
    };
  } catch (error) {
    throw toPublicAuthError(error, "load_context");
  }
}

export async function createTeacherWorkspace(
  workspaceName = "My German Class",
) {
  let value: unknown;
  try {
    value = await callApiRpc<unknown>(
      "create_teacher_workspace",
      { workspace_name: workspaceName },
      "We couldn't create the workspace. Please try again.",
    );
  } catch (error) {
    throw toPublicAuthError(error, "create_workspace");
  }
  const created = parseApiArray<{
    workspace_id: string;
    membership_id: string;
  }>(value, "Workspace creation")[0];
  if (!created) {
    throw new PublicAppError(
      "auth_workspace_failed",
      "We couldn't confirm the new workspace. Please refresh and try again.",
    );
  }
  return {
    workspaceId: created.workspace_id,
    membershipId: created.membership_id,
  };
}
