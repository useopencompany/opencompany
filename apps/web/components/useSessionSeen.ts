"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  getSeenSnapshot,
  markSessionSeen,
  subscribeSeen,
} from "@/lib/agent-sessions/session-seen-store";

// Empty, stable server snapshot — there is no localStorage during SSR, so the
// blue "unseen" dot only ever appears after hydration (it would otherwise
// mismatch). Same reference every call to satisfy useSyncExternalStore.
const SERVER_SNAPSHOT: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Reactive access to the per-device "seen finished sessions" store. The sidebar
 * reads `seenAt` to decide the blue unseen-finished dot; SessionView calls
 * `markSeen` so opening a session clears its dot live (the store notifies, the
 * sidebar re-renders).
 */
export function useSessionSeen() {
  const seen = useSyncExternalStore(subscribeSeen, getSeenSnapshot, () => SERVER_SNAPSHOT);
  const seenAt = useCallback((sessionId: string) => seen[sessionId] ?? null, [seen]);
  return { seenAt, markSeen: markSessionSeen };
}
