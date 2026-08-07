import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  refreshIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const REFRESH_SKEW_MS = 60_000;
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type GoogleDriveFile = {
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

export type GoogleDrivePage = {
  files: GoogleDriveFile[];
  nextPageToken: string | null;
};

export type GoogleSharedDrive = { id: string; name: string };

type GoogleDriveAccount = {
  integrationId: string;
  userWorkosId: string;
  accountEmail: string | null;
};

type StoredTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export class GoogleDriveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleDriveRequestError";
  }
}

export async function loadOwnGoogleDriveAccount(
  userWorkosId: string,
  integrationId: string,
): Promise<GoogleDriveAccount | null> {
  const [row] = await getDb()
    .select({
      integrationId: integrations.id,
      userWorkosId: integrations.userWorkosId,
      accountEmail: integrations.accountEmail,
      status: integrations.status,
      workspaceId: integrations.workspaceId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "google_drive"),
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

export async function listGoogleDriveFiles(input: {
  account: GoogleDriveAccount;
  parentId?: string;
  query?: string;
  pageToken?: string;
  signal?: AbortSignal;
}): Promise<GoogleDrivePage> {
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

  const data = await googleDriveJsonRequest<Record<string, unknown>>({
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

export async function listGoogleSharedDrives(input: {
  account: GoogleDriveAccount;
  signal?: AbortSignal;
}): Promise<GoogleSharedDrive[]> {
  const drives: GoogleSharedDrive[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${DRIVE_BASE}/drives`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,drives(id,name)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleDriveJsonRequest<Record<string, unknown>>({
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

export async function getGoogleDriveFile(input: {
  account: GoogleDriveAccount;
  fileId: string;
  signal?: AbortSignal;
}): Promise<GoogleDriveFile> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(input.fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "id,name,mimeType,driveId,webViewLink,parents,modifiedTime,version,trashed,capabilities(canDownload)",
  );
  const value = await googleDriveJsonRequest<unknown>({
    account: input.account,
    url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const file = parseDriveFile(value);
  if (!file) throw new Error("Google Drive returned an invalid file.");
  return file;
}

export async function getGoogleDriveStartPageToken(input: {
  account: GoogleDriveAccount;
  driveId?: string | null;
  signal?: AbortSignal;
}) {
  const url = new URL(`${DRIVE_BASE}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  if (input.driveId) url.searchParams.set("driveId", input.driveId);
  const data = await googleDriveJsonRequest<Record<string, unknown>>({
    account: input.account,
    url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const startPageToken = readString(data.startPageToken);
  if (!startPageToken) throw new Error("Google Drive returned no start page token.");
  return startPageToken;
}

async function googleDriveJsonRequest<T>(input: {
  account: GoogleDriveAccount;
  url: URL;
  signal?: AbortSignal;
}): Promise<T> {
  const run = async (accessToken: string) =>
    fetch(input.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  let accessToken = await getGoogleDriveAccessToken(input.account, input.signal);
  let response = await run(accessToken);
  if (response.status === 401) {
    accessToken = await getGoogleDriveAccessToken(input.account, input.signal, true);
    response = await run(accessToken);
  }
  if (!response.ok) {
    throw new GoogleDriveRequestError(
      `Google Drive API request failed with ${response.status}.`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function getGoogleDriveAccessToken(
  account: GoogleDriveAccount,
  signal?: AbortSignal,
  forceRefresh = false,
) {
  const credential = await loadIntegrationCredential({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: "google_drive",
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) throw new Error("Reconnect Google Drive in Settings.");
  const tokens = credential.payload as StoredTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markNeedsReauth(account, "Stored Google Drive credentials have no refresh token.");
    throw new Error("Reconnect Google Drive in Settings.");
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    ...(signal ? { signal } : {}),
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markNeedsReauth(account, "Google refused the refresh token.");
      throw new Error("Reconnect Google Drive in Settings.");
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }
  const result = (await response.json()) as StoredTokens & { expires_in?: number };
  if (!result.access_token) throw new Error("Google token refresh returned no access token.");
  const nextTokens = {
    access_token: result.access_token,
    refresh_token: result.refresh_token ?? tokens.refresh_token,
    scope: result.scope ?? tokens.scope,
    token_type: result.token_type ?? tokens.token_type,
  };
  await refreshIntegrationCredential({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: "google_drive",
    kind: "oauth_token",
    payload: Object.fromEntries(
      Object.entries(nextTokens).filter(([, value]) => value !== undefined),
    ),
    expiresAt:
      typeof result.expires_in === "number"
        ? new Date(Date.now() + result.expires_in * 1000)
        : null,
    db: getDb(),
  });
  return result.access_token;
}

async function markNeedsReauth(account: GoogleDriveAccount, reason: string) {
  await markIntegrationStatus({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: "google_drive",
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

function parseDriveFile(value: unknown): GoogleDriveFile | null {
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
