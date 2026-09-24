import type { MessageEngine } from "@opencompany/protocol";
import { enqueueHeadlessChatMessage } from "./headless-chat-transport";
import { createHeadlessTaskComment } from "./headless-task-commands";

export type PluginConnectionContinuationTarget =
  | { kind: "task"; taskId: string; workspaceId: string }
  | { kind: "chat"; conversationId: string; model: string; engine: MessageEngine };

/** Reuse the attempt ID on retries so a reconnect can enqueue only one continuation. */
export async function resumeAfterPluginConnection(input: {
  pluginName: string;
  attemptId: string;
  target: PluginConnectionContinuationTarget;
}) {
  const label = input.pluginName.replaceAll("-", " ");
  const content = `The ${label} connection is restored. Continue the previous request from where you stopped.`;
  if (input.target.kind === "task") {
    await createHeadlessTaskComment(
      input.target.taskId,
      { id: `task_activity_${input.attemptId}`, body: content },
      { scopeKey: input.target.workspaceId },
    );
    return;
  }
  await enqueueHeadlessChatMessage({
    content,
    conversationId: input.target.conversationId,
    clientMessageId: `ui_queued_${input.attemptId}`,
    model: input.target.model,
    engine: input.target.engine,
  });
}
