import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { until } from "until-async";
import {
  clearSession,
  getLogoutUrl,
  getSessionId,
  getSignInUrl,
  getUser,
  handleCallback,
  REDIRECT_URI,
  SIGN_OUT_REDIRECT_URI,
  type User,
} from "./auth";

WebBrowser.maybeCompleteAuthSession();

export interface AuthActionResult {
  success: boolean;
  error?: string;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  initializationError: string | null;
  signIn: () => Promise<AuthActionResult>;
  signOut: () => Promise<AuthActionResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const formatAuthError = (error: unknown): string => {
  return error instanceof Error
    ? error.message
    : "Authentication could not be completed. Please try again.";
};

const matchesRedirectUri = (url: string, redirectUri: string): boolean => {
  const parsed = Linking.parse(url);
  const redirect = Linking.parse(redirectUri);

  return (
    parsed.scheme === redirect.scheme &&
    parsed.hostname === redirect.hostname &&
    parsed.path === redirect.path
  );
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    getUser()
      .then(setUser)
      .catch((error) => {
        console.error("Failed to load stored session:", error);
        setInitializationError(formatAuthError(error));
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      if (matchesRedirectUri(url, SIGN_OUT_REDIRECT_URI)) {
        setIsLoading(true);
        const [clearSessionError] = await until(clearSession);

        if (clearSessionError) {
          console.error(
            "Failed to clear session after sign out:",
            clearSessionError,
          );
        } else {
          setUser(null);
        }

        setIsLoading(false);
        return;
      }

      const parsed = Linking.parse(url);
      if (!matchesRedirectUri(url, REDIRECT_URI)) return;

      const error = parsed.queryParams?.error as string | undefined;
      if (error) {
        console.error(
          "OAuth error:",
          error,
          parsed.queryParams?.error_description,
        );
        return;
      }

      const code = parsed.queryParams?.code as string | undefined;
      if (!code) {
        console.error("No authorization code in callback");
        return;
      }

      setIsLoading(true);
      try {
        const newUser = await handleCallback(code);
        setUser(newUser);
      } catch (error) {
        console.error("Auth callback failed:", error);
        setInitializationError(formatAuthError(error));
      } finally {
        setIsLoading(false);
      }
    };

    const subscription = Linking.addEventListener("url", handleUrl);
    Linking.getInitialURL().then((url) => {
      if (url) void handleUrl({ url });
    });

    return () => subscription.remove();
  }, []);

  const signIn = async (): Promise<AuthActionResult> => {
    try {
      setIsLoading(true);
      setInitializationError(null);
      const url = await getSignInUrl();

      const result = await WebBrowser.openAuthSessionAsync(url, REDIRECT_URI);

      if (result.type !== "success" || !result.url) {
        return { success: false, error: "Authentication was cancelled" };
      }

      const parsed = Linking.parse(result.url);

      const error = parsed.queryParams?.error as string | undefined;
      if (error) {
        const errorDescription = parsed.queryParams
          ?.error_description as string;
        return { success: false, error: errorDescription || error };
      }

      const code = parsed.queryParams?.code as string | undefined;
      if (!code) {
        return { success: false, error: "No authorization code received" };
      }

      const newUser = await handleCallback(code);
      setUser(newUser);
      return { success: true };
    } catch (error) {
      console.error("[Auth] Sign in failed:", error);
      return { success: false, error: String(error) };
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async (): Promise<AuthActionResult> => {
    const [sessionIdError, sessionId] = await until(getSessionId);
    if (sessionIdError) {
      return { success: false, error: formatAuthError(sessionIdError) };
    }

    if (!sessionId) {
      return { success: false, error: "No active session found" };
    }

    const [openBrowserError] = await until(() =>
      WebBrowser.openBrowserAsync(getLogoutUrl(sessionId)),
    );
    if (openBrowserError) {
      return { success: false, error: formatAuthError(openBrowserError) };
    }

    return { success: true };
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading, initializationError, signIn, signOut }}
    >
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
