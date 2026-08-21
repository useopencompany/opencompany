import Drawer from "expo-router/drawer";
import { View } from "react-native";
import { useResolveClassNames, useUniwind } from "uniwind";

import { SCREEN_CORNER_RADIUS } from "@/lib/screen-corner-radius";
import { Sidebar } from "@/widgets/sidebar";

export default function AppLayout() {
  const { theme } = useUniwind();
  const drawerStyle = useResolveClassNames("w-xs bg-sidebar");
  const sceneStaticStyle = useResolveClassNames(
    theme === "dark"
      ? "overflow-hidden border-continuous screen-shadow-dark"
      : "overflow-hidden border-continuous screen-shadow-light",
  );

  return (
    // Sits between the drawer and content and covers the area around the
    // rounded corners of the scene.
    <View className="flex-1 bg-sidebar">
      <Drawer
        detachInactiveScreens={false}
        screenOptions={{
          drawerType: "back",
          overlayColor: "transparent",
          drawerStyle,
          swipeEdgeWidth: 120,
          headerShown: false,
          sceneStyle: [sceneStaticStyle, { borderRadius: SCREEN_CORNER_RADIUS }],
        }}
        // Render an element so Sidebar's drawer-progress hooks stay below the
        // DrawerProgressContext provider.
        drawerContent={() => <Sidebar />}
      >
        <Drawer.Screen name="(stack)" />
      </Drawer>
    </View>
  );
}
