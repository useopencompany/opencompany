import { install } from "react-native-quick-crypto";

install();

import "../global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider } from "@/features/auth";
import { RootNavigator } from "@/pages/root-navigator";
import { queryClient } from "@/shared/lib/query-client";
import { ToastProvider } from "@/shared/ui/toast";
import { ChatCoordinatorProvider } from "@/widgets/chat/model/chat-coordinator";
import { SplashScreenController } from "@/widgets/splash-screen-controller";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ChatCoordinatorProvider>
              <KeyboardProvider>
                <SplashScreenController />
                <RootNavigator />
              </KeyboardProvider>
            </ChatCoordinatorProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ToastProvider>
    </GestureHandlerRootView>
  );
}
