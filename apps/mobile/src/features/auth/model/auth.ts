/**
 * Core authentication module using WorkOS SDK with PKCE.
 *
 * This mirrors the electron-authkit-example's auth.ts pattern:
 * - getSignInUrl() generates PKCE-protected authorization URL
 * - handleCallback() exchanges code for tokens
 * - getUser() returns current user (with auto-refresh)
 * - clearSession() clears stored credentials
 *
 * Note: Requires react-native-quick-crypto polyfill (see the root layout).
 */
import { WorkOS } from "@workos-inc/node";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";

// Environment variables (set in .env or app.config.js)
const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID!;
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Resolve the callback from the scheme compiled into the current Expo app.
export const REDIRECT_URI = Linking.createURL("callback");
export const SIGN_OUT_REDIRECT_URI = Linking.createURL("signout-callback");

// Initialize WorkOS in public client mode (no API key needed for PKCE)
const workos = new WorkOS({ clientId: WORKOS_CLIENT_ID });

// Storage keys
const KEYS = {
  SESSION: "workos_session",
  PKCE: "workos_pkce",
} as const;

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
}

/** Map WorkOS user response to our User type */
function toUser(workosUser: {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}): User {
  return {
    id: workosUser.id,
    email: workosUser.email,
    firstName: workosUser.firstName ?? null,
    lastName: workosUser.lastName ?? null,
    profilePictureUrl: workosUser.profilePictureUrl ?? null,
  };
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface PkceState {
  codeVerifier: string;
  expiresAt: number;
}

/**
 * Generate sign-in URL with PKCE challenge.
 * The WorkOS SDK handles PKCE generation automatically via getAuthorizationUrlWithPKCE.
 */
export async function getSignInUrl(): Promise<string> {
  const { url, codeVerifier } = await workos.userManagement.getAuthorizationUrlWithPKCE({
    redirectUri: REDIRECT_URI,
    provider: "authkit",
  });

  // Store code verifier securely - needed for token exchange
  const pkceState: PkceState = {
    codeVerifier,
    expiresAt: Date.now() + PKCE_TTL_MS,
  };
  await SecureStore.setItemAsync(KEYS.PKCE, JSON.stringify(pkceState));

  return url;
}

/** Exchange authorization code for tokens using stored code verifier. */
export async function handleCallback(code: string): Promise<User> {
  const pkceData = await SecureStore.getItemAsync(KEYS.PKCE);
  if (!pkceData) {
    throw new Error("No PKCE state found - please try signing in again");
  }

  const pkceState: PkceState = JSON.parse(pkceData);
  if (pkceState.expiresAt < Date.now()) {
    await SecureStore.deleteItemAsync(KEYS.PKCE);
    throw new Error("Authentication session expired - please try again");
  }

  // Exchange authorization code for tokens using PKCE
  const auth = await workos.userManagement.authenticateWithCode({
    code,
    codeVerifier: pkceState.codeVerifier,
  });

  // Clear PKCE state after successful exchange
  await SecureStore.deleteItemAsync(KEYS.PKCE);

  // Store session securely
  const session: StoredSession = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: toUser(auth.user),
  };
  await SecureStore.setItemAsync(KEYS.SESSION, JSON.stringify(session));

  return session.user;
}

/** Parse JWT payload without verification (for reading claims only). */
function parseJwtPayload(token: string): Record<string, unknown> {
  const base64 = token.split(".")[1];
  if (!base64) throw new Error("The stored access token is malformed.");
  // Handle URL-safe base64
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(normalized));
}

const readStoredSession = async (): Promise<StoredSession | null> => {
  const sessionData = await SecureStore.getItemAsync(KEYS.SESSION);
  if (!sessionData) return null;
  return JSON.parse(sessionData) as StoredSession;
};

const persistSession = async (session: StoredSession): Promise<void> => {
  await SecureStore.setItemAsync(KEYS.SESSION, JSON.stringify(session));
};

const refreshStoredSession = async (organizationId?: string): Promise<StoredSession> => {
  const session = await readStoredSession();
  if (!session) throw new Error("No active session found.");

  const refreshed = await workos.userManagement.authenticateWithRefreshToken({
    refreshToken: session.refreshToken,
    ...(organizationId ? { organizationId } : {}),
  });

  const newSession: StoredSession = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    user: toUser(refreshed.user),
  };
  await persistSession(newSession);
  return newSession;
};

/** Read the WorkOS user without making a network request. */
export async function getStoredUser(): Promise<User | null> {
  return (await readStoredSession())?.user ?? null;
}

/** Return a fresh bearer, rotating the stored WorkOS tokens only when needed. */
export async function getAccessToken(): Promise<string> {
  const session = await readStoredSession();
  if (!session) throw new Error("No active session found.");

  // Check if token is expired (with 10 second buffer)
  const payload = parseJwtPayload(session.accessToken);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const isExpired = Date.now() > exp * 1000 - 10_000;

  if (isExpired) {
    return (await refreshStoredSession()).accessToken;
  }

  return session.accessToken;
}

/** Bind the stored WorkOS session to the selected organization and persist the rotated tokens. */
export async function selectOrganization(organizationId: string): Promise<User> {
  return (await refreshStoredSession(organizationId)).user;
}

/** Get session ID from stored access token (needed for logout). */
export async function getSessionId(): Promise<string | null> {
  const sessionData = await SecureStore.getItemAsync(KEYS.SESSION);
  if (!sessionData) return null;

  try {
    const session: StoredSession = JSON.parse(sessionData);
    const payload = parseJwtPayload(session.accessToken);
    return (payload.sid as string) ?? null;
  } catch {
    return null;
  }
}

/** Get WorkOS logout URL for the current session. */
export function getLogoutUrl(sessionId: string): string {
  return workos.userManagement.getLogoutUrl({
    sessionId,
    returnTo: SIGN_OUT_REDIRECT_URI,
  });
}

/** Clear stored session and PKCE state. */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.SESSION);
  await SecureStore.deleteItemAsync(KEYS.PKCE);
}
