import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import Stack from "expo-router/stack";
import { useCSSVariable, useUniwind } from "uniwind";
import { useAuth } from "@/features/auth";

export function RootNavigator() {
  const { accountUnavailableReason, isLoading, isSessionLoading, user, workspace } = useAuth();
  const { theme } = useUniwind();
  const backgroundColor = useCSSVariable("--color-background") as string;
  const isAuthenticated = Boolean(user);
  const hasWorkspace = Boolean(workspace);
  const isAccountUnavailable = accountUnavailableReason !== null;
  const isAuthenticatedRouteReady = isAuthenticated && !isLoading;
  const shouldShowApp = isSessionLoading || (isAuthenticated && (isLoading || hasWorkspace));

  const darkTheme: ReactNavigation.Theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: backgroundColor,
    },
  };

  const lightTheme: ReactNavigation.Theme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: backgroundColor,
    },
  };

  return (
    <ThemeProvider value={theme === "dark" ? darkTheme : lightTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={shouldShowApp}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>

        <Stack.Protected guard={!isSessionLoading && !isAuthenticated}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>

        <Stack.Protected guard={isAuthenticatedRouteReady && !hasWorkspace && isAccountUnavailable}>
          <Stack.Screen
            name="account-unavailable"
            options={{ headerShown: true, title: "Account unavailable" }}
          />
        </Stack.Protected>

        <Stack.Protected
          guard={isAuthenticatedRouteReady && !hasWorkspace && !isAccountUnavailable}
        >
          <Stack.Screen
            name="workspace-selection"
            options={{ headerShown: true, title: "Choose a workspace", headerTransparent: true }}
          />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
