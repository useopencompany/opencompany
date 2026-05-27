export const SYNC_OUTBOX_MAX_ATTEMPTS = 5;
export const SYNC_OUTBOX_RETRY_BASE_MS = 60_000;
export const SYNC_OUTBOX_RETRY_MAX_MS = 30 * 60_000;

export function nextSyncRetryAt(now: Date, failedAttempts: number) {
  const delayMs = Math.min(
    SYNC_OUTBOX_RETRY_MAX_MS,
    SYNC_OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, failedAttempts - 1),
  );
  return new Date(now.getTime() + delayMs);
}
