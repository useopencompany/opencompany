import { RunEventCursorError } from "@opencompany/protocol/run-stream";
import {
  type ConversationDto,
  type MessageDto,
  MessageSummaryReadModelSchema,
  RunReadModelSchema,
  TaskReadModelSchema,
} from "@opencompany/protocol/schemas";
import { until } from "until-async";
import type { z } from "zod";
import {
  ApiRequestError,
  type AuthenticatedApi,
  isRetryableApiError,
} from "@/shared/api/opencompany-api";
import { combineAbortSignals, throwIfAborted } from "@/shared/lib/abort";
import { queryClient } from "@/shared/lib/query-client";
import type { ConnectivityState } from "./chat";
import { chatQueryKeys, invalidateConversation } from "./chat-queries";
import {
  applyMessagePresentationSnapshot,
  applyRunProjection,
  type ChatPartition,
  completeCommand,
  evictCompletedCache,
  failMessageCommand,
  getConversationRunCheckpoint,
  getMessagePresentationCache,
  getStoredConversation,
  markCommandInFlight,
  mergeConversationSnapshots,
  mergeMessageSnapshots,
  mergeTaskSnapshots,
  NEW_CHAT_ID,
  nextOutboxCommand,
  nextOutboxWakeAt,
  type OutboxCommand,
  reconcileSidebarMembership,
  recoverOutbox,
  requeueCommand,
  settleIdleConversationRuns,
  syncRunSnapshots,
} from "./chat-store";
import { orderedPartsFromPresentation, textFromParts } from "./message-presentation";
import { processChatCommand } from "./process-chat-command";
import { projectRunEvent } from "./run-projection";
import { seenChangeGuard, sidebarChangeGuard } from "./sidebar-change-guard";

// A Task conversation is not served by the chat resources, so its transcript and Runs come from
// the authorized read models. How often an open Task checks for Runs started elsewhere.
const TASK_POLL_INTERVAL_MS = 3_000;

const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  srt: "text/plain",
  text: "text/plain",
  image: "image/*",
};

type MessageSummary = z.output<typeof MessageSummaryReadModelSchema>;
interface PresentationAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  kind: string;
}

// The read model names attachments by presentation kind; the transcript stores canonical DTOs.
const messageFromReadModel = (message: MessageSummary): MessageDto => ({
  id: message.id,
  conversationId: message.conversationId,
  role: message.role,
  content: message.content,
  attachments: (message.attachments ?? []).map((attachment: PresentationAttachment) => ({
    id: attachment.id,
    filename: attachment.name,
    mediaType: ATTACHMENT_MEDIA_TYPES[attachment.kind] ?? "application/octet-stream",
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind === "image" ? "image" : "document",
  })),
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

function retryDelay(command: OutboxCommand, error: unknown): number {
  if (error instanceof ApiRequestError && error.retryAfterMs !== undefined)
    return error.retryAfterMs;
  return Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** Math.min(command.attempts, 5)));
}

const observationRetryDelay = (attempt: number): number => {
  const ceiling = Math.min(8_000, 250 * 2 ** Math.min(attempt, 5));
  return 250 + Math.floor(Math.random() * Math.max(1, ceiling - 249));
};

const abortableDelay = async (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });

const STRUCTURAL_EVENT_TYPES = new Set([
  "message.created",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "artifact.published",
  "run.completed",
  "run.failed",
  "run.canceled",
]);

const reconciledPresentationContent = (
  activeContent: string | undefined,
  canonicalText: string,
  fallbackContent: string,
): string => {
  if (!activeContent) return canonicalText || fallbackContent;
  return canonicalText.length >= activeContent.length ? canonicalText : activeContent;
};

export function createChatSession(input: {
  userId: string;
  workspaceId: string;
  api: AuthenticatedApi;
  onConnectivity: (state: ConnectivityState) => void;
  onError: (message: string, error: unknown, context?: string) => void;
}) {
  const lifetime = new AbortController();
  const partition: ChatPartition = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    signal: lifetime.signal,
  };
  let activity: AbortController | null = null;
  let observation: AbortController | null = null;
  let visibleId: string | null = null;
  let drainPromise: Promise<void> | null = null;
  let drainRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectStatusTimer: ReturnType<typeof setTimeout> | null = null;

  const scope = (signal: AbortSignal): ChatPartition => ({ ...partition, signal });
  const reportError = (signal: AbortSignal, message: string, error: unknown, context: string) => {
    if (!signal.aborted) input.onError(message, error, context);
  };

  const clearConnectionFailure = () => {
    if (reconnectStatusTimer) clearTimeout(reconnectStatusTimer);
    reconnectStatusTimer = null;
    input.onConnectivity("online");
  };

  const markConnectionFailure = (signal: AbortSignal) => {
    if (signal.aborted || reconnectStatusTimer) return;
    reconnectStatusTimer = setTimeout(() => {
      reconnectStatusTimer = null;
      if (!signal.aborted) input.onConnectivity("reconnecting");
    }, 1_500);
  };

  const refreshMessagePresentation = async (
    conversationId: string,
    messageId: string,
    content: string,
    signal: AbortSignal,
    active?: Awaited<ReturnType<typeof getConversationRunCheckpoint>>,
  ) => {
    const current = scope(signal);
    const cached = await getMessagePresentationCache(current, messageId);
    const result = await input.api.getMessagePresentation(
      conversationId,
      messageId,
      cached?.etag,
      signal,
    );
    if (result.status === "not-modified") return active;
    const parts = orderedPartsFromPresentation({
      content: active?.content ?? content,
      messageId,
      presentation: result.data.presentation,
    });
    const canonicalText = textFromParts(parts);
    if (
      active?.content &&
      canonicalText !== active.content &&
      !canonicalText.startsWith(active.content)
    ) {
      return active;
    }
    const nextContent = reconciledPresentationContent(active?.content, canonicalText, content);
    if (active?.content.startsWith(canonicalText) && canonicalText.length < active.content.length) {
      return active;
    }
    const applied = await applyMessagePresentationSnapshot(current, messageId, {
      revision: result.data.updatedAt,
      etag: result.etag,
      content: nextContent,
      parts,
    });
    if (!applied || !active) return active;
    return { ...active, content: nextContent, parts };
  };

  const mergeTranscript = async (
    id: string,
    messages: MessageDto[],
    signal: AbortSignal,
  ): Promise<void> => {
    const current = scope(signal);
    await mergeMessageSnapshots(current, id, messages);
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    for (let index = 0; index < assistantMessages.length; index += 6) {
      await Promise.all(
        assistantMessages
          .slice(index, index + 6)
          .map((message) => refreshMessagePresentation(id, message.id, message.content, signal)),
      );
    }
  };

  const readRuns = (id: string, signal: AbortSignal) =>
    input.api.readModelSnapshot("chat-runs-v1", RunReadModelSchema, { conversationId: id }, signal);

  const refreshConversation = async (id: string, signal: AbortSignal): Promise<void> => {
    if (id === NEW_CHAT_ID) return;
    throwIfAborted(signal);
    const local = await getStoredConversation(partition, id);
    if (local?.provisional) return;
    const current = scope(signal);
    if (local?.kind === "task") {
      const messages = await input.api.readModelSnapshot(
        "chat-messages-v2",
        MessageSummaryReadModelSchema,
        { conversationId: id },
        signal,
      );
      await mergeTranscript(
        id,
        messages
          .map(messageFromReadModel)
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? left.id.localeCompare(right.id)
              : Date.parse(left.createdAt) - Date.parse(right.createdAt),
          ),
        signal,
      );
      await syncRunSnapshots(current, id, await readRuns(id, signal));
      await invalidateConversation(current, id);
      await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
      return;
    }
    const startedAt = Date.now();
    const envelope = await input.api.getConversation(id, signal);
    await mergeConversationSnapshots(
      current,
      [envelope.data],
      sidebarChangeGuard.preservedFor(0),
      seenChangeGuard.preservedFor(startedAt),
    );
    let cursor: string | undefined;
    do {
      const page = await input.api.listMessages(id, { cursor, limit: 100 }, signal);
      await mergeTranscript(id, page.data, signal);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // Runs carry their reply Message explicitly, so an active Run is matched to its own reply
    // rather than to whichever assistant Message happens to be newest.
    if (envelope.data.runtime?.activeRunId)
      await syncRunSnapshots(current, id, await readRuns(id, signal));
    await invalidateConversation(current, id);
    await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
  };

  const refreshConversations = async (): Promise<void> => {
    if (!activity || activity.signal.aborted) return;
    const current = scope(activity.signal);
    const startedAt = Date.now();
    const listed: string[] = [];
    const idle: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await input.api.listConversations({ cursor, limit: 100 }, current.signal);
      for (const conversation of page.data as ConversationDto[])
        if (conversation.activityState === "idle" && !conversation.runtime?.activeRunId)
          idle.push(conversation.id);
      await mergeConversationSnapshots(
        current,
        page.data,
        sidebarChangeGuard.preservedFor(startedAt),
        seenChangeGuard.preservedFor(startedAt),
      );
      listed.push(...page.data.map((conversation: ConversationDto) => conversation.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const tasks = (
      await input.api.readModelSnapshot("tasks-v1", TaskReadModelSchema, {}, current.signal)
    ).filter((task) => !task.archivedAt);
    await mergeTaskSnapshots(
      current,
      tasks,
      sidebarChangeGuard.preservedFor(startedAt),
      seenChangeGuard.preservedFor(startedAt),
    );
    listed.push(...tasks.map((task) => task.conversationId));
    idle.push(
      ...tasks
        .filter((task) => task.status !== "queued" && task.status !== "running")
        .map((task) => task.conversationId),
    );
    await settleIdleConversationRuns(
      current,
      idle.filter((id) => id !== visibleId),
      startedAt,
    );
    // Membership is only rewritten from a complete listing of both chats and Tasks.
    await reconcileSidebarMembership(current, listed, sidebarChangeGuard.preservedFor(startedAt));
    await evictCompletedCache(current);
    throwIfAborted(current.signal);
    await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
  };

  const observe = async (id: string, signal: AbortSignal): Promise<void> => {
    const current = scope(signal);
    await refreshConversation(id, signal);
    clearConnectionFailure();
    // Stream the working Run, then any Run that was queued behind it, until none is left. A Run
    // whose stream ended without settling is paused on the reader; it resumes through a new
    // observation once they answer.
    let streamedRunId: string | null = null;
    for (;;) {
      const checkpoint = await getConversationRunCheckpoint(current, id);
      throwIfAborted(signal);
      if (!checkpoint || checkpoint.runId === streamedRunId) return;
      streamedRunId = checkpoint.runId;
      let projection = checkpoint;
      for await (const event of input.api.streamRunEvents({
        runId: checkpoint.runId,
        ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
        ...(checkpoint.presentationCursor
          ? { presentationCursor: checkpoint.presentationCursor }
          : {}),
        signal,
        maxReconnectAttempts: 0,
        onReconnect: () => markConnectionFailure(signal),
        onConnected: clearConnectionFailure,
      })) {
        throwIfAborted(signal);
        projection = projectRunEvent(projection, event);
        if (STRUCTURAL_EVENT_TYPES.has(event.type)) {
          projection =
            (await refreshMessagePresentation(
              id,
              checkpoint.assistantMessageId,
              projection.content,
              signal,
              projection,
            )) ?? projection;
        }
        await applyRunProjection(current, projection);
        await invalidateConversation(current, id);
      }
      // The protocol iterator decides when the response is terminal, including historical pauses.
      throwIfAborted(signal);
      await refreshConversation(id, signal);
    }
  };

  // Between Runs, an open Task only checks whether a Run started or settled elsewhere, and
  // refreshes its transcript when one did.
  const pollTask = async (id: string, signal: AbortSignal): Promise<void> => {
    let seen = "";
    for (;;) {
      await abortableDelay(TASK_POLL_INTERVAL_MS, signal);
      throwIfAborted(signal);
      const runs = await readRuns(id, signal);
      const signature = runs
        .map((run) => `${run.id}:${run.status}`)
        .sort()
        .join(",");
      if (seen && signature !== seen) await observe(id, signal);
      seen = signature;
    }
  };

  const restartObservation = () => {
    observation?.abort();
    if (!activity || activity.signal.aborted || !visibleId) return;
    observation = new AbortController();
    const signal = combineAbortSignals([activity.signal, observation.signal]);
    const id = visibleId;
    void until(async () => {
      let attempts = 0;
      while (!signal.aborted && visibleId === id) {
        const [error] = await until(async () => {
          await observe(id, signal);
          const local = await getStoredConversation(partition, id);
          if (local?.kind === "task") await pollTask(id, signal);
        });
        if (!error) return;
        if (error instanceof RunEventCursorError) {
          const current = scope(signal);
          const checkpoint = await getConversationRunCheckpoint(current, id);
          if (!checkpoint) throw error;
          const reset =
            error.cursorKind === "presentation"
              ? { ...checkpoint, presentationCursor: null }
              : { ...checkpoint, cursor: null, presentationCursor: null, content: "", parts: [] };
          await applyRunProjection(current, reset);
          attempts = 0;
          continue;
        }
        markConnectionFailure(signal);
        if (!isRetryableApiError(error)) throw error;
        await abortableDelay(observationRetryDelay(attempts), signal);
        attempts += 1;
      }
    }).then(([error]) => {
      if (error && !signal.aborted) {
        clearConnectionFailure();
        reportError(signal, "This chat could not be refreshed.", error, "chat.observation");
      }
    });
  };

  const runDrain = async (signal: AbortSignal): Promise<void> => {
    const current = scope(signal);
    await recoverOutbox(current);
    while (!signal.aborted) {
      const command = await nextOutboxCommand(current);
      throwIfAborted(signal);
      if (!command) {
        const wakeAt = await nextOutboxWakeAt(current);
        throwIfAborted(signal);
        if (wakeAt !== null) retryTimer = setTimeout(drain, Math.max(0, wakeAt - Date.now()));
        return;
      }
      await markCommandInFlight(current, command.id);
      const [error] = await until(() => processChatCommand(input.api, current, command, signal));
      throwIfAborted(signal);
      if (error && isRetryableApiError(error)) {
        await requeueCommand(
          current,
          command.id,
          Date.now() + retryDelay(command, error),
          error instanceof Error ? error.message : "Request failed",
        );
        continue;
      }
      if (error) {
        if (command.kind === "message") {
          await failMessageCommand(current, command);
          await queryClient.invalidateQueries({
            queryKey: chatQueryKeys.draft(current, command.conversationId),
          });
          input.onError(
            "Message was not accepted. Your draft has been restored.",
            error,
            "chat.outbox.message",
          );
        } else {
          await completeCommand(current, command.id);
          input.onError(
            command.kind === "stop"
              ? "The run could not be stopped."
              : "That approval response was not accepted.",
            error,
            `chat.outbox.${command.kind}`,
          );
        }
      }
      await invalidateConversation(current, command.conversationId);
      await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(current) });
      if (visibleId === command.conversationId) restartObservation();
    }
  };

  const drain = () => {
    if (!activity || activity.signal.aborted) return;
    drainRequested = true;
    if (drainPromise) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    drainRequested = false;
    const signal = activity.signal;
    drainPromise = runDrain(signal)
      .catch((error: unknown) => {
        reportError(
          signal,
          "Queued chat work could not be processed on this device.",
          error,
          "chat.outbox.drain",
        );
      })
      .finally(() => {
        drainPromise = null;
        if (drainRequested) drain();
      });
  };

  const pause = () => {
    activity?.abort();
    observation?.abort();
    activity = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (reconnectStatusTimer) clearTimeout(reconnectStatusTimer);
    reconnectStatusTimer = null;
  };

  return {
    partition,
    start: () => {
      if (lifetime.signal.aborted || activity) return;
      activity = new AbortController();
      input.onConnectivity("online");
      const signal = activity.signal;
      drain();
      restartObservation();
      void until(refreshConversations).then(([error]) => {
        if (error)
          reportError(signal, "Recent chats could not be refreshed.", error, "chat.list.refresh");
      });
    },
    pause,
    dispose: () => {
      lifetime.abort();
      pause();
    },
    setVisibleConversation: (id: string | null) => {
      if (id === visibleId) return;
      visibleId = id;
      restartObservation();
    },
    refreshConversations,
    // Pulls a conversation's transcript into the local cache without opening it.
    refreshConversation: (id: string, signal: AbortSignal) =>
      refreshConversation(id, combineAbortSignals([lifetime.signal, signal])),
    drain,
  };
}
