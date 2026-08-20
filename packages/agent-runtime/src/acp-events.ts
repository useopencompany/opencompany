import { PUBLISH_ARTIFACT_TOOL_NAME, parsePublishedChatArtifact } from "./chat-artifacts";
import type { HarnessNormalizedEvent } from "./harness-events";

export type AcpTurnSummary = {
  status: "success" | "failure";
  result: string | null;
  error: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  sessionId: string | null;
  goal: AcpGoalSummary | null;
};

export type AcpGoalSummary = {
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
};

// Upper bound on the MCP tool result echoed into the assistant part. Matches the command output
// preview budget so a large tool result cannot bloat the persisted message row.
const MCP_TOOL_RESULT_LIMIT = 4_000;

type AcpToolKind = "command" | "file_change" | "web_search" | "subagent" | "tool";

type AcpToolCall = {
  kind: AcpToolKind;
  name: string;
  title: string;
  command?: string;
  query?: string;
  server?: string;
  tool?: string;
  changes?: Array<Record<string, unknown>>;
  rawInput?: Record<string, unknown>;
  parentToolCallId?: string;
  outputText: string;
};

export function createAcpEventNormalizer(input: { engineName?: string } = {}) {
  const toolCalls = new Map<string, AcpToolCall>();
  const messageText = new Map<string, string>();
  const messageOrder: string[] = [];
  let currentSessionId: string | null = null;
  let summary: AcpTurnSummary | null = null;
  let goal: AcpGoalSummary | null = null;
  let generatedMessageId = 0;

  const beginRun = (sessionId: string) => {
    currentSessionId = sessionId;
    summary = null;
    goal = null;
    toolCalls.clear();
    messageText.clear();
    messageOrder.length = 0;
    generatedMessageId = 0;
  };

  const normalize = (raw: Record<string, unknown>): HarnessNormalizedEvent[] => {
    const method = readString(raw.method);
    const params = readRecord(raw.params) ?? {};

    if (method === "session/started") {
      currentSessionId = readString(params.sessionId) ?? currentSessionId;
      return [
        normalized("turn.started", raw, {
          threadId: currentSessionId,
          turnId: currentSessionId,
          status: "running",
        }),
      ];
    }

    if (method === "session/request_permission") {
      const toolCall = readRecord(params.toolCall) ?? {};
      const toolCallId = readString(toolCall.toolCallId) ?? "acp-permission";
      return [
        normalized("approval.requested", raw, {
          itemId: `acp-approval-${toolCallId}`,
          requestId: jsonRpcRequestId(raw.id),
          interactionId: readString(raw.interactionId),
          title:
            readString(toolCall.title) ??
            `${input.engineName ?? "The coding engine"} needs permission`,
          action:
            readString(readRecord(toolCall.rawInput)?.command) ??
            readString(toolCall.name) ??
            readString(toolCall.title),
          options: Array.isArray(params.options) ? params.options : undefined,
          rawInput: readRecord(toolCall.rawInput) ?? undefined,
        }),
      ];
    }

    if (method === "session/prompt_result") {
      const stopReason = readString(params.stopReason) ?? "end_turn";
      const usage = readPromptUsage(params.usage);
      const success = stopReason === "end_turn";
      const result = messageOrder
        .map((id) => messageText.get(id) ?? "")
        .filter((text) => text.trim())
        .join("\n\n");
      const error = success ? null : promptFailureMessage(stopReason);
      summary = {
        status: success ? "success" : "failure",
        result: result || null,
        error,
        usage,
        sessionId: currentSessionId,
        goal,
      };
      return [
        normalized("turn.completed", raw, {
          turnId: currentSessionId,
          status: success ? "completed" : stopReason === "cancelled" ? "interrupted" : "failed",
          error: error ?? undefined,
        }),
        normalized("usage.updated", raw, {
          turnId: currentSessionId,
          tokenUsage: usage,
        }),
      ];
    }

    if (method !== "session/update") return [normalized("unknown", raw, { method })];
    currentSessionId = readString(params.sessionId) ?? currentSessionId;
    const update = readRecord(params.update);
    if (!update) return [normalized("unknown", raw, { method })];
    const updateType = readString(update.sessionUpdate);
    const parentToolCallId = providerParentToolCallId(update);

    if (updateType === "agent_message_chunk") {
      const content = readRecord(update.content);
      const text = content?.type === "text" ? readStringAllowEmpty(content.text) : null;
      if (text == null || !text) return [];
      const itemId =
        readString(update.messageId) ??
        (parentToolCallId ? `acp-message-${parentToolCallId}` : "acp-message-root");
      if (!parentToolCallId) {
        if (!messageText.has(itemId)) messageOrder.push(itemId);
        messageText.set(itemId, `${messageText.get(itemId) ?? ""}${text}`);
      }
      return [normalized("assistant.delta", raw, { itemId, delta: text, parentToolCallId })];
    }

    if (updateType === "agent_thought_chunk") {
      const content = readRecord(update.content);
      const text = content?.type === "text" ? readString(content.text) : null;
      return text
        ? [
            normalized("reasoning.completed", raw, {
              itemId: readString(update.messageId) ?? `acp-thought-${generatedMessageId++}`,
              text,
              parentToolCallId,
            }),
          ]
        : [];
    }

    if (updateType === "tool_call") {
      return normalizeToolCall(raw, update, toolCalls, parentToolCallId);
    }

    if (updateType === "tool_call_update") {
      return normalizeToolCallUpdate(raw, update, toolCalls, parentToolCallId);
    }

    if (updateType === "plan" || updateType === "plan_update") {
      const text = renderPlan(update);
      return text
        ? [
            normalized("plan.updated", raw, {
              itemId: readString(update.planId) ?? "acp-plan",
              text,
              status: updateType === "plan" ? "completed" : "running",
              parentToolCallId,
            }),
          ]
        : [];
    }

    if (updateType === "session_info_update") {
      const nextGoal = readGoal(readRecord(update._meta)?.goal);
      if (nextGoal !== undefined) {
        goal = nextGoal;
        return [
          normalized("goal.updated", raw, {
            itemId: "acp-goal",
            ...(goal ?? { status: "cleared" }),
          }),
        ];
      }
    }

    if (updateType === "usage_update") {
      return [
        normalized("usage.updated", raw, {
          turnId: currentSessionId,
          contextUsage: {
            used: readNumber(update.used) ?? 0,
            size: readNumber(update.size) ?? 0,
            cost: readRecord(update.cost) ?? undefined,
          },
        }),
      ];
    }

    return [normalized("unknown", raw, { method, updateType })];
  };

  return {
    beginRun,
    normalize,
    sessionId: () => currentSessionId,
    summary: () => summary,
  };
}

function normalizeToolCall(
  raw: Record<string, unknown>,
  update: Record<string, unknown>,
  toolCalls: Map<string, AcpToolCall>,
  parentToolCallId: string | null,
) {
  const itemId = readString(update.toolCallId);
  if (!itemId) return [normalized("unknown", raw, { updateType: "tool_call" })];
  const name = acpToolName(update);
  const title = readString(update.title) ?? name;
  const rawInput = readRecord(update.rawInput) ?? undefined;
  const kind = classifyTool(update, name);
  const command = commandFromTool(rawInput, title);
  const query = queryFromTool(rawInput, title);
  const changes = fileChangesFromTool(update, rawInput);
  const mcp = mcpToolInfo(name);
  const toolCall: AcpToolCall = {
    kind,
    name,
    title,
    ...(command ? { command } : {}),
    ...(query ? { query } : {}),
    ...(mcp.server ? { server: mcp.server } : {}),
    ...(mcp.tool ? { tool: mcp.tool } : {}),
    ...(changes.length ? { changes } : {}),
    ...(rawInput ? { rawInput } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    outputText: "",
  };
  toolCalls.set(itemId, toolCall);
  const events = [toolStartedEvent(raw, itemId, toolCall)];
  const status = readString(update.status);
  if (status === "completed" || status === "failed") {
    events.push(toolCompletedEvent(raw, itemId, toolCall, update, status));
  }
  return events;
}

function normalizeToolCallUpdate(
  raw: Record<string, unknown>,
  update: Record<string, unknown>,
  toolCalls: Map<string, AcpToolCall>,
  parentToolCallId: string | null,
) {
  const itemId = readString(update.toolCallId);
  if (!itemId) return [normalized("unknown", raw, { updateType: "tool_call_update" })];
  const existing = toolCalls.get(itemId);
  const name = acpToolName(update, existing?.name);
  const rawInput = readRecord(update.rawInput) ?? existing?.rawInput;
  const kind = existing?.kind ?? classifyTool(update, name);
  const mcp = mcpToolInfo(name);
  const updatedChanges = fileChangesFromTool(update, rawInput);
  const command = existing?.command ?? commandFromTool(rawInput, readString(update.title) ?? name);
  const query = existing?.query ?? queryFromTool(rawInput, readString(update.title) ?? name);
  const server = existing?.server ?? mcp.server;
  const tool = existing?.tool ?? mcp.tool;
  const changes = updatedChanges.length > 0 ? updatedChanges : existing?.changes;
  const resolvedParentToolCallId = parentToolCallId ?? existing?.parentToolCallId;
  const next: AcpToolCall = {
    kind,
    name,
    title: readString(update.title) ?? existing?.title ?? name,
    ...(command ? { command } : {}),
    ...(query ? { query } : {}),
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
    ...(changes ? { changes } : {}),
    ...(rawInput ? { rawInput } : {}),
    ...(resolvedParentToolCallId ? { parentToolCallId: resolvedParentToolCallId } : {}),
    outputText: existing?.outputText ?? "",
  };
  toolCalls.set(itemId, next);
  const events: HarnessNormalizedEvent[] = [];
  const outputText = toolOutputText(update);
  if (kind === "command" && outputText) {
    const delta = outputText.startsWith(next.outputText)
      ? outputText.slice(next.outputText.length)
      : outputText;
    next.outputText = outputText;
    if (delta) {
      events.push(
        normalized("command.output", raw, {
          itemId,
          command: next.command,
          delta,
          parentToolCallId: next.parentToolCallId,
        }),
      );
    }
  }
  const status = readString(update.status);
  if (status === "completed" || status === "failed") {
    events.push(toolCompletedEvent(raw, itemId, next, update, status));
    toolCalls.delete(itemId);
  }
  return events;
}

function toolStartedEvent(
  raw: Record<string, unknown>,
  itemId: string,
  toolCall: AcpToolCall,
): HarnessNormalizedEvent {
  const common = { itemId, parentToolCallId: toolCall.parentToolCallId };
  switch (toolCall.kind) {
    case "command":
      return normalized("command.started", raw, {
        ...common,
        command: toolCall.command ?? toolCall.title,
      });
    case "file_change":
      return normalized("file_change.started", raw, {
        ...common,
        changes: toolCall.changes ?? [],
      });
    case "web_search":
      return normalized("web_search.started", raw, { ...common, query: toolCall.query });
    case "subagent":
      return normalized("subagent.started", raw, {
        ...common,
        description: toolCall.title,
        subagentType: toolCall.name,
        prompt: readString(toolCall.rawInput?.prompt),
      });
    case "tool":
      return normalized("mcp_tool.started", raw, {
        ...common,
        server: toolCall.server,
        tool: toolCall.tool ?? toolCall.name,
        rawInput: toolCall.rawInput,
      });
  }
}

function toolCompletedEvent(
  raw: Record<string, unknown>,
  itemId: string,
  toolCall: AcpToolCall,
  update: Record<string, unknown>,
  status: "completed" | "failed",
): HarnessNormalizedEvent {
  const outputText = toolOutputText(update) || toolCall.outputText;
  const common = { itemId, parentToolCallId: toolCall.parentToolCallId };
  switch (toolCall.kind) {
    case "command":
      return status === "failed"
        ? normalized("command.failed", raw, {
            ...common,
            command: toolCall.command ?? toolCall.title,
            error: truncate(outputText, 600) ?? `${toolCall.title} failed.`,
          })
        : normalized("command.completed", raw, {
            ...common,
            command: toolCall.command ?? toolCall.title,
            output: { status, exitCode: commandExitCode(update) },
          });
    case "file_change":
      return normalized("file_change.completed", raw, {
        ...common,
        changes: toolCall.changes ?? [],
        status,
      });
    case "web_search":
      return normalized("web_search.completed", raw, {
        ...common,
        query: toolCall.query,
        status,
      });
    case "subagent":
      return normalized("subagent.completed", raw, {
        ...common,
        status,
        result: status === "completed" ? truncate(outputText, 2_000) : undefined,
        error: status === "failed" ? (truncate(outputText, 600) ?? "Subagent failed.") : undefined,
      });
    case "tool": {
      const artifact =
        status === "completed" && toolCall.tool === PUBLISH_ARTIFACT_TOOL_NAME
          ? publishedArtifact(update.rawOutput, outputText)
          : null;
      return normalized("mcp_tool.completed", raw, {
        ...common,
        server: toolCall.server,
        tool: toolCall.tool ?? toolCall.name,
        status,
        // Carry the call arguments and result through completion so the expanded tool row
        // shows what actually happened instead of a bare "completed". A published artifact
        // renders as its own part, so its raw JSON echo is intentionally omitted here.
        rawInput: toolCall.rawInput,
        result:
          status === "completed" && !artifact
            ? (truncate(outputText, MCP_TOOL_RESULT_LIMIT) ?? undefined)
            : undefined,
        error: status === "failed" ? (truncate(outputText, 600) ?? "Tool failed.") : undefined,
        artifact: artifact ?? undefined,
      });
    }
  }
}

function classifyTool(update: Record<string, unknown>, name: string): AcpToolKind {
  if (
    claudeMetaBoolean(update, "subagent") ||
    (codexSubagentMeta(update) && !readString(codexSubagentMeta(update)?.parentToolCallId)) ||
    codexCollaborationMeta(update) ||
    name === "Agent" ||
    name === "Task"
  ) {
    return "subagent";
  }
  const kind = readString(update.kind);
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "search" || kind === "fetch") return "web_search";
  return "tool";
}

function acpToolName(update: Record<string, unknown>, fallback = "tool") {
  const rawInput = readRecord(update.rawInput);
  const mcpName =
    readString(rawInput?.server) && readString(rawInput?.tool)
      ? `mcp__${readString(rawInput?.server)}__${readString(rawInput?.tool)}`
      : null;
  return (
    claudeMetaString(update, "toolName") ??
    mcpName ??
    readString(update.name) ??
    readString(update.title) ??
    fallback
  );
}

function commandFromTool(rawInput: Record<string, unknown> | undefined, title: string) {
  const command = readString(rawInput?.command);
  if (command) return command;
  const args = Array.isArray(rawInput?.args)
    ? rawInput.args.filter((value): value is string => typeof value === "string")
    : [];
  return args.length ? [title, ...args].join(" ") : title;
}

function queryFromTool(rawInput: Record<string, unknown> | undefined, title: string) {
  return readString(rawInput?.query) ?? readString(rawInput?.url) ?? title;
}

function fileChangesFromTool(
  update: Record<string, unknown>,
  rawInput: Record<string, unknown> | undefined,
) {
  const paths = new Set<string>();
  for (const location of Array.isArray(update.locations) ? update.locations : []) {
    const path = readString(readRecord(location)?.path);
    if (path) paths.add(path);
  }
  for (const key of ["file_path", "notebook_path", "path"] as const) {
    const path = readString(rawInput?.[key]);
    if (path) paths.add(path);
  }
  return [...paths].map((path) => ({ path, kind: readString(update.kind) ?? "edit" }));
}

function toolOutputText(update: Record<string, unknown>) {
  const texts: string[] = [];
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const record = readRecord(item);
    const content = record?.type === "content" ? readRecord(record.content) : null;
    if (content?.type === "text") {
      const text = readStringAllowEmpty(content.text);
      if (text) texts.push(text);
    }
  }
  if (texts.length) return texts.join("\n");
  if (typeof update.rawOutput === "string") return update.rawOutput;
  const rawOutput = readRecord(update.rawOutput);
  if (rawOutput) {
    const formatted =
      readStringAllowEmpty(rawOutput.formatted_output) ??
      readStringAllowEmpty(rawOutput.output) ??
      readStringAllowEmpty(rawOutput.content);
    if (formatted) return formatted;
  }
  const meta = readRecord(update._meta);
  for (const key of ["terminal_output", "terminal_output_delta", "mcp_output_delta"]) {
    const data = readStringAllowEmpty(readRecord(meta?.[key])?.data);
    if (data) return data;
  }
  return "";
}

function commandExitCode(update: Record<string, unknown>) {
  const output = readRecord(update.rawOutput);
  return readNumber(output?.exitCode) ?? readNumber(output?.exit_code);
}

function mcpToolInfo(name: string) {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (match) return { server: match[1], tool: match[2] };
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name);
  return dotted ? { server: dotted[1], tool: dotted[2] } : { server: undefined, tool: name };
}

function renderPlan(update: Record<string, unknown>) {
  const plan = readRecord(update.plan);
  const markdown =
    readString(update.markdown) ??
    readString(update.text) ??
    readString(plan?.content) ??
    readString(plan?.text);
  if (markdown) return markdown;
  const entries = Array.isArray(update.entries)
    ? update.entries
    : Array.isArray(update.items)
      ? update.items
      : [];
  const lines: string[] = [];
  for (const entry of entries) {
    const record = readRecord(entry);
    const content = readString(record?.content);
    if (!content) continue;
    const status = readString(record?.status);
    const marker = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
    lines.push(`- ${marker} ${content}`);
  }
  return lines.join("\n");
}

function readPromptUsage(value: unknown): AcpTurnSummary["usage"] {
  const usage = readRecord(value);
  if (!usage) return null;
  const inputTokens = readNumber(usage.inputTokens) ?? 0;
  const outputTokens = readNumber(usage.outputTokens) ?? 0;
  const cacheRead = readNumber(usage.cachedReadTokens);
  const cacheWrite = readNumber(usage.cachedWriteTokens);
  if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheRead != null ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite != null ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

function promptFailureMessage(stopReason: string) {
  if (stopReason === "cancelled") return "The coding engine was interrupted.";
  if (stopReason === "max_tokens") return "The coding engine reached its token limit.";
  if (stopReason === "max_turn_requests") return "The coding engine reached its turn limit.";
  if (stopReason === "refusal") return "The coding engine declined the request.";
  return `The coding engine stopped with reason: ${stopReason}.`;
}

function publishedArtifact(rawOutput: unknown, outputText: string) {
  const candidates: unknown[] = [rawOutput];
  if (outputText) {
    try {
      candidates.push(JSON.parse(outputText));
    } catch {
      // A non-JSON tool result cannot be an artifact publication payload.
    }
  }
  for (const candidate of candidates) {
    const artifact = parsePublishedChatArtifact(candidate);
    if (artifact) return artifact;
  }
  return null;
}

function claudeMeta(update: Record<string, unknown>) {
  return readRecord(readRecord(update._meta)?.claudeCode);
}

function claudeMetaString(update: Record<string, unknown>, key: string) {
  return readString(claudeMeta(update)?.[key]);
}

function claudeMetaBoolean(update: Record<string, unknown>, key: string) {
  return claudeMeta(update)?.[key] === true;
}

function codexMeta(update: Record<string, unknown>) {
  return readRecord(readRecord(update._meta)?.codex);
}

function codexSubagentMeta(update: Record<string, unknown>) {
  return readRecord(codexMeta(update)?.subagent);
}

function codexCollaborationMeta(update: Record<string, unknown>) {
  return readRecord(codexMeta(update)?.collaboration);
}

function providerParentToolCallId(update: Record<string, unknown>) {
  return (
    claudeMetaString(update, "parentToolUseId") ??
    readString(codexSubagentMeta(update)?.parentToolCallId) ??
    readString(codexCollaborationMeta(update)?.senderThreadId)
  );
}

function readGoal(value: unknown): AcpGoalSummary | null | undefined {
  if (value === null) return null;
  const record = readRecord(value);
  if (!record) return undefined;
  const objective = readString(record.objective);
  const status = readString(record.status);
  if (!objective || !status) return undefined;
  return {
    objective,
    status,
    tokenBudget: readNumber(record.tokenBudget),
    tokensUsed: readNumber(record.tokensUsed),
    timeUsedSeconds: readNumber(record.timeUsedSeconds),
  };
}

function normalized(
  type: HarnessNormalizedEvent["type"],
  rawEvent: Record<string, unknown>,
  payload: Record<string, unknown>,
): HarnessNormalizedEvent {
  return {
    type,
    rawEvent,
    payload: Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined && value !== null),
    ),
  };
}

function jsonRpcRequestId(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function truncate(value: string, limit: number) {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function readStringAllowEmpty(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
