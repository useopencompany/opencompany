"use client";

import {
  type ChatReadModel,
  type ConversationReadModel,
  ConversationReadModelSchema,
  type EngineSessionReadModel,
  EngineSessionReadModelSchema,
  type MessageReadModel,
  MessageReadModelSchema,
  type RunReadModel,
  RunReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { clearChatSyncError, recordChatSyncError } from "./headless-chat-sync-status";

function readModelUrl(readModel: ChatReadModel) {
  return `${headlessChatApiBaseUrl()}/v1/read-models/${readModel}`;
}

function shapeOptions(readModel: ChatReadModel) {
  return {
    url: readModelUrl(readModel),
    fetchClient: createHeadlessChatApiFetch(),
  };
}

function createConversations() {
  return createCollection(
    electricCollectionOptions({
      id: "headless-chat:conversations:v2",
      schema: ConversationReadModelSchema,
      shapeOptions: shapeOptions("chat-conversations-v2"),
      getKey: (row) => row.id,
    }),
  );
}

function createMessages(conversationId: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-chat:messages:v1:${conversationId}`,
      schema: MessageReadModelSchema,
      shapeOptions: {
        ...shapeOptions("chat-messages-v1"),
        params: { conversationId },
        // Electric already marks the collection ready on error, so without this the transcript
        // renders as a silent empty conversation. Record the failure for the retry surface and
        // return {} to keep the shape stream retrying with Electric's backoff.
        onError: (error) => {
          console.warn("Chat transcript sync failed; retrying.", { conversationId, error });
          recordChatSyncError(conversationId);
          return {};
        },
      },
      getKey: (row) => row.id,
    }),
  );
}

function createRuns(conversationId: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-chat:runs:v1:${conversationId}`,
      schema: RunReadModelSchema,
      shapeOptions: {
        ...shapeOptions("chat-runs-v1"),
        params: { conversationId },
      },
      getKey: (row) => row.id,
    }),
  );
}

function createEngineSession(conversationId: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-chat:engine-session:v1:${conversationId}`,
      schema: EngineSessionReadModelSchema,
      shapeOptions: {
        ...shapeOptions("engine-sessions-v1"),
        params: { conversationId },
      },
      // goat_codex_chat_sessions_chat_session_idx guarantees one engine session per Conversation.
      getKey: (row) => row.conversationId,
    }),
  );
}

const messagesByConversation = new Map<string, ReturnType<typeof createMessages>>();
const runsByConversation = new Map<string, ReturnType<typeof createRuns>>();
const engineSessionsByConversation = new Map<string, ReturnType<typeof createEngineSession>>();
let conversations: ReturnType<typeof createConversations> | null = null;

export function getHeadlessChatMessages(conversationId: string) {
  const cached = messagesByConversation.get(conversationId);
  if (cached) return cached;
  const collection = createMessages(conversationId);
  messagesByConversation.set(conversationId, collection);
  return collection;
}

export function preloadHeadlessChatMessages(conversationId: string) {
  return getHeadlessChatMessages(conversationId).preload();
}

// Bumped whenever a conversation's message collection is recreated. useHeadlessChatTranscript reads
// this so it re-runs getHeadlessChatMessages and resubscribes to the fresh Electric stream.
const messagesGenerationByConversation = new Map<string, number>();
const messagesGenerationListeners = new Set<() => void>();

export function getHeadlessChatMessagesGeneration(conversationId: string | null) {
  return conversationId ? (messagesGenerationByConversation.get(conversationId) ?? 0) : 0;
}

export function subscribeHeadlessChatMessagesGeneration(listener: () => void) {
  messagesGenerationListeners.add(listener);
  return () => {
    messagesGenerationListeners.delete(listener);
  };
}

// Electric already marked the failed collection ready, and .preload() on a cached, ready collection
// is a no-op — so once Electric exhausts its bounded onError retries the stream never restarts.
// Drop the cached collection, create a fresh one, and bump the generation so the transcript hook
// resubscribes to a new ShapeStream that fetches from scratch.
export function retryHeadlessChatMessages(conversationId: string) {
  clearChatSyncError(conversationId);
  const previous = messagesByConversation.get(conversationId);
  messagesByConversation.delete(conversationId);
  // Stop the previous ShapeStream before replacing it. TanStack DB otherwise defers cleanup (~5min
  // by default), during which the old stream keeps retrying the same heavy transcript and a stale
  // onError could re-flag this conversation after the fresh stream has recovered; repeated retries
  // would stack streams.
  void previous?.cleanup();
  const collection = getHeadlessChatMessages(conversationId);
  messagesGenerationByConversation.set(
    conversationId,
    (messagesGenerationByConversation.get(conversationId) ?? 0) + 1,
  );
  for (const listener of messagesGenerationListeners) listener();
  return collection.preload();
}

export function getHeadlessChatRuns(conversationId: string) {
  const cached = runsByConversation.get(conversationId);
  if (cached) return cached;
  const collection = createRuns(conversationId);
  runsByConversation.set(conversationId, collection);
  return collection;
}

export function getHeadlessChatConversations() {
  conversations ??= createConversations();
  return conversations;
}

export function getHeadlessChatEngineSession(conversationId: string) {
  const cached = engineSessionsByConversation.get(conversationId);
  if (cached) return cached;
  const collection = createEngineSession(conversationId);
  engineSessionsByConversation.set(conversationId, collection);
  return collection;
}

export async function awaitHeadlessChatTransaction(input: {
  conversationId: string;
  transactionId: string;
  timeoutMs?: number;
}) {
  const transactionId = Number(input.transactionId);
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) {
    throw new Error("The API returned an invalid Electric transaction identifier.");
  }
  const messages = getHeadlessChatMessages(input.conversationId);
  const runs = getHeadlessChatRuns(input.conversationId);
  const conversations = getHeadlessChatConversations();
  await Promise.all([
    conversations.utils.awaitTxId(transactionId, input.timeoutMs),
    messages.utils.awaitTxId(transactionId, input.timeoutMs),
    runs.utils.awaitTxId(transactionId, input.timeoutMs),
  ]);
}

export async function awaitHeadlessConversationTransaction(
  transactionIdValue: string,
  timeoutMs?: number,
) {
  const transactionId = Number(transactionIdValue);
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) {
    throw new Error("The API returned an invalid Electric transaction identifier.");
  }
  await getHeadlessChatConversations().utils.awaitTxId(transactionId, timeoutMs);
}

export type HeadlessChatMessageReadModel = MessageReadModel;
export type HeadlessChatRunReadModel = RunReadModel;
export type HeadlessChatConversationReadModel = ConversationReadModel;
export type HeadlessChatEngineSessionReadModel = EngineSessionReadModel;
