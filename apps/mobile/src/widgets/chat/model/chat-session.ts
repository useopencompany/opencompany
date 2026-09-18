import { RunEventCursorError } from "@opencompany/protocol/run-stream";
import { until } from "until-async";
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
  applyRunProjection,
  type ChatPartition,
  completeCommand,
  evictCompletedCache,
  failMessageCommand,
  getConversationRunCheckpoint,
  getStoredConversation,
  markCommandInFlight,
  mergeConversationSnapshots,
  mergeMessageSnapshots,
  NEW_CHAT_ID,
  nextOutboxCommand,
  nextOutboxWakeAt,
  type OutboxCommand,
  recoverOutbox,
  requeueCommand,
  setRunSnapshot,
} from "./chat-store";
import { processChatCommand } from "./process-chat-command";
import { projectRunEvent } from "./run-projection";

function retryDelay(command: OutboxCommand, error: unknown): number {
  if (error instanceof ApiRequestError && error.retryAfterMs !== undefined)
    return error.retryAfterMs;
  return Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** Math.min(command.attempts, 5)));
}

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

  const scope = (signal: AbortSignal): ChatPartition => ({ ...partition, signal });
  const reportError = (signal: AbortSignal, message: string, error: unknown, context: string) => {
    if (!signal.aborted) input.onError(message, error, context);
  };

  const refreshConversation = async (id: string, signal: AbortSignal): Promise<void> => {
    if (id === NEW_CHAT_ID) return;
    throwIfAborted(signal);
    const local = await getStoredConversation(partition, id);
    if (local?.provisional) return;
    const current = scope(signal);
    const envelope = await input.api.getConversation(id, signal);
    await mergeConversationSnapshots(current, [envelope.data]);
    let cursor: string | undefined;
    do {
      const page = await input.api.listMessages(id, { cursor, limit: 100 }, signal);
      await mergeMessageSnapshots(current, id, page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const runId = envelope.data.runtime?.activeRunId;
    if (runId) {
      const run = await input.api.getRun(runId, signal);
      await setRunSnapshot(current, run.data);
    }
    await invalidateConversation(current, id);
  };

  const refreshConversations = async (): Promise<void> => {
    if (!activity || activity.signal.aborted) return;
    const current = scope(activity.signal);
    let cursor: string | undefined;
    do {
      const page = await input.api.listConversations({ cursor, limit: 100 }, current.signal);
      await mergeConversationSnapshots(current, page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await evictCompletedCache(current);
    throwIfAborted(current.signal);
    await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
  };

  const observe = async (id: string, signal: AbortSignal): Promise<void> => {
    const current = scope(signal);
    input.onConnectivity("reconnecting");
    await refreshConversation(id, signal);
    const checkpoint = await getConversationRunCheckpoint(current, id);
    throwIfAborted(signal);
    input.onConnectivity("online");
    if (!checkpoint) return;
    let projection = checkpoint;
    for await (const event of input.api.streamRunEvents({
      runId: checkpoint.runId,
      ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
      ...(checkpoint.presentationCursor
        ? { presentationCursor: checkpoint.presentationCursor }
        : {}),
      signal,
      onReconnect: () => input.onConnectivity("waiting"),
      onConnected: () => input.onConnectivity("online"),
    })) {
      throwIfAborted(signal);
      projection = projectRunEvent(projection, event);
      await applyRunProjection(current, projection);
      await invalidateConversation(current, id);
    }
    // The protocol iterator decides when the response is terminal, including historical pauses.
    throwIfAborted(signal);
    await refreshConversation(id, signal);
  };

  const restartObservation = () => {
    observation?.abort();
    if (!activity || activity.signal.aborted || !visibleId) return;
    observation = new AbortController();
    const signal = combineAbortSignals([activity.signal, observation.signal]);
    const id = visibleId;
    void until(async () => {
      const [error] = await until(() => observe(id, signal));
      if (!(error instanceof RunEventCursorError)) {
        if (error) throw error;
        return;
      }
      const current = scope(signal);
      const checkpoint = await getConversationRunCheckpoint(current, id);
      if (!checkpoint) throw error;
      const reset =
        error.cursorKind === "presentation"
          ? { ...checkpoint, presentationCursor: null }
          : { ...checkpoint, cursor: null, presentationCursor: null, content: "", parts: [] };
      await applyRunProjection(current, reset);
      await observe(id, signal);
    }).then(([error]) => {
      if (error && !signal.aborted) {
        input.onConnectivity("waiting");
        reportError(
          signal,
          "This chat could not be refreshed. Reopen it to try again.",
          error,
          "chat.observation",
        );
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
  };

  return {
    partition,
    start: () => {
      if (lifetime.signal.aborted || activity) return;
      activity = new AbortController();
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
    drain,
  };
}
