import type {
  JsonValue,
  TiptapDoc,
  TiptapMark,
  TiptapNode,
} from "@opencompany/agent-runtime/types";

export type { TiptapNode } from "@opencompany/agent-runtime/types";

export type SanitizeTiptapOptions = {
  // Invoked whenever a mention node is dropped because it lacks renderable
  // attrs. The node carries no recoverable token text, so dropping stays
  // correct — but the save path passes this to log the loss instead of letting
  // it happen silently (read paths leave it unset and stay quiet).
  onDroppedMention?: (node: Record<string, unknown>) => void;
};

export function sanitizeTiptapDoc(value: unknown, options?: SanitizeTiptapOptions): TiptapDoc {
  const doc = asRecord(value);
  if (!doc || doc.type !== "doc") {
    return { type: "doc", content: [] };
  }

  const content = sanitizeContent(doc.content, options);
  return content.length > 0 ? { type: "doc", content } : { type: "doc", content: [] };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
  } catch {
    return null;
  }

  return value as Record<string, unknown>;
}

function sanitizeContent(value: unknown, options?: SanitizeTiptapOptions): TiptapNode[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeNode(item, options))
    .filter((node): node is TiptapNode => Boolean(node));
}

function sanitizeNode(value: unknown, options?: SanitizeTiptapOptions): TiptapNode | null {
  const node = asRecord(value);
  const type = typeof node?.type === "string" ? node.type : null;
  if (!node || !type) return null;

  if (type === "mention" && !hasRenderableMentionAttrs(node.attrs)) {
    options?.onDroppedMention?.(node);
    return null;
  }

  const out: TiptapNode = { type };

  if (typeof node.text === "string") {
    out.text = node.text;
  }

  const attrs = sanitizeAttrs(node.attrs);
  if (attrs) {
    out.attrs = attrs;
  }

  const marks = sanitizeMarks(node.marks);
  if (marks.length > 0) {
    out.marks = marks;
  }

  const content = sanitizeContent(node.content, options);
  if (content.length > 0) {
    out.content = content;
  }

  return out;
}

function hasRenderableMentionAttrs(value: unknown) {
  const attrs = asRecord(value);
  if (!attrs) return false;

  return hasNonEmptyString(attrs.id) || hasNonEmptyString(attrs.label);
}

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeMarks(value: unknown): TiptapMark[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    const mark = asRecord(item);
    if (typeof mark?.type !== "string") return [];

    const out: TiptapMark = { type: mark.type };
    const attrs = sanitizeAttrs(mark.attrs);
    if (attrs) out.attrs = attrs;
    return [out];
  });
}

function sanitizeAttrs(value: unknown): Record<string, JsonValue> | undefined {
  const attrs = asRecord(value);
  if (!attrs) return undefined;

  const clean: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(attrs)) {
    const value = sanitizeJsonValue(item);
    if (value !== undefined) clean[key] = value;
  }

  return Object.keys(clean).length > 0 ? clean : undefined;
}

function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(sanitizeJsonValue)
      .filter((item): item is JsonValue => item !== undefined);
    return items;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const clean: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const value = sanitizeJsonValue(item);
    if (value !== undefined) clean[key] = value;
  }

  return clean;
}
