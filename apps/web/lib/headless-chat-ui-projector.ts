import {
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
} from "@opencompany/agent-runtime";
import type { RunStreamEventDto } from "@opencompany/protocol";
import type { UIMessage, UIMessageChunk } from "ai";

export type HeadlessToolCallCheckpoint = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export class HeadlessChatUiProjector {
  private text: string;
  private activeTextId: string | null = null;
  private textSegment: number;
  private readonly activeToolCalls: Map<string, HeadlessToolCallCheckpoint>;

  constructor(
    private readonly assistantMessageId: string,
    initialContent = "",
    initialTextSegment = 0,
    initialActiveToolCalls: readonly HeadlessToolCallCheckpoint[] = [],
  ) {
    this.text = typeof initialContent === "string" ? initialContent : "";
    this.textSegment =
      Number.isSafeInteger(initialTextSegment) && initialTextSegment >= 0 ? initialTextSegment : 0;
    this.activeToolCalls = new Map(
      initialActiveToolCalls.map((call) => [call.toolCallId, { ...call }]),
    );
  }

  get content() {
    return this.text;
  }

  get segment() {
    return this.textSegment;
  }

  get toolCallCheckpoint() {
    return [...this.activeToolCalls.values()].map((call) => ({ ...call }));
  }

  /**
   * Seeds a fresh AI SDK message projection before applying events after a durable cursor.
   * Every resumed approval/result must have its invocation in the same consumer state.
   */
  rehydrate(): UIMessageChunk[] {
    return this.toolCallCheckpoint.map((call) => ({
      type: "tool-input-available",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      ...(isDynamicCodexTool(call.toolName) ? { dynamic: true } : {}),
    }));
  }

  project(event: RunStreamEventDto): UIMessageChunk[] {
    if (event.type === "message.presentation_delta") {
      const { startOffset, endOffset, delta } = event.payload;
      if (startOffset > this.text.length || endOffset <= this.text.length) return [];
      return this.appendText(delta.slice(this.text.length - startOffset));
    }

    if (event.type === "message.content_updated") {
      const next = event.payload.content;
      // Durable snapshots are append-only during an Attempt. If a future projector revises prior
      // text, Electric remains authoritative and the transient overlay must not invent a suffix.
      const chunks = next.startsWith(this.text)
        ? this.appendText(next.slice(this.text.length))
        : [];
      if (event.payload.complete) chunks.push(...this.endText());
      return chunks;
    }

    if (event.type === "tool.started") {
      const toolCall = {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.name,
        input: transientToolInput(event.payload),
      };
      this.activeToolCalls.set(toolCall.toolCallId, toolCall);
      return [
        ...this.endText(),
        {
          type: "tool-input-available",
          ...toolCall,
          ...(isDynamicCodexTool(toolCall.toolName) ? { dynamic: true } : {}),
        },
      ];
    }

    if (event.type === "tool.completed") {
      this.requireActiveToolCall(event.payload.toolCallId, event.type);
      const toolName = this.activeToolCalls.get(event.payload.toolCallId)?.toolName;
      this.activeToolCalls.delete(event.payload.toolCallId);
      return [
        {
          type: "tool-output-available",
          toolCallId: event.payload.toolCallId,
          output: transientToolOutput(toolName, event.payload.summary),
        },
      ];
    }

    if (event.type === "tool.failed") {
      this.requireActiveToolCall(event.payload.toolCallId, event.type);
      this.activeToolCalls.delete(event.payload.toolCallId);
      return [
        {
          type: "tool-output-error",
          toolCallId: event.payload.toolCallId,
          errorText: event.payload.message,
        },
      ];
    }

    if (event.type === "approval.requested") {
      const toolCallId = event.payload.toolCallId ?? event.payload.approvalId;
      const chunks: UIMessageChunk[] = [];
      if (!this.activeToolCalls.has(toolCallId)) {
        const toolCall = {
          toolCallId,
          toolName: event.payload.kind,
          input: { action: event.payload.action ?? event.payload.kind },
        };
        this.activeToolCalls.set(toolCallId, toolCall);
        chunks.push(...this.endText(), {
          type: "tool-input-available",
          ...toolCall,
        });
      }
      chunks.push({
        type: "tool-approval-request",
        approvalId: event.payload.approvalId,
        toolCallId,
      });
      return chunks;
    }

    if (event.type === "run.failed") {
      return [...this.endText(), { type: "error", errorText: event.payload.message }];
    }

    if (event.type === "run.canceled") {
      return [...this.endText(), { type: "abort", reason: "Canceled by the user." }];
    }

    return [];
  }

  finish(): UIMessageChunk[] {
    return this.endText();
  }

  private requireActiveToolCall(toolCallId: string, eventType: "tool.completed" | "tool.failed") {
    if (this.activeToolCalls.has(toolCallId)) return;
    throw new Error(`${eventType} was received before tool.started for tool call ${toolCallId}.`);
  }

  private appendText(delta: string): UIMessageChunk[] {
    if (!delta) return [];
    const chunks: UIMessageChunk[] = [];
    if (!this.activeTextId) {
      this.textSegment += 1;
      this.activeTextId = `text_${this.assistantMessageId}_${this.textSegment}`;
      chunks.push({ type: "text-start", id: this.activeTextId });
    }
    this.text += delta;
    chunks.push({ type: "text-delta", id: this.activeTextId, delta });
    return chunks;
  }

  private endText(): UIMessageChunk[] {
    if (!this.activeTextId) return [];
    const id = this.activeTextId;
    this.activeTextId = null;
    return [{ type: "text-end", id }];
  }
}

type ToolStartedPayload = Extract<RunStreamEventDto, { type: "tool.started" }>["payload"];

function transientToolInput(payload: ToolStartedPayload): Record<string, unknown> {
  const common = {
    ...(payload.label ? { label: payload.label } : {}),
    ...(payload.detail ? { detail: payload.detail } : {}),
    ...(payload.kind ? { kind: payload.kind } : {}),
    ...(payload.parentToolCallId ? { parentToolCallId: payload.parentToolCallId } : {}),
  };
  if (payload.name === CODEX_COMMAND_TOOL_NAME) {
    return {
      ...common,
      command: payload.detail ?? payload.label ?? "Command",
      ...(payload.label && payload.label !== "Command" ? { description: payload.label } : {}),
    };
  }
  if (payload.name === CODEX_MCP_TOOL_NAME) {
    return {
      label: payload.label ?? "MCP tool",
      ...common,
      ...(payload.detail ? { tool: payload.detail } : {}),
    };
  }
  if (payload.name === CODEX_WEB_SEARCH_TOOL_NAME) {
    return {
      label: payload.label ?? "Web search",
      ...common,
      ...(payload.detail ? { query: payload.detail } : {}),
    };
  }
  if (payload.name === CODEX_SUBAGENT_TOOL_NAME) {
    return {
      label: payload.label ?? "Subagent",
      ...common,
      ...(payload.detail ? { description: payload.detail } : {}),
      ...(payload.kind && payload.kind !== "subagent" ? { subagentType: payload.kind } : {}),
    };
  }
  if (payload.name === CODEX_FILE_CHANGE_TOOL_NAME) {
    return {
      label: payload.label ?? "File change",
      ...common,
    };
  }
  return common;
}

function transientToolOutput(toolName: string | undefined, summary: string | undefined) {
  if (toolName === CODEX_COMMAND_TOOL_NAME) {
    return {
      status: summary === "failed" || summary === "interrupted" ? summary : "completed",
      exitCode: null,
    };
  }
  if (toolName === CODEX_SUBAGENT_TOOL_NAME || (toolName && isDynamicCodexTool(toolName))) {
    return { status: summary ?? "completed" };
  }
  return { ok: true, ...(summary ? { summary } : {}) };
}

function isDynamicCodexTool(toolName: string) {
  return (
    toolName === CODEX_PLAN_TOOL_NAME ||
    toolName === CODEX_GOAL_TOOL_NAME ||
    toolName === CODEX_QUESTION_TOOL_NAME ||
    toolName === CODEX_APPROVAL_TOOL_NAME ||
    toolName === CODEX_FILE_CHANGE_TOOL_NAME ||
    toolName === CODEX_MCP_TOOL_NAME ||
    toolName === CODEX_DYNAMIC_TOOL_NAME ||
    toolName === CODEX_WEB_SEARCH_TOOL_NAME
  );
}

type MessagePart = UIMessage["parts"][number];

/** Rebuilds the transient flat AI SDK tool list into the persisted subagent shape. */
export function nestHeadlessToolParts<UI_MESSAGE extends UIMessage>(
  message: UI_MESSAGE,
): UI_MESSAGE {
  if (message.role !== "assistant") return message;
  const parts = message.parts as readonly MessagePart[];
  const parentIds = new Set(
    parts.map(toolCallIdFromPart).filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
  );
  const childrenByParent = new Map<string, MessagePart[]>();
  for (const part of parts) {
    const parentToolCallId = parentToolCallIdFromPart(part);
    if (!parentToolCallId || !parentIds.has(parentToolCallId)) continue;
    const children = childrenByParent.get(parentToolCallId) ?? [];
    children.push(withoutParentToolCallId(part));
    childrenByParent.set(parentToolCallId, children);
  }
  if (childrenByParent.size === 0) return message;

  const nested = parts.flatMap((part) => {
    const parentToolCallId = parentToolCallIdFromPart(part);
    if (parentToolCallId && parentIds.has(parentToolCallId)) return [];
    const toolCallId = toolCallIdFromPart(part);
    const children = toolCallId ? childrenByParent.get(toolCallId) : undefined;
    if (!children?.length) return [part];
    const record = part as unknown as Record<string, unknown>;
    const existingChildren = Array.isArray(record.children)
      ? (record.children as MessagePart[])
      : [];
    const existingIds = new Set(
      existingChildren
        .map(toolCallIdFromPart)
        .filter((childToolCallId): childToolCallId is string => Boolean(childToolCallId)),
    );
    return [
      {
        ...record,
        children: [
          ...existingChildren,
          ...children.filter((child) => {
            const childToolCallId = toolCallIdFromPart(child);
            return !childToolCallId || !existingIds.has(childToolCallId);
          }),
        ],
      } as unknown as MessagePart,
    ];
  });
  return { ...message, parts: nested } as UI_MESSAGE;
}

function toolCallIdFromPart(part: MessagePart) {
  const record = part as unknown as Record<string, unknown>;
  return typeof record.toolCallId === "string" ? record.toolCallId : null;
}

function parentToolCallIdFromPart(part: MessagePart) {
  const record = part as unknown as Record<string, unknown>;
  if (!isRecord(record.input)) return null;
  return typeof record.input.parentToolCallId === "string" ? record.input.parentToolCallId : null;
}

function withoutParentToolCallId(part: MessagePart): MessagePart {
  const record = part as unknown as Record<string, unknown>;
  if (!isRecord(record.input)) return part;
  const input = { ...record.input };
  delete input.parentToolCallId;
  return { ...record, input } as unknown as MessagePart;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
