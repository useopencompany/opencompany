import type { IdentityUserDto, IdentityWorkspaceDto } from "@opencompany/protocol/schemas";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import { until } from "until-async";
import {
  type AuthenticatedApi,
  type AuthenticatedIdentity,
  createAuthenticatedApi,
  isUnauthorizedApiError,
} from "@/shared/api/opencompany-api";
import {
  clearSession,
  getAccessToken,
  getLogoutUrl,
  getSessionId,
  getSignInUrl,
  getStoredUser,
  handleCallback,
  REDIRECT_URI,
  SIGN_OUT_REDIRECT_URI,
  selectOrganization,
  type User,
} from "./auth";

WebBrowser.maybeCompleteAuthSession();

export interface AuthActionResult {
  success: boolean;
  error?: string;
}

export type AccountUnavailableReason = "incomplete-onboarding" | "no-workspaces";

export interface AuthContextValue {
  user: User | null;
  profile: IdentityUserDto | null;
  workspaces: IdentityWorkspaceDto[];
  workspace: IdentityWorkspaceDto | null;
  accountUnavailableReason: AccountUnavailableReason | null;
  api: AuthenticatedApi;
  isLoading: boolean;
  initializationError: string | null;
  refreshIdentity: () => Promise<AuthActionResult>;
  selectWorkspace: (workspaceId: string) => Promise<AuthActionResult>;
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
  const [profile, setProfile] = useState<IdentityUserDto | null>(null);
  const [workspaces, setWorkspaces] = useState<IdentityWorkspaceDto[]>([]);
  const [workspace, setWorkspace] = useState<IdentityWorkspaceDto | null>(null);
  const [accountUnavailableReason, setAccountUnavailableReason] =
    useState<AccountUnavailableReason | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const authorizationRef = useRef<{ code: string; promise: Promise<void> } | null>(null);

  const clearAuthState = async (): Promise<void> => {
    const [clearError] = await until(clearSession);
    if (clearError) console.error("Failed to clear the stored session:", clearError);
    setUser(null);
    setProfile(null);
    setWorkspaces([]);
    setWorkspace(null);
    setAccountUnavailableReason(null);
    setInitializationError(null);
  };

  const [api] = useState<AuthenticatedApi>(() =>
    createAuthenticatedApi({
      getAccessToken,
      onUnauthorized: clearAuthState,
    }),
  );

  const storeIdentityState = (identity: AuthenticatedIdentity): IdentityWorkspaceDto | null => {
    setProfile(identity.user);
    setWorkspaces(identity.workspaces);

    if (!identity.user.onboardedAt) {
      setWorkspace(null);
      setAccountUnavailableReason("incomplete-onboarding");
      return null;
    }

    if (identity.workspaces.length === 0) {
      setWorkspace(null);
      setAccountUnavailableReason("no-workspaces");
      return null;
    }

    setAccountUnavailableReason(null);
    const activeWorkspace = identity.activeWorkspaceId
      ? (identity.workspaces.find((item) => item.id === identity.activeWorkspaceId) ?? null)
      : null;
    setWorkspace(activeWorkspace);
    return activeWorkspace;
  };

  const activateWorkspace = async (workspaceId: string): Promise<void> => {
    const activation = await api.switchWorkspace(workspaceId);
    const refreshedUser = await selectOrganization(activation.organizationId);
    setUser(refreshedUser);

    const identity = await api.getIdentity();
    const activeWorkspace = identity.workspaces.find((item) => item.id === workspaceId) ?? null;
    if (identity.activeWorkspaceId !== workspaceId || !activeWorkspace) {
      storeIdentityState(identity);
      setWorkspace(null);
      throw new Error("The selected workspace did not become active. Please try again.");
    }

    storeIdentityState(identity);
    setWorkspace(activeWorkspace);
  };

  const resolveIdentity = async (
    identity: AuthenticatedIdentity,
    autoActivate: boolean,
  ): Promise<void> => {
    const activeWorkspace = storeIdentityState(identity);
    if (activeWorkspace || !identity.user.onboardedAt || identity.workspaces.length === 0) {
      return;
    }

    if (autoActivate && identity.workspaces.length === 1) {
      await activateWorkspace(identity.workspaces[0].id);
    }
  };

  const loadIdentity = async (mode: "read" | "sync", autoActivate: boolean): Promise<void> => {
    const identity = mode === "sync" ? await api.syncIdentity() : await api.getIdentity();
    await resolveIdentity(identity, autoActivate);
  };

  useEffect(() => {
    const bootstrap = async () => {
      const [storedUserError, storedUser] = await until(getStoredUser);
      if (storedUserError) {
        console.error("Failed to read the stored session:", storedUserError);
        setInitializationError(formatAuthError(storedUserError));
        setIsLoading(false);
        return;
      }
      if (!storedUser) {
        setIsLoading(false);
        return;
      }

      setUser(storedUser);
      const [identityError] = await until(() => loadIdentity("read", true));
      if (identityError && !isUnauthorizedApiError(identityError)) {
        console.error("Failed to restore backend identity:", identityError);
        setInitializationError(formatAuthError(identityError));
      }
      setIsLoading(false);
    };

    void bootstrap();
  }, []);

  const completeSignIn = async (code: string): Promise<void> => {
    const newUser = await handleCallback(code);
    setUser(newUser);
    await loadIdentity("sync", true);
  };

  const completeSignInOnce = (code: string): Promise<void> => {
    if (authorizationRef.current?.code === code) return authorizationRef.current.promise;

    const promise = completeSignIn(code);
    authorizationRef.current = { code, promise };
    return promise;
  };

  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      if (matchesRedirectUri(url, SIGN_OUT_REDIRECT_URI)) {
        setIsLoading(true);
        await clearAuthState();
        setIsLoading(false);
        return;
      }

      const parsed = Linking.parse(url);
      if (!matchesRedirectUri(url, REDIRECT_URI)) return;

      const error = parsed.queryParams?.error as string | undefined;
      if (error) {
        console.error("OAuth error:", error, parsed.queryParams?.error_description);
        return;
      }

      const code = parsed.queryParams?.code as string | undefined;
      if (!code) {
        console.error("No authorization code in callback");
        return;
      }

      setIsLoading(true);
      setInitializationError(null);
      const [callbackError] = await until(() => completeSignInOnce(code));
      if (callbackError && !isUnauthorizedApiError(callbackError)) {
        console.error("Auth callback failed:", callbackError);
        setInitializationError(formatAuthError(callbackError));
      }
      setIsLoading(false);
    };

    const subscription = Linking.addEventListener("url", handleUrl);
    void Linking.getInitialURL().then((url) => {
      if (url) void handleUrl({ url });
    });

    return () => subscription.remove();
  }, []);

  const refreshIdentity = async (): Promise<AuthActionResult> => {
    setInitializationError(null);
    const [error] = await until(() => loadIdentity("sync", true));
    if (error) {
      if (!isUnauthorizedApiError(error)) setInitializationError(formatAuthError(error));
      return { success: false, error: formatAuthError(error) };
    }
    return { success: true };
  };

  const selectWorkspace = async (workspaceId: string): Promise<AuthActionResult> => {
    if (!workspaces.some((item) => item.id === workspaceId)) {
      return { success: false, error: "That workspace is no longer available." };
    }

    setInitializationError(null);
    const [error] = await until(() => activateWorkspace(workspaceId));
    if (error) {
      if (!isUnauthorizedApiError(error)) setInitializationError(formatAuthError(error));
      return { success: false, error: formatAuthError(error) };
    }
    return { success: true };
  };

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
        const errorDescription = parsed.queryParams?.error_description as string;
        return { success: false, error: errorDescription || error };
      }

      const code = parsed.queryParams?.code as string | undefined;
      if (!code) return { success: false, error: "No authorization code received" };

      await completeSignInOnce(code);
      return { success: true };
    } catch (error) {
      console.error("[Auth] Sign in failed:", error);
      if (!isUnauthorizedApiError(error)) setInitializationError(formatAuthError(error));
      return { success: false, error: formatAuthError(error) };
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async (): Promise<AuthActionResult> => {
    const [sessionIdError, sessionId] = await until(getSessionId);
    if (sessionIdError) {
      return { success: false, error: formatAuthError(sessionIdError) };
    }
    if (!sessionId) return { success: false, error: "No active session found" };

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
      value={{
        user,
        profile,
        workspaces,
        workspace,
        accountUnavailableReason,
        api,
        isLoading,
        initializationError,
        refreshIdentity,
        selectWorkspace,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
