import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Shared AES-256-GCM credential crypto. Used by both the web app (integration and
// MCP credential storage) and the runner (MCP credential decryption at run time).
// This is the single source of truth for the cipher, IV/key sizes, key loading, and
// the encrypted-payload shape; callers own only their AAD context shape and their
// caller-specific error messages.

export const ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
const IV_BYTE_LENGTH = 12;
const ENCRYPTION_KEY_BYTE_LENGTH = 32;

// The default and (today) only credential key. The version→env map is the rotation
// seam: a future key v2 adds an entry here and existing rows keep decrypting under
// their stored version.
export const DEFAULT_ENCRYPTION_KEY_VERSION = 1;
const DEFAULT_ENCRYPTION_KEY_ENV_BY_VERSION: Record<number, string> = {
  [DEFAULT_ENCRYPTION_KEY_VERSION]: "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
};

export type EncryptedPayload = {
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  ciphertext: string;
  authTag: string;
};

// Missing or malformed key env. Callers re-throw this rather than masking it as a
// decrypt failure, so a misconfigured environment surfaces clearly.
export class EncryptionKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyConfigError";
  }
}

// Requested a key version with no configured env. Callers map this to their own
// provider-specific "unsupported key version" wording.
export class UnsupportedKeyVersionError extends Error {
  readonly keyVersion: number;
  constructor(keyVersion: number) {
    super(`Unsupported encryption key version ${keyVersion}.`);
    this.name = "UnsupportedKeyVersionError";
    this.keyVersion = keyVersion;
  }
}

// Any failure to decrypt or parse ciphertext (wrong key, tampered AAD/auth tag,
// corrupt data, non-object plaintext). Deliberately opaque — callers translate it
// into their own generic message so we never leak which check failed.
export class CredentialDecryptionError extends Error {
  constructor(message = "Credential could not be decrypted.") {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

// Build the additional authenticated data buffer. The caller passes a context object
// whose field ORDER is significant: JSON.stringify serializes in insertion order, and
// the AAD must be byte-identical to what was used at encryption time or decryption
// fails. Callers must keep their field order stable across versions.
export function buildAad(context: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(context), "utf8");
}

export function loadEncryptionKey(
  keyVersion: number = DEFAULT_ENCRYPTION_KEY_VERSION,
  envByVersion: Record<number, string> = DEFAULT_ENCRYPTION_KEY_ENV_BY_VERSION,
): Buffer {
  const envName = envByVersion[keyVersion];
  if (!envName) {
    throw new UnsupportedKeyVersionError(keyVersion);
  }

  const raw = process.env[envName]?.trim();
  if (!raw) {
    throw new EncryptionKeyConfigError(`${envName} is required.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new EncryptionKeyConfigError(`${envName} must be a base64-encoded 32-byte key.`);
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new EncryptionKeyConfigError(`${envName} must be a base64-encoded 32-byte key.`);
  }

  return key;
}

export function encryptJson(
  payload: unknown,
  opts: { key: Buffer; aad: Buffer },
): EncryptedPayload {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, opts.key, iv);
  cipher.setAAD(opts.aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptJson(
  encrypted: EncryptedPayload,
  opts: { key: Buffer; aad: Buffer },
): Record<string, unknown> {
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      opts.key,
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAAD(opts.aad);
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as unknown;
    if (!isRecord(payload)) {
      throw new CredentialDecryptionError();
    }
    return payload;
  } catch {
    throw new CredentialDecryptionError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
