import { randomUUID } from "node:crypto";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";
import {
  type CodexCredentialStatus,
  codexCredentials,
  type IntegrationCredentialEncryptedPayload,
} from "./schema";

const ENCRYPTION_KEY_VERSION = 1;

type DbSchema = typeof schema;
type CodexAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

export type CodexAuthJson = Record<string, unknown>;

export type LoadedCodexCredential = {
  authJson: CodexAuthJson;
  status: CodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export function newCodexDeviceAuthFlowId() {
  return `gcodf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function saveCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  authJson: CodexAuthJson;
  status?: CodexCredentialStatus;
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
    .insert(codexCredentials)
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
      target: codexCredentials.userWorkosId,
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
      userWorkosId: codexCredentials.userWorkosId,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
      updatedAt: codexCredentials.updatedAt,
    });

  if (!credential) throw new Error("Could not persist Codex credential.");
  return credential;
}

export async function rotateCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  authJson: CodexAuthJson;
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
    .update(codexCredentials)
    .set({
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status: "connected",
      statusReason: null,
      lastValidatedAt: input.validatedAt ?? now,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId))
    .returning({ userWorkosId: codexCredentials.userWorkosId });
  return Boolean(credential);
}

export async function markCodexCredentialNeedsReauth(input: {
  db: CodexAuthDb;
  userWorkosId: string;
  statusReason: string;
  now?: Date;
}) {
  await input.db
    .update(codexCredentials)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId));
}

export async function loadCodexCredential(input: {
  db: CodexAuthDb;
  userWorkosId: string;
}): Promise<LoadedCodexCredential | null> {
  const [credential] = await input.db
    .select({
      userWorkosId: codexCredentials.userWorkosId,
      encryptedAuthJson: codexCredentials.encryptedAuthJson,
      encryptionKeyVersion: codexCredentials.encryptionKeyVersion,
      status: codexCredentials.status,
      statusReason: codexCredentials.statusReason,
      lastValidatedAt: codexCredentials.lastValidatedAt,
      lastRotatedAt: codexCredentials.lastRotatedAt,
      updatedAt: codexCredentials.updatedAt,
    })
    .from(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId))
    .limit(1);

  if (!credential) return null;
  if (credential.userWorkosId !== input.userWorkosId) {
    throw new Error("Codex credential row did not match the requested user.");
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

export async function deleteCodexCredential(input: { db: CodexAuthDb; userWorkosId: string }) {
  await input.db
    .delete(codexCredentials)
    .where(eq(codexCredentials.userWorkosId, input.userWorkosId));
}

function encryptAuthJson(
  authJson: CodexAuthJson,
  context: { userWorkosId: string },
  keyVersion: number,
): IntegrationCredentialEncryptedPayload {
  return encryptJson(authJson, {
    key: loadEncryptionKey(keyVersion),
    aad: authenticatedData(context, keyVersion),
  });
}

function decryptAuthJson(
  encryptedAuthJson: IntegrationCredentialEncryptedPayload,
  context: { userWorkosId: string },
  keyVersion: number,
): CodexAuthJson {
  if (encryptedAuthJson.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Codex credential encryption algorithm ${encryptedAuthJson.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(`Unsupported Codex credential encryption key version ${keyVersion}.`);
    }
    throw error;
  }

  try {
    return decryptJson(encryptedAuthJson, {
      key,
      aad: authenticatedData(context, keyVersion),
    });
  } catch {
    throw new Error("Codex credential could not be decrypted.");
  }
}

function authenticatedData(context: { userWorkosId: string }, keyVersion: number) {
  return buildAad({
    userWorkosId: context.userWorkosId,
    kind: "goat_codex_auth_json",
    keyVersion,
  });
}
