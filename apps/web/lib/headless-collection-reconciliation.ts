"use client";

import { captureException } from "@opencompany/observability";
import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";

type TransactionAwareCollection = {
  status?: string;
  utils: { awaitTxId(transactionId: number, timeoutMs?: number): Promise<unknown> };
};

// TanStack DB collections only start their Electric shape once something subscribes to them. A
// collection nobody is looking at stays `idle`, so its transaction ids can never arrive and waiting
// on it would time out every single time. There is no projection to reconcile in that case.
export function awaitCollectionTransaction(
  collection: TransactionAwareCollection,
  transactionId: number,
  timeoutMs?: number,
): Promise<unknown> {
  if (collection.status === "idle" || collection.status === "cleaned-up") {
    return Promise.resolve();
  }
  return collection.utils.awaitTxId(transactionId, timeoutMs);
}

// The command response is authoritative once the API has committed the write. Electric only
// reconciles the live client projection, so a delayed stream must not turn a successful mutation
// into a retryable-looking failure that can duplicate creates or strand optimistic versions.
export async function reconcileCommittedProjection(wait: Promise<unknown>) {
  try {
    await wait;
  } catch (error) {
    if (error instanceof TimeoutWaitingForTxIdError) {
      captureException(error, {
        event: "opencompany.read_model_reconciliation_timeout",
      });
      return;
    }
    throw error;
  }
}
