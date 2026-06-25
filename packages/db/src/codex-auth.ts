import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";
import {
  type WorkspaceCodexCredentialStatus,
  type WorkspaceIntegrationCredentialEncryptedPayload,
  workspaceCodexCredentials,
} from "./schema";

const ENCRYPTION_KEY_VERSION = 1;

// Driver-agnostic db handle: callers pass the web app's `neon-http` client or the runner's pooled
// `node-postgres` client, so this types against drizzle's `PgDatabase` base rather than either
// concrete driver (matches recall.ts / sync-outbox.ts). The `Pick` keeps the surface to the query
// builders these helpers actually use, with full builder typing instead of the previous `=> any`.
type CodexAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, typeof schema>,
  "delete" | "insert" | "select" | "update"
>;

export type WorkspaceCodexAuthJson = Record<string, unknown>;

export type LoadedWorkspaceCodexCredential = {
  authJson: WorkspaceCodexAuthJson;
  status: WorkspaceCodexCredentialStatus;
  statusReason: string | null;
  connectedByUserId: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export function newWorkspaceCodexDeviceAuthFlowId() {
  return `wcodf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function saveWorkspaceCodexCredential(input: {
  db: CodexAuthDb;
  workspaceId: string;
  authJson: WorkspaceCodexAuthJson;
  connectedByUserId?: string | null;
  status?: WorkspaceCodexCredentialStatus;
  statusReason?: string | null;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { workspaceId: input.workspaceId },
    ENCRYPTION_KEY_VERSION,
  );
  const status = input.status ?? "connected";

  const [credential] = await input.db
    .insert(workspaceCodexCredentials)
    .values({
      workspaceId: input.workspaceId,
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status,
      statusReason: input.statusReason ?? null,
      connectedByUserId: input.connectedByUserId ?? null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceCodexCredentials.workspaceId,
      set: {
        encryptedAuthJson,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        status,
        statusReason: input.statusReason ?? null,
        connectedByUserId: input.connectedByUserId ?? null,
        lastValidatedAt: input.validatedAt ?? now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      workspaceId: workspaceCodexCredentials.workspaceId,
      lastValidatedAt: workspaceCodexCredentials.lastValidatedAt,
      lastRotatedAt: workspaceCodexCredentials.lastRotatedAt,
      updatedAt: workspaceCodexCredentials.updatedAt,
    });

  if (!credential) throw new Error("Could not persist workspace Codex credential.");
  return credential;
}

export async function rotateWorkspaceCodexCredential(input: {
  db: CodexAuthDb;
  workspaceId: string;
  authJson: WorkspaceCodexAuthJson;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { workspaceId: input.workspaceId },
    ENCRYPTION_KEY_VERSION,
  );
  const [credential] = await input.db
    .update(workspaceCodexCredentials)
    .set({
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status: "connected",
      statusReason: null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .where(eq(workspaceCodexCredentials.workspaceId, input.workspaceId))
    .returning({ workspaceId: workspaceCodexCredentials.workspaceId });
  return Boolean(credential);
}

export async function markWorkspaceCodexCredentialNeedsReauth(input: {
  db: CodexAuthDb;
  workspaceId: string;
  statusReason: string;
  now?: Date;
}) {
  await input.db
    .update(workspaceCodexCredentials)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(workspaceCodexCredentials.workspaceId, input.workspaceId));
}

export async function loadWorkspaceCodexCredential(input: {
  db: CodexAuthDb;
  workspaceId: string;
}): Promise<LoadedWorkspaceCodexCredential | null> {
  const [credential] = await input.db
    .select({
      workspaceId: workspaceCodexCredentials.workspaceId,
      encryptedAuthJson: workspaceCodexCredentials.encryptedAuthJson,
      encryptionKeyVersion: workspaceCodexCredentials.encryptionKeyVersion,
      status: workspaceCodexCredentials.status,
      statusReason: workspaceCodexCredentials.statusReason,
      connectedByUserId: workspaceCodexCredentials.connectedByUserId,
      lastValidatedAt: workspaceCodexCredentials.lastValidatedAt,
      lastRotatedAt: workspaceCodexCredentials.lastRotatedAt,
      updatedAt: workspaceCodexCredentials.updatedAt,
    })
    .from(workspaceCodexCredentials)
    .where(eq(workspaceCodexCredentials.workspaceId, input.workspaceId))
    .limit(1);

  if (!credential) return null;
  if (credential.workspaceId !== input.workspaceId) {
    throw new Error("Codex credential row did not match the requested workspace.");
  }

  return {
    authJson: decryptAuthJson(
      credential.encryptedAuthJson,
      { workspaceId: input.workspaceId },
      credential.encryptionKeyVersion,
    ),
    status: credential.status,
    statusReason: credential.statusReason,
    connectedByUserId: credential.connectedByUserId,
    lastValidatedAt: credential.lastValidatedAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function deleteWorkspaceCodexCredential(input: {
  db: CodexAuthDb;
  workspaceId: string;
}) {
  await input.db
    .delete(workspaceCodexCredentials)
    .where(eq(workspaceCodexCredentials.workspaceId, input.workspaceId));
}

function encryptAuthJson(
  authJson: WorkspaceCodexAuthJson,
  context: { workspaceId: string },
  keyVersion: number,
): WorkspaceIntegrationCredentialEncryptedPayload {
  return encryptJson(authJson, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(context, keyVersion),
  });
}

function decryptAuthJson(
  encryptedAuthJson: WorkspaceIntegrationCredentialEncryptedPayload,
  context: { workspaceId: string },
  keyVersion: number,
): WorkspaceCodexAuthJson {
  if (encryptedAuthJson.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Codex credential encryption algorithm ${encryptedAuthJson.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported Codex credential encryption key version ${keyVersion}.`);
    }
    throw error;
  }

  try {
    return decryptJson(encryptedAuthJson, {
      key,
      aad: authenticatedData(context, keyVersion),
    });
  } catch {
    throw new Error("Codex credential could not be decrypted.");
  }
}

function authenticatedData(context: { workspaceId: string }, keyVersion: number) {
  return buildAad({
    workspaceId: context.workspaceId,
    kind: "codex_auth_json",
    keyVersion,
  });
}
