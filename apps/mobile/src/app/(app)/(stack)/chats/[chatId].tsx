import { Stack, useLocalSearchParams } from "expo-router";
import { StreamingChat } from "@/widgets/chat";
import { ChatToolbar } from "@/widgets/chat/ui/chat-toolbar";

export default function ChatScreen() {
  const { anchorMessageId, chatId } = useLocalSearchParams<{
    anchorMessageId?: string;
    chatId: string;
  }>();
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />
      <StreamingChat key={chatId} chatId={chatId} pendingAnchorMessageId={anchorMessageId} />
      <ChatToolbar chatId={chatId} />
    </>
  );
}
