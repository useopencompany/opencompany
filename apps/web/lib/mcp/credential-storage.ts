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
import { and, eq, isNull, lt, ne } from "drizzle-orm";

const ENCRYPTION_KEY_VERSION = 1;
export const DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY = "default";

// An abandoned multi-account OAuth flow leaves a temp row (generated accountKey, no
// connectedByUserId) that `complete` never finalized. They're already filtered out of the
// runner and settings, but accumulate on every retry. We sweep ones older than the state TTL
// (10 min, see oauth-state.ts) so an in-flight concurrent connect is never deleted mid-flow.
const INCOMPLETE_MCP_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

type CredentialDb = Pick<ReturnType<typeof getDb>, "delete" | "insert" | "select">;

export type McpCredentialContext = {
  workspaceId: string;
  serverId: string;
  kind: WorkspaceMcpCredentialKind;
  accountKey?: string;
};

export type McpCredentialAccountFields = {
  externalAccountId?: string | null;
  accountLabel?: string | null;
  accountEmail?: string | null;
  connectedByUserId?: string | null;
  metadata?: Record<string, unknown>;
};

export type LoadedMcpCredential = {
  accountKey: string;
  externalAccountId: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  connectedByUserId: string | null;
  payload: Record<string, unknown>;
  bearerToken?: string;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  encryptionKeyVersion: number;
};

export async function saveMcpCredential(
  input: McpCredentialContext & {
    payload?: Record<string, unknown>;
    bearerToken?: string;
    expiresAt?: Date | null;
    db?: CredentialDb;
  } & McpCredentialAccountFields,
) {
  const db = input.db ?? getDb();
  const now = new Date();
  const accountKey = normalizeAccountKey(input.accountKey);
  const payload = input.payload ?? { bearerToken: input.bearerToken };
  const encryptedPayload = encryptPayload(payload, input);
  const accountSet = accountFieldsForUpdate(input);

  const [credential] = await db
    .insert(workspaceMcpCredentials)
    .values({
      id: newWorkspaceMcpCredentialId(),
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      kind: input.kind,
      accountKey,
      externalAccountId: input.externalAccountId ?? null,
      accountLabel: input.accountLabel ?? null,
      accountEmail: input.accountEmail ?? null,
      connectedByUserId: input.connectedByUserId ?? null,
      encryptedPayload,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      metadata: input.metadata ?? {},
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // Conflict target must match the workspace_mcp_credentials unique index and the runner's
      // upsert in apps/runner/src/mcp-tools.ts (createRunnerMcpOAuthProvider). Keep all three in sync.
      target: [
        workspaceMcpCredentials.serverId,
        workspaceMcpCredentials.kind,
        workspaceMcpCredentials.accountKey,
      ],
      set: {
        workspaceId: input.workspaceId,
        encryptedPayload,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        ...accountSet,
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
  const accountKey = normalizeAccountKey(input.accountKey);
  const [credential] = await db
    .select({
      workspaceId: workspaceMcpCredentials.workspaceId,
      serverId: workspaceMcpCredentials.serverId,
      kind: workspaceMcpCredentials.kind,
      accountKey: workspaceMcpCredentials.accountKey,
      externalAccountId: workspaceMcpCredentials.externalAccountId,
      accountLabel: workspaceMcpCredentials.accountLabel,
      accountEmail: workspaceMcpCredentials.accountEmail,
      connectedByUserId: workspaceMcpCredentials.connectedByUserId,
      encryptedPayload: workspaceMcpCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceMcpCredentials.encryptionKeyVersion,
      expiresAt: workspaceMcpCredentials.expiresAt,
      lastRotatedAt: workspaceMcpCredentials.lastRotatedAt,
      updatedAt: workspaceMcpCredentials.updatedAt,
      metadata: workspaceMcpCredentials.metadata,
    })
    .from(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.serverId, input.serverId),
        eq(workspaceMcpCredentials.kind, input.kind),
        eq(workspaceMcpCredentials.accountKey, accountKey),
      ),
    )
    .limit(1);

  if (!credential) return null;
  if (
    credential.workspaceId !== input.workspaceId ||
    credential.serverId !== input.serverId ||
    credential.kind !== input.kind ||
    credential.accountKey !== accountKey
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
    accountKey: credential.accountKey,
    externalAccountId: credential.externalAccountId,
    accountLabel: credential.accountLabel,
    accountEmail: credential.accountEmail,
    connectedByUserId: credential.connectedByUserId,
    payload,
    ...(bearerToken ? { bearerToken } : {}),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    metadata: credential.metadata,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function deleteMcpCredential(input: McpCredentialContext & { db?: CredentialDb }) {
  const db = input.db ?? getDb();
  const baseFilter = and(
    eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
    eq(workspaceMcpCredentials.serverId, input.serverId),
    eq(workspaceMcpCredentials.kind, input.kind),
  );
  await db
    .delete(workspaceMcpCredentials)
    .where(
      input.accountKey
        ? and(
            baseFilter,
            eq(workspaceMcpCredentials.accountKey, normalizeAccountKey(input.accountKey)),
          )
        : baseFilter,
    );
}

export async function listMcpCredentialAccounts(input: {
  workspaceId: string;
  serverId: string;
  kind: WorkspaceMcpCredentialKind;
  db?: CredentialDb;
}) {
  const db = input.db ?? getDb();
  return db
    .select({
      accountKey: workspaceMcpCredentials.accountKey,
      externalAccountId: workspaceMcpCredentials.externalAccountId,
      accountLabel: workspaceMcpCredentials.accountLabel,
      accountEmail: workspaceMcpCredentials.accountEmail,
      connectedByUserId: workspaceMcpCredentials.connectedByUserId,
      expiresAt: workspaceMcpCredentials.expiresAt,
      lastRotatedAt: workspaceMcpCredentials.lastRotatedAt,
      updatedAt: workspaceMcpCredentials.updatedAt,
      metadata: workspaceMcpCredentials.metadata,
    })
    .from(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.serverId, input.serverId),
        eq(workspaceMcpCredentials.kind, input.kind),
      ),
    );
}

// Delete abandoned, never-finalized multi-account temp rows for a server+kind. Best-effort:
// called when a new connect starts so retries don't pile up orphan credential rows. Bounded by
// the state TTL so it can't race a concurrent in-flight flow.
export async function cleanupIncompleteMcpCredentials(input: {
  workspaceId: string;
  serverId: string;
  kind: WorkspaceMcpCredentialKind;
  db?: CredentialDb;
}) {
  const db = input.db ?? getDb();
  const cutoff = new Date(Date.now() - INCOMPLETE_MCP_CREDENTIAL_TTL_MS);
  await db
    .delete(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
        eq(workspaceMcpCredentials.serverId, input.serverId),
        eq(workspaceMcpCredentials.kind, input.kind),
        ne(workspaceMcpCredentials.accountKey, DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY),
        isNull(workspaceMcpCredentials.connectedByUserId),
        lt(workspaceMcpCredentials.updatedAt, cutoff),
      ),
    );
}

export async function finalizeMcpCredentialAccount(
  input: McpCredentialContext &
    Required<Pick<McpCredentialAccountFields, "connectedByUserId">> &
    McpCredentialAccountFields & {
      nextAccountKey?: string;
    },
) {
  const db = getDb();
  const now = new Date();
  const currentAccountKey = normalizeAccountKey(input.accountKey);
  const nextAccountKey = normalizeAccountKey(input.nextAccountKey ?? currentAccountKey);

  return db.transaction(async (tx) => {
    if (nextAccountKey !== currentAccountKey) {
      await tx
        .delete(workspaceMcpCredentials)
        .where(
          and(
            eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
            eq(workspaceMcpCredentials.serverId, input.serverId),
            eq(workspaceMcpCredentials.kind, input.kind),
            eq(workspaceMcpCredentials.accountKey, nextAccountKey),
          ),
        );
    }

    const [updated] = await tx
      .update(workspaceMcpCredentials)
      .set({
        accountKey: nextAccountKey,
        externalAccountId: input.externalAccountId ?? null,
        accountLabel: input.accountLabel ?? null,
        accountEmail: input.accountEmail ?? null,
        connectedByUserId: input.connectedByUserId,
        metadata: input.metadata ?? {},
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceMcpCredentials.workspaceId, input.workspaceId),
          eq(workspaceMcpCredentials.serverId, input.serverId),
          eq(workspaceMcpCredentials.kind, input.kind),
          eq(workspaceMcpCredentials.accountKey, currentAccountKey),
        ),
      )
      .returning({ accountKey: workspaceMcpCredentials.accountKey });

    if (!updated) throw new Error("Could not finalize MCP credential account.");
    return { accountKey: updated.accountKey };
  });
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

export function newMcpCredentialAccountKey() {
  return `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function normalizeAccountKey(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY;
}

function accountFieldsForUpdate(input: McpCredentialAccountFields) {
  const fields: Partial<typeof workspaceMcpCredentials.$inferInsert> = {};
  if (input.externalAccountId !== undefined) fields.externalAccountId = input.externalAccountId;
  if (input.accountLabel !== undefined) fields.accountLabel = input.accountLabel;
  if (input.accountEmail !== undefined) fields.accountEmail = input.accountEmail;
  if (input.connectedByUserId !== undefined) fields.connectedByUserId = input.connectedByUserId;
  if (input.metadata !== undefined) fields.metadata = input.metadata;
  return fields;
}
