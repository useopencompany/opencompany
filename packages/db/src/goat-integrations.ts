import { randomUUID } from "node:crypto";
import {
  buildAad,
  DEFAULT_ENCRYPTION_KEY_VERSION,
  decryptJson,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatIntegrationCredentialKind,
  type GoatIntegrationProvider,
  goatIntegrationCredentials,
  goatIntegrations,
} from "./goat-schema";

export type GoatGoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

type GoatIntegrationDb = Pick<ReturnType<typeof getDb>, "insert" | "select" | "update">;
type GoatIntegrationRootDb = GoatIntegrationDb & Pick<ReturnType<typeof getDb>, "transaction">;

export type GoatIntegrationCredentialContext = {
  userWorkosId: string;
  integrationId: string;
  provider: GoatIntegrationProvider;
  kind: GoatIntegrationCredentialKind;
};

export type LoadedGoatIntegrationCredential = {
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function connectGoatGoogleIntegration(input: {
  provider: GoatIntegrationProvider;
  userWorkosId: string;
  externalId: string;
  accountEmail: string | null;
  accountName: string | null;
  tokens: GoatGoogleOAuthTokens;
  expiresAt: Date | null;
  scopes: string[];
  db?: GoatIntegrationRootDb;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.accountEmail?.trim() || input.accountName?.trim() || "Google";

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: input.provider,
      externalId: input.externalId,
      connectionLabel,
      accountName: input.accountName,
      accountEmail: input.accountEmail,
      accountType: "google_account",
      status: "connected",
      statusReason: null,
      scopes: input.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      set: {
        connectionLabel,
        accountName: input.accountName,
        accountEmail: input.accountEmail,
        accountType: "google_account",
        status: "connected",
        statusReason: null,
        scopes: input.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Google integration.");
  }

  try {
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: input.provider,
      kind: "oauth_token",
      payload: { ...input.tokens },
      expiresAt: input.expiresAt,
      db,
      now,
    });
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: input.provider,
      status: "sync_failed",
      statusReason: "Failed to persist Google integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export async function saveGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db?: GoatIntegrationDb;
    now?: Date;
  },
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION;
  const encryptedPayload = encryptJson(input.payload, {
    key: loadEncryptionKey(keyVersion),
    aad: goatCredentialAad({ ...input, keyVersion }),
  });

  const [credential] = await db
    .insert(goatIntegrationCredentials)
    .values({
      id: newGoatIntegrationCredentialId(),
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      kind: input.kind,
      encryptedPayload,
      encryptionKeyVersion: keyVersion,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatIntegrationCredentials.integrationId, goatIntegrationCredentials.kind],
      set: {
        userWorkosId: input.userWorkosId,
        provider: input.provider,
        encryptedPayload,
        encryptionKeyVersion: keyVersion,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      id: goatIntegrationCredentials.id,
      expiresAt: goatIntegrationCredentials.expiresAt,
      lastRotatedAt: goatIntegrationCredentials.lastRotatedAt,
      updatedAt: goatIntegrationCredentials.updatedAt,
      encryptionKeyVersion: goatIntegrationCredentials.encryptionKeyVersion,
    });

  if (!credential) {
    throw new Error("Could not persist Goat integration credential.");
  }

  return credential;
}

export async function refreshGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & {
    payload: Record<string, unknown>;
    expiresAt?: Date | null;
    db?: GoatIntegrationRootDb;
    now?: Date;
  },
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const credential = await saveGoatIntegrationCredential({ ...input, db: tx, now });
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: input.provider,
      status: "connected",
      statusReason: null,
      db: tx,
      now,
    });
    return credential;
  });
}

export async function loadGoatIntegrationCredential(
  input: GoatIntegrationCredentialContext & { db?: Pick<ReturnType<typeof getDb>, "select"> },
): Promise<LoadedGoatIntegrationCredential | null> {
  const db = input.db ?? getDb();
  const [credential] = await db
    .select({
      userWorkosId: goatIntegrationCredentials.userWorkosId,
      integrationId: goatIntegrationCredentials.integrationId,
      provider: goatIntegrationCredentials.provider,
      kind: goatIntegrationCredentials.kind,
      encryptedPayload: goatIntegrationCredentials.encryptedPayload,
      encryptionKeyVersion: goatIntegrationCredentials.encryptionKeyVersion,
      expiresAt: goatIntegrationCredentials.expiresAt,
      lastRotatedAt: goatIntegrationCredentials.lastRotatedAt,
      updatedAt: goatIntegrationCredentials.updatedAt,
    })
    .from(goatIntegrationCredentials)
    .where(
      and(
        eq(goatIntegrationCredentials.userWorkosId, input.userWorkosId),
        eq(goatIntegrationCredentials.integrationId, input.integrationId),
        eq(goatIntegrationCredentials.provider, input.provider),
        eq(goatIntegrationCredentials.kind, input.kind),
      ),
    )
    .limit(1);

  if (!credential) return null;

  return {
    payload: decryptJson(credential.encryptedPayload, {
      key: loadEncryptionKey(credential.encryptionKeyVersion),
      aad: goatCredentialAad({
        userWorkosId: input.userWorkosId,
        integrationId: input.integrationId,
        provider: input.provider,
        kind: input.kind,
        keyVersion: credential.encryptionKeyVersion,
      }),
    }),
    expiresAt: credential.expiresAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export async function markGoatIntegrationStatus(input: {
  userWorkosId: string;
  integrationId: string;
  provider: GoatIntegrationProvider;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason?: string | null;
  db?: Pick<ReturnType<typeof getDb>, "update">;
  now?: Date;
}) {
  await (input.db ?? getDb())
    .update(goatIntegrations)
    .set({
      status: input.status,
      statusReason: input.statusReason ? input.statusReason.slice(0, 240) : null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.provider, input.provider),
      ),
    );
}

export function goatCredentialAad(
  input: GoatIntegrationCredentialContext & { keyVersion: number },
) {
  return buildAad({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: input.provider,
    kind: input.kind,
    keyVersion: input.keyVersion,
  });
}

function newGoatIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newGoatIntegrationCredentialId() {
  return `gcred_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
