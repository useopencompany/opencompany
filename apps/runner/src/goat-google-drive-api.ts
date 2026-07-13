import { createHash } from "node:crypto";
import { extractDocxText, extractXlsxText } from "@opencompany/file-extract";
import type { RunnerEnv } from "./env";
import {
  type GoogleApiAccount,
  GoogleApiRequestError,
  googleApiCall,
  googleApiFetch,
} from "./google-api-auth";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200_000;
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const PDF_MIME_TYPE = "application/pdf";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "driveId",
  "webViewLink",
  "parents",
  "modifiedTime",
  "version",
  "trashed",
  "capabilities(canDownload)",
  "owners(displayName,emailAddress)",
  "lastModifyingUser(displayName,emailAddress)",
].join(",");

export type GoogleDriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  driveId: string | null;
  webViewLink: string | null;
  parents: string[];
  modifiedTime: string;
  version: string;
  trashed: boolean;
  canDownload: boolean;
  owners: string[];
  lastModifyingUser: string | null;
};

export type GoogleDriveApiContext = {
  env: RunnerEnv;
  userWorkosId: string;
  account: GoogleApiAccount;
  signal: AbortSignal;
};

export async function getGoogleDriveStartPageToken(
  context: GoogleDriveApiContext,
  driveId: string | null,
) {
  const url = new URL(`${DRIVE_BASE}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  if (driveId) url.searchParams.set("driveId", driveId);
  const data = asRecord(await callJson(context, "GET", url));
  const token = readString(data.startPageToken);
  if (!token) throw new Error("Google Drive returned no start page token.");
  return token;
}

export async function listGoogleDriveChanges(
  context: GoogleDriveApiContext,
  input: { pageToken: string; driveId: string | null },
) {
  const url = new URL(`${DRIVE_BASE}/changes`);
  url.searchParams.set("pageToken", input.pageToken);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    `nextPageToken,newStartPageToken,changes(fileId,removed,time,driveId,file(${FILE_FIELDS}))`,
  );
  if (input.driveId) url.searchParams.set("driveId", input.driveId);
  const data = asRecord(await callJson(context, "GET", url));
  return {
    nextPageToken: readString(data.nextPageToken),
    newStartPageToken: readString(data.newStartPageToken),
    changes: asArray(data.changes).flatMap((value) => {
      const row = asRecord(value);
      const fileId = readString(row.fileId);
      if (!fileId) return [];
      return [
        {
          fileId,
          removed: row.removed === true,
          time: readString(row.time),
          driveId: readString(row.driveId),
          file: parseGoogleDriveFile(row.file),
        },
      ];
    }),
  };
}

export async function watchGoogleDriveChanges(
  context: GoogleDriveApiContext,
  input: {
    pageToken: string;
    driveId: string | null;
    channelId: string;
    channelToken: string;
    address: string;
    expiresAt: Date;
  },
) {
  const url = new URL(`${DRIVE_BASE}/changes/watch`);
  url.searchParams.set("pageToken", input.pageToken);
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  if (input.driveId) url.searchParams.set("driveId", input.driveId);
  const data = asRecord(
    await googleApiCall({
      ...context,
      method: "POST",
      url: url.toString(),
      body: {
        id: input.channelId,
        type: "web_hook",
        address: input.address,
        token: input.channelToken,
        expiration: input.expiresAt.getTime().toString(),
      },
    }),
  );
  const resourceId = readString(data.resourceId);
  if (!resourceId) throw new Error("Google Drive watch returned no resource id.");
  const expiration = Number(readString(data.expiration));
  return {
    resourceId,
    expiresAt: Number.isFinite(expiration) ? new Date(expiration) : input.expiresAt,
  };
}

export async function stopGoogleDriveChannel(
  context: GoogleDriveApiContext,
  input: { channelId: string; resourceId: string },
) {
  await googleApiCall({
    ...context,
    method: "POST",
    url: `${DRIVE_BASE}/channels/stop`,
    body: { id: input.channelId, resourceId: input.resourceId },
  });
}

export async function getGoogleDriveFileMetadata(context: GoogleDriveApiContext, fileId: string) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", FILE_FIELDS);
  const file = parseGoogleDriveFile(await callJson(context, "GET", url));
  if (!file) throw new Error("Google Drive returned invalid file metadata.");
  return file;
}

export async function listGoogleDriveFolderChildren(
  context: GoogleDriveApiContext,
  folderId: string,
) {
  const files: GoogleDriveFileMetadata[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set("q", `'${driveQueryLiteral(folderId)}' in parents and trashed = false`);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = asRecord(await callJson(context, "GET", url));
    files.push(...asArray(data.files).flatMap((file) => parseGoogleDriveFile(file) ?? []));
    pageToken = readString(data.nextPageToken);
  } while (pageToken);
  return files;
}

export async function readGoogleDriveDocument(
  context: GoogleDriveApiContext,
  file: GoogleDriveFileMetadata,
) {
  const mode = readMode(file.mimeType);
  if (!mode) {
    return { ok: false as const, reason: `Unsupported Google Drive file type: ${file.mimeType}.` };
  }
  if (!file.canDownload) {
    return {
      ok: false as const,
      reason: "Google Drive does not allow this file to be downloaded.",
    };
  }
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}`);
  if (mode.exportMimeType) {
    url.pathname += "/export";
    url.searchParams.set("mimeType", mode.exportMimeType);
  } else {
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
  }
  const response = await googleApiFetch({
    ...context,
    method: "GET",
    url: url.toString(),
  });
  if (!response.ok) {
    if (response.status === 403) {
      const detail = await response.text();
      if (/rateLimitExceeded|userRateLimitExceeded|backendError/i.test(detail)) {
        throw new GoogleApiRequestError("Google Drive content request was rate limited.", 403);
      }
      return { ok: false as const, reason: "Google Drive no longer permits this file to be read." };
    }
    throw new Error(`Google Drive content request failed with ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false as const, reason: "Google Drive file exceeds the 20 MB ingestion limit." };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false as const, reason: "Google Drive file exceeds the 20 MB ingestion limit." };
  }
  const extractedText = capUtf8(await mode.extract(bytes), MAX_EXTRACTED_BYTES);
  return {
    ok: true as const,
    extractedText,
    contentSha256: createHash("sha256").update(extractedText, "utf8").digest("hex"),
  };
}

function readMode(
  mimeType: string,
): { exportMimeType: string | null; extract(bytes: Buffer): Promise<string> } | null {
  if (mimeType === GOOGLE_DOC_MIME_TYPE) return textMode("text/markdown");
  if (mimeType === GOOGLE_SHEET_MIME_TYPE) {
    return { exportMimeType: XLSX_MIME_TYPE, extract: (bytes) => extractXlsxText(bytes) };
  }
  if (mimeType === GOOGLE_SLIDES_MIME_TYPE) return textMode("text/plain");
  if (mimeType === PDF_MIME_TYPE) {
    return { exportMimeType: null, extract: extractPdfText };
  }
  if (mimeType === DOCX_MIME_TYPE) {
    return { exportMimeType: null, extract: (bytes) => extractDocxText(bytes) };
  }
  if (mimeType === XLSX_MIME_TYPE) {
    return { exportMimeType: null, extract: (bytes) => extractXlsxText(bytes) };
  }
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/csv" ||
    mimeType === "application/json"
  ) {
    return textMode(null);
  }
  return null;
}

function textMode(exportMimeType: string | null) {
  return { exportMimeType, extract: async (bytes: Buffer) => bytes.toString("utf8").trim() };
}

async function extractPdfText(bytes: Buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === "string" ? text.trim() : "";
}

async function callJson(context: GoogleDriveApiContext, method: string, url: URL) {
  return googleApiCall({ ...context, method, url: url.toString() });
}

function parseGoogleDriveFile(value: unknown): GoogleDriveFileMetadata | null {
  const row = asRecord(value);
  const id = readString(row.id);
  const name = readString(row.name);
  const mimeType = readString(row.mimeType);
  const modifiedTime = readString(row.modifiedTime);
  const version = readString(row.version);
  if (!id || !name || !mimeType || !modifiedTime || !version) return null;
  const capabilities = asRecord(row.capabilities);
  return {
    id,
    name,
    mimeType,
    driveId: readString(row.driveId),
    webViewLink: readString(row.webViewLink),
    parents: asArray(row.parents).flatMap((parent) =>
      typeof parent === "string" && parent ? [parent] : [],
    ),
    modifiedTime,
    version,
    trashed: row.trashed === true,
    canDownload: capabilities.canDownload !== false,
    owners: asArray(row.owners).flatMap((owner) => {
      const person = asRecord(owner);
      const label = readPerson(person);
      return label ? [label] : [];
    }),
    lastModifyingUser: readPerson(asRecord(row.lastModifyingUser)),
  };
}

function readPerson(value: Record<string, unknown>) {
  const name = readString(value.displayName);
  const email = readString(value.emailAddress);
  if (name && email) return `${name} <${email}>`;
  return name ?? email;
}

function capUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "")}\n… truncated`;
}

function driveQueryLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
