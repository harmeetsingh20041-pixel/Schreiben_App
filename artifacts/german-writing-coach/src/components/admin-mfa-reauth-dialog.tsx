import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  getMfaState,
  verifyTotpFactor,
  type TotpFactorSummary,
} from "@/services/authService";

export function AdminMfaReauthDialog({
  open,
  onCancel,
  onVerified,
}: {
  open: boolean;
  onCancel: () => void;
  onVerified: () => Promise<void>;
}) {
  const [factors, setFactors] = useState<TotpFactorSummary[]>([]);
  const [selectedFactorId, setSelectedFactorId] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setFactors([]);
      setSelectedFactorId("");
      setCode("");
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    void getMfaState()
      .then((state) => {
        if (!active) return;
        if (state.verifiedTotpFactors.length < 2) {
          setError(
            "Two verified authenticators are required. Cancel and complete account security setup.",
          );
          return;
        }
        setFactors(state.verifiedTotpFactors);
        setSelectedFactorId(state.verifiedTotpFactors[0]?.id ?? "");
        window.setTimeout(() => codeInputRef.current?.focus(), 0);
      })
      .catch((nextError) => {
        if (!active) return;
        setError(
          formatErrorMessage(
            nextError,
            "Authenticator status could not be loaded.",
          ),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open]);

  async function submit() {
    if (loading) return;
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the current six-digit authenticator code.");
      codeInputRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await verifyTotpFactor(selectedFactorId, code);
      await onVerified();
    } catch (nextError) {
      setError(
        formatErrorMessage(
          nextError,
          "The administrator action was not confirmed.",
        ),
      );
      codeInputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm administrator action</DialogTitle>
          <DialogDescription>
            Enter a fresh TOTP code. The server accepts it for ten minutes and
            will still recheck this action authoritatively.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {factors.length > 0 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-reauth-factor">Authenticator</Label>
              <select
                id="admin-reauth-factor"
                value={selectedFactorId}
                onChange={(event) => setSelectedFactorId(event.target.value)}
                disabled={loading}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {factors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.friendlyName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-reauth-code">Six-digit code</Label>
              <Input
                ref={codeInputRef}
                id="admin-reauth-code"
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
                    void submit();
                  }
                }}
                disabled={loading}
              />
            </div>
          </div>
        )}

        {loading && factors.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading authenticators...
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={loading || !selectedFactorId}
            onClick={() => void submit()}
          >
            {loading && factors.length > 0 ? "Confirming..." : "Confirm and retry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
