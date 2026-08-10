import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function SwiftUIHostedComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "SwiftUI + Hosted", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="swiftui-hosted" />
    </>
  );
}
