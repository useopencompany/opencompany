import { Stack, useNavigation } from "expo-router";

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
            onPress: () => navigation.openDrawer(),
          },
        ],
      }}
    />
  );
}
