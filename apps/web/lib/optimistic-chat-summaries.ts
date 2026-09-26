"use client";

import { useSyncExternalStore } from "react";
import type { ChatSummaryView } from "@/lib/chat-ui";

export type OptimisticChatSummary = {
  workspaceId: string;
  chat: ChatSummaryView;
  // Set once the API has accepted the chat's first message. The row keeps bridging the sidebar
  // until the durable projection arrives, but the Conversation itself now exists server-side,
  // so its route can be rendered and the URL may name it.
  accepted?: boolean;
};

const EMPTY_SNAPSHOT: readonly OptimisticChatSummary[] = [];

let snapshot: readonly OptimisticChatSummary[] = EMPTY_SNAPSHOT;
const summaries = new Map<string, OptimisticChatSummary>();
const listeners = new Set<() => void>();

export function addOptimisticChatSummary(input: {
  workspaceId: string;
  sessionId: string;
  prompt: string;
  model: string;
  engine: NonNullable<ChatSummaryView["engine"]>;
}) {
  const now = new Date().toISOString();
  const normalizedPrompt = input.prompt.replace(/\s+/g, " ").trim();
  summaries.set(input.sessionId, {
    workspaceId: input.workspaceId,
    chat: {
      id: input.sessionId,
      title: optimisticTitleFromPrompt(input.prompt),
      model: input.model as ChatSummaryView["model"],
      engine: input.engine,
      codexComposerSettings: null,
      runtime: null,
      activityState: "working",
      hasUnseen: false,
      preview: normalizedPrompt || "Starting chat…",
      updatedAt: now,
      lastSeenAt: null,
      pinnedAt: null,
    },
  });
  publishSnapshot();
}

export function markOptimisticChatSummaryAccepted(sessionId: string) {
  const entry = summaries.get(sessionId);
  if (!entry || entry.accepted) return;
  summaries.set(sessionId, { ...entry, accepted: true });
  publishSnapshot();
}

export function removeOptimisticChatSummary(sessionId: string) {
  if (!summaries.delete(sessionId)) return;
  publishSnapshot();
}

/**
 * Chats in `workspaceId` whose first message the API has accepted but whose durable row has not
 * reached the client yet. They can be routed to; the rest of the optimistic rows exist only in
 * this tab and a server-rendered route cannot show them.
 */
export function acceptedOptimisticChatIds(
  optimisticChats: readonly OptimisticChatSummary[],
  workspaceId: string,
): ReadonlySet<string> {
  return new Set(
    optimisticChats
      .filter((entry) => entry.workspaceId === workspaceId && entry.accepted)
      .map((entry) => entry.chat.id),
  );
}

export function reconcileOptimisticChatSummaries(
  persistedChats: readonly Pick<ChatSummaryView, "id">[],
) {
  let changed = false;
  for (const chat of persistedChats) {
    changed = summaries.delete(chat.id) || changed;
  }
  if (changed) publishSnapshot();
}

export function clearAllOptimisticChatSummaries() {
  if (summaries.size === 0) return;
  summaries.clear();
  publishSnapshot();
}

export function useOptimisticChatSummaries() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function mergeOptimisticChatSummaries(input: {
  persistedChats: readonly ChatSummaryView[];
  optimisticChats: readonly OptimisticChatSummary[];
  workspaceId: string;
}): ChatSummaryView[] {
  const persistedIds = new Set(input.persistedChats.map((chat) => chat.id));
  const pending = input.optimisticChats
    .filter((entry) => entry.workspaceId === input.workspaceId && !persistedIds.has(entry.chat.id))
    .map((entry) => entry.chat)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return pending.length > 0 ? [...pending, ...input.persistedChats] : [...input.persistedChats];
}

function optimisticTitleFromPrompt(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || "New chat";
  return title.length <= 60 ? title : `${title.slice(0, 57).trimEnd()}...`;
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

function publishSnapshot() {
  snapshot = summaries.size > 0 ? [...summaries.values()] : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}
