import Drawer from "expo-router/drawer";
import { View } from "react-native";
import { useResolveClassNames, useUniwind } from "uniwind";

import { SCREEN_CORNER_RADIUS } from "@/lib/screen-corner-radius";
import {
  ChatInputControllerProvider,
  useChatInputController,
} from "@/widgets/chat/model/chat-input-controller";
import { Sidebar } from "@/widgets/sidebar";

export default function AppLayout() {
  return (
    <ChatInputControllerProvider>
      <AppDrawer />
    </ChatInputControllerProvider>
  );
}

function AppDrawer() {
  const { theme } = useUniwind();
  const input = useChatInputController();
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
        drawerContent={({ navigation }) => <Sidebar closeDrawer={() => navigation.closeDrawer()} />}
        screenListeners={{
          gestureStart: () => {
            void input.dismissComposer();
          },
          gestureEnd: () => {
            void input.dismissSearch();
          },
          transitionStart: (event) => {
            if (!event.data.closing) {
              input.setDrawerOpen(true);
              void input.dismissComposer();
            }
          },
          transitionEnd: (event) => {
            input.setDrawerOpen(!event.data.closing);
            if (event.data.closing) void input.dismissSearch();
          },
        }}
      >
        <Drawer.Screen name="(stack)" />
      </Drawer>
    </View>
  );
}
