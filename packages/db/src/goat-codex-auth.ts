import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as goatSchema from "./goat-schema";
import {
  type GoatCodexCredentialStatus,
  type GoatIntegrationCredentialEncryptedPayload,
  goatCodexCredentials,
} from "./goat-schema";

const ENCRYPTION_KEY_VERSION = 1;

type DbSchema = typeof goatSchema;
type GoatCodexAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

export type GoatCodexAuthJson = Record<string, unknown>;

export type LoadedGoatCodexCredential = {
  authJson: GoatCodexAuthJson;
  status: GoatCodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export function newGoatCodexDeviceAuthFlowId() {
  return `gcodf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function saveGoatCodexCredential(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
  authJson: GoatCodexAuthJson;
  status?: GoatCodexCredentialStatus;
  statusReason?: string | null;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { userWorkosId: input.userWorkosId },
    ENCRYPTION_KEY_VERSION,
  );
  const status = input.status ?? "connected";

  const [credential] = await input.db
    .insert(goatCodexCredentials)
    .values({
      userWorkosId: input.userWorkosId,
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status,
      statusReason: input.statusReason ?? null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goatCodexCredentials.userWorkosId,
      set: {
        encryptedAuthJson,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        status,
        statusReason: input.statusReason ?? null,
        lastValidatedAt: input.validatedAt ?? now,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      userWorkosId: goatCodexCredentials.userWorkosId,
      lastValidatedAt: goatCodexCredentials.lastValidatedAt,
      lastRotatedAt: goatCodexCredentials.lastRotatedAt,
      updatedAt: goatCodexCredentials.updatedAt,
    });

  if (!credential) throw new Error("Could not persist Goat Codex credential.");
  return credential;
}

export async function rotateGoatCodexCredential(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
  authJson: GoatCodexAuthJson;
  expectedLastRotatedAt: Date | null;
  validatedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const encryptedAuthJson = encryptAuthJson(
    input.authJson,
    { userWorkosId: input.userWorkosId },
    ENCRYPTION_KEY_VERSION,
  );
  const [credential] = await input.db
    .update(goatCodexCredentials)
    .set({
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status: "connected",
      statusReason: null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatCodexCredentials.userWorkosId, input.userWorkosId),
        input.expectedLastRotatedAt
          ? eq(goatCodexCredentials.lastRotatedAt, input.expectedLastRotatedAt)
          : isNull(goatCodexCredentials.lastRotatedAt),
      ),
    )
    .returning({ userWorkosId: goatCodexCredentials.userWorkosId });
  return Boolean(credential);
}

export async function markGoatCodexCredentialNeedsReauth(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
  statusReason: string;
  now?: Date;
}) {
  await input.db
    .update(goatCodexCredentials)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(goatCodexCredentials.userWorkosId, input.userWorkosId));
}

export async function loadGoatCodexCredential(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
}): Promise<LoadedGoatCodexCredential | null> {
  const [credential] = await input.db
    .select({
      userWorkosId: goatCodexCredentials.userWorkosId,
      encryptedAuthJson: goatCodexCredentials.encryptedAuthJson,
      encryptionKeyVersion: goatCodexCredentials.encryptionKeyVersion,
      status: goatCodexCredentials.status,
      statusReason: goatCodexCredentials.statusReason,
      lastValidatedAt: goatCodexCredentials.lastValidatedAt,
      lastRotatedAt: goatCodexCredentials.lastRotatedAt,
      updatedAt: goatCodexCredentials.updatedAt,
    })
    .from(goatCodexCredentials)
    .where(eq(goatCodexCredentials.userWorkosId, input.userWorkosId))
    .limit(1);

  if (!credential) return null;
  if (credential.userWorkosId !== input.userWorkosId) {
    throw new Error("Goat Codex credential row did not match the requested user.");
  }

  return {
    authJson: decryptAuthJson(
      credential.encryptedAuthJson,
      { userWorkosId: input.userWorkosId },
      credential.encryptionKeyVersion,
    ),
    status: credential.status,
    statusReason: credential.statusReason,
    lastValidatedAt: credential.lastValidatedAt,
    lastRotatedAt: credential.lastRotatedAt,
    updatedAt: credential.updatedAt,
    encryptionKeyVersion: credential.encryptionKeyVersion,
  };
}

export type GoatCodexAuthStatus = {
  status: GoatCodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
};

// Status-only read for settings surfaces and engine-availability checks; never
// touches the encrypted auth payload.
export async function loadGoatCodexAuthStatus(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
}): Promise<GoatCodexAuthStatus | null> {
  const [row] = await input.db
    .select({
      status: goatCodexCredentials.status,
      statusReason: goatCodexCredentials.statusReason,
      lastValidatedAt: goatCodexCredentials.lastValidatedAt,
      lastRotatedAt: goatCodexCredentials.lastRotatedAt,
    })
    .from(goatCodexCredentials)
    .where(eq(goatCodexCredentials.userWorkosId, input.userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function deleteGoatCodexCredential(input: {
  db: GoatCodexAuthDb;
  userWorkosId: string;
}) {
  await input.db
    .delete(goatCodexCredentials)
    .where(eq(goatCodexCredentials.userWorkosId, input.userWorkosId));
}

function encryptAuthJson(
  authJson: GoatCodexAuthJson,
  context: { userWorkosId: string },
  keyVersion: number,
): GoatIntegrationCredentialEncryptedPayload {
  return encryptJson(authJson, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(context, keyVersion),
  });
}

function decryptAuthJson(
  encryptedAuthJson: GoatIntegrationCredentialEncryptedPayload,
  context: { userWorkosId: string },
  keyVersion: number,
): GoatCodexAuthJson {
  if (encryptedAuthJson.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Goat Codex credential encryption algorithm ${encryptedAuthJson.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported Goat Codex credential encryption key version ${keyVersion}.`);
    }
    throw error;
  }

  try {
    return decryptJson(encryptedAuthJson, {
      key,
      aad: authenticatedData(context, keyVersion),
    });
  } catch {
    throw new Error("Goat Codex credential could not be decrypted.");
  }
}

function authenticatedData(context: { userWorkosId: string }, keyVersion: number) {
  return buildAad({
    userWorkosId: context.userWorkosId,
    kind: "goat_codex_auth_json",
    keyVersion,
  });
}
