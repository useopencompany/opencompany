import { isBrowserToolName } from "@opencompany/browser-tools";
import type { GoatTaskStatus } from "@opencompany/db/goat-schema";
import type { GoatTaskView } from "@/components/GoatSurface";
import {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolOutput,
  type GoatChatUiMessage,
  type GoatTaskCardMetadata,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_TASK_TOOL_PART_TYPE,
  type StartTaskToolOutput,
  USE_ACTION_TOOL_NAME,
  type UseActionToolOutput,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@/lib/chat-ui";

export type AssistantRenderItem =
  | { type: "text"; key: string; text: string; citations: BrainCitation[] }
  | { type: "reasoning"; key: string; text: string }
  | { type: "task"; key: string; task: ChatTaskCardView }
  | { type: "tool"; key: string; tool: ToolCallView };

export type BrainCitation = {
  key: string;
  label: string;
  title: string;
  href: string;
  // External chips open provider URLs in a new tab; internal chips stay
  // next/link Brain navigations.
  external?: boolean;
};

export type ChatTaskCardView = {
  id: string;
  displayId: string | null;
  title: string | null;
  status: GoatTaskStatus | null;
};

export type ChatTaskLookup = ReadonlyMap<string, ChatTaskCardView>;

export type ToolCallView = {
  name: string;
  label: string;
  status: "running" | "completed" | "failed" | "waiting" | "stopped";
  statusText: string;
  detail: string | null;
  input: unknown;
  output: unknown;
  errorText: string | null;
  // Raw part state, so approval-aware rows (use_action) can tell a pending
  // approval request apart from an in-flight call.
  state: string;
  approvalId: string | null;
};

export function getOrderedAssistantItems(
  message: GoatChatUiMessage,
  taskLookup: ChatTaskLookup,
  stopped = false,
) {
  const items: AssistantRenderItem[] = [];
  let textBuffer = "";
  let pendingCitations: BrainCitation[] = [];

  const flushText = (key: string) => {
    const text = textBuffer.trim();
    textBuffer = "";
    if (!text) return;
    items.push({ type: "text", key, text, citations: pendingCitations });
    pendingCitations = [];
  };

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      textBuffer += part.text;
      continue;
    }
    if (part.type === "reasoning") {
      if (!part.text.trim()) continue;
      flushText(`text-${index}`);
      items.push({ type: "reasoning", key: `reasoning-${index}`, text: part.text });
      continue;
    }
    if (!isToolPartRecord(part)) continue;
    const tool = toolCallViewFromPart(part, stopped);
    if (!tool) continue;
    flushText(`text-${index}`);
    if (tool.name === GOAT_BRAIN_TOOL_NAME && tool.status === "completed") {
      pendingCitations = mergeBrainCitations(
        pendingCitations,
        brainCitationsFromToolOutput(tool.output),
      );
    }
    if (
      part.type === START_TASK_TOOL_PART_TYPE &&
      part.state === "output-available" &&
      isStartTaskToolOutput(part.output)
    ) {
      items.push({
        type: "task",
        key: `task-${index}`,
        task: resolveChatTaskCard(taskFromOutput(part.output), taskLookup),
      });
      continue;
    }
    items.push({
      type: "tool",
      key: `tool-${index}`,
      tool,
    });
  }

  flushText("text-end");

  const metadataTask = metadataTaskCard(message.metadata);
  if (!items.some((item) => item.type === "task") && metadataTask) {
    items.push({
      type: "task",
      key: "task-metadata",
      task: resolveChatTaskCard(metadataTask, taskLookup),
    });
  }

  return items;
}

export function metadataTaskCard(
  metadata: GoatChatUiMessage["metadata"],
): GoatTaskCardMetadata | null {
  if (metadata?.task) return metadata.task;
  if (metadata?.taskId) return { id: metadata.taskId };
  return null;
}

export function toolCallViewFromPart(
  part: Record<string, unknown> & { type: string },
  stopped = false,
): ToolCallView | null {
  const name = toolNameFromPart(part);
  if (!name) return null;
  const state = typeof part.state === "string" ? part.state : "";
  const output = part.output;
  const failedGoatBrain =
    name === GOAT_BRAIN_TOOL_NAME && state === "output-available" && isGoatBrainToolOutput(output)
      ? !goatBrainToolOutputSucceeded(output)
      : false;
  // use_action reports failures inside its structured output, not via the
  // part state: completed-with-ok=false renders as failed.
  const failedAction =
    name === USE_ACTION_TOOL_NAME && state === "output-available" && isUseActionToolOutput(output)
      ? output.ok === false && output.error.code !== "approval_required"
      : false;
  const awaitingCapabilityApproval =
    name === USE_ACTION_TOOL_NAME &&
    state === "output-available" &&
    isUseActionToolOutput(output) &&
    output.ok === false &&
    output.error.code === "approval_required";
  const failedPublicWebTool =
    (name === WEB_FETCH_TOOL_NAME || name === WEB_SEARCH_TOOL_NAME) &&
    state === "output-available" &&
    isRecord(output) &&
    output.ok === false;
  const failedBrowserTool =
    isBrowserToolName(name) &&
    state === "output-available" &&
    isRecord(output) &&
    output.ok === false;
  // Codex item parts (file changes, MCP tools, web searches) carry their outcome in
  // output.status rather than the part state.
  const codexItemOutcome =
    isCodexItemToolName(name) && state === "output-available" && isRecord(output)
      ? readString(output.status)
      : null;
  const status = failedGoatBrain
    ? "failed"
    : failedAction
      ? "failed"
      : awaitingCapabilityApproval
        ? "waiting"
        : failedPublicWebTool
          ? "failed"
          : failedBrowserTool
            ? "failed"
            : codexItemOutcome === "failed"
              ? "failed"
              : codexItemOutcome === "interrupted"
                ? "stopped"
                : toolStatusFromState(state, stopped);
  const codexPromptOutcome =
    (name === CODEX_QUESTION_TOOL_NAME || name === CODEX_APPROVAL_TOOL_NAME) &&
    state === "output-available" &&
    isRecord(output)
      ? readString(output.status)
      : null;
  return {
    name,
    label: name === USE_ACTION_TOOL_NAME ? actionToolLabel(part.input) : toolLabel(name),
    status,
    statusText:
      codexPromptOutcome === "answered"
        ? "Answered"
        : codexPromptOutcome === "auto-resolved"
          ? "Auto-resolved"
          : codexPromptOutcome === "unanswered" || codexPromptOutcome === "canceled"
            ? codexPromptOutcome === "canceled"
              ? "Canceled"
              : "Unanswered"
            : awaitingCapabilityApproval
              ? "Approval needed"
              : toolStatusText(status, state),
    detail: toolDetail(name, part, status),
    input: part.input,
    output: part.output,
    errorText: typeof part.errorText === "string" ? part.errorText : null,
    state,
    approvalId:
      isRecord(part.approval) && typeof part.approval.id === "string" ? part.approval.id : null,
  };
}

function isCodexItemToolName(name: string) {
  return (
    name === CODEX_FILE_CHANGE_TOOL_NAME ||
    name === CODEX_MCP_TOOL_NAME ||
    name === CODEX_WEB_SEARCH_TOOL_NAME
  );
}

export function isToolPartRecord(
  value: unknown,
): value is Record<string, unknown> & { type: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

export function toolNameFromPart(part: Record<string, unknown> & { type: string }) {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  return part.type.slice("tool-".length);
}

export function toolStatusFromState(state: string, stopped = false): ToolCallView["status"] {
  if (state === "output-error" || state === "output-denied") return "failed";
  if (state === "output-available") return "completed";
  if (state === "approval-requested" || state === "approval-responded") return "waiting";
  if (stopped) return "stopped";
  return "running";
}

export function toolStatusText(status: ToolCallView["status"], state: string) {
  if (state === "output-denied") return "Declined";
  if (state === "approval-requested") return "Waiting";
  if (state === "approval-responded") return "Approved";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "stopped") return "Stopped";
  return "Running";
}

export function toolLabel(name: string) {
  if (name === GOAT_BRAIN_TOOL_NAME) return "Brain";
  if (name === CODEX_COMMAND_TOOL_NAME) return "Command";
  if (name === CODEX_PLAN_TOOL_NAME) return "Plan";
  if (name === CODEX_GOAL_TOOL_NAME) return "Goal";
  if (name === CODEX_QUESTION_TOOL_NAME) return "Question";
  if (name === CODEX_APPROVAL_TOOL_NAME) return "Approval";
  if (name === CODEX_FILE_CHANGE_TOOL_NAME) return "File change";
  if (name === CODEX_MCP_TOOL_NAME) return "MCP tool";
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) return "Web search";
  if (name === START_TASK_TOOL_NAME) return "Task";
  if (name === SCHEDULE_TASK_TOOL_NAME) return "Recurring task";
  if (name === EDIT_TASK_SCHEDULE_TOOL_NAME) return "Edit routine";
  if (name === DELETE_TASK_SCHEDULE_TOOL_NAME) return "Delete routine";
  if (name === WEB_FETCH_TOOL_NAME) return "Web Fetch";
  if (name === WEB_SEARCH_TOOL_NAME) return "Web Search";
  if (name === "browser_open") return "Open page";
  if (name === "browser_snapshot") return "Page snapshot";
  if (name === "browser_click") return "Click";
  if (name === "browser_fill") return "Fill field";
  if (name === "browser_wait") return "Wait";
  if (name === "browser_read") return "Read page";
  if (name === "browser_get") return "Inspect page";
  if (name === "browser_find") return "Find on page";
  if (name === "browser_scroll") return "Scroll";
  if (name === "browser_screenshot") return "Screenshot";
  if (name === "browser_close") return "Close browser";
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function toolDetail(
  name: string,
  part: Record<string, unknown> & { type: string },
  status: ToolCallView["status"],
) {
  if (name === CODEX_COMMAND_TOOL_NAME) {
    return isRecord(part.input) && typeof part.input.command === "string"
      ? part.input.command
      : null;
  }

  if (
    name === CODEX_PLAN_TOOL_NAME ||
    name === CODEX_GOAL_TOOL_NAME ||
    name === CODEX_QUESTION_TOOL_NAME ||
    name === CODEX_APPROVAL_TOOL_NAME ||
    isCodexItemToolName(name)
  ) {
    return codexStateToolDetail(name, part);
  }

  if (part.state === "output-error" && typeof part.errorText === "string") {
    return truncateToolPreview(part.errorText);
  }

  if (name === GOAT_BRAIN_TOOL_NAME) {
    return goatBrainToolDetail(part, status);
  }

  if (name === START_TASK_TOOL_NAME) {
    return startTaskToolDetail(part);
  }

  if (name === SCHEDULE_TASK_TOOL_NAME) {
    return scheduleTaskToolDetail(part);
  }
  if (name === EDIT_TASK_SCHEDULE_TOOL_NAME || name === DELETE_TASK_SCHEDULE_TOOL_NAME) {
    return taskScheduleMutationToolDetail(part);
  }
  if (name === USE_ACTION_TOOL_NAME) {
    return actionToolDetail(part);
  }
  if (isBrowserToolName(name)) {
    return browserToolDetail(name, part);
  }
  if (
    (name === WEB_FETCH_TOOL_NAME || name === WEB_SEARCH_TOOL_NAME) &&
    part.state === "output-available" &&
    isRecord(part.output) &&
    part.output.ok === false &&
    typeof part.output.error === "string"
  ) {
    return truncateToolPreview(part.output.error);
  }

  return formatToolInput(part.input);
}

function browserToolDetail(name: string, part: Record<string, unknown> & { type: string }) {
  const input = isRecord(part.input) ? part.input : {};
  const output = isRecord(part.output) ? part.output : {};
  if (
    part.state === "output-available" &&
    output.ok === false &&
    typeof output.error === "string"
  ) {
    return truncateToolPreview(output.error);
  }

  if (name === "browser_open" || name === "browser_read") {
    const url = readString(input.url);
    if (url) return truncateToolPreview(browserUrlLabel(url));
    const filter = readString(input.filter);
    return truncateToolPreview(filter ? `Filter: ${filter}` : "Current page");
  }
  if (name === "browser_snapshot") {
    const selector = readString(input.selector);
    return truncateToolPreview(selector ?? "Interactive page elements");
  }
  if (name === "browser_click" || name === "browser_fill") {
    return truncateToolPreview(readString(input.ref));
  }
  if (name === "browser_wait") {
    const milliseconds = typeof input.milliseconds === "number" ? `${input.milliseconds} ms` : null;
    return truncateToolPreview(
      milliseconds ??
        readString(input.ref) ??
        readString(input.text) ??
        readString(input.urlPattern) ??
        readString(input.loadState),
    );
  }
  if (name === "browser_get") {
    return truncateToolPreview(
      [readString(input.target), readString(input.ref) ?? readString(input.selector)]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (name === "browser_find") {
    return truncateToolPreview(
      [readString(input.by), readString(input.value), readString(input.action)]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (name === "browser_scroll") {
    const pixels = typeof input.pixels === "number" ? `${input.pixels}px` : null;
    return truncateToolPreview([readString(input.direction), pixels].filter(Boolean).join(" · "));
  }
  if (name === "browser_screenshot") {
    return input.fullPage === true ? "Full page" : "Current viewport";
  }
  return null;
}

function browserUrlLabel(value: string) {
  try {
    const url = new URL(value);
    return url.hostname || value;
  } catch {
    return value;
  }
}

function actionToolDetail(part: Record<string, unknown>) {
  const action = isRecord(part.input) ? readString(part.input.action) : null;
  if (part.state === "output-available" && isUseActionToolOutput(part.output)) {
    if (part.output.ok === false) {
      return truncateToolPreview([action, part.output.error.message].filter(Boolean).join(" - "));
    }
    if (isRecord(part.output.result) && part.output.result.untrustedProviderData === true) {
      const resultCount =
        typeof part.output.result.resultCount === "number"
          ? `${part.output.result.resultCount} result${
              part.output.result.resultCount === 1 ? "" : "s"
            }`
          : null;
      const cost = isRecord(part.output.result.cost)
        ? part.output.result.cost.state === "settling"
          ? "cost settling"
          : typeof part.output.result.cost.totalUsdMicros === "number"
            ? formatActionCost(part.output.result.cost.totalUsdMicros)
            : null
        : null;
      return truncateToolPreview([action, resultCount, cost].filter(Boolean).join(" · "));
    }
    return truncateToolPreview(action);
  }
  return truncateToolPreview(action) ?? formatToolInput(part.input);
}

function formatActionCost(usdMicros: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usdMicros < 100_000 ? 3 : 2,
    maximumFractionDigits: usdMicros < 100_000 ? 3 : 2,
  }).format(usdMicros / 1_000_000);
}

function actionToolLabel(input: unknown) {
  const action = isRecord(input) ? readString(input.action) : null;
  if (!action) return "Action";
  return toolLabel(action.split(".").join("_"));
}

export function isUseActionToolOutput(value: unknown): value is UseActionToolOutput {
  if (!isRecord(value)) return false;
  if (typeof value.ok !== "boolean" || typeof value.action !== "string") return false;
  return value.ok === true || isRecord(value.error);
}

function goatBrainToolDetail(
  part: Record<string, unknown> & { type: string },
  status: ToolCallView["status"],
) {
  if (part.state === "output-available" && isGoatBrainToolOutput(part.output)) {
    if (!goatBrainToolOutputSucceeded(part.output)) {
      return truncateToolPreview(
        firstNonEmptyLine(part.output.error, part.output.stderr, part.output.stdout) ??
          formatToolInput(part.input),
      );
    }
    return truncateToolPreview(
      firstNonEmptyLine(
        goatBrainCliSuccessSummary(part.output.stdout),
        part.output.stdout,
        part.output.stderr,
      ) ?? formatToolInput(part.input),
    );
  }

  const inputPreview = formatToolInput(part.input);
  if (inputPreview) return inputPreview;
  return status === "running" ? "Running goat_brain" : null;
}

function startTaskToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.input)) {
    const name = typeof part.input.name === "string" ? part.input.name : null;
    const prompt = typeof part.input.prompt === "string" ? part.input.prompt : null;
    return truncateToolPreview(name ?? prompt);
  }
  return formatToolInput(part.input);
}

function scheduleTaskToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.output)) {
    const name = typeof part.output.scheduleName === "string" ? part.output.scheduleName : null;
    const cron = typeof part.output.cron === "string" ? part.output.cron : null;
    const timezone = typeof part.output.timezone === "string" ? part.output.timezone : null;
    return truncateToolPreview([name, cron, timezone].filter(Boolean).join(" - "));
  }
  if (isRecord(part.input)) {
    const source =
      typeof part.input.sourceDescription === "string" ? part.input.sourceDescription : null;
    const cron = typeof part.input.cron === "string" ? part.input.cron : null;
    return truncateToolPreview([source, cron].filter(Boolean).join(" - "));
  }
  return formatToolInput(part.input);
}

function taskScheduleMutationToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.output)) {
    const ok = part.output.ok === true;
    const name =
      typeof part.output.scheduleName === "string"
        ? part.output.scheduleName
        : typeof part.output.error === "string"
          ? part.output.error
          : null;
    return truncateToolPreview([ok ? "Done" : "Issue", name].filter(Boolean).join(" - "));
  }
  if (isRecord(part.input)) {
    const scheduleName =
      typeof part.input.scheduleName === "string"
        ? part.input.scheduleName
        : typeof part.input.scheduleId === "string"
          ? part.input.scheduleId
          : null;
    return truncateToolPreview(scheduleName ?? formatToolInput(part.input));
  }
  return formatToolInput(part.input);
}

function codexStateToolDetail(name: string, part: Record<string, unknown>) {
  const input = isRecord(part.input) ? part.input : {};
  const output = isRecord(part.output) ? part.output : {};

  if (name === CODEX_PLAN_TOOL_NAME) {
    return truncateToolPreview(readString(output.text) ?? readString(input.text) ?? "Plan mode");
  }
  if (name === CODEX_GOAL_TOOL_NAME) {
    const status = readString(output.status);
    const objective = readString(output.objective);
    return truncateToolPreview(
      [status ? `Status: ${status}` : null, objective].filter(Boolean).join(" - "),
    );
  }
  if (name === CODEX_QUESTION_TOOL_NAME || name === CODEX_APPROVAL_TOOL_NAME) {
    const prompt =
      name === CODEX_QUESTION_TOOL_NAME
        ? readString(input.question)
        : (readString(input.title) ?? readString(input.action));
    const fallback =
      name === CODEX_QUESTION_TOOL_NAME ? "Codex asked for input" : "Codex asked for approval";
    return truncateToolPreview(prompt ?? fallback);
  }
  if (name === CODEX_FILE_CHANGE_TOOL_NAME) {
    const paths = codexFileChangePaths(output.changes) ?? codexFileChangePaths(input.changes);
    if (!paths || paths.length === 0) return "File changes";
    if (paths.length === 1) return truncateToolPreview(paths[0]);
    return truncateToolPreview(`${paths.length} files: ${paths.join(", ")}`);
  }
  if (name === CODEX_MCP_TOOL_NAME) {
    const target = [readString(input.server), readString(input.tool)].filter(Boolean).join(".");
    const error = readString(output.error);
    return truncateToolPreview([target || "MCP tool call", error].filter(Boolean).join(" - "));
  }
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) {
    return truncateToolPreview(readString(input.query) ?? "Web search");
  }
  return null;
}

function codexFileChangePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths = value
    .map((entry) => (isRecord(entry) && typeof entry.path === "string" ? entry.path : null))
    .filter((path): path is string => Boolean(path));
  return paths.length > 0 ? paths : null;
}

function formatToolInput(value: unknown) {
  if (typeof value === "string") return truncateToolPreview(value);
  if (!isRecord(value)) return null;
  if (typeof value.args === "string") return truncateToolPreview(`goat_brain ${value.args}`);
  if (typeof value.command === "string") {
    return truncateToolPreview(`goat_brain ${formatGoatBrainCommandInput(value)}`);
  }
  if (typeof value.action === "string") {
    const detail =
      typeof value.text === "string"
        ? value.text
        : typeof value.id === "string"
          ? value.id
          : undefined;
    return truncateToolPreview(detail ? `${value.action}: ${detail}` : value.action);
  }
  if (typeof value.query === "string") return truncateToolPreview(`query: ${value.query}`);
  if (typeof value.prompt === "string") return truncateToolPreview(value.prompt);
  try {
    return truncateToolPreview(JSON.stringify(value));
  } catch {
    return null;
  }
}

function formatGoatBrainCommandInput(input: Record<string, unknown>) {
  const command = input.command;
  const flags = isRecord(input.flags) ? input.flags : {};
  const parts = [String(command)];
  for (const [rawName, value] of Object.entries(flags)) {
    const name = rawName
      .replace(/_/g, "-")
      .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
      .replace(/^-+/, "")
      .replace(/-+/g, "-");
    if (typeof value === "boolean") {
      if (value) parts.push(`--${name}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(`--${name}`, formatToolArg(item));
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`--${name}`, formatToolArg(String(value)));
    }
  }
  return parts.join(" ");
}

function formatToolArg(value: string) {
  if (/^[a-zA-Z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export function isGoatBrainToolOutput(value: unknown): value is GoatBrainToolOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    (typeof value.brainRef === "string" || value.brainRef === undefined) &&
    (typeof value.stdout === "string" || value.stdout === undefined) &&
    (typeof value.stderr === "string" || value.stderr === undefined) &&
    (typeof value.error === "string" || value.error === undefined)
  );
}

const MAX_BRAIN_CITATIONS_PER_TEXT = 6;

export function brainCitationsFromToolOutput(output: unknown): BrainCitation[] {
  if (!isGoatBrainToolOutput(output) || !output.ok) return [];
  const parsed = isRecord(output.parsed) ? output.parsed : null;
  if (!parsed) return [];

  const brainRef = readString(output.brainRef);
  const citations: BrainCitation[] = [];
  if (Array.isArray(parsed.hits)) {
    for (const hit of parsed.hits) addBrainDocumentCitation(citations, hit, brainRef);
  }
  if (Array.isArray(parsed.documents)) {
    for (const document of parsed.documents) {
      addBrainDocumentCitation(citations, document, brainRef);
    }
  }
  if (Array.isArray(parsed.entries)) {
    addTimelineDocumentCitation(citations, parsed, brainRef);
  }

  return mergeBrainCitations([], citations);
}

function addTimelineDocumentCitation(
  citations: BrainCitation[],
  value: Record<string, unknown>,
  brainRef: string | null,
) {
  const id = readString(value.id);
  if (!id) return;
  addUniqueBrainCitation(citations, {
    key: `brain:${brainRef ?? ""}:${id}`,
    label: id,
    title: `Brain document ${id}`,
    href: brainRef ? brainRootHref(brainRef) : "/brain",
  });
}

function addBrainDocumentCitation(
  citations: BrainCitation[],
  value: unknown,
  brainRef: string | null,
) {
  if (!isRecord(value)) return;
  if (readString(value.kind) === "evidence") return;
  const id = readString(value.id) ?? readString(value.brainId) ?? readString(value.requestedId);
  const title = readString(value.title) ?? id;
  if (!id || !title) return;

  const folder = readString(value.folder) ?? readString(value.folderPath);
  const href = folder ? brainDocumentHref(brainRef, folder, id) : brainRootHref(brainRef);
  addUniqueBrainCitation(citations, {
    key: `brain:${brainRef ?? ""}:${folder ?? ""}:${id}`,
    label: title,
    title: folder ? `${title} (${folder}/${id})` : `${title} (${id})`,
    href,
  });
}

function mergeBrainCitations(
  existing: readonly BrainCitation[],
  additions: readonly BrainCitation[],
): BrainCitation[] {
  const citations: BrainCitation[] = [];
  for (const citation of [...existing, ...additions]) {
    addUniqueBrainCitation(citations, citation);
    if (citations.length >= MAX_BRAIN_CITATIONS_PER_TEXT) break;
  }
  return citations;
}

function addUniqueBrainCitation(citations: BrainCitation[], citation: BrainCitation) {
  if (citations.some((current) => current.key === citation.key)) return;
  citations.push(citation);
}

function brainDocumentHref(brainRef: string | null, folder: string, id: string) {
  return brainPathHref([...(brainRef ? [brainRef] : []), ...folder.split("/").filter(Boolean), id]);
}

function brainRootHref(brainRef: string | null) {
  return brainPathHref(brainRef ? [brainRef] : []);
}

function brainPathHref(segments: string[]) {
  return `/brain${segments.length ? `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}` : ""}`;
}

function goatBrainToolOutputSucceeded(output: GoatBrainToolOutput) {
  if (output.ok) return true;
  return parseGoatBrainCliJson(output.stdout)?.ok === true;
}

function goatBrainCliSuccessSummary(stdout: string | undefined) {
  const parsed = parseGoatBrainCliJson(stdout);
  if (!parsed || parsed.ok !== true) return null;
  const appliedCount = Array.isArray(parsed.applied) ? parsed.applied.length : null;
  if (typeof appliedCount === "number" && appliedCount > 0) {
    return `Ingested ${appliedCount} brain change${appliedCount === 1 ? "" : "s"}.`;
  }
  const planCount = Array.isArray(parsed.plan) ? parsed.plan.length : null;
  if (parsed.dryRun === true && typeof planCount === "number") {
    return `Dry run planned ${planCount} brain change${planCount === 1 ? "" : "s"}.`;
  }
  return null;
}

function parseGoatBrainCliJson(stdout: string | undefined): Record<string, unknown> | null {
  if (!stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstNonEmptyLine(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const line = value?.trim().split(/\r?\n/, 1)[0]?.trim();
    if (line) return line;
  }
  return null;
}

export function truncateToolPreview(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
}

export function buildChatTaskLookup(input: {
  messages: readonly GoatChatUiMessage[];
  tasks: readonly GoatTaskView[];
  liveTasks: readonly GoatTaskView[] | null;
}): ChatTaskLookup {
  const lookup = new Map<string, ChatTaskCardView>();

  for (const message of input.messages) {
    const task = metadataTaskCard(message.metadata);
    if (task) setChatTaskLookupValue(lookup, task);
  }

  for (const task of input.tasks) {
    setChatTaskLookupValue(lookup, taskCardFromTask(task));
  }

  for (const task of input.liveTasks ?? []) {
    setChatTaskLookupValue(lookup, taskCardFromTask(task));
  }

  return lookup;
}

function setChatTaskLookupValue(lookup: Map<string, ChatTaskCardView>, task: GoatTaskCardMetadata) {
  const existing = lookup.get(task.id);
  lookup.set(task.id, {
    id: task.id,
    displayId: task.displayId ?? existing?.displayId ?? null,
    title: task.title ?? existing?.title ?? null,
    status: task.status ?? existing?.status ?? null,
  });
}

function taskCardFromTask(task: GoatTaskView): ChatTaskCardView {
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.name,
    status: task.status,
  };
}

export function resolveChatTaskCard(
  fallback: GoatTaskCardMetadata,
  lookup: ChatTaskLookup,
): ChatTaskCardView {
  const resolved = lookup.get(fallback.id);
  return {
    id: fallback.id,
    displayId: resolved?.displayId ?? fallback.displayId ?? null,
    title: resolved?.title ?? fallback.title ?? null,
    status: resolved?.status ?? fallback.status ?? null,
  };
}

export function taskFromOutput(output: StartTaskToolOutput): GoatTaskCardMetadata {
  return {
    id: output.taskId,
    displayId: output.taskDisplayId,
    title: output.taskName,
    status: output.status === "queued" ? "queued" : null,
  };
}

export function isStartTaskToolOutput(value: unknown): value is StartTaskToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.taskId === "string" &&
    typeof output.taskDisplayId === "string" &&
    typeof output.taskName === "string"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function shouldShowThinkingBubble(messages: readonly GoatChatUiMessage[]) {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role === "user") return true;
  return getOrderedAssistantItems(lastMessage, new Map<string, ChatTaskCardView>()).length === 0;
}

export function formatDebugValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
