import { Stack } from "expo-router";

import { StreamingChat } from "@/widgets/chat";
import { NEW_CHAT_ID } from "@/widgets/chat/model/chat-store";

export default function FirstStackScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />
      <StreamingChat chatId={NEW_CHAT_ID} />
    </>
  );
}
