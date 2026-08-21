import { describe, expect, test } from "vitest";
import {
  discoverPluginSkillDirectories,
  PluginSpecError,
  type PluginTreeEntry,
  parseMcpConfig,
  parsePluginManifest,
} from "./plugin-spec";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function manifest(fields: Record<string, unknown>): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "my-plugin", ...fields });
}

describe("parsePluginManifest", () => {
  test("parses a full valid manifest", () => {
    const result = parsePluginManifest(
      manifest({
        version: "1.2.3",
        description: "A plugin.",
        author: { name: "Ada", email: "ada@example.com", url: "https://example.com" },
        homepage: "https://example.com",
        repository: "https://github.com/o/r",
        license: "MIT",
        keywords: ["a", "b"],
        extensions: { "com.example.client": { anything: [1, 2, 3] } },
      }),
    );
    expect(result.ignoredFields).toEqual([]);
    expect(result.manifest).toMatchObject({
      name: "my-plugin",
      version: "1.2.3",
      author: { name: "Ada", email: "ada@example.com", url: "https://example.com" },
      keywords: ["a", "b"],
    });
    // Extension values are retained verbatim and not validated.
    expect(result.manifest.extensions).toEqual({ "com.example.client": { anything: [1, 2, 3] } });
  });

  test("reports and ignores unknown top-level fields without rejecting", () => {
    const result = parsePluginManifest(manifest({ surprise: true, another: 1 }));
    expect(result.ignoredFields.sort()).toEqual(["another", "surprise"]);
    expect(result.manifest.name).toBe("my-plugin");
  });

  type Rejection = { label: string; json: string; match: RegExp };
  const rejections: Rejection[] = [
    { label: "not JSON", json: "{not json", match: /not valid JSON/ },
    { label: "not an object", json: "[]", match: /must be a JSON object/ },
    {
      label: "wrong $schema",
      json: JSON.stringify({ $schema: "https://example.com/other", name: "x" }),
      match: /\$schema/,
    },
    {
      label: "missing name",
      json: JSON.stringify({ $schema: PLUGIN_SCHEMA }),
      match: /`name` must be a string/,
    },
    {
      label: "name with consecutive dots",
      json: JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "a..b" }),
      match: /Plugin `name`/,
    },
    {
      label: "name ending with a hyphen",
      json: JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "abc-" }),
      match: /Plugin `name`/,
    },
    {
      label: "keywords not an array of strings",
      json: manifest({ keywords: [1, 2] }),
      match: /`keywords\[0\]` must be a string/,
    },
    {
      label: "author with a non-string field",
      json: manifest({ author: { name: 5 } }),
      match: /`author\.name` must be a string/,
    },
    {
      label: "extensions not an object",
      json: manifest({ extensions: [] }),
      match: /`extensions` must be an object/,
    },
  ];

  for (const testCase of rejections) {
    test(`rejects: ${testCase.label}`, () => {
      expect(() => parsePluginManifest(testCase.json)).toThrow(PluginSpecError);
      expect(() => parsePluginManifest(testCase.json)).toThrow(testCase.match);
    });
  }
});

describe("discoverPluginSkillDirectories", () => {
  test("returns only immediate children of skills/ that contain a SKILL.md", () => {
    const entries: PluginTreeEntry[] = [
      { path: "plugin.json", type: "blob" },
      { path: "skills/alpha/SKILL.md", type: "blob" },
      { path: "skills/beta/SKILL.md", type: "blob" },
      { path: "skills/beta/extra.md", type: "blob" },
      // Nested one level too deep: not a skill.
      { path: "skills/gamma/nested/SKILL.md", type: "blob" },
      // A SKILL.md outside skills/ is not discovered.
      { path: "docs/SKILL.md", type: "blob" },
    ];
    expect(discoverPluginSkillDirectories(entries)).toEqual(["alpha", "beta"]);
  });

  test("returns an empty list when skills/ is missing", () => {
    expect(discoverPluginSkillDirectories([{ path: "plugin.json", type: "blob" }])).toEqual([]);
  });
});

describe("parseMcpConfig", () => {
  function mcp(servers: Record<string, unknown>): string {
    return JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers });
  }

  test("selects stdio servers and reports http/sse as unsupported", () => {
    const result = parseMcpConfig(
      mcp({
        local: {
          type: "stdio",
          command: "./bin/server",
          args: ["--flag", "${PLUGIN_ROOT}/x"],
          env: { API_MODE: "prod" },
          cwd: "${PLUGIN_DATA}",
        },
        remote: { type: "streamable-http", url: "https://mcp.example.com/x" },
        legacy: { type: "sse", url: "https://mcp.example.com/sse" },
      }),
    );
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({
      name: "local",
      type: "stdio",
      command: "./bin/server",
      args: ["--flag", "${PLUGIN_ROOT}/x"],
      env: { API_MODE: "prod" },
      cwd: "${PLUGIN_DATA}",
    });
    const byName = Object.fromEntries(result.reports.map((r) => [r.name, r.status]));
    expect(byName).toEqual({ local: "selected", remote: "unsupported", legacy: "unsupported" });
  });

  test("skips invalid server entries but keeps valid ones", () => {
    const result = parseMcpConfig(
      mcp({
        good: { type: "stdio", command: "server" },
        missingCommand: { type: "stdio" },
        reservedEnv: { type: "stdio", command: "server", env: { PLUGIN_ROOT: "/x" } },
        unknownTransport: { type: "carrier-pigeon" },
        badUrl: { type: "streamable-http", url: "not-a-url" },
      }),
    );
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.servers.map((s) => s.name)).toEqual(["good"]);
    const byName = Object.fromEntries(result.reports.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      good: "selected",
      missingCommand: "invalid",
      reservedEnv: "invalid",
      unknownTransport: "invalid",
      badUrl: "invalid",
    });
  });

  type Disabled = { label: string; json: string; match: RegExp };
  const disabledCases: Disabled[] = [
    { label: "invalid JSON", json: "{oops", match: /not valid JSON/ },
    { label: "not an object", json: "[]", match: /must be a JSON object/ },
    {
      label: "wrong $schema",
      json: JSON.stringify({ $schema: "https://example.com/x", mcpServers: {} }),
      match: /\$schema/,
    },
    {
      label: "unknown top-level field",
      json: JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: {}, extra: 1 }),
      match: /Unknown top-level field/,
    },
    {
      label: "mcpServers not an object",
      json: JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: [] }),
      match: /`mcpServers` must be an object/,
    },
  ];

  for (const testCase of disabledCases) {
    test(`disables MCP: ${testCase.label}`, () => {
      const result = parseMcpConfig(testCase.json);
      expect(result.status).toBe("disabled");
      if (result.status !== "disabled") return;
      expect(result.reason).toMatch(testCase.match);
    });
  }
});
