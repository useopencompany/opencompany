import { throwIfAborted } from "@/shared/lib/abort";
import { queryClient } from "@/shared/lib/query-client";
import type { ChatPartition } from "./chat-store";

const root = (partition: ChatPartition) =>
  ["chat", partition.userId, partition.workspaceId] as const;
export const chatQueryKeys = {
  conversations: (partition: ChatPartition) => [...root(partition), "conversations"] as const,
  messages: (partition: ChatPartition, id: string) => [...root(partition), "messages", id] as const,
  draft: (partition: ChatPartition, id: string) => [...root(partition), "draft", id] as const,
  run: (partition: ChatPartition, id: string) => [...root(partition), "run", id] as const,
};

export async function invalidateConversation(partition: ChatPartition, id: string): Promise<void> {
  throwIfAborted(partition.signal);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.messages(partition, id) }),
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.run(partition, id) }),
  ]);
}
