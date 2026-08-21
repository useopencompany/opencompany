import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import {
  clearSession,
  getLogoutUrl,
  getSessionId,
  getSignInUrl,
  getUser,
  handleCallback,
  REDIRECT_URI,
  type User,
} from "@/features/auth";

// This is a no-op on iOS. It only completes popup sessions on web and does not
// install a native URL listener.
WebBrowser.maybeCompleteAuthSession();

export interface AuthActionResult {
  success: boolean;
  error?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  initializationError: string | null;
  signIn: () => Promise<AuthActionResult>;
  signOut: () => Promise<AuthActionResult>;
}

interface CallbackOutcome {
  matched: boolean;
  cancelled: boolean;
  user?: User;
  error?: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function formatAuthError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Authentication could not be completed. Please try again.";
}

function getQueryParam(
  queryParams: ReturnType<typeof Linking.parse>["queryParams"],
  key: string,
): string | undefined {
  const value = queryParams?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function matchesRedirectUri(url: string, redirectUri: string): boolean {
  const actual = Linking.parse(url);
  const expected = Linking.parse(redirectUri);

  return (
    actual.scheme === expected.scheme &&
    actual.hostname === expected.hostname &&
    actual.path === expected.path
  );
}

async function processCallbackUrl(url: string, redirectUri: string): Promise<CallbackOutcome> {
  if (!matchesRedirectUri(url, redirectUri)) {
    return { matched: false, cancelled: false };
  }

  const parsed = Linking.parse(url);
  const callbackError = getQueryParam(parsed.queryParams, "error");

  if (callbackError) {
    // Denying consent is equivalent to closing the browser for v1: return to
    // the idle sign-in screen without presenting an error.
    if (callbackError === "access_denied") {
      return { matched: true, cancelled: true };
    }

    return {
      matched: true,
      cancelled: false,
      error: "The authentication provider returned an error. Please try again.",
    };
  }

  const code = getQueryParam(parsed.queryParams, "code");
  if (!code) {
    return {
      matched: true,
      cancelled: false,
      error: "The authentication callback did not include a code.",
    };
  }

  try {
    return {
      matched: true,
      cancelled: false,
      user: await handleCallback(code),
    };
  } catch (error) {
    return { matched: true, cancelled: false, error: formatAuthError(error) };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      let nextInitializationError: string | null = null;

      try {
        const restoredUser = await getUser();
        if (!mounted) return;
        setUser(restoredUser);

        // iOS openAuthSessionAsync resolves its own callback. This one check
        // only recovers a callback that relaunched the app from a cold start.
        const initialUrl = await Linking.getInitialURL();
        if (!mounted || !initialUrl) return;

        const outcome = await processCallbackUrl(initialUrl, REDIRECT_URI);
        if (!mounted || !outcome.matched) return;

        if (outcome.user) {
          setUser(outcome.user);
        } else if (outcome.error) {
          nextInitializationError = outcome.error;
        }
      } catch (error) {
        nextInitializationError = formatAuthError(error);
      } finally {
        if (mounted) {
          setInitializationError(nextInitializationError);
          setLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      mounted = false;
    };
  }, []);

  async function signIn(): Promise<AuthActionResult> {
    setLoading(true);
    setInitializationError(null);

    try {
      const url = await getSignInUrl();
      const result = await WebBrowser.openAuthSessionAsync(url, REDIRECT_URI);

      if (result.type !== "success" || !result.url) {
        // `cancel` and `dismiss` are expected user actions, not errors.
        return { success: false };
      }

      const outcome = await processCallbackUrl(result.url, REDIRECT_URI);
      if (outcome.cancelled) return { success: false };
      if (outcome.error) return { success: false, error: outcome.error };
      if (!outcome.matched || !outcome.user) {
        return {
          success: false,
          error: "The authentication callback was not recognized. Please try again.",
        };
      }

      setUser(outcome.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: formatAuthError(error) };
    } finally {
      setLoading(false);
    }
  }

  async function signOut(): Promise<AuthActionResult> {
    setLoading(true);

    try {
      const sessionId = await getSessionId();
      await clearSession();
      setUser(null);

      if (sessionId) {
        await WebBrowser.openBrowserAsync(getLogoutUrl(sessionId));
      }

      return { success: true };
    } catch (error) {
      setUser(null);
      return { success: false, error: formatAuthError(error) };
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, initializationError, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
