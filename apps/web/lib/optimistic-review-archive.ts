"use client";

import { useSyncExternalStore } from "react";

// Archiving is how an item leaves the review queue, and the round trip behind it is a write plus
// the projection that write has to land in. Holding the row until then makes a decision the reader
// has already made look like work they are waiting on, so the row leaves on the click and comes
// back only if the write actually failed.
const EMPTY_SNAPSHOT: ReadonlySet<string> = new Set();

let snapshot: ReadonlySet<string> = EMPTY_SNAPSHOT;
const archivedIds = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Hides a review item ahead of its archive write. Returns false when one is already in flight for
 * the conversation, which is what keeps a double click from sending a second command.
 */
export function archiveReviewItemOptimistically(conversationId: string) {
  if (archivedIds.has(conversationId)) return false;
  archivedIds.add(conversationId);
  publishSnapshot();
  return true;
}

/** Puts an item back after its archive write failed, so the queue keeps work it still owes. */
export function restoreOptimisticReviewArchive(conversationId: string) {
  if (!archivedIds.delete(conversationId)) return;
  publishSnapshot();
}

/**
 * Drops the local hint once the projection reports the same thing. Conversations and Tasks both
 * land as archived rows, so either id settling the hint is the row the reader archived.
 */
export function reconcileOptimisticReviewArchives(archivedConversationIds: Iterable<string>) {
  if (archivedIds.size === 0) return;
  let changed = false;
  for (const conversationId of archivedConversationIds) {
    changed = archivedIds.delete(conversationId) || changed;
  }
  if (changed) publishSnapshot();
}

export function clearOptimisticReviewArchives() {
  if (archivedIds.size === 0) return;
  archivedIds.clear();
  publishSnapshot();
}

export function useOptimisticReviewArchives() {
  return useSyncExternalStore(subscribe, getOptimisticReviewArchives, getServerSnapshot);
}

export function getOptimisticReviewArchives() {
  return snapshot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

function publishSnapshot() {
  snapshot = archivedIds.size > 0 ? new Set(archivedIds) : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}
