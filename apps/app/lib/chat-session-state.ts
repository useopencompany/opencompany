"use client";

import type { ChatState } from "@opencompany/core/chat-ui";
import { useSyncExternalStore } from "react";

const EMPTY_SNAPSHOT: ReadonlyMap<string, ChatState> = new Map();

let snapshot: ReadonlyMap<string, ChatState> = EMPTY_SNAPSHOT;
const states = new Map<string, ChatState>();
const listeners = new Set<() => void>();

export function setLocalChatState(sessionId: string | null, state: ChatState | null) {
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

export function clearLocalChatState(sessionId: string | null, expectedState?: ChatState) {
  if (!sessionId) return;
  const current = states.get(sessionId) ?? null;
  if (!current || (expectedState && current !== expectedState)) return;
  states.delete(sessionId);
  snapshot = states.size > 0 ? new Map(states) : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

export function clearAllLocalChatStates() {
  if (states.size === 0) return;
  states.clear();
  snapshot = EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

export function useLocalChatStates() {
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
