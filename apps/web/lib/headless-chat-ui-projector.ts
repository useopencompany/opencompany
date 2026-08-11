import type { RunStreamEventDto } from "@opencompany/protocol";
import type { UIMessageChunk } from "ai";

export class HeadlessChatUiProjector {
  private text: string;
  private activeTextId: string | null = null;
  private textSegment: number;
  private readonly startedToolCalls: Set<string>;

  constructor(
    private readonly assistantMessageId: string,
    initialContent = "",
    initialTextSegment = 0,
    initialStartedToolCallIds: readonly string[] = [],
  ) {
    this.text = typeof initialContent === "string" ? initialContent : "";
    this.textSegment =
      Number.isSafeInteger(initialTextSegment) && initialTextSegment >= 0 ? initialTextSegment : 0;
    this.startedToolCalls = new Set(
      (Array.isArray(initialStartedToolCallIds) ? initialStartedToolCallIds : []).filter(
        (value) => typeof value === "string" && value.length > 0,
      ),
    );
  }

  get content() {
    return this.text;
  }

  get segment() {
    return this.textSegment;
  }

  get startedToolCallIds() {
    return [...this.startedToolCalls];
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
      this.startedToolCalls.add(event.payload.toolCallId);
      return [
        ...this.endText(),
        {
          type: "tool-input-available",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.name,
          input: {},
        },
      ];
    }

    if (event.type === "tool.completed") {
      return [
        {
          type: "tool-output-available",
          toolCallId: event.payload.toolCallId,
          output: { ok: true },
        },
      ];
    }

    if (event.type === "tool.failed") {
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
      if (!this.startedToolCalls.has(toolCallId)) {
        this.startedToolCalls.add(toolCallId);
        chunks.push(...this.endText(), {
          type: "tool-input-available",
          toolCallId,
          toolName: event.payload.kind,
          input: { action: event.payload.action ?? event.payload.kind },
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
