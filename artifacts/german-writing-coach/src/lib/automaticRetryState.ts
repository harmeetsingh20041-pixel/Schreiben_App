export function hasScheduledAutomaticRetry(
  retryAt: string | null | undefined,
  nowMs = Date.now(),
) {
  if (!retryAt) return false;
  const retryAtMs = Date.parse(retryAt);
  return Number.isFinite(retryAtMs) && retryAtMs > nowMs;
}
