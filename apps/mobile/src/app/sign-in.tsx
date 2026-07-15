import {
  exchangeCodeAsync,
  makeRedirectUri,
  ResponseType,
  useAuthRequest,
} from "expo-auth-session";
import { Redirect, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { AUTH_DISCOVERY, GOAT_DEV_TOKEN, OAUTH_CONFIGURED, WORKOS_CLIENT_ID } from "@/lib/config";
import { colors } from "@/lib/theme";

WebBrowser.maybeCompleteAuthSession();

const redirectUri = makeRedirectUri({ scheme: "goat", path: "auth/callback" });

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, applyTokenResponse } = useAuth();
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: WORKOS_CLIENT_ID ?? "",
      redirectUri,
      responseType: ResponseType.Code,
      usePKCE: true,
      scopes: [],
    },
    AUTH_DISCOVERY,
  );

  useEffect(() => {
    if (response?.type !== "success" || !request || !WORKOS_CLIENT_ID || !AUTH_DISCOVERY) return;
    const code = response.params.code;
    if (!code) return;
    let cancelled = false;
    setExchanging(true);
    setError(null);
    (async () => {
      try {
        const tokens = await exchangeCodeAsync(
          {
            clientId: WORKOS_CLIENT_ID,
            code,
            redirectUri,
            extraParams: { code_verifier: request.codeVerifier ?? "" },
          },
          AUTH_DISCOVERY,
        );
        if (cancelled) return;
        await applyTokenResponse(tokens);
        router.replace("/");
      } catch (exchangeError) {
        if (!cancelled) {
          setError(
            exchangeError instanceof Error ? exchangeError.message : "Sign-in failed. Try again.",
          );
        }
      } finally {
        if (!cancelled) setExchanging(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [response, request, applyTokenResponse, router]);

  if (GOAT_DEV_TOKEN || status === "signedIn") {
    return <Redirect href="/" />;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.body}>
        <Text style={styles.title}>Goat</Text>
        <Text style={styles.subtitle}>Your company brain, in your pocket.</Text>
      </View>
      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {OAUTH_CONFIGURED ? (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            disabled={!request || exchanging}
            onPress={() => {
              setError(null);
              promptAsync();
            }}
          >
            {exchanging ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonLabel}>Sign in</Text>
            )}
          </Pressable>
        ) : (
          <Text style={styles.setupHint}>
            Sign-in is not configured. Set EXPO_PUBLIC_WORKOS_CLIENT_ID and
            EXPO_PUBLIC_AUTHKIT_DOMAIN in apps/mobile/.env, or use the local dev token
            (EXPO_PUBLIC_GOAT_DEV_TOKEN + GOAT_MOBILE_DEV_TOKEN on the server).
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
  },
  body: {
    flex: 1,
    justifyContent: "center",
  },
  title: {
    fontSize: 40,
    fontWeight: "700",
    color: colors.textPrimary,
    letterSpacing: -1,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 17,
    color: colors.textSecondary,
  },
  footer: {
    paddingBottom: 16,
    gap: 12,
  },
  error: {
    color: colors.destructive,
    fontSize: 14,
  },
  setupHint: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    backgroundColor: colors.textPrimary,
    borderRadius: 14,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonLabel: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
});
