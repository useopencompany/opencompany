import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function IsolatedHostComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "Isolated Input Host", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="isolated-host" />
    </>
  );
}
