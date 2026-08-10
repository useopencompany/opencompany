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
  type GoatCodexCredentialStatus,
  type GoatIntegrationCredentialEncryptedPayload,
  goatClaudeCodeCredentials,
} from "./goat-schema";

const ENCRYPTION_KEY_VERSION = 1;

type DbSchema = typeof goatSchema;
type GoatClaudeCodeAuthDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

// Payload shape stored encrypted: the long-lived `claude setup-token` OAuth token,
// plus optional subscription hints needed for entitlement checks under token auth
// (see CLAUDE_CODE_SUBSCRIPTION_TYPE / CLAUDE_CODE_RATE_LIMIT_TIER).
export type GoatClaudeCodeAuthJson = {
  token: string;
  subscriptionType?: string;
  rateLimitTier?: string;
};

export type LoadedGoatClaudeCodeCredential = {
  authJson: GoatClaudeCodeAuthJson;
  status: GoatCodexCredentialStatus;
  statusReason: string | null;
  lastValidatedAt: Date | null;
  lastRotatedAt: Date | null;
  updatedAt: Date;
  encryptionKeyVersion: number;
};

export async function saveGoatClaudeCodeCredential(input: {
  db: GoatClaudeCodeAuthDb;
  userWorkosId: string;
  authJson: GoatClaudeCodeAuthJson;
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
  const lastValidatedAt = input.validatedAt ?? null;

  const [credential] = await input.db
    .insert(goatClaudeCodeCredentials)
    .values({
      userWorkosId: input.userWorkosId,
      encryptedAuthJson,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      status,
      statusReason: input.statusReason ?? null,
      lastValidatedAt,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: goatClaudeCodeCredentials.userWorkosId,
      set: {
        encryptedAuthJson,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        status,
        statusReason: input.statusReason ?? null,
        lastValidatedAt,
        lastRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      userWorkosId: goatClaudeCodeCredentials.userWorkosId,
      lastValidatedAt: goatClaudeCodeCredentials.lastValidatedAt,
      lastRotatedAt: goatClaudeCodeCredentials.lastRotatedAt,
      updatedAt: goatClaudeCodeCredentials.updatedAt,
    });

  if (!credential) throw new Error("Could not persist Goat Claude Code credential.");
  return credential;
}

export async function markGoatClaudeCodeCredentialValidated(input: {
  db: GoatClaudeCodeAuthDb;
  userWorkosId: string;
  expectedUpdatedAt: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [credential] = await input.db
    .update(goatClaudeCodeCredentials)
    .set({
      status: "connected",
      statusReason: null,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatClaudeCodeCredentials.userWorkosId, input.userWorkosId),
        eq(goatClaudeCodeCredentials.updatedAt, input.expectedUpdatedAt),
      ),
    )
    .returning({ userWorkosId: goatClaudeCodeCredentials.userWorkosId });
  return Boolean(credential);
}

export async function markGoatClaudeCodeCredentialNeedsReauth(input: {
  db: GoatClaudeCodeAuthDb;
  userWorkosId: string;
  statusReason: string;
  now?: Date;
}) {
  await input.db
    .update(goatClaudeCodeCredentials)
    .set({
      status: "needs_reauth",
      statusReason: input.statusReason,
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(goatClaudeCodeCredentials.userWorkosId, input.userWorkosId));
}

export async function loadGoatClaudeCodeCredential(input: {
  db: GoatClaudeCodeAuthDb;
  userWorkosId: string;
}): Promise<LoadedGoatClaudeCodeCredential | null> {
  const [credential] = await input.db
    .select({
      userWorkosId: goatClaudeCodeCredentials.userWorkosId,
      encryptedAuthJson: goatClaudeCodeCredentials.encryptedAuthJson,
      encryptionKeyVersion: goatClaudeCodeCredentials.encryptionKeyVersion,
      status: goatClaudeCodeCredentials.status,
      statusReason: goatClaudeCodeCredentials.statusReason,
      lastValidatedAt: goatClaudeCodeCredentials.lastValidatedAt,
      lastRotatedAt: goatClaudeCodeCredentials.lastRotatedAt,
      updatedAt: goatClaudeCodeCredentials.updatedAt,
    })
    .from(goatClaudeCodeCredentials)
    .where(eq(goatClaudeCodeCredentials.userWorkosId, input.userWorkosId))
    .limit(1);

  if (!credential) return null;
  if (credential.userWorkosId !== input.userWorkosId) {
    throw new Error("Goat Claude Code credential row did not match the requested user.");
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

export async function deleteGoatClaudeCodeCredential(input: {
  db: GoatClaudeCodeAuthDb;
  userWorkosId: string;
}) {
  await input.db
    .delete(goatClaudeCodeCredentials)
    .where(eq(goatClaudeCodeCredentials.userWorkosId, input.userWorkosId));
}

function encryptAuthJson(
  authJson: GoatClaudeCodeAuthJson,
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
): GoatClaudeCodeAuthJson {
  if (encryptedAuthJson.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Goat Claude Code credential encryption algorithm ${encryptedAuthJson.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(keyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(
        `Unsupported Goat Claude Code credential encryption key version ${keyVersion}.`,
      );
    }
    throw error;
  }

  let decrypted: Record<string, unknown>;
  try {
    decrypted = decryptJson(encryptedAuthJson, {
      key,
      aad: authenticatedData(context, keyVersion),
    });
  } catch {
    throw new Error("Goat Claude Code credential could not be decrypted.");
  }
  if (typeof decrypted.token !== "string" || !decrypted.token) {
    throw new Error("Goat Claude Code credential payload is missing its token.");
  }
  return decrypted as GoatClaudeCodeAuthJson;
}

function authenticatedData(context: { userWorkosId: string }, keyVersion: number) {
  return buildAad({
    userWorkosId: context.userWorkosId,
    kind: "goat_claude_code_auth_json",
    keyVersion,
  });
}
