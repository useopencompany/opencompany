import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import {
  type ConnectorMcpCredentialKind,
  connectorMcpCredentials,
  type WorkspaceIntegrationCredentialEncryptedPayload,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

const CONNECTOR_ENCRYPTION_KEY_VERSION = 1;
const CONNECTOR_ENCRYPTION_KEY_ENV_BY_VERSION = {
  [CONNECTOR_ENCRYPTION_KEY_VERSION]: "CONNECTOR_CREDENTIAL_ENCRYPTION_KEY",
};

type CredentialDb = Pick<ReturnType<typeof getDb>, "delete" | "insert" | "select">;

export type ConnectorMcpCredentialContext = {
  organizationId: string;
  serverId: string;
  kind: ConnectorMcpCredentialKind;
};

export type LoadedConnectorMcpCredential = {
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function saveConnectorMcpCredential(
  input: ConnectorMcpCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db?: CredentialDb;
  },
) {
  const db = input.db ?? getDb();
  const now = new Date();
  const encryptedPayload = encryptConnectorPayload(input.payload, input);

  const [credential] = await db
    .insert(connectorMcpCredentials)
    .values({
      id: newConnectorMcpCredentialId(),
      organizationId: input.organizationId,
      serverId: input.serverId,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: CONNECTOR_ENCRYPTION_KEY_VERSION,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [connectorMcpCredentials.serverId, connectorMcpCredentials.kind],
      set: {
        organizationId: input.organizationId,
        encryptedPayload,
        encryptionKeyVersion: CONNECTOR_ENCRYPTION_KEY_VERSION,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: connectorMcpCredentials.id });

  if (!credential) throw new Error("Could not persist Connector MCP credential.");
}

export async function loadConnectorMcpCredential(
  input: ConnectorMcpCredentialContext & { db?: CredentialDb },
): Promise<LoadedConnectorMcpCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      organizationId: connectorMcpCredentials.organizationId,
      serverId: connectorMcpCredentials.serverId,
      kind: connectorMcpCredentials.kind,
      encryptedPayload: connectorMcpCredentials.encryptedPayload,
      encryptionKeyVersion: connectorMcpCredentials.encryptionKeyVersion,
      expiresAt: connectorMcpCredentials.expiresAt,
      lastRotatedAt: connectorMcpCredentials.lastRotatedAt,
      updatedAt: connectorMcpCredentials.updatedAt,
    })
    .from(connectorMcpCredentials)
    .where(
      and(
        eq(connectorMcpCredentials.organizationId, input.organizationId),
        eq(connectorMcpCredentials.serverId, input.serverId),
        eq(connectorMcpCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;
  if (
    credential.organizationId !== input.organizationId ||
    credential.serverId !== input.serverId ||
    credential.kind !== input.kind
  ) {
    throw new Error("Connector MCP credential row did not match the requested context.");
  }

  return {
    payload: decryptConnectorPayload(
      credential.encryptedPayload,
      input,
      credential.encryptionKeyVersion,
    ),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function deleteConnectorMcpCredential(
  input: ConnectorMcpCredentialContext & { db?: CredentialDb },
) {
  const db = input.db ?? getDb();
  await db
    .delete(connectorMcpCredentials)
    .where(
      and(
        eq(connectorMcpCredentials.organizationId, input.organizationId),
        eq(connectorMcpCredentials.serverId, input.serverId),
        eq(connectorMcpCredentials.kind, input.kind),
      ),
    );
}

function encryptConnectorPayload(
  payload: Record<string, unknown>,
  context: ConnectorMcpCredentialContext,
): WorkspaceIntegrationCredentialEncryptedPayload {
  return encryptJson(payload, {
    key: loadConnectorEncryptionKey(CONNECTOR_ENCRYPTION_KEY_VERSION),
    aad: authenticatedData(context, CONNECTOR_ENCRYPTION_KEY_VERSION),
  });
}

function decryptConnectorPayload(
  encryptedPayload: WorkspaceIntegrationCredentialEncryptedPayload,
  context: ConnectorMcpCredentialContext,
  keyVersion: number,
) {
  if (keyVersion !== CONNECTOR_ENCRYPTION_KEY_VERSION) {
    throw new Error(`Unsupported Connector MCP credential encryption key version ${keyVersion}.`);
  }
  if (encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Connector MCP credential encryption algorithm ${encryptedPayload.algorithm}.`,
    );
  }

  const key = loadConnectorEncryptionKey(keyVersion);
  try {
    return decryptJson(encryptedPayload, { key, aad: authenticatedData(context, keyVersion) });
  } catch {
    throw new Error("Connector MCP credential could not be decrypted.");
  }
}

function loadConnectorEncryptionKey(keyVersion: number) {
  return loadEncryptionKey(keyVersion, CONNECTOR_ENCRYPTION_KEY_ENV_BY_VERSION);
}

function authenticatedData(context: ConnectorMcpCredentialContext, keyVersion: number) {
  return buildAad({
    organizationId: context.organizationId,
    serverId: context.serverId,
    kind: context.kind,
    keyVersion,
  });
}

function newConnectorMcpCredentialId() {
  return `cmcpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
