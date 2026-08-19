import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  googleApiFetch: vi.fn(),
  extractDocumentMarkdown: vi.fn(
    async (input: { mediaType?: string }) =>
      ({ markdown: `extracted:${input.mediaType}`, truncated: false, format: "text" }) as const,
  ),
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
  extractDocumentMarkdown: mocks.extractDocumentMarkdown,
  DocumentExtractionError: class DocumentExtractionError extends Error {
    constructor(
      readonly kind: string,
      message: string,
    ) {
      super(message);
      this.name = "DocumentExtractionError";
    }
  },
}));

import { DocumentExtractionError } from "@opencompany/file-extract";
import { type GoogleDriveFileMetadata, readGoogleDriveDocument } from "./google-drive-api";

describe("Google Drive document extraction", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["application/vnd.google-apps.document", "text/markdown"],
    ["application/vnd.google-apps.presentation", "text/plain"],
    [
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ])("exports Google-native %s files as %s", async (mimeType, exportMimeType) => {
    mocks.googleApiFetch.mockResolvedValue(new Response("exported bytes"));

    const result = await readGoogleDriveDocument(context(), file({ mimeType }));

    expect(result).toMatchObject({ ok: true, extractedText: `extracted:${exportMimeType}` });
    const request = mocks.googleApiFetch.mock.calls[0]?.[0] as { url: string };
    const url = new URL(request.url);
    expect(url.pathname.endsWith("/export")).toBe(true);
    expect(url.searchParams.get("mimeType")).toBe(exportMimeType);
  });

  it.each([
    ["application/pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["text/markdown"],
    ["text/csv"],
    ["text/plain"],
  ])("downloads and extracts %s files", async (mimeType) => {
    mocks.googleApiFetch.mockResolvedValue(new Response("bytes"));

    const result = await readGoogleDriveDocument(context(), file({ mimeType }));

    expect(result).toMatchObject({ ok: true, extractedText: `extracted:${mimeType}` });
    const request = mocks.googleApiFetch.mock.calls[0]?.[0] as { url: string };
    const url = new URL(request.url);
    expect(url.searchParams.get("alt")).toBe("media");
    // The downloaded bytes are parsed with the file's own media type as the hint.
    expect(mocks.extractDocumentMarkdown.mock.calls[0]?.[0]).toMatchObject({ mediaType: mimeType });
  });

  it("maps document extraction failures to a visible terminal reason", async () => {
    mocks.googleApiFetch.mockResolvedValue(new Response("bytes"));
    mocks.extractDocumentMarkdown.mockRejectedValueOnce(
      new DocumentExtractionError(
        "image_only_pdf",
        "This PDF is scanned or image-only; OCR is not supported.",
      ),
    );

    await expect(
      readGoogleDriveDocument(context(), file({ mimeType: "application/pdf" })),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("image-only") });
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
