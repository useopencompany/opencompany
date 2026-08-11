"use client";

import {
  type ChatReadModel,
  type ConversationReadModel,
  ConversationReadModelSchema,
  type MessageReadModel,
  MessageReadModelSchema,
  type RunReadModel,
  RunReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";

function readModelUrl(readModel: ChatReadModel) {
  const origin =
    typeof window === "undefined"
      ? (process.env.GOAT_NEXT_PUBLIC_APP_URL?.replace(/\/+$/u, "") ?? "")
      : window.location.origin;
  return `${origin}/v1/read-models/${readModel}`;
}

function createConversations() {
  return createCollection(
    electricCollectionOptions({
      id: "headless-chat:conversations:v1",
      schema: ConversationReadModelSchema,
      shapeOptions: { url: readModelUrl("chat-conversations-v1") },
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
        url: readModelUrl("chat-messages-v1"),
        params: { conversationId },
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
        url: readModelUrl("chat-runs-v1"),
        params: { conversationId },
      },
      getKey: (row) => row.id,
    }),
  );
}

const messagesByConversation = new Map<string, ReturnType<typeof createMessages>>();
const runsByConversation = new Map<string, ReturnType<typeof createRuns>>();
let conversations: ReturnType<typeof createConversations> | null = null;

export function getHeadlessChatMessages(conversationId: string) {
  const cached = messagesByConversation.get(conversationId);
  if (cached) return cached;
  const collection = createMessages(conversationId);
  messagesByConversation.set(conversationId, collection);
  return collection;
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
