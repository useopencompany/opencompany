"use client";

import { useSyncExternalStore } from "react";
import type { GoatChatState } from "@/lib/chat-ui";

const EMPTY_SNAPSHOT: ReadonlyMap<string, GoatChatState> = new Map();

let snapshot: ReadonlyMap<string, GoatChatState> = EMPTY_SNAPSHOT;
const states = new Map<string, GoatChatState>();
const listeners = new Set<() => void>();

export function setLocalGoatChatState(sessionId: string | null, state: GoatChatState | null) {
  if (!sessionId) return;
  const current = states.get(sessionId) ?? null;
  if (current === state) return;
  if (state) {
    states.set(sessionId, state);
  } else {
    states.delete(sessionId);
  }
  snapshot = states.size > 0 ? new Map(states) : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

export function useLocalGoatChatStates() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return EMPTY_SNAPSHOT;
}
