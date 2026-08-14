import type { GoatChatUiMessage } from "@/lib/chat-ui";

type ComposeChatTranscriptInput = {
  persistedMessages: readonly GoatChatUiMessage[];
  transientMessages: readonly GoatChatUiMessage[];
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
}: ComposeChatTranscriptInput): GoatChatUiMessage[] {
  if (persistedMessages.length === 0) return [...transientMessages];

  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const transientOnly = transientMessages.filter((message) => !persistedIds.has(message.id));
  const latestTransientAssistant = streaming
    ? transientMessages.findLast((message) => message.role === "assistant")
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
  persisted: GoatChatUiMessage,
  transient: GoatChatUiMessage,
): GoatChatUiMessage {
  const persistedText = textFromParts(persisted.parts);
  const transientText = textFromParts(transient.parts);
  const canAppendText = transientText.startsWith(persistedText);
  let persistedTextRemaining = persistedText.length;
  const persistedToolCallIds = new Set(
    persisted.parts.map(toolCallId).filter((id): id is string => Boolean(id)),
  );
  const additions: GoatChatUiMessage["parts"] = [];

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
    }
  }

  if (additions.length === 0) return persisted;
  return {
    ...transient,
    ...persisted,
    metadata: { ...transient.metadata, ...persisted.metadata },
    parts: [...persisted.parts, ...additions],
  };
}

function textFromParts(parts: GoatChatUiMessage["parts"]) {
  return parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> =>
      Boolean(part && part.type === "text"),
    )
    .map((part) => part.text)
    .join("");
}

function toolCallId(part: GoatChatUiMessage["parts"][number]) {
  return "toolCallId" in part && typeof part.toolCallId === "string" ? part.toolCallId : null;
}
