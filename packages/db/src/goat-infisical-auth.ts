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
import type * as goatSchema from "./goat-schema";
import {
  type GoatInfisicalConnectionStatus,
  type GoatIntegrationCredentialEncryptedPayload,
  goatInfisicalConnections,
} from "./goat-schema";

const ENCRYPTION_KEY_VERSION = 1;
export const GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION = 1 as const;
export const GOAT_INFISICAL_US_HOST = "https://app.infisical.com";
export const GOAT_INFISICAL_EU_HOST = "https://eu.infisical.com";
export const GOAT_INFISICAL_HOSTS = [GOAT_INFISICAL_US_HOST, GOAT_INFISICAL_EU_HOST] as const;
export type GoatInfisicalHost = (typeof GOAT_INFISICAL_HOSTS)[number];

export function isGoatInfisicalHost(value: unknown): value is GoatInfisicalHost {
  return typeof value === "string" && GOAT_INFISICAL_HOSTS.includes(value as GoatInfisicalHost);
}

export function isGoatInfisicalSessionDomain(value: unknown, expectedHost: GoatInfisicalHost) {
  if (typeof value !== "string") return false;
  return (
    value
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/api$/, "") === expectedHost
  );
}

type DbSchema = typeof goatSchema;
type GoatInfisicalAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "insert" | "select" | "update"
>;

export type GoatInfisicalAuthBundleFile = {
  path: string;
  contentsBase64: string;
  mode: number;
};

export type GoatInfisicalAuthBundle = {
  formatVersion: typeof GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION;
  files: GoatInfisicalAuthBundleFile[];
  redactionValues: string[];
};

export type LoadedGoatInfisicalConnection = {
  workspaceId: string;
  authBundle: GoatInfisicalAuthBundle | null;
  credentialGeneration: string;
  status: GoatInfisicalConnectionStatus;
  statusReason: string | null;
  host: GoatInfisicalHost;
  accountEmail: string | null;
  cliVersion: string | null;
  bundleFormatVersion: number | null;
  expiresAt: Date | null;
  connectedByWorkosId: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
};

export type GoatInfisicalConnectionMetadata = Omit<LoadedGoatInfisicalConnection, "authBundle">;

export function newGoatInfisicalAuthFlowId() {
  return `ginff_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function saveGoatInfisicalConnection(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
  authBundle: GoatInfisicalAuthBundle;
  host: GoatInfisicalHost;
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
    .insert(goatInfisicalConnections)
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
      bundleFormatVersion: GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
      expiresAt: input.expiresAt ?? null,
      connectedByWorkosId: input.connectedByWorkosId,
      lastValidatedAt: now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goatInfisicalConnections.workspaceId,
      set: {
        encryptedAuthBundle,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        credentialGeneration,
        status: "connected",
        statusReason: null,
        host: input.host,
        accountEmail: input.accountEmail,
        cliVersion: input.cliVersion,
        bundleFormatVersion: GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
        expiresAt: input.expiresAt ?? null,
        connectedByWorkosId: input.connectedByWorkosId,
        lastValidatedAt: now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      workspaceId: goatInfisicalConnections.workspaceId,
      credentialGeneration: goatInfisicalConnections.credentialGeneration,
    });

  if (!connection) throw new Error("Could not persist the Infisical connection.");
  return connection;
}

export async function disconnectGoatInfisicalConnection(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const credentialGeneration = randomUUID();
  await input.db
    .insert(goatInfisicalConnections)
    .values({
      workspaceId: input.workspaceId,
      encryptedAuthBundle: null,
      encryptionKeyVersion: null,
      credentialGeneration,
      status: "disconnected",
      statusReason: null,
      host: GOAT_INFISICAL_US_HOST,
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
      target: goatInfisicalConnections.workspaceId,
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

export async function markGoatInfisicalConnectionNeedsReauth(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
  expectedCredentialGeneration: string;
  statusReason: string;
  now?: Date;
}) {
  const [updated] = await input.db
    .update(goatInfisicalConnections)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason.slice(0, 240),
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(goatInfisicalConnections.workspaceId, input.workspaceId),
        eq(goatInfisicalConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(goatInfisicalConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: goatInfisicalConnections.workspaceId });
  return Boolean(updated);
}

export async function markGoatInfisicalConnectionValidated(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
  expectedCredentialGeneration: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [updated] = await input.db
    .update(goatInfisicalConnections)
    .set({ status: "connected", statusReason: null, lastValidatedAt: now, updatedAt: now })
    .where(
      and(
        eq(goatInfisicalConnections.workspaceId, input.workspaceId),
        eq(goatInfisicalConnections.credentialGeneration, input.expectedCredentialGeneration),
        eq(goatInfisicalConnections.status, "connected"),
      ),
    )
    .returning({ workspaceId: goatInfisicalConnections.workspaceId });
  return Boolean(updated);
}

export async function loadGoatInfisicalConnection(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
}): Promise<LoadedGoatInfisicalConnection | null> {
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

export async function loadGoatInfisicalConnectionMetadata(input: {
  db: GoatInfisicalAuthDb;
  workspaceId: string;
}): Promise<GoatInfisicalConnectionMetadata | null> {
  const row = await loadConnectionRow(input);
  return row ? metadataFromRow(row, null) : null;
}

async function loadConnectionRow(input: { db: GoatInfisicalAuthDb; workspaceId: string }) {
  const [row] = await input.db
    .select({
      workspaceId: goatInfisicalConnections.workspaceId,
      encryptedAuthBundle: goatInfisicalConnections.encryptedAuthBundle,
      encryptionKeyVersion: goatInfisicalConnections.encryptionKeyVersion,
      credentialGeneration: goatInfisicalConnections.credentialGeneration,
      status: goatInfisicalConnections.status,
      statusReason: goatInfisicalConnections.statusReason,
      host: goatInfisicalConnections.host,
      accountEmail: goatInfisicalConnections.accountEmail,
      cliVersion: goatInfisicalConnections.cliVersion,
      bundleFormatVersion: goatInfisicalConnections.bundleFormatVersion,
      expiresAt: goatInfisicalConnections.expiresAt,
      connectedByWorkosId: goatInfisicalConnections.connectedByWorkosId,
      lastValidatedAt: goatInfisicalConnections.lastValidatedAt,
      lastRotatedAt: goatInfisicalConnections.lastRotatedAt,
      updatedAt: goatInfisicalConnections.updatedAt,
    })
    .from(goatInfisicalConnections)
    .where(eq(goatInfisicalConnections.workspaceId, input.workspaceId))
    .limit(1);
  return row ?? null;
}

function metadataFromRow(
  row: NonNullable<Awaited<ReturnType<typeof loadConnectionRow>>>,
  authBundle: GoatInfisicalAuthBundle | null,
): LoadedGoatInfisicalConnection {
  return {
    workspaceId: row.workspaceId,
    authBundle,
    credentialGeneration: row.credentialGeneration,
    status: row.status,
    statusReason: row.statusReason,
    host: isGoatInfisicalHost(row.host) ? row.host : GOAT_INFISICAL_US_HOST,
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
  authBundle: GoatInfisicalAuthBundle,
  workspaceId: string,
  keyVersion: number,
): GoatIntegrationCredentialEncryptedPayload {
  return encryptJson(authBundle, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(workspaceId, keyVersion),
  });
}

function decryptAuthBundle(
  encryptedAuthBundle: GoatIntegrationCredentialEncryptedPayload,
  workspaceId: string,
  keyVersion: number,
): GoatInfisicalAuthBundle {
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

function isAuthBundle(value: unknown): value is GoatInfisicalAuthBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoatInfisicalAuthBundle>;
  return (
    candidate.formatVersion === GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION &&
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
