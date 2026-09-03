"use client";

import { MessagePresentationEnvelopeSchema } from "@opencompany/protocol";
import type { ChatUiMessage, StoredChatMessage } from "@/lib/chat-ui";
import { textFromChatUiMessage, toChatUiMessage } from "@/lib/chat-ui";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

type PresentationCacheEntry = {
  etag: string | null;
  updatedAt: string;
  message: ChatUiMessage;
};

const presentationCache = new Map<string, PresentationCacheEntry>();
const presentationRequests = new Map<string, Promise<ChatUiMessage>>();

export function loadHeadlessChatMessagePresentation(message: ChatUiMessage) {
  const conversationId = message.metadata?.sessionId;
  const summary = message.metadata?.presentation;
  if (!conversationId || summary?.source !== "summary") {
    return Promise.resolve(message);
  }

  const identity = `${conversationId}\0${message.id}`;
  const cached = presentationCache.get(identity);
  if (cached?.updatedAt === summary.updatedAt) return Promise.resolve(cached.message);

  const requestKey = `${identity}\0${summary.updatedAt}`;
  const pending = presentationRequests.get(requestKey);
  if (pending) return pending;

  const request = fetchMessagePresentation({
    cached,
    conversationId,
    message,
    messageId: message.id,
  }).finally(() => presentationRequests.delete(requestKey));
  presentationRequests.set(requestKey, request);
  return request;
}

async function fetchMessagePresentation(input: {
  cached: PresentationCacheEntry | undefined;
  conversationId: string;
  message: ChatUiMessage;
  messageId: string;
}) {
  const fetchApi = createHeadlessChatApiFetch();
  const url = new URL(
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(
      input.messageId,
    )}/presentation`,
    headlessChatApiBaseUrl(),
  );
  const response = await fetchApi(url, {
    headers: {
      Accept: "application/json",
      ...(input.cached?.etag ? { "If-None-Match": input.cached.etag } : {}),
    },
  });
  if (response.status === 304 && input.cached) return input.cached.message;
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This trace is no longer available."
        : "Could not load this trace. Please try again.",
    );
  }

  const envelope = MessagePresentationEnvelopeSchema.parse(await response.json());
  const resolved = messageWithFullPresentation(input.message, envelope.data);
  presentationCache.set(`${input.conversationId}\0${input.messageId}`, {
    etag: response.headers.get("ETag"),
    updatedAt: envelope.data.updatedAt,
    message: resolved,
  });
  return resolved;
}

function messageWithFullPresentation(
  message: ChatUiMessage,
  result: {
    presentation: Record<string, unknown> | null;
    updatedAt: string;
  },
) {
  const metadata = message.metadata;
  const task = metadata?.task;
  const fullMessage = toChatUiMessage({
    id: message.id,
    sessionId: metadata?.sessionId ?? "",
    role: message.role === "user" ? "user" : "assistant",
    content: textFromChatUiMessage(message),
    taskId: metadata?.taskId ?? task?.id ?? null,
    debugTrace: result.presentation as StoredChatMessage["debugTrace"],
    attachments: metadata?.attachments as StoredChatMessage["attachments"],
    attachmentTexts: null,
    createdAt: new Date(metadata?.timing?.createdAt ?? result.updatedAt),
    updatedAt: new Date(result.updatedAt),
    taskDisplayId: task?.displayId ?? null,
    taskName: task?.title ?? null,
    taskPrompt: null,
    taskStatus: task?.status ?? null,
  });
  return {
    ...fullMessage,
    metadata: {
      ...metadata,
      ...fullMessage.metadata,
      presentation: { source: "summary" as const, updatedAt: result.updatedAt },
    },
  };
}
