import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { useAuth } from "@/features/auth-provider";

void SplashScreen.preventAutoHideAsync();

export function SplashScreenController() {
  const { loading } = useAuth();

  useEffect(() => {
    if (!loading) {
      void SplashScreen.hideAsync();
    }
  }, [loading]);

  return null;
}
