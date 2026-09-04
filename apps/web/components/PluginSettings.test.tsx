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
  GITHUB_PLUGIN_SOURCE,
  GMAIL_PLUGIN_SOURCE,
  GOOGLE_CALENDAR_PLUGIN_SOURCE,
  GOOGLE_DRIVE_PLUGIN_SOURCE,
  LINEAR_PLUGIN_SOURCE,
  NEON_PLUGIN_SOURCE,
  OfficialSkillPluginDetail,
  PluginDetail,
  PluginsSettings,
  POSTHOG_PLUGIN_SOURCE,
  RENDER_PLUGIN_SOURCE,
  SIGNOZ_PLUGIN_SOURCE,
  SLACK_PLUGIN_SOURCE,
  STRIPE_PLUGIN_SOURCE,
  X_PLUGIN_SOURCE,
  YC_ADVISE_PLUGIN_SOURCE,
} from "./PluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toasts }));
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

const ycAdvisePreview = {
  ...officialPreview,
  manifest: {
    name: "yc-advise",
    description: "Independent YC-style startup advice and structured founder office hours.",
  },
  source: {
    ...officialPreview.source,
    ref: "2e092c3bc518622f1dc4ac1a6777d87ae3695ec6",
    path: "yc-advise",
    resolvedCommit: "2e092c3bc518622f1dc4ac1a6777d87ae3695ec6",
  },
  skills: [
    {
      path: "skills/yc-office-hours",
      name: "yc-office-hours",
      description: "Run candid, practical YC-style founder office hours.",
      integrity: `sha256:${"f".repeat(64)}`,
      fileCount: 2,
      totalBytes: 8_192,
    },
  ],
  report: {
    ...officialPreview.report,
    skills: [
      {
        path: "skills/yc-office-hours",
        name: "yc-office-hours",
        status: "valid" as const,
        integrity: `sha256:${"f".repeat(64)}`,
      },
    ],
  },
} as const satisfies PluginImportPreviewDto;
describe("Plugin settings", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    toasts.error.mockReset();
    toasts.success.mockReset();
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
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute(
      "href",
      "/settings/plugins/linear",
    );
  });

  it("offers one-click installation for every uninstalled official package", () => {
    render(<PluginsSettings plugins={[]} canEdit />);

    const linearLink = screen.getByRole("link", { name: /linear/i });
    const linearCard = linearLink.closest("li");
    expect(linearLink).toHaveAttribute("href", "/settings/plugins/linear");
    expect(screen.getByRole("searchbox", { name: "Search plugins" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Featured" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Communication" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Productivity" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Engineering" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Business" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /neon/i })).toHaveAttribute(
      "href",
      "/settings/plugins/neon",
    );
    expect(screen.getByRole("link", { name: /better stack/i })).toHaveAttribute(
      "href",
      "/settings/plugins/betterstack",
    );
    expect(screen.getByRole("link", { name: /github/i })).toHaveAttribute(
      "href",
      "/settings/plugins/github",
    );
    expect(screen.getByRole("link", { name: /gmail/i })).toHaveAttribute(
      "href",
      "/settings/plugins/gmail",
    );
    expect(screen.getByRole("link", { name: /google drive/i })).toHaveAttribute(
      "href",
      "/settings/plugins/google-drive",
    );
    expect(screen.getByRole("link", { name: /slack/i })).toHaveAttribute(
      "href",
      "/settings/plugins/slack",
    );
    expect(screen.getByRole("link", { name: /google calendar/i })).toHaveAttribute(
      "href",
      "/settings/plugins/google-calendar",
    );
    expect(screen.getByRole("link", { name: /signoz/i })).toHaveAttribute(
      "href",
      "/settings/plugins/signoz",
    );
    expect(screen.getByRole("link", { name: /render/i })).toHaveAttribute(
      "href",
      "/settings/plugins/render",
    );
    expect(screen.getByRole("link", { name: /posthog/i })).toHaveAttribute(
      "href",
      "/settings/plugins/posthog",
    );
    expect(screen.getByRole("link", { name: /stripe/i })).toHaveAttribute(
      "href",
      "/settings/plugins/stripe",
    );
    expect(screen.getByRole("link", { name: /^x/i })).toHaveAttribute(
      "href",
      "/settings/plugins/x",
    );
    expect(screen.getByRole("link", { name: /yc advise/i })).toHaveAttribute(
      "href",
      "/settings/plugins/yc-advise",
    );
    expect(GITHUB_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/github$/u,
    );
    expect(GOOGLE_DRIVE_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/dc0c91221bcfa9b6088a19277f875c438b37e96e/google-drive",
    );
    expect(LINEAR_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/linear$/u,
    );
    expect(NEON_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/neon$/u,
    );
    expect(BETTERSTACK_PLUGIN_SOURCE).toMatch(
      /^https:\/\/github\.com\/useopencompany\/plugins\/tree\/[0-9a-f]{40}\/betterstack$/u,
    );
    expect(RENDER_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/569241125c96a07b9072d42aee404822a6950b26/render",
    );
    expect(POSTHOG_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/4ba32cd5a7618d9be3714ec0efd3c8784209046c/posthog",
    );
    expect(SIGNOZ_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/053e9e9207f320651f1cb9b4e8feb84ab2af6bba/signoz",
    );
    expect(SLACK_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/1b912fe6c4f4497147887b2383f0181f763aa19b/slack",
    );
    expect(STRIPE_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/68c22e8a1ffe5eb8a83fb91c68f76f3f45705d3a/stripe",
    );
    expect(X_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/21060c09d1bbe70df85519cc3ad74cd5d097fbb6/x",
    );
    expect(GMAIL_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/587fb06ae2a4e4bed7532e216f8712979ca35e7b/gmail",
    );
    expect(GOOGLE_CALENDAR_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/de04f0c11eeb4e4eb4ed1140818205e14b08401f/google-calendar",
    );
    expect(YC_ADVISE_PLUGIN_SOURCE).toBe(
      "https://github.com/useopencompany/plugins/tree/2e092c3bc518622f1dc4ac1a6777d87ae3695ec6/yc-advise",
    );
    expect(linearCard).not.toBeNull();
    expect(
      within(linearCard as HTMLElement).getByRole("button", { name: "Install" }),
    ).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Install" })).toHaveLength(14);
    expect(previewHeadlessPluginImport).not.toHaveBeenCalled();
    expect(importHeadlessPlugin).not.toHaveBeenCalled();
  });

  it("searches the catalog and narrows it by category", async () => {
    const user = userEvent.setup();
    render(<PluginsSettings plugins={[]} canEdit />);

    const search = screen.getByRole("searchbox", { name: "Search plugins" });
    await user.type(search, "database");

    const searchResults = screen.getByRole("region", { name: "Search results" });
    expect(within(searchResults).getByRole("link", { name: /neon/i })).toBeInTheDocument();
    expect(within(searchResults).queryByRole("link", { name: /gmail/i })).not.toBeInTheDocument();

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "Business" }));

    const business = screen.getByRole("region", { name: "Business" });
    expect(within(business).getByRole("link", { name: /posthog/i })).toBeInTheDocument();
    expect(within(business).getByRole("link", { name: /stripe/i })).toBeInTheDocument();
    expect(within(business).getByRole("link", { name: /yc advise/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /gmail/i })).not.toBeInTheDocument();
  });

  it("opens a full category from its overview section", async () => {
    const user = userEvent.setup();
    render(<PluginsSettings plugins={[]} canEdit />);

    await user.click(screen.getByRole("button", { name: "View all engineering plugins" }));

    const engineering = screen.getByRole("region", { name: "Engineering" });
    expect(within(engineering).getAllByRole("link")).toHaveLength(5);
    expect(within(engineering).getByRole("link", { name: /github/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Engineering" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("recovers from an empty search", async () => {
    const user = userEvent.setup();
    render(<PluginsSettings plugins={[]} canEdit />);

    await user.type(screen.getByRole("searchbox", { name: "Search plugins" }), "no-such-plugin");
    expect(screen.getByText("No plugins found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("region", { name: "Featured" })).toBeInTheDocument();
  });

  it("installs from the overview and opens the installed plugin page", async () => {
    const user = userEvent.setup();
    let finishPreview: ((preview: PluginImportPreviewDto) => void) | undefined;
    vi.mocked(previewHeadlessPluginImport).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve;
        }),
    );

    render(<PluginsSettings plugins={[]} canEdit />);

    const linearCard = screen.getByRole("link", { name: /linear/i }).closest("li");
    expect(linearCard).not.toBeNull();
    await user.click(within(linearCard as HTMLElement).getByRole("button", { name: "Install" }));

    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Install" })[0]).toBeDisabled();

    finishPreview?.(officialPreview);

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/settings/plugins/linear");
    });
    expect(previewHeadlessPluginImport).toHaveBeenCalledWith({ url: LINEAR_PLUGIN_SOURCE });
    expect(importHeadlessPlugin).toHaveBeenCalledWith({
      url: LINEAR_PLUGIN_SOURCE,
      expectedResolvedCommit: officialPreview.source.resolvedCommit,
      expectedIntegrity: officialPreview.integrity,
    });
    expect(toasts.success).toHaveBeenCalledWith("Linear installed.");
  });

  it("keeps the user on the overview and allows a retry when installation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(previewHeadlessPluginImport).mockRejectedValue(
      new Error("Package source unavailable."),
    );

    render(<PluginsSettings plugins={[]} canEdit />);

    const linearCard = screen.getByRole("link", { name: /linear/i }).closest("li");
    expect(linearCard).not.toBeNull();
    const installButton = within(linearCard as HTMLElement).getByRole("button", {
      name: "Install",
    });
    await user.click(installButton);

    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith(
        "Couldn't install Linear. Package source unavailable.",
      );
    });
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(installButton).toBeEnabled();
    });
  });

  it("previews and installs an official skills-only package from its detail page", async () => {
    vi.mocked(previewHeadlessPluginImport).mockResolvedValue(ycAdvisePreview);
    vi.mocked(importHeadlessPlugin).mockResolvedValue({
      plugin: {
        ...plugin,
        name: "yc-advise",
        manifest: ycAdvisePreview.manifest,
        stdioServers: [],
      },
      replayed: false,
    });

    render(<OfficialSkillPluginDetail name="yc-advise" canEdit />);

    expect(screen.getByRole("button", { name: "Loading package…" })).toBeDisabled();
    expect(await screen.findByText("yc-office-hours")).toBeInTheDocument();
    expect(screen.getByText(/no account connection is required/i)).toBeInTheDocument();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton).toBeEnabled();
    await userEvent.click(installButton);

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(importHeadlessPlugin).toHaveBeenCalledWith({
      url: YC_ADVISE_PLUGIN_SOURCE,
      expectedResolvedCommit: ycAdvisePreview.source.resolvedCommit,
      expectedIntegrity: ycAdvisePreview.integrity,
    });
    expect(toasts.success).toHaveBeenCalledWith("YC Advise installed.");
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

  it("shows a neutral empty MCP state for skills-only packages", () => {
    render(<PluginDetail plugin={{ ...plugin, stdioServers: [] }} canEdit />);

    expect(
      screen.getByText(
        "An immutable Agent Plugin package with passive Skills and no executable MCP servers.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This plugin does not include executable MCP servers."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/approve exact package/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/installation alone never starts/i)).not.toBeInTheDocument();
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
