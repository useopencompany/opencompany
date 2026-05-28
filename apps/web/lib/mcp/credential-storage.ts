import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type WorkspaceIntegrationCredentialEncryptedPayload,
  type WorkspaceMcpCredentialKind,
  workspaceMcpCredentials,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

const ENCRYPTION_KEY_ENV = "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY";
const ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_BYTE_LENGTH = 12;
const ENCRYPTION_KEY_BYTE_LENGTH = 32;

type CredentialDb = Pick<ReturnType<typeof getDb>, "delete" | "insert" | "select">;

export type McpCredentialContext = {
  workspaceId: string;
  serverId: string;
  kind: WorkspaceMcpCredentialKind;
};

export type LoadedMcpCredential = {
  payload: Record<string, unknown>;
  bearerToken?: string;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function saveMcpCredential(
  input: McpCredentialContext & {
    payload?: Record<string, unknown>;
    bearerToken?: string;
    expiresAt?: Date | null;
    db?: CredentialDb;
  },
) {
  const db = input.db ?? getDb();
  const now = new Date();
  const payload = input.payload ?? { bearerToken: input.bearerToken };
  const encryptedPayload = encryptPayload(payload, input);

  const [credential] = await db
    .insert(workspaceMcpCredentials)
    .values({
      id: newWorkspaceMcpCredentialId(),
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMcpCredentials.serverId, workspaceMcpCredentials.kind],
      set: {
        workspaceId: input.workspaceId,
        encryptedPayload,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceMcpCredentials.id });

  if (!credential) throw new Error("Could not persist workspace MCP credential.");
}

export async function loadMcpCredential(
  input: McpCredentialContext & { db?: CredentialDb },
): Promise<LoadedMcpCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      workspaceId: workspaceMcpCredentials.workspaceId,
      serverId: workspaceMcpCredentials.serverId,
      kind: workspaceMcpCredentials.kind,
      encryptedPayload: workspaceMcpCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceMcpCredentials.encryptionKeyVersion,
      expiresAt: workspaceMcpCredentials.expiresAt,
      lastRotatedAt: workspaceMcpCredentials.lastRotatedAt,
      updatedAt: workspaceMcpCredentials.updatedAt,
    })
    .from(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.serverId, input.serverId),
        eq(workspaceMcpCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;
  if (
    credential.workspaceId !== input.workspaceId ||
    credential.serverId !== input.serverId ||
    credential.kind !== input.kind
  ) {
    throw new Error("MCP credential row did not match the requested context.");
  }

  const payload = decryptPayload(
    credential.encryptedPayload,
    input,
    credential.encryptionKeyVersion,
  );
  const bearerToken = typeof payload.bearerToken === "string" ? payload.bearerToken : undefined;
  return {
    payload,
    ...(bearerToken ? { bearerToken } : {}),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function deleteMcpCredential(input: McpCredentialContext & { db?: CredentialDb }) {
  const db = input.db ?? getDb();
  await db
    .delete(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.serverId, input.serverId),
        eq(workspaceMcpCredentials.kind, input.kind),
      ),
    );
}

function encryptPayload(
  payload: Record<string, unknown>,
  context: McpCredentialContext,
): WorkspaceIntegrationCredentialEncryptedPayload {
  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(authenticatedData(context, ENCRYPTION_KEY_VERSION));
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
  context: McpCredentialContext,
  keyVersion: number,
) {
  if (keyVersion !== ENCRYPTION_KEY_VERSION) {
    throw new Error(`Unsupported MCP credential encryption key version ${keyVersion}.`);
  }
  if (encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported MCP credential encryption algorithm ${encryptedPayload.algorithm}.`,
    );
  }

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      loadEncryptionKey(),
      Buffer.from(encryptedPayload.iv, "base64"),
    );
    decipher.setAAD(authenticatedData(context, keyVersion));
    decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as unknown;
    if (!isRecord(payload)) throw new Error("Decrypted MCP credential payload is invalid.");
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unsupported MCP credential")) {
      throw error;
    }
    if (isEncryptionKeyConfigurationError(error)) {
      throw error;
    }
    throw new Error("MCP credential could not be decrypted.");
  }
}

function authenticatedData(context: McpCredentialContext, keyVersion: number) {
  return Buffer.from(
    JSON.stringify({
      workspaceId: context.workspaceId,
      serverId: context.serverId,
      kind: context.kind,
      keyVersion,
    }),
    "utf8",
  );
}

function loadEncryptionKey() {
  const raw = process.env[ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) throw new Error(`${ENCRYPTION_KEY_ENV} is required for MCP credential storage.`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte key.`);
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

function isEncryptionKeyConfigurationError(error: unknown) {
  return error instanceof Error && error.message.includes(ENCRYPTION_KEY_ENV);
}

function newWorkspaceMcpCredentialId() {
  return `wmcpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
