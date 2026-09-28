/**
 * Conversations whose reader-owned change the server may not reflect yet.
 *
 * A refresh that started before a change settled can return the old state. Refreshes ask a guard
 * which conversations to leave alone: every change still in flight, and every change confirmed
 * after the refresh started (its response may predate the write).
 */
const createChangeGuard = () => {
  const inFlight = new Map<string, number>();
  const confirmedAt = new Map<string, number>();
  return {
    begin(conversationId: string): void {
      inFlight.set(conversationId, (inFlight.get(conversationId) ?? 0) + 1);
    },
    end(conversationId: string): void {
      const remaining = (inFlight.get(conversationId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(conversationId, remaining);
      else inFlight.delete(conversationId);
      confirmedAt.set(conversationId, Date.now());
    },
    isPending(conversationId: string): boolean {
      return inFlight.has(conversationId);
    },
    preservedFor(refreshStartedAt: number): ReadonlySet<string> {
      const preserved = new Set(inFlight.keys());
      for (const [conversationId, settledAt] of confirmedAt) {
        if (settledAt >= refreshStartedAt) preserved.add(conversationId);
        // No refresh runs for a minute, so older confirmations can no longer be overtaken.
        else if (Date.now() - settledAt > 60_000) confirmedAt.delete(conversationId);
      }
      return preserved;
    },
  };
};

/** Pins, archives, and titles. */
export const sidebarChangeGuard = createChangeGuard();

/** Read acknowledgements, so a refresh racing one doesn't bring the unread dot back. */
export const seenChangeGuard = createChangeGuard();
