import { useQuery } from "@tanstack/react-query";
import { useChatCoordinator } from "./chat-coordinator";
import { chatQueryKeys, runStateQueryOptions } from "./chat-queries";
import { getPendingMessageCommand, NEW_CHAT_ID } from "./chat-store";

/** A message is on its way or a Run is working, so engine settings wait until it settles. */
export function useConversationWorking(conversationId: string): boolean {
  const { partition, pendingSends } = useChatCoordinator();
  const enabled = Boolean(partition) && conversationId !== NEW_CHAT_ID;
  const run = useQuery({ ...runStateQueryOptions(partition, conversationId), enabled });
  const pendingMessage = useQuery({
    queryKey: partition
      ? chatQueryKeys.pendingMessage(partition, conversationId)
      : ["chat", "pending-message", "signed-out"],
    queryFn: () => getPendingMessageCommand(partition!, conversationId),
    enabled,
  });
  const status = run.data?.active?.status;
  return Boolean(
    pendingSends[conversationId] ||
      pendingMessage.data ||
      status === "queued" ||
      status === "running" ||
      status === "paused",
  );
}
