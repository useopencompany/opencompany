import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  googleApiFetch: vi.fn(),
  extractDocxText: vi.fn(async () => "docx text"),
  extractXlsxText: vi.fn(async () => "sheet one\nsheet two"),
  getDocumentProxy: vi.fn(async () => ({})),
  extractPdfText: vi.fn(async () => ({ text: "pdf text" })),
}));

vi.mock("./google-api-auth", () => ({
  GoogleApiRequestError: class GoogleApiRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  googleApiCall: vi.fn(),
  googleApiFetch: mocks.googleApiFetch,
}));

vi.mock("@opencompany/file-extract", () => ({
  extractDocxText: mocks.extractDocxText,
  extractXlsxText: mocks.extractXlsxText,
}));

vi.mock("unpdf", () => ({
  getDocumentProxy: mocks.getDocumentProxy,
  extractText: mocks.extractPdfText,
}));

import { type GoogleDriveFileMetadata, readGoogleDriveDocument } from "./google-drive-api";

describe("Google Drive document extraction", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["application/vnd.google-apps.document", "text/markdown", "markdown text"],
    ["application/vnd.google-apps.presentation", "text/plain", "slide text"],
    [
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sheet one\nsheet two",
    ],
  ])("exports Google-native %s files", async (mimeType, exportMimeType, expectedText) => {
    mocks.googleApiFetch.mockResolvedValue(
      new Response(mimeType.includes("spreadsheet") ? "xlsx bytes" : expectedText),
    );

    const result = await readGoogleDriveDocument(context(), file({ mimeType }));

    expect(result).toMatchObject({ ok: true, extractedText: expectedText });
    const request = mocks.googleApiFetch.mock.calls[0]?.[0] as { url: string };
    const url = new URL(request.url);
    expect(url.pathname.endsWith("/export")).toBe(true);
    expect(url.searchParams.get("mimeType")).toBe(exportMimeType);
  });

  it.each([
    ["application/pdf", "pdf text"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx text"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet one\nsheet two"],
    ["text/markdown", "plain text"],
    ["text/csv", "plain text"],
    ["text/plain", "plain text"],
  ])("downloads and extracts %s files", async (mimeType, expectedText) => {
    mocks.googleApiFetch.mockResolvedValue(new Response("plain text"));

    const result = await readGoogleDriveDocument(context(), file({ mimeType }));

    expect(result).toMatchObject({ ok: true, extractedText: expectedText });
    const request = mocks.googleApiFetch.mock.calls[0]?.[0] as { url: string };
    const url = new URL(request.url);
    expect(url.searchParams.get("alt")).toBe("media");
  });

  it("returns visible terminal reasons for unsupported, non-downloadable, and oversized files", async () => {
    await expect(
      readGoogleDriveDocument(context(), file({ mimeType: "image/png" })),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("Unsupported") });
    await expect(
      readGoogleDriveDocument(context(), file({ canDownload: false })),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("does not allow") });

    mocks.googleApiFetch.mockResolvedValue(
      new Response("small", { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }),
    );
    await expect(readGoogleDriveDocument(context(), file())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("20 MB"),
    });
  });

  it("retries rate-limit-shaped 403 responses instead of marking them permanently inaccessible", async () => {
    mocks.googleApiFetch.mockResolvedValue(
      new Response('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', {
        status: 403,
      }),
    );

    await expect(readGoogleDriveDocument(context(), file())).rejects.toMatchObject({ status: 403 });
  });
});

function context() {
  return {
    env: {} as never,
    userWorkosId: "user_1",
    account: {
      integrationId: "integration_1",
      provider: "google_drive" as const,
      accountEmail: "person@example.com",
    },
    signal: new AbortController().signal,
  };
}

function file(overrides: Partial<GoogleDriveFileMetadata> = {}): GoogleDriveFileMetadata {
  return {
    id: "file_1",
    name: "Document",
    mimeType: "text/plain",
    driveId: null,
    webViewLink: "https://drive.google.com/file/d/file_1/view",
    parents: ["root"],
    modifiedTime: "2026-07-13T08:00:00.000Z",
    version: "2",
    trashed: false,
    canDownload: true,
    owners: [],
    lastModifyingUser: null,
    ...overrides,
  };
}
