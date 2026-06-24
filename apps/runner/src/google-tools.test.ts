import { buildAad, decryptJson, encryptJson } from "@opencompany/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeGoogleHostedTool, googleCredentialAad } from "./google-tools";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMock.getDb,
}));

// The runner decrypts Google integration OAuth tokens that the web app encrypted. Both sides build
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

describe("Google Drive hosted tools", () => {
  beforeEach(() => {
    dbMock.getDb.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("searches Drive files through a connected Google Drive account", async () => {
    dbMock.getDb.mockReturnValue(dbWithConnectedGoogleDriveCredential());
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: "file_123",
              name: "Roadmap",
              mimeType: "application/vnd.google-apps.document",
              webViewLink: "https://docs.google.com/document/d/file_123",
              modifiedTime: "2026-06-01T12:00:00.000Z",
              owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleHostedTool({
      name: "drive_search_files",
      args: { query: "Roadmap", maxResults: 5 },
      context: googleToolContext(),
      signal: new AbortController().signal,
    });

    expect(result.output).toMatchObject({
      files: [
        {
          id: "file_123",
          name: "Roadmap",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/file_123",
        },
      ],
    });
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.pathname).toBe("/drive/v3/files");
    expect(requestUrl.searchParams.get("pageSize")).toBe("5");
    expect(requestUrl.searchParams.get("q")).toContain("name contains 'Roadmap'");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
    });
  });

  it("updates a Google Doc with a constrained Docs batchUpdate request", async () => {
    dbMock.getDb.mockReturnValue(dbWithConnectedGoogleDriveCredential());
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          replies: [{}],
          writeControl: { requiredRevisionId: "rev_after" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleHostedTool({
      name: "drive_update_document",
      args: {
        documentId: "doc_123",
        operation: "replace_all_text",
        matchText: "old copy",
        text: "new copy",
        requiredRevisionId: "rev_before",
      },
      context: googleToolContext(),
      signal: new AbortController().signal,
    });

    expect(result.output).toMatchObject({
      documentId: "doc_123",
      operation: "replace_all_text",
      writeControl: { requiredRevisionId: "rev_after" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(url as string).pathname).toBe("/v1/documents/doc_123:batchUpdate");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer access-token",
        "Content-Type": "application/json",
      }),
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: "old copy", matchCase: false },
            replaceText: "new copy",
          },
        },
      ],
      writeControl: { requiredRevisionId: "rev_before" },
    });
  });
});

function googleToolContext() {
  return {
    workspaceId: CONTEXT.workspaceId,
    encryptionKey: KEY,
    clientId: "client-id",
    clientSecret: "client-secret",
  };
}

function dbWithConnectedGoogleDriveCredential() {
  const encryptedPayload = encryptJson(
    { access_token: "access-token", refresh_token: "refresh-token", scope: "drive" },
    {
      key: KEY,
      aad: googleCredentialAad({ ...CONTEXT, provider: "google_drive" }),
    },
  );
  return {
    select: vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: async () => [
            {
              id: CONTEXT.integrationId,
              accountEmail: "ada@example.com",
              status: "connected",
            },
          ],
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                encryptedPayload,
                encryptionKeyVersion: CONTEXT.keyVersion,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
              },
            ],
          }),
        }),
      }),
  };
}
