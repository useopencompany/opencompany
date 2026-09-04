import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS } from "./artifact-policy";
import { PluginResolverError, resolvePlugin } from "./plugin-resolver";
import type { SkillResolverFetcher, SkillTreeEntry } from "./skill-resolver";

const encoder = new TextEncoder();

describe("resolvePlugin", () => {
  it("retains the complete package, copies valid skills, and registers remote MCP", async () => {
    const files = new Map<string, Uint8Array>([
      [
        "plugin.json",
        text(
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "quality-tools",
            description: "Quality helpers.",
            futureField: true,
          }),
        ),
      ],
      [
        "skills/review/SKILL.md",
        text("---\nname: review\ndescription: Review code.\n---\nReview carefully."),
      ],
      ["skills/review/scripts/check.sh", text("#!/bin/sh\nexit 0\n")],
      ["skills/broken/SKILL.md", text("---\nname: wrong-name\ndescription: Broken.\n---\nNope.")],
      [
        "mcp.json",
        text(
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            mcpServers: {
              local: {
                type: "stdio",
                command: "./server",
                args: ["--root", "${PLUGIN_ROOT}"],
                env: { TOKEN: "${PLUGIN_DATA}/token" },
              },
              remote: { type: "streamable-http", url: "https://example.com/mcp" },
            },
          }),
        ),
      ],
      ["server", Uint8Array.of(0, 1, 2, 3)],
    ]);

    const plugin = await resolvePlugin({
      url: "https://github.com/example/plugins",
      fetcher: fetcher(files, new Set(["skills/review/scripts/check.sh", "server"])),
    });

    expect(plugin).toMatchObject({
      manifest: { name: "quality-tools", description: "Quality helpers." },
      source: {
        type: "github",
        url: "https://github.com/example/plugins",
        ref: "main",
        path: "",
      },
      resolvedCommit: "a".repeat(40),
      fileCount: 6,
      skills: [
        {
          name: "review",
          path: "skills/review",
          body: "Review carefully.",
          fileCount: 2,
        },
      ],
      stdioServers: [
        {
          name: "local",
          command: "./server",
          env: { TOKEN: "${PLUGIN_DATA}/token" },
        },
      ],
      remoteServers: [
        {
          name: "remote",
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: {},
        },
      ],
      capabilities: [],
      report: {
        ignoredManifestFields: ["futureField"],
        skills: [
          expect.objectContaining({ name: "broken", status: "skipped" }),
          expect.objectContaining({ name: "review", status: "valid" }),
        ],
        mcp: {
          status: "parsed",
          reports: [
            expect.objectContaining({ name: "local", status: "selected" }),
            expect.objectContaining({ name: "remote", status: "gateway-registered" }),
          ],
        },
        capabilities: { status: "absent" },
      },
    });
    expect(plugin.integrity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plugin.files.find((file) => file.path === "server")).toMatchObject({
      executable: true,
      content: Uint8Array.of(0, 1, 2, 3),
    });
    expect(plugin.skills[0]!.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/check.sh",
    ]);
  });

  it("rejects a manifest violation before fetching the rest of the package", async () => {
    const files = new Map<string, Uint8Array>([
      ["plugin.json", text(JSON.stringify({ name: "missing-schema" }))],
      ["payload.bin", Uint8Array.of(1, 2, 3)],
    ]);
    const boundary = fetcher(files);

    await expect(
      resolvePlugin({ url: "example/plugins", fetcher: boundary }),
    ).rejects.toBeInstanceOf(PluginResolverError);
    expect(boundary.fetchBlob).toHaveBeenCalledTimes(1);
    expect(boundary.fetchBlob).toHaveBeenCalledWith(
      "example",
      "plugins",
      "a".repeat(40),
      "plugin.json",
    );
  });

  it("rejects declared per-file and total sizes before fetching any blob", async () => {
    const manifest = text(
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "bounded-plugin",
      }),
    );
    const files = new Map<string, Uint8Array>([["plugin.json", manifest]]);
    for (let index = 0; index < 9; index += 1) {
      files.set(`payload-${index}.bin`, Uint8Array.of(index));
    }

    const oversizedFileEntries = treeEntries(files);
    oversizedFileEntries.find((entry) => entry.path === "payload-0.bin")!.size =
      PLUGIN_LIMITS.maxFileBytes + 1;
    const oversizedFileBoundary = fetcher(files, new Set(), oversizedFileEntries);
    await expect(
      resolvePlugin({ url: "example/plugins", fetcher: oversizedFileBoundary }),
    ).rejects.toThrow("Plugin contains a file larger than the 2 MB limit.");
    expect(oversizedFileBoundary.fetchBlob).not.toHaveBeenCalled();

    const oversizedTreeEntries = treeEntries(files);
    for (const entry of oversizedTreeEntries) {
      if (entry.path !== "plugin.json") entry.size = PLUGIN_LIMITS.maxFileBytes;
    }
    const oversizedTreeBoundary = fetcher(files, new Set(), oversizedTreeEntries);
    await expect(
      resolvePlugin({ url: "example/plugins", fetcher: oversizedTreeBoundary }),
    ).rejects.toThrow("Plugin is too large (max 16 MB).");
    expect(oversizedTreeBoundary.fetchBlob).not.toHaveBeenCalled();
  });

  it("rejects symlinks anywhere in the selected package", async () => {
    const files = new Map<string, Uint8Array>([
      [
        "plugin.json",
        text(
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "safe-plugin",
          }),
        ),
      ],
      ["linked", text("elsewhere")],
    ]);
    const entries = treeEntries(files);
    entries.find((entry) => entry.path === "linked")!.mode = "120000";

    await expect(
      resolvePlugin({ url: "example/plugins", fetcher: fetcher(files, new Set(), entries) }),
    ).rejects.toThrow(/symlink/iu);
  });

  it("normalizes repeated separators in a selected plugin path", async () => {
    const files = new Map<string, Uint8Array>([
      [
        "packages/tool/plugin.json",
        text(
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "safe-plugin",
          }),
        ),
      ],
    ]);

    const plugin = await resolvePlugin({
      url: "example/plugins",
      selectedPath: "///packages////tool///",
      fetcher: fetcher(files),
    });

    expect(plugin.source.path).toBe("packages/tool");
  });

  it("does not honor capability claims outside the reviewed source allowlist", async () => {
    const files = new Map<string, Uint8Array>([
      [
        "plugin.json",
        text(
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "untrusted-plugin",
            extensions: {
              "so.opencompany.capabilities": {
                read: {
                  label: "Everything is safe",
                  defaultMode: "on",
                  tools: ["delete_everything"],
                },
              },
            },
          }),
        ),
      ],
    ]);

    const plugin = await resolvePlugin({
      url: "example/plugins",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/opencompany-experimental"],
    });

    expect(plugin.capabilities).toEqual([]);
    expect(plugin.report.capabilities).toMatchObject({ present: true, status: "ignored" });
  });

  it("loads the official Linear package fixture cleanly through the shipped resolver", async () => {
    const fixtureRoot = fileURLToPath(new URL("./test-fixtures/plugins/linear", import.meta.url));
    const files = await fixtureFiles(fixtureRoot, "linear");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "linear",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "linear", version: "1.0.0" });
    expect(plugin.skills.map((skill) => skill.name)).toEqual([
      "linear-issue-drafting",
      "linear-status-reporting",
      "linear-triage",
    ]);
    expect(plugin.stdioServers).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "linear",
        type: "streamable-http",
        url: "https://mcp.linear.app/mcp",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      expect.objectContaining({
        id: "read",
        label: "Read Linear",
        defaultMode: "on",
        tools: expect.arrayContaining(["list_issues", "get_issue"]),
      }),
      expect.objectContaining({
        id: "write",
        label: "Manage issues",
        defaultMode: "ask",
        tools: ["save_issue", "save_comment"],
      }),
    ]);
    expect(plugin.report.skills.every((entry) => entry.status === "valid")).toBe(true);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "linear", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the official Better Stack package with its reviewed permission boundary", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("./test-fixtures/plugins/betterstack", import.meta.url),
    );
    const files = await fixtureFiles(fixtureRoot, "betterstack");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "betterstack",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "betterstack", version: "1.0.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.stdioServers).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "betterstack",
        type: "streamable-http",
        url: "https://mcp.betterstack.com",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      expect.objectContaining({
        id: "read",
        label: "Search Better Stack docs",
        defaultMode: "on",
        tools: ["documentation"],
      }),
      expect.objectContaining({
        id: "query",
        label: "Inspect observability data",
        defaultMode: "ask",
        tools: expect.arrayContaining(["query", "errors", "team_members"]),
      }),
      expect.objectContaining({
        id: "write",
        label: "Manage Better Stack",
        defaultMode: "ask",
        tools: expect.arrayContaining(["create_monitor", "remove_dashboard"]),
      }),
    ]);
    expect(plugin.capabilities.flatMap((capability) => capability.tools)).toHaveLength(107);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "betterstack", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the opencompany Google Calendar package with every exposed tool classified", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("./test-fixtures/plugins/google-calendar", import.meta.url),
    );
    const files = await fixtureFiles(fixtureRoot, "google-calendar");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "google-calendar",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "google-calendar", version: "1.1.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "google-calendar",
        type: "streamable-http",
        url: "https://api.opencompany.chat/mcp/plugins/google-calendar",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      {
        id: "read",
        label: "Check calendars",
        defaultMode: "ask",
        tools: ["list_calendars"],
      },
      {
        id: "query",
        label: "Read calendar events",
        defaultMode: "ask",
        tools: ["list_events", "get_event"],
      },
      {
        id: "write",
        label: "Manage calendar events",
        defaultMode: "ask",
        tools: ["create_event"],
      },
    ]);
    expect(plugin.capabilities.flatMap((capability) => capability.tools)).toHaveLength(4);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "google-calendar", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the official SigNoz package with sensitive telemetry behind Ask", async () => {
    const fixtureRoot = fileURLToPath(new URL("./test-fixtures/plugins/signoz", import.meta.url));
    const files = await fixtureFiles(fixtureRoot, "signoz");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "signoz",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "signoz", version: "1.0.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "signoz",
        type: "streamable-http",
        url: "https://mcp.us.signoz.cloud/mcp",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      expect.objectContaining({
        id: "read",
        defaultMode: "on",
        tools: ["signoz_fetch_doc", "signoz_search_docs"],
      }),
      expect.objectContaining({
        id: "query",
        defaultMode: "ask",
        tools: expect.arrayContaining(["signoz_search_logs", "signoz_get_trace_details"]),
      }),
      expect.objectContaining({
        id: "write",
        defaultMode: "ask",
        tools: expect.arrayContaining(["signoz_create_alert", "signoz_delete_dashboard"]),
      }),
    ]);
    expect(plugin.capabilities.flatMap((capability) => capability.tools)).toHaveLength(43);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "signoz", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the official PostHog package with every reviewed analytics tool classified", async () => {
    const fixtureRoot = fileURLToPath(new URL("./test-fixtures/plugins/posthog", import.meta.url));
    const files = await fixtureFiles(fixtureRoot, "posthog");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "posthog",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "posthog", version: "1.0.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.stdioServers).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "posthog",
        type: "streamable-http",
        url: "https://mcp.posthog.com/mcp?mode=tools&tools=dashboards-get-all,dashboard-get,dashboard-insights-run,insights-list,insight-get,insight-query,read-data-schema,query-trends,query-funnel,query-retention,query-paths,query-stickiness,query-lifecycle,insight-create",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      {
        id: "read",
        label: "Read analytics",
        defaultMode: "on",
        tools: [
          "dashboards-get-all",
          "dashboard-get",
          "dashboard-insights-run",
          "insights-list",
          "insight-get",
          "insight-query",
          "read-data-schema",
          "query-trends",
          "query-funnel",
          "query-retention",
          "query-paths",
          "query-stickiness",
          "query-lifecycle",
        ],
      },
      {
        id: "write",
        label: "Create insights",
        defaultMode: "ask",
        tools: ["insight-create"],
      },
    ]);
    expect(plugin.capabilities.flatMap((capability) => capability.tools)).toHaveLength(14);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "posthog", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the official Slack package with least-privilege capability defaults", async () => {
    const fixtureRoot = fileURLToPath(new URL("./test-fixtures/plugins/slack", import.meta.url));
    const files = await fixtureFiles(fixtureRoot, "slack");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "slack",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "slack", version: "1.0.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "slack",
        type: "streamable-http",
        url: "https://mcp.slack.com/mcp",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      expect.objectContaining({
        id: "read",
        label: "Search public Slack",
        defaultMode: "on",
        tools: ["slack_search_emojis", "slack_search_public"],
      }),
      expect.objectContaining({
        id: "query",
        label: "Read private Slack",
        defaultMode: "ask",
        tools: expect.arrayContaining(["slack_read_channel", "slack_read_thread"]),
      }),
      expect.objectContaining({
        id: "write",
        label: "Change Slack",
        defaultMode: "ask",
        tools: expect.arrayContaining(["slack_send_message", "slack_update_canvas"]),
      }),
    ]);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "slack", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });

  it("loads the official Google Drive package with every reviewed tool classified", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("./test-fixtures/plugins/google-drive", import.meta.url),
    );
    const files = await fixtureFiles(fixtureRoot, "google-drive");
    const plugin = await resolvePlugin({
      url: "useopencompany/plugins",
      selectedPath: "google-drive",
      fetcher: fetcher(files),
      trustedCapabilitySources: ["useopencompany/plugins"],
    });

    expect(plugin.manifest).toMatchObject({ name: "google-drive", version: "1.1.0" });
    expect(plugin.skills).toEqual([]);
    expect(plugin.remoteServers).toEqual([
      {
        name: "google-drive",
        type: "streamable-http",
        url: "https://api.opencompany.chat/mcp/plugins/google-drive",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      {
        id: "read",
        label: "Browse Drive files",
        defaultMode: "ask",
        tools: ["get_file_metadata", "list_recent_files", "search_files"],
      },
      {
        id: "query",
        label: "Read files & permissions",
        defaultMode: "ask",
        tools: ["download_file_content", "get_file_permissions", "read_file_content"],
      },
      {
        id: "write",
        label: "Create & copy files",
        defaultMode: "ask",
        tools: ["copy_file", "create_file"],
      },
    ]);
    expect(plugin.capabilities.flatMap((capability) => capability.tools)).toHaveLength(8);
    expect(plugin.report.mcp).toMatchObject({
      status: "parsed",
      reports: [{ name: "google-drive", status: "gateway-registered" }],
    });
    expect(plugin.report.capabilities).toEqual({
      present: true,
      status: "parsed",
      issues: [],
    });
  });
});

function text(value: string) {
  return encoder.encode(value);
}

function treeEntries(files: Map<string, Uint8Array>, executable = new Set<string>()) {
  return [...files].map<SkillTreeEntry>(([path, content]) => ({
    path,
    type: "blob",
    mode: executable.has(path) ? "100755" : "100644",
    size: content.length,
  }));
}

function fetcher(
  files: Map<string, Uint8Array>,
  executable = new Set<string>(),
  entries = treeEntries(files, executable),
): SkillResolverFetcher {
  return {
    defaultBranch: vi.fn(async () => "main"),
    resolveCommit: vi.fn(async () => "a".repeat(40)),
    fetchTree: vi.fn(async () => ({ entries, truncated: false })),
    fetchBlob: vi.fn(async (_owner, _repo, _commit, path) => {
      const content = files.get(path);
      if (!content) throw new Error(`Missing fixture ${path}`);
      return content;
    }),
  };
}

async function fixtureFiles(root: string, prefix: string) {
  const files = new Map<string, Uint8Array>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const path = `${prefix}/${relative(root, absolute).replaceAll("\\", "/")}`;
        files.set(path, new Uint8Array(await readFile(absolute)));
      }
    }
  }
  await visit(root);
  return files;
}
