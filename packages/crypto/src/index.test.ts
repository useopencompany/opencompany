import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAad,
  CredentialDecryptionError,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  type EncryptedPayload,
  EncryptionKeyConfigError,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "./index";

const KEY_ENV = "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY";

function key(fill: number) {
  return Buffer.alloc(32, fill);
}

function keyBase64(fill: number) {
  return key(fill).toString("base64");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadEncryptionKey", () => {
  it("returns the decoded 32-byte key for version 1", () => {
    vi.stubEnv(KEY_ENV, keyBase64(1));
    expect(loadEncryptionKey()).toEqual(key(1));
    expect(loadEncryptionKey(1)).toEqual(key(1));
  });

  it("throws EncryptionKeyConfigError when the key env is missing", () => {
    expect(() => loadEncryptionKey()).toThrow(EncryptionKeyConfigError);
    expect(() => loadEncryptionKey()).toThrow(`${KEY_ENV} is required.`);
  });

  it("throws EncryptionKeyConfigError when the key is malformed", () => {
    vi.stubEnv(KEY_ENV, "not-base64!!");
    expect(() => loadEncryptionKey()).toThrow(`${KEY_ENV} must be a base64-encoded 32-byte key.`);
  });

  it("throws EncryptionKeyConfigError when the key is the wrong length", () => {
    vi.stubEnv(KEY_ENV, Buffer.alloc(16, 1).toString("base64"));
    expect(() => loadEncryptionKey()).toThrow(`${KEY_ENV} must be a base64-encoded 32-byte key.`);
  });

  it("throws UnsupportedKeyVersionError for an unknown key version", () => {
    vi.stubEnv(KEY_ENV, keyBase64(1));
    expect(() => loadEncryptionKey(99)).toThrow(UnsupportedKeyVersionError);
  });
});

describe("encryptJson / decryptJson round-trip", () => {
  it("round-trips a payload under the same key and AAD", () => {
    const aad = buildAad({ workspaceId: "wks_1", serverId: "srv_1", kind: "oauth", keyVersion: 1 });
    const encrypted = encryptJson({ token: "secret" }, { key: key(1), aad });

    expect(encrypted.algorithm).toBe(ENCRYPTION_ALGORITHM);
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(decryptJson(encrypted, { key: key(1), aad })).toEqual({ token: "secret" });
  });

  it("fails with CredentialDecryptionError under a different key", () => {
    const aad = buildAad({ workspaceId: "wks_1", serverId: "srv_1", kind: "oauth", keyVersion: 1 });
    const encrypted = encryptJson({ token: "secret" }, { key: key(1), aad });

    expect(() => decryptJson(encrypted, { key: key(2), aad })).toThrow(CredentialDecryptionError);
  });

  it("fails when the AAD does not match (context binding)", () => {
    const encrypted = encryptJson(
      { token: "secret" },
      {
        key: key(1),
        aad: buildAad({ workspaceId: "wks_1", serverId: "srv_1", kind: "oauth", keyVersion: 1 }),
      },
    );
    const tampered = buildAad({
      workspaceId: "wks_2",
      serverId: "srv_1",
      kind: "oauth",
      keyVersion: 1,
    });

    expect(() => decryptJson(encrypted, { key: key(1), aad: tampered })).toThrow(
      CredentialDecryptionError,
    );
  });

  it("fails when the ciphertext is tampered with", () => {
    const aad = buildAad({ workspaceId: "wks_1", serverId: "srv_1", kind: "oauth", keyVersion: 1 });
    const encrypted = encryptJson({ token: "secret" }, { key: key(1), aad });
    const tampered: EncryptedPayload = {
      ...encrypted,
      ciphertext: Buffer.from(randomBytes(16)).toString("base64"),
    };

    expect(() => decryptJson(tampered, { key: key(1), aad })).toThrow(CredentialDecryptionError);
  });
});

describe("buildAad field ordering (golden, locks byte compatibility)", () => {
  it("serializes the integration AAD shape in a stable field order", () => {
    const aad = buildAad({
      workspaceId: "wks_1",
      integrationId: "wint_1",
      provider: "github",
      kind: "oauth_token",
      keyVersion: 1,
    });
    expect(aad.toString("utf8")).toBe(
      '{"workspaceId":"wks_1","integrationId":"wint_1","provider":"github","kind":"oauth_token","keyVersion":1}',
    );
  });

  it("serializes the MCP AAD shape in a stable field order", () => {
    const aad = buildAad({
      workspaceId: "wks_1",
      serverId: "wmcps_1",
      kind: "bearer_token",
      keyVersion: 1,
    });
    expect(aad.toString("utf8")).toBe(
      '{"workspaceId":"wks_1","serverId":"wmcps_1","kind":"bearer_token","keyVersion":1}',
    );
  });
});

describe("legacy byte compatibility", () => {
  // Reproduce the exact AAD + cipher the pre-refactor inline implementations used,
  // then assert decryptJson reads it. Guards against any silent change to the AAD
  // construction or cipher parameters that would orphan already-stored credentials.
  it("decrypts a payload encrypted the way the legacy code did", () => {
    const context = { workspaceId: "wks_1", serverId: "wmcps_1", kind: "oauth", keyVersion: 1 };
    const legacyAad = Buffer.from(JSON.stringify(context), "utf8");

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(7), iv);
    cipher.setAAD(legacyAad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ access_token: "abc" }), "utf8"),
      cipher.final(),
    ]);
    const legacyPayload: EncryptedPayload = {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };

    expect(decryptJson(legacyPayload, { key: key(7), aad: buildAad(context) })).toEqual({
      access_token: "abc",
    });
  });
});
