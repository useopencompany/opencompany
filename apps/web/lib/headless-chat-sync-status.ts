"use client";

import { useCallback, useSyncExternalStore } from "react";

// Tracks which conversations have a failed Electric message sync. The message collection's onError
// records here (and keeps the shape stream retrying with Electric's backoff); the transcript reads
// it to replace a silent, empty "ready" collection with a retry affordance. Cleared when durable
// rows arrive or the user retries.
const failedConversations = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function recordChatSyncError(conversationId: string) {
  if (failedConversations.has(conversationId)) return;
  failedConversations.add(conversationId);
  notify();
}

export function clearChatSyncError(conversationId: string) {
  if (!failedConversations.delete(conversationId)) return;
  notify();
}

export function getChatSyncFailed(conversationId: string | null): boolean {
  return conversationId ? failedConversations.has(conversationId) : false;
}

export function useChatSyncFailed(conversationId: string | null): boolean {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const getSnapshot = useCallback(() => getChatSyncFailed(conversationId), [conversationId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
