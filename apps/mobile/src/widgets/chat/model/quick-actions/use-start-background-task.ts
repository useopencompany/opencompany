import { descriptionFromAdHocTaskPrompt } from "@opencompany/core/ad-hoc-task";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { until } from "until-async";
import { useAuth } from "@/features/auth";
import { ApiRequestError } from "@/shared/api/opencompany-api";
import { analytics } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "../chat-coordinator";
import { type OutgoingDraft, removeStoredAttachment } from "../chat-store";
import { selectedModelId } from "../composer-selection";

export type BackgroundTaskSource = "task" | "workflow";

// The API accepts a Task before its conversation can be read; web waits on the Task's transaction
// for the same reason. Opening the chat any sooner shows "Conversation not found".
const CONVERSATION_WAIT_ATTEMPTS = 10;
const CONVERSATION_WAIT_INTERVAL_MS = 500;

/** The Task or workflow a draft starts instead of sending a message, if any. */
export const backgroundTaskSource = (draft: Pick<OutgoingDraft, "mentions">) =>
  draft.mentions.find(
    (mention): mention is typeof mention & { kind: BackgroundTaskSource } =>
      mention.kind === "task" || mention.kind === "workflow",
  ) ?? null;

/**
 * Starts the draft's `#task` or `#workflow` as a background Task, then opens its conversation.
 * Online only: the server answers with a Task rather than a message, so there is nothing for the
 * outbox to replay.
 */
export function useStartBackgroundTask() {
  const { api } = useAuth();
  const coordinator = useChatCoordinator();
  const { showToast, showErrorToast } = useToast();
  const waitForConversation = async (conversationId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const [error] = await until(async () => {
        // The sidebar list marks it a Task, which is how the transcript knows where to load from.
        await coordinator.refreshConversations();
        await coordinator.refreshConversation(conversationId, new AbortController().signal);
      });
      if (!error) return;
      const notReadable = error instanceof ApiRequestError && error.status === 404;
      if (!notReadable || attempt >= CONVERSATION_WAIT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONVERSATION_WAIT_INTERVAL_MS));
    }
  };
  return useMutation({
    mutationFn: async (draft: OutgoingDraft) => {
      const source = backgroundTaskSource(draft);
      if (!source) throw new Error("This draft does not start a Task.");
      if (source.kind === "task") {
        const created = await api.createTask(
          {
            goal: descriptionFromAdHocTaskPrompt(draft.text),
            engine: draft.selection.engine,
            model: selectedModelId(draft.selection),
          },
          `mobile-task:${globalThis.crypto.randomUUID()}`,
        );
        return created.data.task;
      }
      const attachmentIds: string[] = [];
      for (const attachment of draft.attachments) {
        const uploaded = await api.uploadAttachment(
          attachment.uri,
          `mobile-attachment:${attachment.id}:${globalThis.crypto.randomUUID()}`,
        );
        attachmentIds.push(uploaded.data.attachment.id);
      }
      const skillIds = draft.mentions.flatMap((mention) =>
        mention.kind === "skill" ? [mention.id] : [],
      );
      const created = await api.invokeWorkflow(
        source.id,
        {
          description: draft.text.trim(),
          ...(skillIds.length > 0 ? { skillIds } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
        `mobile-workflow-invoke:${globalThis.crypto.randomUUID()}`,
      );
      return created.data.task;
    },
    onSuccess: async (task, draft) => {
      const source = backgroundTaskSource(draft)!.kind;
      analytics.capture("background_task_started", { source });
      showToast(`Started ${task.name} in the background.`);
      const { partition } = coordinator;
      if (partition && draft.attachments.length > 0) {
        // The workflow took its own copies, so the draft's attachments are spent.
        const [removeError] = await until(async () => {
          for (const attachment of draft.attachments)
            await removeStoredAttachment(partition, attachment.id);
          await queryClient.invalidateQueries({
            queryKey: chatQueryKeys.draft(partition, draft.conversationId),
            exact: true,
          });
        });
        if (removeError)
          showErrorToast(
            "The sent attachments could not be removed from the draft.",
            removeError,
            "chat.background_task.attachments",
          );
      }
      // Mobile has no side panel to show the Task in, so open its conversation once it exists.
      const [waitError] = await until(() => waitForConversation(task.conversationId));
      if (waitError)
        showErrorToast(
          "The new Task could not be loaded yet.",
          waitError,
          "chat.background_task.open",
        );
      router.replace({ pathname: "/chats/[chatId]", params: { chatId: task.conversationId } });
    },
    onError: (error, draft) => {
      analytics.capture("background_task_failed", {
        source: backgroundTaskSource(draft)?.kind ?? "task",
      });
      showErrorToast(
        error instanceof Error ? error.message : "The Task could not be started.",
        error,
        "chat.background_task.start",
      );
    },
  });
}
