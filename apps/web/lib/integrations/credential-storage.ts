import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import {
  type WorkspaceIntegrationConnectionStatus,
  type WorkspaceIntegrationCredentialEncryptedPayload,
  type WorkspaceIntegrationCredentialKind,
  workspaceIntegrationCredentials,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { sanitizeIntegrationStatusReason } from "@/lib/integrations/status";

const ENCRYPTION_KEY_VERSION = 1;
type CredentialDb = Pick<ReturnType<typeof getDb>, "delete" | "insert" | "select" | "update">;
type CredentialRootDb = CredentialDb & Pick<ReturnType<typeof getDb>, "transaction">;

export type IntegrationCredentialContext = {
  workspaceId: string;
  integrationId: string;
  provider: string;
  kind: WorkspaceIntegrationCredentialKind;
};

export type SaveIntegrationCredentialInput = IntegrationCredentialContext & {
  payload: Record<string, unknown>;
  expiresAt?: Date | null;
  db?: CredentialDb;
  now?: Date;
};

export type RefreshIntegrationCredentialInput = Omit<SaveIntegrationCredentialInput, "db"> & {
  db?: CredentialRootDb;
  statusReason?: string | null;
};

export type LoadIntegrationCredentialInput = IntegrationCredentialContext & {
  db?: CredentialDb;
};

export type DeleteIntegrationCredentialInput = IntegrationCredentialContext & {
  db?: CredentialDb;
};

export type MarkIntegrationCredentialRefreshFailedInput = {
  workspaceId: string;
  integrationId: string;
  provider: string;
  status: Extract<WorkspaceIntegrationConnectionStatus, "needs_reauth" | "sync_failed">;
  statusReason: string;
  db?: CredentialDb;
  now?: Date;
};

export type LoadedIntegrationCredential = {
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function saveIntegrationCredential(input: SaveIntegrationCredentialInput) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const encryptedPayload = encryptPayload(input.payload, input, ENCRYPTION_KEY_VERSION);

  const [credential] = await db
    .insert(workspaceIntegrationCredentials)
    .values({
      id: newWorkspaceIntegrationCredentialId(),
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      provider: input.provider,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceIntegrationCredentials.integrationId, workspaceIntegrationCredentials.kind],
      set: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        encryptedPayload,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      id: workspaceIntegrationCredentials.id,
      expiresAt: workspaceIntegrationCredentials.expiresAt,
      lastRotatedAt: workspaceIntegrationCredentials.lastRotatedAt,
      updatedAt: workspaceIntegrationCredentials.updatedAt,
      encryptionKeyVersion: workspaceIntegrationCredentials.encryptionKeyVersion,
    });

  if (!credential) {
    throw new Error("Could not persist workspace integration credential.");
  }

  return credential;
}

export async function refreshIntegrationCredential(input: RefreshIntegrationCredentialInput) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const credential = await saveIntegrationCredential({ ...input, db: tx, now });
    await tx
      .update(workspaceIntegrations)
      .set({
        status: "connected",
        statusReason: input.statusReason
          ? sanitizeIntegrationStatusReason(input.statusReason)
          : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, input.workspaceId),
          eq(workspaceIntegrations.id, input.integrationId),
          eq(workspaceIntegrations.provider, input.provider),
        ),
      );

    return credential;
  });
}

export async function loadIntegrationCredential(
  input: LoadIntegrationCredentialInput,
): Promise<LoadedIntegrationCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      workspaceId: workspaceIntegrationCredentials.workspaceId,
      integrationId: workspaceIntegrationCredentials.integrationId,
      provider: workspaceIntegrationCredentials.provider,
      kind: workspaceIntegrationCredentials.kind,
      encryptedPayload: workspaceIntegrationCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceIntegrationCredentials.encryptionKeyVersion,
      expiresAt: workspaceIntegrationCredentials.expiresAt,
      lastRotatedAt: workspaceIntegrationCredentials.lastRotatedAt,
      updatedAt: workspaceIntegrationCredentials.updatedAt,
    })
    .from(workspaceIntegrationCredentials)
    .where(
      and(
        eq(workspaceIntegrationCredentials.workspaceId, input.workspaceId),
        eq(workspaceIntegrationCredentials.integrationId, input.integrationId),
        eq(workspaceIntegrationCredentials.provider, input.provider),
        eq(workspaceIntegrationCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;

  assertCredentialContextMatchesRequest(credential, input);

  return {
    payload: decryptPayload(credential.encryptedPayload, input, credential.encryptionKeyVersion),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function deleteIntegrationCredential(input: DeleteIntegrationCredentialInput) {
  const db = input.db ?? getDb();

  await db
    .delete(workspaceIntegrationCredentials)
    .where(
      and(
        eq(workspaceIntegrationCredentials.workspaceId, input.workspaceId),
        eq(workspaceIntegrationCredentials.integrationId, input.integrationId),
        eq(workspaceIntegrationCredentials.provider, input.provider),
        eq(workspaceIntegrationCredentials.kind, input.kind),
      ),
    );
}

export async function markIntegrationCredentialRefreshFailed(
  input: MarkIntegrationCredentialRefreshFailedInput,
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  await db
    .update(workspaceIntegrations)
    .set({
      status: input.status,
      statusReason: sanitizeIntegrationStatusReason(
        input.statusReason,
        "Credential refresh failed.",
      ),
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.id, input.integrationId),
        eq(workspaceIntegrations.provider, input.provider),
      ),
    );
}

function encryptPayload(
  payload: Record<string, unknown>,
  context: IntegrationCredentialContext,
  keyVersion: number,
): WorkspaceIntegrationCredentialEncryptedPayload {
  return encryptJson(payload, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(context, keyVersion),
  });
}

function decryptPayload(
  encryptedPayload: WorkspaceIntegrationCredentialEncryptedPayload,
  context: IntegrationCredentialContext,
  keyVersion: number,
) {
  if (encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported integration credential encryption algorithm ${encryptedPayload.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported integration credential encryption key version ${keyVersion}.`);
    }
    // EncryptionKeyConfigError (missing/malformed key env) surfaces as-is rather than
    // being masked as a decrypt failure.
    throw error;
  }

  try {
    return decryptJson(encryptedPayload, { key, aad: authenticatedData(context, keyVersion) });
  } catch {
    throw new Error("Integration credential could not be decrypted.");
  }
}

// Field order is significant — it must stay byte-identical to previously stored
// credentials (see buildAad in @opencompany/crypto).
function authenticatedData(context: IntegrationCredentialContext, keyVersion: number) {
  return buildAad({
    workspaceId: context.workspaceId,
    integrationId: context.integrationId,
    provider: context.provider,
    kind: context.kind,
    keyVersion,
  });
}

function assertCredentialContextMatchesRequest(
  credential: IntegrationCredentialContext,
  request: IntegrationCredentialContext,
) {
  if (
    credential.workspaceId !== request.workspaceId ||
    credential.integrationId !== request.integrationId ||
    credential.provider !== request.provider ||
    credential.kind !== request.kind
  ) {
    throw new Error("Integration credential row did not match the requested context.");
  }
}

function newWorkspaceIntegrationCredentialId() {
  return `wicred_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
