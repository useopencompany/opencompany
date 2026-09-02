import "@testing-library/jest-dom/vitest";
import type { PluginImportPreviewDto } from "@opencompany/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  importHeadlessPlugin,
  previewHeadlessPluginImport,
} from "@/lib/headless-knowledge-commands";
import {
  BETTERSTACK_PLUGIN_SOURCE,
  LINEAR_PLUGIN_SOURCE,
  NEON_PLUGIN_SOURCE,
  PluginDetail,
  PluginsSettings,
} from "./PluginSettings";

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
  refreshHeadlessPluginMcp: vi.fn(),
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
  remoteMcpServers: [],
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

const officialPreview = {
  manifest: { name: "linear", description: "Linear workflows." },
  source: {
    type: "github",
    url: "https://github.com/useopencompany/plugins",
    ref: "775df7a9a37f5585b9b87a26533ba6ed1035f1dc",
    path: "linear",
    resolvedCommit: "775df7a9a37f5585b9b87a26533ba6ed1035f1dc",
  },
  integrity: `sha256:${"d".repeat(64)}`,
  files: [{ path: "plugin.json", sizeBytes: 128 }],
  fileCount: 1,
  totalBytes: 128,
  skills: [],
  stdioServers: [],
  remoteMcpServers: [],
  report: { ignoredManifestFields: [], skills: [], mcp: { status: "absent" } },
} as const satisfies PluginImportPreviewDto;

describe("Plugin settings", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    vi.mocked(previewHeadlessPluginImport).mockReset();
    vi.mocked(previewHeadlessPluginImport).mockResolvedValue(officialPreview);
    vi.mocked(importHeadlessPlugin).mockReset();
    vi.mocked(importHeadlessPlugin).mockResolvedValue({
      plugin: { ...plugin, name: "linear", manifest: officialPreview.manifest },
      replayed: false,
    });
  });

  it("shows the installed Linear card", () => {
    render(
      <PluginsSettings
        plugins={[
          {
            id: plugin.id,
            name: "linear",
            status: plugin.status,
            manifest: { name: "Linear", description: "Linear workflows." },
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

    expect(screen.getByRole("link", { name: /linear/i })).toHaveAttribute(
      "href",
      "/settings/plugins/linear",
    );
    expect(screen.getByText(/1 skill · updated/i)).toBeInTheDocument();
  });

  it("offers immutable official MCP packages before installation", async () => {
    render(<PluginsSettings plugins={[]} canEdit />);

    const linearLink = screen.getByRole("link", { name: /linear/i });
    const linearCard = linearLink.closest("div.border");
    expect(linearLink).toHaveAttribute("href", "/settings/plugins/linear");
    expect(screen.getByRole("link", { name: /neon/i })).toHaveAttribute(
      "href",
      "/settings/plugins/neon",
    );
    expect(screen.getByRole("link", { name: /better stack/i })).toHaveAttribute(
      "href",
      "/settings/plugins/betterstack",
    );
    expect(screen.getAllByText("Not installed")).toHaveLength(3);
    expect(screen.getAllByText("Official package · ready to install")).toHaveLength(3);
    expect(LINEAR_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/linear$/u,
    );
    expect(NEON_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/neon$/u,
    );
    expect(BETTERSTACK_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/betterstack$/u,
    );
    expect(linearCard).not.toBeNull();
    await userEvent.click(
      within(linearCard as HTMLElement).getByRole("button", { name: "Install" }),
    );
    await waitFor(() =>
      expect(previewHeadlessPluginImport).toHaveBeenCalledWith({ url: LINEAR_PLUGIN_SOURCE }),
    );
    expect(importHeadlessPlugin).toHaveBeenCalledWith({
      url: LINEAR_PLUGIN_SOURCE,
      expectedResolvedCommit: officialPreview.source.resolvedCommit,
      expectedIntegrity: officialPreview.integrity,
    });
    expect(router.push).toHaveBeenCalledWith("/settings/plugins/linear");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the exact MCP approval boundary without exposing environment values", () => {
    render(<PluginDetail plugin={plugin} canEdit />);

    expect(screen.getByRole("heading", { name: "Passive skills (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Executable MCP servers (1)" })).toBeInTheDocument();
    expect(screen.getByText("https://github.com/example/plugins")).toBeInTheDocument();
    expect(screen.getByText("plugins/quality-tools")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    const advancedDetails = screen.getByText("Advanced package details").closest("details");
    expect(advancedDetails).not.toHaveAttribute("open");
    expect(screen.getAllByText("a".repeat(40))).toHaveLength(1);
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

  it("hides approval while disabled but keeps revocation available", () => {
    const { rerender } = render(
      <PluginDetail plugin={{ ...plugin, status: "disabled" }} canEdit />,
    );

    expect(screen.getByText(/enable it before approving/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve exact package/i }),
    ).not.toBeInTheDocument();

    rerender(
      <PluginDetail
        plugin={{ ...plugin, status: "disabled", mcpApprovedIntegrity: plugin.integrity }}
        canEdit
      />,
    );

    expect(screen.getByRole("button", { name: /revoke MCP/i })).toBeInTheDocument();
  });
});
