import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const INFISICAL_FILE_VAULT_ALGORITHM = "PBES2-HS256+A128KW";
const INFISICAL_FILE_VAULT_ENCRYPTION = "A256GCM";
const INFISICAL_FILE_VAULT_PBKDF_ITERATIONS = 8192;
const AES_KEY_WRAP_INITIAL_VALUE = Buffer.alloc(8, 0xa6);

export async function createInfisicalBackupKeyEntry(configContents: string) {
  const passphrase = readFileVaultPassphrase(configContents);
  const backupKey = randomBytes(16).toString("hex");
  const saltInput = randomBytes(12);
  const protectedHeader = {
    alg: INFISICAL_FILE_VAULT_ALGORITHM,
    created: new Date().toISOString(),
    enc: INFISICAL_FILE_VAULT_ENCRYPTION,
    p2c: INFISICAL_FILE_VAULT_PBKDF_ITERATIONS,
    p2s: base64Url(saltInput),
  };
  const encodedHeader = base64Url(Buffer.from(JSON.stringify(protectedHeader), "utf8"));
  const salt = Buffer.concat([
    Buffer.from(INFISICAL_FILE_VAULT_ALGORITHM, "utf8"),
    Buffer.from([0]),
    saltInput,
  ]);
  const wrappingKey = pbkdf2Sync(
    passphrase,
    salt,
    INFISICAL_FILE_VAULT_PBKDF_ITERATIONS,
    16,
    "sha256",
  );
  const contentEncryptionKey = randomBytes(32);
  const encryptedKey = wrapInfisicalFileVaultKey(wrappingKey, contentEncryptionKey);
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentEncryptionKey, initializationVector, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(encodedHeader, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(backupKey), "utf8")),
    cipher.final(),
  ]);

  return [
    encodedHeader,
    base64Url(encryptedKey),
    base64Url(initializationVector),
    base64Url(ciphertext),
    base64Url(cipher.getAuthTag()),
  ].join(".");
}

// RFC 3394 AES key wrap, used by Infisical's PBES2-HS256+A128KW file vault.
export function wrapInfisicalFileVaultKey(wrappingKey: Uint8Array, key: Uint8Array) {
  if (wrappingKey.byteLength !== 16 || key.byteLength < 16 || key.byteLength % 8 !== 0) {
    throw new Error("Infisical file-vault key material has an invalid length.");
  }

  let integrityRegister = Buffer.from(AES_KEY_WRAP_INITIAL_VALUE);
  const blocks = Array.from({ length: key.byteLength / 8 }, (_, index) =>
    Buffer.from(key.subarray(index * 8, index * 8 + 8)),
  );

  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < blocks.length; index += 1) {
      const encrypted = encryptAesBlock(
        Buffer.from(wrappingKey),
        Buffer.concat([integrityRegister, blocks[index] as Buffer]),
      );
      integrityRegister = xorCounter(encrypted.subarray(0, 8), round * blocks.length + index + 1);
      blocks[index] = encrypted.subarray(8, 16);
    }
  }

  return Buffer.concat([integrityRegister, ...blocks]);
}

function encryptAesBlock(key: Buffer, block: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function xorCounter(input: Uint8Array, counter: number) {
  const output = Buffer.from(input);
  let value = BigInt(counter);
  for (let index = output.length - 1; index >= 0 && value > 0; index -= 1) {
    output[index] = (output[index] ?? 0) ^ Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

function base64Url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function readFileVaultPassphrase(configContents: string) {
  let value: unknown;
  try {
    value = JSON.parse(configContents);
  } catch {
    throw new Error("Infisical file-vault config is invalid.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Infisical file-vault config is invalid.");
  }
  const config = value as Record<string, unknown>;
  if (config.vaultBackendType !== "file" || typeof config.vaultBackendPassphrase !== "string") {
    throw new Error("Infisical file-vault config is incomplete.");
  }
  const passphrase = Buffer.from(config.vaultBackendPassphrase, "base64");
  if (passphrase.byteLength === 0) {
    throw new Error("Infisical file-vault config is incomplete.");
  }
  return passphrase;
}
