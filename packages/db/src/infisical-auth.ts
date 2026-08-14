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
import type * as schema from "./product-schema";
import {
  type InfisicalConnectionStatus,
  type IntegrationCredentialEncryptedPayload,
  infisicalConnections,
} from "./product-schema";

const ENCRYPTION_KEY_VERSION = 1;
export const INFISICAL_AUTH_BUNDLE_FORMAT_VERSION = 1 as const;
export const INFISICAL_US_HOST = "https://app.infisical.com";
export const INFISICAL_EU_HOST = "https://eu.infisical.com";
export const INFISICAL_HOSTS = [INFISICAL_US_HOST, INFISICAL_EU_HOST] as const;
export type InfisicalHost = (typeof INFISICAL_HOSTS)[number];

export function isInfisicalHost(value: unknown): value is InfisicalHost {
  return typeof value === "string" && INFISICAL_HOSTS.includes(value as InfisicalHost);
}

export function isInfisicalSessionDomain(value: unknown, expectedHost: InfisicalHost) {
  if (typeof value !== "string") return false;
  return (
    value
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/api$/, "") === expectedHost
  );
}

type DbSchema = typeof schema;
type InfisicalAuthDb = Pick<PgDatabase<PgQueryResultHKT, DbSchema>, "insert" | "select" | "update">;

export type InfisicalAuthBundleFile = {
  path: string;
  contentsBase64: string;
  mode: number;
};

export type InfisicalAuthBundle = {
  formatVersion: typeof INFISICAL_AUTH_BUNDLE_FORMAT_VERSION;
  files: InfisicalAuthBundleFile[];
  redactionValues: string[];
};

export type LoadedInfisicalConnection = {
  workspaceId: string;
  authBundle: InfisicalAuthBundle | null;
  credentialGeneration: string;
  status: InfisicalConnectionStatus;
  statusReason: string | null;
  host: InfisicalHost;
  accountEmail: string | null;
  cliVersion: string | null;
  bundleFormatVersion: number | null;
  expiresAt: Date | null;
  connectedByWorkosId: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
};

export type InfisicalConnectionMetadata = Omit<LoadedInfisicalConnection, "authBundle">;

export function newInfisicalAuthFlowId() {
  return `ginff_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function saveInfisicalConnection(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
  authBundle: InfisicalAuthBundle;
  host: InfisicalHost;
  accountEmail: string;
  cliVersion: string;
  expiresAt?: Date | null;
  connectedByWorkosId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const credentialGeneration = randomUUID();
  const encryptedAuthBundle = encryptAuthBundle(
    input.authBundle,
    input.workspaceId,
    ENCRYPTION_KEY_VERSION,
  );

  const [connection] = await input.db
    .insert(infisicalConnections)
    .values({
      workspaceId: input.workspaceId,
      encryptedAuthBundle,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      credentialGeneration,
      status: "connected",
      statusReason: null,
      host: input.host,
      accountEmail: input.accountEmail,
      cliVersion: input.cliVersion,
      bundleFormatVersion: INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
      expiresAt: input.expiresAt ?? null,
      connectedByWorkosId: input.connectedByWorkosId,
      lastValidatedAt: now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: infisicalConnections.workspaceId,
      set: {
        encryptedAuthBundle,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        credentialGeneration,
        status: "connected",
        statusReason: null,
        host: input.host,
        accountEmail: input.accountEmail,
        cliVersion: input.cliVersion,
        bundleFormatVersion: INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
        expiresAt: input.expiresAt ?? null,
        connectedByWorkosId: input.connectedByWorkosId,
        lastValidatedAt: now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      workspaceId: infisicalConnections.workspaceId,
      credentialGeneration: infisicalConnections.credentialGeneration,
    });

  if (!connection) throw new Error("Could not persist the Infisical connection.");
  return connection;
}

export async function disconnectInfisicalConnection(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const credentialGeneration = randomUUID();
  await input.db
    .insert(infisicalConnections)
    .values({
      workspaceId: input.workspaceId,
      encryptedAuthBundle: null,
      encryptionKeyVersion: null,
      credentialGeneration,
      status: "disconnected",
      statusReason: null,
      host: INFISICAL_US_HOST,
      accountEmail: null,
      cliVersion: null,
      bundleFormatVersion: null,
      expiresAt: null,
      connectedByWorkosId: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: infisicalConnections.workspaceId,
      set: {
        encryptedAuthBundle: null,
        encryptionKeyVersion: null,
        credentialGeneration,
        status: "disconnected",
        statusReason: null,
        accountEmail: null,
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

export async function markInfisicalConnectionNeedsReauth(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
  expectedCredentialGeneration: string;
  statusReason: string;
  now?: Date;
}) {
  const [updated] = await input.db
    .update(infisicalConnections)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason.slice(0, 240),
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(infisicalConnections.workspaceId, input.workspaceId),
        eq(infisicalConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(infisicalConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: infisicalConnections.workspaceId });
  return Boolean(updated);
}

export async function markInfisicalConnectionValidated(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
  expectedCredentialGeneration: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [updated] = await input.db
    .update(infisicalConnections)
    .set({ status: "connected", statusReason: null, lastValidatedAt: now, updatedAt: now })
    .where(
      and(
        eq(infisicalConnections.workspaceId, input.workspaceId),
        eq(infisicalConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(infisicalConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: infisicalConnections.workspaceId });
  return Boolean(updated);
}

export async function loadInfisicalConnection(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
}): Promise<LoadedInfisicalConnection | null> {
  const row = await loadConnectionRow(input);
  if (!row) return null;
  if (row.workspaceId !== input.workspaceId) {
    throw new Error("Infisical connection row did not match the requested workspace.");
  }

  const authBundle =
    row.encryptedAuthBundle && row.encryptionKeyVersion !== null
      ? decryptAuthBundle(row.encryptedAuthBundle, input.workspaceId, row.encryptionKeyVersion)
      : null;
  return metadataFromRow(row, authBundle);
}

export async function loadInfisicalConnectionMetadata(input: {
  db: InfisicalAuthDb;
  workspaceId: string;
}): Promise<InfisicalConnectionMetadata | null> {
  const row = await loadConnectionRow(input);
  return row ? metadataFromRow(row, null) : null;
}

async function loadConnectionRow(input: { db: InfisicalAuthDb; workspaceId: string }) {
  const [row] = await input.db
    .select({
      workspaceId: infisicalConnections.workspaceId,
      encryptedAuthBundle: infisicalConnections.encryptedAuthBundle,
      encryptionKeyVersion: infisicalConnections.encryptionKeyVersion,
      credentialGeneration: infisicalConnections.credentialGeneration,
      status: infisicalConnections.status,
      statusReason: infisicalConnections.statusReason,
      host: infisicalConnections.host,
      accountEmail: infisicalConnections.accountEmail,
      cliVersion: infisicalConnections.cliVersion,
      bundleFormatVersion: infisicalConnections.bundleFormatVersion,
      expiresAt: infisicalConnections.expiresAt,
      connectedByWorkosId: infisicalConnections.connectedByWorkosId,
      lastValidatedAt: infisicalConnections.lastValidatedAt,
      lastRotatedAt: infisicalConnections.lastRotatedAt,
      updatedAt: infisicalConnections.updatedAt,
    })
    .from(infisicalConnections)
    .where(eq(infisicalConnections.workspaceId, input.workspaceId))
    .limit(1);
  return row ?? null;
}

function metadataFromRow(
  row: NonNullable<Awaited<ReturnType<typeof loadConnectionRow>>>,
  authBundle: InfisicalAuthBundle | null,
): LoadedInfisicalConnection {
  return {
    workspaceId: row.workspaceId,
    authBundle,
    credentialGeneration: row.credentialGeneration,
    status: row.status,
    statusReason: row.statusReason,
    host: isInfisicalHost(row.host) ? row.host : INFISICAL_US_HOST,
    accountEmail: row.accountEmail,
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
  authBundle: InfisicalAuthBundle,
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
): InfisicalAuthBundle {
  if (encryptedAuthBundle.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Infisical credential encryption algorithm ${encryptedAuthBundle.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported Infisical credential encryption key version ${keyVersion}.`);
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
    throw new Error("Infisical credential could not be decrypted.");
  }
  if (!isAuthBundle(decrypted)) {
    throw new Error("Infisical credential payload has an unsupported format.");
  }
  return decrypted;
}

function isAuthBundle(value: unknown): value is InfisicalAuthBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InfisicalAuthBundle>;
  return (
    candidate.formatVersion === INFISICAL_AUTH_BUNDLE_FORMAT_VERSION &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        typeof file.contentsBase64 === "string" &&
        typeof file.mode === "number",
    ) &&
    Array.isArray(candidate.redactionValues) &&
    candidate.redactionValues.every((secret) => typeof secret === "string")
  );
}

function authenticatedData(workspaceId: string, keyVersion: number) {
  return buildAad({ workspaceId, kind: "goat_infisical_auth_bundle", keyVersion });
}
