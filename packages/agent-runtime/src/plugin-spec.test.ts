import { describe, expect, test } from "vitest";
import {
  discoverPluginSkillDirectories,
  PluginSpecError,
  type PluginTreeEntry,
  parseMcpConfig,
  parsePluginCapabilities,
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

describe("parsePluginCapabilities", () => {
  test("parses valid reviewed capability groups and ignores unknown fields", () => {
    const result = parsePluginCapabilities(
      {
        "so.opencompany.capabilities": {
          read: {
            label: "Read Linear",
            defaultMode: "on",
            tools: ["list_issues", "get_issue", "list_issues"],
            future: true,
          },
          write: {
            label: "Manage issues",
            defaultMode: "ask",
            tools: ["save_issue", "save_comment"],
          },
          future: { label: "Future", defaultMode: "ask", tools: [] },
        },
        "com.example.unknown": { anything: true },
      },
      { trusted: true },
    );

    expect(result.definitions).toEqual([
      {
        id: "read",
        label: "Read Linear",
        defaultMode: "on",
        tools: ["list_issues", "get_issue"],
      },
      {
        id: "write",
        label: "Manage issues",
        defaultMode: "ask",
        tools: ["save_issue", "save_comment"],
      },
    ]);
    expect(result.report).toEqual({
      present: true,
      status: "parsed",
      issues: [
        "Unknown field `read.future` was ignored.",
        "Unknown capability group `future` was ignored.",
      ],
    });
  });

  test.each([
    {
      label: "namespace is not an object",
      value: [],
      issue: /must be an object/u,
    },
    {
      label: "group is not an object",
      value: { read: [] },
      issue: /group `read` must be an object/u,
    },
    {
      label: "group fields are malformed",
      value: { read: { label: "", defaultMode: "yes", tools: [1] } },
      issue: /read\.label/u,
    },
    {
      label: "tool belongs to multiple groups",
      value: {
        read: { label: "Read", defaultMode: "on", tools: ["shared"] },
        write: { label: "Write", defaultMode: "ask", tools: ["shared"] },
      },
      issue: /multiple capability groups/u,
    },
  ])("reports malformed definitions without rejecting the package: $label", ({ value, issue }) => {
    const result = parsePluginCapabilities(
      { "so.opencompany.capabilities": value },
      { trusted: true },
    );
    expect(result.report.status).toBe("parsed");
    if (result.report.status !== "parsed") return;
    expect(result.report.issues.join("\n")).toMatch(issue);
  });

  test("retains but never honors third-party capability claims", () => {
    const result = parsePluginCapabilities(
      {
        "so.opencompany.capabilities": {
          read: { label: "Everything is safe", defaultMode: "on", tools: ["delete_all"] },
        },
      },
      { trusted: false },
    );
    expect(result.definitions).toEqual([]);
    expect(result.report).toMatchObject({ present: true, status: "ignored" });
  });
});

describe("parseMcpConfig", () => {
  function mcp(servers: Record<string, unknown>): string {
    return JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers });
  }

  test("keeps stdio selected and registers http/sse with the gateway", () => {
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
    expect(result.remoteServers).toEqual([
      {
        name: "remote",
        type: "streamable-http",
        url: "https://mcp.example.com/x",
        headers: {},
      },
      {
        name: "legacy",
        type: "sse",
        url: "https://mcp.example.com/sse",
        headers: {},
      },
    ]);
    const byName = Object.fromEntries(result.reports.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      local: "selected",
      remote: "gateway-registered",
      legacy: "gateway-registered",
    });
  });

  test("skips invalid server entries but keeps valid ones", () => {
    const result = parseMcpConfig(
      mcp({
        good: { type: "stdio", command: "server" },
        missingCommand: { type: "stdio" },
        reservedEnv: { type: "stdio", command: "server", env: { PLUGIN_ROOT: "/x" } },
        runtimeEnv: { type: "stdio", command: "server", env: { PATH: "/untrusted" } },
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
      runtimeEnv: "invalid",
      unknownTransport: "invalid",
      badUrl: "invalid",
    });
  });

  test("accepts only bare or plugin-relative stdio commands", () => {
    const result = parseMcpConfig(
      mcp({
        bare: { type: "stdio", command: "node" },
        pluginRelative: { type: "stdio", command: "./bin/server" },
        absolute: { type: "stdio", command: "/usr/bin/node" },
        bareRelative: { type: "stdio", command: "bin/server" },
        parentRelative: { type: "stdio", command: "../bin/server" },
      }),
    );

    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.servers.map((server) => server.name)).toEqual(["bare", "pluginRelative"]);
    expect(result.reports).toEqual([
      { name: "bare", status: "selected", transport: "stdio" },
      { name: "pluginRelative", status: "selected", transport: "stdio" },
      {
        name: "absolute",
        status: "invalid",
        transport: "stdio",
        reason: "`command` must be a bare executable name or a `./`-relative plugin path.",
      },
      {
        name: "bareRelative",
        status: "invalid",
        transport: "stdio",
        reason: "`command` must be a bare executable name or a `./`-relative plugin path.",
      },
      {
        name: "parentRelative",
        status: "invalid",
        transport: "stdio",
        reason: "`command` must be a bare executable name or a `./`-relative plugin path.",
      },
    ]);
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
