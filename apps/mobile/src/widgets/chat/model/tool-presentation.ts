import { OFFICIAL_PLUGIN_LABELS } from "@opencompany/agent-runtime/official-plugin-catalog";
import type { SFSymbol } from "expo-symbols";
import type { ToolPart, ToolStatus } from "./chat";

// Mirrors the web transcript's tool naming (apps/web/lib/coding-tool-presentation.ts and
// components/chat/assistant-items.ts) so a call reads the same on every surface.

export interface ToolPresentation {
  /** What the tool did, such as "Search" or "Linear · Create issue". */
  label: string;
  /** One line naming the target: a path, query, URL, or command. */
  target: string | null;
  /** An SF Symbol for the kind of work. */
  symbol: SFSymbol;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const firstString = (records: readonly Record<string, unknown>[], keys: readonly string[]) => {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return null;
};

const records = (...values: unknown[]) => values.filter(isRecord);

const sentenceCase = (value: string) => {
  const words = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words ? `${words.slice(0, 1).toUpperCase()}${words.slice(1)}` : "";
};

const normalizeIdentity = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "");

const FIXED_LABELS: Readonly<Record<string, string>> = {
  codex_command: "Command",
  codex_plan: "Plan",
  codex_goal: "Goal",
  codex_question: "Question",
  codex_approval: "Approval",
  codex_file_change: "File change",
  codex_mcp_tool: "Tool",
  codex_dynamic_tool: "Tool",
  codex_web_search: "Web search",
  codex_subagent: "Subagent",
  run_subagent: "Subagent",
  start_task: "Task",
  start_workflow: "Workflow",
  workflows: "Workflow",
  schedule_task: "Recurring task",
  edit_task_schedule: "Edit routine",
  delete_task_schedule: "Delete routine",
  opencompany_slack_bot_send_message: "Slack bot",
  post_slack_message: "Slack bot",
  read_workflow_memory: "Workflow memory",
  update_workflow_memory: "Update workflow memory",
  web_fetch: "Web fetch",
  web_search: "Web search",
  browser_open: "Open page",
  browser_snapshot: "Page snapshot",
  browser_click: "Click",
  browser_fill: "Fill field",
  browser_wait: "Wait",
  browser_read: "Read page",
  browser_get: "Inspect page",
  browser_find: "Find on page",
  browser_scroll: "Scroll",
  browser_screenshot: "Screenshot",
  browser_close: "Close browser",
  use_skill: "Skill",
  list_skills: "Skills",
  list_actions: "Integrations",
  describe_actions: "Integrations",
  write_artifact: "Write file",
  publish_artifact: "Publish file",
  update_task_status: "Task status",
  workspace_skills: "Skills",
};

const SYMBOLS = {
  command: "terminal",
  read: "doc.text",
  write: "square.and.pencil",
  search: "magnifyingglass",
  web: "globe",
  browser: "safari",
  subagent: "person.2",
  task: "checklist",
  workflow: "arrow.triangle.branch",
  plan: "list.bullet.clipboard",
  question: "questionmark.bubble",
  approval: "hand.raised",
  skill: "book.closed",
  action: "bolt.horizontal",
  message: "bubble.left",
  file: "doc.richtext",
  memory: "tray.full",
  tool: "wrench.and.screwdriver",
} as const satisfies Record<string, SFSymbol>;

const SANDBOX_MARKERS = [
  "/opencompany-goat/codex-chat/",
  "/opencompany-goat/claude-chat/",
  "/codex-chat/",
  "/claude-chat/",
  "/workspaces/",
  "/workspace/",
];

const repoRelativePath = (value: string) => {
  const normalized = value.replace(/\\/gu, "/");
  for (const marker of SANDBOX_MARKERS) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex < 0) continue;
    const workspacePath = normalized.slice(markerIndex + marker.length);
    const separator = workspacePath.indexOf("/");
    if (separator >= 0 && workspacePath.slice(separator + 1)) {
      return workspacePath.slice(separator + 1);
    }
  }
  return normalized;
};

const filePaths = (sources: readonly Record<string, unknown>[]) => {
  const paths: string[] = [];
  const add = (value: unknown) => {
    const path = readString(value);
    if (path && !paths.includes(path)) paths.push(path);
  };
  for (const source of sources) {
    for (const key of ["file_path", "filePath", "notebook_path", "notebookPath", "path"]) {
      add(source[key]);
    }
    for (const list of [source.locations, source.changes]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (isRecord(entry)) add(entry.path);
    }
  }
  return paths.map(repoRelativePath);
};

const describePaths = (paths: readonly string[]) => {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  return `${paths[0]} and ${paths.length - 1} more`;
};

/** Unwraps `bash -lc '…'` so the card shows the command the agent meant. */
const displayCommand = (value: string) => {
  let command = value.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|)sh\s+-(?:lc|cl|c)\s+([\s\S]+)$/iu.exec(command);
    if (!match?.[1]) break;
    command = match[1].trim();
    if (command.length >= 2 && (command.startsWith("'") || command.startsWith('"'))) {
      const quote = command[0];
      if (command.endsWith(quote)) command = command.slice(1, -1);
    }
  }
  return command;
};

const actionSource = (action: string) => {
  const plugin = /^plugin:([^:]+):/u.exec(action);
  const slug = plugin?.[1] ?? action.split(".", 1)[0] ?? "";
  return slug.replace(/_account$/u, "").toLowerCase();
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  ...OFFICIAL_PLUGIN_LABELS,
  github: "GitHub",
  github_user: "GitHub",
  session_history: "Session history",
  linkedin: "LinkedIn",
  seo: "SEO",
  tiktok: "TikTok",
  youtube: "YouTube",
};

/** "Linear · Create issue", or the service alone when the id names no action. */
export const actionLabel = (action: string) => {
  const source = actionSource(action);
  const sourceLabel =
    source === "custom_mcp" || source.startsWith("custom-")
      ? "Custom integration"
      : (SOURCE_LABELS[source] ?? (sentenceCase(source) || "Action"));
  if (!action.includes(".")) return sourceLabel;
  const words = (action.split(".").at(-1) ?? "").split("_").filter(Boolean);
  const sourceWords = source.split(/[_-]+/u).filter(Boolean);
  while (words.length > 1 && sourceWords.length > 0 && words[0] === sourceWords[0]) {
    words.shift();
    sourceWords.shift();
  }
  const verb = sentenceCase(words.join(" "));
  return verb ? `${sourceLabel} · ${verb}` : sourceLabel;
};

const parseMcpTarget = (identity: string, server: string | null, tool: string | null) => {
  if (server && tool) return { server, tool };
  const underscored = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/iu.exec(identity);
  if (underscored?.[1] && underscored[2]) return { server: underscored[1], tool: underscored[2] };
  const dotted = /^mcp\.([^.]+)\.(.+)$/iu.exec(identity);
  return dotted?.[1] && dotted[2] ? { server: dotted[1], tool: dotted[2] } : null;
};

const presentation = (label: string, target: string | null, symbol: keyof typeof SYMBOLS) => ({
  label,
  target,
  symbol: SYMBOLS[symbol],
});

/**
 * Coding engines report every call under a few bucket tools; the call's identity is in its
 * envelope and, for these engine-built parts, in the normalized input.
 */
const codingToolPresentation = (tool: ToolPart): ToolPresentation | null => {
  const input = isRecord(tool.input) ? tool.input : null;
  const output = isRecord(tool.output) ? tool.output : null;
  const metadata = tool.metadata ?? null;
  const semantic = records(input, metadata);
  const values = records(input?.arguments, input?.rawInput, input, metadata, output);
  const server = firstString(semantic, ["server"]);
  const toolNameField = firstString(semantic, ["toolName"]);
  const explicitName = toolNameField === tool.name ? null : toolNameField;
  const toolField = firstString(semantic, ["tool"]);
  const identity = explicitName ?? (!server ? toolField : null) ?? tool.name;
  const normalized = normalizeIdentity(identity);
  const kind = firstString(semantic, ["kind"])?.toLowerCase() ?? null;
  const title = firstString(semantic, ["title", "label"]);
  const safeTitle = title && normalizeIdentity(title) !== normalized ? title : null;

  if (tool.name === "codex_command") {
    const command = firstString(semantic, ["command"]) ?? firstString(semantic, ["detail"]);
    const description = firstString(semantic, ["description"]);
    return presentation(
      description ?? safeTitle ?? "Command",
      command ? displayCommand(command) : null,
      "command",
    );
  }
  if (tool.name === "codex_plan") return presentation("Plan", readString(output?.text), "plan");
  if (tool.name === "codex_goal")
    return presentation("Goal", readString(output?.objective), "plan");
  if (tool.name === "codex_question")
    return presentation("Question", readString(input?.question), "question");
  if (tool.name === "codex_approval")
    return presentation(
      "Approval",
      readString(input?.title) ?? readString(input?.action),
      "approval",
    );
  if (tool.name === "codex_subagent") {
    const description = readString(input?.description) ?? readString(input?.prompt);
    return presentation(
      readString(input?.subagentType) ?? "Subagent",
      description ?? readString(input?.label),
      "subagent",
    );
  }
  if (tool.name === "codex_web_search")
    return presentation("Web search", firstString(values, ["query", "pattern"]), "web");
  if (!tool.name.startsWith("codex_")) return null;

  const mcp = parseMcpTarget(explicitName ?? identity, server, toolField);
  if (mcp) {
    if (mcp.tool === "use_action") {
      const action = firstString(records(input?.arguments, output), ["action"]);
      if (action) return presentation(actionLabel(action), null, "action");
    }
    if (mcp.tool === "workflows") {
      const args = isRecord(input?.arguments) ? input.arguments : null;
      return presentation(
        "Workflow",
        firstString(records(args?.workflow, args), ["name", "workflowId", "command"]),
        "workflow",
      );
    }
    return presentation(
      safeTitle ?? FIXED_LABELS[mcp.tool] ?? (sentenceCase(mcp.tool) || "Tool"),
      `${mcp.server} · ${mcp.tool}`,
      "tool",
    );
  }
  if (normalized === "read" || normalized === "readfile" || kind === "read")
    return presentation("Read", describePaths(filePaths(values)), "read");
  if (normalized === "write" || normalized === "writefile" || kind === "write")
    return presentation("Write", describePaths(filePaths(values)), "write");
  if (
    ["edit", "multiedit", "notebookedit"].includes(normalized) ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    tool.name === "codex_file_change"
  ) {
    const label =
      kind === "delete"
        ? "Delete"
        : kind === "move"
          ? "Move"
          : tool.name === "codex_file_change"
            ? "File change"
            : "Edit";
    return presentation(label, describePaths(filePaths(values)), "write");
  }
  if (normalized === "grep" || normalized === "glob" || (explicitName && kind === "search"))
    return presentation("Search", firstString(values, ["pattern", "query", "glob"]), "search");
  if (normalized === "todowrite" || normalized === "todo")
    return presentation("Plan", null, "plan");
  if (normalized === "webfetch" || normalized === "fetch" || (explicitName && kind === "fetch"))
    return presentation("Fetch", firstString(values, ["url", "query"]), "web");
  return presentation(
    safeTitle ?? (explicitName ? sentenceCase(explicitName) : null) ?? "Tool",
    firstString(semantic, ["detail"]),
    "tool",
  );
};

const browserTarget = (name: string, input: Record<string, unknown>) => {
  if (name === "browser_open" || name === "browser_read") {
    const url = readString(input.url);
    if (url) {
      try {
        return new URL(url).hostname || url;
      } catch {
        return url;
      }
    }
    return readString(input.filter) ?? "Current page";
  }
  if (name === "browser_screenshot") return input.fullPage === true ? "Full page" : "Viewport";
  if (name === "browser_wait" && typeof input.milliseconds === "number")
    return `${input.milliseconds} ms`;
  return firstString([input], ["ref", "selector", "text", "value", "direction", "target"]);
};

/** A one-line description of what a host tool acted on, from its arguments. */
const hostTarget = (tool: ToolPart): string | null => {
  const input = isRecord(tool.input) ? tool.input : null;
  if (typeof tool.input === "string") return readString(tool.input);
  if (!input) return null;
  if (tool.name.startsWith("browser_")) return browserTarget(tool.name, input);
  if (tool.name === "use_skill") return readString(input.skill);
  if (tool.name === "start_task" || tool.name === "start_workflow")
    return firstString([input], ["name", "workflowId", "prompt"]);
  if (tool.name === "opencompany_slack_bot_send_message" || tool.name === "post_slack_message")
    return readString(input.channel) ?? "Thread reply";
  if (tool.name === "web_search") return readString(input.query);
  if (tool.name === "web_fetch") return readString(input.url);
  return firstString(
    [input],
    ["command", "query", "url", "path", "file_path", "name", "title", "prompt", "action"],
  );
};

const hostSymbol = (name: string): keyof typeof SYMBOLS => {
  if (name.startsWith("browser_")) return "browser";
  if (name === "web_search" || name === "web_fetch") return "web";
  if (name === "run_subagent") return "subagent";
  if (name === "start_task" || name === "update_task_status") return "task";
  if (name === "start_workflow" || name === "workflows") return "workflow";
  if (name.includes("skill")) return "skill";
  if (name.includes("action")) return "action";
  if (name.includes("slack")) return "message";
  if (name.includes("artifact")) return "file";
  if (name.includes("memory")) return "memory";
  if (name.includes("wiki")) return "read";
  if (name.includes("search")) return "search";
  return "tool";
};

export const toolPresentation = (tool: ToolPart): ToolPresentation => {
  const coding = codingToolPresentation(tool);
  if (coding) return coding;
  if (tool.name === "use_action") {
    const action = isRecord(tool.input) ? readString(tool.input.action) : null;
    return presentation(action ? actionLabel(action) : "Action", null, "action");
  }
  const label =
    FIXED_LABELS[tool.name] ??
    // A lifecycle event's label stands in until the full presentation arrives.
    tool.label ??
    (sentenceCase(tool.name) || "Tool");
  return {
    label,
    target: hostTarget(tool) ?? tool.detail ?? null,
    symbol: SYMBOLS[hostSymbol(tool.name)],
  };
};

export const TOOL_STATUS_TEXT: Readonly<Record<ToolStatus, string>> = {
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  denied: "Declined",
  interrupted: "Stopped",
};

export const isSubagentTool = (tool: ToolPart) =>
  tool.name === "codex_subagent" || tool.name === "run_subagent";

/**
 * Tool calls whose result is something the reader acts on: a started Task or Workflow, or an
 * integration that needs connecting. They stay visible when a finished turn folds its trace.
 */
export const isOutputTool = (tool: ToolPart): boolean => {
  if (tool.status !== "completed") return false;
  const output = isRecord(tool.output) ? tool.output : null;
  if (!output) return false;
  if (
    ["start_task", "start_workflow", "workflows"].includes(tool.name) &&
    typeof output.taskId === "string"
  )
    return true;
  if (tool.name === "workflows" && isRecord(output.workflow)) return true;
  if (tool.name === "list_actions" && output.ok === true && isRecord(output.source)) {
    const connection = isRecord(output.source.connection) ? output.source.connection : null;
    return connection?.status === "not_connected" || connection?.status === "needs_reauth";
  }
  return false;
};
