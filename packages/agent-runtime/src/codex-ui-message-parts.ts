import {
  CHAT_ARTIFACT_DATA_PART_TYPE,
  PUBLISH_ARTIFACT_TOOL_NAME,
  type PublishedChatArtifact,
  parsePublishedChatArtifact,
} from "./chat-artifacts";
import type { CodexAppServerNormalizedEvent } from "./codex-app-server-events";

// Shared projection of normalized Codex app-server events into AI SDK UIMessage parts.
// The cloud Codex chat runner folds events through this reducer so every coding
// engine persists the same normalized assistant-turn shape (reasoning parts,
// codex_command tool parts, text parts) in chat_messages.debug_trace.uiMessageParts.

export const CODEX_COMMAND_TOOL_NAME = "codex_command";
export const CODEX_COMMAND_TOOL_PART_TYPE = `tool-${CODEX_COMMAND_TOOL_NAME}` as const;
export const CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT = 4_000;
export const CODEX_PLAN_TOOL_NAME = "codex_plan";
export const CODEX_GOAL_TOOL_NAME = "codex_goal";
export const CODEX_QUESTION_TOOL_NAME = "codex_question";
export const CODEX_APPROVAL_TOOL_NAME = "codex_approval";
export const CODEX_FILE_CHANGE_TOOL_NAME = "codex_file_change";
export const CODEX_MCP_TOOL_NAME = "codex_mcp_tool";
export const CODEX_DYNAMIC_TOOL_NAME = "codex_dynamic_tool";
export const CODEX_WEB_SEARCH_TOOL_NAME = "codex_web_search";
export const CODEX_SUBAGENT_TOOL_NAME = "codex_subagent";
export const CODEX_SUBAGENT_TOOL_PART_TYPE = `tool-${CODEX_SUBAGENT_TOOL_NAME}` as const;

export type CodexCommandToolInput = { command: string };
export type CodexCommandToolOutput = {
  status: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  outputPreview?: string;
};

export type CodexUiTextPart = { type: "text"; text: string; itemId?: string };
export type CodexUiReasoningPart = { type: "reasoning"; text: string; state: "done" };
export type CodexUiArtifactPart = {
  type: typeof CHAT_ARTIFACT_DATA_PART_TYPE;
  data: PublishedChatArtifact;
};
export type CodexUiCommandPart = {
  type: typeof CODEX_COMMAND_TOOL_PART_TYPE;
  toolCallId: string;
  input: CodexCommandToolInput;
} & (
  | { state: "input-available" }
  | { state: "output-available"; output: CodexCommandToolOutput }
  | { state: "output-error"; errorText: string }
);
export type CodexUiStatusPart = {
  type: "dynamic-tool";
  toolName:
    | typeof CODEX_PLAN_TOOL_NAME
    | typeof CODEX_GOAL_TOOL_NAME
    | typeof CODEX_QUESTION_TOOL_NAME
    | typeof CODEX_APPROVAL_TOOL_NAME
    | typeof CODEX_FILE_CHANGE_TOOL_NAME
    | typeof CODEX_MCP_TOOL_NAME
    | typeof CODEX_DYNAMIC_TOOL_NAME
    | typeof CODEX_WEB_SEARCH_TOOL_NAME;
  toolCallId: string;
  input: Record<string, unknown>;
} & (
  | { state: "input-available" }
  | { state: "approval-requested"; approval?: { id: string } }
  | { state: "output-available"; output: Record<string, unknown> }
);
type CodexUiStatusPartPayload =
  | { state: "input-available"; input: Record<string, unknown> }
  | {
      state: "approval-requested";
      input: Record<string, unknown>;
      approval?: { id: string };
    }
  | {
      state: "output-available";
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
// A Claude Code Task (subagent) call. Unlike other tool parts it carries a nested `children`
// array holding the subagent's own reasoning / commands / tool calls, projected through the
// same reducer so the UI can expand a subagent and show its full trace.
export type CodexUiSubagentPart = {
  type: typeof CODEX_SUBAGENT_TOOL_PART_TYPE;
  toolCallId: string;
  input: {
    label: string;
    description?: string;
    subagentType?: string;
    prompt?: string;
  };
  children: CodexUiMessagePart[];
} & (
  | { state: "input-available" }
  | { state: "output-available"; output: { status: string; error?: string; result?: string } }
);
export type CodexUiMessagePart =
  | CodexUiTextPart
  | CodexUiReasoningPart
  | CodexUiArtifactPart
  | CodexUiCommandPart
  | CodexUiStatusPart
  | CodexUiSubagentPart;

export type CodexUiMessageProjection = {
  parts: CodexUiMessagePart[];
  content: string;
  error: string | null;
  changed: boolean;
};

type ApplyCodexEventOptions = {
  // Truncated tail of the command's aggregated output, folded into the tool part on
  // command.completed / command.failed. Callers that buffer command.output deltas
  // (see createCodexCommandOutputAccumulator) pass it here; omitting it is fine.
  commandOutputPreview?: string | null;
};

export function applyCodexEventToUiMessageParts(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
  options: ApplyCodexEventOptions = {},
): CodexUiMessageProjection {
  // A published file belongs to the main assistant response even when a Claude subagent made the
  // MCP call. Keep it out of the collapsible subagent trace so the user cannot miss the output.
  if (
    (event.type === "dynamic_tool.started" ||
      event.type === "dynamic_tool.completed" ||
      event.type === "mcp_tool.started" ||
      event.type === "mcp_tool.completed") &&
    readString(event.payload.tool) === PUBLISH_ARTIFACT_TOOL_NAME
  ) {
    return applyPublishedArtifactEvent(parts, event);
  }
  // Subagent steps carry the parent Agent tool call id; fold them into that part's children
  // rather than the top-level turn.
  const parentToolCallId = readString(event.payload.parentToolCallId);
  if (parentToolCallId) {
    return applyEventToSubagentChild(parts, parentToolCallId, event, options);
  }
  switch (event.type) {
    case "assistant.delta": {
      const delta =
        typeof event.payload.delta === "string" && event.payload.delta ? event.payload.delta : null;
      if (!delta) return unchanged(parts);
      const itemId = readString(event.payload.itemId) ?? `assistant-${parts.length}`;
      const index = parts.findIndex((part) => part.type === "text" && part.itemId === itemId);
      if (index < 0) return changed([...parts, { type: "text", text: delta, itemId }]);
      return changed(
        parts.map((part, currentIndex) =>
          currentIndex === index && part.type === "text"
            ? { ...part, text: `${part.text}${delta}` }
            : part,
        ),
      );
    }
    case "assistant.completed": {
      const text = readString(event.payload.content);
      if (!text) return unchanged(parts);
      const itemId = readString(event.payload.itemId);
      if (!itemId) return changed([...parts, { type: "text", text }]);
      const index = parts.findIndex((part) => part.type === "text" && part.itemId === itemId);
      if (index < 0) return changed([...parts, { type: "text", text }]);
      return changed(
        parts.map((part, currentIndex) =>
          currentIndex === index && part.type === "text" ? { type: "text", text } : part,
        ),
      );
    }
    case "reasoning.completed": {
      const text = readString(event.payload.text);
      if (!text?.trim()) return unchanged(parts);
      return changed([...parts, { type: "reasoning", text, state: "done" }]);
    }
    case "command.started": {
      const toolCallId = commandToolCallId(event, parts);
      if (parts.some((part) => isCommandPart(part) && part.toolCallId === toolCallId)) {
        return unchanged(parts);
      }
      return changed([
        ...parts,
        {
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId,
          state: "input-available",
          input: { command: commandFromPayload(event) },
        },
      ]);
    }
    case "command.completed": {
      const output: CodexCommandToolOutput = {
        status: commandOutputStatus(event),
        exitCode: commandExitCode(event),
        ...(options.commandOutputPreview
          ? { outputPreview: truncateOutputPreview(options.commandOutputPreview) }
          : {}),
      };
      return changed(
        replaceCommandPart(parts, event, (existing) => ({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: existing.toolCallId,
          state: "output-available",
          input: existing.input,
          output,
        })),
      );
    }
    case "command.failed": {
      const errorText = readString(event.payload.error) ?? "Codex command failed.";
      return changed(
        replaceCommandPart(parts, event, (existing) => ({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: existing.toolCallId,
          state: "output-error",
          input: existing.input,
          errorText,
        })),
      );
    }
    case "file_change.started":
    case "file_change.completed": {
      return changed(
        upsertStatusPart(parts, event, CODEX_FILE_CHANGE_TOOL_NAME, fileChangeStatusPart(event)),
      );
    }
    case "mcp_tool.started":
    case "mcp_tool.completed": {
      return changed(upsertStatusPart(parts, event, CODEX_MCP_TOOL_NAME, mcpToolStatusPart(event)));
    }
    case "subagent.started":
    case "subagent.completed": {
      return changed(upsertSubagentPart(parts, event));
    }
    case "dynamic_tool.started":
    case "dynamic_tool.completed": {
      return changed(
        upsertStatusPart(parts, event, CODEX_DYNAMIC_TOOL_NAME, dynamicToolStatusPart(event)),
      );
    }
    case "web_search.started":
    case "web_search.completed": {
      return changed(
        upsertStatusPart(parts, event, CODEX_WEB_SEARCH_TOOL_NAME, webSearchStatusPart(event)),
      );
    }
    case "plan.updated": {
      return changed(upsertStatusPart(parts, event, CODEX_PLAN_TOOL_NAME, planStatusPart(event)));
    }
    case "goal.updated": {
      return changed(upsertStatusPart(parts, event, CODEX_GOAL_TOOL_NAME, goalStatusPart(event)));
    }
    case "question.requested": {
      return changed(
        upsertStatusPart(parts, event, CODEX_QUESTION_TOOL_NAME, questionStatusPart(event)),
      );
    }
    case "approval.requested": {
      return changed(
        upsertStatusPart(parts, event, CODEX_APPROVAL_TOOL_NAME, approvalStatusPart(event)),
      );
    }
    case "error": {
      const message = readString(event.payload.message) ?? "Codex app-server error.";
      return { ...unchanged(parts), error: message, changed: true };
    }
    default:
      return unchanged(parts);
  }
}

export function resolveCodexUiInteraction(
  parts: readonly CodexUiMessagePart[],
  input: {
    interactionId: string;
    status: "answered" | "auto-resolved" | "canceled";
  },
): CodexUiMessageProjection {
  let didChange = false;
  const next = parts.map((part): CodexUiMessagePart => {
    if (
      part.type !== "dynamic-tool" ||
      part.toolName !== CODEX_QUESTION_TOOL_NAME ||
      part.state !== "approval-requested" ||
      readString(part.input.interactionId) !== input.interactionId
    ) {
      return part;
    }
    didChange = true;
    return {
      type: "dynamic-tool",
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      state: "output-available",
      input: part.input,
      output: { status: input.status },
    };
  });
  return didChange ? changed(next) : unchanged(parts);
}

export function resolveCodexUiApproval(
  parts: readonly CodexUiMessagePart[],
  input: {
    approvalId: string;
    status: "approved" | "denied" | "canceled";
  },
): CodexUiMessageProjection {
  let didChange = false;
  const next = parts.map((part): CodexUiMessagePart => {
    if (
      part.type !== "dynamic-tool" ||
      part.toolName !== CODEX_APPROVAL_TOOL_NAME ||
      part.state !== "approval-requested" ||
      part.approval?.id !== input.approvalId
    ) {
      return part;
    }
    didChange = true;
    return {
      type: "dynamic-tool",
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      state: "output-available",
      input: part.input,
      output: { status: input.status },
    };
  });
  return didChange ? changed(next) : unchanged(parts);
}

// The Codex TUI offers implementation only after a successful Plan-mode turn, not as soon as
// the proposed-plan item arrives. Keeping this as an explicit terminal transition prevents an
// actionable card from appearing while the runner is still streaming the turn.
export function offerCodexPlanImplementation(
  parts: readonly CodexUiMessagePart[],
): CodexUiMessageProjection {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (
      !part ||
      part.type !== "dynamic-tool" ||
      part.toolName !== CODEX_PLAN_TOOL_NAME ||
      part.state !== "output-available" ||
      !isRecord(part.output) ||
      readString(part.output.status) !== "completed" ||
      readString(part.output.source) === "turn_plan" ||
      !readString(part.output.text)?.trim()
    ) {
      continue;
    }
    if (part.output.implementationAvailable === true) return unchanged(parts);
    const next = [...parts];
    next[index] = {
      ...part,
      output: { ...part.output, implementationAvailable: true },
    };
    return changed(next);
  }
  return unchanged(parts);
}

// Settles non-terminal parts when a turn ends, so a reloaded chat never shows an eternal
// spinner (dangling commands) or an eternal "Waiting" (questions/approvals nobody can answer)
// for a turn that is over. Commands are only touched on abnormal outcomes; status parts are
// settled on every outcome.
export function finalizeCodexUiMessageParts(
  parts: readonly CodexUiMessagePart[],
  outcome: "completed" | "interrupted" | "failed",
  error?: string | null,
): CodexUiMessageProjection {
  let didChange = false;
  const next = parts.map((part): CodexUiMessagePart => {
    if (isCommandPart(part) && part.state === "input-available" && outcome !== "completed") {
      didChange = true;
      if (outcome === "interrupted") {
        return {
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "output-available",
          input: part.input,
          output: { status: "interrupted", exitCode: null },
        };
      }
      return {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: part.toolCallId,
        state: "output-error",
        input: part.input,
        errorText: error?.trim() || "Codex turn failed.",
      };
    }
    if (part.type === "dynamic-tool" && part.state !== "output-available") {
      didChange = true;
      // Questions/approvals have no response channel in this chat, so they end unanswered
      // whatever the turn outcome; other in-flight status parts inherit the turn outcome.
      const status = part.state === "approval-requested" ? "unanswered" : outcome;
      return {
        type: "dynamic-tool",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        state: "output-available",
        input: part.input,
        output: { ...part.input, status },
      };
    }
    if (isSubagentPart(part)) {
      // Settle the subagent's own in-flight children (dangling commands/statuses), then close
      // the subagent itself if its Task tool_result never arrived.
      const childProjection = finalizeCodexUiMessageParts(part.children, outcome, error);
      const children = childProjection.changed ? childProjection.parts : part.children;
      if (part.state === "output-available") {
        if (!childProjection.changed) return part;
        didChange = true;
        return { ...part, children };
      }
      didChange = true;
      return {
        type: CODEX_SUBAGENT_TOOL_PART_TYPE,
        toolCallId: part.toolCallId,
        input: part.input,
        children,
        state: "output-available",
        output: { status: outcome, ...(error ? { error } : {}) },
      };
    }
    return part;
  });
  return didChange ? changed(next) : unchanged(parts);
}

export function codexUiMessagePartsContent(parts: readonly CodexUiMessagePart[]): string {
  return parts
    .filter((part): part is CodexUiTextPart => part.type === "text")
    .map((part) => part.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

export function parseCodexUiMessageParts(value: unknown): CodexUiMessagePart[] {
  if (!Array.isArray(value)) return [];
  const parts: CodexUiMessagePart[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({
        type: "text",
        text: part.text,
        ...(typeof part.itemId === "string" ? { itemId: part.itemId } : {}),
      });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      parts.push({ type: "reasoning", text: part.text, state: "done" });
      continue;
    }
    if (part.type === CHAT_ARTIFACT_DATA_PART_TYPE) {
      const artifact = parsePublishedChatArtifact({ ok: true, artifact: part.data });
      if (artifact) parts.push({ type: CHAT_ARTIFACT_DATA_PART_TYPE, data: artifact });
      continue;
    }
    if (part.type === CODEX_COMMAND_TOOL_PART_TYPE && typeof part.toolCallId === "string") {
      const command = readString((part.input as Record<string, unknown> | undefined)?.command);
      const input: CodexCommandToolInput = { command: command ?? "command" };
      if (part.state === "input-available") {
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "input-available",
          input,
        });
      } else if (part.state === "output-available") {
        const output = parseCommandOutput(part.output);
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "output-available",
          input,
          output,
        });
      } else if (part.state === "output-error") {
        const errorText = readString(part.errorText) ?? "Codex command failed.";
        parts.push({
          type: CODEX_COMMAND_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          state: "output-error",
          input,
          errorText,
        });
      }
      continue;
    }
    if (part.type === CODEX_SUBAGENT_TOOL_PART_TYPE && typeof part.toolCallId === "string") {
      const rawInput = isRecord(part.input) ? part.input : {};
      const input: CodexUiSubagentPart["input"] = {
        label: readString(rawInput.label) ?? "Subagent",
        ...(readString(rawInput.description)
          ? { description: readString(rawInput.description) as string }
          : {}),
        ...(readString(rawInput.subagentType)
          ? { subagentType: readString(rawInput.subagentType) as string }
          : {}),
        ...(readString(rawInput.prompt) ? { prompt: readString(rawInput.prompt) as string } : {}),
      };
      const children = parseCodexUiMessageParts(part.children);
      if (part.state === "output-available") {
        const output = isRecord(part.output) ? part.output : {};
        const error = readString(output.error);
        const result = readString(output.result);
        parts.push({
          type: CODEX_SUBAGENT_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          input,
          children,
          state: "output-available",
          output: {
            status: readString(output.status) ?? "completed",
            ...(error ? { error } : {}),
            ...(result ? { result } : {}),
          },
        });
      } else {
        parts.push({
          type: CODEX_SUBAGENT_TOOL_PART_TYPE,
          toolCallId: part.toolCallId,
          input,
          children,
          state: "input-available",
        });
      }
      continue;
    }
    if (
      part.type === "dynamic-tool" &&
      typeof part.toolName === "string" &&
      isCodexStatusToolName(part.toolName) &&
      typeof part.toolCallId === "string"
    ) {
      const input = isRecord(part.input) ? part.input : {};
      if (part.state === "input-available") {
        parts.push({
          type: "dynamic-tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: "input-available",
          input,
        });
      } else if (part.state === "approval-requested") {
        parts.push({
          type: "dynamic-tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: "approval-requested",
          input,
          ...(isRecord(part.approval) && typeof part.approval.id === "string"
            ? { approval: { id: part.approval.id } }
            : {}),
        });
      } else if (
        part.state === "approval-responded" &&
        part.toolName === CODEX_APPROVAL_TOOL_NAME
      ) {
        const approval = isRecord(part.approval) ? part.approval : null;
        parts.push({
          type: "dynamic-tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: "output-available",
          input,
          output: { status: approval?.approved === true ? "approved" : "denied" },
        });
      } else if (part.state === "output-available") {
        parts.push({
          type: "dynamic-tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: "output-available",
          input,
          output: isRecord(part.output) ? part.output : {},
        });
      }
    }
  }
  return parts;
}

function applyPublishedArtifactEvent(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
): CodexUiMessageProjection {
  if (event.type !== "dynamic_tool.completed" && event.type !== "mcp_tool.completed") {
    return unchanged(parts);
  }
  const artifact = parsePublishedChatArtifact({ ok: true, artifact: event.payload.artifact });
  if (!artifact) {
    const toolName =
      event.type === "dynamic_tool.completed" ? CODEX_DYNAMIC_TOOL_NAME : CODEX_MCP_TOOL_NAME;
    const payload =
      event.type === "dynamic_tool.completed"
        ? dynamicToolStatusPart(event)
        : mcpToolStatusPart(event);
    return changed(upsertStatusPart(parts, event, toolName, payload));
  }
  if (
    parts.some(
      (part) =>
        part.type === CHAT_ARTIFACT_DATA_PART_TYPE &&
        part.data.artifactVersionId === artifact.artifactVersionId,
    )
  ) {
    return unchanged(parts);
  }
  return changed([...parts, { type: CHAT_ARTIFACT_DATA_PART_TYPE, data: artifact }]);
}

// Buffers command.output deltas per command item so a truncated tail can be attached
// to the completed tool part. Keeps only the newest bytes per item.
export function createCodexCommandOutputAccumulator(
  limit: number = CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT,
) {
  const buffers = new Map<string, string>();
  return {
    push(event: CodexAppServerNormalizedEvent) {
      if (event.type !== "command.output") return;
      const itemId = readString(event.payload.itemId);
      const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
      if (!itemId || !delta) return;
      const next = (buffers.get(itemId) ?? "") + delta;
      buffers.set(itemId, next.length > limit ? next.slice(next.length - limit) : next);
    },
    take(itemId: string | null | undefined): string | null {
      if (!itemId) return null;
      const buffered = buffers.get(itemId);
      buffers.delete(itemId);
      return buffered?.trim() ? buffered : null;
    },
  };
}

function replaceCommandPart(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
  replace: (
    existing: Extract<CodexUiCommandPart, { state: "input-available" }>,
  ) => CodexUiCommandPart,
): CodexUiMessagePart[] {
  const itemId = readString(event.payload.itemId);
  let index = -1;
  if (itemId) {
    index = parts.findIndex((part) => isCommandPart(part) && part.toolCallId === itemId);
  }
  if (index < 0) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part && isCommandPart(part) && part.state === "input-available") {
        index = i;
        break;
      }
    }
  }
  if (index < 0) {
    // No started part to finalize (started event lost); synthesize the terminal part.
    const synthesized = replace({
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      toolCallId: itemId ?? `codex-cmd-${parts.length}`,
      state: "input-available",
      input: { command: commandFromPayload(event) },
    });
    return [...parts, synthesized];
  }
  const existing = parts[index] as CodexUiCommandPart;
  const next = [...parts];
  next[index] = replace({
    type: CODEX_COMMAND_TOOL_PART_TYPE,
    toolCallId: existing.toolCallId,
    state: "input-available",
    input: existing.input,
  });
  return next;
}

function upsertStatusPart(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
  toolName: CodexUiStatusPart["toolName"],
  nextPart: CodexUiStatusPartPayload,
): CodexUiMessagePart[] {
  const toolCallId = statusToolCallId(event, toolName, parts);
  const index = parts.findIndex(
    (part) =>
      part.type === "dynamic-tool" && part.toolName === toolName && part.toolCallId === toolCallId,
  );
  const existing = index >= 0 ? (parts[index] ?? null) : null;
  const resolvedPart =
    toolName === CODEX_PLAN_TOOL_NAME && nextPart.state === "input-available"
      ? appendPlanDelta(existing, nextPart)
      : nextPart;
  const part = createStatusPart(toolName, toolCallId, resolvedPart);
  if (index < 0) return [...parts, part];
  return parts.map((current, currentIndex) => (currentIndex === index ? part : current));
}

function createStatusPart(
  toolName: CodexUiStatusPart["toolName"],
  toolCallId: string,
  payload: CodexUiStatusPartPayload,
): CodexUiStatusPart {
  if (payload.state === "output-available") {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId,
      state: "output-available",
      input: payload.input,
      output: payload.output,
    };
  }
  if (payload.state === "approval-requested") {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId,
      state: "approval-requested",
      input: payload.input,
      ...(payload.approval ? { approval: payload.approval } : {}),
    };
  }
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state: payload.state,
    input: payload.input,
  };
}

function appendPlanDelta(
  existing: CodexUiMessagePart | null,
  nextPart: Extract<CodexUiStatusPartPayload, { state: "input-available" }>,
): Extract<CodexUiStatusPartPayload, { state: "input-available" }> {
  if (!existing || existing.type !== "dynamic-tool" || existing.toolName !== CODEX_PLAN_TOOL_NAME) {
    return nextPart;
  }
  const previousText =
    readString(existing.input.text) ??
    (existing.state === "output-available" ? readString(existing.output.text) : null) ??
    "";
  const delta = readString(nextPart.input.text) ?? "";
  return {
    ...nextPart,
    input: {
      ...nextPart.input,
      text: `${previousText}${delta}`,
    },
  };
}

function fileChangeStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const changes = Array.isArray(event.payload.changes) ? event.payload.changes : [];
  const input = { label: "File change", changes };
  if (event.type === "file_change.started") return { state: "input-available", input };
  return {
    state: "output-available",
    input,
    output: { status: readString(event.payload.status) ?? "completed", changes },
  };
}

function mcpToolStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  // ACP (Claude Code) carries the call arguments as `rawInput`; the Codex app-server carries them
  // as `arguments`. Surface whichever is present so the expanded row shows the real input.
  const args = isRecord(event.payload.rawInput)
    ? event.payload.rawInput
    : isRecord(event.payload.arguments)
      ? event.payload.arguments
      : null;
  const input = {
    label: "MCP tool",
    ...(readString(event.payload.server) ? { server: event.payload.server } : {}),
    ...(readString(event.payload.tool) ? { tool: event.payload.tool } : {}),
    ...(args ? { arguments: args } : {}),
  };
  if (event.type === "mcp_tool.started") return { state: "input-available", input };
  const error = readString(event.payload.error);
  const result = readString(event.payload.result);
  return {
    state: "output-available",
    input,
    output: {
      status: readString(event.payload.status) ?? "completed",
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    },
  };
}

// Routes a parent-stamped subagent event into the matching Task part's children, reusing the
// reducer recursively. Claude Code does not nest Task within Task, so a single top-level lookup
// covers every real case; an event whose parent part has not arrived yet is dropped.
function applyEventToSubagentChild(
  parts: readonly CodexUiMessagePart[],
  parentToolCallId: string,
  event: CodexAppServerNormalizedEvent,
  options: ApplyCodexEventOptions,
): CodexUiMessageProjection {
  const index = parts.findIndex(
    (part) => isSubagentPart(part) && part.toolCallId === parentToolCallId,
  );
  if (index < 0) return unchanged(parts);
  const parent = parts[index] as CodexUiSubagentPart;
  const { parentToolCallId: _ignored, ...childPayload } = event.payload;
  const childEvent: CodexAppServerNormalizedEvent = { ...event, payload: childPayload };
  const projection = applyCodexEventToUiMessageParts(parent.children, childEvent, options);
  if (!projection.changed) return unchanged(parts);
  const next = [...parts];
  next[index] = { ...parent, children: projection.parts };
  return changed(next);
}

function upsertSubagentPart(
  parts: readonly CodexUiMessagePart[],
  event: CodexAppServerNormalizedEvent,
): CodexUiMessagePart[] {
  const toolCallId =
    readString(event.payload.itemId) ?? `${CODEX_SUBAGENT_TOOL_NAME}_${parts.length + 1}`;
  const index = parts.findIndex((part) => isSubagentPart(part) && part.toolCallId === toolCallId);
  const existing = index >= 0 ? (parts[index] as CodexUiSubagentPart) : null;
  const input = existing?.input ?? subagentInput(event);
  const children = existing?.children ?? [];
  const part: CodexUiSubagentPart =
    event.type === "subagent.completed"
      ? {
          type: CODEX_SUBAGENT_TOOL_PART_TYPE,
          toolCallId,
          input,
          children,
          state: "output-available",
          output: subagentOutput(event),
        }
      : {
          type: CODEX_SUBAGENT_TOOL_PART_TYPE,
          toolCallId,
          input,
          children,
          state: "input-available",
        };
  if (index < 0) return [...parts, part];
  return parts.map((current, currentIndex) => (currentIndex === index ? part : current));
}

function subagentInput(event: CodexAppServerNormalizedEvent): CodexUiSubagentPart["input"] {
  return {
    label: "Subagent",
    ...(readString(event.payload.subagentType)
      ? { subagentType: readString(event.payload.subagentType) as string }
      : {}),
    ...(readString(event.payload.description)
      ? { description: readString(event.payload.description) as string }
      : {}),
    ...(readString(event.payload.prompt)
      ? { prompt: readString(event.payload.prompt) as string }
      : {}),
  };
}

function subagentOutput(
  event: CodexAppServerNormalizedEvent,
): Extract<CodexUiSubagentPart, { state: "output-available" }>["output"] {
  const error = readString(event.payload.error);
  const result = readString(event.payload.result);
  return {
    status: readString(event.payload.status) ?? "completed",
    ...(error ? { error } : {}),
    ...(result ? { result } : {}),
  };
}

function isSubagentPart(part: CodexUiMessagePart): part is CodexUiSubagentPart {
  return part.type === CODEX_SUBAGENT_TOOL_PART_TYPE;
}

function dynamicToolStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const tool = readString(event.payload.tool);
  const namespace = readString(event.payload.namespace);
  const label =
    tool === "goat_brain"
      ? "Brain"
      : tool === "save_to_brain"
        ? "Save to Brain"
        : "opencompany tool";
  const input = {
    label,
    ...(namespace ? { namespace } : {}),
    ...(tool ? { tool } : {}),
    ...(isRecord(event.payload.arguments) ? { arguments: event.payload.arguments } : {}),
  };
  if (event.type === "dynamic_tool.started") return { state: "input-available", input };
  const error = readString(event.payload.error);
  return {
    state: "output-available",
    input,
    output: {
      status: readString(event.payload.status) ?? "completed",
      ...(typeof event.payload.success === "boolean" ? { success: event.payload.success } : {}),
      ...(error ? { error } : {}),
    },
  };
}

function webSearchStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const input = {
    label: "Web search",
    ...(readString(event.payload.query) ? { query: event.payload.query } : {}),
  };
  if (event.type === "web_search.started") return { state: "input-available", input };
  return {
    state: "output-available",
    input,
    output: { status: readString(event.payload.status) ?? "completed" },
  };
}

function planStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const text = readString(event.payload.text) ?? "";
  const completed = readString(event.payload.status) === "completed";
  const source = readString(event.payload.source);
  const plan = Array.isArray(event.payload.plan) ? event.payload.plan : null;
  const sourcePayload = source ? { source } : {};
  const planPayload = plan ? { plan } : {};
  return completed
    ? {
        state: "output-available",
        input: { label: "Plan", ...sourcePayload, ...planPayload },
        output: { status: "completed", text, ...sourcePayload, ...planPayload },
      }
    : {
        state: "input-available",
        input: { label: "Plan", text, ...sourcePayload, ...planPayload },
      };
}

function goalStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const output = Object.fromEntries(
    Object.entries({
      objective: readString(event.payload.objective),
      status: readString(event.payload.status),
      tokenBudget: typeof event.payload.tokenBudget === "number" ? event.payload.tokenBudget : null,
      tokensUsed: typeof event.payload.tokensUsed === "number" ? event.payload.tokensUsed : null,
      timeUsedSeconds:
        typeof event.payload.timeUsedSeconds === "number" ? event.payload.timeUsedSeconds : null,
    }).filter(([, value]) => value !== null),
  );
  return {
    state: "output-available",
    input: { label: "Goal" },
    output,
  };
}

function questionStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const interactionId = readString(event.payload.interactionId);
  const questions = Array.isArray(event.payload.questions) ? event.payload.questions : null;
  const autoResolutionMs =
    typeof event.payload.autoResolutionMs === "number" ? event.payload.autoResolutionMs : null;
  return {
    state: "approval-requested",
    input: {
      label: "Question",
      question: readString(event.payload.question),
      ...(interactionId ? { interactionId } : {}),
      ...(questions ? { questions } : {}),
      ...(autoResolutionMs !== null ? { autoResolutionMs } : {}),
    },
  };
}

function approvalStatusPart(event: CodexAppServerNormalizedEvent): CodexUiStatusPartPayload {
  const approvalId = readString(event.payload.interactionId);
  const options = Array.isArray(event.payload.options) ? event.payload.options : null;
  const rawInput = isRecord(event.payload.rawInput) ? event.payload.rawInput : null;
  return {
    state: "approval-requested",
    input: {
      label: "Approval",
      title: readString(event.payload.title),
      action: readString(event.payload.action),
      ...(options ? { options } : {}),
      ...(rawInput ? { rawInput } : {}),
    },
    ...(approvalId ? { approval: { id: approvalId } } : {}),
  };
}

function statusToolCallId(
  event: CodexAppServerNormalizedEvent,
  toolName: CodexUiStatusPart["toolName"],
  parts: readonly CodexUiMessagePart[],
) {
  const itemId = readString(event.payload.itemId);
  if (itemId) return itemId;
  const existing = parts.find((part) => part.type === "dynamic-tool" && part.toolName === toolName);
  if (existing?.type === "dynamic-tool") return existing.toolCallId;
  return `${toolName}_${parts.length + 1}`;
}

function isCodexStatusToolName(value: string): value is CodexUiStatusPart["toolName"] {
  return (
    value === CODEX_PLAN_TOOL_NAME ||
    value === CODEX_GOAL_TOOL_NAME ||
    value === CODEX_QUESTION_TOOL_NAME ||
    value === CODEX_APPROVAL_TOOL_NAME ||
    value === CODEX_FILE_CHANGE_TOOL_NAME ||
    value === CODEX_MCP_TOOL_NAME ||
    value === CODEX_DYNAMIC_TOOL_NAME ||
    value === CODEX_WEB_SEARCH_TOOL_NAME
  );
}

function commandToolCallId(
  event: CodexAppServerNormalizedEvent,
  parts: readonly CodexUiMessagePart[],
) {
  return readString(event.payload.itemId) ?? `codex-cmd-${parts.length}`;
}

function commandFromPayload(event: CodexAppServerNormalizedEvent) {
  return readString(event.payload.command) ?? "command";
}

function commandOutputStatus(
  event: CodexAppServerNormalizedEvent,
): CodexCommandToolOutput["status"] {
  const output = event.payload.output;
  const status =
    output && typeof output === "object" && !Array.isArray(output)
      ? readString((output as Record<string, unknown>).status)
      : null;
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function commandExitCode(event: CodexAppServerNormalizedEvent): number | null {
  const output = event.payload.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const exitCode = (output as Record<string, unknown>).exitCode;
  return typeof exitCode === "number" ? exitCode : null;
}

function parseCommandOutput(value: unknown): CodexCommandToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "completed", exitCode: null };
  }
  const record = value as Record<string, unknown>;
  const status = readString(record.status);
  return {
    status: status === "failed" || status === "interrupted" ? status : "completed",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    ...(typeof record.outputPreview === "string" && record.outputPreview
      ? { outputPreview: record.outputPreview }
      : {}),
  };
}

function truncateOutputPreview(preview: string) {
  return preview.length > CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT
    ? preview.slice(preview.length - CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT)
    : preview;
}

function isCommandPart(part: CodexUiMessagePart): part is CodexUiCommandPart {
  return part.type === CODEX_COMMAND_TOOL_PART_TYPE;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unchanged(parts: readonly CodexUiMessagePart[]): CodexUiMessageProjection {
  return {
    parts: [...parts],
    content: codexUiMessagePartsContent(parts),
    error: null,
    changed: false,
  };
}

function changed(parts: CodexUiMessagePart[]): CodexUiMessageProjection {
  return { parts, content: codexUiMessagePartsContent(parts), error: null, changed: true };
}
