import type { ResolveApprovalBody } from "@opencompany/protocol/schemas";
import * as Network from "expo-network";
import { router } from "expo-router";
import { createContext, type ReactNode, use, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/features/auth";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import type { ConnectivityState } from "./chat";
import { registerChatAbortHandler } from "./chat-lifecycle";
import { chatQueryKeys, invalidateConversation } from "./chat-queries";
import { createChatSession } from "./chat-session";
import {
  type ChatPartition,
  queueApprovalCommand,
  queueMessageFromDraft,
  queueStopCommand,
} from "./chat-store";

export { chatQueryKeys } from "./chat-queries";

interface ChatCoordinatorValue {
  partition: ChatPartition | null;
  connectivity: ConnectivityState;
  setVisibleConversation: (id: string | null) => void;
  sendDraft: (id: string) => Promise<string>;
  stopRun: (id: string, runId: string) => Promise<void>;
  resolveApproval: (
    id: string,
    runId: string,
    approvalId: string,
    body: ResolveApprovalBody,
  ) => Promise<void>;
  refreshConversations: () => Promise<void>;
}
const ChatCoordinatorContext = createContext<ChatCoordinatorValue | null>(null);

export function ChatCoordinatorProvider({ children }: { children: ReactNode }) {
  const { user, workspace } = useAuth();
  return <ChatSessionProvider key={`${user?.id}:${workspace?.id}`}>{children}</ChatSessionProvider>;
}

function ChatSessionProvider({ children }: { children: ReactNode }) {
  const { api, user, workspace } = useAuth();
  const { showErrorToast } = useToast();
  const [connectivity, setConnectivity] = useState<ConnectivityState>("online");
  const [online, setOnline] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const makeSession = () =>
    user && workspace
      ? createChatSession({
          userId: user.id,
          workspaceId: workspace.id,
          api,
          onConnectivity: setConnectivity,
          onError: showErrorToast,
        })
      : null;
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<ReturnType<typeof createChatSession> | null>(null);
  useEffect(() => {
    const current = makeSession();
    setSession(current);
    return () => current?.dispose();
  }, [generation]);
  const partition = session?.partition ?? null;

  useEffect(
    () =>
      registerChatAbortHandler(
        () => {
          session?.dispose();
          setSession(null);
        },
        () => setGeneration((value) => value + 1),
      ),
    [session],
  );

  useEffect(() => {
    let mounted = true;
    const receiveNetwork = (state: Network.NetworkState) => {
      if (mounted) setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    };
    void Network.getNetworkStateAsync().then(receiveNetwork, (error: unknown) => {
      if (mounted)
        showErrorToast("The network state could not be read.", error, "chat.network.state");
    });
    const network = Network.addNetworkStateListener(receiveNetwork);
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => {
      mounted = false;
      network.remove();
      app.remove();
    };
  }, []);

  useEffect(() => {
    if (online && foreground) session?.start();
    else session?.pause();
    return () => session?.pause();
  }, [session, online, foreground]);
  useEffect(() => {
    session?.setVisibleConversation(visibleId);
  }, [session, visibleId]);

  const sendDraft = async (id: string): Promise<string> => {
    if (!partition) throw new Error("Choose a workspace before sending a message.");
    const queued = await queueMessageFromDraft(partition, id);
    await invalidateConversation(partition, queued.conversationId);
    await queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
    if (id !== queued.conversationId)
      router.replace({ pathname: "/chats/[chatId]", params: { chatId: queued.conversationId } });
    session?.drain();
    return queued.conversationId;
  };
  const stopRun = async (id: string, runId: string): Promise<void> => {
    if (!partition) return;
    await queueStopCommand(partition, id, runId);
    await invalidateConversation(partition, id);
    session?.drain();
  };
  const resolveApproval = async (
    id: string,
    runId: string,
    approvalId: string,
    body: ResolveApprovalBody,
  ): Promise<void> => {
    if (!partition) return;
    await queueApprovalCommand(partition, id, runId, approvalId, body);
    await invalidateConversation(partition, id);
    session?.drain();
  };
  return (
    <ChatCoordinatorContext
      value={{
        partition,
        connectivity: online ? connectivity : "offline",
        setVisibleConversation: setVisibleId,
        sendDraft,
        stopRun,
        resolveApproval,
        refreshConversations: async () => {
          await session?.refreshConversations();
        },
      }}
    >
      {children}
    </ChatCoordinatorContext>
  );
}

export function useChatCoordinator(): ChatCoordinatorValue {
  const context = use(ChatCoordinatorContext);
  if (!context) throw new Error("useChatCoordinator must be used inside ChatCoordinatorProvider.");
  return context;
}
