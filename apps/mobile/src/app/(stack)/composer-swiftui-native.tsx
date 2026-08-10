import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function SwiftUINativeComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "Full SwiftUI", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="swiftui-native" />
    </>
  );
}
