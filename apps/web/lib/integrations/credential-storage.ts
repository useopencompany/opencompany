import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
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

const ENCRYPTION_KEY_ENV = "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY";
const ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_KEY_ENV_BY_VERSION: Record<number, string> = {
  [ENCRYPTION_KEY_VERSION]: ENCRYPTION_KEY_ENV,
};
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_BYTE_LENGTH = 12;
const ENCRYPTION_KEY_BYTE_LENGTH = 32;
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
  const key = loadEncryptionKey(keyVersion);
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(authenticatedData(context, keyVersion));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
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

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      loadEncryptionKey(keyVersion),
      Buffer.from(encryptedPayload.iv, "base64"),
    );
    decipher.setAAD(authenticatedData(context, keyVersion));
    decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as unknown;
    if (!isRecord(payload)) {
      throw new Error("Decrypted integration credential payload is invalid.");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unsupported integration credential")) {
      throw error;
    }
    throw new Error("Integration credential could not be decrypted.");
  }
}

function authenticatedData(context: IntegrationCredentialContext, keyVersion: number) {
  return Buffer.from(
    JSON.stringify({
      workspaceId: context.workspaceId,
      integrationId: context.integrationId,
      provider: context.provider,
      kind: context.kind,
      keyVersion,
    }),
    "utf8",
  );
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

function loadEncryptionKey(keyVersion: number) {
  const envName = encryptionKeyEnvForVersion(keyVersion);
  const raw = process.env[envName]?.trim();
  if (!raw) {
    throw new Error(`${envName} is required for integration credential storage.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key.`);
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key.`);
  }

  return key;
}

function encryptionKeyEnvForVersion(keyVersion: number) {
  const envName = ENCRYPTION_KEY_ENV_BY_VERSION[keyVersion];
  if (envName) return envName;

  throw new Error(`Unsupported integration credential encryption key version ${keyVersion}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newWorkspaceIntegrationCredentialId() {
  return `wicred_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
