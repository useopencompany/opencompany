import { describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS } from "./artifact-policy";
import { PluginResolverError, resolvePlugin } from "./plugin-resolver";
import type { SkillResolverFetcher, SkillTreeEntry } from "./skill-resolver";

const encoder = new TextEncoder();

describe("resolvePlugin", () => {
  it("retains the complete package, copies valid skills, and reports skipped/unsupported components", async () => {
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
            expect.objectContaining({ name: "remote", status: "unsupported" }),
          ],
        },
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
