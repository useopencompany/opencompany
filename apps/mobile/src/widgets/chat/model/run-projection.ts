import type { RunStreamEventDto } from "@opencompany/protocol/events";
import type { AttachmentDto } from "@opencompany/protocol/schemas";
import type { ChatPart } from "./chat";
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

const textParts = (parts: ChatPart[], content: string): ChatPart[] => [
  { type: "text", text: content },
  ...parts.filter((part) => part.type !== "text"),
];

export const projectRunEvent = (
  checkpoint: RunCheckpoint,
  event: RunStreamEventDto,
): RunCheckpoint => {
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
      parts: textParts(checkpoint.parts, content),
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
          ...(content ? ([{ type: "text", text: content }] satisfies ChatPart[]) : []),
          ...event.payload.message.attachments.map(
            (attachment: AttachmentDto): ChatPart => ({ type: "attachment", attachment }),
          ),
        ],
      };
    }
    case "message.content_updated": {
      if (event.payload.messageId !== checkpoint.assistantMessageId) return base;
      return {
        ...base,
        content: event.payload.content,
        parts: textParts(checkpoint.parts, event.payload.content),
      };
    }
    case "tool.started":
      return {
        ...base,
        parts: replacePart(
          checkpoint.parts,
          (part) => part.type === "tool" && part.toolCallId === event.payload.toolCallId,
          {
            type: "tool",
            toolCallId: event.payload.toolCallId,
            name: event.payload.name,
            ...(event.payload.label ? { label: event.payload.label } : {}),
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            status: "running",
          },
        ),
      };
    case "tool.completed": {
      const existing = checkpoint.parts.find(
        (part) => part.type === "tool" && part.toolCallId === event.payload.toolCallId,
      );
      return {
        ...base,
        parts: replacePart(
          checkpoint.parts,
          (part) => part.type === "tool" && part.toolCallId === event.payload.toolCallId,
          {
            type: "tool",
            toolCallId: event.payload.toolCallId,
            name: existing?.type === "tool" ? existing.name : "Tool",
            status: "completed",
            ...(event.payload.summary ? { summary: event.payload.summary } : {}),
          },
        ),
      };
    }
    case "tool.failed": {
      const existing = checkpoint.parts.find(
        (part) => part.type === "tool" && part.toolCallId === event.payload.toolCallId,
      );
      return {
        ...base,
        parts: replacePart(
          checkpoint.parts,
          (part) => part.type === "tool" && part.toolCallId === event.payload.toolCallId,
          {
            type: "tool",
            toolCallId: event.payload.toolCallId,
            name: existing?.type === "tool" ? existing.name : "Tool",
            status: "failed",
            error: event.payload.message,
          },
        ),
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
            type: "approval",
            approvalId: event.payload.approvalId,
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
          { type: "artifact", ...event.payload },
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
        parts: [...checkpoint.parts, { type: "notice", message: event.payload.message }],
      };
    case "run.canceled":
      return { ...base, status: "canceled", isStopping: false };
  }
  return base;
};
