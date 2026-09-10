import { createMCPClient } from "@ai-sdk/mcp";
import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRemoteTool } from "../actions/remote-mcp";
import { resolvePluginImport } from "../plugin-import";

const mocks = vi.hoisted(() => ({
  isActive: vi.fn(async () => true),
  loadIntegration: vi.fn(),
  apiCall: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.isActive,
}));
vi.mock("./google-data", () => ({
  loadGoogleAdminIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import { createGoogleAdminMcpService } from "./google-admin-mcp-server";
import {
  createGoogleAdminMcpTicket,
  type GoogleAdminMcpOperation,
} from "./google-admin-mcp-ticket";
import { GOOGLE_ADMIN_GROUP_SCOPE, GOOGLE_ADMIN_USER_SCOPE } from "./google-admin-scopes";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const SECRET = "shared-test-secret";
const connectedRow = {
  id: "integration_1",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [GOOGLE_ADMIN_USER_SCOPE, GOOGLE_ADMIN_GROUP_SCOPE],
  capabilityModes: { read: "ask", query: "ask", write: "ask" },
  toolModes: {},
};

function service() {
  return createGoogleAdminMcpService({
    db: { sentinel: "db" },
    internalSecret: SECRET,
    adminApiCall: mocks.apiCall,
  });
}

function request(operation: GoogleAdminMcpOperation, method: string, params: unknown = {}) {
  const { ticket } = createGoogleAdminMcpTicket({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    integrationId: "integration_1",
    registrationId: "registration_1",
    operation,
    secret: SECRET,
  });
  return new Request("https://api.opencompany.chat/mcp/plugins/google-admin", {
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

const tools = [
  "list_users",
  "get_user",
  "create_user",
  "list_groups",
  "get_group",
  "create_group",
  "update_group",
  "list_group_members",
  "add_group_member",
];
async function invoke(
  name: string,
  args: Record<string, unknown> = {},
  capability: "query" | "write" = "write",
) {
  const response = await service().handle(
    request({ type: "tools/call", tool: name, capability }, "tools/call", {
      name,
      arguments: args,
    }),
  );
  return { response, body: await responseJson(response) };
}
function output(body: any) {
  return JSON.parse(body.result.content[0].text);
}

describe("Google Admin MCP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isActive.mockResolvedValue(true);
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.apiCall.mockResolvedValue({ id: "resource_1" });
  });

  it("discovers exactly the reviewed tools through a real MCP client", async () => {
    const adapter = service();
    const { ticket } = createGoogleAdminMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/list" },
      secret: SECRET,
    });
    const client = await createMCPClient({
      clientName: "admin-test",
      version: "1",
      transport: {
        type: "http",
        url: "https://api.opencompany.chat/mcp/plugins/google-admin",
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: ticket,
          onAuthorizationRequired: () => {
            throw new Error("auth required");
          },
        }),
        fetch: async (url, init) => adapter.handle(new Request(url, init)),
      },
    });
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual(tools);
      const create = result.tools.find((tool) => tool.name === "create_user")!;
      expect(create.annotations?.readOnlyHint).toBe(false);
      expect(create.inputSchema.properties).not.toHaveProperty("password");
      expect(mocks.apiCall).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("imports the real pinned package and classifies every discovered tool conservatively", async () => {
    const url = OFFICIAL_PLUGIN_SOURCES["google-admin"];
    const plugin = await resolvePluginImport({ url });
    const discovery = await responseJson(
      await service().handle(request({ type: "tools/list" }, "tools/list")),
    );
    expect(plugin.manifest.name).toBe("google-admin");
    expect(plugin.remoteServers[0]?.url).toBe(
      "https://api.opencompany.chat/mcp/plugins/google-admin",
    );
    expect(plugin.capabilities.flatMap((entry) => entry.tools).sort()).toEqual([...tools].sort());
    for (const tool of discovery.result.tools) {
      const classification = classifyRemoteTool(tool, plugin.capabilities);
      expect(classification.curated).toBe(true);
      expect(classification.capability.defaultMode).toBe("ask");
      expect(classification.capability.id).toBe(tool.annotations.readOnlyHint ? "query" : "write");
    }
    expect(
      classifyRemoteTool({ name: "future_admin_tool" }, plugin.capabilities).capability.defaultMode,
    ).toBe("ask");
  });

  it("creates a user with a server-generated password and returns only a safe profile and handoff", async () => {
    mocks.apiCall.mockImplementation(async (_connection, _method, _url, options) => ({
      id: "new_user",
      primaryEmail: options.body.primaryEmail,
      password: options.body.password,
      recoveryEmail: "private@example.com",
      isAdmin: true,
    }));
    const { body } = await invoke("create_user", {
      primaryEmail: "alex@example.com",
      givenName: "Alex",
      familyName: "Chen",
      orgUnitPath: "/Engineering",
      password: "user-supplied",
      isAdmin: true,
    });
    expect(body.result.isError).not.toBe(true);
    const [connection, method, url, options] = mocks.apiCall.mock.calls[0]!;
    expect(connection).toEqual({
      userWorkosId: "user_1",
      integrationId: "integration_1",
      provider: "google_admin",
    });
    expect(method).toBe("POST");
    expect(url.origin).toBe("https://admin.googleapis.com");
    expect(url.pathname).toBe("/admin/directory/v1/users");
    expect(options.body).toMatchObject({
      primaryEmail: "alex@example.com",
      name: { givenName: "Alex", familyName: "Chen" },
      orgUnitPath: "/Engineering",
      changePasswordAtNextLogin: true,
    });
    expect(options.body.password.length).toBeGreaterThanOrEqual(40);
    expect(options.body.password).not.toBe("user-supplied");
    expect(options.body).not.toHaveProperty("isAdmin");
    expect(JSON.stringify(body)).not.toContain(options.body.password);
    expect(output(body)).toMatchObject({
      user: { id: "new_user", primaryEmail: "alex@example.com" },
      nextStep: expect.stringContaining("No invitation has been sent"),
    });
    expect(output(body).user).not.toHaveProperty("recoveryEmail");
  });

  it("scopes lists to the administrator's customer and bounds pagination", async () => {
    mocks.apiCall.mockResolvedValue({
      users: [{ id: "one", recoveryPhone: "secret" }, { id: "two" }],
      nextPageToken: "next",
    });
    const { body } = await invoke(
      "list_users",
      { pageSize: 1, pageToken: "cursor", query: "email:alex*" },
      "query",
    );
    const url = mocks.apiCall.mock.calls[0]![2];
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      customer: "my_customer",
      maxResults: "1",
      pageToken: "cursor",
      query: "email:alex*",
    });
    expect(output(body)).toEqual({ users: [{ id: "one" }], nextPageToken: "next" });
  });

  it.each([".", ".."])(
    "rejects dot-segment resource keys %s before accessing Google",
    async (userKey) => {
      const { body } = await invoke("get_user", { userKey }, "query");
      expect(body.result.isError).toBe(true);
      expect(mocks.apiCall).not.toHaveBeenCalled();
    },
  );

  it("encodes resource keys without changing the Google origin or path hierarchy", async () => {
    await invoke("get_user", { userKey: "https://evil.test/../user?x=y" }, "query");
    const url = mocks.apiCall.mock.calls[0]![2];
    expect(url.origin).toBe("https://admin.googleapis.com");
    expect(url.pathname).toBe(
      "/admin/directory/v1/users/https%3A%2F%2Fevil.test%2F..%2Fuser%3Fx%3Dy",
    );
  });

  it("creates groups and limits group edits to display fields", async () => {
    await invoke("create_group", {
      email: "eng@example.com",
      name: "Engineering",
      description: "Team",
    });
    expect(mocks.apiCall.mock.calls[0]![3].body).toEqual({
      email: "eng@example.com",
      name: "Engineering",
      description: "Team",
    });
    await invoke("update_group", {
      groupKey: "group/id",
      description: "",
      email: "renamed@example.com",
      whoCanPostMessage: "ANYONE_CAN_POST",
    });
    expect(mocks.apiCall.mock.calls[1]![1]).toBe("PATCH");
    expect(mocks.apiCall.mock.calls[1]![3].body).toEqual({ description: "" });
    const count = mocks.apiCall.mock.calls.length;
    const { body } = await invoke("update_group", { groupKey: "id" });
    expect(body.result.isError).toBe(true);
    expect(mocks.apiCall.mock.calls.length).toBe(count);
  });

  it("defaults additions to MEMBER and accepts an explicit OWNER role", async () => {
    await invoke("add_group_member", { groupKey: "eng@example.com", email: "alex@example.com" });
    expect(mocks.apiCall.mock.calls[0]![3].body).toEqual({
      email: "alex@example.com",
      role: "MEMBER",
    });
    await invoke("add_group_member", {
      groupKey: "eng@example.com",
      email: "lead@example.com",
      role: "OWNER",
    });
    expect(mocks.apiCall.mock.calls[1]![3].body.role).toBe("OWNER");
  });

  it("rejects discovery tickets used to write, mismatched tools, and mismatched capability claims", async () => {
    for (const operation of [
      { type: "tools/list" },
      { type: "tools/call", tool: "create_group", capability: "write" },
      { type: "tools/call", tool: "create_user", capability: "query" },
    ] as const) {
      const response = await service().handle(
        request(operation, "tools/call", { name: "create_user", arguments: {} }),
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it.each(["make_admin", "delete_user", "toString", "constructor"])(
    "rejects unclassified tool %s",
    async (tool) => {
      const response = await service().handle(
        request({ type: "tools/call", tool, capability: "write" }, "tools/call", { name: tool }),
      );
      expect(response.status).toBe(403);
      expect(mocks.apiCall).not.toHaveBeenCalled();
    },
  );

  it("rechecks uninstall, account identity, granted scopes, and current Off permissions", async () => {
    mocks.isActive.mockResolvedValueOnce(false);
    expect((await service().handle(request({ type: "tools/list" }, "tools/list"))).status).toBe(
      403,
    );
    for (const row of [
      { ...connectedRow, id: "another_account" },
      { ...connectedRow, status: "disconnected" },
      { ...connectedRow, scopes: [GOOGLE_ADMIN_USER_SCOPE] },
    ]) {
      mocks.loadIntegration.mockResolvedValueOnce(row);
      expect((await service().handle(request({ type: "tools/list" }, "tools/list"))).status).toBe(
        401,
      );
    }
    for (const row of [
      { ...connectedRow, capabilityModes: { write: "off" } },
      { ...connectedRow, toolModes: { create_user: "off" } },
    ]) {
      mocks.loadIntegration.mockResolvedValueOnce(row);
      expect((await invoke("create_user")).response.status).toBe(403);
    }
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures and preserves the reconnect error", async () => {
    mocks.apiCall.mockRejectedValueOnce(new Error("password=secret-provider-echo"));
    const { body } = await invoke("create_group", {
      email: "eng@example.com",
      name: "Engineering",
    });
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-provider-echo");
    mocks.apiCall.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    expect(
      output((await invoke("get_user", { userKey: "alex@example.com" }, "query")).body).error.code,
    ).toBe("auth_expired");
  });
});
