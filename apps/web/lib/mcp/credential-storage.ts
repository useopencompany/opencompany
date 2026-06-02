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
  type WorkspaceIntegrationCredentialEncryptedPayload,
  type WorkspaceMcpCredentialKind,
  workspaceMcpCredentials,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

const ENCRYPTION_KEY_VERSION = 1;

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
  return encryptJson(payload, {
    key: loadEncryptionKey(ENCRYPTION_KEY_VERSION),
    aad: authenticatedData(context, ENCRYPTION_KEY_VERSION),
  });
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

  // Loaded before the try so a missing/malformed key env (EncryptionKeyConfigError)
  // surfaces as-is rather than being masked as a decrypt failure.
  const key = loadEncryptionKey(keyVersion);
  try {
    return decryptJson(encryptedPayload, { key, aad: authenticatedData(context, keyVersion) });
  } catch {
    throw new Error("MCP credential could not be decrypted.");
  }
}

// Field order is significant — it must stay byte-identical to previously stored
// credentials (see buildAad in @opencompany/crypto).
function authenticatedData(context: McpCredentialContext, keyVersion: number) {
  return buildAad({
    workspaceId: context.workspaceId,
    serverId: context.serverId,
    kind: context.kind,
    keyVersion,
  });
}

function newWorkspaceMcpCredentialId() {
  return `wmcpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
