import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { assertPersonalPluginWritesEnabled, pluginAccess } from "./plugin-access";
import type * as schema from "./product-schema";
import {
  type DopplerConnectionStatus,
  dopplerConnections,
  type IntegrationCredentialEncryptedPayload,
  plugins,
} from "./product-schema";
import { skillMembership } from "./skill-access";

const ENCRYPTION_KEY_VERSION = 1;
export const DOPPLER_AUTH_BUNDLE_FORMAT_VERSION = 1 as const;
type DbSchema = typeof schema;
type DopplerAuthDb = Pick<PgDatabase<PgQueryResultHKT, DbSchema>, "insert" | "select" | "update">;

export type DopplerAuthBundle = {
  formatVersion: typeof DOPPLER_AUTH_BUNDLE_FORMAT_VERSION;
  token: string;
};

export type LoadedDopplerConnection = {
  workspaceId: string;
  authBundle: DopplerAuthBundle | null;
  credentialGeneration: string;
  status: DopplerConnectionStatus;
  statusReason: string | null;
  accountName: string | null;
  cliVersion: string | null;
  bundleFormatVersion: number | null;
  expiresAt: Date | null;
  connectedByWorkosId: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
};

export type DopplerConnectionMetadata = Omit<LoadedDopplerConnection, "authBundle">;

export async function saveDopplerConnection(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
  authBundle: DopplerAuthBundle;
  accountName: string;
  cliVersion: string;
  expiresAt?: Date | null;
  connectedByWorkosId: string;
  now?: Date;
}) {
  await assertPersonalPluginWritesEnabled(input.db);
  const now = input.now ?? new Date();
  const credentialGeneration = randomUUID();
  const encryptedAuthBundle = encryptAuthBundle(
    input.authBundle,
    JSON.stringify([input.workspaceId, input.userId]),
    ENCRYPTION_KEY_VERSION,
  );

  const [connection] = await input.db
    .insert(dopplerConnections)
    .values({
      workspaceId: input.workspaceId,
      ownerUserId: input.userId,
      encryptedAuthBundle,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      credentialGeneration,
      status: "connected",
      statusReason: null,
      accountName: input.accountName,
      cliVersion: input.cliVersion,
      bundleFormatVersion: DOPPLER_AUTH_BUNDLE_FORMAT_VERSION,
      expiresAt: input.expiresAt ?? null,
      connectedByWorkosId: input.connectedByWorkosId,
      lastValidatedAt: now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [dopplerConnections.workspaceId, dopplerConnections.ownerUserId],
      set: {
        encryptedAuthBundle,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        credentialGeneration,
        status: "connected",
        statusReason: null,
        accountName: input.accountName,
        cliVersion: input.cliVersion,
        bundleFormatVersion: DOPPLER_AUTH_BUNDLE_FORMAT_VERSION,
        expiresAt: input.expiresAt ?? null,
        connectedByWorkosId: input.connectedByWorkosId,
        lastValidatedAt: now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      workspaceId: dopplerConnections.workspaceId,
      credentialGeneration: dopplerConnections.credentialGeneration,
    });

  if (!connection) throw new Error("Could not persist the Doppler connection.");
  return connection;
}

export async function disconnectDopplerConnection(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
  now?: Date;
}) {
  await assertPersonalPluginWritesEnabled(input.db);
  const now = input.now ?? new Date();
  const credentialGeneration = randomUUID();
  await input.db
    .insert(dopplerConnections)
    .values({
      workspaceId: input.workspaceId,
      ownerUserId: input.userId,
      encryptedAuthBundle: null,
      encryptionKeyVersion: null,
      credentialGeneration,
      status: "disconnected",
      statusReason: null,
      accountName: null,
      cliVersion: null,
      bundleFormatVersion: null,
      expiresAt: null,
      connectedByWorkosId: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [dopplerConnections.workspaceId, dopplerConnections.ownerUserId],
      set: {
        encryptedAuthBundle: null,
        encryptionKeyVersion: null,
        credentialGeneration,
        status: "disconnected",
        statusReason: null,
        accountName: null,
        cliVersion: null,
        bundleFormatVersion: null,
        expiresAt: null,
        connectedByWorkosId: null,
        lastValidatedAt: null,
        lastRotatedAt: null,
        updatedAt: now,
      },
    });
  return { credentialGeneration };
}

export async function markDopplerConnectionNeedsReauth(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
  expectedCredentialGeneration: string;
  statusReason: string;
  now?: Date;
}) {
  const [updated] = await input.db
    .update(dopplerConnections)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason.slice(0, 240),
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(dopplerConnections.workspaceId, input.workspaceId),
        eq(dopplerConnections.ownerUserId, input.userId),
        skillMembership(input),
        eq(dopplerConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(dopplerConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: dopplerConnections.workspaceId });
  return Boolean(updated);
}

export async function markDopplerConnectionValidated(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
  expectedCredentialGeneration: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [updated] = await input.db
    .update(dopplerConnections)
    .set({ status: "connected", statusReason: null, lastValidatedAt: now, updatedAt: now })
    .where(
      and(
        eq(dopplerConnections.workspaceId, input.workspaceId),
        eq(dopplerConnections.ownerUserId, input.userId),
        skillMembership(input),
        eq(dopplerConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(dopplerConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: dopplerConnections.workspaceId });
  return Boolean(updated);
}

export async function loadDopplerConnection(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
}): Promise<LoadedDopplerConnection | null> {
  const row = await loadConnectionRow(input);
  if (!row) return null;
  if (row.workspaceId !== input.workspaceId) {
    throw new Error("Doppler connection row did not match the requested workspace.");
  }

  const authBundle =
    row.encryptedAuthBundle && row.encryptionKeyVersion !== null
      ? decryptAuthBundle(
          row.encryptedAuthBundle,
          JSON.stringify([input.workspaceId, input.userId]),
          row.encryptionKeyVersion,
        )
      : null;
  return metadataFromRow(row, authBundle);
}

export async function loadDopplerConnectionMetadata(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
}): Promise<DopplerConnectionMetadata | null> {
  const row = await loadConnectionRow(input);
  return row ? metadataFromRow(row, null) : null;
}

async function loadConnectionRow(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
}) {
  const [row] = await input.db
    .select({
      workspaceId: dopplerConnections.workspaceId,
      encryptedAuthBundle: dopplerConnections.encryptedAuthBundle,
      encryptionKeyVersion: dopplerConnections.encryptionKeyVersion,
      credentialGeneration: dopplerConnections.credentialGeneration,
      status: dopplerConnections.status,
      statusReason: dopplerConnections.statusReason,
      accountName: dopplerConnections.accountName,
      cliVersion: dopplerConnections.cliVersion,
      bundleFormatVersion: dopplerConnections.bundleFormatVersion,
      expiresAt: dopplerConnections.expiresAt,
      connectedByWorkosId: dopplerConnections.connectedByWorkosId,
      lastValidatedAt: dopplerConnections.lastValidatedAt,
      lastRotatedAt: dopplerConnections.lastRotatedAt,
      updatedAt: dopplerConnections.updatedAt,
    })
    .from(dopplerConnections)
    .where(
      and(
        eq(dopplerConnections.workspaceId, input.workspaceId),
        eq(dopplerConnections.ownerUserId, input.userId),
        skillMembership(input),
      ),
    )
    .limit(1);
  return row ?? null;
}

function metadataFromRow(
  row: NonNullable<Awaited<ReturnType<typeof loadConnectionRow>>>,
  authBundle: DopplerAuthBundle | null,
): LoadedDopplerConnection {
  return {
    workspaceId: row.workspaceId,
    authBundle,
    credentialGeneration: row.credentialGeneration,
    status: row.status,
    statusReason: row.statusReason,
    accountName: row.accountName,
    cliVersion: row.cliVersion,
    bundleFormatVersion: row.bundleFormatVersion,
    expiresAt: row.expiresAt,
    connectedByWorkosId: row.connectedByWorkosId,
    lastValidatedAt: row.lastValidatedAt,
    lastRotatedAt: row.lastRotatedAt,
    updatedAt: row.updatedAt,
  };
}

function encryptAuthBundle(
  authBundle: DopplerAuthBundle,
  workspaceId: string,
  keyVersion: number,
): IntegrationCredentialEncryptedPayload {
  return encryptJson(authBundle, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(workspaceId, keyVersion),
  });
}

function decryptAuthBundle(
  encryptedAuthBundle: IntegrationCredentialEncryptedPayload,
  workspaceId: string,
  keyVersion: number,
): DopplerAuthBundle {
  if (encryptedAuthBundle.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Doppler credential encryption algorithm ${encryptedAuthBundle.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported Doppler credential encryption key version ${keyVersion}.`);
    }
    throw error;
  }

  let decrypted: unknown;
  try {
    decrypted = decryptJson(encryptedAuthBundle, {
      key,
      aad: authenticatedData(workspaceId, keyVersion),
    });
  } catch {
    throw new Error("Doppler credential could not be decrypted.");
  }
  if (!isAuthBundle(decrypted)) {
    throw new Error("Doppler credential payload has an unsupported format.");
  }
  return decrypted;
}

function isAuthBundle(value: unknown): value is DopplerAuthBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DopplerAuthBundle>;
  return (
    candidate.formatVersion === DOPPLER_AUTH_BUNDLE_FORMAT_VERSION &&
    typeof candidate.token === "string" &&
    /^dp\.ct\.[A-Za-z0-9_-]+$/.test(candidate.token) &&
    candidate.token.length < 4096
  );
}

function authenticatedData(workspaceId: string, keyVersion: number) {
  return buildAad({ workspaceId, kind: "doppler_auth_bundle", keyVersion });
}

export async function hasDopplerPlugin(input: {
  db: DopplerAuthDb;
  workspaceId: string;
  userId: string;
}) {
  const [plugin] = await input.db
    .select({
      sourceUrl: plugins.sourceUrl,
      sourcePath: plugins.sourcePath,
      sourceRef: plugins.sourceRef,
    })
    .from(plugins)
    .where(and(eq(plugins.name, "doppler"), eq(plugins.status, "enabled"), pluginAccess(input)))
    .limit(1);
  return Boolean(
    plugin &&
      plugin.sourceUrl === "https://github.com/useopencompany/plugins" &&
      plugin.sourcePath === "doppler" &&
      /^[a-f0-9]{40}$/.test(plugin.sourceRef),
  );
}
