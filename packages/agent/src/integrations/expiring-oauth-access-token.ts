import { getDb } from "@opencompany/db/client";
import {
  claimIntegrationCredentialRefresh,
  type LoadedIntegrationCredential,
  loadIntegrationCredential,
  markIntegrationStatus,
  releaseIntegrationCredentialRefresh,
  rotateIntegrationCredential,
} from "@opencompany/db/integrations";
import type { IntegrationProvider } from "@opencompany/db/product-schema";

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LEASE_MS = 30_000;
const ROTATION_WAIT_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800] as const;

type DbLike = any;

export type ExpiringOAuthConnection = {
  userWorkosId: string;
  integrationId: string;
  provider: IntegrationProvider;
};

export type ParsedExpiringOAuthCredential<TPayload extends object> = {
  accessToken: string;
  refreshToken: string | null;
  payload: TPayload;
};

export type ExpiringOAuthRefreshResult = {
  accessToken: string;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
};

export class ExpiringOAuthReauthRequired extends Error {
  readonly statusReason: string;

  constructor(message: string, statusReason: string) {
    super(message);
    this.name = "ExpiringOAuthReauthRequired";
    this.statusReason = statusReason;
  }
}

type GetExpiringOAuthAccessTokenInput<TPayload extends object> = {
  connection: ExpiringOAuthConnection;
  displayName: string;
  parseCredential: (
    payload: Record<string, unknown>,
  ) => ParsedExpiringOAuthCredential<TPayload> | null;
  validateRefresh?: (credential: ParsedExpiringOAuthCredential<TPayload>, now: Date) => void;
  refresh: (
    credential: ParsedExpiringOAuthCredential<TPayload>,
    context: { now: Date; signal?: AbortSignal },
  ) => Promise<ExpiringOAuthRefreshResult>;
  createAuthError: (message: string) => Error;
  missingCredential: { message: string; statusReason: string };
  invalidCredential: { message: string; statusReason: string };
  options?: {
    signal?: AbortSignal;
    forceRefresh?: boolean;
    minimumValidityMs?: number;
    db?: DbLike;
    now?: Date;
  };
};

const refreshes = new Map<string, Promise<string>>();

export async function getExpiringOAuthAccessToken<TPayload extends object>(
  input: GetExpiringOAuthAccessTokenInput<TPayload>,
): Promise<string> {
  const db = input.options?.db ?? getDb();
  const now = input.options?.now ?? new Date();
  const credential = await loadIntegrationCredential({
    ...input.connection,
    kind: "oauth_token",
    db,
  });
  const parsed = credential ? input.parseCredential(credential.payload) : null;
  if (!credential) {
    return failAuthentication(input, input.missingCredential, db, now);
  }
  if (!parsed) {
    return failAuthentication(input, input.invalidCredential, db, now);
  }
  if (!input.options?.forceRefresh && isFresh(credential, now, input.options?.minimumValidityMs)) {
    return parsed.accessToken;
  }

  const key = [
    input.connection.provider,
    input.connection.userWorkosId,
    input.connection.integrationId,
  ].join(":");
  const active = refreshes.get(key);
  if (active) return active;

  const refresh = refreshWithLease(input, credential, db, now);
  refreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  }
}

async function refreshWithLease<TPayload extends object>(
  input: GetExpiringOAuthAccessTokenInput<TPayload>,
  initiallyLoaded: LoadedIntegrationCredential,
  db: DbLike,
  now: Date,
) {
  const current = await loadIntegrationCredential({
    ...input.connection,
    kind: "oauth_token",
    db,
  });
  const parsed = current ? input.parseCredential(current.payload) : null;
  if (!current) return failAuthentication(input, input.missingCredential, db, now);
  if (!parsed) return failAuthentication(input, input.invalidCredential, db, now);

  const alreadyRotated = !sameInstant(current.lastRotatedAt, initiallyLoaded.lastRotatedAt);
  if (
    (alreadyRotated || !input.options?.forceRefresh) &&
    isFresh(current, now, input.options?.minimumValidityMs)
  ) {
    return parsed.accessToken;
  }
  const leaseUntil = new Date(now.getTime() + REFRESH_LEASE_MS);
  const claimed = await claimIntegrationCredentialRefresh({
    ...input.connection,
    kind: "oauth_token",
    expectedLastRotatedAt: current.lastRotatedAt,
    leaseUntil,
    db,
    now,
  });
  if (!claimed) {
    return waitForRotatedAccessToken(input, current.lastRotatedAt, db, now);
  }

  try {
    input.validateRefresh?.(parsed, now);
    const refreshed = await input.refresh(parsed, {
      now,
      ...(input.options?.signal ? { signal: input.options.signal } : {}),
    });
    const rotated = await rotateIntegrationCredential({
      ...input.connection,
      kind: "oauth_token",
      payload: refreshed.payload,
      expiresAt: refreshed.expiresAt,
      expectedLastRotatedAt: current.lastRotatedAt,
      expectedRefreshLeaseUntil: leaseUntil,
      db,
      now,
    });
    if (rotated) return refreshed.accessToken;
    return waitForRotatedAccessToken(input, current.lastRotatedAt, db, now);
  } catch (error) {
    await releaseIntegrationCredentialRefresh({
      ...input.connection,
      kind: "oauth_token",
      expectedRefreshLeaseUntil: leaseUntil,
      db,
    });
    if (error instanceof ExpiringOAuthReauthRequired) {
      await markIntegrationStatus({
        ...input.connection,
        status: "needs_reauth",
        statusReason: error.statusReason,
        db,
        now,
      });
      throw input.createAuthError(error.message);
    }
    throw error;
  }
}

async function waitForRotatedAccessToken<TPayload extends object>(
  input: GetExpiringOAuthAccessTokenInput<TPayload>,
  previousLastRotatedAt: Date | null,
  db: DbLike,
  now: Date,
) {
  for (const delayMs of ROTATION_WAIT_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs, input.options?.signal);
    const current = await loadIntegrationCredential({
      ...input.connection,
      kind: "oauth_token",
      db,
    });
    const parsed = current ? input.parseCredential(current.payload) : null;
    if (
      current &&
      parsed &&
      !sameInstant(current.lastRotatedAt, previousLastRotatedAt) &&
      isFresh(current, now, input.options?.minimumValidityMs)
    ) {
      return parsed.accessToken;
    }
  }
  throw new Error(`${input.displayName} credential refresh is already in progress.`);
}

async function failAuthentication<TPayload extends object>(
  input: GetExpiringOAuthAccessTokenInput<TPayload>,
  failure: { message: string; statusReason: string },
  db: DbLike,
  now: Date,
): Promise<never> {
  await markIntegrationStatus({
    ...input.connection,
    status: "needs_reauth",
    statusReason: failure.statusReason,
    db,
    now,
  });
  throw input.createAuthError(failure.message);
}

function isFresh(
  credential: LoadedIntegrationCredential,
  now: Date,
  minimumValidityMs: number | undefined,
) {
  const requiredValidityMs = Math.max(REFRESH_SKEW_MS, minimumValidityMs ?? 0);
  return Boolean(
    credential.expiresAt && credential.expiresAt.getTime() - requiredValidityMs > now.getTime(),
  );
}

function sameInstant(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

async function wait(delayMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
