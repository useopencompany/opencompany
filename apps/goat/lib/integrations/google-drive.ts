import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq } from "drizzle-orm";
import {
  GoatGoogleApiRequestError,
  goatGoogleJsonRequest,
} from "@/lib/integrations/google-access-token";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type GoatGoogleDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  driveId: string | null;
  webViewLink: string | null;
  parents: string[];
  modifiedTime: string | null;
  version: string | null;
  trashed: boolean;
  canDownload: boolean;
};

export type GoatGoogleDrivePage = {
  files: GoatGoogleDriveFile[];
  nextPageToken: string | null;
};

export type GoatGoogleSharedDrive = { id: string; name: string };

type GoogleDriveAccount = {
  integrationId: string;
  userWorkosId: string;
  accountEmail: string | null;
};

export class GoatGoogleDriveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoatGoogleDriveRequestError";
  }
}

export async function loadOwnGoatGoogleDriveAccount(
  userWorkosId: string,
  integrationId: string,
): Promise<GoogleDriveAccount | null> {
  const [row] = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      accountEmail: goatIntegrations.accountEmail,
      status: goatIntegrations.status,
      workspaceId: goatIntegrations.workspaceId,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_drive"),
      ),
    )
    .limit(1);
  if (!row || row.workspaceId || row.status === "disconnected") return null;
  return {
    integrationId: row.integrationId,
    userWorkosId: row.userWorkosId,
    accountEmail: row.accountEmail,
  };
}

export async function listGoatGoogleDriveFiles(input: {
  account: GoogleDriveAccount;
  parentId?: string;
  query?: string;
  pageToken?: string;
  signal?: AbortSignal;
}): Promise<GoatGoogleDrivePage> {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("orderBy", "folder,name_natural");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,files(id,name,mimeType,driveId,webViewLink,parents,modifiedTime,version,trashed,capabilities(canDownload))",
  );
  const query: string[] = ["trashed = false"];
  query.push(`'${driveQueryLiteral(input.parentId ?? "root")}' in parents`);
  if (input.query?.trim()) {
    query.push(`name contains '${driveQueryLiteral(input.query.trim())}'`);
  }
  url.searchParams.set("q", query.join(" and "));
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);

  const data = await goatGoogleDriveJsonRequest<Record<string, unknown>>({
    account: input.account,
    url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    files: asArray(data.files).flatMap((value) => {
      const file = parseDriveFile(value);
      return file ? [file] : [];
    }),
    nextPageToken: readString(data.nextPageToken),
  };
}

export async function listGoatGoogleSharedDrives(input: {
  account: GoogleDriveAccount;
  signal?: AbortSignal;
}): Promise<GoatGoogleSharedDrive[]> {
  const drives: GoatGoogleSharedDrive[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${DRIVE_BASE}/drives`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,drives(id,name)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await goatGoogleDriveJsonRequest<Record<string, unknown>>({
      account: input.account,
      url,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    drives.push(
      ...asArray(data.drives).flatMap((value) => {
        const row = asRecord(value);
        const id = readString(row.id);
        const name = readString(row.name);
        return id && name ? [{ id, name }] : [];
      }),
    );
    pageToken = readString(data.nextPageToken);
  } while (pageToken);
  return drives;
}

export async function getGoatGoogleDriveFile(input: {
  account: GoogleDriveAccount;
  fileId: string;
  signal?: AbortSignal;
}): Promise<GoatGoogleDriveFile> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(input.fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "id,name,mimeType,driveId,webViewLink,parents,modifiedTime,version,trashed,capabilities(canDownload)",
  );
  const value = await goatGoogleDriveJsonRequest<unknown>({
    account: input.account,
    url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const file = parseDriveFile(value);
  if (!file) throw new Error("Google Drive returned an invalid file.");
  return file;
}

export async function getGoatGoogleDriveStartPageToken(input: {
  account: GoogleDriveAccount;
  driveId?: string | null;
  signal?: AbortSignal;
}) {
  const url = new URL(`${DRIVE_BASE}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  if (input.driveId) url.searchParams.set("driveId", input.driveId);
  const data = await goatGoogleDriveJsonRequest<Record<string, unknown>>({
    account: input.account,
    url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const startPageToken = readString(data.startPageToken);
  if (!startPageToken) throw new Error("Google Drive returned no start page token.");
  return startPageToken;
}

async function goatGoogleDriveJsonRequest<T>(input: {
  account: GoogleDriveAccount;
  url: URL;
  signal?: AbortSignal;
}): Promise<T> {
  try {
    return await goatGoogleJsonRequest<T>({
      account: {
        userWorkosId: input.account.userWorkosId,
        integrationId: input.account.integrationId,
        provider: "google_drive",
      },
      url: input.url,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // Callers type-match on GoatGoogleDriveRequestError to branch on status.
    if (error instanceof GoatGoogleApiRequestError) {
      throw new GoatGoogleDriveRequestError(error.message, error.status);
    }
    throw error;
  }
}

function parseDriveFile(value: unknown): GoatGoogleDriveFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = readString(row.id);
  const name = readString(row.name);
  const mimeType = readString(row.mimeType);
  if (!id || !name || !mimeType) return null;
  const capabilities =
    row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
      ? (row.capabilities as Record<string, unknown>)
      : {};
  return {
    id,
    name,
    mimeType,
    driveId: readString(row.driveId),
    webViewLink: readString(row.webViewLink),
    parents: asArray(row.parents).flatMap((parent) =>
      typeof parent === "string" && parent ? [parent] : [],
    ),
    modifiedTime: readString(row.modifiedTime),
    version: readString(row.version),
    trashed: row.trashed === true,
    canDownload: capabilities.canDownload !== false,
  };
}

function driveQueryLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
