import type { IdentityUserDto, IdentityWorkspaceDto } from "@opencompany/protocol/schemas";
import { hashKey, useMutation, useQuery } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { createContext, type ReactNode, use, useEffect } from "react";
import { Alert } from "react-native";
import { until } from "until-async";
import {
  type AuthenticatedApi,
  type AuthenticatedIdentity,
  createAuthenticatedApi,
  isUnauthorizedApiError,
} from "@/shared/api/opencompany-api";
import { queryClient } from "@/shared/lib/query-client";
import { abortChatActivity, resumeChatActivity } from "@/widgets/chat/model/chat-lifecycle";
import {
  hasPendingWorkspaceWork,
  purgeAllChatData,
  purgePartition,
} from "@/widgets/chat/model/chat-store";
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
  isSessionLoading: boolean;
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
  | { type: "callback"; url: string }
  | { type: "refresh-identity" }
  | { type: "select-workspace"; workspaceId: string }
  | { type: "clear-session" };

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_QUERY_KEY = ["auth", "session"] as const;
const SESSION_QUERY_HASH = hashKey(SESSION_QUERY_KEY);
const identityQueryKey = (userId: string | undefined) => ["auth", "identity", userId] as const;

class AuthCancellationError extends Error {}
class UnexpectedWorkspaceActivationError extends Error {}

const normalizeAuthError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("Authentication could not be completed. Please try again.");

/** Cancellations are deliberate and a 401 already reset the session, so neither needs a message. */
const toDisplayMessage = (error: unknown): string | null =>
  !error || error instanceof AuthCancellationError || isUnauthorizedApiError(error)
    ? null
    : normalizeAuthError(error).message;

const accountUnavailableReasonFor = (
  identity: AuthenticatedIdentity | undefined,
): AccountUnavailableReason | null => {
  if (!identity) return null;
  if (!identity.user.onboardedAt) return "incomplete-onboarding";
  if (identity.workspaces.length === 0) return "no-workspaces";
  return null;
};

const requireCachedUser = (): User => {
  const user = queryClient.getQueryData<User | null>(SESSION_QUERY_KEY);
  if (!user) throw new Error("No active session found");
  return user;
};

const clearAuthentication = async (): Promise<void> => {
  abortChatActivity();
  await queryClient.cancelQueries();
  const [purgeError] = await until(purgeAllChatData);
  if (purgeError) console.error("Failed to purge local chat data:", purgeError);
  const [clearError] = await until(clearSession);
  if (clearError) console.error("Failed to clear the stored session:", clearError);

  queryClient.setQueryData(SESSION_QUERY_KEY, null);
  // Drop everything the previous user could still see. The session query is kept so the provider
  // reports "signed out" instead of dropping back into its initial loading state.
  queryClient.removeQueries({ predicate: (query) => query.queryHash !== SESSION_QUERY_HASH });
};

const confirmWorkspaceDiscard = (): Promise<boolean> =>
  new Promise((resolve) => {
    Alert.alert(
      "Discard local chat work?",
      "This workspace has a draft, pending attachment, or queued action. Accepted runs will continue on the server.",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Discard & Switch", style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

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

/** Loads the identity, activating the workspace for onboarded accounts that only have one. */
const loadIdentity = async (
  userId: string,
  mode: "read" | "sync",
  user?: User,
): Promise<AuthenticatedIdentity> => {
  const identity = mode === "sync" ? await api.syncIdentity() : await api.getIdentity();
  const hasActiveWorkspace = identity.workspaces.some(
    (workspace) => workspace.id === identity.activeWorkspaceId,
  );
  const soleWorkspace = identity.workspaces.length === 1 ? identity.workspaces[0] : null;

  if (hasActiveWorkspace || !identity.user.onboardedAt || !soleWorkspace) {
    cacheIdentity(userId, identity, user);
    return identity;
  }

  const [activationError, activated] = await until(() =>
    activateWorkspace(userId, soleWorkspace.id),
  );
  if (!activationError) return activated;

  // Cache the identity we did load so the workspace picker can still render, unless
  // activateWorkspace already cached a corrected one or a 401 wiped the session.
  if (
    !(activationError instanceof UnexpectedWorkspaceActivationError) &&
    !isUnauthorizedApiError(activationError)
  ) {
    cacheIdentity(userId, identity);
  }
  throw normalizeAuthError(activationError);
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

/** Reads the authorization code out of a WorkOS redirect, raising any OAuth error it carries. */
const parseAuthorizationCode = (url: string): string => {
  const { queryParams } = Linking.parse(url);
  const oauthError = queryParams?.error as string | undefined;
  if (oauthError) {
    throw new Error((queryParams?.error_description as string | undefined) || oauthError);
  }

  const code = queryParams?.code as string | undefined;
  if (!code) throw new Error("No authorization code received");
  return code;
};

const exchangeAuthorizationCode = async (code: string): Promise<void> => {
  const user = await handleCallback(code);
  const [identityError] = await until(() => loadIdentity(user.id, "sync", user));
  if (!identityError) return;

  // The tokens are good even when the identity call is not, so keep the session and let the
  // signed-in screens retry. A 401 has already cleared it.
  if (!isUnauthorizedApiError(identityError)) queryClient.setQueryData(SESSION_QUERY_KEY, user);
  throw normalizeAuthError(identityError);
};

let pendingAuthorization: { code: string; promise: Promise<void> } | null = null;

/**
 * The redirect can reach us twice: as the `openAuthSessionAsync` result and again through the deep
 * link listener. `handleCallback` consumes the PKCE verifier, so exchanging the same code a second
 * time would fail — share the first attempt's promise instead.
 */
const completeSignIn = (url: string): Promise<void> => {
  const code = parseAuthorizationCode(url);
  if (pendingAuthorization?.code === code) return pendingAuthorization.promise;

  const promise = exchangeAuthorizationCode(code);
  pendingAuthorization = { code, promise };
  return promise;
};

const openSignInBrowser = async (): Promise<string> => {
  const result = await WebBrowser.openAuthSessionAsync(await getSignInUrl(), REDIRECT_URI);
  if (result.type !== "success" || !result.url) {
    throw new AuthCancellationError("Authentication was cancelled");
  }
  return result.url;
};

const runAuthAction = async (action: AuthAction): Promise<void> => {
  switch (action.type) {
    case "clear-session":
      return clearAuthentication();

    case "sign-in":
      return completeSignIn(await openSignInBrowser());

    case "callback":
      return completeSignIn(action.url);

    case "refresh-identity": {
      await loadIdentity(requireCachedUser().id, "sync");
      return;
    }

    case "select-workspace": {
      const { id: userId } = requireCachedUser();
      const identity = queryClient.getQueryData<AuthenticatedIdentity>(identityQueryKey(userId));
      if (!identity?.workspaces.some((workspace) => workspace.id === action.workspaceId)) {
        throw new Error("That workspace is no longer available.");
      }

      const currentPartition =
        identity.activeWorkspaceId && identity.activeWorkspaceId !== action.workspaceId
          ? { userId, workspaceId: identity.activeWorkspaceId }
          : null;
      const discard = currentPartition ? await hasPendingWorkspaceWork(currentPartition) : false;
      if (discard && !(await confirmWorkspaceDiscard())) throw new AuthCancellationError();
      abortChatActivity();
      try {
        if (discard && currentPartition) await purgePartition(currentPartition);
        await activateWorkspace(userId, action.workspaceId);
      } finally {
        resumeChatActivity();
      }
      return;
    }
  }
};

/** WorkOS redirects the app back to itself; every other deep link belongs to the router. */
const toAuthAction = (url: string): AuthAction | null => {
  if (matchesRedirectUri(url, SIGN_OUT_REDIRECT_URI)) return { type: "clear-session" };
  if (matchesRedirectUri(url, REDIRECT_URI)) return { type: "callback", url };
  return null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
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

  const authMutation = useMutation({
    scope: { id: "auth" },
    mutationFn: async (action: AuthAction): Promise<void> => {
      const [error] = await until(() => runAuthAction(action));
      if (error) throw normalizeAuthError(error);
    },
  });
  const { mutate: dispatchAuth, mutateAsync: dispatchAuthAsync } = authMutation;

  const signOutMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const [error] = await until(async () => {
        const sessionId = await getSessionId();
        if (!sessionId) throw new Error("No active session found");
        const logoutUrl = getLogoutUrl(sessionId);
        await clearAuthentication();
        await WebBrowser.openBrowserAsync(logoutUrl);
      });
      if (error) throw normalizeAuthError(error);
    },
  });

  // WorkOS can hand its redirect to the OS rather than to `openAuthSessionAsync` — on a cold start,
  // or when the sign-out browser returns — so the app has to listen for the deep link as well.
  useEffect(() => {
    const handleUrl = (url: string) => {
      const action = toAuthAction(url);
      if (action) dispatchAuth(action);
    };

    const subscription = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    void Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });

    return () => subscription.remove();
  }, [dispatchAuth]);

  const identity = identityQuery.data;
  const workspaces = identity?.workspaces ?? [];
  const pendingAction = authMutation.isPending ? authMutation.variables : null;
  const isSigningIn = pendingAction?.type === "sign-in" || pendingAction?.type === "callback";

  return (
    <AuthContext
      value={{
        user,
        api,
        profile: identity?.user ?? null,
        workspaces,
        workspace:
          identity?.activeWorkspaceId && identity.user.onboardedAt
            ? (workspaces.find((item) => item.id === identity.activeWorkspaceId) ?? null)
            : null,
        accountUnavailableReason: accountUnavailableReasonFor(identity),
        isLoading:
          sessionQuery.isLoading ||
          identityQuery.isLoading ||
          isSigningIn ||
          pendingAction?.type === "clear-session",
        isSessionLoading: sessionQuery.isLoading,
        errorMessage:
          toDisplayMessage(authMutation.error) ??
          toDisplayMessage(sessionQuery.error ?? identityQuery.error),
        isSigningIn,
        isSigningOut: signOutMutation.isPending,
        isRefreshingIdentity: pendingAction?.type === "refresh-identity",
        selectingWorkspaceId:
          pendingAction?.type === "select-workspace" ? pendingAction.workspaceId : null,
        refreshIdentity: () => dispatchAuthAsync({ type: "refresh-identity" }),
        selectWorkspace: (workspaceId) =>
          dispatchAuthAsync({ type: "select-workspace", workspaceId }),
        signIn: () => dispatchAuthAsync({ type: "sign-in" }),
        signOut: () => signOutMutation.mutateAsync(),
      }}
    >
      {children}
    </AuthContext>
  );
}

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
