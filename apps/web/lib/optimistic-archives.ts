"use client";

import { useSyncExternalStore } from "react";

// Conversations the user has archived but whose projection has not landed yet. Archiving is a
// write plus the Electric projection that write has to reach, and holding the row for that round
// trip makes a decision the user has already made look like work they are waiting on. Every list
// built from the conversation projection - the sidebar and the review queue - reads this store, so
// one archive empties the row from all of them on the click and puts it back only if the write
// actually failed.
const EMPTY_SNAPSHOT: ReadonlySet<string> = new Set();

let snapshot: ReadonlySet<string> = EMPTY_SNAPSHOT;
const archivedIds = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Hides a conversation ahead of its archive write. Returns false when one is already in flight for
 * it, which is what keeps a double click from sending a second command.
 */
export function archiveConversationOptimistically(conversationId: string) {
  if (archivedIds.has(conversationId)) return false;
  archivedIds.add(conversationId);
  publishSnapshot();
  return true;
}

/** Puts a conversation back after its archive write failed, so no list silently loses a row. */
export function restoreOptimisticArchive(conversationId: string) {
  if (!archivedIds.delete(conversationId)) return;
  publishSnapshot();
}

/**
 * Drops the local hint once the projection reports the same thing. Conversations and Tasks both
 * land as archived rows, so either id settling the hint is the conversation the user archived.
 */
export function reconcileOptimisticArchives(archivedConversationIds: Iterable<string>) {
  if (archivedIds.size === 0) return;
  let changed = false;
  for (const conversationId of archivedConversationIds) {
    changed = archivedIds.delete(conversationId) || changed;
  }
  if (changed) publishSnapshot();
}

export function clearOptimisticArchives() {
  if (archivedIds.size === 0) return;
  archivedIds.clear();
  publishSnapshot();
}

export function useOptimisticArchives() {
  return useSyncExternalStore(subscribe, getOptimisticArchives, getServerSnapshot);
}

export function getOptimisticArchives() {
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
