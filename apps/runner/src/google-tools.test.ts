import { buildAad, decryptJson, encryptJson } from "@opencompany/crypto";
import { describe, expect, it } from "vitest";
import { googleCredentialAad } from "./google-tools";

// The runner decrypts Gmail/Calendar OAuth tokens that the web app encrypted. Both sides build
// the AES-GCM additional-authenticated-data (AAD) from the same fields, in the same order — if
// they ever drift, decryption fails in production. These tests pin that contract.

const KEY = Buffer.alloc(32, 7);
const CONTEXT = {
  workspaceId: "wks_test",
  integrationId: "wint_test",
  provider: "google_calendar" as const,
  keyVersion: 1,
};

// Mirrors apps/web/lib/integrations/credential-storage.ts `authenticatedData`. Kept inline so a
// reorder on either side trips the assertions below.
function webAuthenticatedData() {
  return buildAad({
    workspaceId: CONTEXT.workspaceId,
    integrationId: CONTEXT.integrationId,
    provider: CONTEXT.provider,
    kind: "oauth_token",
    keyVersion: CONTEXT.keyVersion,
  });
}

describe("googleCredentialAad", () => {
  it("matches the web app's credential AAD byte-for-byte", () => {
    expect(googleCredentialAad(CONTEXT).equals(webAuthenticatedData())).toBe(true);
  });

  it("decrypts a payload the web app would have written", () => {
    const tokens = { access_token: "ya29.abc", refresh_token: "1//refresh", scope: "calendar" };
    const encrypted = encryptJson(tokens, { key: KEY, aad: webAuthenticatedData() });

    const decrypted = decryptJson(encrypted, { key: KEY, aad: googleCredentialAad(CONTEXT) });

    expect(decrypted).toEqual(tokens);
  });

  it("fails to decrypt when a context field differs (tamper protection)", () => {
    const encrypted = encryptJson({ access_token: "x" }, { key: KEY, aad: webAuthenticatedData() });
    const wrongAad = googleCredentialAad({ ...CONTEXT, workspaceId: "wks_other" });

    expect(() => decryptJson(encrypted, { key: KEY, aad: wrongAad })).toThrow();
  });
});
