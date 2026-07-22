import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
  truncateText,
} from "@/lib/actions/types";
import { GoogleAccessAuthError, googleApiCall } from "@/lib/integrations/google-access-token";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 25;
const MAX_QUERY_CHARS = 200;
const MAX_FILE_NAME_CHARS = 300;

type GoogleDriveConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
};

export async function resolveGoogleDriveActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await loadGoogleDriveConnections(userWorkosId);
  if (connections.length === 0) return null;

  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            maxLength: 200,
            description: `Which connected Google Drive account to use. One of: ${connections
              .map((connection) => JSON.stringify(accountSelector(connection, connections)))
              .join(", ")}.`,
          },
        }
      : {};

  const actions: ResolvedGoatAction[] = [
    {
      id: "google_drive.search_files",
      provider: "google_drive",
      description:
        "Search the user's Google Drive, including shared files and shared drives, by file name or indexed text. Returns compact file metadata and links, not file contents.",
      params: {
        type: "object",
        additionalProperties: false,
        required: connections.length > 1 ? ["query", "account"] : ["query"],
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "Words from the file name or indexed file text to find.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_RESULTS,
            description: `Max files to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).`,
          },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const hasMultipleAccounts = connections.length > 1;
        assertOnlyKnownParams(params, hasMultipleAccounts);
        const account = hasMultipleAccounts ? optionalStringParam(params, "account") : undefined;
        if (account && account.length > 200) {
          throw new GoatActionInvalidParamsError('"account" must be at most 200 characters.');
        }
        const connection = resolveConnection(connections, account);
        const query = requiredStringParam(params, "query");
        if (query.length > MAX_QUERY_CHARS) {
          throw new GoatActionInvalidParamsError(
            `"query" must be at most ${MAX_QUERY_CHARS} characters.`,
          );
        }
        const requestedLimit = optionalNumberParam(params, "limit");
        if (
          requestedLimit !== undefined &&
          (!Number.isInteger(requestedLimit) ||
            requestedLimit < 1 ||
            requestedLimit > MAX_SEARCH_RESULTS)
        ) {
          throw new GoatActionInvalidParamsError(
            `"limit" must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`,
          );
        }
        const limit = requestedLimit ?? DEFAULT_SEARCH_RESULTS;

        const url = new URL(DRIVE_FILES_URL);
        url.searchParams.set("pageSize", String(limit));
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        url.searchParams.set(
          "fields",
          "nextPageToken,files(id,name,mimeType,driveId,webViewLink,modifiedTime)",
        );
        url.searchParams.set(
          "q",
          `trashed = false and fullText contains '${driveQueryLiteral(query)}'`,
        );

        const response = await googleDriveApiCall(context, connection, url);
        const body = asRecord(response);
        const rawFiles = asArray(body.files);
        return {
          account: connectionLabel(connection),
          query,
          files: rawFiles.slice(0, limit).flatMap((value) => {
            const file = compactDriveFile(value);
            return file ? [file] : [];
          }),
          moreAvailable: rawFiles.length > limit || Boolean(readString(body.nextPageToken, 4_096)),
        };
      },
    },
  ];

  return {
    id: "google_drive",
    label:
      connections.length === 1
        ? `Google Drive (${connectionLabel(connections[0]!)})`
        : `Google Drive (${connections.length} accounts)`,
    description: "Search connected Google Drive files.",
    actions,
  };
}

async function loadGoogleDriveConnections(userWorkosId: string): Promise<GoogleDriveConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_drive"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  return rows
    .filter((row) => row.status === "connected")
    .map((row) => ({
      integrationId: row.integrationId,
      accountEmail: row.accountEmail,
      accountName: row.accountName,
    }));
}

function resolveConnection(
  connections: readonly GoogleDriveConnection[],
  account: string | undefined,
): GoogleDriveConnection {
  if (account) {
    const wanted = account.toLowerCase();
    const match = connections.find(
      (entry) => accountSelector(entry, connections).toLowerCase() === wanted,
    );
    if (!match) {
      throw new GoatActionInvalidParamsError(
        `No connected Google Drive account matches ${JSON.stringify(account)}. Connected accounts: ${connections
          .map((entry) => JSON.stringify(accountSelector(entry, connections)))
          .join(", ")}.`,
      );
    }
    return match;
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple Google Drive accounts are connected; pass account as one of: ${connections
      .map((entry) => JSON.stringify(accountSelector(entry, connections)))
      .join(", ")}.`,
  );
}

function connectionLabel(connection: GoogleDriveConnection) {
  const label = connection.accountEmail?.trim() || connection.accountName?.trim();
  if (!label) return "Google account";
  const normalized = label.replace(/\s+/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}

function accountSelector(
  connection: GoogleDriveConnection,
  connections: readonly GoogleDriveConnection[],
) {
  const label = connectionLabel(connection);
  const duplicateLabel = connections.some(
    (entry) => entry !== connection && connectionLabel(entry).toLowerCase() === label.toLowerCase(),
  );
  return duplicateLabel ? `${label} (${connection.integrationId})` : label;
}

async function googleDriveApiCall(
  context: GoatActionExecuteContext,
  connection: GoogleDriveConnection,
  url: URL,
) {
  try {
    return await googleApiCall(
      {
        userWorkosId: context.userWorkosId,
        integrationId: connection.integrationId,
        provider: "google_drive",
      },
      "GET",
      url,
      { signal: context.signal },
    );
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      throw new GoatActionAuthError(
        "auth_expired",
        "google_drive",
        `Reconnect Google Drive for ${connectionLabel(connection)} in Settings → Integrations, then retry.`,
      );
    }
    throw error;
  }
}

function assertOnlyKnownParams(params: Record<string, unknown>, allowAccount: boolean) {
  const unknown = Object.keys(params).filter(
    (key) => key !== "query" && key !== "limit" && !(allowAccount && key === "account"),
  );
  if (unknown.length > 0) {
    throw new GoatActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
    );
  }
}

function compactDriveFile(value: unknown) {
  const file = asRecord(value);
  const id = readString(file.id, 512);
  const name = readString(file.name, 32_768);
  const mimeType = readString(file.mimeType, 200);
  if (!id || !name || !mimeType) return null;
  const webViewLink = readGoogleUrl(file.webViewLink);
  const modifiedTime = readString(file.modifiedTime, 100);
  const driveId = readString(file.driveId, 512);
  return {
    id,
    name: truncateText(name, MAX_FILE_NAME_CHARS),
    mimeType,
    ...(modifiedTime ? { modifiedTime } : {}),
    ...(driveId ? { driveId } : {}),
    ...(webViewLink ? { webViewLink } : {}),
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

function readString(value: unknown, maxChars: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars ? value : null;
}

function readGoogleUrl(value: unknown) {
  const candidate = readString(value, 2_048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".google.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
