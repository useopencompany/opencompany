"use client";

import type { CollectionStatus } from "@tanstack/react-db";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useHydrated } from "@/components/useHydrated";
import {
  type ChatUiMessage,
  compareChatMessageOrder,
  type StoredChatMessage,
  toChatUiMessage,
} from "@/lib/chat-ui";
import {
  getHeadlessChatMessages,
  getHeadlessChatRuns,
  type HeadlessChatMessageReadModel,
  type HeadlessChatRunReadModel,
} from "@/lib/headless-chat-collections";

export type HeadlessChatTranscript = {
  sessionId: string | null;
  messages: ChatUiMessage[];
  isLoading: boolean;
};

type ReadableCollection<TRow extends object> = {
  readonly status: CollectionStatus;
  startSyncImmediate: () => void;
  subscribeChanges: (callback: () => void) => { unsubscribe: () => void };
  values: () => IterableIterator<TRow>;
};

type CollectionSnapshot<TRow extends object> = {
  collection: ReadableCollection<TRow> | null;
  version: number;
};

export function useHeadlessChatTranscript(sessionId: string | null): HeadlessChatTranscript {
  const hydrated = useHydrated();
  const messagesCollection = useMemo(
    () => (hydrated && sessionId ? getHeadlessChatMessages(sessionId) : null),
    [hydrated, sessionId],
  );
  const runsCollection = useMemo(
    () => (hydrated && sessionId ? getHeadlessChatRuns(sessionId) : null),
    [hydrated, sessionId],
  );
  // Subscribe to the source collections directly. When sidebar preloading has
  // already made them ready, their rows are available on this render without
  // creating an intermediate live-query collection or publishing through an
  // effect. The direct subscription also supplies a safe server snapshot,
  // which TanStack's useLiveQuery intentionally does not.
  const { rows, isLoading: messagesLoading } = useCollectionRows(messagesCollection);
  const { rows: runRows } = useCollectionRows(runsCollection);
  const messages = useMemo(() => {
    const runsByAssistantMessage = new Map(
      ((runRows ?? []) as HeadlessChatRunReadModel[]).map((run) => [run.assistantMessageId, run]),
    );
    return ((rows ?? []) as HeadlessChatMessageReadModel[])
      .toSorted((a, b) =>
        compareChatMessageOrder(
          { id: a.id, role: a.role, createdAt: a.createdAt },
          { id: b.id, role: b.role, createdAt: b.createdAt },
        ),
      )
      .map((row) => headlessChatMessageRowToUiMessage(row, runsByAssistantMessage.get(row.id)));
  }, [rows, runRows]);

  return {
    sessionId,
    messages,
    isLoading: Boolean(sessionId) && (!hydrated || messagesLoading),
  };
}

function useCollectionRows<TRow extends object>(
  collection: ReadableCollection<TRow> | null,
): { rows: TRow[]; isLoading: boolean } {
  const store = useMemo(() => createCollectionStore(collection), [collection]);
  const serverSnapshot = useMemo<CollectionSnapshot<TRow>>(
    () => ({ collection: null, version: 0 }),
    [],
  );
  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);

  return useMemo(() => {
    if (!snapshot.collection) return { rows: [], isLoading: false };
    return {
      rows: Array.from(snapshot.collection.values()),
      isLoading:
        snapshot.collection.status === "idle" ||
        snapshot.collection.status === "loading" ||
        snapshot.collection.status === "cleaned-up",
    };
  }, [snapshot]);
}

function createCollectionStore<TRow extends object>(collection: ReadableCollection<TRow> | null) {
  let version = 0;
  let snapshot: CollectionSnapshot<TRow> = { collection, version };
  const publish = (onStoreChange: () => void) => {
    version += 1;
    snapshot = { collection, version };
    onStoreChange();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (onStoreChange: () => void) => {
      if (!collection) return () => undefined;
      const subscription = collection.subscribeChanges(() => publish(onStoreChange));
      collection.startSyncImmediate();
      // A preloaded collection may already be ready and will not emit an
      // initial change after this subscriber attaches.
      if (collection.status === "ready") publish(onStoreChange);
      return () => subscription.unsubscribe();
    },
  };
}

function headlessChatMessageRowToUiMessage(
  row: HeadlessChatMessageReadModel,
  run?: HeadlessChatRunReadModel,
): ChatUiMessage {
  const message = toChatUiMessage({
    id: row.id,
    sessionId: row.conversationId,
    role: row.role,
    content: row.content,
    taskId: row.taskId,
    debugTrace: row.presentation as StoredChatMessage["debugTrace"],
    attachments: row.attachments as StoredChatMessage["attachments"],
    attachmentTexts: null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  });
  if (row.role !== "assistant" || !run) return message;
  return {
    ...message,
    metadata: {
      ...message.metadata,
      runId: run.id,
      model: message.metadata?.model ?? run.model,
      ...(run.status === "failed" && run.error ? { error: run.error } : {}),
      ...(run.status === "canceled" ? { aborted: true } : {}),
    },
  };
}
