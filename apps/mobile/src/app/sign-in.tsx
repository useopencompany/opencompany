import { Button, Host, ProgressView } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { useAuth } from "@/features/auth";
import { StyledImage } from "@/shared/ui/styled-image";
import { useToast } from "@/shared/ui/toast";

export default function SignInScreen() {
  const { initializationError, isLoading, signIn } = useAuth();
  const { showToast } = useToast();
  const shownInitializationErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!initializationError || shownInitializationErrorRef.current === initializationError) {
      return;
    }

    shownInitializationErrorRef.current = initializationError;
    showToast(initializationError);
  }, [initializationError, showToast]);

  const handleSignIn = async () => {
    const result = await signIn();
    const error = result.error;
    if (!result.success && error) {
      showToast(error);
    }
  };

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="items-center">
        <View accessible accessibilityLabel="opencompany" className="h-8 w-[195px]">
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
            {isLoading ? (
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
