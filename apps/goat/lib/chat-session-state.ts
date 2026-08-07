"use client";

import { useSyncExternalStore } from "react";
import type { GoatChatState } from "@/lib/chat-ui";

const EMPTY_SNAPSHOT: ReadonlyMap<string, GoatChatState> = new Map();
const CHAT_STATE_CHANNEL_NAME = "opencompany-goat-chat-session-state";

let snapshot: ReadonlyMap<string, GoatChatState> = EMPTY_SNAPSHOT;
const localStates = new Map<string, GoatChatState>();
const remoteWorkingStates = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const channelSourceId = createChannelSourceId();
let channel: BroadcastChannel | null = null;

export function setLocalGoatChatState(sessionId: string | null, state: GoatChatState | null) {
  if (!sessionId) return;
  const current = localStates.get(sessionId) ?? null;
  if (current === state) return;
  if (state) {
    localStates.set(sessionId, state);
  } else {
    localStates.delete(sessionId);
  }
  publishSnapshot();
  broadcastWorkingState(sessionId, state === "working");
}

export function clearLocalGoatChatState(sessionId: string | null, expectedState?: GoatChatState) {
  if (!sessionId) return;
  const current = localStates.get(sessionId) ?? null;
  if (!current || (expectedState && current !== expectedState)) return;
  localStates.delete(sessionId);
  publishSnapshot();
  broadcastWorkingState(sessionId, false);
}

export function clearAllLocalGoatChatStates() {
  for (const [sessionId, state] of localStates) {
    if (state === "working") broadcastWorkingState(sessionId, false);
  }
  if (localStates.size === 0 && remoteWorkingStates.size === 0) return;
  localStates.clear();
  remoteWorkingStates.clear();
  publishSnapshot();
}

export function useLocalGoatChatStates() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(listener: () => void) {
  ensureCrossTabChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

type ChatStateChannelMessage =
  | { type: "request"; sourceId: string }
  | { type: "working"; sourceId: string; sessionId: string; active: boolean };

function ensureCrossTabChannel() {
  if (channel || typeof window === "undefined" || !("BroadcastChannel" in window)) return channel;

  try {
    channel = new window.BroadcastChannel(CHAT_STATE_CHANNEL_NAME);
    channel.addEventListener("message", handleChannelMessage);
    window.addEventListener("pagehide", clearPublishedWorkingStates);
    channel.postMessage({
      type: "request",
      sourceId: channelSourceId,
    } satisfies ChatStateChannelMessage);
  } catch {
    // BroadcastChannel can be blocked in restricted browser contexts. The current tab's
    // in-memory state still works, so cross-tab sync remains a progressive enhancement.
    channel = null;
  }
  return channel;
}

function broadcastWorkingState(sessionId: string, active: boolean) {
  try {
    ensureCrossTabChannel()?.postMessage({
      type: "working",
      sourceId: channelSourceId,
      sessionId,
      active,
    } satisfies ChatStateChannelMessage);
  } catch {
    // The page may be closing while pagehide publishes its final state.
  }
}

function handleChannelMessage(event: MessageEvent<unknown>) {
  const message = parseChannelMessage(event.data);
  if (!message || message.sourceId === channelSourceId) return;

  if (message.type === "request") {
    for (const [sessionId, state] of localStates) {
      if (state === "working") broadcastWorkingState(sessionId, true);
    }
    return;
  }

  const sessions = remoteWorkingStates.get(message.sourceId) ?? new Set<string>();
  if (message.active) {
    sessions.add(message.sessionId);
    remoteWorkingStates.set(message.sourceId, sessions);
  } else {
    sessions.delete(message.sessionId);
    if (sessions.size === 0) remoteWorkingStates.delete(message.sourceId);
  }
  publishSnapshot();
}

function parseChannelMessage(value: unknown): ChatStateChannelMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "request" && typeof message.sourceId === "string") {
    return { type: "request", sourceId: message.sourceId };
  }
  if (
    message.type === "working" &&
    typeof message.sourceId === "string" &&
    typeof message.sessionId === "string" &&
    typeof message.active === "boolean"
  ) {
    return {
      type: "working",
      sourceId: message.sourceId,
      sessionId: message.sessionId,
      active: message.active,
    };
  }
  return null;
}

function clearPublishedWorkingStates() {
  for (const [sessionId, state] of localStates) {
    if (state === "working") broadcastWorkingState(sessionId, false);
  }
}

function publishSnapshot() {
  const next = new Map(localStates);
  for (const sessions of remoteWorkingStates.values()) {
    for (const sessionId of sessions) next.set(sessionId, "working");
  }
  snapshot = next.size > 0 ? next : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

function createChannelSourceId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `goat-chat-state-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
