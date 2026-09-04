import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./product-schema";
import {
  type CodexCredentialStatus,
  codexCredentials,
  type IntegrationCredentialEncryptedPayload,
  users,
  workspaceCodexEngineAccounts,
  workspaceMembers,
} from "./product-schema";

const ENCRYPTION_KEY_VERSION = 1;

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
  refreshLockId: string | null;
  refreshLockExpiresAt: Date | null;
};

export type WorkspaceCodexEngineAccountView = {
  workspaceId: string;
  providerUserWorkosId: string;
  providerDisplayName: string;
  providerEmail: string;
  enabled: boolean;
  credentialStatus: CodexCredentialStatus;
  credentialStatusReason: string | null;
  lastValidatedAt: Date | null;
  updatedAt: Date;
};

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
        refreshLockId: null,
        refreshLockExpiresAt: null,
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
      refreshLockId: null,
      refreshLockExpiresAt: null,
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
      refreshLockId: null,
      refreshLockExpiresAt: null,
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
      refreshLockId: codexCredentials.refreshLockId,
      refreshLockExpiresAt: codexCredentials.refreshLockExpiresAt,
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
    refreshLockId: credential.refreshLockId,
    refreshLockExpiresAt: credential.refreshLockExpiresAt,
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

export async function tryAcquireCodexCredentialRefreshLock(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  lockId?: string;
  now?: Date;
  ttlMs?: number;
}) {
  const now = input.now ?? new Date();
  const lockId = input.lockId ?? `codex_refresh_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 30_000));
  const [credential] = await input.db
    .update(codexCredentials)
    .set({ refreshLockId: lockId, refreshLockExpiresAt: expiresAt, updatedAt: now })
    .where(
      and(
        eq(codexCredentials.userWorkosId, input.userWorkosId),
        eq(codexCredentials.status, "connected"),
        or(
          isNull(codexCredentials.refreshLockExpiresAt),
          lte(codexCredentials.refreshLockExpiresAt, now),
        ),
      ),
    )
    .returning({ userWorkosId: codexCredentials.userWorkosId });
  return credential ? { lockId, expiresAt } : null;
}

export async function releaseCodexCredentialRefreshLock(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  lockId: string;
  now?: Date;
}) {
  await input.db
    .update(codexCredentials)
    .set({ refreshLockId: null, refreshLockExpiresAt: null, updatedAt: input.now ?? new Date() })
    .where(
      and(
        eq(codexCredentials.userWorkosId, input.userWorkosId),
        eq(codexCredentials.refreshLockId, input.lockId),
      ),
    );
}

export async function loadWorkspaceCodexEngineAccount(input: {
  db: any;
  workspaceId: string;
}): Promise<WorkspaceCodexEngineAccountView | null> {
  const [row] = await input.db
    .select({
      workspaceId: workspaceCodexEngineAccounts.workspaceId,
      providerUserWorkosId: workspaceCodexEngineAccounts.providerUserWorkosId,
      providerEmail: users.email,
      providerFirstName: users.firstName,
      providerLastName: users.lastName,
      enabled: workspaceCodexEngineAccounts.enabled,
      credentialStatus: codexCredentials.status,
      credentialStatusReason: codexCredentials.statusReason,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      updatedAt: workspaceCodexEngineAccounts.updatedAt,
    })
    .from(workspaceCodexEngineAccounts)
    .innerJoin(
      codexCredentials,
      eq(codexCredentials.userWorkosId, workspaceCodexEngineAccounts.providerUserWorkosId),
    )
    .innerJoin(users, eq(users.workosUserId, workspaceCodexEngineAccounts.providerUserWorkosId))
    .where(eq(workspaceCodexEngineAccounts.workspaceId, input.workspaceId))
    .limit(1);
  if (!row) return null;
  const providerDisplayName = [row.providerFirstName, row.providerLastName]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .trim();
  return {
    workspaceId: row.workspaceId,
    providerUserWorkosId: row.providerUserWorkosId,
    providerDisplayName: providerDisplayName || row.providerEmail,
    providerEmail: row.providerEmail,
    enabled: row.enabled,
    credentialStatus: row.credentialStatus,
    credentialStatusReason: row.credentialStatusReason,
    lastValidatedAt: row.lastValidatedAt,
    updatedAt: row.updatedAt,
  };
}

export async function setWorkspaceCodexEngineAccount(input: {
  db: any;
  workspaceId: string;
  providerUserWorkosId: string;
  updatedByWorkosId: string;
  now?: Date;
}) {
  const [eligible] = await input.db
    .select({
      role: workspaceMembers.role,
      credentialStatus: codexCredentials.status,
    })
    .from(workspaceMembers)
    .innerJoin(codexCredentials, eq(codexCredentials.userWorkosId, workspaceMembers.userWorkosId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userWorkosId, input.providerUserWorkosId),
      ),
    )
    .limit(1);
  if (eligible?.role !== "admin") {
    throw new Error("Only a workspace admin can provide the Codex engine account.");
  }
  if (eligible.credentialStatus !== "connected") {
    throw new Error("Reconnect Codex before enabling subscription-backed models.");
  }

  const now = input.now ?? new Date();
  await input.db
    .insert(workspaceCodexEngineAccounts)
    .values({
      workspaceId: input.workspaceId,
      providerUserWorkosId: input.providerUserWorkosId,
      enabled: true,
      updatedByWorkosId: input.updatedByWorkosId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceCodexEngineAccounts.workspaceId,
      set: {
        providerUserWorkosId: input.providerUserWorkosId,
        enabled: true,
        updatedByWorkosId: input.updatedByWorkosId,
        updatedAt: now,
      },
    });
  return loadWorkspaceCodexEngineAccount({ db: input.db, workspaceId: input.workspaceId });
}

export async function disableWorkspaceCodexEngineAccount(input: {
  db: any;
  workspaceId: string;
  updatedByWorkosId: string;
  now?: Date;
}) {
  await input.db
    .update(workspaceCodexEngineAccounts)
    .set({
      enabled: false,
      updatedByWorkosId: input.updatedByWorkosId,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(workspaceCodexEngineAccounts.workspaceId, input.workspaceId));
  return loadWorkspaceCodexEngineAccount({ db: input.db, workspaceId: input.workspaceId });
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
