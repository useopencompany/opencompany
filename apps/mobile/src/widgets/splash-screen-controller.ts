import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { useAuth } from "@/features/auth";

void SplashScreen.preventAutoHideAsync();

export function SplashScreenController() {
  const { isSessionLoading } = useAuth();

  useEffect(() => {
    if (!isSessionLoading) {
      void SplashScreen.hideAsync();
    }
  }, [isSessionLoading]);

  return null;
}
