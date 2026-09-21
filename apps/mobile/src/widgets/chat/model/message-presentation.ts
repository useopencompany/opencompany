import type { ChatPart } from "./chat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
};

const toolStatus = (state: unknown): "running" | "completed" | "failed" => {
  if (state === "output-error" || state === "output-denied") return "failed";
  if (state === "output-available") return "completed";
  return "running";
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

  const parts: ChatPart[] = [];
  for (const [index, value] of rawParts.entries()) {
    if (!isRecord(value) || typeof value.type !== "string") continue;
    if (value.type === "text" && typeof value.text === "string") {
      parts.push({
        id:
          typeof value.itemId === "string" ? `text:${value.itemId}` : `text:${messageId}:${index}`,
        type: "text",
        text: value.text,
      });
      continue;
    }
    if (value.type === "reasoning" && typeof value.text === "string") {
      parts.push({ id: `notice:${messageId}:${index}`, type: "notice", message: value.text });
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
          id: `artifact:${data.artifactId}`,
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
    const input = isRecord(value.input) ? value.input : undefined;
    const approval = isRecord(value.approval) ? value.approval : undefined;
    if (value.state === "approval-requested" && typeof approval?.id === "string") {
      parts.push({
        id: `approval:${approval.id}`,
        type: "approval",
        approvalId: approval.id,
        toolCallId: value.toolCallId,
        kind: value.type,
        prompt: printable(input) ?? `Allow ${recordString(input, "action") ?? "this action"}?`,
        options: [],
        ...(input ? { input } : {}),
        status: "pending",
      });
      continue;
    }
    const status = toolStatus(value.state);
    const name = value.type === "dynamic-tool" ? recordString(value, "toolName") : undefined;
    parts.push({
      id: `tool:${value.toolCallId}`,
      type: "tool",
      toolCallId: value.toolCallId,
      name: name ?? value.type.replace(/^tool-/u, "").replaceAll("-", " "),
      ...(recordString(input, "name") ? { label: recordString(input, "name") } : {}),
      ...(printable(input) ? { detail: printable(input) } : {}),
      status,
      ...(status === "completed" && printable(value.output)
        ? { summary: printable(value.output) }
        : {}),
      ...(status === "failed"
        ? { error: printable(value.errorText) ?? printable(value.output) ?? "The tool failed." }
        : {}),
    });
  }

  if (!parts.some((part) => part.type === "text") && content) {
    parts.push({ id: `text:${messageId}:fallback`, type: "text", text: content });
  }
  return parts;
};

export const textFromParts = (parts: ChatPart[]): string =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
