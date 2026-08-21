import { CODEX_DYNAMIC_TOOL_NAME } from "@opencompany/agent-runtime";
import {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
} from "@/lib/chat-ui";

export type CodingToolPresentation = {
  label: string;
  detail: string | null;
  detailChips: string[];
  category: "search" | "tool";
};

type CodingToolPresentationInput = {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
};

const CODING_TOOL_BUCKETS = new Set([
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_DYNAMIC_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
]);

const FIXED_CODING_TOOL_LABELS: Readonly<Record<string, string>> = {
  [CODEX_APPROVAL_TOOL_NAME]: "Approval",
  [CODEX_GOAL_TOOL_NAME]: "Goal",
  [CODEX_PLAN_TOOL_NAME]: "Plan",
  [CODEX_QUESTION_TOOL_NAME]: "Question",
  [CODEX_SUBAGENT_TOOL_NAME]: "Subagent",
};

const INTERNAL_LABELS = new Set([
  ...CODING_TOOL_BUCKETS,
  "codex command",
  "codex dynamic tool",
  "codex file change",
  "codex mcp tool",
  "codex web search",
  "mcp tool",
  "mcp tool call",
  "opencompany tool",
  "terminal",
]);

export function codingToolPresentation({
  name,
  input,
  output,
  metadata,
}: CodingToolPresentationInput): CodingToolPresentation | null {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const metadataRecord = asRecord(metadata);
  const records = compactRecords([
    nestedRecord(inputRecord, "arguments"),
    nestedRecord(inputRecord, "rawInput"),
    inputRecord,
    nestedRecord(metadataRecord, "arguments"),
    nestedRecord(metadataRecord, "rawInput"),
    metadataRecord,
    outputRecord,
  ]);
  const server = firstString(records, ["server"]);
  const toolNameField = firstString(records, ["toolName"]);
  const explicitToolName = toolNameField === name ? null : toolNameField;
  const tool = firstString(records, ["tool"]);
  const hasExplicitIdentity = Boolean(explicitToolName || (!server && tool));
  const identity = explicitToolName ?? (!server ? tool : null) ?? name;
  const normalizedIdentity = normalizeToolIdentity(identity);
  const kind = firstString(records, ["kind"])?.toLowerCase() ?? null;
  const title = firstString(records, ["title"]);
  const labelHint = firstString(records, ["label"]);
  const detailHint = firstString(records, ["detail"]);
  const error = outputRecord ? firstString([outputRecord], ["error"]) : null;
  const isCodingBucket = CODING_TOOL_BUCKETS.has(name);
  const mcpTarget = parseMcpTarget(explicitToolName ?? identity, server, tool);

  if (name === CODEX_COMMAND_TOOL_NAME) {
    const description = firstString(records, ["description"]);
    const command = firstString(records, ["command"]) ?? detailHint;
    const detailChips = command ? [displayShellCommand(command)] : [];
    return presentation(
      safeHumanLabel(description, identity) ??
        safeHumanLabel(labelHint, identity) ??
        safeHumanLabel(title, identity) ??
        "Command",
      detailChips,
    );
  }

  const fixedLabel = FIXED_CODING_TOOL_LABELS[name];
  if (fixedLabel) return presentation(fixedLabel, []);

  if (!isCodingBucket && !hasExplicitIdentity && !mcpTarget) return null;

  if (mcpTarget) {
    const detailChips = [`${mcpTarget.server} · ${mcpTarget.tool}`, ...(error ? [error] : [])];
    return presentation(
      safeHumanLabel(title, identity) ?? safeHumanLabel(labelHint, identity) ?? "Tool",
      detailChips,
    );
  }

  if (isReadTool(normalizedIdentity, kind)) {
    const path = firstPath(records);
    const lines = lineCountFromToolOutput(output);
    return presentation(
      lines === null ? "Read" : `Read ${formatLineCount(lines)}`,
      path ? [fileBasename(path)] : [],
    );
  }

  if (isWriteTool(normalizedIdentity, kind)) {
    const paths = filePaths(records);
    const lines = lineCountFromText(firstString(records, ["content", "text"]));
    return presentation(
      lines === null ? "Write" : `Write ${formatLineCount(lines)}`,
      compactFileChips(paths),
    );
  }

  if (isEditTool(normalizedIdentity, kind, name)) {
    const paths = filePaths(records);
    const lines = lineCountFromText(firstString(records, ["new_string", "newString"]));
    const action = fileChangeAction(normalizedIdentity, kind, records);
    return presentation(
      lines === null ? action : `${action} ${formatLineCount(lines)}`,
      compactFileChips(paths),
    );
  }

  if (isSearchTool(normalizedIdentity, kind, hasExplicitIdentity)) {
    const pattern = firstString(records, ["pattern", "query", "glob"]);
    return presentation("Search", pattern ? [pattern] : [], "search");
  }

  if (isTodoTool(normalizedIdentity)) {
    const todos = firstArray(records, "todos");
    const detailChips = todos ? [`${todos.length} ${todos.length === 1 ? "item" : "items"}`] : [];
    return presentation("Plan", detailChips);
  }

  if (isFetchTool(normalizedIdentity, kind, hasExplicitIdentity)) {
    const target = firstString(records, ["url", "query"]);
    return presentation("Fetch", target ? [target] : [], "search");
  }

  if (name === CODEX_WEB_SEARCH_TOOL_NAME) {
    const query = firstString(records, ["pattern", "query", "glob"]);
    return presentation("Web search", query ? [query] : [], "search");
  }

  if (name === CODEX_FILE_CHANGE_TOOL_NAME) {
    return presentation("File change", compactFileChips(filePaths(records)));
  }

  const fallbackLabel =
    safeHumanLabel(title, identity) ??
    safeHumanLabel(labelHint, identity) ??
    (hasExplicitIdentity ? humanizeToolIdentity(identity) : null) ??
    "Tool";
  const fallbackDetail = detailHint ? [detailHint] : error ? [error] : [];
  return presentation(fallbackLabel, fallbackDetail);
}

export function displayShellCommand(value: string) {
  let command = value.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|)sh\s+-(?:lc|cl|c)\s+([\s\S]+)$/i.exec(command);
    if (!match?.[1]) break;
    command = unwrapShellArgument(match[1].trim());
  }
  return command;
}

export function repoRelativeSandboxPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  for (const marker of [
    "/opencompany-goat/codex-chat/",
    "/codex-chat/",
    "/workspaces/",
    "/workspace/",
  ]) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex < 0) continue;
    const workspacePath = normalized.slice(markerIndex + marker.length);
    const separatorIndex = workspacePath.indexOf("/");
    if (separatorIndex >= 0 && workspacePath.slice(separatorIndex + 1)) {
      return workspacePath.slice(separatorIndex + 1);
    }
  }
  return normalized;
}

function presentation(
  label: string,
  detailChips: string[],
  category: CodingToolPresentation["category"] = "tool",
): CodingToolPresentation {
  const visibleChips = detailChips.map((chip) => chip.trim()).filter(Boolean);
  return {
    label,
    detail: visibleChips.length > 0 ? visibleChips.join(", ") : null,
    detailChips: visibleChips,
    category,
  };
}

function unwrapShellArgument(value: string) {
  if (value.length < 2) return value;
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/g, "'").replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return value;
}

function parseMcpTarget(
  identity: string,
  explicitServer: string | null,
  explicitTool: string | null,
) {
  if (explicitServer && explicitTool) return { server: explicitServer, tool: explicitTool };
  const doubleUnderscore = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/i.exec(identity);
  if (doubleUnderscore?.[1] && doubleUnderscore[2]) {
    return { server: doubleUnderscore[1], tool: doubleUnderscore[2] };
  }
  const dotted = /^mcp\.([^.]+)\.(.+)$/i.exec(identity);
  return dotted?.[1] && dotted[2] ? { server: dotted[1], tool: dotted[2] } : null;
}

function isReadTool(identity: string, kind: string | null) {
  return identity === "read" || identity === "readfile" || kind === "read";
}

function isWriteTool(identity: string, kind: string | null) {
  return identity === "write" || identity === "writefile" || kind === "write";
}

function isEditTool(identity: string, kind: string | null, name: string) {
  return (
    identity === "edit" ||
    identity === "multiedit" ||
    identity === "notebookedit" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    name === CODEX_FILE_CHANGE_TOOL_NAME
  );
}

function isSearchTool(identity: string, kind: string | null, hasExplicitIdentity: boolean) {
  return identity === "grep" || identity === "glob" || (hasExplicitIdentity && kind === "search");
}

function isTodoTool(identity: string) {
  return identity === "todowrite" || identity === "todo";
}

function isFetchTool(identity: string, kind: string | null, hasExplicitIdentity: boolean) {
  return (
    identity === "webfetch" || identity === "fetch" || (hasExplicitIdentity && kind === "fetch")
  );
}

function fileChangeAction(
  identity: string,
  kind: string | null,
  records: readonly Record<string, unknown>[],
) {
  const changeKind = firstChangeKind(records) ?? kind;
  if (identity === "write" || changeKind === "write" || changeKind === "create") return "Write";
  if (changeKind === "delete") return "Delete";
  if (changeKind === "move") return "Move";
  return "Edit";
}

function firstChangeKind(records: readonly Record<string, unknown>[]) {
  for (const record of records) {
    if (!Array.isArray(record.changes)) continue;
    for (const change of record.changes) {
      const kind = asRecord(change)?.kind;
      if (typeof kind === "string" && kind.trim()) return kind.trim().toLowerCase();
    }
  }
  return null;
}

function filePaths(records: readonly Record<string, unknown>[]) {
  const paths: string[] = [];
  const addPath = (path: unknown) => {
    if (typeof path !== "string" || !path.trim() || paths.includes(path.trim())) return;
    paths.push(path.trim());
  };
  for (const record of records) {
    for (const key of ["file_path", "filePath", "notebook_path", "notebookPath", "path"]) {
      addPath(record[key]);
    }
    if (!Array.isArray(record.changes)) continue;
    for (const change of record.changes) addPath(asRecord(change)?.path);
  }
  return paths;
}

function firstPath(records: readonly Record<string, unknown>[]) {
  return filePaths(records)[0] ?? null;
}

function compactFileChips(paths: readonly string[]) {
  const relativePaths = paths.map(repoRelativeSandboxPath);
  if (relativePaths.length <= 3) return relativePaths;
  return [...relativePaths.slice(0, 3), `+${relativePaths.length - 3} files`];
}

function fileBasename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) ?? normalized;
}

function lineCountFromToolOutput(value: unknown, depth = 0): number | null {
  if (depth > 3) return null;
  if (typeof value === "string") {
    const summary = /\b(?:read|returned)\s+(\d+)\s+lines?\b/i.exec(value);
    if (summary?.[1]) return Number(summary[1]);
    const numberedLines = value.split(/\r?\n/).filter((line) => /^\s*\d+\s*(?:→|\||\t)/.test(line));
    if (numberedLines.length > 0) return numberedLines.length;
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.startsWith("[")) {
      try {
        return lineCountFromToolOutput(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(value)) return null;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["lineCount", "linesRead", "lines_read", "numLines", "totalLines"]) {
    const count = record[key];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  if (Array.isArray(record.lines)) return record.lines.length;
  for (const key of ["result", "content", "output", "text", "data"]) {
    const count = lineCountFromToolOutput(record[key], depth + 1);
    if (count !== null) return count;
  }
  return null;
}

function lineCountFromText(value: string | null) {
  if (value === null) return null;
  return value ? value.split(/\r?\n/).length : 0;
}

function formatLineCount(count: number) {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function safeHumanLabel(value: string | null, identity: string) {
  if (!value) return null;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/[_-]+/g, " ");
  if (!trimmed || INTERNAL_LABELS.has(trimmed.toLowerCase()) || INTERNAL_LABELS.has(normalized)) {
    return null;
  }
  if (normalizeToolIdentity(trimmed) === normalizeToolIdentity(identity)) return null;
  return trimmed;
}

function humanizeToolIdentity(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeToolIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstString(records: readonly Record<string, unknown>[], keys: readonly string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstArray(records: readonly Record<string, unknown>[], key: string) {
  for (const record of records) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

function nestedRecord(record: Record<string, unknown> | null, key: string) {
  return record ? asRecord(record[key]) : null;
}

function compactRecords(records: Array<Record<string, unknown> | null>) {
  return records.filter((record): record is Record<string, unknown> => Boolean(record));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
