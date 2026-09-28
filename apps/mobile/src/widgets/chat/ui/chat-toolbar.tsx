import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { analytics } from "@/shared/lib/analytics";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import { useChatInputController } from "../model/chat-input-controller";
import { listStoredConversations } from "../model/chat-store";
import { useConversationActions } from "../model/conversation-actions";

export function ChatToolbar({ chatId }: { chatId: string }) {
  const { partition } = useChatCoordinator();
  const input = useChatInputController();
  const actions = useConversationActions();
  const conversations = useQuery({
    queryKey: partition
      ? chatQueryKeys.conversations(partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(partition!),
    enabled: Boolean(partition),
    select: (items) => items.find((item) => item.id === chatId),
  });
  const conversation = conversations.data;
  const availability = conversation ? actions.availability(conversation) : null;
  const isTask = conversation?.kind === "task";

  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button
        accessibilityLabel="New chat"
        icon="square.and.pencil"
        onPress={() => {
          input.requestComposerFocus();
          analytics.capture("new_chat_started");
          router.navigate("/");
        }}
      />
      {conversation && availability && (!isTask || availability.canArchive) ? (
        <Stack.Toolbar.Menu
          accessibilityLabel={isTask ? "Task options" : "Chat options"}
          icon="ellipsis"
          title={conversation.title}
        >
          <Stack.Toolbar.Label>{""}</Stack.Toolbar.Label>
          {isTask ? null : (
            <Stack.Toolbar.MenuAction
              disabled={!availability.canShare}
              icon="square.and.arrow.up"
              onPress={() => actions.share(conversation)}
            >
              Share
            </Stack.Toolbar.MenuAction>
          )}
          {isTask ? null : (
            <Stack.Toolbar.MenuAction
              disabled={!availability.canPin}
              icon={availability.isPinned ? "pin.slash" : "pin"}
              onPress={() => actions.togglePin(conversation)}
            >
              {availability.isPinned ? "Unpin" : "Pin"}
            </Stack.Toolbar.MenuAction>
          )}
          <Stack.Toolbar.MenuAction
            disabled={!availability.canArchive}
            icon="archivebox"
            onPress={() => actions.archive(conversation)}
          >
            Archive
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      ) : null}
    </Stack.Toolbar>
  );
}
