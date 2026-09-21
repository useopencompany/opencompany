import { Stack, useLocalSearchParams } from "expo-router";
import { StreamingChat } from "@/widgets/chat";

export default function ChatScreen() {
  const { anchorMessageId, chatId } = useLocalSearchParams<{
    anchorMessageId?: string;
    chatId: string;
  }>();
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />
      <StreamingChat chatId={chatId} pendingAnchorMessageId={anchorMessageId} />
    </>
  );
}
