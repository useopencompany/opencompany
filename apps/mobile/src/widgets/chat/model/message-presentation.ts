import type { ChatPart, ReasoningPart, ToolPart, ToolStatus } from "./chat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
};

// Envelope fields that name a tool invocation. Arguments live in `input` and never take part.
const IDENTITY_KEYS = ["title", "kind", "server", "tool", "label", "detail", "description"];

// Coding-engine item parts report their outcome inside the output rather than the part state.
const OUTCOME_IN_OUTPUT_TOOLS = new Set([
  "codex_command",
  "codex_file_change",
  "codex_mcp_tool",
  "codex_web_search",
  "codex_subagent",
]);

const toolStatus = (name: string, value: Record<string, unknown>): ToolStatus => {
  const state = typeof value.state === "string" ? value.state : "";
  const approval = isRecord(value.approval) ? value.approval : undefined;
  if (state === "output-denied") return "denied";
  if (state === "approval-responded" && approval?.approved === false) return "denied";
  if (state === "output-error") return "failed";
  if (state === "approval-requested" || state === "approval-responded") return "waiting";
  if (state !== "output-available") return "running";
  const output = isRecord(value.output) ? value.output : undefined;
  if (output?.ok === false) {
    // A connected action that needs the user's approval is waiting on them, not failing.
    return recordString(output.error, "code") === "approval_required" ? "waiting" : "failed";
  }
  if (OUTCOME_IN_OUTPUT_TOOLS.has(name)) {
    if (output?.status === "failed") return "failed";
    if (output?.status === "interrupted") return "interrupted";
  }
  return "completed";
};

const printable = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  const preferred = ["summary", "message", "status", "command", "prompt", "name"];
  for (const key of preferred) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
};

const toolError = (value: Record<string, unknown>): string | undefined => {
  if (typeof value.errorText === "string" && value.errorText) return value.errorText;
  const approval = isRecord(value.approval) ? value.approval : undefined;
  if (approval?.approved === false) {
    return typeof approval.reason === "string" && approval.reason
      ? approval.reason
      : "The action was declined.";
  }
  const output = isRecord(value.output) ? value.output : undefined;
  if (output?.ok === false) {
    return typeof output.error === "string"
      ? output.error
      : (recordString(output.error, "message") ?? undefined);
  }
  return recordString(output, "error");
};

const toolPartFrom = (
  value: Record<string, unknown> & { type: string; toolCallId: string },
  id: string,
  sourceIndex: number,
  children: ChatPart[] | undefined,
): ToolPart => {
  const name =
    value.type === "dynamic-tool"
      ? (recordString(value, "toolName") ?? "tool")
      : value.type.replace(/^tool-/u, "");
  const status = toolStatus(name, value);
  const metadata = Object.fromEntries(
    IDENTITY_KEYS.flatMap((key) => (key in value ? [[key, value[key]]] : [])),
  );
  if (value.type !== "dynamic-tool" && typeof value.toolName === "string")
    metadata.toolName = value.toolName;
  const error = status === "failed" || status === "denied" ? toolError(value) : undefined;
  return {
    id,
    type: "tool",
    toolCallId: value.toolCallId,
    name,
    status,
    sourceIndex,
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    // Keep the complete payloads: the detail sheet shows them as they were sent.
    ...("input" in value ? { input: value.input } : {}),
    ...("output" in value ? { output: value.output } : {}),
    ...(status === "completed" && printable(value.output)
      ? { summary: printable(value.output) }
      : {}),
    ...(error ? { error } : {}),
    ...(children ? { children } : {}),
  };
};

/**
 * Folds a presentation's parts into ordered chat parts. Nested subagent traces recurse with a
 * prefix, so every part keeps an identity that is unique within the message and stable across
 * refreshes, including historical reasoning that predates persisted reasoning ids.
 */
const partsFromPresentation = (
  rawParts: readonly unknown[],
  messageId: string,
  prefix: string,
  topLevel: boolean,
): ChatPart[] => {
  const parts: ChatPart[] = [];
  for (const [index, value] of rawParts.entries()) {
    if (!isRecord(value) || typeof value.type !== "string") continue;
    if (value.type === "text" && typeof value.text === "string") {
      const itemId = typeof value.itemId === "string" ? value.itemId : undefined;
      parts.push({
        id: itemId ? `${prefix}text:${itemId}` : `${prefix}text:${messageId}:${index}`,
        type: "text",
        text: value.text,
        ...(itemId ? { itemId } : {}),
      });
      continue;
    }
    if (value.type === "reasoning" && typeof value.text === "string") {
      const itemId =
        typeof value.itemId === "string" && value.itemId
          ? value.itemId
          : `${messageId}:${prefix}${index}`;
      parts.push({
        id: `${prefix}reasoning:${itemId}`,
        type: "reasoning",
        itemId,
        text: value.text,
        streaming: value.state === "streaming",
        sourceIndex: index,
      } satisfies ReasoningPart);
      continue;
    }
    if (value.type === "data-steering" && isRecord(value.data)) {
      const text = recordString(value.data, "text");
      if (!text?.trim()) continue;
      const itemId = recordString(value.data, "itemId");
      parts.push({
        id: `${prefix}steering:${itemId ?? `${messageId}:${index}`}`,
        type: "steering",
        text,
        sourceIndex: index,
      });
      continue;
    }
    if (value.type === "data-artifact-file" && isRecord(value.data)) {
      const data = value.data;
      if (
        typeof data.artifactId === "string" &&
        typeof data.title === "string" &&
        typeof data.filename === "string" &&
        typeof data.mediaType === "string" &&
        typeof data.sizeBytes === "number"
      ) {
        parts.push({
          id: `${prefix}artifact:${data.artifactId}`,
          type: "artifact",
          artifactId: data.artifactId,
          title: data.title,
          filename: data.filename,
          mediaType: data.mediaType,
          sizeBytes: data.sizeBytes,
        });
      }
      continue;
    }
    if (!(value.type === "dynamic-tool" || value.type.startsWith("tool-"))) continue;
    if (typeof value.toolCallId !== "string") continue;
    const tool = value as Record<string, unknown> & { type: string; toolCallId: string };
    const input = isRecord(value.input) ? value.input : undefined;
    const approval = isRecord(value.approval) ? value.approval : undefined;
    // Only the turn itself can raise an approval the reader answers; a subagent cannot.
    if (topLevel && value.state === "approval-requested" && typeof approval?.id === "string") {
      parts.push({
        id: `approval:${approval.id}`,
        type: "approval",
        approvalId: approval.id,
        toolCallId: tool.toolCallId,
        kind: value.type,
        prompt: printable(input) ?? `Allow ${recordString(input, "action") ?? "this action"}?`,
        options: [],
        ...(input ? { input } : {}),
        status: "pending",
      });
      continue;
    }
    const id = `${prefix}tool:${tool.toolCallId}`;
    const children = Array.isArray(value.children)
      ? partsFromPresentation(value.children, messageId, `${id}/`, false)
      : undefined;
    parts.push(toolPartFrom(tool, id, index, children));
  }
  return parts;
};

export const orderedPartsFromPresentation = ({
  content,
  messageId,
  presentation,
}: {
  content: string;
  messageId: string;
  presentation: Record<string, unknown> | null;
}): ChatPart[] => {
  const rawParts = presentation?.uiMessageParts;
  if (!Array.isArray(rawParts)) {
    return content ? [{ id: `text:${messageId}:0`, type: "text", text: content }] : [];
  }
  const parts = partsFromPresentation(rawParts, messageId, "", true);
  if (!parts.some((part) => part.type === "text") && content) {
    parts.push({ id: `text:${messageId}:fallback`, type: "text", text: content });
  }
  return parts;
};

export const textFromParts = (parts: ChatPart[]): string =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** Finds a part by identity anywhere in a message, including inside subagent traces. */
export const findPart = (parts: readonly ChatPart[], id: string): ChatPart | undefined => {
  for (const part of parts) {
    if (part.id === id) return part;
    if (part.type === "tool" && part.children) {
      const nested = findPart(part.children, id);
      if (nested) return nested;
    }
  }
  return undefined;
};
