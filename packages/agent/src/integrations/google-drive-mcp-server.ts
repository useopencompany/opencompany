import { isPluginGatewayRegistrationActive } from "@opencompany/db/plugin-gateway-repository";
import { extractDocumentMarkdown } from "@opencompany/file-extract";
import { createMcpHandler } from "mcp-handler";
import * as z from "zod";
import {
  type CapabilityId,
  effectiveCapabilityMode,
  isCapabilityMode,
} from "../actions/capabilities";
import { truncateText } from "../actions/types";
import {
  GoogleAccessAuthError,
  googleApiCall,
  googleApiDownload,
  googleApiMultipartUpload,
} from "./google-access-token";
import { loadGoogleDriveIntegration } from "./google-data";
import {
  type GoogleDriveMcpTicketPayload,
  verifyGoogleDriveMcpTicket,
} from "./google-drive-mcp-ticket";
import { googleDriveMcpScopesSatisfied } from "./google-drive-scopes";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";
const MCP_MAX_DURATION_SECONDS = 120;
const MAX_FILE_ID_CHARS = 512;
const MAX_FILE_NAME_CHARS = 300;
const MAX_TAB_ID_CHARS = 512;
const MAX_QUERY_CHARS = 1_000;
const MAX_PAGE_TOKEN_CHARS = 2_048;
const MAX_FIND_TEXT_CHARS = 20_000;
const MAX_REPLACEMENT_TEXT_CHARS = 1_000_000;
const MAX_REVISION_ID_CHARS = 2_048;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 200_000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_TEXT_CHARS = 1_000_000;
const MAX_UPLOAD_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4;
const MAX_PERMISSION_PAGES = 5;
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_FIELDS = [
  "id",
  "name",
  "parents",
  "mimeType",
  "size",
  "description",
  "fileExtension",
  "webViewLink",
  "sharedWithMeTime",
  "createdTime",
  "modifiedTime",
  "viewedByMeTime",
  "driveId",
  "trashed",
  "owners(displayName,emailAddress)",
  "capabilities(canAddChildren,canCopy,canDownload,canEdit)",
].join(",");

const TOOL_CAPABILITIES = {
  get_file_metadata: "read",
  list_recent_files: "read",
  search_files: "read",
  download_file_content: "query",
  get_file_permissions: "query",
  read_file_content: "query",
  copy_file: "write",
  create_file: "write",
  replace_document_text: "write",
  replace_document_contents: "write",
} as const satisfies Record<string, CapabilityId>;

type GoogleDriveMcpToolName = keyof typeof TOOL_CAPABILITIES;
type DbLike = any;
type DriveApiCall = typeof googleApiCall;
type DriveApiDownload = typeof googleApiDownload;
type DriveApiUpload = typeof googleApiMultipartUpload;

export type GoogleDriveMcpService = {
  handle(request: Request): Promise<Response>;
};

const fileIdSchema = z.string().trim().min(1).max(MAX_FILE_ID_CHARS);
const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Maximum files to return (default 10, max 100).");
const pageTokenSchema = z.string().trim().min(1).max(MAX_PAGE_TOKEN_CHARS).optional();

const searchFilesSchema = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUERY_CHARS)
    .describe(
      "A structured Drive query, for example title contains 'plan' or parentId = 'root'. Trashed files are always excluded.",
    ),
  pageSize: pageSizeSchema,
  pageToken: pageTokenSchema,
  excludeContentSnippets: z
    .boolean()
    .optional()
    .describe("Accepted for Google MCP compatibility; this server does not return snippets."),
};

const listRecentFilesSchema = {
  orderBy: z.enum(["recency", "lastModified", "lastModifiedByMe"]).optional(),
  pageSize: pageSizeSchema,
  pageToken: pageTokenSchema,
  excludeContentSnippets: z
    .boolean()
    .optional()
    .describe("Accepted for Google MCP compatibility; this server does not return snippets."),
};

const getFileSchema = { fileId: fileIdSchema };
const getFileMetadataSchema = {
  ...getFileSchema,
  excludeContentSnippets: z
    .boolean()
    .optional()
    .describe("Accepted for Google MCP compatibility; this server does not return snippets."),
};
const readFileSchema = {
  fileId: fileIdSchema,
  includeComments: z
    .boolean()
    .optional()
    .describe("Return bounded comment threads separately from the extracted file content."),
};
const downloadFileSchema = {
  fileId: fileIdSchema,
  exportMimeType: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .describe("Required for Google Docs, Sheets, and Slides; ignored for ordinary files."),
};
const copyFileSchema = {
  fileId: fileIdSchema,
  title: z.string().trim().min(1).max(MAX_FILE_NAME_CHARS).optional(),
  parentId: fileIdSchema.optional(),
};
const createFileSchema = {
  title: z.string().trim().min(1).max(MAX_FILE_NAME_CHARS),
  mimeType: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .describe("Target MIME type. Use application/vnd.google-apps.folder to create a folder."),
  contentMimeType: z.string().trim().min(3).max(200).optional(),
  content: z
    .string()
    .max(MAX_UPLOAD_BASE64_CHARS)
    .optional()
    .describe("Deprecated base64 content."),
  base64Content: z.string().max(MAX_UPLOAD_BASE64_CHARS).optional(),
  textContent: z.string().max(MAX_UPLOAD_TEXT_CHARS).optional(),
  parentId: fileIdSchema.optional(),
  disableConversionToGoogleType: z.boolean().optional(),
};
const replaceDocumentTextSchema = {
  fileId: fileIdSchema.describe("Google Drive file id for the Google Doc to edit."),
  findText: z
    .string()
    .min(1)
    .max(MAX_FIND_TEXT_CHARS)
    .describe("Exact text to find. Every occurrence in the selected tab or document is replaced."),
  replaceText: z
    .string()
    .max(MAX_REPLACEMENT_TEXT_CHARS)
    .describe("Replacement text. Pass an empty string to delete the matched text."),
  matchCase: z.boolean().optional().describe("Match capitalization exactly. Defaults to true."),
  tabId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_TAB_ID_CHARS)
    .optional()
    .describe("Optional Google Docs tab id. When omitted, text is replaced across all tabs."),
  requiredRevisionId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REVISION_ID_CHARS)
    .optional()
    .describe(
      "Optional revision id. The edit fails if the document has changed since that revision.",
    ),
};
const replaceDocumentContentsSchema = {
  fileId: fileIdSchema.describe("Google Drive file id for the Google Doc to overwrite."),
  text: z
    .string()
    .max(MAX_REPLACEMENT_TEXT_CHARS)
    .describe(
      "Complete new plain-text contents for the selected tab. Existing formatting and embedded content are removed.",
    ),
  tabId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_TAB_ID_CHARS)
    .optional()
    .describe("Optional Google Docs tab id. When omitted, the first document tab is replaced."),
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const EDIT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const REPLACE_CONTENTS_ANNOTATIONS = {
  ...EDIT_ANNOTATIONS,
  idempotentHint: true,
} as const;

export function createGoogleDriveMcpService(input: {
  db: DbLike;
  internalSecret: string;
  driveApiCall?: DriveApiCall;
  driveApiDownload?: DriveApiDownload;
  driveApiUpload?: DriveApiUpload;
}): GoogleDriveMcpService {
  const apiCall = input.driveApiCall ?? googleApiCall;
  const apiDownload = input.driveApiDownload ?? googleApiDownload;
  const apiUpload = input.driveApiUpload ?? googleApiMultipartUpload;
  return {
    async handle(request) {
      const ticket = bearerToken(request);
      if (!ticket) return unauthorized("A Google Drive MCP bearer ticket is required.");
      const payload = verifyGoogleDriveMcpTicket({ ticket, secret: input.internalSecret });
      if (!payload) return unauthorized("The Google Drive MCP bearer ticket is invalid.");

      const requestPolicy = await authorizeRequest(request, payload);
      if (!requestPolicy.ok) return requestPolicy.response;

      const authorization = await authorizeTicket(input.db, payload);
      if (!authorization.ok) return authorization.response;

      const handler = createMcpHandler(
        (server) => {
          server.registerTool(
            "get_file_metadata",
            {
              title: "Get file metadata",
              description: "Get bounded metadata for one Google Drive file by id.",
              inputSchema: getFileMetadataSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => getFileMetadata(apiCall, payload, args.fileId, request.signal)),
          );
          server.registerTool(
            "list_recent_files",
            {
              title: "List recent files",
              description: "List recent non-trashed files from My Drive and shared drives.",
              inputSchema: listRecentFilesSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => listRecentFiles(apiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "search_files",
            {
              title: "Search files",
              description: "Search non-trashed Drive files using Google Drive v3 query syntax.",
              inputSchema: searchFilesSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => searchFiles(apiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "download_file_content",
            {
              title: "Download file content",
              description:
                "Download at most 5 MB from a Drive file and return it as base64. Google-native files require an export MIME type.",
              inputSchema: downloadFileSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() =>
                downloadFileContent(apiCall, apiDownload, payload, args, request.signal),
              ),
          );
          server.registerTool(
            "get_file_permissions",
            {
              title: "Get file permissions",
              description: "List bounded sharing permissions for one Drive file.",
              inputSchema: getFileSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => getFilePermissions(apiCall, payload, args.fileId, request.signal)),
          );
          server.registerTool(
            "read_file_content",
            {
              title: "Read file content",
              description:
                "Extract a bounded Markdown representation from a supported Drive document, optionally with comment threads.",
              inputSchema: readFileSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => readFileContent(apiCall, apiDownload, payload, args, request.signal)),
          );
          server.registerTool(
            "copy_file",
            {
              title: "Copy file",
              description: "Copy a Drive file, optionally changing its title or parent folder.",
              inputSchema: copyFileSchema,
              annotations: CREATE_ANNOTATIONS,
            },
            async (args) => runTool(() => copyFile(apiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "create_file",
            {
              title: "Create file",
              description:
                "Create a Drive file or folder, with an optional bounded text or base64 upload.",
              inputSchema: createFileSchema,
              annotations: CREATE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => createFile(apiCall, apiUpload, payload, args, request.signal)),
          );
          server.registerTool(
            "replace_document_text",
            {
              title: "Replace text in Google Doc",
              description:
                "Replace every exact occurrence of text in an existing Google Doc. Use only when the user explicitly requested this edit.",
              inputSchema: replaceDocumentTextSchema,
              annotations: EDIT_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => replaceDocumentText(apiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "replace_document_contents",
            {
              title: "Replace Google Doc contents",
              description:
                "Replace all body content in one Google Docs tab with plain text, removing existing formatting and embedded content. Use only when the user explicitly requested a full replacement.",
              inputSchema: replaceDocumentContentsSchema,
              annotations: REPLACE_CONTENTS_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => replaceDocumentContents(apiCall, payload, args, request.signal)),
          );
        },
        {
          serverInfo: { name: "opencompany-google-drive", version: "0.1.0" },
          instructions:
            "Use search_files or list_recent_files to find file ids, read_file_content for bounded natural-language content, and write tools only after the user requested a Drive change. Prefer replace_document_text for focused Google Doc edits; replace_document_contents intentionally removes existing body formatting and embedded content.",
        },
        {
          streamableHttpEndpoint: "/mcp/plugins/google-drive",
          disableSse: true,
          maxDuration: MCP_MAX_DURATION_SECONDS,
        },
      );

      try {
        return await handler(request);
      } catch (error) {
        if (error instanceof GoogleAccessAuthError) {
          return unauthorized("The connected Google Drive account must be reauthorized.");
        }
        throw error;
      }
    },
  };
}

async function authorizeTicket(db: DbLike, payload: GoogleDriveMcpTicketPayload) {
  const [active, row] = await Promise.all([
    isPluginGatewayRegistrationActive(db, {
      workspaceId: payload.workspaceId,
      registrationId: payload.registrationId,
    }),
    loadGoogleDriveIntegration({ userWorkosId: payload.userWorkosId, db }),
  ]);
  if (!active) return forbidden("The Google Drive plugin is no longer enabled.");
  if (
    !row ||
    row.id !== payload.integrationId ||
    row.status !== "connected" ||
    !googleDriveMcpScopesSatisfied(row.scopes ?? [])
  ) {
    return {
      ok: false as const,
      response: unauthorized("The connected Google Drive account must be reauthorized."),
    };
  }
  if (payload.operation.type === "tools/call") {
    const capability = TOOL_CAPABILITIES[payload.operation.tool as GoogleDriveMcpToolName];
    if (!capability || capability !== payload.operation.capability) {
      return forbidden("The Google Drive MCP ticket does not authorize this tool.");
    }
    const toolMode = row.toolModes?.[payload.operation.tool];
    const mode = isCapabilityMode(toolMode)
      ? toolMode
      : effectiveCapabilityMode("google_drive", capability, row.capabilityModes);
    if (mode === "off") return forbidden("This Google Drive capability is disabled.");
  }
  return { ok: true as const };
}

async function authorizeRequest(request: Request, payload: GoogleDriveMcpTicketPayload) {
  if (request.method !== "POST") {
    return { ok: false as const, response: methodNotAllowed() };
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { ok: false as const, response: badRequest("A JSON-RPC request body is required.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false as const, response: badRequest("JSON-RPC batches are not supported.") };
  }
  const rpc = body as Record<string, unknown>;
  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (
    ["initialize", "notifications/initialized", "notifications/cancelled", "ping"].includes(method)
  ) {
    return { ok: true as const };
  }
  if (method === "tools/list" && payload.operation.type === "tools/list") {
    return { ok: true as const };
  }
  if (method === "tools/call" && payload.operation.type === "tools/call") {
    const params = rpc.params;
    if (
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as Record<string, unknown>).name === payload.operation.tool
    ) {
      return { ok: true as const };
    }
  }
  return {
    ok: false as const,
    response: forbidden("The Google Drive MCP ticket does not authorize this operation.").response,
  };
}

async function searchFiles(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof searchFilesSchema>>,
  signal: AbortSignal,
) {
  const url = filesListUrl(args.pageSize, args.pageToken);
  url.searchParams.set("q", `(${translateSearchQuery(args.query)}) and trashed = false`);
  url.searchParams.set("orderBy", "modifiedTime desc");
  return listFilesResponse(await callGoogle(apiCall, payload, "GET", url, signal), args.pageSize);
}

async function listRecentFiles(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof listRecentFilesSchema>>,
  signal: AbortSignal,
) {
  const url = filesListUrl(args.pageSize, args.pageToken);
  url.searchParams.set("q", "trashed = false");
  url.searchParams.set(
    "orderBy",
    args.orderBy === "lastModified"
      ? "modifiedTime desc"
      : args.orderBy === "lastModifiedByMe"
        ? "modifiedByMeTime desc"
        : "recency desc",
  );
  return listFilesResponse(await callGoogle(apiCall, payload, "GET", url, signal), args.pageSize);
}

function filesListUrl(pageSize = 10, pageToken?: string) {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

function listFilesResponse(value: unknown, pageSize = 10) {
  const response = asRecord(value);
  return {
    files: asArray(response.files)
      .slice(0, pageSize)
      .map((file) => compactFile(asRecord(file))),
    nextPageToken: boundedString(response.nextPageToken, MAX_PAGE_TOKEN_CHARS),
  };
}

async function getFileMetadata(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  fileId: string,
  signal: AbortSignal,
) {
  const url = fileUrl(fileId);
  url.searchParams.set("fields", FILE_FIELDS);
  return compactFile(asRecord(await callGoogle(apiCall, payload, "GET", url, signal)));
}

async function getFilePermissions(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  fileId: string,
  signal: AbortSignal,
) {
  const permissions: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set(
      "fields",
      "nextPageToken,permissions(id,role,displayName,type,emailAddress,domain,allowFileDiscovery,expirationTime,deleted,view,pendingOwner,permissionDetails(permissionType,inheritedFrom,role,inherited))",
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = asRecord(await callGoogle(apiCall, payload, "GET", url, signal));
    permissions.push(...asArray(response.permissions));
    pageToken = boundedString(response.nextPageToken, MAX_PAGE_TOKEN_CHARS);
    if (!pageToken) break;
  }
  return {
    fileId,
    permissions: permissions
      .slice(0, 500)
      .map((permission) => compactPermission(asRecord(permission))),
    truncated: Boolean(pageToken) || permissions.length > 500,
  };
}

async function readFileContent(
  apiCall: DriveApiCall,
  apiDownload: DriveApiDownload,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof readFileSchema>>,
  signal: AbortSignal,
) {
  const metadata = await getFileMetadata(apiCall, payload, args.fileId, signal);
  const mimeType = metadata.mimeType;
  const title = metadata.title;
  if (!mimeType || !title) throw new Error("Google Drive returned incomplete file metadata.");
  if (metadata.canDownload === false)
    throw new Error("Google Drive does not allow this file to be downloaded.");
  const download = readableDownload(args.fileId, mimeType);
  const result = await apiDownload(googleConnection(payload), download.url, {
    signal,
    maxBytes: MAX_READ_BYTES,
  });
  const extraction = await extractDocumentMarkdown({
    bytes: result.bytes,
    filename: download.filename(title),
    mediaType: download.contentType,
    maxOutputBytes: MAX_READ_OUTPUT_BYTES,
  });
  return {
    file: metadata,
    fileContent: extraction.markdown,
    truncated: extraction.truncated,
    ...(args.includeComments
      ? { comments: await listComments(apiCall, payload, args.fileId, signal) }
      : {}),
  };
}

async function downloadFileContent(
  apiCall: DriveApiCall,
  apiDownload: DriveApiDownload,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof downloadFileSchema>>,
  signal: AbortSignal,
) {
  const metadata = await getFileMetadata(apiCall, payload, args.fileId, signal);
  if (!metadata.mimeType || !metadata.title) {
    throw new Error("Google Drive returned incomplete file metadata.");
  }
  if (metadata.canDownload === false)
    throw new Error("Google Drive does not allow this file to be downloaded.");
  const native = isGoogleNativeMimeType(metadata.mimeType);
  if (native && metadata.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    throw new Error("Google Drive folders cannot be downloaded.");
  }
  if (native && !args.exportMimeType) {
    throw new Error('"exportMimeType" is required for Google Docs, Sheets, and Slides.');
  }
  if (args.exportMimeType) assertMimeType(args.exportMimeType);
  const url = fileUrl(args.fileId);
  if (native) {
    url.pathname += "/export";
    url.searchParams.set("mimeType", args.exportMimeType!);
  } else {
    url.searchParams.set("alt", "media");
  }
  const result = await apiDownload(googleConnection(payload), url, {
    signal,
    maxBytes: MAX_DOWNLOAD_BYTES,
  });
  return {
    id: metadata.id,
    title: metadata.title,
    mimeType: normalizedContentType(result.contentType) ?? args.exportMimeType ?? metadata.mimeType,
    content: result.bytes.toString("base64"),
  };
}

async function copyFile(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof copyFileSchema>>,
  signal: AbortSignal,
) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(args.fileId)}/copy`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", FILE_FIELDS);
  const response = await callGoogle(apiCall, payload, "POST", url, signal, {
    ...(args.title ? { name: args.title } : {}),
    ...(args.parentId ? { parents: [args.parentId] } : {}),
  });
  return compactFile(asRecord(response));
}

async function createFile(
  apiCall: DriveApiCall,
  apiUpload: DriveApiUpload,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof createFileSchema>>,
  signal: AbortSignal,
) {
  const suppliedContents = [args.content, args.base64Content, args.textContent].filter(
    (value) => value !== undefined,
  );
  if (suppliedContents.length > 1) {
    throw new Error('Set only one of "content", "base64Content", or "textContent".');
  }
  const hasContent = suppliedContents.length === 1;
  if (hasContent && !args.contentMimeType) {
    throw new Error('"contentMimeType" is required when file content is provided.');
  }
  if (args.contentMimeType) assertMimeType(args.contentMimeType);
  if (args.mimeType) assertMimeType(args.mimeType);
  if (hasContent && args.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    throw new Error("A Google Drive folder cannot contain uploaded file bytes.");
  }

  const metadata: Record<string, unknown> = {
    name: args.title,
    ...(args.parentId ? { parents: [args.parentId] } : {}),
  };
  if (!hasContent) {
    metadata.mimeType = args.mimeType ?? "application/octet-stream";
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", FILE_FIELDS);
    return compactFile(asRecord(await callGoogle(apiCall, payload, "POST", url, signal, metadata)));
  }

  const bytes =
    args.textContent !== undefined
      ? Buffer.from(args.textContent, "utf8")
      : decodeBase64(args.base64Content ?? args.content ?? "");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Google Drive plugin uploads are limited to 5 MB.");
  }
  const contentMimeType = args.contentMimeType!;
  metadata.mimeType =
    args.mimeType ??
    (args.disableConversionToGoogleType
      ? contentMimeType
      : (googleConversionMimeType(contentMimeType) ?? contentMimeType));
  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", FILE_FIELDS);
  return compactFile(
    asRecord(
      await apiUpload(googleConnection(payload), url, {
        metadata,
        bytes,
        contentType: contentMimeType,
        signal,
      }),
    ),
  );
}

async function replaceDocumentText(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof replaceDocumentTextSchema>>,
  signal: AbortSignal,
) {
  const response = asRecord(
    await callGoogle(apiCall, payload, "POST", documentBatchUpdateUrl(args.fileId), signal, {
      requests: [
        {
          replaceAllText: {
            containsText: { text: args.findText, matchCase: args.matchCase ?? true },
            replaceText: args.replaceText,
            ...(args.tabId ? { tabsCriteria: { tabIds: [args.tabId] } } : {}),
          },
        },
      ],
      ...(args.requiredRevisionId
        ? { writeControl: { requiredRevisionId: args.requiredRevisionId } }
        : {}),
    }),
  );
  const documentId = confirmedDocumentId(response, args.fileId);
  const replaceReply = asRecord(asRecord(asArray(response.replies)[0]).replaceAllText);
  const occurrencesChanged = nonNegativeSafeInteger(replaceReply.occurrencesChanged);
  return {
    document: {
      id: documentId,
      viewUrl: googleDocumentUrl(documentId, args.tabId),
      ...(args.tabId ? { tabId: args.tabId } : {}),
      ...(occurrencesChanged !== undefined ? { occurrencesChanged } : {}),
      ...responseRevision(response),
    },
  };
}

async function replaceDocumentContents(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof replaceDocumentContentsSchema>>,
  signal: AbortSignal,
) {
  const getUrl = new URL(`${DOCS_BASE}/documents/${encodeURIComponent(args.fileId)}`);
  getUrl.searchParams.set("includeTabsContent", "true");
  const current = asRecord(await callGoogle(apiCall, payload, "GET", getUrl, signal));
  confirmedDocumentId(current, args.fileId);
  const tab = resolveDocumentTab(current, args.tabId);
  const endIndex = documentBodyEndIndex(tab.documentTab);
  const revisionId = boundedString(current.revisionId, MAX_REVISION_ID_CHARS);
  if (!revisionId) throw new Error("Google Docs did not return a revision id for this document.");

  const requests: Record<string, unknown>[] = [];
  if (endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1, tabId: tab.tabId },
      },
    });
  }
  if (args.text) {
    requests.push({
      insertText: {
        location: { index: 1, tabId: tab.tabId },
        text: args.text,
      },
    });
  }

  if (requests.length === 0) {
    return {
      document: {
        id: args.fileId,
        viewUrl: googleDocumentUrl(args.fileId, tab.tabId),
        tabId: tab.tabId,
        revisionId,
        changed: false,
      },
    };
  }

  const response = asRecord(
    await callGoogle(apiCall, payload, "POST", documentBatchUpdateUrl(args.fileId), signal, {
      requests,
      writeControl: { requiredRevisionId: revisionId },
    }),
  );
  const documentId = confirmedDocumentId(response, args.fileId);
  return {
    document: {
      id: documentId,
      viewUrl: googleDocumentUrl(documentId, tab.tabId),
      tabId: tab.tabId,
      changed: true,
      ...responseRevision(response),
    },
  };
}

async function listComments(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  fileId: string,
  signal: AbortSignal,
) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/comments`);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("includeDeleted", "false");
  url.searchParams.set(
    "fields",
    "comments(id,content,quotedFileContent/value,resolved,createdTime,modifiedTime,author(displayName,emailAddress),replies(id,content,createdTime,modifiedTime,author(displayName,emailAddress)))",
  );
  const response = asRecord(await callGoogle(apiCall, payload, "GET", url, signal));
  return asArray(response.comments)
    .slice(0, 100)
    .map((comment) => compactComment(asRecord(comment)));
}

function readableDownload(fileId: string, mimeType: string) {
  const url = fileUrl(fileId);
  if (mimeType === GOOGLE_DOC_MIME_TYPE) {
    url.pathname += "/export";
    url.searchParams.set("mimeType", "text/markdown");
    return {
      url,
      contentType: "text/markdown",
      filename: (title: string) => `${title}.md`,
    };
  }
  if (mimeType === GOOGLE_SHEET_MIME_TYPE) {
    url.pathname += "/export";
    url.searchParams.set("mimeType", XLSX_MIME_TYPE);
    return {
      url,
      contentType: XLSX_MIME_TYPE,
      filename: (title: string) => `${title}.xlsx`,
    };
  }
  if (mimeType === GOOGLE_SLIDES_MIME_TYPE) {
    url.pathname += "/export";
    url.searchParams.set("mimeType", "text/plain");
    return {
      url,
      contentType: "text/plain",
      filename: (title: string) => `${title}.txt`,
    };
  }
  if (isGoogleNativeMimeType(mimeType)) {
    throw new Error(`Unsupported Google Drive file type: ${mimeType}.`);
  }
  url.searchParams.set("alt", "media");
  return { url, contentType: mimeType, filename: (title: string) => title };
}

function fileUrl(fileId: string) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function documentBatchUpdateUrl(fileId: string) {
  return new URL(`${DOCS_BASE}/documents/${encodeURIComponent(fileId)}:batchUpdate`);
}

function confirmedDocumentId(response: Record<string, unknown>, expectedId: string) {
  const documentId = boundedString(response.documentId, MAX_FILE_ID_CHARS);
  if (documentId !== expectedId) throw new Error("Google Docs did not confirm the document edit.");
  return documentId;
}

function responseRevision(response: Record<string, unknown>) {
  const revisionId = boundedString(
    asRecord(response.writeControl).requiredRevisionId,
    MAX_REVISION_ID_CHARS,
  );
  return revisionId ? { revisionId } : {};
}

function nonNegativeSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveDocumentTab(document: Record<string, unknown>, requestedTabId?: string) {
  const tabs = flattenDocumentTabs(asArray(document.tabs));
  const tab = requestedTabId
    ? tabs.find(
        (candidate) =>
          boundedString(asRecord(candidate.tabProperties).tabId, MAX_TAB_ID_CHARS) ===
          requestedTabId,
      )
    : tabs[0];
  if (!tab) {
    throw new Error(
      requestedTabId
        ? `Google Docs did not return tab ${JSON.stringify(requestedTabId)}.`
        : "Google Docs did not return a document tab.",
    );
  }
  const tabId = boundedString(asRecord(tab.tabProperties).tabId, MAX_TAB_ID_CHARS);
  const documentTab = asRecord(tab.documentTab);
  if (!tabId || Object.keys(documentTab).length === 0) {
    throw new Error("Google Docs returned an invalid document tab.");
  }
  return { tabId, documentTab };
}

function flattenDocumentTabs(tabs: unknown[]): Record<string, unknown>[] {
  return tabs.flatMap((value) => {
    const tab = asRecord(value);
    return [tab, ...flattenDocumentTabs(asArray(tab.childTabs))];
  });
}

function documentBodyEndIndex(documentTab: Record<string, unknown>) {
  const indexes = asArray(asRecord(documentTab.body).content).flatMap((value) => {
    const endIndex = asRecord(value).endIndex;
    return typeof endIndex === "number" && Number.isSafeInteger(endIndex) && endIndex >= 2
      ? [endIndex]
      : [];
  });
  const endIndex = indexes.length > 0 ? Math.max(...indexes) : undefined;
  if (!endIndex) throw new Error("Google Docs returned an invalid document body.");
  return endIndex;
}

function googleDocumentUrl(fileId: string, tabId?: string) {
  const url = new URL(`https://docs.google.com/document/d/${encodeURIComponent(fileId)}/edit`);
  if (tabId) url.searchParams.set("tab", tabId);
  return url.toString();
}

function compactFile(value: Record<string, unknown>) {
  const owners = asArray(value.owners)
    .slice(0, 20)
    .map((owner) => compactPerson(asRecord(owner)))
    .filter((owner) => owner.displayName || owner.emailAddress);
  const capabilities = asRecord(value.capabilities);
  return {
    id: boundedString(value.id, MAX_FILE_ID_CHARS),
    title: truncateText(string(value.name), MAX_FILE_NAME_CHARS),
    parentId: asArray(value.parents).flatMap(
      (parent) => boundedString(parent, MAX_FILE_ID_CHARS) ?? [],
    )[0],
    mimeType: boundedString(value.mimeType, 200),
    fileSize: boundedString(value.size, 50),
    description: truncateText(string(value.description), 1_000),
    fileExtension: boundedString(value.fileExtension, 100),
    viewUrl: googleUrl(value.webViewLink),
    sharedWithMeTime: boundedString(value.sharedWithMeTime, 100),
    createdTime: boundedString(value.createdTime, 100),
    modifiedTime: boundedString(value.modifiedTime, 100),
    viewedByMeTime: boundedString(value.viewedByMeTime, 100),
    driveId: boundedString(value.driveId, MAX_FILE_ID_CHARS),
    owner: owners[0]?.emailAddress,
    owners,
    canAddChildren: capabilities.canAddChildren === true || undefined,
    canCopy: capabilities.canCopy === true || undefined,
    canDownload:
      typeof capabilities.canDownload === "boolean" ? capabilities.canDownload : undefined,
    canEdit: capabilities.canEdit === true || undefined,
  };
}

function translateSearchQuery(query: string) {
  const tokens = tokenizeSearchQuery(query);
  const translated: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]!;
    const operator = tokens[index + 1];
    const value = tokens[index + 2];
    if (
      current.kind === "word" &&
      (current.value === "parentId" || current.value === "owner") &&
      operator?.kind === "operator" &&
      (operator.value === "=" || operator.value === "!=") &&
      value?.kind === "string"
    ) {
      const collection = current.value === "parentId" ? "parents" : "owners";
      const membership = `${value.value} in ${collection}`;
      translated.push(operator.value === "=" ? membership : `not (${membership})`);
      index += 2;
      continue;
    }
    translated.push(current.kind === "word" && current.value === "title" ? "name" : current.value);
  }
  return translated.join(" ");
}

function tokenizeSearchQuery(query: string) {
  const tokens: Array<{ kind: "word" | "string" | "operator" | "paren"; value: string }> = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
      continue;
    }
    if (char === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < query.length) {
        if (query[index] === "\\") {
          index += 2;
          continue;
        }
        if (query[index] === "'") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("Drive search query contains an unterminated string.");
      tokens.push({ kind: "string", value: query.slice(start, index) });
      continue;
    }
    if (/[A-Za-z]/u.test(char)) {
      const start = index;
      index += 1;
      while (index < query.length && /[A-Za-z0-9_]/u.test(query[index]!)) index += 1;
      tokens.push({ kind: "word", value: query.slice(start, index) });
      continue;
    }
    if (/[!<>=]/u.test(char)) {
      const start = index;
      index += 1;
      if (query[index] === "=") index += 1;
      tokens.push({ kind: "operator", value: query.slice(start, index) });
      continue;
    }
    throw new Error(`Drive search query contains an unsupported character: ${char}.`);
  }
  return tokens;
}

function compactPermission(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, 256),
    role: boundedString(value.role, 50),
    displayName: truncateText(string(value.displayName), 200),
    type: boundedString(value.type, 50),
    emailAddress: boundedString(value.emailAddress, 320),
    domain: boundedString(value.domain, 253),
    allowFileDiscovery:
      typeof value.allowFileDiscovery === "boolean" ? value.allowFileDiscovery : undefined,
    expirationTime: boundedString(value.expirationTime, 100),
    deleted: value.deleted === true || undefined,
    view: boundedString(value.view, 50),
    pendingOwner: value.pendingOwner === true || undefined,
    permissionDetails: asArray(value.permissionDetails)
      .slice(0, 20)
      .map((detail) => {
        const row = asRecord(detail);
        return {
          permissionType: boundedString(row.permissionType, 50),
          inheritedFrom: boundedString(row.inheritedFrom, MAX_FILE_ID_CHARS),
          role: boundedString(row.role, 50),
          inherited: typeof row.inherited === "boolean" ? row.inherited : undefined,
        };
      }),
  };
}

function compactComment(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, 256),
    content: truncateText(string(value.content), 2_000),
    quotedContent: truncateText(string(asRecord(value.quotedFileContent).value), 1_000),
    resolved: value.resolved === true || undefined,
    createdTime: boundedString(value.createdTime, 100),
    modifiedTime: boundedString(value.modifiedTime, 100),
    author: compactPerson(asRecord(value.author)),
    replies: asArray(value.replies)
      .slice(0, 50)
      .map((reply) => {
        const row = asRecord(reply);
        return {
          id: boundedString(row.id, 256),
          content: truncateText(string(row.content), 2_000),
          createdTime: boundedString(row.createdTime, 100),
          modifiedTime: boundedString(row.modifiedTime, 100),
          author: compactPerson(asRecord(row.author)),
        };
      }),
  };
}

function compactPerson(value: Record<string, unknown>) {
  return {
    displayName: truncateText(string(value.displayName), 200),
    emailAddress: boundedString(value.emailAddress, 320),
  };
}

function googleConnection(payload: GoogleDriveMcpTicketPayload) {
  return {
    userWorkosId: payload.userWorkosId,
    integrationId: payload.integrationId,
    provider: "google_drive" as const,
  };
}

async function callGoogle(
  apiCall: DriveApiCall,
  payload: GoogleDriveMcpTicketPayload,
  method: "GET" | "POST",
  url: URL,
  signal: AbortSignal,
  body?: unknown,
) {
  return await apiCall(googleConnection(payload), method, url, {
    signal,
    ...(body !== undefined ? { body } : {}),
  });
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s+/gu, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw new Error("File content must be valid base64.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized)
    throw new Error("File content must be valid base64.");
  return bytes;
}

function googleConversionMimeType(contentType: string) {
  const conversions: Record<string, string> = {
    "text/plain": GOOGLE_DOC_MIME_TYPE,
    "text/markdown": GOOGLE_DOC_MIME_TYPE,
    "application/rtf": GOOGLE_DOC_MIME_TYPE,
    "application/msword": GOOGLE_DOC_MIME_TYPE,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": GOOGLE_DOC_MIME_TYPE,
    "text/csv": GOOGLE_SHEET_MIME_TYPE,
    "application/csv": GOOGLE_SHEET_MIME_TYPE,
    "application/vnd.ms-excel": GOOGLE_SHEET_MIME_TYPE,
    [XLSX_MIME_TYPE]: GOOGLE_SHEET_MIME_TYPE,
    "application/vnd.ms-powerpoint": GOOGLE_SLIDES_MIME_TYPE,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      GOOGLE_SLIDES_MIME_TYPE,
  };
  return conversions[contentType.toLowerCase()];
}

function assertMimeType(value: string) {
  if (!/^[\w.+-]+\/[\w.+-]+$/u.test(value)) throw new Error(`Invalid MIME type: ${value}.`);
}

function isGoogleNativeMimeType(value: string) {
  return value.startsWith("application/vnd.google-apps.");
}

function normalizedContentType(value: string | null) {
  const result = value?.split(";")[0]?.trim();
  return result && result.length <= 200 ? result : undefined;
}

function googleUrl(value: unknown) {
  const candidate = boundedString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" &&
      (url.hostname === "google.com" || url.hostname.endsWith(".google.com"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function runTool(run: () => Promise<unknown>) {
  try {
    return toolResult(await run());
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code: "auth_expired",
                message: "The connected Google Drive account must be reauthorized.",
              },
            }),
          },
        ],
      };
    }
    throw error;
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function unauthorized(message: string) {
  return Response.json(
    { error: message },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="google-drive-mcp"' } },
  );
}

function forbidden(message: string) {
  return { ok: false as const, response: Response.json({ error: message }, { status: 403 }) };
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function methodNotAllowed() {
  return Response.json({ error: "Only POST is supported." }, { status: 405 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function boundedString(value: unknown, maxChars: number) {
  const result = string(value);
  return result && result.length <= maxChars ? result : undefined;
}
