import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./product-schema";
import {
  type CodexCredentialStatus,
  codexCredentials,
  type IntegrationCredentialEncryptedPayload,
} from "./product-schema";

const ENCRYPTION_KEY_VERSION = 1;
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_TOKEN_REFRESH_WINDOW_MS = 60_000;

type DbSchema = typeof schema;
type CodexAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

export type CodexAuthJson = Record<string, unknown>;

export type LoadedCodexCredential = {
  authJson: CodexAuthJson;
  status: CodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export type CodexAccessToken = {
  accessToken: string;
  accountId: string;
  expiresAt: Date | null;
};

export class CodexCredentialNeedsReauthError extends Error {
  constructor(message = "Reconnect Codex in Settings → Integrations to continue.") {
    super(message);
    this.name = "CodexCredentialNeedsReauthError";
  }
}

export class CodexCredentialRefreshError extends Error {
  constructor(message = "Codex API error while refreshing the connected subscription.") {
    super(message);
    this.name = "CodexCredentialRefreshError";
  }
}

export function newCodexDeviceAuthFlowId() {
  return `gcodf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function saveCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  authJson: CodexAuthJson;
  status?: CodexCredentialStatus;
  statusReason?: string | null;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { userWorkosId: input.userWorkosId },
    ENCRYPTION_KEY_VERSION,
  );
  const status = input.status ?? "connected";

  const [credential] = await input.db
    .insert(codexCredentials)
    .values({
      userWorkosId: input.userWorkosId,
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status,
      statusReason: input.statusReason ?? null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: codexCredentials.userWorkosId,
      set: {
        encryptedAuthJson,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        status,
        statusReason: input.statusReason ?? null,
        lastValidatedAt: input.validatedAt ?? now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      userWorkosId: codexCredentials.userWorkosId,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
      updatedAt: codexCredentials.updatedAt,
    });

  if (!credential) throw new Error("Could not persist opencompany Codex credential.");
  return credential;
}

export async function rotateCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  authJson: CodexAuthJson;
  expectedLastRotatedAt: Date | null;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { userWorkosId: input.userWorkosId },
    ENCRYPTION_KEY_VERSION,
  );
  const [credential] = await input.db
    .update(codexCredentials)
    .set({
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status: "connected",
      statusReason: null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(codexCredentials.userWorkosId, input.userWorkosId),
        input.expectedLastRotatedAt
          ? eq(codexCredentials.lastRotatedAt, input.expectedLastRotatedAt)
          : isNull(codexCredentials.lastRotatedAt),
      ),
    )
    .returning({ userWorkosId: codexCredentials.userWorkosId });
  return Boolean(credential);
}

export async function markCodexCredentialNeedsReauth(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  statusReason: string;
  now?: Date;
}) {
  await input.db
    .update(codexCredentials)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId));
}

export async function loadCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
}): Promise<LoadedCodexCredential | null> {
  const [credential] = await input.db
    .select({
      userWorkosId: codexCredentials.userWorkosId,
      encryptedAuthJson: codexCredentials.encryptedAuthJson,
      encryptionKeyVersion: codexCredentials.encryptionKeyVersion,
      status: codexCredentials.status,
      statusReason: codexCredentials.statusReason,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
      updatedAt: codexCredentials.updatedAt,
    })
    .from(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId))
    .limit(1);

  if (!credential) return null;
  if (credential.userWorkosId !== input.userWorkosId) {
    throw new Error("opencompany Codex credential row did not match the requested user.");
  }

  return {
    authJson: decryptAuthJson(
      credential.encryptedAuthJson,
      { userWorkosId: input.userWorkosId },
      credential.encryptionKeyVersion,
    ),
    status: credential.status,
    statusReason: credential.statusReason,
    lastValidatedAt: credential.lastValidatedAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export type CodexAuthStatus = {
  status: CodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
};

// Status-only read for settings surfaces and engine-availability checks; never
// touches the encrypted auth payload.
export async function loadCodexAuthStatus(input: {
  db: CodexAuthDb;
  userWorkosId: string;
}): Promise<CodexAuthStatus | null> {
  const [row] = await input.db
    .select({
      status: codexCredentials.status,
      statusReason: codexCredentials.statusReason,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
    })
    .from(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function deleteCodexCredential(input: { db: CodexAuthDb; userWorkosId: string }) {
  await input.db
    .delete(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId));
}

// Loads a usable ChatGPT bearer token and refreshes it under a transaction-level
// advisory lock when it is near expiry. A rejectedAccessToken prevents two 401
// handlers from rotating the same refresh token: after the lock, the loser uses
// the winner's already-rotated access token instead of refreshing again.
export async function loadFreshCodexAccessToken(input: {
  db: any;
  userWorkosId: string;
  rejectedAccessToken?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<CodexAccessToken> {
  const now = input.now ?? new Date();
  const initial = await loadUsableCodexCredential(input.db, input.userWorkosId);
  const initialToken = await parseStoredCodexAccessToken(
    input.db,
    input.userWorkosId,
    initial.authJson,
    now,
  );
  if (
    (!input.rejectedAccessToken && !needsRefresh(initialToken, now)) ||
    (input.rejectedAccessToken && initialToken.accessToken !== input.rejectedAccessToken)
  ) {
    return initialToken;
  }

  return input.db.transaction(async (tx: any) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`opencompany:codex-token-refresh:${input.userWorkosId}`}, 0)
      )
    `);
    const credential = await loadUsableCodexCredential(tx, input.userWorkosId);
    const currentToken = await parseStoredCodexAccessToken(
      tx,
      input.userWorkosId,
      credential.authJson,
      now,
    );
    if (
      (input.rejectedAccessToken && currentToken.accessToken !== input.rejectedAccessToken) ||
      (!input.rejectedAccessToken && !needsRefresh(currentToken, now))
    ) {
      return currentToken;
    }

    const tokens = authTokens(credential.authJson);
    const refreshToken = nonEmptyString(tokens.refresh_token);
    if (!refreshToken) {
      await markCodexCredentialNeedsReauth({
        db: tx,
        userWorkosId: input.userWorkosId,
        statusReason:
          "Codex credentials cannot be refreshed. Reconnect Codex in opencompany settings.",
        now,
      });
      throw new CodexCredentialNeedsReauthError();
    }

    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
    } catch {
      throw new CodexCredentialRefreshError();
    }

    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        await markCodexCredentialNeedsReauth({
          db: tx,
          userWorkosId: input.userWorkosId,
          statusReason:
            "Codex authentication expired or was revoked. Reconnect Codex in opencompany settings.",
          now,
        });
        throw new CodexCredentialNeedsReauthError();
      }
      throw new CodexCredentialRefreshError();
    }

    const refreshed = await readRefreshResponse(response);
    const accessToken = nonEmptyString(refreshed.access_token);
    if (!accessToken) {
      await markCodexCredentialNeedsReauth({
        db: tx,
        userWorkosId: input.userWorkosId,
        statusReason:
          "Codex returned unusable refreshed credentials. Reconnect Codex in opencompany settings.",
        now,
      });
      throw new CodexCredentialNeedsReauthError();
    }

    const nextAuthJson = {
      ...credential.authJson,
      tokens: {
        ...tokens,
        access_token: accessToken,
        refresh_token: nonEmptyString(refreshed.refresh_token) ?? refreshToken,
        ...(nonEmptyString(refreshed.account_id)
          ? { account_id: nonEmptyString(refreshed.account_id) }
          : {}),
        ...(nonEmptyString(refreshed.id_token)
          ? { id_token: nonEmptyString(refreshed.id_token) }
          : {}),
      },
      last_refresh: now.toISOString(),
    };
    const nextToken = await parseStoredCodexAccessToken(tx, input.userWorkosId, nextAuthJson, now);
    const rotated = await rotateCodexCredential({
      db: tx,
      userWorkosId: input.userWorkosId,
      authJson: nextAuthJson,
      expectedLastRotatedAt: credential.lastRotatedAt,
      now,
    });
    if (!rotated) {
      // A coding sandbox may have persisted its own refresh while this server
      // held the database lock. Its optimistic write wins; use that token.
      const winner = await loadUsableCodexCredential(tx, input.userWorkosId);
      return parseStoredCodexAccessToken(tx, input.userWorkosId, winner.authJson, now);
    }
    return nextToken;
  });
}

async function loadUsableCodexCredential(db: any, userWorkosId: string) {
  let credential: LoadedCodexCredential | null;
  try {
    credential = await loadCodexCredential({ db, userWorkosId });
  } catch {
    await markCodexCredentialNeedsReauth({
      db,
      userWorkosId,
      statusReason:
        "Codex credentials could not be decrypted. Reconnect Codex in opencompany settings.",
    });
    throw new CodexCredentialNeedsReauthError();
  }
  if (!credential || credential.status !== "connected") {
    throw new CodexCredentialNeedsReauthError();
  }
  return credential;
}

function authTokens(authJson: CodexAuthJson): Record<string, unknown> {
  const tokens = authJson.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new CodexCredentialNeedsReauthError();
  }
  return tokens as Record<string, unknown>;
}

function parseCodexAccessToken(authJson: CodexAuthJson): CodexAccessToken {
  const tokens = authTokens(authJson);
  const accessToken = nonEmptyString(tokens.access_token);
  if (!accessToken) throw new CodexCredentialNeedsReauthError();
  const accessClaims = decodeJwtClaims(accessToken);
  const idToken = nonEmptyString(tokens.id_token);
  const idClaims = idToken ? decodeJwtClaims(idToken) : null;
  const accountId =
    nonEmptyString(tokens.account_id) ?? nestedAccountId(idClaims) ?? nestedAccountId(accessClaims);
  if (!accountId) throw new CodexCredentialNeedsReauthError();
  const exp = typeof accessClaims?.exp === "number" ? accessClaims.exp : null;
  return {
    accessToken,
    accountId,
    expiresAt: exp ? new Date(exp * 1000) : null,
  };
}

async function parseStoredCodexAccessToken(
  db: any,
  userWorkosId: string,
  authJson: CodexAuthJson,
  now: Date,
) {
  try {
    return parseCodexAccessToken(authJson);
  } catch (error) {
    if (!(error instanceof CodexCredentialNeedsReauthError)) throw error;
    await markCodexCredentialNeedsReauth({
      db,
      userWorkosId,
      statusReason:
        "Codex credentials are incomplete or invalid. Reconnect Codex in opencompany settings.",
      now,
    });
    throw error;
  }
}

function needsRefresh(token: CodexAccessToken, now: Date) {
  return (
    token.expiresAt !== null &&
    token.expiresAt.getTime() - now.getTime() <= CODEX_TOKEN_REFRESH_WINDOW_MS
  );
}

async function readRefreshResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nestedAccountId(claims: Record<string, unknown> | null) {
  const auth = claims?.["https://api.openai.com/auth"];
  return auth && typeof auth === "object" && !Array.isArray(auth)
    ? nonEmptyString((auth as Record<string, unknown>).chatgpt_account_id)
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encryptAuthJson(
  authJson: CodexAuthJson,
  context: { userWorkosId: string },
  keyVersion: number,
): IntegrationCredentialEncryptedPayload {
  return encryptJson(authJson, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(context, keyVersion),
  });
}

function decryptAuthJson(
  encryptedAuthJson: IntegrationCredentialEncryptedPayload,
  context: { userWorkosId: string },
  keyVersion: number,
): CodexAuthJson {
  if (encryptedAuthJson.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported opencompany Codex credential encryption algorithm ${encryptedAuthJson.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(
        `Unsupported opencompany Codex credential encryption key version ${keyVersion}.`,
      );
    }
    throw error;
  }

  try {
    return decryptJson(encryptedAuthJson, {
      key,
      aad: authenticatedData(context, keyVersion),
    });
  } catch {
    throw new Error("opencompany Codex credential could not be decrypted.");
  }
}

function authenticatedData(context: { userWorkosId: string }, keyVersion: number) {
  return buildAad({
    userWorkosId: context.userWorkosId,
    kind: "goat_codex_auth_json",
    keyVersion,
  });
}
