import { refreshAsync, type TokenResponse } from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AUTH_DISCOVERY, GOAT_DEV_TOKEN, WORKOS_CLIENT_ID } from "@/lib/config";

const STORAGE_KEY = "goat.auth.tokens.v1";
// Refresh slightly before expiry; AuthKit access tokens are short-lived (~5 min).
const EXPIRY_MARGIN_MS = 30_000;

type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

type AuthStatus = "loading" | "signedOut" | "signedIn";

type AuthContextValue = {
  status: AuthStatus;
  // Returns a valid access token, refreshing when needed; null when signed out.
  getAccessToken: () => Promise<string | null>;
  applyTokenResponse: (response: TokenResponse) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function storedTokensFromResponse(
  response: TokenResponse,
  previous: StoredTokens | null,
): StoredTokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? previous?.refreshToken ?? null,
    expiresAt:
      typeof response.expiresIn === "number"
        ? (response.issuedAt + response.expiresIn) * 1000
        : null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(GOAT_DEV_TOKEN ? "signedIn" : "loading");
  const tokensRef = useRef<StoredTokens | null>(null);
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (GOAT_DEV_TOKEN) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (cancelled) return;
        if (raw) {
          tokensRef.current = JSON.parse(raw) as StoredTokens;
          setStatus("signedIn");
        } else {
          setStatus("signedOut");
        }
      } catch {
        if (!cancelled) setStatus("signedOut");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistTokens = useCallback(async (tokens: StoredTokens | null) => {
    tokensRef.current = tokens;
    if (tokens) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tokens));
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    }
  }, []);

  const signOut = useCallback(async () => {
    await persistTokens(null);
    setStatus("signedOut");
  }, [persistTokens]);

  const applyTokenResponse = useCallback(
    async (response: TokenResponse) => {
      await persistTokens(storedTokensFromResponse(response, tokensRef.current));
      setStatus("signedIn");
    },
    [persistTokens],
  );

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (GOAT_DEV_TOKEN) return GOAT_DEV_TOKEN;

    const tokens = tokensRef.current;
    if (!tokens) return null;
    const fresh = tokens.expiresAt === null || Date.now() < tokens.expiresAt - EXPIRY_MARGIN_MS;
    if (fresh) return tokens.accessToken;

    if (!refreshInFlightRef.current) {
      refreshInFlightRef.current = (async () => {
        try {
          if (!tokens.refreshToken || !WORKOS_CLIENT_ID || !AUTH_DISCOVERY) {
            await signOut();
            return null;
          }
          const response = await refreshAsync(
            { clientId: WORKOS_CLIENT_ID, refreshToken: tokens.refreshToken },
            AUTH_DISCOVERY,
          );
          const next = storedTokensFromResponse(response, tokens);
          await persistTokens(next);
          return next.accessToken;
        } catch {
          await signOut();
          return null;
        } finally {
          refreshInFlightRef.current = null;
        }
      })();
    }
    return refreshInFlightRef.current;
  }, [persistTokens, signOut]);

  const value = useMemo(
    () => ({ status, getAccessToken, applyTokenResponse, signOut }),
    [status, getAccessToken, applyTokenResponse, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
