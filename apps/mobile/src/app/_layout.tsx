import "@/lib/polyfills";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider } from "@/lib/auth";
import { colors } from "@/lib/theme";

export default function RootLayout() {
  return (
    <AuthProvider>
      <KeyboardProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        />
        <StatusBar style="dark" />
      </KeyboardProvider>
    </AuthProvider>
  );
}
