import { Stack, useNavigation } from "expo-router";
import { KeyboardController } from "react-native-keyboard-controller";

export default function StackLayout() {
  // TS doesn't know the type of navigation, so we cast it to include openDrawer
  const navigation = useNavigation() as ReturnType<typeof useNavigation> & {
    openDrawer: () => void;
  };
  return (
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
      <Stack.Screen
        name="attachment-sheet"
        options={{
          presentation: "formSheet",
          animation: "default",
          headerShown: false,
          gestureEnabled: true,
          sheetGrabberVisible: true,
          contentStyle: { backgroundColor: "transparent" },
          sheetAllowedDetents: [0.6, 1],
        }}
      />
    </Stack>
  );
}
