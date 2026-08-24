// Pure Agent Plugins 1.0.0 parser: root `plugin.json`, `skills/` discovery, and `mcp.json`.
//
// This module contains no I/O. It validates the manifest against the published 1.0.0 contract,
// discovers the immediate child components of `skills/`, and parses MCP server declarations. It
// validates every official transport (stdio, streamable-http, sse) but selects only stdio for
// execution, because that is the only transport this release runs. Failures are surfaced at the
// boundary the spec assigns them: a manifest violation rejects the whole package, an invalid
// `mcp.json` disables MCP without discarding valid skills, and an invalid individual server entry
// is skipped and reported while other servers keep loading.

export class PluginSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSpecError";
  }
}

const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

// ---------------------------------------------------------------------------
// plugin.json
// ---------------------------------------------------------------------------

export type PluginAuthor = { name?: string; email?: string; url?: string };

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  // Client-specific extension namespaces, keyed by reverse-domain. Values are retained verbatim and
  // intentionally not validated — unimplemented namespaces are ignored.
  extensions?: Record<string, unknown>;
};

export type PluginManifestResult = {
  manifest: PluginManifest;
  // Unknown top-level fields, reported and ignored per the schema-closure rule.
  ignoredFields: string[];
};

// Manifest name rule: 1-64 chars, lowercase alphanumerics, hyphens, and periods, alphanumeric
// start/end, and no `--` or `..`. The regex enforces charset and start/end; the runs are checked
// separately for a clearer error and to keep the pattern readable.
const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PLUGIN_NAME_MAX = 64;

const PERMITTED_MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

function requireManifestString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PluginSpecError(`Manifest field \`${field}\` must be a string.`);
  }
  return value;
}

function parseAuthor(value: unknown): PluginAuthor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginSpecError("Manifest field `author` must be an object.");
  }
  const record = value as Record<string, unknown>;
  const author: PluginAuthor = {};
  for (const key of ["name", "email", "url"] as const) {
    if (record[key] !== undefined) {
      author[key] = requireManifestString(record[key], `author.${key}`);
    }
  }
  return author;
}

function parseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PluginSpecError("Manifest field `keywords` must be an array of strings.");
  }
  return value.map((entry, index) => requireManifestString(entry, `keywords[${index}]`));
}

// Parse and strictly validate a root `plugin.json`. Throws PluginSpecError for any fatal violation
// (bad `$schema`, bad/missing `name`, or a wrongly-typed known field). Unknown top-level fields are
// not fatal: they are returned in `ignoredFields`.
export function parsePluginManifest(jsonText: string): PluginManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new PluginSpecError("plugin.json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginSpecError("plugin.json must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;

  if (record.$schema !== PLUGIN_SCHEMA_URL) {
    throw new PluginSpecError(`plugin.json \`$schema\` must be "${PLUGIN_SCHEMA_URL}".`);
  }

  const name = requireManifestString(record.name, "name");
  if (
    name.length > PLUGIN_NAME_MAX ||
    !PLUGIN_NAME_RE.test(name) ||
    name.includes("--") ||
    name.includes("..")
  ) {
    throw new PluginSpecError(
      "Plugin `name` must be 1-64 lowercase alphanumeric, hyphen, and period characters, start and end alphanumeric, with no `--` or `..`.",
    );
  }

  const manifest: PluginManifest = { name };
  if (record.version !== undefined) {
    manifest.version = requireManifestString(record.version, "version");
  }
  if (record.description !== undefined) {
    manifest.description = requireManifestString(record.description, "description");
  }
  if (record.author !== undefined) {
    manifest.author = parseAuthor(record.author);
  }
  if (record.homepage !== undefined) {
    manifest.homepage = requireManifestString(record.homepage, "homepage");
  }
  if (record.repository !== undefined) {
    manifest.repository = requireManifestString(record.repository, "repository");
  }
  if (record.license !== undefined) {
    manifest.license = requireManifestString(record.license, "license");
  }
  if (record.keywords !== undefined) {
    manifest.keywords = parseKeywords(record.keywords);
  }
  if (record.extensions !== undefined) {
    if (
      typeof record.extensions !== "object" ||
      record.extensions === null ||
      Array.isArray(record.extensions)
    ) {
      throw new PluginSpecError("Manifest field `extensions` must be an object.");
    }
    manifest.extensions = record.extensions as Record<string, unknown>;
  }

  const ignoredFields = Object.keys(record).filter((key) => !PERMITTED_MANIFEST_FIELDS.has(key));

  return { manifest, ignoredFields };
}

// ---------------------------------------------------------------------------
// skills/ discovery
// ---------------------------------------------------------------------------

// A minimal view of a package tree entry: the plugin-root-relative path and whether it is a file.
export type PluginTreeEntry = { path: string; type: "blob" | "tree" | "commit" };

// Return the immediate child directory names of `skills/` that contain a `skills/<name>/SKILL.md`
// regular file. Nested SKILL.md files (deeper than one level) are ignored, per the spec's
// no-recursive-search rule. A missing `skills/` directory is not an error and yields an empty list.
export function discoverPluginSkillDirectories(entries: readonly PluginTreeEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const segments = entry.path.split("/");
    // Exactly: skills / <name> / SKILL.md
    if (segments.length !== 3) continue;
    if (segments[0] !== "skills" || segments[2] !== "SKILL.md") continue;
    const child = segments[1];
    if (child) names.add(child);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// mcp.json
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "streamable-http" | "sse";

// A validated stdio server, selected for execution. Placeholder expansion (${PLUGIN_ROOT} /
// ${PLUGIN_DATA}) and launcher construction are deferred to the runtime phase; here we only keep
// the validated declaration.
export type StdioMcpServer = {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type McpServerReport = {
  name: string;
  // `selected`: a valid stdio server this release will run.
  // `unsupported`: a valid streamable-http or sse server that is recognized but not launched.
  // `invalid`: a server entry that failed validation and was skipped.
  status: "selected" | "unsupported" | "invalid";
  transport?: McpTransport;
  reason?: string;
};

export type McpConfigResult =
  // The whole document is invalid; MCP is disabled for the plugin. Valid skills are unaffected.
  | { status: "disabled"; reason: string }
  // The document parsed; `servers` are the executable stdio servers and `reports` explains every
  // declared server (selected, unsupported, or skipped-invalid).
  | { status: "parsed"; servers: StdioMcpServer[]; reports: McpServerReport[] };

const RESERVED_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "PLUGIN_ROOT", "PLUGIN_DATA"]);

function parseStringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;
  return value as string[];
}

// Validate one server entry. Returns either the selected stdio server or a report explaining why it
// was not selected (unsupported transport, or invalid entry). Never throws.
function validateServer(name: string, value: unknown): McpServerReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { name, status: "invalid", reason: "Server entry must be an object." };
  }
  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "stdio") {
    if (typeof record.command !== "string" || record.command.length === 0) {
      return { name, status: "invalid", transport: "stdio", reason: "`command` is required." };
    }
    // The spec requires a single-token command (bare name or `./` plugin-relative path).
    if (/\s/.test(record.command)) {
      return {
        name,
        status: "invalid",
        transport: "stdio",
        reason: "`command` must be a single token.",
      };
    }
    if (record.command.includes("/") && !record.command.startsWith("./")) {
      return {
        name,
        status: "invalid",
        transport: "stdio",
        reason: "`command` must be a bare executable name or a `./`-relative plugin path.",
      };
    }
    let args: string[] = [];
    if (record.args !== undefined) {
      const parsedArgs = parseStringArray(record.args);
      if (!parsedArgs) {
        return {
          name,
          status: "invalid",
          transport: "stdio",
          reason: "`args` must be an array of strings.",
        };
      }
      args = parsedArgs;
    }
    let env: Record<string, string> = {};
    if (record.env !== undefined) {
      const parsedEnv = parseStringMap(record.env);
      if (!parsedEnv) {
        return {
          name,
          status: "invalid",
          transport: "stdio",
          reason: "`env` must be a map of string values.",
        };
      }
      if (Object.keys(parsedEnv).some((key) => RESERVED_ENV_KEYS.has(key))) {
        return {
          name,
          status: "invalid",
          transport: "stdio",
          reason: "`env` must not override the runtime environment.",
        };
      }
      env = parsedEnv;
    }
    if (record.cwd !== undefined && typeof record.cwd !== "string") {
      return { name, status: "invalid", transport: "stdio", reason: "`cwd` must be a string." };
    }
    return { name, status: "selected", transport: "stdio" };
    // Note: the fully-typed StdioMcpServer is assembled by the caller from the same validated
    // record so this pure validator returns only a report; see parseMcpConfig.
  }

  if (type === "streamable-http" || type === "sse") {
    if (typeof record.url !== "string" || !isAbsoluteHttpUrl(record.url)) {
      return {
        name,
        status: "invalid",
        transport: type,
        reason: "`url` must be an absolute http(s) URL.",
      };
    }
    if (record.headers !== undefined && parseStringMap(record.headers) === null) {
      return {
        name,
        status: "invalid",
        transport: type,
        reason: "`headers` must be a map of string values.",
      };
    }
    return {
      name,
      status: "unsupported",
      transport: type,
      reason: `The ${type} transport is validated but not launched in this release.`,
    };
  }

  return {
    name,
    status: "invalid",
    reason:
      typeof type === "string" ? `Unknown transport type "${type}".` : "Missing transport `type`.",
  };
}

function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.hash) return false;
  return true;
}

// Re-assemble a validated stdio server's typed shape from its raw record. Only called for entries
// that already passed `validateServer` with status "selected", so the field types are known-good.
function buildStdioServer(name: string, record: Record<string, unknown>): StdioMcpServer {
  const server: StdioMcpServer = {
    name,
    type: "stdio",
    command: record.command as string,
    args: (parseStringArray(record.args) ?? []) as string[],
    env: parseStringMap(record.env) ?? {},
  };
  if (typeof record.cwd === "string") server.cwd = record.cwd;
  return server;
}

// Parse and validate an `mcp.json` document. A structurally invalid document disables MCP for the
// plugin (callers keep the plugin and its valid skills). A valid document yields the selected stdio
// servers plus a per-server report covering every declared entry.
export function parseMcpConfig(jsonText: string): McpConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { status: "disabled", reason: "mcp.json is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "disabled", reason: "mcp.json must be a JSON object." };
  }
  const record = parsed as Record<string, unknown>;

  if (record.$schema !== MCP_SCHEMA_URL) {
    return { status: "disabled", reason: `mcp.json \`$schema\` must be "${MCP_SCHEMA_URL}".` };
  }
  for (const key of Object.keys(record)) {
    if (key !== "$schema" && key !== "mcpServers") {
      return { status: "disabled", reason: `Unknown top-level field \`${key}\` in mcp.json.` };
    }
  }
  if (
    typeof record.mcpServers !== "object" ||
    record.mcpServers === null ||
    Array.isArray(record.mcpServers)
  ) {
    return { status: "disabled", reason: "mcp.json `mcpServers` must be an object." };
  }

  const servers: StdioMcpServer[] = [];
  const reports: McpServerReport[] = [];
  for (const [name, value] of Object.entries(record.mcpServers as Record<string, unknown>)) {
    const report = validateServer(name, value);
    reports.push(report);
    if (report.status === "selected") {
      servers.push(buildStdioServer(name, value as Record<string, unknown>));
    }
  }

  return { status: "parsed", servers, reports };
}
