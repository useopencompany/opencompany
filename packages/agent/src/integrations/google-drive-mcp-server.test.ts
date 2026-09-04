import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isActive: vi.fn(async () => true),
  loadIntegration: vi.fn(),
  apiCall: vi.fn(),
  apiDownload: vi.fn(),
  apiUpload: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.isActive,
}));
vi.mock("./google-data", () => ({
  loadGoogleDriveIntegration: mocks.loadIntegration,
}));

import { createGoogleDriveMcpService } from "./google-drive-mcp-server";
import {
  createGoogleDriveMcpTicket,
  type GoogleDriveMcpOperation,
} from "./google-drive-mcp-ticket";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READ_SCOPE } from "./google-drive-scopes";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const SECRET = "shared-test-secret";
const connectedRow = {
  id: "integration_1",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
  capabilityModes: { read: "ask", query: "ask", write: "ask" },
  toolModes: {},
};

function service() {
  return createGoogleDriveMcpService({
    db: { sentinel: "db" },
    internalSecret: SECRET,
    driveApiCall: mocks.apiCall,
    driveApiDownload: mocks.apiDownload,
    driveApiUpload: mocks.apiUpload,
  });
}

function request(operation: GoogleDriveMcpOperation, method: string, params: unknown = {}) {
  const { ticket } = createGoogleDriveMcpTicket({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    integrationId: "integration_1",
    registrationId: "registration_1",
    operation,
    secret: SECRET,
  });
  return new Request("https://api.opencompany.chat/mcp/plugins/google-drive", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function responseJson(response: Response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    return JSON.parse(data ?? "null") as any;
  }
  return JSON.parse(text) as any;
}

describe("opencompany Google Drive MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isActive.mockResolvedValue(true);
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.apiCall.mockResolvedValue({ files: [] });
    mocks.apiDownload.mockResolvedValue({
      bytes: Buffer.from("Hello from Drive", "utf8"),
      contentType: "text/plain",
    });
    mocks.apiUpload.mockResolvedValue({
      id: "created_1",
      name: "Plan",
      mimeType: "application/vnd.google-apps.document",
    });
  });

  it("discovers only the eight reviewed Drive-compatible tools", async () => {
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "get_file_metadata",
      "list_recent_files",
      "search_files",
      "download_file_content",
      "get_file_permissions",
      "read_file_content",
      "copy_file",
      "create_file",
    ]);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("completes a real MCP handshake and discovery request", async () => {
    const driveMcp = service();
    const { ticket } = createGoogleDriveMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/list" },
      secret: SECRET,
    });
    const authProvider = createRemoteMcpStaticBearerAuthProvider({
      accessToken: ticket,
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    const client = await createMCPClient({
      clientName: "drive-test",
      version: "0.1.0",
      transport: {
        type: "http",
        url: "https://api.opencompany.chat/mcp/plugins/google-drive",
        authProvider,
        fetch: async (url, init) => driveMcp.handle(new Request(url, init)),
      },
    });
    try {
      const listedTools = await client.listTools();
      expect(listedTools.tools.map((tool) => tool.name)).toEqual([
        "get_file_metadata",
        "list_recent_files",
        "search_files",
        "download_file_content",
        "get_file_permissions",
        "read_file_content",
        "copy_file",
        "create_file",
      ]);
    } finally {
      await client.close();
    }
  });

  it("searches through the stable Drive REST API and bounds returned metadata", async () => {
    mocks.apiCall.mockResolvedValueOnce({
      files: [
        {
          id: "file_1",
          name: "Launch plan",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/file_1/edit",
          owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
          capabilities: { canDownload: true },
        },
      ],
      nextPageToken: "next_1",
    });
    const response = await service().handle(
      request({ type: "tools/call", tool: "search_files", capability: "read" }, "tools/call", {
        name: "search_files",
        arguments: {
          query: "title contains 'Launch' and parentId = 'root' and owner = 'me'",
          pageSize: 5,
        },
      }),
    );
    const body = await responseJson(response);
    expect(body.result.content[0].text).toContain("Launch plan");
    expect(mocks.apiCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google_drive", integrationId: "integration_1" }),
      "GET",
      expect.objectContaining({
        origin: "https://www.googleapis.com",
        pathname: "/drive/v3/files",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const url = mocks.apiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("q")).toBe(
      "(name contains 'Launch' and 'root' in parents and 'me' in owners) and trashed = false",
    );
    expect(url.searchParams.get("pageSize")).toBe("5");
  });

  it("extracts bounded readable content without returning Google credentials", async () => {
    mocks.apiCall.mockResolvedValueOnce({
      id: "file_1",
      name: "Notes.txt",
      mimeType: "text/plain",
      capabilities: { canDownload: true },
    });
    const response = await service().handle(
      request(
        { type: "tools/call", tool: "read_file_content", capability: "query" },
        "tools/call",
        { name: "read_file_content", arguments: { fileId: "file_1" } },
      ),
    );
    const body = await responseJson(response);
    expect(body.result.content[0].text).toContain("Hello from Drive");
    expect(mocks.apiDownload).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google_drive", integrationId: "integration_1" }),
      expect.objectContaining({ pathname: "/drive/v3/files/file_1" }),
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 }),
    );
    expect(JSON.stringify(mocks.apiDownload.mock.calls)).not.toContain("google-access-token");
  });

  it("uploads bounded text through the stable Drive upload endpoint", async () => {
    const response = await service().handle(
      request({ type: "tools/call", tool: "create_file", capability: "write" }, "tools/call", {
        name: "create_file",
        arguments: {
          title: "Plan",
          textContent: "Draft",
          contentMimeType: "text/plain",
        },
      }),
    );
    const body = await responseJson(response);
    expect(body.result.content[0].text).toContain("created_1");
    expect(mocks.apiUpload).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google_drive", integrationId: "integration_1" }),
      expect.objectContaining({
        origin: "https://www.googleapis.com",
        pathname: "/upload/drive/v3/files",
      }),
      expect.objectContaining({
        bytes: Buffer.from("Draft"),
        contentType: "text/plain",
        metadata: expect.objectContaining({
          name: "Plan",
          mimeType: "application/vnd.google-apps.document",
        }),
      }),
    );
  });

  it("returns a trusted reconnect envelope when Google revokes access during a call", async () => {
    const { GoogleAccessAuthError } = await import("./google-access-token");
    mocks.apiCall.mockRejectedValueOnce(new GoogleAccessAuthError("revoked"));
    const response = await service().handle(
      request({ type: "tools/call", tool: "search_files", capability: "read" }, "tools/call", {
        name: "search_files",
        arguments: { query: "title contains 'plan'" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result).toMatchObject({ isError: true });
    expect(body.result.content[0].text).toContain('"code":"auth_expired"');
  });

  it("rejects missing and incorrectly signed bearer tickets", async () => {
    const missing = await service().handle(
      new Request("https://api.opencompany.chat/mcp/plugins/google-drive", { method: "POST" }),
    );
    expect(missing.status).toBe(401);

    const invalid = request({ type: "tools/list" }, "tools/list");
    invalid.headers.set("authorization", "Bearer invalid.ticket");
    expect((await service().handle(invalid)).status).toBe(401);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("rejects operation switching and rechecks plugin, account scopes, and disabled tools", async () => {
    const switched = await service().handle(
      request({ type: "tools/call", tool: "search_files", capability: "read" }, "tools/call", {
        name: "copy_file",
        arguments: { fileId: "file_1" },
      }),
    );
    expect(switched.status).toBe(403);

    mocks.isActive.mockResolvedValueOnce(false);
    const disabledPlugin = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(disabledPlugin.status).toBe(403);

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: [GOOGLE_DRIVE_READ_SCOPE],
    });
    const missingScope = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(missingScope.status).toBe(401);

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      toolModes: { copy_file: "off" },
    });
    const disabled = await service().handle(
      request({ type: "tools/call", tool: "copy_file", capability: "write" }, "tools/call", {
        name: "copy_file",
        arguments: { fileId: "file_1" },
      }),
    );
    expect(disabled.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });
});
