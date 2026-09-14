import type { ChatUiMessage } from "@/lib/chat-ui";
import type { HeadlessChatRunReadModel } from "@/lib/headless-chat-collections";

// A message the user sent while a coding turn was already running. It is a real durable Run, so it
// starts on its own as soon as the running turn finishes; until then it can be steered into that
// turn or dropped. It renders above the composer rather than in the transcript, because nothing
// has happened to it yet.
export type QueuedChatMessage = {
  runId: string;
  text: string;
};

type QueuedMessagesInput = {
  runs: ReadonlyMap<string, HeadlessChatRunReadModel>;
  messages: readonly ChatUiMessage[];
};

export function queuedChatMessages(input: QueuedMessagesInput): QueuedChatMessage[] {
  const textByMessageId = new Map(
    input.messages.map((message) => [message.id, chatMessageText(message)] as const),
  );
  return [...input.runs.values()]
    .filter((run) => run.status === "queued")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((run) => ({ runId: run.id, text: textByMessageId.get(run.triggerMessageId) ?? "" }))
    .filter((queued) => queued.text.length > 0);
}

// Messages belonging to a Run that never executed: still waiting (it renders as a card instead) or
// removed from the queue before it could start, by the trash action or by being steered into the
// running turn. Either way the transcript has nothing to show for it.
export function pendingRunMessageIds(input: QueuedMessagesInput): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const run of input.runs.values()) {
    if (run.attemptCount > 0) continue;
    if (run.status !== "queued" && run.status !== "canceled") continue;
    ids.add(run.triggerMessageId);
    ids.add(run.assistantMessageId);
  }
  return ids;
}

function chatMessageText(message: ChatUiMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}
