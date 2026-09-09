import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteMcpOperation } from "../actions/remote-mcp";
import { createConvexMcpService } from "./convex-mcp-server";
import { createConvexMcpTicket } from "./convex-mcp-ticket";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const mocks = vi.hoisted(() => ({ active: vi.fn(), row: vi.fn(), key: vi.fn(), run: vi.fn() }));
vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.active,
}));
vi.mock("./convex-mcp", () => ({
  loadConvexIntegration: mocks.row,
  loadConvexCredential: mocks.key,
}));
let key = "dev:happy-animal-123|fakekey123";
const identity = {
  userWorkosId: "u1",
  workspaceId: "w1",
  integrationId: "i1",
  registrationId: "r1",
};
const connected = { id: "i1", status: "connected", capabilityModes: {}, toolModes: {} };
const service = () =>
  createConvexMcpService({ db: {}, internalSecret: "test-secret", runCli: mocks.run });
function ticket(operation: RemoteMcpOperation) {
  return createConvexMcpTicket({
    ...identity,
    connectionVersion: "connection-version-1",
    operation,
    secret: "test-secret",
  }).ticket;
}
function request(operation: RemoteMcpOperation, method: string, params: unknown = {}) {
  return new Request("https://api.opencompany.chat/mcp/plugins/convex", {
    method: "POST",
    headers: { authorization: `Bearer ${ticket(operation)}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
function call(tool: string, capability: "read" | "query" | "draft" | "write", args: unknown = {}) {
  return request({ type: "tools/call", tool, capability }, "tools/call", {
    name: tool,
    arguments: args,
  });
}
describe("Convex hosted bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.active.mockResolvedValue(true);
    mocks.row.mockResolvedValue(connected);
    key = "dev:happy-animal-123|fakekey123";
    mocks.key.mockResolvedValue({ apiKey: key, connectionVersion: "connection-version-1" });
    mocks.run.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  });
  it("completes real SDK handshake and discovery without exposing deployment selectors", async () => {
    const bridge = service();
    const client = await createMCPClient({
      transport: {
        type: "http",
        url: "https://api.opencompany.chat/mcp/plugins/convex",
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: ticket({ type: "tools/list" }),
          onAuthorizationRequired: async () => {
            throw new Error("unauthorized");
          },
        }),
        fetch: async (url, init) => bridge.handle(new Request(url, init)),
      },
    });
    try {
      const tools = await client.tools();
      expect(Object.keys(tools).sort()).toEqual(
        [
          "status",
          "tables",
          "functionSpec",
          "data",
          "logs",
          "runOneoffQuery",
          "run",
          "envGet",
          "envList",
          "envSet",
          "envRemove",
        ].sort(),
      );
      expect(JSON.stringify(tools)).not.toContain("deploymentSelector");
      expect(mocks.run).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("requires a valid ticket before loading credentials", async () => {
    expect(
      (
        await service().handle(
          new Request("https://api.opencompany.chat/mcp/plugins/convex", { method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.key).not.toHaveBeenCalled();
  });
  it("rejects a discovery ticket used to run a function", async () => {
    const response = await service().handle(
      request({ type: "tools/list" }, "tools/call", {
        name: "run",
        arguments: { functionName: "a:b", args: "{}" },
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rejects wrong capability and unknown tools", async () => {
    expect(
      (await service().handle(call("run", "read", { functionName: "a:b", args: "{}" }))).status,
    ).toBe(403);
    expect((await service().handle(call("newTool", "write"))).status).toBe(403);
  });
  it("invalidates already minted tickets when a key is replaced", async () => {
    const req = call("tables", "read");
    mocks.key.mockResolvedValue({
      apiKey: "dev:another-animal-123|newkey123",
      connectionVersion: "connection-version-2",
    });
    expect((await service().handle(req)).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("invalidates already minted tickets when the same key is reconnected", async () => {
    const req = call("tables", "read");
    mocks.key.mockResolvedValue({ apiKey: key, connectionVersion: "connection-version-2" });
    expect((await service().handle(req)).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rechecks uninstall, disconnect, and account replacement", async () => {
    mocks.active.mockResolvedValueOnce(false);
    expect((await service().handle(call("tables", "read"))).status).toBe(403);
    mocks.row.mockResolvedValueOnce({ ...connected, status: "disconnected" });
    expect((await service().handle(call("tables", "read"))).status).toBe(401);
    mocks.row.mockResolvedValueOnce({ ...connected, id: "another-account" });
    expect((await service().handle(call("tables", "read"))).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("enforces Off and accepts a specific enabled tool override", async () => {
    expect((await service().handle(call("envList", "draft"))).status).toBe(403);
    mocks.row.mockResolvedValue({ ...connected, toolModes: { envList: "ask" } });
    expect((await service().handle(call("envList", "draft"))).status).toBe(200);
    expect(mocks.run).toHaveBeenCalledOnce();
  });
  it("passes authorized arguments to the pinned CLI", async () => {
    await service().handle(call("run", "write", { functionName: "messages:add", args: "{}" }));
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "run",
        args: { functionName: "messages:add", args: "{}" },
        apiKey: "dev:happy-animal-123|fakekey123",
      }),
    );
  });
  it.each([{ projectDir: "/etc" }, { deploymentSelector: "forged" }, { extra: true }])(
    "rejects routing overrides and unknown arguments: %j",
    async (args) => {
      const response = await service().handle(call("tables", "read", args));
      expect((await response.json()).error.code).toBe(-32602);
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );
  it("restricts production discovery and execution independently of saved permissions", async () => {
    key = "prod:happy-animal-123|fakekey123";
    mocks.key.mockResolvedValue({ apiKey: key, connectionVersion: "connection-version-1" });
    mocks.row.mockResolvedValue({
      ...connected,
      capabilityModes: { query: "on", write: "on", draft: "on" },
    });
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(
      (await response.json()).result.tools.map((t: { name: string }) => t.name).sort(),
    ).toEqual(["functionSpec", "status", "tables"]);
    expect(
      (await service().handle(call("run", "write", { functionName: "a:b", args: "{}" }))).status,
    ).toBe(403);
    expect((await service().handle(call("envList", "draft"))).status).toBe(403);
    expect((await service().handle(call("tables", "read"))).status).toBe(200);
  });
  it("bounds bodies and hides process failures", async () => {
    const oversized = await service().handle(call("run", "write", { args: "x".repeat(140_000) }));
    expect(oversized.status).toBe(413);
    mocks.run.mockRejectedValue(new Error("secret process details"));
    const response = await service().handle(call("tables", "read"));
    expect(await response.text()).not.toContain("secret process details");
  });
});
