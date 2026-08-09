import "../global.css";

import Drawer from "expo-router/drawer";
import { useColorScheme, View } from "react-native";
import { SCREEN_CORNER_RADIUS } from "@/lib/screen-corner-radius";
import { Sidebar } from "@/widgets/sidebar";

export function RootNavigator() {
  const scheme = useColorScheme();
  // Sits behind everything, so it's what shows through the rounded corners of
  // the screen content once the drawer has slid it aside.
  const backdrop = scheme === "dark" ? "#111111" : "#F7F7F5";

  return (
    <View style={{ flex: 1, backgroundColor: backdrop }}>
      <Drawer
        screenOptions={{
          drawerType: "back",
          overlayColor: "transparent",
          drawerStyle: { width: 310, backgroundColor: backdrop },
          swipeEdgeWidth: 120,
          headerShown: false,
          sceneStyle: {
            borderRadius: SCREEN_CORNER_RADIUS,
            borderCurve: "continuous",
            overflow: "hidden",
          },
        }}
        // Must render as an element, not be passed by reference: `drawerContent`
        // is invoked as a plain function during the drawer's own render, so
        // hooks inside it would resolve above `DrawerProgressContext.Provider`
        // and `useDrawerProgress()` would throw.
        drawerContent={() => <Sidebar />}
      >
        <Drawer.Screen name="(stack)" />
      </Drawer>
    </View>
  );
}
