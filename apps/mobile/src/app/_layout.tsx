import { install } from "react-native-quick-crypto";

install();

import "../global.css";

import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider } from "@/features/auth-provider";
import { SplashScreenController } from "@/features/splash-screen-controller";
import { RootNavigator } from "@/pages/root-navigator";

export default function RootLayout() {
  return (
    <AuthProvider>
      <KeyboardProvider>
        <SplashScreenController />
        <RootNavigator />
      </KeyboardProvider>
    </AuthProvider>
  );
}
