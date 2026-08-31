import { Stack } from "expo-router";
import { StreamingChat } from "@/widgets/chat";

export default function ChatScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />
      <StreamingChat />
    </>
  );
}
