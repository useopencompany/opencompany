import type { ReasoningUpdateEventDto, RunStreamEventDto } from "@opencompany/protocol/events";
import type { AttachmentDto } from "@opencompany/protocol/schemas";
import type { ChatPart, ReasoningPart, ToolPart } from "./chat";
import type { RunCheckpoint } from "./chat-store";

const replacePart = <T extends ChatPart>(
  parts: ChatPart[],
  matches: (part: ChatPart) => boolean,
  next: T,
): ChatPart[] => {
  const index = parts.findIndex(matches);
  if (index < 0) return [...parts, next];
  return parts.map((part, partIndex) => (partIndex === index ? next : part));
};

/** Applies `update` to the tool with this call id, wherever it sits in the trace. */
const updateTool = (
  parts: ChatPart[],
  toolCallId: string,
  update: (tool: ToolPart) => ToolPart,
): { parts: ChatPart[]; found: boolean } => {
  let found = false;
  const next = parts.map((part) => {
    if (found || part.type !== "tool") return part;
    if (part.toolCallId === toolCallId) {
      found = true;
      return update(part);
    }
    if (!part.children) return part;
    const nested = updateTool(part.children, toolCallId, update);
    if (!nested.found) return part;
    found = true;
    return { ...part, children: nested.parts };
  });
  return { parts: found ? next : parts, found };
};

const findTool = (parts: readonly ChatPart[], toolCallId: string): ToolPart | undefined => {
  for (const part of parts) {
    if (part.type !== "tool") continue;
    if (part.toolCallId === toolCallId) return part;
    const nested = part.children ? findTool(part.children, toolCallId) : undefined;
    if (nested) return nested;
  }
  return undefined;
};

const insertAtPosition = (siblings: ChatPart[], part: ChatPart, position: number): ChatPart[] => {
  // Parts from the canonical presentation know where they were; anything after `position`
  // happened later, so the new part goes in front of it. Live-only parts are newest.
  const before = siblings.findIndex(
    (sibling) =>
      "sourceIndex" in sibling &&
      sibling.sourceIndex !== undefined &&
      sibling.sourceIndex >= position,
  );
  if (before < 0) return [...siblings, part];
  return [...siblings.slice(0, before), part, ...siblings.slice(before)];
};

/**
 * Whether `incoming` holds newer reasoning than `existing`. Each frame carries the whole block,
 * so a replayed or reordered frame shows up as text that is not longer than what is already here.
 */
const supersedes = (existing: ReasoningPart, incoming: ReasoningPart): boolean => {
  if (existing.attempt !== undefined && incoming.attempt !== undefined) {
    if (incoming.attempt < existing.attempt) return false;
    if (incoming.attempt > existing.attempt) return true;
  }
  if (incoming.text.length !== existing.text.length)
    return incoming.text.length > existing.text.length;
  return existing.streaming && !incoming.streaming;
};

export interface ReasoningUpdate {
  parentToolCallId?: string;
  position: number;
  part: ReasoningPart;
}

/** Merges one reasoning snapshot into its block, or places a new block among its siblings. */
export const upsertReasoning = (parts: ChatPart[], update: ReasoningUpdate): ChatPart[] => {
  const upsert = (siblings: ChatPart[], idPrefix: string): ChatPart[] => {
    const part = { ...update.part, id: `${idPrefix}reasoning:${update.part.itemId}` };
    const index = siblings.findIndex(
      (sibling) => sibling.type === "reasoning" && sibling.itemId === part.itemId,
    );
    if (index < 0)
      return insertAtPosition(siblings, { ...part, sourceIndex: update.position }, update.position);
    const existing = siblings[index] as ReasoningPart;
    if (!supersedes(existing, part)) return siblings;
    return siblings.map((sibling, siblingIndex) =>
      siblingIndex === index
        ? { ...existing, ...part, sourceIndex: existing.sourceIndex }
        : sibling,
    );
  };
  if (!update.parentToolCallId) return upsert(parts, "");
  // A subagent's block waits for its parent tool; the canonical refresh delivers it otherwise.
  return updateTool(parts, update.parentToolCallId, (tool) => ({
    ...tool,
    children: upsert(tool.children ?? [], `${tool.id}/`),
  })).parts;
};

const reasoningUpdateFrom = (event: ReasoningUpdateEventDto): ReasoningUpdate => ({
  ...(event.payload.parentToolCallId ? { parentToolCallId: event.payload.parentToolCallId } : {}),
  position: event.payload.position,
  part: {
    id: `reasoning:${event.payload.itemId}`,
    type: "reasoning",
    itemId: event.payload.itemId,
    text: event.payload.text,
    streaming: event.payload.state === "streaming",
    attempt: event.attemptNumber,
  },
});

const liveReasoning = (parts: readonly ChatPart[], parentToolCallId?: string): ReasoningUpdate[] =>
  parts.flatMap((part, index): ReasoningUpdate[] => {
    if (part.type === "reasoning")
      return [
        {
          ...(parentToolCallId ? { parentToolCallId } : {}),
          position: part.sourceIndex ?? index,
          part,
        },
      ];
    if (part.type === "tool" && part.children) return liveReasoning(part.children, part.toolCallId);
    return [];
  });

/**
 * Lays live reasoning over a canonical presentation. The canonical parts can predate frames this
 * device already applied, so a block keeps whichever text is newer, and a block still streaming
 * that the checkpoint has not saved yet stays in place.
 */
export const preserveLiveReasoning = (
  canonical: ChatPart[],
  live: readonly ChatPart[],
): ChatPart[] => {
  const saved = new Set(liveReasoning(canonical).map((update) => update.part.itemId));
  return liveReasoning(live)
    .filter(
      (update) =>
        update.part.attempt !== undefined &&
        (saved.has(update.part.itemId) || update.part.streaming),
    )
    .reduce(upsertReasoning, canonical);
};

const appendText = (parts: ChatPart[], delta: string, startOffset: number): ChatPart[] => {
  const last = parts.at(-1);
  if (last?.type === "text") {
    return parts.map((part, index) =>
      index === parts.length - 1 ? { ...last, text: last.text + delta } : part,
    );
  }
  return [...parts, { id: `text:${startOffset}`, type: "text", text: delta }];
};

const reconcileTextContent = (parts: ChatPart[], content: string): ChatPart[] => {
  const currentText = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (content.startsWith(currentText)) {
    const suffix = content.slice(currentText.length);
    return suffix ? appendText(parts, suffix, currentText.length) : parts;
  }
  const firstText = parts.findIndex((part) => part.type === "text");
  if (firstText < 0) return [{ id: "text:0", type: "text", text: content }, ...parts];
  return parts.map((part, index) =>
    index === firstText && part.type === "text" ? { ...part, text: content } : part,
  );
};

export const projectRunEvent = (
  checkpoint: RunCheckpoint,
  event: RunStreamEventDto,
): RunCheckpoint => {
  if (event.type === "message.reasoning_updated") {
    const base = { ...checkpoint, presentationCursor: event.presentationCursor };
    if (event.payload.messageId !== checkpoint.assistantMessageId) return base;
    return { ...base, parts: upsertReasoning(checkpoint.parts, reasoningUpdateFrom(event)) };
  }

  if (event.type === "message.presentation_delta") {
    if (
      event.payload.messageId !== checkpoint.assistantMessageId ||
      event.payload.startOffset !== checkpoint.content.length
    ) {
      return { ...checkpoint, presentationCursor: event.presentationCursor };
    }
    const content = checkpoint.content + event.payload.delta;
    return {
      ...checkpoint,
      content,
      parts: appendText(checkpoint.parts, event.payload.delta, event.payload.startOffset),
      presentationCursor: event.presentationCursor,
    };
  }

  const base = { ...checkpoint, cursor: event.cursor };
  switch (event.type) {
    case "run.queued":
      return { ...base, status: "queued" };
    case "run.started":
      return { ...base, status: "running" };
    case "run.cancel_requested":
      return { ...base, isStopping: true };
    case "message.created": {
      if (event.payload.message.id !== checkpoint.assistantMessageId) return base;
      const content = event.payload.message.content;
      return {
        ...base,
        content,
        parts: [
          ...(content
            ? ([
                { id: `text:${event.payload.message.id}:0`, type: "text", text: content },
              ] satisfies ChatPart[])
            : []),
          ...event.payload.message.attachments.map(
            (attachment: AttachmentDto): ChatPart => ({
              id: `attachment:${attachment.id}`,
              type: "attachment",
              attachment,
            }),
          ),
        ],
      };
    }
    case "message.content_updated": {
      if (event.payload.messageId !== checkpoint.assistantMessageId) return base;
      return {
        ...base,
        content: event.payload.content,
        parts: reconcileTextContent(checkpoint.parts, event.payload.content),
      };
    }
    case "tool.started": {
      const { toolCallId, parentToolCallId } = event.payload;
      // A started event repeats after a reconnect; it must not wipe what a refresh already knows.
      const existing = findTool(checkpoint.parts, toolCallId);
      if (existing) return base;
      const started = (idPrefix: string): ToolPart => ({
        id: `${idPrefix}tool:${toolCallId}`,
        type: "tool",
        toolCallId,
        name: event.payload.name,
        ...(event.payload.label ? { label: event.payload.label } : {}),
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        status: "running",
      });
      if (parentToolCallId) {
        const nested = updateTool(checkpoint.parts, parentToolCallId, (parent) => ({
          ...parent,
          children: [...(parent.children ?? []), started(`${parent.id}/`)],
        }));
        if (nested.found) return { ...base, parts: nested.parts };
      }
      return { ...base, parts: [...checkpoint.parts, started("")] };
    }
    case "tool.completed": {
      const { toolCallId, summary } = event.payload;
      const updated = updateTool(checkpoint.parts, toolCallId, (tool) => ({
        ...tool,
        status: "completed",
        state: "output-available",
        ...(summary ? { summary } : {}),
      }));
      return updated.found
        ? { ...base, parts: updated.parts }
        : {
            ...base,
            parts: [
              ...checkpoint.parts,
              {
                id: `tool:${toolCallId}`,
                type: "tool",
                toolCallId,
                name: "tool",
                status: "completed",
                ...(summary ? { summary } : {}),
              },
            ],
          };
    }
    case "tool.failed": {
      const { toolCallId, message } = event.payload;
      const updated = updateTool(checkpoint.parts, toolCallId, (tool) => ({
        ...tool,
        status: "failed",
        state: "output-error",
        error: message,
      }));
      return updated.found
        ? { ...base, parts: updated.parts }
        : {
            ...base,
            parts: [
              ...checkpoint.parts,
              {
                id: `tool:${toolCallId}`,
                type: "tool",
                toolCallId,
                name: "tool",
                status: "failed",
                error: message,
              },
            ],
          };
    }
    case "approval.requested":
      return {
        ...base,
        status: "paused",
        parts: replacePart(
          checkpoint.parts,
          (part) => part.type === "approval" && part.approvalId === event.payload.approvalId,
          {
            id: `approval:${event.payload.approvalId}`,
            type: "approval",
            approvalId: event.payload.approvalId,
            ...(event.payload.toolCallId ? { toolCallId: event.payload.toolCallId } : {}),
            kind: event.payload.kind,
            prompt: event.payload.prompt,
            options: event.payload.options ?? [],
            ...(event.payload.input ? { input: event.payload.input } : {}),
            status: "pending",
          },
        ),
      };
    case "approval.resolved":
      return {
        ...base,
        parts: checkpoint.parts.map((part) =>
          part.type === "approval" && part.approvalId === event.payload.approvalId
            ? { ...part, status: "resolved", resolution: event.payload.resolution }
            : part,
        ),
      };
    case "artifact.published":
      return {
        ...base,
        parts: replacePart(
          checkpoint.parts,
          (part) => part.type === "artifact" && part.artifactId === event.payload.artifactId,
          { id: `artifact:${event.payload.artifactId}`, type: "artifact", ...event.payload },
        ),
      };
    case "run.paused":
      return { ...base, status: "paused" };
    case "run.completed":
      return { ...base, status: "completed", isStopping: false };
    case "run.failed":
      return {
        ...base,
        status: "failed",
        isStopping: false,
        parts: [
          ...checkpoint.parts,
          {
            id: `notice:${event.id}`,
            type: "notice",
            message: event.payload.message,
            kind: "error",
          },
        ],
      };
    case "run.canceled":
      return { ...base, status: "canceled", isStopping: false };
  }
  return base;
};
