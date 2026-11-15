import type {
  ApprovalPart,
  ArtifactPart,
  AttachmentPart,
  ChatPart,
  NoticePart,
  ReasoningPart,
  SteeringPart,
  ToolPart,
} from "./chat";
import { isOutputTool, isSubagentTool } from "./tool-presentation";

export type ActivityItem =
  | { type: "text"; key: string; text: string }
  | { type: "reasoning"; key: string; part: ReasoningPart }
  | { type: "steering"; key: string; part: SteeringPart }
  | { type: "tool"; key: string; part: ToolPart; children: ActivityItem[] }
  | { type: "approval"; key: string; part: ApprovalPart }
  | { type: "artifact"; key: string; part: ArtifactPart }
  | { type: "attachment"; key: string; part: AttachmentPart }
  | { type: "notice"; key: string; part: NoticePart };

/**
 * Folds a message's parts into the items the transcript renders, in order. Adjacent text joins
 * into one message unless the engine marked the pieces as separate items, matching the web
 * transcript. In a settled turn, a tool that never finished reads as stopped.
 */
export const activityItems = (
  parts: readonly ChatPart[],
  { settled, keepEmptyNotices }: { settled: boolean; keepEmptyNotices: boolean },
): ActivityItem[] => {
  const items: ActivityItem[] = [];
  let text: { key: string; text: string; itemId: string | undefined } | null = null;
  const flushText = () => {
    if (text?.text.trim()) items.push({ type: "text", key: text.key, text: text.text });
    text = null;
  };
  for (const part of parts) {
    if (part.type === "text") {
      if (text && part.itemId && text.itemId && part.itemId !== text.itemId) flushText();
      if (text) {
        text.text += part.text;
        text.itemId ??= part.itemId;
      } else text = { key: part.id, text: part.text, itemId: part.itemId };
      continue;
    }
    if (part.type === "reasoning" && !part.text.trim()) continue;
    if (part.type === "notice" && part.kind !== "error" && !keepEmptyNotices) continue;
    flushText();
    if (part.type === "tool") {
      const tool: ToolPart =
        settled && (part.status === "running" || part.status === "waiting")
          ? { ...part, status: "interrupted" }
          : part;
      items.push({
        type: "tool",
        key: part.id,
        part: tool,
        children: part.children
          ? activityItems(part.children, { settled, keepEmptyNotices: false })
          : [],
      });
      continue;
    }
    items.push({ type: part.type, key: part.id, part } as ActivityItem);
  }
  flushText();
  return items;
};

export interface CompactedActivity {
  hidden: ActivityItem[];
  visible: ActivityItem[];
  summary: string;
}

const hasUnresolvedWork = (item: ActivityItem): boolean => {
  if (item.type === "approval") return item.part.status !== "resolved";
  if (item.type !== "tool") return false;
  if (item.part.status === "running" || item.part.status === "waiting") return true;
  return item.children.some(hasUnresolvedWork);
};

const countActivity = (items: readonly ActivityItem[]) => {
  let messages = 0;
  let toolCalls = 0;
  for (const item of items) {
    if (item.type === "text" || item.type === "reasoning") messages += 1;
    if (item.type !== "tool") continue;
    toolCalls += 1;
    if (!isSubagentTool(item.part)) continue;
    const nested = countActivity(item.children);
    messages += nested.messages;
    toolCalls += nested.toolCalls;
  }
  return { messages, toolCalls };
};

const plural = (count: number, singular: string, pluralForm: string) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * Splits a resting turn into the trace folded behind its disclosure and what stays visible: the
 * final answer plus outputs the reader acts on, in their original order. Mirrors
 * `compactAssistantTrace` in the web transcript. Returns null when the turn stays expanded: it
 * has unresolved work, no final answer, or nothing to fold.
 */
export const compactActivity = (items: readonly ActivityItem[]): CompactedActivity | null => {
  if (items.some(hasUnresolvedWork)) return null;
  const finalTextIndex = items.findLastIndex((item) => item.type === "text");
  if (finalTextIndex < 0) return null;
  const hidden: ActivityItem[] = [];
  const visible: ActivityItem[] = [];
  for (const [index, item] of items.entries()) {
    const staysVisible =
      index === finalTextIndex ||
      item.type === "artifact" ||
      item.type === "attachment" ||
      item.type === "steering" ||
      item.type === "approval" ||
      item.type === "notice" ||
      (item.type === "tool" && isOutputTool(item.part));
    (staysVisible ? visible : hidden).push(item);
  }
  if (hidden.length === 0) return null;
  const { messages, toolCalls } = countActivity(hidden);
  const summary = [
    toolCalls > 0 ? plural(toolCalls, "tool call", "tool calls") : null,
    messages > 0 ? plural(messages, "message", "messages") : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { hidden, visible, summary };
};
