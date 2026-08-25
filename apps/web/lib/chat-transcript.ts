import type { ChatUiMessage } from "@/lib/chat-ui";
import { nestHeadlessToolParts } from "./headless-chat-ui-projector";

type ComposeChatTranscriptInput = {
  persistedMessages: readonly ChatUiMessage[];
  transientMessages: readonly ChatUiMessage[];
  streaming: boolean;
};

/**
 * Composes the durable transcript with the active useChat projection.
 *
 * Electric owns persisted message structure. The transient projection may only
 * add optimistic messages or append content from the currently streaming
 * assistant message; it must never replace durable reasoning or tool parts.
 */
export function composeChatTranscript({
  persistedMessages,
  transientMessages,
  streaming,
}: ComposeChatTranscriptInput): ChatUiMessage[] {
  const nestedTransientMessages = transientMessages.map(nestHeadlessToolParts);
  if (persistedMessages.length === 0) return nestedTransientMessages;

  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const transientOnly = nestedTransientMessages.filter((message) => !persistedIds.has(message.id));
  const latestTransientAssistant = streaming
    ? nestedTransientMessages.findLast((message) => message.role === "assistant")
    : undefined;
  const activeAssistant =
    latestTransientAssistant && persistedIds.has(latestTransientAssistant.id)
      ? latestTransientAssistant
      : undefined;
  const persisted = activeAssistant
    ? persistedMessages.map((message) =>
        message.id === activeAssistant.id
          ? augmentPersistedMessage(message, activeAssistant)
          : message,
      )
    : [...persistedMessages];

  return transientOnly.length > 0 ? [...persisted, ...transientOnly] : persisted;
}

function augmentPersistedMessage(
  persisted: ChatUiMessage,
  transient: ChatUiMessage,
): ChatUiMessage {
  const persistedText = textFromParts(persisted.parts);
  const transientText = textFromParts(transient.parts);
  const canAppendText = transientText.startsWith(persistedText);
  let persistedTextRemaining = persistedText.length;
  const persistedToolCallIds = new Set(
    persisted.parts.map(toolCallId).filter((id): id is string => Boolean(id)),
  );
  const additions: ChatUiMessage["parts"] = [];
  const replacements = new Map<string, ChatUiMessage["parts"][number]>();

  for (const part of transient.parts) {
    if (part.type === "text") {
      if (!canAppendText) continue;
      const consumed = Math.min(persistedTextRemaining, part.text.length);
      persistedTextRemaining -= consumed;
      const suffix = part.text.slice(consumed);
      if (suffix) additions.push({ ...part, text: suffix });
      continue;
    }

    const id = toolCallId(part);
    if (id && !persistedToolCallIds.has(id)) {
      additions.push(part);
      persistedToolCallIds.add(id);
      continue;
    }
    if (id) {
      const persistedPart = persisted.parts.find((candidate) => toolCallId(candidate) === id);
      if (!persistedPart) continue;
      const merged = mergeTransientChildren(persistedPart, part);
      if (merged !== persistedPart) replacements.set(id, merged);
    }
  }

  if (additions.length === 0 && replacements.size === 0) return persisted;
  return {
    ...transient,
    ...persisted,
    metadata: { ...transient.metadata, ...persisted.metadata },
    parts: [
      ...persisted.parts.map((part) => {
        const id = toolCallId(part);
        return id ? (replacements.get(id) ?? part) : part;
      }),
      ...additions,
    ],
  };
}

function mergeTransientChildren(
  persisted: ChatUiMessage["parts"][number],
  transient: ChatUiMessage["parts"][number],
) {
  const persistedRecord = persisted as unknown as Record<string, unknown>;
  const transientRecord = transient as unknown as Record<string, unknown>;
  if (!Array.isArray(transientRecord.children)) return persisted;
  const transientChildren = transientRecord.children as ChatUiMessage["parts"];
  const existingChildren = Array.isArray(persistedRecord.children)
    ? (persistedRecord.children as ChatUiMessage["parts"])
    : [];
  const existingIds = new Set(
    existingChildren.map(toolCallId).filter((id): id is string => Boolean(id)),
  );
  const additions = transientChildren.filter((part) => {
    const id = toolCallId(part);
    return !id || !existingIds.has(id);
  });
  if (additions.length === 0) return persisted;
  return {
    ...persistedRecord,
    children: [...existingChildren, ...additions],
  } as unknown as typeof persisted;
}

function textFromParts(parts: ChatUiMessage["parts"]) {
  return parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> =>
      Boolean(part && part.type === "text"),
    )
    .map((part) => part.text)
    .join("");
}

function toolCallId(part: ChatUiMessage["parts"][number]) {
  return "toolCallId" in part && typeof part.toolCallId === "string" ? part.toolCallId : null;
}
