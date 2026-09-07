import { describe, expect, it, vi } from "vitest";
import { CoreError } from "./chat";
import {
  PluginImportApplicationService,
  type PluginImportResolver,
  type PluginRepository,
  type ResolvedPluginPackage,
} from "./plugin-import";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "session" as const,
};
const resolvedCommit = "a".repeat(40);
const integrity = `sha256:${"b".repeat(64)}`;
const plugin: ResolvedPluginPackage = {
  manifest: { name: "quality-tools", description: "Quality helpers." },
  source: {
    type: "github",
    url: "https://github.com/example/plugins",
    ref: "main",
    path: "",
    resolvedCommit,
  },
  integrity,
  files: [
    {
      path: "plugin.json",
      content: new TextEncoder().encode("private package bytes"),
      executable: false,
    },
  ],
  fileCount: 1,
  totalBytes: 21,
  skills: [],
  stdioServers: [
    {
      name: "local",
      type: "stdio",
      command: "./server",
      args: [],
      env: { PRIVATE_TOKEN: "secret-value" },
    },
  ],
  remoteServers: [],
  capabilities: [],
  events: [],
  report: {
    ignoredManifestFields: [],
    skills: [],
    mcp: {
      present: true,
      status: "parsed",
      reports: [{ name: "local", status: "selected", transport: "stdio" }],
    },
  },
};

describe("PluginImportApplicationService", () => {
  it("checks write permission before resolving a package", async () => {
    const resolver = { resolve: vi.fn() } satisfies PluginImportResolver;
    const service = new PluginImportApplicationService(repository(), resolver);

    await expect(
      service.preview({ ...actor, permissions: [] }, { url: "example/plugins" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("keeps package bytes and MCP environment values out of previews", async () => {
    const service = new PluginImportApplicationService(repository(), resolver(plugin));

    const preview = await service.preview(actor, { url: "example/plugins" });

    expect(preview).toMatchObject({
      manifest: { name: "quality-tools" },
      files: [{ path: "plugin.json", sizeBytes: 21 }],
      stdioServers: [{ name: "local", envKeys: ["PRIVATE_TOKEN"] }],
    });
    expect(preview).not.toHaveProperty("files.0.content");
    expect(preview).not.toHaveProperty("files.0.executable");
    expect(preview).not.toHaveProperty("stdioServers.0.env");
    expect(JSON.stringify(preview)).not.toContain("secret-value");
  });

  it("installs only the exact previewed commit and integrity", async () => {
    const install = vi.fn(async () => ({ plugin: {} as never, idempotentReplay: false }));
    const service = new PluginImportApplicationService(repository({ install }), resolver(plugin));

    await service.install(actor, {
      idempotencyKey: "plugin-install-1",
      url: "example/plugins",
      expectedResolvedCommit: resolvedCommit,
      expectedIntegrity: integrity,
    });

    expect(install).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "plugin-install-1",
      plugin,
    });
  });

  it("rejects package drift before persistence", async () => {
    const install = vi.fn();
    const service = new PluginImportApplicationService(repository({ install }), resolver(plugin));

    await expect(
      service.install(actor, {
        idempotencyKey: "plugin-install-1",
        url: "example/plugins",
        expectedResolvedCommit: "c".repeat(40),
        expectedIntegrity: integrity,
      }),
    ).rejects.toEqual(
      new CoreError(
        "conflict",
        "This plugin changed since the preview. Preview it again before installing.",
      ),
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("refreshes gateway discovery after install, enable, and an explicit refresh", async () => {
    const storedPlugin = { name: "quality-tools", status: "enabled" } as never;
    const install = vi.fn(async () => ({ plugin: storedPlugin, idempotentReplay: false }));
    const setStatus = vi.fn(async () => storedPlugin);
    const get = vi.fn(async () => storedPlugin);
    const refresh = vi.fn(async () => undefined);
    const service = new PluginImportApplicationService(
      repository({ install, setStatus, get }),
      resolver(plugin),
      { refresh },
    );

    await service.install(actor, {
      idempotencyKey: "plugin-install-1",
      url: "example/plugins",
      expectedResolvedCommit: resolvedCommit,
      expectedIntegrity: integrity,
    });
    await service.setEnabled(actor, "quality-tools", false);
    await service.setEnabled(actor, "quality-tools", true);
    await service.refreshMcp(actor, "quality-tools");

    expect(refresh).toHaveBeenNthCalledWith(1, {
      actor,
      pluginName: "quality-tools",
      reason: "install",
    });
    expect(refresh).toHaveBeenNthCalledWith(2, {
      actor,
      pluginName: "quality-tools",
      reason: "enable",
    });
    expect(refresh).toHaveBeenNthCalledWith(3, {
      actor,
      pluginName: "quality-tools",
      reason: "explicit",
    });
  });
});

function resolver(value: ResolvedPluginPackage): PluginImportResolver {
  return { resolve: vi.fn(async () => value) };
}

function repository(overrides: Partial<PluginRepository> = {}): PluginRepository {
  return {
    install: vi.fn(async () => ({ plugin: {} as never, idempotentReplay: false })),
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    setStatus: vi.fn(async () => ({}) as never),
    setEventEnabled: vi.fn(async () => ({}) as never),
    approveMcp: vi.fn(async () => ({}) as never),
    revokeMcp: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => undefined),
    deleteData: vi.fn(async () => ({ deleted: false })),
    ...overrides,
  };
}
