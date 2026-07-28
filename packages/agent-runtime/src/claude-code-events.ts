import type { CodexAppServerNormalizedEvent } from "./codex-app-server-events";

// Translates Claude Code headless stream-json events (`claude -p --output-format
// stream-json --verbose`) into the CodexAppServerNormalizedEvent vocabulary, so the
// goat chat projector, audit log, and renderer consume Claude turns unchanged.
//
// The normalizer is stateful: tool_result events only carry a tool_use_id, so routing
// them to the right terminal event (command vs file change vs web search vs generic
// tool) requires remembering what each tool_use started as.

export type ClaudeCodeTurnSummary = {
  status: "success" | "failure";
  result: string | null;
  error: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  sessionId: string | null;
};

type ClaudeToolKind = "command" | "file_change" | "web_search" | "plan" | "tool";

type ClaudeToolUse = {
  kind: ClaudeToolKind;
  command?: string | undefined;
  changes?: Array<Record<string, unknown>> | undefined;
  query?: string | undefined;
  server?: string | undefined;
  tool?: string | undefined;
};

const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_ITEM_ID = "claude-plan";

export function createClaudeCodeEventNormalizer() {
  const toolUses = new Map<string, ClaudeToolUse>();
  let sessionId: string | null = null;
  let summary: ClaudeCodeTurnSummary | null = null;

  const normalize = (raw: Record<string, unknown>): CodexAppServerNormalizedEvent[] => {
    const type = readString(raw.type);

    if (type === "system") {
      if (readString(raw.subtype) === "init") {
        sessionId = readString(raw.session_id) ?? sessionId;
        return [
          normalized("turn.started", raw, {
            threadId: sessionId,
            turnId: sessionId,
            status: "running",
          }),
        ];
      }
      return [normalized("unknown", raw, { subtype: readString(raw.subtype) })];
    }

    if (type === "assistant") return normalizeAssistantMessage(raw, toolUses);
    if (type === "user") return normalizeUserMessage(raw, toolUses);

    if (type === "result") {
      const subtype = readString(raw.subtype);
      sessionId = readString(raw.session_id) ?? sessionId;
      const usage = readUsage(raw.usage);
      // API failures report subtype "success" with is_error=true (observed on a 401),
      // so is_error is the authoritative failure signal.
      const success = subtype === "success" && raw.is_error !== true;
      // Failed results (e.g. a stale --resume id) carry their message in an
      // `errors: string[]` field, not `result`; stderr stays empty.
      const errorDetails = Array.isArray(raw.errors)
        ? raw.errors.filter((entry): entry is string => typeof entry === "string" && !!entry)
        : [];
      const httpStatus =
        typeof raw.api_error_status === "number" ? ` (HTTP ${raw.api_error_status})` : "";
      const error = success
        ? null
        : `${
            readString(raw.result) ??
            (errorDetails.length
              ? errorDetails.join("; ")
              : `Claude Code finished with status: ${subtype ?? "unknown"}.`)
          }${httpStatus}`;
      summary = {
        status: success ? "success" : "failure",
        result: readString(raw.result),
        error,
        usage,
        sessionId,
      };
      return [
        normalized("turn.completed", raw, {
          turnId: sessionId,
          status: success ? "completed" : "failed",
          error: error ?? undefined,
        }),
        normalized("usage.updated", raw, {
          turnId: sessionId,
          tokenUsage: usage,
        }),
      ];
    }

    return [normalized("unknown", raw, { eventType: type })];
  };

  return {
    normalize,
    sessionId: () => sessionId,
    summary: () => summary,
  };
}

function normalizeAssistantMessage(
  raw: Record<string, unknown>,
  toolUses: Map<string, ClaudeToolUse>,
): CodexAppServerNormalizedEvent[] {
  // Subagent traffic (Task tool) carries parent_tool_use_id; the parent Task tool part
  // already represents that work, so nested content is not projected.
  if (readString(raw.parent_tool_use_id)) return [];
  const message = readRecord(raw.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const messageId = readString(message?.id) ?? "assistant";
  const events: CodexAppServerNormalizedEvent[] = [];

  content.forEach((block, index) => {
    const record = readRecord(block);
    if (!record) return;
    const itemId = `${messageId}:${index}`;

    if (record.type === "text") {
      const text = readString(record.text);
      if (text) events.push(normalized("assistant.completed", raw, { itemId, content: text }));
      return;
    }

    if (record.type === "thinking") {
      const text = readString(record.thinking);
      if (text) events.push(normalized("reasoning.completed", raw, { itemId, text }));
      return;
    }

    if (record.type !== "tool_use") return;
    const toolUseId = readString(record.id) ?? itemId;
    const name = readString(record.name) ?? "tool";
    const input = readRecord(record.input) ?? {};

    if (name === "Bash") {
      const command = readString(input.command) ?? "command";
      toolUses.set(toolUseId, { kind: "command", command });
      events.push(normalized("command.started", raw, { itemId: toolUseId, command }));
      return;
    }

    if (FILE_CHANGE_TOOLS.has(name)) {
      const path = readString(input.file_path) ?? readString(input.notebook_path);
      const changes = path ? [{ path, kind: name.toLowerCase() }] : [];
      toolUses.set(toolUseId, { kind: "file_change", changes });
      events.push(normalized("file_change.started", raw, { itemId: toolUseId, changes }));
      return;
    }

    if (name === "WebSearch" || name === "WebFetch") {
      const query = readString(input.query) ?? readString(input.url) ?? undefined;
      toolUses.set(toolUseId, { kind: "web_search", query });
      events.push(normalized("web_search.started", raw, { itemId: toolUseId, query }));
      return;
    }

    if (name === "TodoWrite") {
      toolUses.set(toolUseId, { kind: "plan" });
      const text = renderTodoList(input.todos);
      if (text) {
        // Full replacement each time: a stable itemId upserts one plan part, and
        // status "completed" renders the whole list rather than appending deltas.
        events.push(
          normalized("plan.updated", raw, { itemId: PLAN_ITEM_ID, text, status: "completed" }),
        );
      }
      return;
    }

    const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    const toolInfo: ClaudeToolUse = mcpMatch
      ? { kind: "tool", server: mcpMatch[1], tool: mcpMatch[2] }
      : { kind: "tool", tool: name };
    toolUses.set(toolUseId, toolInfo);
    events.push(
      normalized("mcp_tool.started", raw, {
        itemId: toolUseId,
        server: toolInfo.server,
        tool: toolInfo.tool,
      }),
    );
  });

  return events;
}

function normalizeUserMessage(
  raw: Record<string, unknown>,
  toolUses: Map<string, ClaudeToolUse>,
): CodexAppServerNormalizedEvent[] {
  if (readString(raw.parent_tool_use_id)) return [];
  const message = readRecord(raw.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: CodexAppServerNormalizedEvent[] = [];

  for (const block of content) {
    const record = readRecord(block);
    if (record?.type !== "tool_result") continue;
    const toolUseId = readString(record.tool_use_id);
    if (!toolUseId) continue;
    const started = toolUses.get(toolUseId);
    if (!started) continue;
    toolUses.delete(toolUseId);
    const isError = record.is_error === true;
    const outputText = toolResultText(record.content);

    if (started.kind === "command") {
      if (outputText) {
        events.push(
          normalized("command.output", raw, {
            itemId: toolUseId,
            delta: outputText,
            command: started.command,
          }),
        );
      }
      if (isError) {
        events.push(
          normalized("command.failed", raw, {
            itemId: toolUseId,
            command: started.command,
            error: truncate(outputText, 600) ?? "Command failed.",
          }),
        );
      } else {
        events.push(
          normalized("command.completed", raw, {
            itemId: toolUseId,
            command: started.command,
            output: { status: "completed", exitCode: null },
          }),
        );
      }
      continue;
    }

    if (started.kind === "file_change") {
      events.push(
        normalized("file_change.completed", raw, {
          itemId: toolUseId,
          changes: started.changes ?? [],
          status: isError ? "failed" : "completed",
        }),
      );
      continue;
    }

    if (started.kind === "web_search") {
      events.push(
        normalized("web_search.completed", raw, {
          itemId: toolUseId,
          query: started.query,
          status: isError ? "failed" : "completed",
        }),
      );
      continue;
    }

    if (started.kind === "plan") continue;

    events.push(
      normalized("mcp_tool.completed", raw, {
        itemId: toolUseId,
        server: started.server,
        tool: started.tool,
        status: isError ? "failed" : "completed",
        error: isError ? (truncate(outputText, 600) ?? "Tool failed.") : undefined,
      }),
    );
  }

  return events;
}

function renderTodoList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    const content = readString(record?.content);
    if (!content) continue;
    const status = readString(record?.status);
    const marker = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
    lines.push(`- ${marker} ${content}`);
  }
  return lines.length ? lines.join("\n") : null;
}

function toolResultText(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    const text = record?.type === "text" ? readString(record.text) : null;
    if (text) texts.push(text);
  }
  return texts.length ? texts.join("\n") : null;
}

function readUsage(value: unknown): { input_tokens: number; output_tokens: number } | null {
  const record = readRecord(value);
  if (!record) return null;
  const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : 0;
  const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : 0;
  if (!inputTokens && !outputTokens) return null;
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

function truncate(value: string | null, limit: number): string | null {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function normalized(
  type: CodexAppServerNormalizedEvent["type"],
  rawEvent: Record<string, unknown>,
  payload: Record<string, unknown>,
): CodexAppServerNormalizedEvent {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) output[key] = value;
  }
  return { type, payload: output, rawEvent };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
