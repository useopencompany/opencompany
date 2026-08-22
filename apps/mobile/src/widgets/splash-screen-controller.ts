import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { useAuth } from "@/features/auth";

void SplashScreen.preventAutoHideAsync();

export function SplashScreenController() {
  const { isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      void SplashScreen.hideAsync();
    }
  }, [isLoading]);

  return null;
}
