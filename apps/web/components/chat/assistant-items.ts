import { SUBAGENT_TOOL_NAME } from "@opencompany/agent/subagent";
import type { TaskStatus } from "@opencompany/agent/task-runtime-types";
import {
  CHAT_ARTIFACT_DATA_PART_TYPE,
  CHAT_STEERING_DATA_PART_TYPE,
  CODEX_DYNAMIC_TOOL_NAME,
  type PublishedChatArtifact,
  parsePublishedChatArtifact,
} from "@opencompany/agent-runtime";
import { isBrowserToolName } from "@opencompany/browser-tools";
import type { TaskView } from "@/components/Surface";
import { actionRowLabel, actionSource } from "@/lib/action-identity";
import {
  type ChatUiMessage,
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
  LEGACY_SLACK_BOT_TOOL_NAME,
  SLACK_BOT_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_TASK_TOOL_PART_TYPE,
  START_WORKFLOW_TOOL_NAME,
  START_WORKFLOW_TOOL_PART_TYPE,
  type StartTaskToolOutput,
  type TaskCardMetadata,
  USE_ACTION_TOOL_NAME,
  USE_SKILL_TOOL_NAME,
  type UseActionToolOutput,
  type UseSkillToolOutput,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@/lib/chat-ui";
import { codingToolPresentation } from "@/lib/coding-tool-presentation";
import { type WorkflowCardOutput, workflowCardOutputFromTool } from "./workflow-tool-output";

// Recurring Tasks were removed, but their tool calls are still in saved transcripts. These names
// are spelled out because the constants no longer exist; they only ever match historical parts.
const RETIRED_SCHEDULE_TASK_TOOL_NAME = "schedule_task";
const RETIRED_EDIT_TASK_SCHEDULE_TOOL_NAME = "edit_task_schedule";
const RETIRED_DELETE_TASK_SCHEDULE_TOOL_NAME = "delete_task_schedule";

export type AssistantRenderItem =
  | { type: "text"; key: string; text: string }
  | { type: "reasoning"; key: string; text: string }
  | { type: "steering"; key: string; text: string }
  | { type: "task"; key: string; task: ChatTaskCardView }
  | { type: "artifact"; key: string; artifact: PublishedChatArtifact }
  | { type: "workflow"; key: string; output: WorkflowCardOutput }
  | { type: "tool"; key: string; tool: ToolCallView }
  | { type: "subagent"; key: string; subagent: SubagentRenderView };

// What the user first saw the engine produce. Steering is the user's own message echoed into the
// turn, not engine output, so it never satisfies time-to-first-output.
export type AssistantVisibleOutputKind = Exclude<AssistantRenderItem["type"], "steering"> | "error";

// A Claude Code Task call: the tool header plus the subagent's own nested trace, already
// resolved into render items so the UI can render them under an expandable subagent row.
export type SubagentRenderView = {
  tool: ToolCallView;
  children: AssistantRenderItem[];
};

type RenderablePart = Record<string, unknown> & { type: string };

export type ChatTaskCardView = {
  id: string;
  displayId: string | null;
  title: string | null;
  status: TaskStatus | null;
};

export type ChatTaskLookup = ReadonlyMap<string, ChatTaskCardView>;

export type ToolCallView = {
  toolCallId: string;
  name: string;
  label: string;
  status: "running" | "completed" | "failed" | "waiting" | "stopped";
  statusText: string;
  detail: string | null;
  detailChips: string[];
  input: unknown;
  output: unknown;
  errorText: string | null;
  // Raw part state, so approval-aware rows (use_action) can tell a pending
  // approval request apart from an in-flight call.
  state: string;
  approvalId: string | null;
  // The service a connected action ran against ("linear"), so the row can carry its brand mark.
  actionSource: string | null;
};

type AssistantRenderOptions = {
  stopped?: boolean;
  includeMetadataTaskCard?: boolean;
};

export function getOrderedAssistantItems(
  message: ChatUiMessage,
  taskLookup: ChatTaskLookup,
  options: AssistantRenderOptions = {},
) {
  const stopped = options.stopped ?? false;
  const items = collectRenderItems(
    message.parts as readonly RenderablePart[],
    taskLookup,
    stopped,
    "",
  );

  const metadataTask = metadataTaskCard(message.metadata);
  if (
    options.includeMetadataTaskCard !== false &&
    !items.some((item) => item.type === "task") &&
    metadataTask
  ) {
    items.push({
      type: "task",
      key: "task-metadata",
      task: resolveChatTaskCard(metadataTask, taskLookup),
    });
  }

  return items;
}

export function firstVisibleAssistantOutputKind(
  message: ChatUiMessage,
  taskLookup: ChatTaskLookup,
  options: AssistantRenderOptions = {},
): AssistantVisibleOutputKind | null {
  const firstItem = getOrderedAssistantItems(message, taskLookup, options).find(
    (item) => item.type !== "steering",
  );
  if (firstItem) return firstItem.type as AssistantVisibleOutputKind;
  return message.metadata?.error ? "error" : null;
}

// Shared by the top-level turn and each subagent's nested trace: folds a parts array into ordered
// render items. keyPrefix keeps React keys unique across nesting levels.
function collectRenderItems(
  parts: readonly RenderablePart[],
  taskLookup: ChatTaskLookup,
  stopped: boolean,
  keyPrefix: string,
): AssistantRenderItem[] {
  const items: AssistantRenderItem[] = [];
  let textBuffer = "";
  let textBufferItemId: string | null = null;

  const flushText = (key: string) => {
    const text = textBuffer.trim();
    textBuffer = "";
    textBufferItemId = null;
    if (!text) return;
    items.push({ type: "text", key, text });
  };

  for (const [index, part] of parts.entries()) {
    if (part.type === "text") {
      const itemId = typeof part.itemId === "string" && part.itemId ? part.itemId : null;
      // Durable coding-engine text is already assembled by semantic item id. Keep adjacent items
      // distinct so progress updates remain separate messages; an id-less suffix can still be the
      // transient continuation of the current durable item while Electric catches up.
      if (textBuffer && itemId && itemId !== textBufferItemId) {
        flushText(`${keyPrefix}text-${index}`);
      }
      if (!textBuffer) textBufferItemId = itemId;
      textBuffer += typeof part.text === "string" ? part.text : "";
      continue;
    }
    if (part.type === "reasoning") {
      const text = typeof part.text === "string" ? part.text : "";
      if (!text.trim()) continue;
      flushText(`${keyPrefix}text-${index}`);
      items.push({ type: "reasoning", key: `${keyPrefix}reasoning-${index}`, text });
      continue;
    }
    if (part.type === CHAT_STEERING_DATA_PART_TYPE) {
      const data = part.data as { text?: unknown } | undefined;
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text.trim()) continue;
      flushText(`${keyPrefix}text-${index}`);
      items.push({ type: "steering", key: `${keyPrefix}steering-${index}`, text });
      continue;
    }
    if (part.type === CHAT_ARTIFACT_DATA_PART_TYPE) {
      const artifact = parsePublishedChatArtifact({ ok: true, artifact: part.data });
      if (!artifact) continue;
      flushText(`${keyPrefix}text-${index}`);
      items.push({ type: "artifact", key: `${keyPrefix}artifact-${index}`, artifact });
      continue;
    }
    if (!isToolPartRecord(part)) continue;
    const tool = toolCallViewFromPart(part, stopped);
    if (!tool) continue;
    flushText(`${keyPrefix}text-${index}`);
    if (tool.name === CODEX_SUBAGENT_TOOL_NAME || tool.name === SUBAGENT_TOOL_NAME) {
      const childParts = Array.isArray(part.children) ? (part.children as RenderablePart[]) : [];
      items.push({
        type: "subagent",
        key: `${keyPrefix}subagent-${index}`,
        subagent: {
          tool,
          children: collectRenderItems(childParts, taskLookup, stopped, `${keyPrefix}sa${index}-`),
        },
      });
      continue;
    }
    if (
      (part.type === START_TASK_TOOL_PART_TYPE ||
        part.type === START_WORKFLOW_TOOL_PART_TYPE ||
        part.type === "tool-workflows") &&
      part.state === "output-available" &&
      isStartTaskToolOutput(part.output)
    ) {
      items.push({
        type: "task",
        key: `${keyPrefix}task-${index}`,
        task: resolveChatTaskCard(taskFromOutput(part.output), taskLookup),
      });
      continue;
    }
    const workflowOutput = workflowCardOutputFromTool(tool);
    if (workflowOutput) {
      items.push({
        type: "workflow",
        key: `${keyPrefix}workflow-${index}`,
        output: workflowOutput,
      });
      continue;
    }
    items.push({
      type: "tool",
      key: `${keyPrefix}tool-${index}`,
      tool,
    });
  }

  flushText(`${keyPrefix}text-end`);

  return deduplicateTaskItems(items);
}

function deduplicateTaskItems(items: AssistantRenderItem[]) {
  const seenTaskIds = new Set<string>();
  return items.filter((item) => {
    if (item.type !== "task") return true;
    if (seenTaskIds.has(item.task.id)) return false;
    seenTaskIds.add(item.task.id);
    return true;
  });
}

export function metadataTaskCard(metadata: ChatUiMessage["metadata"]): TaskCardMetadata | null {
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
  const presentation = codingToolPresentation({
    name,
    input: part.input,
    output: part.output,
    metadata: part,
  });
  const presentationOwnsDetail =
    name === CODEX_COMMAND_TOOL_NAME ||
    name === CODEX_DYNAMIC_TOOL_NAME ||
    name === CODEX_FILE_CHANGE_TOOL_NAME ||
    name === CODEX_MCP_TOOL_NAME ||
    name === CODEX_WEB_SEARCH_TOOL_NAME;
  const state = typeof part.state === "string" ? part.state : "";
  const output = part.output;
  // use_action reports failures inside its structured output, not via the
  // part state: completed-with-ok=false renders as failed.
  const failedAction =
    name === USE_ACTION_TOOL_NAME && state === "output-available" && isUseActionToolOutput(output)
      ? output.ok === false && output.error.code !== "approval_required"
      : false;
  const failedSkill =
    name === USE_SKILL_TOOL_NAME && state === "output-available" && isUseSkillToolOutput(output)
      ? output.ok === false
      : false;
  const awaitingCapabilityApproval =
    name === USE_ACTION_TOOL_NAME &&
    state === "output-available" &&
    isUseActionToolOutput(output) &&
    output.ok === false &&
    output.error.code === "approval_required";
  const approvalDeclined =
    state === "approval-responded" && isRecord(part.approval) && part.approval.approved === false;
  const failedWorkflow =
    name === "workflows" && state === "output-available" && isRecord(output) && output.ok === false;
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
  const status = approvalDeclined
    ? "failed"
    : failedAction || failedWorkflow
      ? "failed"
      : failedSkill
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
    toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name,
    label:
      name === USE_ACTION_TOOL_NAME
        ? actionToolLabel(part.input)
        : (presentation?.label ?? toolLabel(name)),
    actionSource:
      name === USE_ACTION_TOOL_NAME
        ? actionToolSource(part.input)
        : (presentation?.actionSource ?? null),
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
            : approvalDeclined
              ? "Declined"
              : awaitingCapabilityApproval
                ? "Approval needed"
                : toolStatusText(status, state),
    detail: presentationOwnsDetail
      ? (presentation?.detail ?? null)
      : (presentation?.detail ?? toolDetail(name, part)),
    detailChips: presentation?.detailChips ?? [],
    input: part.input,
    output: part.output,
    errorText: approvalDeclined
      ? isRecord(part.approval) && typeof part.approval.reason === "string"
        ? part.approval.reason
        : "The action was declined."
      : typeof part.errorText === "string"
        ? part.errorText
        : null,
    state,
    approvalId:
      isRecord(part.approval) && typeof part.approval.id === "string" ? part.approval.id : null,
  };
}

function isCodexItemToolName(name: string) {
  return (
    name === CODEX_FILE_CHANGE_TOOL_NAME ||
    name === CODEX_MCP_TOOL_NAME ||
    name === CODEX_WEB_SEARCH_TOOL_NAME ||
    name === CODEX_SUBAGENT_TOOL_NAME
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
  if (name === CODEX_COMMAND_TOOL_NAME) return "Command";
  if (name === CODEX_PLAN_TOOL_NAME) return "Plan";
  if (name === CODEX_GOAL_TOOL_NAME) return "Goal";
  if (name === CODEX_QUESTION_TOOL_NAME) return "Question";
  if (name === CODEX_APPROVAL_TOOL_NAME) return "Approval";
  if (name === CODEX_FILE_CHANGE_TOOL_NAME) return "File change";
  if (name === CODEX_MCP_TOOL_NAME || name === CODEX_DYNAMIC_TOOL_NAME) return "Tool";
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) return "Web search";
  if (name === CODEX_SUBAGENT_TOOL_NAME || name === SUBAGENT_TOOL_NAME) return "Subagent";
  if (name === START_TASK_TOOL_NAME) return "Task";
  if (name === START_WORKFLOW_TOOL_NAME || name === "workflows") return "Workflow";
  if (name === RETIRED_SCHEDULE_TASK_TOOL_NAME) return "Recurring task";
  if (name === RETIRED_EDIT_TASK_SCHEDULE_TOOL_NAME) return "Edit routine";
  if (name === RETIRED_DELETE_TASK_SCHEDULE_TOOL_NAME) return "Delete routine";
  if (name === SLACK_BOT_TOOL_NAME || name === LEGACY_SLACK_BOT_TOOL_NAME) return "Slack bot";
  if (name === "read_workflow_memory") return "Workflow memory";
  if (name === "update_workflow_memory") return "Update workflow memory";
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

export function toolDetail(name: string, part: Record<string, unknown> & { type: string }) {
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

  if (name === "workflows") {
    const output = isRecord(part.output) ? part.output : null;
    const workflow = output && isRecord(output.workflow) ? output.workflow : null;
    if (workflow && typeof workflow.name === "string")
      return `${workflow.name} · ${output?.ok === false ? "Needs attention" : workflow.archived ? "Archived" : workflow.status === "active" ? "Active" : "Draft"}`;
    return isRecord(part.input) && typeof part.input.command === "string"
      ? part.input.command
      : null;
  }
  if (name === START_TASK_TOOL_NAME || name === START_WORKFLOW_TOOL_NAME) {
    return startTaskToolDetail(part);
  }

  if (name === RETIRED_SCHEDULE_TASK_TOOL_NAME) {
    return scheduleTaskToolDetail(part);
  }
  if (
    name === RETIRED_EDIT_TASK_SCHEDULE_TOOL_NAME ||
    name === RETIRED_DELETE_TASK_SCHEDULE_TOOL_NAME
  ) {
    return taskScheduleMutationToolDetail(part);
  }
  if (name === SLACK_BOT_TOOL_NAME || name === LEGACY_SLACK_BOT_TOOL_NAME) {
    // The destination is what a reader checks; the message body is already in the transcript.
    if (!isRecord(part.input)) return formatToolInput(part.input);
    const channel = readString(part.input.channel);
    // No channel means a reply, which lands in the thread of an earlier post or of the Slack
    // message that started this run. Naming the thread beats dumping the message body here.
    return channel ? truncateToolPreview(channel) : "Thread reply";
  }
  if (name === USE_ACTION_TOOL_NAME) {
    return actionToolDetail(part);
  }
  if (name === USE_SKILL_TOOL_NAME) {
    return skillToolDetail(part);
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

// The row label already names the service and the action, so the chip carries only what the
// label cannot: why a call failed, and what a metered lookup returned and cost.
function actionToolDetail(part: Record<string, unknown>) {
  if (part.state !== "output-available" || !isUseActionToolOutput(part.output)) return null;
  if (part.output.ok === false) return truncateToolPreview(part.output.error.message);
  if (!isRecord(part.output.result) || part.output.result.untrustedProviderData !== true) {
    return null;
  }
  const resultCount =
    typeof part.output.result.resultCount === "number"
      ? `${part.output.result.resultCount} result${part.output.result.resultCount === 1 ? "" : "s"}`
      : null;
  const cost = isRecord(part.output.result.cost)
    ? part.output.result.cost.state === "settling"
      ? "cost settling"
      : typeof part.output.result.cost.totalUsdMicros === "number"
        ? formatActionCost(part.output.result.cost.totalUsdMicros)
        : null
    : null;
  return truncateToolPreview([resultCount, cost].filter(Boolean).join(" · "));
}

function formatActionCost(usdMicros: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usdMicros < 100_000 ? 3 : 2,
    maximumFractionDigits: usdMicros < 100_000 ? 3 : 2,
  }).format(usdMicros / 1_000_000);
}

export function actionToolLabel(input: unknown) {
  const action = isRecord(input) ? readString(input.action) : null;
  return action ? actionRowLabel(action) : "Action";
}

/** The service slug behind a connected action call, for the row's brand mark. */
export function actionToolSource(input: unknown) {
  const action = isRecord(input) ? readString(input.action) : null;
  return action ? actionSource(action) : null;
}

export function isUseActionToolOutput(value: unknown): value is UseActionToolOutput {
  if (!isRecord(value)) return false;
  if (typeof value.ok !== "boolean" || typeof value.action !== "string") return false;
  return value.ok === true || isRecord(value.error);
}

function skillToolDetail(part: Record<string, unknown>) {
  const skill = isRecord(part.input) ? readString(part.input.skill) : null;
  if (part.state === "output-available" && isUseSkillToolOutput(part.output)) {
    return part.output.ok
      ? truncateToolPreview(part.output.skill.name)
      : truncateToolPreview([skill, part.output.error.message].filter(Boolean).join(" - "));
  }
  return truncateToolPreview(skill) ?? formatToolInput(part.input);
}

export function isUseSkillToolOutput(value: unknown): value is UseSkillToolOutput {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.skill === "undefined") {
    return false;
  }
  if (value.ok === true) {
    return (
      isRecord(value.skill) &&
      typeof value.skill.id === "string" &&
      typeof value.skill.name === "string" &&
      typeof value.skill.description === "string" &&
      typeof value.skill.instructions === "string"
    );
  }
  return (
    typeof value.skill === "string" &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function startTaskToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.input)) {
    const name = typeof part.input.name === "string" ? part.input.name : null;
    const workflowId = typeof part.input.workflowId === "string" ? part.input.workflowId : null;
    const prompt = typeof part.input.prompt === "string" ? part.input.prompt : null;
    return truncateToolPreview(name ?? workflowId ?? prompt);
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
    const target = [readString(input.server), readString(input.tool)].filter(Boolean).join(" · ");
    const error = readString(output.error);
    return truncateToolPreview([target, error].filter(Boolean).join(" - "));
  }
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) {
    return truncateToolPreview(readString(input.query) ?? "Web search");
  }
  if (name === CODEX_SUBAGENT_TOOL_NAME || name === SUBAGENT_TOOL_NAME) {
    const subagentType = readString(input.subagentType);
    const description = readString(input.description) ?? readString(input.prompt);
    return truncateToolPreview(
      [subagentType, description].filter(Boolean).join(" · ") || "Subagent",
    );
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
  if (typeof value.command === "string") return truncateToolPreview(value.command);
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

export function truncateToolPreview(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
}

export function buildChatTaskLookup(input: {
  messages: readonly ChatUiMessage[];
  tasks: readonly TaskView[];
  liveTasks: readonly TaskView[] | null;
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

function setChatTaskLookupValue(lookup: Map<string, ChatTaskCardView>, task: TaskCardMetadata) {
  const existing = lookup.get(task.id);
  lookup.set(task.id, {
    id: task.id,
    displayId: task.displayId ?? existing?.displayId ?? null,
    title: task.title ?? existing?.title ?? null,
    status: task.status ?? existing?.status ?? null,
  });
}

function taskCardFromTask(task: TaskView): ChatTaskCardView {
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.name,
    status: task.status,
  };
}

export function resolveChatTaskCard(
  fallback: TaskCardMetadata,
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

export function taskFromOutput(output: StartTaskToolOutput): TaskCardMetadata {
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

export function shouldShowThinkingBubble(messages: readonly ChatUiMessage[]) {
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
