import "./load-env.mjs";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const claudeMcpPath = join(repoRoot, ".mcp.json");
const codexConfigPath = join(repoRoot, ".codex", "config.toml");
const codexMarkerStart = "# BEGIN opencompany generated SigNoz MCP";
const codexMarkerEnd = "# END opencompany generated SigNoz MCP";
const mcpEnvKeys = ["SIGNOZ_MCP_URL", "SIGNOZ_MCP_REGION", "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT"];
const defaultSignozMcpRegion = "eu2";

const mcpUrl = resolveSignozMcpUrl(withConductorRootEnvFallback(process.env));

if (!mcpUrl) {
  console.log(
    "[agent-mcp] SigNoz MCP not configured. Set SIGNOZ_MCP_REGION, SIGNOZ_MCP_URL, or GOAT_OTEL_EXPORTER_OTLP_ENDPOINT.",
  );
  process.exit(0);
}

writeClaudeMcpConfig(mcpUrl);
writeCodexMcpConfig(mcpUrl);

console.log(`[agent-mcp] Configured SigNoz MCP at ${mcpUrl}`);
console.log("[agent-mcp] Claude Code: .mcp.json");
console.log("[agent-mcp] Codex: .codex/config.toml");

function resolveSignozMcpUrl(env) {
  const explicitUrl = normalize(env.SIGNOZ_MCP_URL);
  if (explicitUrl) return validateMcpUrl(explicitUrl, "SIGNOZ_MCP_URL");

  const explicitRegion = normalize(env.SIGNOZ_MCP_REGION);
  if (explicitRegion) return mcpUrlFromRegion(explicitRegion);

  const inferredRegion = inferRegionFromOtlpEndpoint(env.GOAT_OTEL_EXPORTER_OTLP_ENDPOINT);
  if (inferredRegion) return mcpUrlFromRegion(inferredRegion);

  return mcpUrlFromRegion(defaultSignozMcpRegion);
}

function withConductorRootEnvFallback(env) {
  const conductorRootPath = normalize(env.CONDUCTOR_ROOT_PATH);
  if (!conductorRootPath || conductorRootPath === repoRoot) return env;

  const rootEnv = readSelectedEnvFiles(conductorRootPath, mcpEnvKeys);
  const next = { ...env };

  for (const key of mcpEnvKeys) {
    if (!normalize(next[key]) && normalize(rootEnv[key])) {
      next[key] = rootEnv[key];
    }
  }

  return next;
}

function readSelectedEnvFiles(rootPath, keys) {
  const values = {};
  for (const filename of [".env", ".env.local", ".env.override.local"]) {
    Object.assign(values, readSelectedEnvFile(join(rootPath, filename), keys));
  }
  return values;
}

function readSelectedEnvFile(path, keys) {
  if (!existsSync(path)) return {};

  const wanted = new Set(keys);
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || !wanted.has(match[1])) continue;
    values[match[1]] = unquoteEnvValue(match[2]);
  }
  return values;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalize(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function mcpUrlFromRegion(region) {
  if (!/^[a-z0-9-]+$/i.test(region)) {
    throw new Error(`Invalid SigNoz MCP region: ${region}`);
  }

  return `https://mcp.${region.toLowerCase()}.signoz.cloud/mcp`;
}

function validateMcpUrl(raw, sourceName) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${sourceName} must be a valid URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${sourceName} must use https for the hosted SigNoz MCP server.`);
  }

  return parsed.toString();
}

function inferRegionFromOtlpEndpoint(rawEndpoint) {
  const endpoint = normalize(rawEndpoint);
  if (!endpoint) return null;

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }

  const match = parsed.hostname.match(/^ingest\.([a-z0-9-]+)\.signoz\.cloud$/i);
  return match?.[1] ?? null;
}

function writeClaudeMcpConfig(url) {
  const current = readJsonObject(claudeMcpPath);
  const next = {
    ...current,
    mcpServers: {
      ...(isRecord(current.mcpServers) ? current.mcpServers : {}),
      signoz: {
        type: "http",
        url,
      },
    },
  };

  writeFileSync(claudeMcpPath, `${JSON.stringify(next, null, 2)}\n`);
}

function readJsonObject(path) {
  if (!existsSync(path)) return {};

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${relative(path)} must contain a JSON object.`);
  }

  return parsed;
}

function writeCodexMcpConfig(url) {
  mkdirSync(dirname(codexConfigPath), { recursive: true });

  const generatedBlock = [
    codexMarkerStart,
    "[mcp_servers.signoz]",
    `url = ${toTomlString(url)}`,
    codexMarkerEnd,
  ].join("\n");

  if (!existsSync(codexConfigPath)) {
    writeFileSync(codexConfigPath, `${generatedBlock}\n`);
    return;
  }

  const current = readFileSync(codexConfigPath, "utf8");
  const markedBlockPattern = new RegExp(
    `${escapeRegExp(codexMarkerStart)}[\\s\\S]*?${escapeRegExp(codexMarkerEnd)}`,
  );

  if (markedBlockPattern.test(current)) {
    writeFileSync(
      codexConfigPath,
      `${current.replace(markedBlockPattern, generatedBlock).trimEnd()}\n`,
    );
    return;
  }

  const signozBlock = findTomlTableBlock(current, "mcp_servers.signoz");
  if (signozBlock) {
    const next = `${current.slice(0, signozBlock.start).trimEnd()}\n\n${generatedBlock}\n${current
      .slice(signozBlock.end)
      .trimStart()}`;
    writeFileSync(codexConfigPath, `${next.trimEnd()}\n`);
    return;
  }

  writeFileSync(codexConfigPath, `${current.trimEnd()}\n\n${generatedBlock}\n`);
}

function findTomlTableBlock(content, tableName) {
  const lines = content.split("\n");
  let startLine = -1;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === `[${tableName}]`) {
      startLine = index;
      break;
    }
  }

  if (startLine === -1) return null;

  let endLine = lines.length;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      endLine = index;
      break;
    }
  }

  return {
    start: offsetForLine(lines, startLine),
    end: offsetForLine(lines, endLine),
  };
}

function offsetForLine(lines, lineIndex) {
  return lines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0);
}

function toTomlString(value) {
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}
