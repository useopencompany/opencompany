import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { isValidGoatBrainSourceRef } from "@opencompany/goat-brain";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  effectiveCapabilityMode,
  type GoatCapabilityId,
  providerCapability,
} from "@/lib/actions/capabilities";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
  truncateText,
} from "@/lib/actions/types";
import { GoogleAccessAuthError, googleApiCall } from "@/lib/integrations/google-access-token";
import { hasGoatGoogleDriveWriteScope } from "@/lib/integrations/google-drive-scopes";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DOCS_URL = "https://docs.googleapis.com/v1/documents";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 25;
const MAX_QUERY_CHARS = 200;
const MAX_FILE_ID_CHARS = 512;
const MAX_FILE_NAME_CHARS = 300;
const MAX_ACCOUNT_CHARS = 400;
const MAX_DOCUMENT_TEXT_CHARS = 40_000;
const MAX_FIND_TEXT_CHARS = 20_000;
const MAX_REPLACEMENT_TEXT_CHARS = 100_000;

type GoogleDriveConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
  scopes: string[];
  capabilityModes: unknown;
};

export async function resolveGoogleDriveActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const allConnections = await loadGoogleDriveConnections(userWorkosId);
  if (allConnections.length === 0) return null;

  const readConnections = eligibleConnections(allConnections, "read");
  const writeConnections = eligibleConnections(allConnections, "write").filter((connection) =>
    hasGoatGoogleDriveWriteScope(connection.scopes),
  );
  if (readConnections.length === 0 && writeConnections.length === 0) return null;

  const actions: ResolvedGoatAction[] = [];
  if (readConnections.length > 0) {
    actions.push(searchFilesAction(readConnections), getDocumentAction(readConnections));
  }
  if (writeConnections.length > 0) {
    actions.push(replaceDocumentTextAction(writeConnections));
  }

  const labelConnections = readConnections.length > 0 ? readConnections : writeConnections;
  return {
    id: "google_drive",
    label:
      labelConnections.length === 1
        ? `Google Drive (${connectionLabel(labelConnections[0]!)})`
        : `Google Drive (${labelConnections.length} accounts)`,
    description:
      readConnections.length > 0 && writeConnections.length > 0
        ? "Find Drive files, read Google Docs, and replace text in Google Docs."
        : readConnections.length > 0
          ? "Find Drive files and read Google Docs."
          : "Replace text in Google Docs.",
    actions,
  };
}

function eligibleConnections(
  connections: readonly GoogleDriveConnection[],
  capabilityId: GoatCapabilityId,
) {
  return connections.filter(
    (connection) =>
      effectiveCapabilityMode("google_drive", capabilityId, connection.capabilityModes) !== "off",
  );
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  connections: readonly GoogleDriveConnection[],
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  const askIntegrationIds = connections
    .filter(
      (connection) =>
        effectiveCapabilityMode("google_drive", capabilityId, connection.capabilityModes) === "ask",
    )
    .map((connection) => connection.integrationId);
  if (askIntegrationIds.length === 0) return { permissionMode: "on" };
  return {
    permissionMode: "ask",
    permission: {
      provider: "google_drive",
      capabilityId,
      label: providerCapability("google_drive", capabilityId)?.label ?? capabilityId,
      integrationIds: askIntegrationIds,
    },
  };
}

function searchFilesAction(connections: readonly GoogleDriveConnection[]): ResolvedGoatAction {
  const accountParam = accountParamSchema(connections);
  const required = ["query"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.search_files",
    provider: "google_drive",
    capability: "read",
    ...permissionAnnotation("read", connections),
    description:
      "Search Google Drive, including shared files and shared drives, by file name or indexed text. Returns compact file metadata and links; use google_drive.get_document to read a Google Doc.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
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
      assertOnlyKnownParams(params, ["query", "limit"], hasMultipleAccounts);
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const query = requiredBoundedString(params, "query", MAX_QUERY_CHARS);
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
        "nextPageToken,files(id,name,mimeType,driveId,webViewLink,modifiedTime,capabilities(canDownload))",
      );
      url.searchParams.set(
        "q",
        `trashed = false and fullText contains '${driveQueryLiteral(query)}'`,
      );

      const body = asRecord(await googleDriveApiCall(context, connection, "GET", url));
      const rawFiles = asArray(body.files);
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        query,
        files: rawFiles.slice(0, limit).flatMap((value) => {
          const file = compactDriveFile(value, connection.integrationId);
          return file ? [file] : [];
        }),
        moreAvailable: rawFiles.length > limit || Boolean(readString(body.nextPageToken, 4_096)),
      };
    },
  };
}

function getDocumentAction(connections: readonly GoogleDriveConnection[]): ResolvedGoatAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.get_document",
    provider: "google_drive",
    capability: "read",
    ...permissionAnnotation("read", connections),
    description:
      "Read the current text of a Google Doc by its Drive file id. Returns text across all document tabs plus the current revision id. Use the revision id when replacing text.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FILE_ID_CHARS,
          description:
            "Google Drive file id for a Google Doc, usually returned by google_drive.search_files.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(params, ["file_id"], hasMultipleAccounts);
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const fileId = requiredBoundedString(params, "file_id", MAX_FILE_ID_CHARS);
      const url = new URL(`${GOOGLE_DOCS_URL}/${encodeURIComponent(fileId)}`);
      url.searchParams.set("includeTabsContent", "true");
      const document = asRecord(await googleDriveApiCall(context, connection, "GET", url));
      const documentId = readString(document.documentId, MAX_FILE_ID_CHARS);
      if (!documentId) throw new Error("Google Docs did not return a valid document.");

      const title =
        truncateText(
          readString(document.title, 32_768) ?? "Untitled document",
          MAX_FILE_NAME_CHARS,
        ) ?? "Untitled document";
      const revisionId = readString(document.revisionId, 2_048);
      const fullText = documentText(document);
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        document: {
          id: documentId,
          title,
          mimeType: GOOGLE_DOC_MIME_TYPE,
          sourceRef: driveFileSourceRef(documentId),
          url: googleDocUrl(documentId),
          ...(revisionId ? { revisionId } : {}),
          text: truncateText(fullText, MAX_DOCUMENT_TEXT_CHARS),
          truncated: fullText.length > MAX_DOCUMENT_TEXT_CHARS,
        },
      };
    },
  };
}

function replaceDocumentTextAction(
  connections: readonly GoogleDriveConnection[],
): ResolvedGoatAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id", "find", "replace"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.replace_document_text",
    provider: "google_drive",
    capability: "write",
    ...permissionAnnotation("write", connections),
    description:
      "Replace every exact occurrence of text across all tabs of an existing Google Doc. Use only when the user explicitly asked to edit that document. Pass revision_id from google_drive.get_document when available so a concurrent edit fails instead of being overwritten.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FILE_ID_CHARS,
          description: "Google Drive file id for the Google Doc to edit.",
        },
        find: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FIND_TEXT_CHARS,
          description:
            "Exact text to find. Every occurrence across every document tab is replaced.",
        },
        replace: {
          type: "string",
          maxLength: MAX_REPLACEMENT_TEXT_CHARS,
          description: "Replacement text. Pass an empty string to delete the matched text.",
        },
        match_case: {
          type: "boolean",
          description: "Whether capitalization must match exactly. Defaults to true.",
        },
        revision_id: {
          type: "string",
          minLength: 1,
          maxLength: 2_048,
          description:
            "Optional current revision id from google_drive.get_document. The edit fails if the document changed since it was read.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(
        params,
        ["file_id", "find", "replace", "match_case", "revision_id"],
        hasMultipleAccounts,
      );
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const fileId = requiredBoundedString(params, "file_id", MAX_FILE_ID_CHARS);
      const find = requiredExactText(params, "find", MAX_FIND_TEXT_CHARS);
      const replace = replacementText(params, MAX_REPLACEMENT_TEXT_CHARS);
      const matchCase = optionalBooleanParam(params, "match_case") ?? true;
      const revisionId = boundedOptionalString(params, "revision_id", 2_048);

      await assertWriteStillEnabled(context.userWorkosId, connection);

      const url = new URL(`${GOOGLE_DOCS_URL}/${encodeURIComponent(fileId)}:batchUpdate`);
      const response = asRecord(
        await googleDriveApiCall(context, connection, "POST", url, {
          requests: [
            {
              replaceAllText: {
                containsText: { text: find, matchCase },
                replaceText: replace,
              },
            },
          ],
          ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}),
        }),
      );
      const documentId = readString(response.documentId, MAX_FILE_ID_CHARS);
      if (!documentId) throw new Error("Google Docs did not confirm the document edit.");
      const reply = asRecord(asArray(response.replies)[0]);
      const replaceReply = asRecord(reply.replaceAllText);
      const occurrencesChanged =
        typeof replaceReply.occurrencesChanged === "number" &&
        Number.isSafeInteger(replaceReply.occurrencesChanged) &&
        replaceReply.occurrencesChanged >= 0
          ? replaceReply.occurrencesChanged
          : null;
      const nextRevisionId = readString(asRecord(response.writeControl).requiredRevisionId, 2_048);

      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        document: {
          id: documentId,
          sourceRef: driveFileSourceRef(documentId),
          url: googleDocUrl(documentId),
          ...(occurrencesChanged !== null ? { occurrencesChanged } : {}),
          ...(nextRevisionId ? { revisionId: nextRevisionId } : {}),
        },
      };
    },
  };
}

function accountParamSchema(connections: readonly GoogleDriveConnection[]) {
  return connections.length > 1
    ? {
        account: {
          type: "string" as const,
          minLength: 1,
          maxLength: MAX_ACCOUNT_CHARS,
          description: `Which connected Google Drive account to use. One of: ${connections
            .map((connection) => JSON.stringify(accountSelector(connection, connections)))
            .join(", ")}.`,
        },
      }
    : {};
}

async function assertWriteStillEnabled(userWorkosId: string, connection: GoogleDriveConnection) {
  const rows = await getDb()
    .select({
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_drive"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "connected" || !hasGoatGoogleDriveWriteScope(row.scopes)) {
    throw new GoatActionAuthError(
      "auth_expired",
      "google_drive",
      `Reconnect Google Drive for ${connectionLabel(connection)} in Settings → Integrations to enable Google Docs editing, then retry.`,
    );
  }
  if (effectiveCapabilityMode("google_drive", "write", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "google_drive",
      `Editing Google Docs is turned off for ${connectionLabel(connection)}. It can be changed under Settings → Integrations.`,
    );
  }
}

async function loadGoogleDriveConnections(userWorkosId: string): Promise<GoogleDriveConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_drive"),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  return rows
    .filter((row) => row.status === "connected")
    .map((row) => ({
      integrationId: row.integrationId,
      accountEmail: row.accountEmail,
      accountName: row.accountName,
      scopes: row.scopes,
      capabilityModes: row.capabilityModes,
    }));
}

function resolveConnection(
  connections: readonly GoogleDriveConnection[],
  account: string | undefined,
): GoogleDriveConnection {
  if (account) {
    const wanted = normalizeAccountSelector(account);
    const match = connections.find(
      (connection) => normalizeAccountSelector(accountSelector(connection, connections)) === wanted,
    );
    if (match) return match;
    throw new GoatActionInvalidParamsError(
      `No connected Google Drive account matches ${JSON.stringify(account)}. Connected accounts: ${connections
        .map((connection) => JSON.stringify(accountSelector(connection, connections)))
        .join(", ")}.`,
    );
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple Google Drive accounts are connected; pass account as one of: ${connections
      .map((connection) => JSON.stringify(accountSelector(connection, connections)))
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

function normalizeAccountSelector(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function googleDriveApiCall(
  context: GoatActionExecuteContext,
  connection: GoogleDriveConnection,
  method: "GET" | "POST",
  url: URL,
  body?: unknown,
) {
  try {
    return await googleApiCall(
      {
        userWorkosId: context.userWorkosId,
        integrationId: connection.integrationId,
        provider: "google_drive",
      },
      method,
      url,
      { signal: context.signal, ...(body !== undefined ? { body } : {}) },
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

function assertOnlyKnownParams(
  params: Record<string, unknown>,
  allowedKeys: readonly string[],
  allowAccount: boolean,
) {
  const unknown = Object.keys(params).filter(
    (key) => !allowedKeys.includes(key) && !(allowAccount && key === "account"),
  );
  if (unknown.length > 0) {
    throw new GoatActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
    );
  }
}

function requiredBoundedString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = requiredStringParam(params, key);
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function boundedOptionalString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = optionalStringParam(params, key);
  if (value && value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function requiredExactText(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new GoatActionInvalidParamsError(`"${key}" is required and must be a non-empty string.`);
  }
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function replacementText(params: Record<string, unknown>, maxChars: number) {
  const value = params.replace;
  if (typeof value !== "string") {
    throw new GoatActionInvalidParamsError('"replace" is required and must be a string.');
  }
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"replace" must be at most ${maxChars} characters.`);
  }
  return value;
}

function optionalBooleanParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a boolean.`);
  }
  return value;
}

function compactDriveFile(value: unknown, integrationId: string) {
  const file = asRecord(value);
  const id = readString(file.id, MAX_FILE_ID_CHARS);
  const name = readString(file.name, 32_768);
  const mimeType = readString(file.mimeType, 200);
  if (!id || !name || !mimeType) return null;
  const webViewLink = readGoogleUrl(file.webViewLink);
  const modifiedTime = readString(file.modifiedTime, 100);
  const driveId = readString(file.driveId, MAX_FILE_ID_CHARS);
  const capabilities = asRecord(file.capabilities);
  return {
    id,
    name: truncateText(name, MAX_FILE_NAME_CHARS),
    mimeType,
    sourceRef: driveFileSourceRef(id),
    integrationId,
    canDownload: capabilities.canDownload !== false,
    ...(modifiedTime ? { modifiedTime } : {}),
    ...(driveId ? { driveId } : {}),
    ...(webViewLink ? { webViewLink } : {}),
  };
}

function documentText(document: Record<string, unknown>) {
  const tabs = asArray(document.tabs);
  if (tabs.length === 0) return collectTextRuns(document.body).trim();

  const flattenedTabs: Array<{ title: string; text: string }> = [];
  const visit = (rawTab: unknown): void => {
    const tab = asRecord(rawTab);
    const properties = asRecord(tab.tabProperties);
    const title =
      truncateText(readString(properties.title, 32_768) ?? "Untitled tab", MAX_FILE_NAME_CHARS) ??
      "Untitled tab";
    const text = collectTextRuns(asRecord(tab.documentTab).body).trim();
    if (text) flattenedTabs.push({ title, text });
    for (const child of asArray(tab.childTabs)) visit(child);
  };
  for (const tab of tabs) visit(tab);
  return flattenedTabs
    .map(({ title, text }) => (flattenedTabs.length > 1 ? `## ${title}\n${text}` : text))
    .join("\n\n")
    .trim();
}

function collectTextRuns(value: unknown, depth = 0): string {
  if (depth > 50 || value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => collectTextRuns(item, depth + 1)).join("");
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const textRun = asRecord(record.textRun);
  const ownText = typeof textRun.content === "string" ? textRun.content : "";
  return (
    ownText +
    Object.entries(record)
      .filter(([key]) => key !== "textRun")
      .map(([, child]) => collectTextRuns(child, depth + 1))
      .join("")
  );
}

function driveFileSourceRef(fileId: string) {
  const sourceRef = `google-drive:file:${fileId}`;
  if (!isValidGoatBrainSourceRef(sourceRef)) {
    throw new Error("Google Drive returned a file id that cannot form a Brain source reference.");
  }
  return sourceRef;
}

function googleDocUrl(fileId: string) {
  return `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`;
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
