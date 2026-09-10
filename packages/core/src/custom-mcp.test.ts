import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";
import {
  type CustomMcpAccount,
  CustomMcpApplicationService,
  type CustomMcpRepository,
  type CustomMcpTransport,
} from "./custom-mcp";
import type { PluginInstallation, PluginRepository, ResolvedPluginPackage } from "./plugin-import";

const actor: Actor = {
  userId: "owner",
  workspaceId: "workspace",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "session",
};
const definition = { label: "Company tools", url: "https://tools.example.com/mcp", headers: {} };
const plugin = {
  name: "custom-test",
  source: { type: "custom_mcp", url: definition.url },
  manifest: { description: definition.label },
  status: "enabled",
} as PluginInstallation;
const account = { revision: "revision", tools: [], connected: true } as unknown as CustomMcpAccount;
const probe = { tools: [], fingerprint: "f".repeat(64) };

function fixture() {
  const plugins = {
    install: vi.fn(async () => ({ plugin, idempotentReplay: false })),
    get: vi.fn(async () => plugin),
  };
  const accounts = {
    account: vi.fn(async () => account),
    save: vi.fn(async () => account),
    credentials: vi.fn(async () => ({ headers: {} })),
    refresh: vi.fn(async () => account),
    disconnect: vi.fn(),
    setToolMode: vi.fn(),
  };
  const transport: CustomMcpTransport = {
    validate: vi.fn((definition, credentials) => ({ ...definition, ...credentials })),
    probe: vi.fn(async () => probe),
    package: vi.fn(async () => ({ manifest: { name: plugin.name } }) as ResolvedPluginPackage),
    name: vi.fn(() => plugin.name),
    error: () => "Server unavailable",
  };
  return {
    plugins,
    accounts,
    transport,
    service: new CustomMcpApplicationService(
      plugins as unknown as PluginRepository,
      accounts as CustomMcpRepository,
      transport,
    ),
  };
}

describe("custom MCP application", () => {
  it("requires plugin installation permission before testing arbitrary endpoints", async () => {
    const { service, transport } = fixture();
    const member = { ...actor, permissions: ["skill:read"] };
    await expect(service.preview(member, definition)).rejects.toThrow("Plugin write permission");
    await expect(
      service.create(member, {
        ...definition,
        fingerprint: probe.fingerprint,
        idempotencyKey: "key",
      }),
    ).rejects.toThrow("Plugin write permission");
    expect(transport.probe).not.toHaveBeenCalled();
  });
  it("requires a fresh matching discovery preview before installation", async () => {
    const { service, plugins, accounts } = fixture();
    await expect(
      service.create(actor, { ...definition, fingerprint: "old", idempotencyKey: "key" }),
    ).rejects.toThrow("tools changed");
    expect(plugins.install).not.toHaveBeenCalled();
    expect(accounts.save).not.toHaveBeenCalled();
  });
  it("does not rotate credentials or reset permissions when installation is replayed", async () => {
    const { service, plugins, accounts } = fixture();
    plugins.install.mockResolvedValue({ plugin, idempotentReplay: true });
    expect(
      (
        await service.create(actor, {
          ...definition,
          fingerprint: probe.fingerprint,
          idempotencyKey: "key",
        })
      ).idempotentReplay,
    ).toBe(true);
    expect(accounts.save).not.toHaveBeenCalled();
  });
  it("lets members connect only their own account to an installed custom endpoint", async () => {
    const { service, transport, accounts } = fixture();
    const member = { ...actor, userId: "member", role: "member", permissions: ["skill:read"] };
    await service.connect(member, plugin.name, { headers: { authorization: "synthetic" } });
    expect(transport.probe).toHaveBeenCalledWith(
      definition.url,
      expect.objectContaining({ headers: { authorization: "synthetic" } }),
    );
    expect(accounts.save).toHaveBeenCalledWith(member, plugin.name, {
      headers: { authorization: "synthetic" },
      ...probe,
    });
  });
  it("rejects account operations against disabled or noncustom plugins", async () => {
    const { service, plugins, transport } = fixture();
    plugins.get.mockResolvedValue({ ...plugin, status: "disabled" });
    await expect(service.connect(actor, plugin.name, { headers: {} })).rejects.toThrow("Enable");
    plugins.get.mockResolvedValue({ ...plugin, source: { ...plugin.source, type: "github" } });
    await expect(service.status(actor, plugin.name)).rejects.toThrow("not found");
    expect(transport.probe).not.toHaveBeenCalled();
  });
  it("records a safe refresh error in the personal status", async () => {
    const { service, accounts, transport } = fixture();
    vi.mocked(transport.probe).mockRejectedValue(new Error("raw remote error and credential"));
    await service.refresh(actor, plugin.name);
    expect(accounts.refresh).toHaveBeenCalledWith(actor, plugin.name, account.revision, {
      error: "Server unavailable",
    });
  });
});
