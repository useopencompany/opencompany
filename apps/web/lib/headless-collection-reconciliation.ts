"use client";

import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";

// The command response is authoritative once the API has committed the write. Electric only
// reconciles the live client projection, so a delayed stream must not turn a successful mutation
// into a retryable-looking failure that can duplicate creates or strand optimistic versions.
export async function reconcileCommittedProjection(wait: Promise<unknown>) {
  try {
    await wait;
  } catch (error) {
    if (error instanceof TimeoutWaitingForTxIdError) return;
    throw error;
  }
}
