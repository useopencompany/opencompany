import { isValidBrainSourceRef } from "@opencompany/brain";
import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/schema";
import type { JSONSchema7 } from "ai";
import { and, desc, eq, ne } from "drizzle-orm";
import { GoogleAccessAuthError, googleApiCall } from "../integrations/google-access-token";
import {
  hasGoogleDocsWriteScope,
  hasGoogleSheetsWriteScope,
} from "../integrations/google-drive-scopes";
import { type CapabilityId, effectiveCapabilityMode, providerCapability } from "./capabilities";
import {
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  ActionAuthError,
  type ActionExecuteContext,
  ActionInvalidParamsError,
  ActionPermissionError,
  type ActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedAction,
  requiredStringParam,
  truncateText,
} from "./types";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DOCS_URL = "https://docs.googleapis.com/v1/documents";
const GOOGLE_SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 25;
const MAX_QUERY_CHARS = 200;
const MAX_FILE_ID_CHARS = 512;
const MAX_FILE_NAME_CHARS = 300;
const MAX_ACCOUNT_CHARS = 400;
const MAX_DOCUMENT_TEXT_CHARS = 40_000;
const MAX_INITIAL_DOCUMENT_TEXT_CHARS = 100_000;
const MAX_FIND_TEXT_CHARS = 20_000;
const MAX_REPLACEMENT_TEXT_CHARS = 100_000;
const DEFAULT_SPREADSHEET_RANGE = "A1:Z100";
const MAX_SPREADSHEET_RANGE_CHARS = 500;
const MAX_SPREADSHEET_READ_ROWS = 1_000;
const MAX_SPREADSHEET_WRITE_ROWS = 500;
const MAX_SPREADSHEET_COLUMNS = 100;
const MAX_SPREADSHEET_CELLS = 10_000;
const MAX_SPREADSHEET_CELL_CHARS = 5_000;

type GoogleSheetCellValue = string | number | boolean | null;

type GoogleDriveConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
  scopes: string[];
  capabilityModes: unknown;
};

export async function resolveGoogleDriveActions(
  userWorkosId: string,
): Promise<ActionProviderCatalog | null> {
  const allConnections = await loadGoogleDriveConnections(userWorkosId);
  if (allConnections.length === 0) return null;

  const readConnections = eligibleConnections(allConnections, "read");
  const writeEligibleConnections = eligibleConnections(allConnections, "write");
  const docsWriteConnections = writeEligibleConnections.filter((connection) =>
    hasGoogleDocsWriteScope(connection.scopes),
  );
  const sheetsWriteConnections = writeEligibleConnections.filter((connection) =>
    hasGoogleSheetsWriteScope(connection.scopes),
  );
  if (
    readConnections.length === 0 &&
    docsWriteConnections.length === 0 &&
    sheetsWriteConnections.length === 0
  ) {
    return null;
  }

  const actions: ResolvedAction[] = [];
  if (readConnections.length > 0) {
    actions.push(
      searchFilesAction(readConnections),
      getDocumentAction(readConnections),
      getSpreadsheetValuesAction(readConnections),
    );
  }
  if (docsWriteConnections.length > 0) {
    actions.push(
      createDocumentAction(docsWriteConnections),
      replaceDocumentTextAction(docsWriteConnections),
    );
  }
  if (sheetsWriteConnections.length > 0) {
    actions.push(
      updateSpreadsheetValuesAction(sheetsWriteConnections),
      appendSpreadsheetValuesAction(sheetsWriteConnections),
    );
  }

  const labelConnections =
    readConnections.length > 0
      ? readConnections
      : docsWriteConnections.length > 0
        ? docsWriteConnections
        : sheetsWriteConnections;
  const hasWriteActions = docsWriteConnections.length > 0 || sheetsWriteConnections.length > 0;
  return {
    id: "google_drive",
    label:
      labelConnections.length === 1
        ? `Google Drive (${connectionLabel(labelConnections[0]!)})`
        : `Google Drive (${labelConnections.length} accounts)`,
    description:
      readConnections.length > 0 && hasWriteActions
        ? "Find Drive files, read Google Docs and Sheets, and edit Google Docs or Sheets."
        : readConnections.length > 0
          ? "Find Drive files and read Google Docs and Sheets."
          : "Create or edit Google Docs and update Google Sheets.",
    actions,
  };
}

function eligibleConnections(
  connections: readonly GoogleDriveConnection[],
  capabilityId: CapabilityId,
) {
  return connections.filter(
    (connection) =>
      effectiveCapabilityMode("google_drive", capabilityId, connection.capabilityModes) !== "off",
  );
}

function permissionAnnotation(
  capabilityId: CapabilityId,
  connections: readonly GoogleDriveConnection[],
): Pick<ResolvedAction, "permissionMode" | "permission"> {
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

function searchFilesAction(connections: readonly GoogleDriveConnection[]): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["query"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.search_files",
    provider: "google_drive",
    capability: "read",
    effects: ACTION_EFFECTS_READ,
    ...permissionAnnotation("read", connections),
    description:
      "Search Google Drive, including shared files and shared drives, by file name or indexed text. Returns compact file metadata and links; use google_drive.get_document to read a Google Doc or google_drive.get_spreadsheet_values to read a Google Sheet.",
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
        throw new ActionInvalidParamsError(
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

function getDocumentAction(connections: readonly GoogleDriveConnection[]): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.get_document",
    provider: "google_drive",
    capability: "read",
    effects: ACTION_EFFECTS_READ,
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
            "Google Drive file id for a Google Doc, usually returned by google_drive.search_files. For Google Sheets, use google_drive.get_spreadsheet_values instead.",
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

function getSpreadsheetValuesAction(connections: readonly GoogleDriveConnection[]): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.get_spreadsheet_values",
    provider: "google_drive",
    capability: "read",
    effects: ACTION_EFFECTS_READ,
    ...permissionAnnotation("read", connections),
    description:
      "Read values from a Google Sheet by Drive file id and A1 notation range. Defaults to A1:Z100 on the first sheet when range is omitted. Empty trailing rows and columns may be omitted by Google Sheets.",
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
            "Google Drive file id for a Google Sheet, usually returned by google_drive.search_files.",
        },
        range: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SPREADSHEET_RANGE_CHARS,
          description:
            "A1 notation range to read, for example 'Sheet1!A1:Z100'. Defaults to A1:Z100 on the first sheet.",
        },
        major_dimension: {
          type: "string",
          enum: ["ROWS", "COLUMNS"],
          description:
            "Whether returned values should be grouped by rows or columns. Defaults to ROWS.",
        },
        value_render_option: {
          type: "string",
          enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
          description: "How cell values should be represented. Defaults to FORMATTED_VALUE.",
        },
        date_time_render_option: {
          type: "string",
          enum: ["SERIAL_NUMBER", "FORMATTED_STRING"],
          description:
            "How dates, times, and durations should be represented when value_render_option is not FORMATTED_VALUE. Defaults to SERIAL_NUMBER.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(
        params,
        ["file_id", "range", "major_dimension", "value_render_option", "date_time_render_option"],
        hasMultipleAccounts,
      );
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const fileId = requiredBoundedString(params, "file_id", MAX_FILE_ID_CHARS);
      const range =
        boundedOptionalString(params, "range", MAX_SPREADSHEET_RANGE_CHARS) ??
        DEFAULT_SPREADSHEET_RANGE;
      const majorDimension = enumStringParam(params, "major_dimension", ["ROWS", "COLUMNS"]);
      const valueRenderOption = enumStringParam(params, "value_render_option", [
        "FORMATTED_VALUE",
        "UNFORMATTED_VALUE",
        "FORMULA",
      ]);
      const dateTimeRenderOption = enumStringParam(params, "date_time_render_option", [
        "SERIAL_NUMBER",
        "FORMATTED_STRING",
      ]);

      const url = new URL(
        `${GOOGLE_SHEETS_URL}/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
      );
      if (majorDimension) url.searchParams.set("majorDimension", majorDimension);
      if (valueRenderOption) url.searchParams.set("valueRenderOption", valueRenderOption);
      if (dateTimeRenderOption) url.searchParams.set("dateTimeRenderOption", dateTimeRenderOption);

      const response = asRecord(await googleDriveApiCall(context, connection, "GET", url));
      const spreadsheetId = readString(response.spreadsheetId, MAX_FILE_ID_CHARS) ?? fileId;
      const responseRange = readString(response.range, MAX_SPREADSHEET_RANGE_CHARS) ?? range;
      const shapedValues = sanitizeSpreadsheetValues(response.values, MAX_SPREADSHEET_READ_ROWS);
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        spreadsheet: {
          id: spreadsheetId,
          mimeType: GOOGLE_SHEET_MIME_TYPE,
          sourceRef: driveFileSourceRef(spreadsheetId),
          url: googleSpreadsheetUrl(spreadsheetId),
          range: responseRange,
          majorDimension: readString(response.majorDimension, 20) ?? majorDimension ?? "ROWS",
          values: shapedValues.values,
          truncated: shapedValues.truncated,
        },
      };
    },
  };
}

function createDocumentAction(connections: readonly GoogleDriveConnection[]): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["title"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.create_document",
    provider: "google_drive",
    capability: "write",
    effects: ACTION_EFFECTS_WRITE,
    ...permissionAnnotation("write", connections),
    description:
      "Create a new Google Doc in the connected account's My Drive, optionally with initial plain text. Use only when the user explicitly asked to create a document. Returns the document id and link.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FILE_NAME_CHARS,
          description: "Title for the new Google Doc.",
        },
        text: {
          type: "string",
          maxLength: MAX_INITIAL_DOCUMENT_TEXT_CHARS,
          description: "Optional initial plain text for the document.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(params, ["title", "text"], hasMultipleAccounts);
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const title = requiredBoundedString(params, "title", MAX_FILE_NAME_CHARS);
      const text = boundedOptionalExactText(params, "text", MAX_INITIAL_DOCUMENT_TEXT_CHARS);

      await assertWriteStillEnabled(context.userWorkosId, connection, "docs");

      const created = asRecord(
        await googleDriveApiCall(context, connection, "POST", new URL(GOOGLE_DOCS_URL), { title }),
      );
      const documentId = readString(created.documentId, MAX_FILE_ID_CHARS);
      if (!documentId)
        throw new Error("Google Docs did not return an id for the created document.");
      const document = {
        id: documentId,
        title:
          truncateText(readString(created.title, 32_768) ?? title, MAX_FILE_NAME_CHARS) ?? title,
        mimeType: GOOGLE_DOC_MIME_TYPE,
        sourceRef: driveFileSourceRef(documentId),
        url: googleDocUrl(documentId),
      };

      if (text === undefined) {
        return {
          account: connectionLabel(connection),
          integrationId: connection.integrationId,
          document,
        };
      }

      try {
        const updated = asRecord(
          await googleDriveApiCall(
            context,
            connection,
            "POST",
            new URL(`${GOOGLE_DOCS_URL}/${encodeURIComponent(documentId)}:batchUpdate`),
            {
              requests: [
                {
                  insertText: {
                    endOfSegmentLocation: {},
                    text,
                  },
                },
              ],
            },
          ),
        );
        if (readString(updated.documentId, MAX_FILE_ID_CHARS) !== documentId) {
          throw new Error("Google Docs did not confirm the initial text update.");
        }
        const revisionId = readString(asRecord(updated.writeControl).requiredRevisionId, 2_048);
        return {
          account: connectionLabel(connection),
          integrationId: connection.integrationId,
          document: {
            ...document,
            initialTextAdded: true,
            ...(revisionId ? { revisionId } : {}),
          },
        };
      } catch (error) {
        return {
          account: connectionLabel(connection),
          integrationId: connection.integrationId,
          document: { ...document, initialTextAdded: false },
          warning: `The document was created, but its initial text could not be added. The blank document remains at ${document.url}. ${boundedErrorMessage(error)}`,
        };
      }
    },
  };
}

function replaceDocumentTextAction(connections: readonly GoogleDriveConnection[]): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id", "find", "replace"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.replace_document_text",
    provider: "google_drive",
    capability: "write",
    effects: ACTION_EFFECTS_WRITE,
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

      await assertWriteStillEnabled(context.userWorkosId, connection, "docs");

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

function updateSpreadsheetValuesAction(
  connections: readonly GoogleDriveConnection[],
): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id", "range", "values"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.update_spreadsheet_values",
    provider: "google_drive",
    capability: "write",
    effects: ACTION_EFFECTS_WRITE,
    ...permissionAnnotation("write", connections),
    description:
      "Update cells in an existing Google Sheet by Drive file id and explicit A1 notation range. Existing values in the target range are overwritten. Use only when the user explicitly asked to edit that spreadsheet.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FILE_ID_CHARS,
          description: "Google Drive file id for the Google Sheet to edit.",
        },
        range: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SPREADSHEET_RANGE_CHARS,
          description: "A1 notation range to update, for example 'Sheet1!B2:D4'.",
        },
        values: spreadsheetValuesParamSchema(
          "2D array of values to write. Use null to leave a cell unchanged where Google Sheets supports it, and an empty string to clear a cell.",
        ),
        major_dimension: {
          type: "string",
          enum: ["ROWS", "COLUMNS"],
          description:
            "Whether the values array is organized by rows or columns. Defaults to ROWS.",
        },
        value_input_option: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description:
            "How Google Sheets should interpret input values. Defaults to USER_ENTERED so numbers, dates, and formulas behave like manual edits.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(
        params,
        ["file_id", "range", "values", "major_dimension", "value_input_option"],
        hasMultipleAccounts,
      );
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const fileId = requiredBoundedString(params, "file_id", MAX_FILE_ID_CHARS);
      const range = requiredBoundedString(params, "range", MAX_SPREADSHEET_RANGE_CHARS);
      const values = requiredSpreadsheetValues(params.values);
      const majorDimension = enumStringParam(params, "major_dimension", ["ROWS", "COLUMNS"]);
      const valueInputOption =
        enumStringParam(params, "value_input_option", ["RAW", "USER_ENTERED"]) ?? "USER_ENTERED";

      await assertWriteStillEnabled(context.userWorkosId, connection, "sheets");

      const url = new URL(
        `${GOOGLE_SHEETS_URL}/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
      );
      url.searchParams.set("valueInputOption", valueInputOption);
      const body = {
        range,
        majorDimension: majorDimension ?? "ROWS",
        values,
      };
      const response = asRecord(await googleDriveApiCall(context, connection, "PUT", url, body));
      const spreadsheetId = readString(response.spreadsheetId, MAX_FILE_ID_CHARS) ?? fileId;
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        spreadsheet: {
          id: spreadsheetId,
          mimeType: GOOGLE_SHEET_MIME_TYPE,
          sourceRef: driveFileSourceRef(spreadsheetId),
          url: googleSpreadsheetUrl(spreadsheetId),
          updatedRange: readString(response.updatedRange, MAX_SPREADSHEET_RANGE_CHARS),
          updatedRows: safeNonNegativeInteger(response.updatedRows),
          updatedColumns: safeNonNegativeInteger(response.updatedColumns),
          updatedCells: safeNonNegativeInteger(response.updatedCells),
        },
      };
    },
  };
}

function appendSpreadsheetValuesAction(
  connections: readonly GoogleDriveConnection[],
): ResolvedAction {
  const accountParam = accountParamSchema(connections);
  const required = ["file_id", "range", "values"];
  if (connections.length > 1) required.push("account");

  return {
    id: "google_drive.append_spreadsheet_values",
    provider: "google_drive",
    capability: "write",
    effects: ACTION_EFFECTS_WRITE,
    ...permissionAnnotation("write", connections),
    description:
      "Append rows or columns to an existing Google Sheet using the table detected in an A1 notation range. Use only when the user explicitly asked to add spreadsheet values.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_FILE_ID_CHARS,
          description: "Google Drive file id for the Google Sheet to append to.",
        },
        range: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SPREADSHEET_RANGE_CHARS,
          description:
            "A1 notation range where Google Sheets should detect the existing table, for example 'Sheet1!A1:K'.",
        },
        values: spreadsheetValuesParamSchema(
          "2D array of rows or columns to append. With the default ROWS major_dimension, each inner array is one row.",
        ),
        major_dimension: {
          type: "string",
          enum: ["ROWS", "COLUMNS"],
          description:
            "Whether the values array is organized by rows or columns. Defaults to ROWS.",
        },
        value_input_option: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description:
            "How Google Sheets should interpret input values. Defaults to USER_ENTERED so numbers, dates, and formulas behave like manual edits.",
        },
        insert_data_option: {
          type: "string",
          enum: ["OVERWRITE", "INSERT_ROWS"],
          description: "How new data should be inserted. Defaults to INSERT_ROWS.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const hasMultipleAccounts = connections.length > 1;
      assertOnlyKnownParams(
        params,
        [
          "file_id",
          "range",
          "values",
          "major_dimension",
          "value_input_option",
          "insert_data_option",
        ],
        hasMultipleAccounts,
      );
      const account = hasMultipleAccounts
        ? boundedOptionalString(params, "account", MAX_ACCOUNT_CHARS)
        : undefined;
      const connection = resolveConnection(connections, account);
      const fileId = requiredBoundedString(params, "file_id", MAX_FILE_ID_CHARS);
      const range = requiredBoundedString(params, "range", MAX_SPREADSHEET_RANGE_CHARS);
      const values = requiredSpreadsheetValues(params.values);
      const majorDimension = enumStringParam(params, "major_dimension", ["ROWS", "COLUMNS"]);
      const valueInputOption =
        enumStringParam(params, "value_input_option", ["RAW", "USER_ENTERED"]) ?? "USER_ENTERED";
      const insertDataOption =
        enumStringParam(params, "insert_data_option", ["OVERWRITE", "INSERT_ROWS"]) ??
        "INSERT_ROWS";

      await assertWriteStillEnabled(context.userWorkosId, connection, "sheets");

      const url = new URL(
        `${GOOGLE_SHEETS_URL}/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}:append`,
      );
      url.searchParams.set("valueInputOption", valueInputOption);
      url.searchParams.set("insertDataOption", insertDataOption);
      const body = {
        range,
        majorDimension: majorDimension ?? "ROWS",
        values,
      };
      const response = asRecord(await googleDriveApiCall(context, connection, "POST", url, body));
      const updates = asRecord(response.updates);
      const spreadsheetId =
        readString(response.spreadsheetId, MAX_FILE_ID_CHARS) ??
        readString(updates.spreadsheetId, MAX_FILE_ID_CHARS) ??
        fileId;
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        spreadsheet: {
          id: spreadsheetId,
          mimeType: GOOGLE_SHEET_MIME_TYPE,
          sourceRef: driveFileSourceRef(spreadsheetId),
          url: googleSpreadsheetUrl(spreadsheetId),
          tableRange: readString(response.tableRange, MAX_SPREADSHEET_RANGE_CHARS),
          updatedRange: readString(updates.updatedRange, MAX_SPREADSHEET_RANGE_CHARS),
          updatedRows: safeNonNegativeInteger(updates.updatedRows),
          updatedColumns: safeNonNegativeInteger(updates.updatedColumns),
          updatedCells: safeNonNegativeInteger(updates.updatedCells),
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

async function assertWriteStillEnabled(
  userWorkosId: string,
  connection: GoogleDriveConnection,
  target: "docs" | "sheets",
) {
  const rows = await getDb()
    .select({
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, connection.integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "google_drive"),
      ),
    )
    .limit(1);
  const row = rows[0];
  const hasRequiredScope =
    target === "docs"
      ? hasGoogleDocsWriteScope(row?.scopes ?? [])
      : hasGoogleSheetsWriteScope(row?.scopes ?? []);
  if (!row || row.status !== "connected" || !hasRequiredScope) {
    const targetLabel = target === "docs" ? "Google Docs" : "Google Sheets";
    throw new ActionAuthError(
      "auth_expired",
      "google_drive",
      `Reconnect Google Drive for ${connectionLabel(connection)} in Settings → Integrations to enable editing ${targetLabel}, then retry.`,
    );
  }
  if (effectiveCapabilityMode("google_drive", "write", row.capabilityModes) === "off") {
    throw new ActionPermissionError(
      "google_drive",
      `Editing Google Drive files is turned off for ${connectionLabel(connection)}. It can be changed under Settings → Integrations.`,
    );
  }
}

async function loadGoogleDriveConnections(userWorkosId: string): Promise<GoogleDriveConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: integrations.id,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "google_drive"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt));

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
    throw new ActionInvalidParamsError(
      `No connected Google Drive account matches ${JSON.stringify(account)}. Connected accounts: ${connections
        .map((connection) => JSON.stringify(accountSelector(connection, connections)))
        .join(", ")}.`,
    );
  }
  if (connections.length === 1) return connections[0]!;
  throw new ActionInvalidParamsError(
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
  context: ActionExecuteContext,
  connection: GoogleDriveConnection,
  method: "GET" | "POST" | "PUT",
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
      throw new ActionAuthError(
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
    throw new ActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
    );
  }
}

function requiredBoundedString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = requiredStringParam(params, key);
  if (value.length > maxChars) {
    throw new ActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function boundedOptionalString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = optionalStringParam(params, key);
  if (value && value.length > maxChars) {
    throw new ActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function requiredExactText(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActionInvalidParamsError(`"${key}" is required and must be a non-empty string.`);
  }
  if (value.length > maxChars) {
    throw new ActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function boundedOptionalExactText(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ActionInvalidParamsError(`"${key}" must be a string.`);
  }
  if (value.length > maxChars) {
    throw new ActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function replacementText(params: Record<string, unknown>, maxChars: number) {
  const value = params.replace;
  if (typeof value !== "string") {
    throw new ActionInvalidParamsError('"replace" is required and must be a string.');
  }
  if (value.length > maxChars) {
    throw new ActionInvalidParamsError(`"replace" must be at most ${maxChars} characters.`);
  }
  return value;
}

function optionalBooleanParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ActionInvalidParamsError(`"${key}" must be a boolean.`);
  }
  return value;
}

function enumStringParam<const T extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] | undefined {
  const value = optionalStringParam(params, key);
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new ActionInvalidParamsError(
    `"${key}" must be one of: ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}.`,
  );
}

function spreadsheetValuesParamSchema(description: string): JSONSchema7 {
  return {
    type: "array" as const,
    minItems: 1,
    maxItems: MAX_SPREADSHEET_WRITE_ROWS,
    description,
    items: {
      type: "array" as const,
      minItems: 1,
      maxItems: MAX_SPREADSHEET_COLUMNS,
      items: {
        anyOf: [
          { type: "string", maxLength: MAX_SPREADSHEET_CELL_CHARS },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
        ],
      },
    },
  };
}

function requiredSpreadsheetValues(value: unknown): GoogleSheetCellValue[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ActionInvalidParamsError('"values" is required and must be a non-empty 2D array.');
  }
  if (value.length > MAX_SPREADSHEET_WRITE_ROWS) {
    throw new ActionInvalidParamsError(
      `"values" may include at most ${MAX_SPREADSHEET_WRITE_ROWS} rows or columns.`,
    );
  }

  let cellCount = 0;
  return value.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length === 0) {
      throw new ActionInvalidParamsError(
        `"values"[${rowIndex}] must be a non-empty array of cells.`,
      );
    }
    if (rawRow.length > MAX_SPREADSHEET_COLUMNS) {
      throw new ActionInvalidParamsError(
        `"values"[${rowIndex}] may include at most ${MAX_SPREADSHEET_COLUMNS} cells.`,
      );
    }
    cellCount += rawRow.length;
    if (cellCount > MAX_SPREADSHEET_CELLS) {
      throw new ActionInvalidParamsError(
        `"values" may include at most ${MAX_SPREADSHEET_CELLS} cells.`,
      );
    }
    return rawRow.map((cell, columnIndex) => spreadsheetCellValue(cell, rowIndex, columnIndex));
  });
}

function spreadsheetCellValue(
  value: unknown,
  rowIndex: number,
  columnIndex: number,
): GoogleSheetCellValue {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > MAX_SPREADSHEET_CELL_CHARS) {
      throw new ActionInvalidParamsError(
        `"values"[${rowIndex}][${columnIndex}] must be at most ${MAX_SPREADSHEET_CELL_CHARS} characters.`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ActionInvalidParamsError(
        `"values"[${rowIndex}][${columnIndex}] must be a finite number.`,
      );
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  throw new ActionInvalidParamsError(
    `"values"[${rowIndex}][${columnIndex}] must be a string, number, boolean, or null.`,
  );
}

function sanitizeSpreadsheetValues(value: unknown, maxRows: number) {
  const rows = asArray(value);
  const values: GoogleSheetCellValue[][] = [];
  let truncated = rows.length > maxRows;
  let cellCount = 0;

  for (const rawRow of rows.slice(0, maxRows)) {
    const row = asArray(rawRow);
    if (row.length > MAX_SPREADSHEET_COLUMNS) truncated = true;
    const shapedRow: GoogleSheetCellValue[] = [];
    for (const rawCell of row.slice(0, MAX_SPREADSHEET_COLUMNS)) {
      if (cellCount >= MAX_SPREADSHEET_CELLS) {
        truncated = true;
        break;
      }
      const cell = sanitizeSpreadsheetCell(rawCell);
      shapedRow.push(cell.value);
      if (cell.truncated) truncated = true;
      cellCount += 1;
    }
    values.push(shapedRow);
    if (cellCount >= MAX_SPREADSHEET_CELLS) break;
  }

  return { values, truncated };
}

function sanitizeSpreadsheetCell(value: unknown): {
  value: GoogleSheetCellValue;
  truncated: boolean;
} {
  if (value === null || typeof value === "boolean") return { value, truncated: false };
  if (typeof value === "number" && Number.isFinite(value)) return { value, truncated: false };
  if (typeof value === "string") {
    return {
      value: truncateText(value, MAX_SPREADSHEET_CELL_CHARS) ?? "",
      truncated: value.length > MAX_SPREADSHEET_CELL_CHARS,
    };
  }
  return { value: null, truncated: true };
}

function safeNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  if (!isValidBrainSourceRef(sourceRef)) {
    throw new Error("Google Drive returned a file id that cannot form a Brain source reference.");
  }
  return sourceRef;
}

function googleDocUrl(fileId: string) {
  return `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`;
}

function googleSpreadsheetUrl(fileId: string) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`;
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

function boundedErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Google Docs error.";
  const normalized = message.replace(/\s+/g, " ").trim();
  return truncateText(normalized || "Unknown Google Docs error.", 300);
}
