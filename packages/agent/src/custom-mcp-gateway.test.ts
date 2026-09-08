import type { CustomMcpAccount } from "@opencompany/core";
import type { PluginGatewayRegistrationRecord } from "@opencompany/db/plugin-gateway-repository";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  credentials: vi.fn(),
  failure: vi.fn(),
  active: vi.fn(),
  client: vi.fn(),
  list: vi.fn(),
  call: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: mocks.client }));
vi.mock("@opencompany/db/custom-mcp-repository", async (original) => ({
  ...(await original<object>()),
  PostgresCustomMcpRepository: class {
    account = mocks.account;
    credentials = mocks.credentials;
    recordFailure = mocks.failure;
  },
}));
vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.active,
}));
vi.mock("@opencompany/analytics/product/server", () => ({ captureProductServerEvent: vi.fn() }));

import { resolveRemoteMcpActions } from "./actions/remote-mcp";
import { ACTION_EFFECTS_WRITE } from "./actions/types";
import { bindCustomMcpRegistration, probeCustomMcp } from "./custom-mcp";

const identity = { userWorkosId: "owner", workspaceId: "workspace" };
const record = {
  id: "registration",
  pluginName: "custom-test",
  pluginDescription: "Company tools",
  server: {
    name: "mcp",
    type: "streamable-http",
    url: "https://tools.example.com/mcp",
    headers: {},
  },
} as PluginGatewayRegistrationRecord;
const rawTool = {
  name: "send",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const context = {
  ...identity,
  currentDate: new Date(),
  userTimezone: "UTC",
  signal: new AbortController().signal,
};
let account: CustomMcpAccount;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.active.mockResolvedValue(true);
  mocks.credentials.mockResolvedValue({ headers: { Authorization: "Bearer synthetic-canary" } });
  mocks.client.mockResolvedValue({
    listTools: mocks.list,
    callTool: mocks.call,
    close: mocks.close,
    toolsFromDefinitions: vi.fn(),
  });
  mocks.list.mockResolvedValue({ tools: [rawTool] });
  mocks.close.mockResolvedValue(undefined);
  const probe = await probeCustomMcp(record.server.url, { headers: {} });
  account = {
    integrationId: "account",
    revision: "revision-1",
    tools: probe.tools,
    toolModes: {},
    connected: true,
    checkedAt: new Date(),
    error: null,
  };
  mocks.account.mockImplementation(async () => account);
  mocks.client.mockClear();
  mocks.list.mockClear();
});

it("defaults even advertised read-only tools to Ask and binds approval to this personal revision", async () => {
  const registration = await bindCustomMcpRegistration({}, identity, record);
  const catalog = await resolveRemoteMcpActions(identity, registration);
  expect(catalog?.actions[0]).toMatchObject({
    permissionMode: "ask",
    effects: ACTION_EFFECTS_WRITE,
    approvalContext: "registration:account:revision-1",
  });
  expect(JSON.stringify(catalog)).not.toContain("synthetic-canary");
  expect(JSON.stringify(catalog)).not.toContain(record.server.url);
  expect(mocks.client).not.toHaveBeenCalled();
});

it("rechecks definitions before dispatch, scrubs results, and uses the custom client without OAuth", async () => {
  const registration = await bindCustomMcpRegistration({}, identity, record);
  const catalog = await resolveRemoteMcpActions(identity, registration, {
    recordDispatch: vi.fn(),
  });
  mocks.call.mockResolvedValue({ content: [{ type: "text", text: "Result synthetic-canary" }] });
  const output = await catalog!.actions[0]!.execute({}, context);
  expect(JSON.stringify(output)).not.toContain("synthetic-canary");
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(mocks.call).toHaveBeenCalledOnce();
  expect(mocks.client).toHaveBeenCalledWith(
    expect.objectContaining({
      maxRetries: 0,
      transport: { type: "http", url: record.server.url, fetch: expect.any(Function) },
    }),
  );
});

it("blocks calls after remote definitions change and reports a refresh action", async () => {
  const registration = await bindCustomMcpRegistration({}, identity, record);
  const catalog = await resolveRemoteMcpActions(identity, registration, {
    recordDispatch: vi.fn(),
  });
  mocks.list.mockResolvedValue({ tools: [{ ...rawTool, description: "Changed behavior" }] });
  await expect(catalog!.actions[0]!.execute({}, context)).rejects.toThrow(
    "Refresh tools in Plugins",
  );
  expect(mocks.call).not.toHaveBeenCalled();
  expect(mocks.failure).toHaveBeenCalledWith(
    { userId: identity.userWorkosId, workspaceId: identity.workspaceId },
    record.pluginName,
    "revision-1",
    expect.stringContaining("Refresh tools"),
  );
});

it("rejects another member, rotated credentials, Off tools, and disabled installations before client creation", async () => {
  const registration = await bindCustomMcpRegistration({}, identity, record);
  const catalog = await resolveRemoteMcpActions(identity, registration);
  const action = catalog!.actions[0]!;
  await expect(action.execute({}, { ...context, userWorkosId: "teammate" })).rejects.toThrow();
  account = { ...account, revision: "revision-2" };
  await expect(action.execute({}, context)).rejects.toThrow();
  account = { ...account, revision: "revision-1", toolModes: { send: "off" } };
  await expect(action.execute({}, context)).rejects.toThrow("permission changed");
  mocks.active.mockResolvedValue(false);
  await expect(action.execute({}, context)).rejects.toThrow("disabled");
  expect(mocks.client).not.toHaveBeenCalled();
});

it("does not obtain another member's connection for an unconnected actor", async () => {
  mocks.account.mockResolvedValue(null);
  const registration = await bindCustomMcpRegistration({}, identity, record);
  expect(await resolveRemoteMcpActions(identity, registration)).toBeNull();
  expect(
    await registration.loadConnection({
      ...identity,
      operation: { type: "tools/list" },
      onAuthorizationRequired: () => {
        throw new Error("OAuth must not run");
      },
    }),
  ).toEqual({ ok: false, reason: "not_connected" });
  expect(mocks.credentials).not.toHaveBeenCalled();
});
