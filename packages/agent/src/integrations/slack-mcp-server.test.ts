import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isActive: vi.fn(async () => true),
  loadIntegration: vi.fn(),
  loadCredential: vi.fn(),
  markStatus: vi.fn(),
  apiCall: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.isActive,
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: mocks.loadCredential,
  markIntegrationStatus: mocks.markStatus,
}));
vi.mock("./slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadSlackIntegration: mocks.loadIntegration,
}));

import { createSlackMcpService } from "./slack-mcp-server";
import { createSlackMcpTicket, type SlackMcpOperation } from "./slack-mcp-ticket";
import { SLACK_MCP_USER_SCOPES } from "./slack-scopes";

const SECRET = "shared-test-secret";
const connectedRow = {
  id: "integration_1",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [...SLACK_MCP_USER_SCOPES],
  capabilityModes: { read: "on", query: "ask", write: "ask" },
  toolModes: {},
};

function service() {
  return createSlackMcpService({
    db: { sentinel: "db" },
    internalSecret: SECRET,
    slackApiCall: mocks.apiCall,
  });
}

function request(operation: SlackMcpOperation, method: string, params: unknown = {}) {
  const { ticket } = createSlackMcpTicket({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    integrationId: "integration_1",
    registrationId: "registration_1",
    operation,
    secret: SECRET,
  });
  return new Request("https://api.opencompany.chat/mcp/plugins/slack", {
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

describe("opencompany Slack MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isActive.mockResolvedValue(true);
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-provider-token" },
    });
    mocks.apiCall.mockResolvedValue({ ok: true });
  });

  it("discovers the reviewed direct Web API tools without calling Slack", async () => {
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "slack_search_emojis",
      "slack_search_public",
      "slack_search_public_and_private",
      "slack_search_channels",
      "slack_search_users",
      "slack_read_channel",
      "slack_read_thread",
      "slack_read_user_profile",
      "slack_list_channel_members",
      "slack_list_user_channels",
      "slack_list_user_conversations",
      "slack_get_reactions",
      "slack_read_file",
      "slack_send_message",
      "slack_schedule_message",
      "slack_add_reaction",
      "slack_create_conversation",
      "slack_get_file_upload_url",
      "slack_complete_file_upload",
    ]);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("executes a ticket-authorized message with the encrypted provider token", async () => {
    mocks.apiCall.mockResolvedValue({
      ok: true,
      channel: "C123",
      ts: "1730000000.000100",
    });
    const response = await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_send_message",
          capability: "write",
        },
        "tools/call",
        {
          name: "slack_send_message",
          arguments: { channel_id: "C123", message: "Hello" },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      channel: "C123",
      ts: "1730000000.000100",
    });
    expect(mocks.apiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.postMessage",
        token: "xoxp-provider-token",
        form: expect.objectContaining({ channel: "C123", text: "Hello" }),
      }),
    );
  });

  it("limits public search to Slack's real-time public search scope", async () => {
    mocks.apiCall.mockResolvedValue({
      ok: true,
      results: {
        messages: [
          {
            channel_id: "C_PUBLIC",
            message_ts: "1730000000.1",
            content: "public",
          },
        ],
      },
      response_metadata: { next_cursor: "" },
    });
    const response = await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_search_public",
          capability: "read",
        },
        "tools/call",
        {
          name: "slack_search_public",
          arguments: {
            keywords: ["launch", "plan"],
            filters: "after:2026-09-01",
            natural_language_query: "What is the launch plan?",
            include_bots: true,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.apiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "assistant.search.context",
        token: "xoxp-provider-token",
        form: expect.objectContaining({
          query: "What is the launch plan? launch plan after:2026-09-01",
          channel_types: "public_channel",
          content_types: "messages",
          include_context_messages: "true",
          limit: "20",
          sort: "score",
        }),
      }),
    );
  });

  it("accepts the hosted tool contract for threads and file uploads", async () => {
    mocks.apiCall.mockResolvedValue({ ok: true, messages: [] });
    await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_read_thread",
          capability: "query",
        },
        "tools/call",
        {
          name: "slack_read_thread",
          arguments: {
            channel_id: "C123",
            message_ts: "1730000000.000100",
            response_format: "concise",
          },
        },
      ),
    );
    expect(mocks.apiCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "conversations.replies",
        form: expect.objectContaining({
          channel: "C123",
          ts: "1730000000.000100",
        }),
      }),
    );

    mocks.apiCall.mockResolvedValue({
      ok: true,
      file_id: "F123",
      upload_url: "https://files.slack.com/upload",
    });
    await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_get_file_upload_url",
          capability: "write",
        },
        "tools/call",
        {
          name: "slack_get_file_upload_url",
          arguments: {
            filename: "report.txt",
            content_length: 12,
            alt_txt: "Quarterly report",
          },
        },
      ),
    );
    expect(mocks.apiCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "files.getUploadURLExternal",
        form: expect.objectContaining({
          filename: "report.txt",
          length: "12",
          alt_txt: "Quarterly report",
        }),
      }),
    );
  });

  it("creates a named channel before inviting the requested users", async () => {
    mocks.apiCall.mockImplementation(async ({ method }: { method: string }) =>
      method === "conversations.create"
        ? { ok: true, channel: { id: "C_NEW", name: "project-x" } }
        : { ok: true, channel: { id: "C_NEW" } },
    );
    const response = await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_create_conversation",
          capability: "write",
        },
        "tools/call",
        {
          name: "slack_create_conversation",
          arguments: {
            channel_name: "Project X",
            user_ids: ["U123", "U456"],
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      channel: { id: "C_NEW" },
    });
    expect(mocks.apiCall.mock.calls.map(([call]) => call.method)).toEqual([
      "conversations.create",
      "conversations.invite",
    ]);
    expect(mocks.apiCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        form: expect.objectContaining({ name: "project-x" }),
      }),
    );
  });

  it("rejects tool calls that do not match the ticket operation", async () => {
    const response = await service().handle(
      request(
        {
          type: "tools/call",
          tool: "slack_read_channel",
          capability: "query",
        },
        "tools/call",
        {
          name: "slack_send_message",
          arguments: { channel_id: "C123", message: "No" },
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("fails closed when the plugin registration is disabled", async () => {
    mocks.isActive.mockResolvedValue(false);
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("fails closed when the encrypted provider credential is absent", async () => {
    mocks.loadCredential.mockResolvedValue(null);
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(401);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });
});
