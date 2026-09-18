import { Stack, useLocalSearchParams } from "expo-router";
import { StreamingChat } from "@/widgets/chat";

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />
      <StreamingChat chatId={chatId} />
    </>
  );
}
