import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginDetail, PluginsSettings } from "./PluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/headless-knowledge-commands", () => ({
  approveHeadlessPluginMcp: vi.fn(),
  archiveHeadlessPlugin: vi.fn(),
  deleteHeadlessPluginData: vi.fn(),
  disableHeadlessPlugin: vi.fn(),
  enableHeadlessPlugin: vi.fn(),
  importHeadlessPlugin: vi.fn(),
  previewHeadlessPluginImport: vi.fn(),
  revokeHeadlessPluginMcp: vi.fn(),
}));

const plugin = {
  id: "plugin_1",
  name: "quality-tools",
  status: "enabled" as const,
  manifest: { name: "quality-tools", description: "Quality helpers." },
  source: {
    type: "github" as const,
    url: "https://github.com/example/plugins",
    ref: "main",
    path: "plugins/quality-tools",
    resolvedCommit: "a".repeat(40),
  },
  integrity: `sha256:${"b".repeat(64)}`,
  files: [{ path: "plugin.json", executable: false, sizeBytes: 128 }],
  skills: [
    {
      name: "review",
      path: "skills/review",
      bundleId: "bundle_1",
      integrity: `sha256:${"c".repeat(64)}`,
      description: "Review code.",
    },
  ],
  stdioServers: [
    {
      name: "local",
      type: "stdio" as const,
      command: "./server",
      args: ["--safe"],
      cwd: "${PLUGIN_DATA}",
      envKeys: ["PRIVATE_TOKEN"],
    },
  ],
  installReport: {
    ignoredManifestFields: ["futureField"],
    skills: [
      {
        path: "skills/review",
        name: "review",
        status: "valid" as const,
        integrity: `sha256:${"c".repeat(64)}`,
      },
      {
        path: "skills/broken",
        name: "broken",
        status: "skipped" as const,
        reason: "Name mismatch.",
      },
    ],
    mcp: {
      present: true as const,
      status: "parsed" as const,
      reports: [
        { name: "local", status: "selected" as const, transport: "stdio" as const },
        {
          name: "remote",
          status: "unsupported" as const,
          transport: "streamable-http" as const,
          reason: "Not launched.",
        },
      ],
    },
    collisions: [
      {
        skillName: "review",
        winner: { source: "standalone" as const },
        hiddenPluginNames: ["quality-tools"],
      },
    ],
  },
  mcpApprovedIntegrity: null,
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
  archivedAt: null,
};

describe("Plugin settings", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
  });

  it("lists package component counts", () => {
    render(
      <PluginsSettings
        plugins={[
          {
            id: plugin.id,
            name: plugin.name,
            status: plugin.status,
            manifest: plugin.manifest,
            source: plugin.source,
            integrity: plugin.integrity,
            installReport: plugin.installReport,
            mcpApprovedIntegrity: plugin.mcpApprovedIntegrity,
            createdAt: plugin.createdAt,
            updatedAt: plugin.updatedAt,
            archivedAt: plugin.archivedAt,
            fileCount: 1,
            skillCount: 1,
            stdioServerCount: 1,
          },
        ]}
        canEdit
      />,
    );

    expect(screen.getByRole("link", { name: /quality-tools/i })).toHaveAttribute(
      "href",
      "/settings/plugins/quality-tools",
    );
    expect(screen.getByText(/1 skill · 1 stdio server/i)).toBeInTheDocument();
  });

  it("shows the exact MCP approval boundary without exposing environment values", () => {
    render(<PluginDetail plugin={plugin} canEdit />);

    expect(screen.getByRole("heading", { name: "Passive skills (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Executable MCP servers (1)" })).toBeInTheDocument();
    expect(screen.getByText("https://github.com/example/plugins")).toBeInTheDocument();
    expect(screen.getByText("plugins/quality-tools")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getAllByText("a".repeat(40))).toHaveLength(2);
    expect(screen.getAllByText(`sha256:${"b".repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getByText("local")).toBeInTheDocument();
    expect(screen.getByText("./server")).toBeInTheDocument();
    expect(screen.getByText("--safe")).toBeInTheDocument();
    expect(screen.getByText("${PLUGIN_DATA}")).toBeInTheDocument();
    expect(screen.getByText("PRIVATE_TOKEN")).toBeInTheDocument();
    expect(screen.queryByText("do-not-expose-env-value")).not.toBeInTheDocument();
    expect(screen.getByText(/Skipped skills\/broken: Name mismatch/i)).toBeInTheDocument();
    expect(screen.getByText(/resolves to the standalone skill/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve exact package/i })).toBeInTheDocument();
  });

  it("offers revocation only for the currently approved integrity", () => {
    render(<PluginDetail plugin={{ ...plugin, mcpApprovedIntegrity: plugin.integrity }} canEdit />);

    expect(screen.getByText(/approved for this exact package/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke MCP/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve exact package/i }),
    ).not.toBeInTheDocument();
  });
});
