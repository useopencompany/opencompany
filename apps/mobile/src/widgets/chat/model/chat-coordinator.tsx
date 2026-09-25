import type { ResolveApprovalBody } from "@opencompany/protocol/schemas";
import * as Network from "expo-network";
import { router } from "expo-router";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/features/auth";
import { analytics } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import type { ConnectivityState } from "./chat";
import { registerChatAbortHandler } from "./chat-lifecycle";
import { chatQueryKeys, invalidateConversation } from "./chat-queries";
import { createChatSession } from "./chat-session";
import {
  type ChatPartition,
  queueApprovalCommand,
  queueStopCommand,
  type StoredDraft,
} from "./chat-store";
import { type PendingDraftSend, useDraftSend } from "./use-draft-send";

export { chatQueryKeys } from "./chat-queries";

interface ChatCoordinatorValue {
  partition: ChatPartition | null;
  connectivity: ConnectivityState;
  setVisibleConversation: (id: string | null) => void;
  pendingSends: Record<string, PendingDraftSend>;
  stoppingConversations: ReadonlySet<string>;
  sendDraft: (draft: StoredDraft) => Promise<{ conversationId: string; userMessageId: string }>;
  stopRun: (id: string) => Promise<void>;
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
  const [online, setOnline] = useState<boolean | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const visibleIdRef = useRef<string | null>(null);
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
  const draftSend = useDraftSend(partition);
  const [stoppingConversations, setStoppingConversations] = useState<ReadonlySet<string>>(
    new Set(),
  );

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

  const sendDraft = async (
    draft: StoredDraft,
  ): Promise<{ conversationId: string; userMessageId: string }> => {
    const queued = await draftSend.sendDraft(draft);
    if (!partition) throw new Error("Choose a workspace before sending a message.");
    void queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });
    if (
      draft.conversationId !== queued.conversationId &&
      visibleIdRef.current === draft.conversationId
    )
      router.replace({
        pathname: "/chats/[chatId]",
        params: {
          chatId: queued.conversationId,
          anchorMessageId: queued.clientMessageId,
        },
      });
    session?.drain();
    return { conversationId: queued.conversationId, userMessageId: queued.clientMessageId };
  };
  const stopRun = async (id: string): Promise<void> => {
    if (!partition) return;
    const pending = draftSend.pendingRef.current.get(id);
    const conversationId = pending?.conversationId ?? id;
    setStoppingConversations((current) => new Set([...current, id, conversationId]));
    try {
      if (pending) await pending.persisted;
      await queueStopCommand(partition, conversationId);
      analytics.capture("run_stopped");
      await invalidateConversation(partition, conversationId);
      session?.drain();
    } finally {
      setStoppingConversations((current) => {
        const next = new Set(current);
        next.delete(id);
        next.delete(conversationId);
        return next;
      });
    }
  };
  const resolveApproval = async (
    id: string,
    runId: string,
    approvalId: string,
    body: ResolveApprovalBody,
  ): Promise<void> => {
    if (!partition) return;
    await queueApprovalCommand(partition, id, runId, approvalId, body);
    analytics.capture("approval_resolved", { resolution: body.resolution });
    await invalidateConversation(partition, id);
    session?.drain();
  };
  return (
    <ChatCoordinatorContext
      value={{
        partition,
        connectivity: online === false ? "offline" : connectivity,
        pendingSends: draftSend.pendingSends,
        stoppingConversations,
        setVisibleConversation: (id) => {
          visibleIdRef.current = id;
          setVisibleId(id);
        },
        sendDraft,
        stopRun,
        resolveApproval,
        refreshConversations: async () => {
          await session?.refreshConversations();
          analytics.capture("conversation_list_refreshed");
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
