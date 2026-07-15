import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  cancelTotpEnrollment,
  enrollTotpFactor,
  getMfaState,
  verifyTotpFactor,
  type MfaState,
  type TotpEnrollment,
} from "@/services/authService";

function safeReturnPath(
  search: string,
  isPlatformAdmin: boolean,
  role: "student" | "teacher" | null,
) {
  const requested = new URLSearchParams(search).get("returnTo");
  const allowedReturnPaths = new Set([
    "/admin/teacher-access",
    "/student/dashboard",
    "/teacher/dashboard",
    "/teacher/onboarding",
    "/teacher-access",
  ]);
  if (requested && allowedReturnPaths.has(requested)) {
    return requested;
  }
  if (isPlatformAdmin) return "/admin/teacher-access";
  return role === "teacher" ? "/teacher/dashboard" : "/student/dashboard";
}

export default function MfaPage() {
  const { isPlatformAdmin, logout, refreshAccess, role } = useAuth();
  const [, setLocation] = useLocation();
  const returnPath = useMemo(
    () => safeReturnPath(window.location.search, isPlatformAdmin, role),
    [isPlatformAdmin, role],
  );
  const reauthenticationRequested =
    new URLSearchParams(window.location.search).get("mode") === "reauth";
  const [mfaState, setMfaState] = useState<MfaState | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [selectedFactorId, setSelectedFactorId] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await getMfaState();
      setMfaState(nextState);
      setSelectedFactorId((current) =>
        nextState.verifiedTotpFactors.some((factor) => factor.id === current)
          ? current
          : (nextState.verifiedTotpFactors[0]?.id ?? ""),
      );
      return nextState;
    } catch (nextError) {
      setMfaState(null);
      setError(
        formatErrorMessage(
          nextError,
          "Authenticator status could not be loaded. Please try again.",
        ),
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const verifiedFactors = mfaState?.verifiedTotpFactors ?? [];
  const pendingFactors =
    mfaState?.totpFactors.filter((factor) => factor.status === "unverified") ??
    [];
  const mustChallengeExistingFactor = Boolean(
    mfaState &&
    verifiedFactors.length > 0 &&
    (mfaState.currentLevel !== "aal2" || reauthenticationRequested),
  );
  const needsAnotherFactor = Boolean(
    mfaState && !mustChallengeExistingFactor && verifiedFactors.length < 2,
  );
  const setupComplete = Boolean(
    mfaState &&
    !reauthenticationRequested &&
    mfaState.currentLevel === "aal2" &&
    verifiedFactors.length >= 2,
  );

  useEffect(() => {
    if (enrollment || mustChallengeExistingFactor) {
      codeInputRef.current?.focus();
    }
  }, [enrollment, mustChallengeExistingFactor]);

  async function beginEnrollment() {
    setBusy(true);
    setError(null);
    try {
      const nextEnrollment = await enrollTotpFactor(
        verifiedFactors.length === 0
          ? "Primary authenticator"
          : `Backup authenticator ${verifiedFactors.length + 1}`,
      );
      setEnrollment(nextEnrollment);
      setCode("");
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "Authenticator setup could not be started. Please try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(factorId: string) {
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the current six-digit code from your authenticator app.");
      codeInputRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await verifyTotpFactor(factorId, code);
      setCode("");
      setEnrollment(null);
      const nextState = await loadState();
      await refreshAccess();
      if (
        reauthenticationRequested &&
        nextState?.currentLevel === "aal2" &&
        nextState.verifiedTotpFactors.length >= 2
      ) {
        setLocation(returnPath);
      }
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "The authenticator code could not be verified.",
        ),
      );
      codeInputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnrollment() {
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await cancelTotpEnrollment(enrollment.factorId);
      setEnrollment(null);
      setCode("");
      await loadState();
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "Authenticator setup could not be cancelled safely.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function restartPendingEnrollment() {
    setBusy(true);
    setError(null);
    try {
      for (const factor of pendingFactors) {
        await cancelTotpEnrollment(factor.id);
      }
      await loadState();
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "The incomplete setup could not be restarted safely.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function continueAfterSetup() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The page loads MFA state independently so it can recover when the
      // provider's earlier read failed. Refresh the provider before returning
      // to a protected route or AdminRoute would redirect straight back here.
      await refreshAccess();
      setLocation(returnPath);
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "Secure account access could not be refreshed. Please try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-10 text-foreground sm:py-16">
      <div className="mx-auto max-w-lg space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium text-primary">
              Secure account access
            </p>
            <h1 className="text-3xl font-serif tracking-tight">
              Authenticator verification
            </h1>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {reauthenticationRequested
                ? "Confirm this administrator action"
                : "Set up two authenticators"}
            </CardTitle>
            <CardDescription>
              Platform administrators need a primary and a backup TOTP
              authenticator. The backup replaces recovery codes and should be
              stored separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            {loading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading authenticator status...
              </p>
            )}

            {!loading && !mfaState && (
              <Button type="button" onClick={() => void loadState()}>
                Try again
              </Button>
            )}

            {!loading &&
              mfaState &&
              pendingFactors.length > 0 &&
              !enrollment && (
                <div className="rounded-md border bg-muted/30 p-4">
                  <p className="font-medium">Incomplete setup found</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Remove the unfinished enrollment before generating a new QR
                    code.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3"
                    disabled={busy}
                    onClick={() => void restartPendingEnrollment()}
                  >
                    Restart setup
                  </Button>
                </div>
              )}

            {!loading &&
              mustChallengeExistingFactor &&
              pendingFactors.length === 0 && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="mfa-factor">Authenticator</Label>
                    <select
                      id="mfa-factor"
                      value={selectedFactorId}
                      onChange={(event) =>
                        setSelectedFactorId(event.target.value)
                      }
                      disabled={busy}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {verifiedFactors.map((factor) => (
                        <option key={factor.id} value={factor.id}>
                          {factor.friendlyName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mfa-code">Six-digit code</Label>
                    <Input
                      ref={codeInputRef}
                      id="mfa-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={code}
                      onChange={(event) =>
                        setCode(
                          event.target.value.replace(/\D/g, "").slice(0, 6),
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void verify(selectedFactorId);
                        }
                      }}
                      disabled={busy}
                    />
                  </div>
                  <Button
                    type="button"
                    disabled={busy || !selectedFactorId}
                    onClick={() => void verify(selectedFactorId)}
                  >
                    {busy ? "Verifying..." : "Verify authenticator"}
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Lost the primary device? Choose the backup authenticator
                    above. If all factors are unavailable, contact the database
                    owner for the audited recovery process.
                  </p>
                </div>
              )}

            {!loading &&
              needsAnotherFactor &&
              pendingFactors.length === 0 &&
              !enrollment && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
                    <KeyRound
                      className="mt-0.5 h-5 w-5 text-primary"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="font-medium">
                        {verifiedFactors.length === 0
                          ? "Add the primary authenticator"
                          : "Add the backup authenticator"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Scan the QR code with an authenticator app, then verify
                        its current code.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void beginEnrollment()}
                  >
                    {busy ? "Starting setup..." : "Add authenticator"}
                  </Button>
                </div>
              )}

            {enrollment && (
              <div className="space-y-4">
                <div className="mx-auto w-fit rounded-lg border bg-white p-3">
                  <img
                    src={enrollment.qrCode}
                    alt="QR code for the new authenticator"
                    className="h-48 w-48"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Cannot scan the QR code?
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Enter this secret manually. Do not share or save it in
                    screenshots.
                  </p>
                  <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm">
                    {enrollment.secret}
                  </code>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="enrollment-code">Six-digit code</Label>
                  <Input
                    ref={codeInputRef}
                    id="enrollment-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void verify(enrollment.factorId);
                      }
                    }}
                    disabled={busy}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void verify(enrollment.factorId)}
                  >
                    {busy ? "Verifying..." : "Verify and save"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void cancelEnrollment()}
                  >
                    Cancel setup
                  </Button>
                </div>
              </div>
            )}

            {setupComplete && (
              <div
                role="status"
                className="rounded-md border border-primary/30 bg-primary/5 p-4"
              >
                <p className="font-medium">Two-factor setup is complete</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This session is at AAL2 and both the primary and backup TOTP
                  authenticators are verified.
                </p>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy || loading}
              onClick={() => void logout()}
            >
              Sign out
            </Button>
            {setupComplete && (
              <Button
                type="button"
                disabled={busy || loading}
                onClick={() => void continueAfterSetup()}
              >
                {busy ? "Continuing..." : "Continue"}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
