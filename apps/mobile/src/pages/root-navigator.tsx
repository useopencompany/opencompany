import "../global.css";

import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import Drawer from "expo-router/drawer";
import { View } from "react-native";
import { useCSSVariable, useResolveClassNames, useUniwind } from "uniwind";
import { SCREEN_CORNER_RADIUS } from "@/lib/screen-corner-radius";
import { Sidebar } from "@/widgets/sidebar";

export function RootNavigator() {
  const { theme } = useUniwind();
  const backgroundColor = useCSSVariable("--color-background") as string;

  const darkTheme: ReactNavigation.Theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: backgroundColor,
    },
  };

  const lightTheme: ReactNavigation.Theme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: backgroundColor,
    },
  };

  return (
    <ThemeProvider value={theme === "dark" ? darkTheme : lightTheme}>
      {/* Sits between the drawer and content (covers the area around the rounded corners of the scene) */}
      <View className="flex-1 bg-background-secondary">
        <Drawer
          screenOptions={{
            drawerType: "back",
            overlayColor: "transparent",
            drawerStyle: useResolveClassNames("w-xs bg-background-secondary"),
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
    </ThemeProvider>
  );
}
