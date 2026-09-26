import { install } from "react-native-quick-crypto";

install();

import "../global.css";

import * as Sentry from "@sentry/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { isRunningInExpoGo } from "expo";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider } from "@/features/auth";
import { RootNavigator } from "@/pages/root-navigator";
import { AnalyticsProvider } from "@/shared/lib/analytics";
import { APP_VARIANT, IS_DEVELOPMENT_BUILD } from "@/shared/lib/app-variant";
import { queryClient } from "@/shared/lib/query-client";
import { ToastProvider } from "@/shared/ui/toast";
import { ChatCoordinatorProvider } from "@/widgets/chat/model/chat-coordinator";
import { SplashScreenController } from "@/widgets/splash-screen-controller";

Sentry.init({
  enabled: !IS_DEVELOPMENT_BUILD,
  dsn: "https://46a811602dbe62dc0ac0a0a730b6f641@o4512045432963072.ingest.de.sentry.io/4512119592845392",
  environment: APP_VARIANT,
  // Events carry the signed-in user id (set in AuthProvider) and nothing else identifying.
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  enableNativeFramesTracking: !isRunningInExpoGo(),
});

function RootLayout() {
  return (
    <AnalyticsProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <ChatCoordinatorProvider>
                {/* Preloading focuses a hidden input and can interrupt composer autofocus. */}
                <KeyboardProvider preload={false}>
                  <SplashScreenController />
                  <RootNavigator />
                </KeyboardProvider>
              </ChatCoordinatorProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ToastProvider>
      </GestureHandlerRootView>
    </AnalyticsProvider>
  );
}

export default Sentry.wrap(RootLayout);
