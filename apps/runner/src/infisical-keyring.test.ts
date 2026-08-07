import { describe, expect, it } from "vitest";
import { createInfisicalBackupKeyEntry, wrapInfisicalFileVaultKey } from "./infisical-keyring";

describe("Infisical file-vault keyring", () => {
  it("matches the RFC 3394 AES key-wrap vector", () => {
    const wrappingKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");

    expect(wrapInfisicalFileVaultKey(wrappingKey, key).toString("hex")).toBe(
      "1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5",
    );
  });

  it("creates an Infisical-compatible compact file-vault entry", async () => {
    const entry = await createInfisicalBackupKeyEntry(
      JSON.stringify({
        vaultBackendType: "file",
        vaultBackendPassphrase: Buffer.from("test-file-vault-passphrase", "utf8").toString(
          "base64",
        ),
      }),
    );
    const [encodedHeader, encodedKey, encodedIv, encodedCiphertext, encodedTag] = entry.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader as string, "base64url").toString("utf8"));

    expect(header).toMatchObject({
      alg: "PBES2-HS256+A128KW",
      enc: "A256GCM",
      p2c: 8192,
    });
    expect(Buffer.from(encodedKey as string, "base64url")).toHaveLength(40);
    expect(Buffer.from(encodedIv as string, "base64url")).toHaveLength(12);
    expect(Buffer.from(encodedCiphertext as string, "base64url").byteLength).toBeGreaterThan(0);
    expect(Buffer.from(encodedTag as string, "base64url")).toHaveLength(16);
  });

  it("rejects config that is not an encrypted file vault", async () => {
    await expect(
      createInfisicalBackupKeyEntry(JSON.stringify({ vaultBackendType: "auto" })),
    ).rejects.toThrow("Infisical file-vault config is incomplete.");
  });
});
