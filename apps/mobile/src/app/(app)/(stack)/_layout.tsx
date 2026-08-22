import { router, Stack, useNavigation } from "expo-router";
import { KeyboardController } from "react-native-keyboard-controller";
import { useCSSVariable } from "uniwind";

import { ChatComposerProvider } from "@/widgets/chat/model/chat-composer-context";

export default function StackLayout() {
  // TS doesn't know the type of navigation, so we cast it to include openDrawer
  const navigation = useNavigation() as ReturnType<typeof useNavigation> & {
    openDrawer: () => void;
  };
  const backgroundColor = useCSSVariable("--color-background") as string;
  return (
    <ChatComposerProvider>
      <Stack
        screenOptions={{
          animation: "none",
          gestureEnabled: false,
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: "Sidebar",
              icon: {
                type: "sfSymbol",
                name: "sidebar.left",
              },
              onPress: () => {
                KeyboardController.dismiss();
                navigation.openDrawer();
              },
            },
          ],
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen
          name="camera"
          options={{
            presentation: "fullScreenModal",
            animation: "fade",
            headerShown: false,
            gestureEnabled: true,
          }}
        />
        <Stack.Screen
          name="attachment-sheet"
          options={{
            presentation: "formSheet",
            animation: "default",
            headerShown: false,
            gestureEnabled: true,
            sheetGrabberVisible: true,
            contentStyle: { backgroundColor: "transparent" },
            sheetAllowedDetents: [0.65],
          }}
        />
        <Stack.Screen
          name="settings-sheet"
          options={{
            headerTransparent: true,
            presentation: "formSheet",
            headerTitle: "Settings",
            animation: "default",
            headerShown: true,
            gestureEnabled: true,
            sheetGrabberVisible: true,
            contentStyle: { backgroundColor },
            sheetAllowedDetents: [1],
            unstable_headerLeftItems: () => [],
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Close",
                icon: {
                  type: "sfSymbol",
                  name: "xmark",
                },
                onPress: () => router.dismiss(),
              },
            ],
          }}
        />
      </Stack>
    </ChatComposerProvider>
  );
}
