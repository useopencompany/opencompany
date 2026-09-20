import { useSegments } from "expo-router";
import { PostHog, PostHogProvider } from "posthog-react-native";
import { type ReactNode, useEffect } from "react";

const POSTHOG_API_KEY = process.env.EXPO_PUBLIC_POSTHOG_API_KEY?.trim();
if (!POSTHOG_API_KEY) throw new Error("EXPO_PUBLIC_POSTHOG_API_KEY is required.");

export const analytics = new PostHog(POSTHOG_API_KEY, {
  host: "https://eu.i.posthog.com",
  captureAppLifecycleEvents: false,
  enableSessionReplay: false,
  disableRemoteFeatureFlags: true,
  preloadFeatureFlags: false,
  sendFeatureFlagEvent: false,
  errorTracking: { autocapture: false },
});

const screenNameFor = (segments: string[]): string => {
  if (segments.includes("sign-in")) return "sign_in";
  if (segments.includes("workspace-selection")) return "workspace_selection";
  if (segments.includes("account-unavailable")) return "account_unavailable";
  if (segments.includes("settings-sheet")) return "settings";
  if (segments.includes("attachment-sheet")) return "attachment_picker";
  if (segments.includes("camera")) return "camera";
  if (segments.includes("chats")) return "chat";
  return "new_chat";
};

function ScreenTracker() {
  const segments = useSegments();
  const screenName = screenNameFor(segments);

  useEffect(() => {
    analytics.screen(screenName);
  }, [screenName]);

  return null;
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  return (
    <PostHogProvider client={analytics} autocapture={false}>
      <ScreenTracker />
      {children}
    </PostHogProvider>
  );
}

export const captureError = (event: string, error: unknown, properties?: Record<string, unknown>) =>
  analytics.capture(event, {
    ...properties,
    error_type: error instanceof Error ? error.name : "unknown",
  });
