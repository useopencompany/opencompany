import type { RunStreamEventDto } from "@opencompany/protocol";
import type { UIMessageChunk } from "ai";

export type HeadlessChatUiProjectorPart = {
  id: string;
  kind: "text" | "reasoning";
  text: string;
  done: boolean;
};

type PartState = {
  kind: "text" | "reasoning";
  appliedText: string;
  started: boolean;
  done: boolean;
};

// Projects the canonical semantic stream (durable RunEvents plus the optional low-latency
// presentation lane) into AI SDK UIMessageChunks. `message.part_updated` (durable, issue #1192)
// and `message.presentation_delta` (transient, Redis) both converge on the same per-part applied
// text so either channel alone is sufficient for correct output; Redis only changes smoothness.
// `message.content_updated` remains on the wire as the compatible final-answer text projection
// but is intentionally not applied here to avoid double-rendering text that `message.part_updated`
// already streams part-by-part; `finish()` closes any still-open part at every terminal boundary.
export class HeadlessChatUiProjector {
  private readonly parts = new Map<string, PartState>();
  private readonly partOrder: string[] = [];
  private readonly startedToolCalls: Set<string>;

  constructor(
    private readonly assistantMessageId: string,
    initialParts: readonly HeadlessChatUiProjectorPart[] = [],
    initialStartedToolCallIds: readonly string[] = [],
  ) {
    for (const part of Array.isArray(initialParts) ? initialParts : []) {
      if (!part || typeof part.id !== "string" || !part.id) continue;
      if (part.kind !== "text" && part.kind !== "reasoning") continue;
      this.parts.set(part.id, {
        kind: part.kind,
        appliedText: typeof part.text === "string" ? part.text : "",
        started: true,
        done: part.done === true,
      });
      this.partOrder.push(part.id);
    }
    this.startedToolCalls = new Set(
      (Array.isArray(initialStartedToolCallIds) ? initialStartedToolCallIds : []).filter(
        (value) => typeof value === "string" && value.length > 0,
      ),
    );
  }

  get partsSnapshot(): HeadlessChatUiProjectorPart[] {
    return this.partOrder.map((id) => {
      const state = this.parts.get(id);
      return {
        id,
        kind: state?.kind ?? "text",
        text: state?.appliedText ?? "",
        done: state?.done ?? false,
      };
    });
  }

  get startedToolCallIds() {
    return [...this.startedToolCalls];
  }

  project(event: RunStreamEventDto): UIMessageChunk[] {
    if (event.type === "message.presentation_delta") {
      const { partId, kind, startOffset, endOffset, delta } = event.payload;
      const state = this.stateFor(partId, kind);
      if (startOffset > state.appliedText.length || endOffset <= state.appliedText.length)
        return [];
      return this.applyDelta(partId, state, delta.slice(state.appliedText.length - startOffset));
    }

    if (event.type === "message.part_updated") {
      const { partId, kind, state: lifecycle, text } = event.payload;
      const state = this.stateFor(partId, kind);
      // Durable snapshots are append-only during an Attempt. If a future projector revises prior
      // text, Electric/the read model remains authoritative and the transient overlay must not
      // invent a suffix.
      const chunks = text.startsWith(state.appliedText)
        ? this.applyDelta(partId, state, text.slice(state.appliedText.length))
        : [];
      if (lifecycle === "done") chunks.push(...this.endPart(partId));
      return chunks;
    }

    if (event.type === "message.content_updated") {
      return [];
    }

    if (event.type === "tool.started") {
      this.startedToolCalls.add(event.payload.toolCallId);
      return [
        ...this.endAllOpenParts(),
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
        chunks.push(...this.endAllOpenParts(), {
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
      return [...this.endAllOpenParts(), { type: "error", errorText: event.payload.message }];
    }

    if (event.type === "run.canceled") {
      return [...this.endAllOpenParts(), { type: "abort", reason: "Canceled by the user." }];
    }

    return [];
  }

  finish(): UIMessageChunk[] {
    return this.endAllOpenParts();
  }

  private stateFor(partId: string, kind: "text" | "reasoning"): PartState {
    let state = this.parts.get(partId);
    if (!state) {
      state = { kind, appliedText: "", started: false, done: false };
      this.parts.set(partId, state);
      this.partOrder.push(partId);
    }
    return state;
  }

  private applyDelta(partId: string, state: PartState, delta: string): UIMessageChunk[] {
    if (!delta) return [];
    const chunks: UIMessageChunk[] = [];
    if (!state.started) {
      state.started = true;
      chunks.push({ type: `${state.kind}-start`, id: this.chunkId(partId) } as UIMessageChunk);
    }
    state.appliedText += delta;
    chunks.push({ type: `${state.kind}-delta`, id: this.chunkId(partId), delta } as UIMessageChunk);
    return chunks;
  }

  private endPart(partId: string): UIMessageChunk[] {
    const state = this.parts.get(partId);
    if (!state || state.done) return [];
    state.done = true;
    if (!state.started) return [];
    return [{ type: `${state.kind}-end`, id: this.chunkId(partId) } as UIMessageChunk];
  }

  private endAllOpenParts(): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    for (const partId of this.partOrder) chunks.push(...this.endPart(partId));
    return chunks;
  }

  private chunkId(partId: string) {
    // partId is already minted per-message (`${kind}_${assistantMessageId}_${index}`), so it is a
    // stable, globally unique AI SDK chunk id on its own.
    return partId;
  }
}
