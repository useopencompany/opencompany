import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function NativeTimedComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "RN Synchronized", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="native-timed" />
    </>
  );
}
