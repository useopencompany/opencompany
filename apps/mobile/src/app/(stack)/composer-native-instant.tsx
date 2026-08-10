import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function NativeInstantComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "RN Instant", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="native-instant" />
    </>
  );
}
