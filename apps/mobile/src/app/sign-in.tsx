import { Button, Host, ProgressView } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { View } from "react-native";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { useAuth } from "@/features/auth-provider";
import { StyledImage } from "@/shared/ui/styled-image";

export default function SignInScreen() {
  const { initializationError, loading, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
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
          <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 48 }}>
            {loading ? (
              <ProgressView />
            ) : (
              <Button
                label="Sign in"
                onPress={() => void handleSignIn()}
                testID="sign-in-button"
                systemImage="rectangle.portrait.and.arrow.right"
                modifiers={[buttonStyle("glassProminent"), controlSize("large")]}
              />
            )}
          </Host>
        </View>
      </View>
    </View>
  );
}
