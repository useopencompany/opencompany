import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { analytics } from "@/shared/lib/analytics";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import { useChatInputController } from "../model/chat-input-controller";
import { listStoredConversations } from "../model/chat-store";

const noOp = () => {};

export function ChatToolbar({ chatId }: { chatId: string }) {
  const { partition } = useChatCoordinator();
  const input = useChatInputController();
  const conversations = useQuery({
    queryKey: partition
      ? chatQueryKeys.conversations(partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(partition!),
    enabled: Boolean(partition),
    select: (items) => items.find((item) => item.id === chatId),
  });

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
      <Stack.Toolbar.Menu
        accessibilityLabel="Chat options"
        icon="ellipsis"
        title={conversations.data?.title ?? "Chat"}
      >
        <Stack.Toolbar.Label>{""}</Stack.Toolbar.Label>
        <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={noOp}>
          Share
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction icon="pin" onPress={noOp}>
          Pin
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction icon="magnifyingglass" onPress={noOp}>
          Find in chat
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction icon="archivebox" onPress={noOp}>
          Archive
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}
