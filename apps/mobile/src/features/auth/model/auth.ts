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
import { AppState } from "react-native";

// Environment variables (set in .env or app.config.js)
const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID!;
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Resolve the callback from the scheme compiled into the current Expo app.
export const REDIRECT_URI = Linking.createURL("callback");
export const SIGN_OUT_REDIRECT_URI = Linking.createURL("signout-callback");

// Initialize WorkOS in public client mode (no API key needed for PKCE)
const workos = new WorkOS({ clientId: WORKOS_CLIENT_ID, timeout: 10_000, maxRetries: 1 });

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

export class TerminalSessionError extends Error {
  constructor(cause: unknown) {
    super("Your session has expired. Sign in again.", { cause });
    this.name = "TerminalSessionError";
  }
}

export class SessionRefreshDeferredError extends Error {
  constructor() {
    super("Session refresh is paused while the app is in the background.");
    this.name = "SessionRefreshDeferredError";
  }
}

export class SessionPersistenceError extends Error {
  constructor(cause: unknown) {
    super("The refreshed session could not be saved securely.", { cause });
    this.name = "SessionPersistenceError";
  }
}

const errorValues = (error: unknown): string => {
  if (typeof error === "string") return error.toLocaleLowerCase();
  if (!(error instanceof Error)) return "";
  const record = error as Error & {
    code?: unknown;
    error?: unknown;
    rawData?: Record<string, unknown>;
    response?: Record<string, unknown>;
  };
  return [
    error.message,
    record.code,
    record.error,
    record.rawData?.error,
    record.rawData?.error_description,
    record.rawData?.message,
    record.response?.error,
    record.response?.error_description,
    record.response?.message,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
};

export const isTerminalSessionError = (error: unknown): boolean => {
  if (error instanceof TerminalSessionError) return true;
  const value = errorValues(error);
  return (
    value.includes("invalid_grant") ||
    value.includes("refresh token is invalid") ||
    value.includes("refresh token has expired") ||
    value.includes("refresh token was revoked")
  );
};

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
  const generation = sessionGeneration;
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
  if (generation !== sessionGeneration) throw new Error("Authentication was canceled.");

  // Clear PKCE state after successful exchange
  await SecureStore.deleteItemAsync(KEYS.PKCE);

  // Store session securely
  const session: StoredSession = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: toUser(auth.user),
  };
  sessionMemory = session;
  await persistSessionBestEffort(session, generation);
  if (generation !== sessionGeneration) throw new Error("Authentication was canceled.");

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

let sessionMemory: StoredSession | null | undefined;
let pendingPersistence: StoredSession | null = null;
let sessionGeneration = 0;
let secureStoreWriteTail: Promise<void> = Promise.resolve();

const readStoredSession = async (): Promise<StoredSession | null> => {
  if (sessionMemory !== undefined) return sessionMemory;
  const generation = sessionGeneration;
  const sessionData = await SecureStore.getItemAsync(KEYS.SESSION);
  if (generation !== sessionGeneration) return sessionMemory ?? null;
  sessionMemory = sessionData ? (JSON.parse(sessionData) as StoredSession) : null;
  return sessionMemory;
};

const queueSecureStoreWrite = (write: () => Promise<void>): Promise<void> => {
  const result = secureStoreWriteTail.then(write);
  secureStoreWriteTail = result.catch(() => undefined);
  return result;
};

const persistSession = async (session: StoredSession): Promise<void> => {
  await queueSecureStoreWrite(() =>
    SecureStore.setItemAsync(KEYS.SESSION, JSON.stringify(session)),
  );
};

const persistSessionBestEffort = async (
  session: StoredSession,
  generation: number,
): Promise<void> => {
  try {
    await persistSession(session);
    if (generation === sessionGeneration && pendingPersistence === session) {
      pendingPersistence = null;
    }
  } catch {
    if (generation === sessionGeneration) pendingPersistence = session;
  }
};

const flushPendingPersistence = async (): Promise<void> => {
  if (!pendingPersistence) return;
  const session = pendingPersistence;
  const generation = sessionGeneration;
  try {
    await persistSession(session);
    if (generation === sessionGeneration && pendingPersistence === session) {
      pendingPersistence = null;
    }
  } catch (error) {
    throw new SessionPersistenceError(error);
  }
};

let refreshInFlight: { organizationId?: string; promise: Promise<StoredSession> } | null = null;

const refreshStoredSession = async (organizationId?: string): Promise<StoredSession> => {
  while (refreshInFlight) {
    if (refreshInFlight.organizationId === organizationId) return refreshInFlight.promise;
    // A refresh for a different organization only serializes this one; it does not decide it.
    // Swallow its rejection so a failed selectOrganization() cannot fail an unrelated token read
    // that is merely queued behind it.
    await refreshInFlight.promise.catch(() => undefined);
  }

  const promise = (async () => {
    if (AppState.currentState !== "active") throw new SessionRefreshDeferredError();
    await flushPendingPersistence();
    const session = await readStoredSession();
    if (!session) throw new Error("No active session found.");
    const generation = sessionGeneration;

    let refreshed: Awaited<ReturnType<typeof workos.userManagement.authenticateWithRefreshToken>>;
    try {
      refreshed = await workos.userManagement.authenticateWithRefreshToken({
        refreshToken: session.refreshToken,
        ...(organizationId ? { organizationId } : {}),
      });
    } catch (error) {
      if (isTerminalSessionError(error)) throw new TerminalSessionError(error);
      throw error;
    }
    if (generation !== sessionGeneration) throw new Error("The session changed during refresh.");
    const newSession: StoredSession = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      user: toUser(refreshed.user),
    };
    sessionMemory = newSession;
    await persistSessionBestEffort(newSession, generation);
    if (generation !== sessionGeneration) throw new Error("The session changed during refresh.");
    return newSession;
  })();
  refreshInFlight = { organizationId, promise };
  try {
    return await promise;
  } finally {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  }
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
    if (pendingPersistence) await flushPendingPersistence();
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
  try {
    const session = await readStoredSession();
    if (!session) return null;
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
  sessionGeneration += 1;
  sessionMemory = null;
  pendingPersistence = null;
  await queueSecureStoreWrite(async () => {
    await SecureStore.deleteItemAsync(KEYS.SESSION);
    await SecureStore.deleteItemAsync(KEYS.PKCE);
  });
}
