import type { IdentityUserDto, IdentityWorkspaceDto } from "@opencompany/protocol/schemas";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { createContext, type ReactNode, use, useEffect, useRef } from "react";
import { until } from "until-async";
import {
  type AuthenticatedApi,
  type AuthenticatedIdentity,
  createAuthenticatedApi,
  isUnauthorizedApiError,
} from "@/shared/api/opencompany-api";
import { queryClient } from "@/shared/lib/query-client";
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

export type AccountUnavailableReason = "incomplete-onboarding" | "no-workspaces";

export interface AuthContextValue {
  user: User | null;
  profile: IdentityUserDto | null;
  workspaces: IdentityWorkspaceDto[];
  workspace: IdentityWorkspaceDto | null;
  accountUnavailableReason: AccountUnavailableReason | null;
  api: AuthenticatedApi;
  isLoading: boolean;
  errorMessage: string | null;
  isSigningIn: boolean;
  isSigningOut: boolean;
  isRefreshingIdentity: boolean;
  selectingWorkspaceId: string | null;
  refreshIdentity: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

type AuthAction =
  | { type: "sign-in" }
  | { type: "callback"; code: string }
  | { type: "refresh-identity" }
  | { type: "select-workspace"; workspaceId: string }
  | { type: "clear-session" };

const AuthContext = createContext<AuthContextValue | null>(null);
const SESSION_QUERY_KEY = ["auth", "session"] as const;

class AuthCancellationError extends Error {}
class UnexpectedWorkspaceActivationError extends Error {}

const identityQueryKey = (userId: string | undefined) => ["auth", "identity", userId] as const;

const normalizeAuthError = (error: unknown): Error => {
  return error instanceof Error
    ? error
    : new Error("Authentication could not be completed. Please try again.");
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

const clearAuthentication = async (): Promise<void> => {
  const [clearError] = await until(clearSession);
  if (clearError) console.error("Failed to clear the stored session:", clearError);

  queryClient.setQueryData(SESSION_QUERY_KEY, null);
  await queryClient.cancelQueries();
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey.length !== SESSION_QUERY_KEY.length ||
      query.queryKey[0] !== SESSION_QUERY_KEY[0] ||
      query.queryKey[1] !== SESSION_QUERY_KEY[1],
  });
};

const api = createAuthenticatedApi({
  getAccessToken,
  onUnauthorized: clearAuthentication,
});

const cacheIdentity = (userId: string, identity: AuthenticatedIdentity, user?: User): void => {
  queryClient.setQueryData(identityQueryKey(userId), identity);
  if (user) queryClient.setQueryData(SESSION_QUERY_KEY, user);
};

const activateWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<AuthenticatedIdentity> => {
  const activation = await api.switchWorkspace(workspaceId);
  const refreshedUser = await selectOrganization(activation.organizationId);
  const identity = await api.getIdentity();
  const activeWorkspace = identity.workspaces.find((item) => item.id === workspaceId);

  if (identity.activeWorkspaceId !== workspaceId || !activeWorkspace) {
    cacheIdentity(userId, { ...identity, activeWorkspaceId: null }, refreshedUser);
    throw new UnexpectedWorkspaceActivationError(
      "The selected workspace did not become active. Please try again.",
    );
  }

  cacheIdentity(userId, identity, refreshedUser);
  return identity;
};

const loadIdentity = async (
  userId: string,
  mode: "read" | "sync",
  user?: User,
): Promise<AuthenticatedIdentity> => {
  const identity = mode === "sync" ? await api.syncIdentity() : await api.getIdentity();
  const hasActiveWorkspace = Boolean(
    identity.activeWorkspaceId &&
      identity.workspaces.some((workspace) => workspace.id === identity.activeWorkspaceId),
  );

  if (hasActiveWorkspace || !identity.user.onboardedAt || identity.workspaces.length !== 1) {
    cacheIdentity(userId, identity, user);
    return identity;
  }

  try {
    return await activateWorkspace(userId, identity.workspaces[0].id);
  } catch (error) {
    if (!(error instanceof UnexpectedWorkspaceActivationError) && !isUnauthorizedApiError(error)) {
      cacheIdentity(userId, identity);
    }
    throw normalizeAuthError(error);
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const authorizationRef = useRef<{ code: string; promise: Promise<void> } | null>(null);
  const processUrlRef = useRef<(url: string) => Promise<void>>(async () => {});
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: getStoredUser,
    retry: false,
    staleTime: Infinity,
  });
  const user = sessionQuery.data ?? null;
  const identityQuery = useQuery({
    queryKey: identityQueryKey(user?.id),
    queryFn: () => loadIdentity(user!.id, "read"),
    enabled: Boolean(user),
    retry: false,
    staleTime: Infinity,
  });

  const completeSignIn = async (code: string): Promise<void> => {
    const newUser = await handleCallback(code);
    const [identityError] = await until(() => loadIdentity(newUser.id, "sync", newUser));

    if (identityError && !isUnauthorizedApiError(identityError)) {
      queryClient.setQueryData(SESSION_QUERY_KEY, newUser);
    }
    if (identityError) throw normalizeAuthError(identityError);
  };

  const completeSignInOnce = (code: string): Promise<void> => {
    if (authorizationRef.current?.code === code) return authorizationRef.current.promise;
    const promise = completeSignIn(code);
    authorizationRef.current = { code, promise };
    return promise;
  };

  const authMutation = useMutation({
    scope: { id: "auth" },
    mutationFn: async (action: AuthAction): Promise<void> => {
      try {
        if (action.type === "clear-session") return clearAuthentication();
        if (action.type === "callback") return completeSignInOnce(action.code);

        if (action.type === "sign-in") {
          const url = await getSignInUrl();
          const result = await WebBrowser.openAuthSessionAsync(url, REDIRECT_URI);
          if (result.type !== "success" || !result.url) {
            throw new AuthCancellationError("Authentication was cancelled");
          }

          const parsed = Linking.parse(result.url);
          const oauthError = parsed.queryParams?.error as string | undefined;
          if (oauthError) {
            const description = parsed.queryParams?.error_description as string | undefined;
            throw new Error(description || oauthError);
          }

          const code = parsed.queryParams?.code as string | undefined;
          if (!code) throw new Error("No authorization code received");
          return completeSignInOnce(code);
        }

        if (!user) throw new Error("No active session found");

        if (action.type === "refresh-identity") {
          await loadIdentity(user.id, "sync");
          return;
        }

        const identity = queryClient.getQueryData<AuthenticatedIdentity>(identityQueryKey(user.id));
        if (!identity?.workspaces.some((workspace) => workspace.id === action.workspaceId)) {
          throw new Error("That workspace is no longer available.");
        }

        await activateWorkspace(user.id, action.workspaceId);
      } catch (error) {
        throw normalizeAuthError(error);
      }
    },
  });

  const signOutMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      try {
        const sessionId = await getSessionId();
        if (!sessionId) throw new Error("No active session found");
        await WebBrowser.openBrowserAsync(getLogoutUrl(sessionId));
      } catch (error) {
        throw normalizeAuthError(error);
      }
    },
  });

  processUrlRef.current = async (url: string): Promise<void> => {
    if (matchesRedirectUri(url, SIGN_OUT_REDIRECT_URI)) {
      await authMutation.mutateAsync({ type: "clear-session" });
      return;
    }

    if (!matchesRedirectUri(url, REDIRECT_URI)) return;
    const parsed = Linking.parse(url);
    const oauthError = parsed.queryParams?.error as string | undefined;
    if (oauthError) {
      console.error("OAuth error:", oauthError, parsed.queryParams?.error_description);
      return;
    }

    const code = parsed.queryParams?.code as string | undefined;
    if (!code) {
      console.error("No authorization code in callback");
      return;
    }

    const [callbackError] = await until(() => authMutation.mutateAsync({ type: "callback", code }));
    if (callbackError && !isUnauthorizedApiError(callbackError)) {
      console.error("Auth callback failed:", callbackError);
    }
  };

  useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => void processUrlRef.current(url);
    const subscription = Linking.addEventListener("url", handleUrl);
    void Linking.getInitialURL().then((url) => {
      if (url) void processUrlRef.current(url);
    });

    return () => subscription.remove();
  }, []);

  const identity = identityQuery.data;
  const pendingAction = authMutation.isPending ? authMutation.variables : null;
  const profile = identity?.user ?? null;
  const workspaces = identity?.workspaces ?? [];
  const workspace =
    identity?.activeWorkspaceId && identity.user.onboardedAt
      ? (workspaces.find((item) => item.id === identity.activeWorkspaceId) ?? null)
      : null;
  const isSigningIn = pendingAction?.type === "sign-in" || pendingAction?.type === "callback";
  const isClearingSession = pendingAction?.type === "clear-session";
  const queryError = sessionQuery.error ?? identityQuery.error;
  const mutationError = authMutation.error;
  const errorMessage =
    (mutationError &&
    !(mutationError instanceof AuthCancellationError) &&
    !isUnauthorizedApiError(mutationError)
      ? mutationError.message
      : null) ??
    (queryError && !isUnauthorizedApiError(queryError)
      ? normalizeAuthError(queryError).message
      : null);
  let accountUnavailableReason: AccountUnavailableReason | null = null;
  if (identity && !identity.user.onboardedAt) accountUnavailableReason = "incomplete-onboarding";
  else if (identity?.workspaces.length === 0) accountUnavailableReason = "no-workspaces";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        workspaces,
        workspace,
        accountUnavailableReason,
        api,
        isLoading:
          sessionQuery.isPending ||
          (Boolean(user) && identityQuery.isPending) ||
          isSigningIn ||
          isClearingSession,
        errorMessage,
        isSigningIn,
        isSigningOut: signOutMutation.isPending,
        isRefreshingIdentity: pendingAction?.type === "refresh-identity",
        selectingWorkspaceId:
          pendingAction?.type === "select-workspace" ? pendingAction.workspaceId : null,
        refreshIdentity: () => authMutation.mutateAsync({ type: "refresh-identity" }),
        selectWorkspace: (workspaceId) =>
          authMutation.mutateAsync({ type: "select-workspace", workspaceId }),
        signIn: () => authMutation.mutateAsync({ type: "sign-in" }),
        signOut: () => signOutMutation.mutateAsync(),
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
