import { throwIfAborted } from "@/shared/lib/abort";
import { queryClient } from "@/shared/lib/query-client";
import {
  type ChatPartition,
  getConversationRunCheckpoint,
  listQueuedRunMessageIds,
} from "./chat-store";

const root = (partition: ChatPartition) =>
  ["chat", partition.userId, partition.workspaceId] as const;
export const chatQueryKeys = {
  conversations: (partition: ChatPartition) => [...root(partition), "conversations"] as const,
  messages: (partition: ChatPartition, id: string) => [...root(partition), "messages", id] as const,
  pendingMessage: (partition: ChatPartition, id: string) =>
    [...root(partition), "messages", id, "pending"] as const,
  draft: (partition: ChatPartition, id: string) => [...root(partition), "draft", id] as const,
  run: (partition: ChatPartition, id: string) => [...root(partition), "run", id] as const,
  // Kept outside `messages` so the invalidation a sync ends with does not restart the sync.
  transcriptSync: (partition: ChatPartition, id: string) =>
    [...root(partition), "transcript-sync", id] as const,
};

export async function invalidateConversation(partition: ChatPartition, id: string): Promise<void> {
  throwIfAborted(partition.signal);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.messages(partition, id) }),
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.run(partition, id) }),
  ]);
}

/** The Run working in a conversation, if any, and the Task replies queued behind it. */
export const runStateQueryOptions = (partition: ChatPartition | null, id: string) => ({
  queryKey: partition ? chatQueryKeys.run(partition, id) : ["chat", "run", "signed-out"],
  queryFn: async () => ({
    active: await getConversationRunCheckpoint(partition!, id),
    queuedMessageIds: await listQueuedRunMessageIds(partition!, id),
  }),
  enabled: Boolean(partition),
});
