import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isActive: vi.fn(async () => true),
  loadIntegration: vi.fn(),
  apiCall: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.isActive,
}));
vi.mock("./google-data", () => ({ loadGmailIntegration: mocks.loadIntegration }));

import { createGmailMcpService } from "./gmail-mcp-server";
import { createGmailMcpTicket, type GmailMcpOperation } from "./gmail-mcp-ticket";
import { GMAIL_MODIFY_SCOPE } from "./gmail-scopes";
import { GoogleAccessAuthError } from "./google-access-token";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const SECRET = "shared-test-secret";
const TOOL_NAMES = [
  "list_drafts",
  "get_draft",
  "search_threads",
  "get_thread",
  "get_message",
  "download_attachment",
  "list_labels",
  "create_draft",
  "label_thread",
  "unlabel_thread",
  "trash_thread",
  "untrash_thread",
  "label_message",
  "unlabel_message",
  "trash_message",
  "untrash_message",
  "create_label",
];
const connectedRow = {
  id: "integration_1",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [GMAIL_MODIFY_SCOPE],
  capabilityModes: { query: "ask", draft: "ask", write: "ask" },
  toolModes: {},
};

function service() {
  return createGmailMcpService({
    db: { sentinel: "db" },
    internalSecret: SECRET,
    gmailApiCall: mocks.apiCall,
  });
}

function request(operation: GmailMcpOperation, method: string, params: unknown = {}) {
  const { ticket } = createGmailMcpTicket({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    integrationId: "integration_1",
    registrationId: "registration_1",
    operation,
    secret: SECRET,
  });
  return new Request("https://api.opencompany.chat/mcp/plugins/gmail", {
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

describe("opencompany Gmail MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiCall.mockReset();
    mocks.isActive.mockResolvedValue(true);
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.apiCall.mockResolvedValue({});
  });

  it("discovers only the reviewed stable Gmail tools", async () => {
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("completes a real MCP client handshake and discovery request", async () => {
    const gmailMcp = service();
    const { ticket } = createGmailMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/list" },
      secret: SECRET,
    });
    const client = await createMCPClient({
      clientName: "gmail-test",
      version: "0.1.0",
      transport: {
        type: "http",
        url: "https://api.opencompany.chat/mcp/plugins/gmail",
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: ticket,
          onAuthorizationRequired: () => {
            throw new Error("authorization required");
          },
        }),
        fetch: async (url, init) => gmailMcp.handle(new Request(url, init)),
      },
    });
    try {
      const discovered = await client.listTools();
      expect(discovered.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    } finally {
      await client.close();
    }
  });

  it("creates a reviewable draft through stable Gmail REST without exposing a send tool", async () => {
    mocks.apiCall.mockResolvedValueOnce({
      id: "draft_1",
      message: { id: "message_1", threadId: "thread_1" },
    });
    const response = await service().handle(
      request({ type: "tools/call", tool: "create_draft", capability: "draft" }, "tools/call", {
        name: "create_draft",
        arguments: {
          to: ["ada@example.com"],
          subject: "Launch plan\nBcc: attacker@example.com",
          body: "Looks good to me.",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.isError).not.toBe(true);
    const [connection, method, url, options] = mocks.apiCall.mock.calls[0]!;
    expect(connection).toEqual({
      userWorkosId: "user_1",
      integrationId: "integration_1",
      provider: "gmail",
    });
    expect(method).toBe("POST");
    expect(url.toString()).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    const raw = Buffer.from(options.body.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: ada@example.com\r\n");
    expect(raw).not.toContain("\r\nBcc: attacker@example.com\r\n");
    expect(raw).toContain("Looks good to me.");
    expect(TOOL_NAMES).not.toContain("send_message");
  });

  it("creates replies in the original thread with safe RFC message headers", async () => {
    mocks.apiCall
      .mockResolvedValueOnce({
        id: "message_original",
        threadId: "thread_1",
        payload: {
          headers: [{ name: "Message-ID", value: "<original@example.com>" }],
        },
      })
      .mockResolvedValueOnce({
        id: "draft_1",
        message: { id: "message_reply", threadId: "thread_1" },
      });
    const response = await service().handle(
      request({ type: "tools/call", tool: "create_draft", capability: "draft" }, "tools/call", {
        name: "create_draft",
        arguments: {
          to: ["ada@example.com"],
          subject: "Re: Launch plan",
          body: "Confirmed.",
          replyToMessageId: "message_original",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await responseJson(response)).result.isError).not.toBe(true);
    expect(mocks.apiCall).toHaveBeenCalledTimes(2);
    expect(mocks.apiCall.mock.calls[0]?.[2].searchParams.get("format")).toBe("metadata");
    expect(mocks.apiCall.mock.calls[0]?.[2].searchParams.getAll("metadataHeaders")).toEqual([
      "Message-ID",
    ]);
    const requestBody = mocks.apiCall.mock.calls[1]?.[3].body;
    expect(requestBody.message.threadId).toBe("thread_1");
    const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <original@example.com>\r\n");
    expect(raw).toContain("References: <original@example.com>\r\n");
  });

  it("maps read tools to Gmail REST and returns bounded decoded message content", async () => {
    mocks.apiCall
      .mockResolvedValueOnce({ drafts: [{ id: "draft_1", message: { id: "message_1" } }] })
      .mockResolvedValueOnce({ threads: [{ id: "thread_1", snippet: "Planning" }] })
      .mockResolvedValueOnce({
        id: "thread_1",
        messages: [
          {
            id: "message_1",
            threadId: "thread_1",
            payload: {
              mimeType: "text/plain",
              headers: [{ name: "Subject", value: "Planning" }],
              body: { data: Buffer.from("Untrusted email content", "utf8").toString("base64url") },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ id: "message_1", payload: { headers: [] } })
      .mockResolvedValueOnce({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });

    const calls = [
      { tool: "list_drafts", arguments: { pageSize: 5 } },
      { tool: "search_threads", arguments: { query: "from:ada@example.com" } },
      { tool: "get_thread", arguments: { threadId: "thread_1" } },
      { tool: "get_message", arguments: { messageId: "message_1" } },
      { tool: "list_labels", arguments: {} },
    ];
    const results = [];
    for (const call of calls) {
      const response = await service().handle(
        request({ type: "tools/call", tool: call.tool, capability: "query" }, "tools/call", {
          name: call.tool,
          arguments: call.arguments,
        }),
      );
      expect(response.status).toBe(200);
      results.push(await responseJson(response));
    }

    expect(mocks.apiCall.mock.calls[0]?.[2].toString()).toContain("/users/me/drafts?maxResults=5");
    expect(mocks.apiCall.mock.calls[1]?.[2].searchParams.get("q")).toBe("from:ada@example.com");
    expect(mocks.apiCall.mock.calls[2]?.[2].toString()).toContain("/threads/thread_1?format=full");
    expect(mocks.apiCall.mock.calls[3]?.[2].toString()).toContain(
      "/messages/message_1?format=full",
    );
    expect(mocks.apiCall.mock.calls[4]?.[2].toString()).toContain("/users/me/labels");
    expect(results[2].result.content[0].text).toContain("Untrusted email content");
  });

  it("creates a short-lived URL and downloads the original attachment bytes", async () => {
    const message = {
      id: "message_1",
      payload: {
        parts: [
          {
            partId: "2",
            filename: 'Q3 plan über "final".pdf',
            mimeType: "application/pdf",
            body: { attachmentId: "attachment_1", size: 12 },
          },
        ],
      },
    };
    mocks.apiCall
      .mockResolvedValueOnce(message)
      .mockResolvedValueOnce(message)
      .mockResolvedValueOnce({ data: Buffer.from("pdf contents").toString("base64url") });

    const gmailMcp = service();
    const toolResponse = await gmailMcp.handle(
      request(
        { type: "tools/call", tool: "download_attachment", capability: "query" },
        "tools/call",
        {
          name: "download_attachment",
          arguments: { messageId: "message_1", partId: "2" },
        },
      ),
    );
    expect(toolResponse.status).toBe(200);
    const toolBody = await responseJson(toolResponse);
    const result = JSON.parse(toolBody.result.content[0].text) as {
      filename: string;
      downloadUrl: string;
      expiresAt: string;
    };
    expect(result.filename).toBe('Q3 plan über "final".pdf');
    expect(
      result.downloadUrl.startsWith(
        "https://api.opencompany.chat/mcp/plugins/gmail/attachments/download?",
      ),
    ).toBe(true);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());

    const tamperedUrl = new URL(result.downloadUrl);
    tamperedUrl.searchParams.set("partId", "3");
    expect(await gmailMcp.downloadAttachment(new Request(tamperedUrl))).toMatchObject({
      status: 401,
    });
    expect(mocks.apiCall).toHaveBeenCalledOnce();

    const download = await gmailMcp.downloadAttachment(new Request(result.downloadUrl));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''Q3%20plan%20%C3%BCber%20_final_.pdf",
    );
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toBe("pdf contents");
    expect(mocks.apiCall.mock.calls[2]?.[2].toString()).toContain(
      "/messages/message_1/attachments/attachment_1",
    );
  });

  it("lists attachment part ids and rejects oversized downloads before fetching bytes", async () => {
    const message = {
      id: "message_1",
      payload: {
        parts: [
          {
            partId: "2",
            filename: "archive.zip",
            mimeType: "application/zip",
            body: { attachmentId: "attachment_1", size: 21 * 1024 * 1024 },
          },
        ],
      },
    };
    mocks.apiCall.mockResolvedValue(message);

    const gmailMcp = service();
    const messageResponse = await gmailMcp.handle(
      request({ type: "tools/call", tool: "get_message", capability: "query" }, "tools/call", {
        name: "get_message",
        arguments: { messageId: "message_1" },
      }),
    );
    const messageBody = await responseJson(messageResponse);
    expect(JSON.parse(messageBody.result.content[0].text).attachments).toEqual([
      {
        partId: "2",
        filename: "archive.zip",
        mimeType: "application/zip",
        attachmentId: "attachment_1",
        size: 21 * 1024 * 1024,
      },
    ]);

    const downloadResponse = await gmailMcp.handle(
      request(
        { type: "tools/call", tool: "download_attachment", capability: "query" },
        "tools/call",
        {
          name: "download_attachment",
          arguments: { messageId: "message_1", partId: "2" },
        },
      ),
    );
    expect((await responseJson(downloadResponse)).result).toMatchObject({ isError: true });
    expect(mocks.apiCall).toHaveBeenCalledTimes(2);
  });

  it("rejects attachment download URLs without a matching narrow ticket", async () => {
    const { ticket } = createGmailMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/call", tool: "get_message", capability: "query" },
      secret: SECRET,
    });
    const url = new URL("https://api.opencompany.chat/mcp/plugins/gmail/attachments/download");
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("messageId", "message_1");
    url.searchParams.set("partId", "2");

    const response = await service().downloadAttachment(new Request(url));
    expect(response.status).toBe(401);
    expect(mocks.isActive).not.toHaveBeenCalled();
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("accepts the generic read classification from existing Gmail 1.1 installations", async () => {
    mocks.apiCall.mockResolvedValue({
      id: "message_1",
      payload: {
        parts: [
          {
            partId: "2",
            filename: "plan.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "attachment_1", size: 12 },
          },
        ],
      },
    });
    const response = await service().handle(
      request(
        { type: "tools/call", tool: "download_attachment", capability: "read" },
        "tools/call",
        {
          name: "download_attachment",
          arguments: { messageId: "message_1", partId: "2" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect((await responseJson(response)).result.isError).not.toBe(true);
    expect(mocks.apiCall).toHaveBeenCalledOnce();
  });

  it("maps label, trash, and create-label writes without permanent deletion", async () => {
    const calls = [
      {
        tool: "label_message",
        arguments: { messageId: "message_1", labelIds: ["STARRED"] },
      },
      { tool: "trash_thread", arguments: { threadId: "thread_1" } },
      {
        tool: "create_label",
        arguments: { name: "Projects/Launch", labelListVisibility: "labelShow" },
      },
    ];
    for (const call of calls) {
      const response = await service().handle(
        request({ type: "tools/call", tool: call.tool, capability: "write" }, "tools/call", {
          name: call.tool,
          arguments: call.arguments,
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(mocks.apiCall.mock.calls[0]?.[2].toString()).toContain("/messages/message_1/modify");
    expect(mocks.apiCall.mock.calls[0]?.[3].body).toEqual({ addLabelIds: ["STARRED"] });
    expect(mocks.apiCall.mock.calls[1]?.[2].toString()).toContain("/threads/thread_1/trash");
    expect(mocks.apiCall.mock.calls[2]?.[2].toString()).toContain("/users/me/labels");
    expect(mocks.apiCall.mock.calls[2]?.[3].body).toEqual({
      name: "Projects/Launch",
      labelListVisibility: "labelShow",
    });
    expect(mocks.apiCall.mock.calls.flatMap((call) => [call[1]])).not.toContain("DELETE");
  });

  it("returns a trusted reconnect envelope when Google revokes access during a call", async () => {
    mocks.apiCall.mockRejectedValueOnce(new GoogleAccessAuthError("revoked"));
    const response = await service().handle(
      request({ type: "tools/call", tool: "search_threads", capability: "query" }, "tools/call", {
        name: "search_threads",
        arguments: { query: "newer_than:7d" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result).toMatchObject({ isError: true });
    expect(body.result.content[0].text).toContain('"code":"auth_expired"');
  });

  it("rejects cross-operation and cross-tool reuse before calling Google", async () => {
    const discoveryCall = await service().handle(
      request({ type: "tools/list" }, "tools/call", {
        name: "search_threads",
        arguments: { query: "newer_than:7d" },
      }),
    );
    expect(discoveryCall.status).toBe(403);

    const wrongTool = await service().handle(
      request({ type: "tools/call", tool: "get_message", capability: "query" }, "tools/call", {
        name: "create_draft",
        arguments: {},
      }),
    );
    expect(wrongTool.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("rechecks plugin, account scope, and tool permission on every request", async () => {
    mocks.isActive.mockResolvedValueOnce(false);
    expect((await service().handle(request({ type: "tools/list" }, "tools/list"))).status).toBe(
      403,
    );

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect((await service().handle(request({ type: "tools/list" }, "tools/list"))).status).toBe(
      401,
    );

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      toolModes: { trash_message: "off" },
    });
    const disabledTool = await service().handle(
      request({ type: "tools/call", tool: "trash_message", capability: "write" }, "initialize"),
    );
    expect(disabledTool.status).toBe(403);
  });
});
