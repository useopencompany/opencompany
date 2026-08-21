import { Button, Host } from "@expo/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { useCSSVariable } from "uniwind";

import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { useAuth } from "@/features/auth-provider";
import { StyledImage } from "@/shared/ui/styled-image";

export default function SignInScreen() {
  const { initializationError, loading, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const accent = useCSSVariable("--color-accent") as string;
  const visibleError = error ?? initializationError;

  async function handleSignIn() {
    setError(null);
    const result = await signIn();
    if (!result.success && result.error) {
      setError(result.error);
      console.error(result.error);
    }
  }

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="items-center">
        <View accessible accessibilityLabel="OpenCompany" className="h-8 w-[195px]">
          <StyledImage
            accessible={false}
            className="absolute inset-0 h-full w-full dark:opacity-0"
            contentFit="contain"
            source={wordmark}
          />
          <StyledImage
            accessible={false}
            className="absolute inset-0 h-full w-full opacity-0 dark:opacity-100"
            contentFit="contain"
            source={wordmarkDark}
          />
        </View>

        <View className="mt-10">
          <Host matchContents seedColor={accent}>
            <Button
              disabled={loading}
              label={loading ? "Signing in…" : "Sign in"}
              onPress={() => void handleSignIn()}
              testID="sign-in-button"
              variant="filled"
            />
          </Host>
        </View>

        {visibleError ? (
          <Text
            className="mt-5 max-w-[280px] text-center text-[15px] leading-5 text-muted-foreground"
            selectable
          >
            {visibleError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
