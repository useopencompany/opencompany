import { Stack } from "expo-router";

import { ComposerPlaygroundChat } from "@/widgets/chat";

export default function NativeModuleComposerScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "Native SwiftUI Module", headerTransparent: true }} />
      <ComposerPlaygroundChat variant="native-module" />
    </>
  );
}
