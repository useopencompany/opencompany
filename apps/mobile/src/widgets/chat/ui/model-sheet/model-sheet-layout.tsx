import { Stack } from "expo-router";

/**
 * The model sheet's own navigation stack. Every screen shares the native close item, and it
 * dismisses the whole sheet instead of stepping back one screen.
 */
export function ModelSheetLayout() {
  return (
    <Stack
      screenOptions={({ navigation }) => ({
        headerTransparent: true,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: "transparent" },
        unstable_headerRightItems: () => [
          {
            type: "button",
            label: "Close",
            icon: { type: "sfSymbol", name: "xmark" },
            onPress: () => navigation.getParent()?.goBack(),
          },
        ],
      })}
    >
      <Stack.Screen name="index" options={{ title: "Select model" }} />
      <Stack.Screen name="models" options={{ title: "Model" }} />
      <Stack.Screen name="effort" options={{ title: "Effort" }} />
    </Stack>
  );
}
