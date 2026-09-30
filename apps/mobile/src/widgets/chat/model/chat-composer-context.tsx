import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, use, useState } from "react";
import { useAuth } from "@/features/auth";
import { throwIfAborted } from "@/shared/lib/abort";
import { analytics } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "./chat-coordinator";
import {
  getStoredDraft,
  listStoredConversations,
  NEW_CHAT_ID,
  persistDraftAttachment,
  removeStoredAttachment,
  type StoredConversation,
  type StoredDraft,
  saveStoredDraft,
} from "./chat-store";
import {
  AUTO_MODEL_ID,
  type ComposerSelection,
  defaultComposerSelection,
  resolveComposerSelection,
  selectedModelId,
} from "./composer-selection";

export interface ComposerAttachment {
  id: string;
  kind: "image" | "file";
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}

/** What the conversation allows the composer to change. */
export interface ComposerLocks {
  /** The server accepted this conversation, so its engine and model are fixed. */
  engineAndModel: boolean;
  /** A Task reply keeps the Task's engine, model, and settings; nothing is selectable. */
  isTask: boolean;
}

interface ChatComposerContextValue {
  conversationId: string;
  value: string;
  attachments: ComposerAttachment[];
  /** The selection the composer shows and sends, with conversation locks applied. */
  selection: ComposerSelection;
  locks: ComposerLocks;
  autoModelEnabled: boolean;
  isReady: boolean;
  activateConversation: (conversationId: string) => void;
  addAttachments: (attachments: ComposerAttachment[]) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  updateSelection: (update: (current: ComposerSelection) => ComposerSelection) => void;
  setValue: (value: string) => void;
}

const ChatComposerContext = createContext<ChatComposerContextValue | null>(null);

const conversationSource = (conversation: StoredConversation | undefined) =>
  conversation
    ? {
        engine: conversation.engine,
        model: conversation.model,
        composerSettings: conversation.composerSettings,
        locked: !conversation.provisional,
      }
    : null;

export function ChatComposerProvider({ children }: { children: React.ReactNode }) {
  const { partition } = useChatCoordinator();
  const { profile } = useAuth();
  const { showErrorToast } = useToast();
  const [conversationId, setConversationId] = useState(NEW_CHAT_ID);
  const autoModelEnabled = profile?.autoModelRoutingEnabled === true;
  const queryKey = partition
    ? chatQueryKeys.draft(partition, conversationId)
    : ["chat", "draft", "signed-out"];
  const draftQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<StoredDraft> => {
      const draft = await getStoredDraft(partition!, conversationId);
      throwIfAborted(signal);
      return draft;
    },
    enabled: Boolean(partition),
    staleTime: Infinity,
  });
  const conversationQuery = useQuery({
    queryKey: partition
      ? chatQueryKeys.conversations(partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(partition!),
    enabled: Boolean(partition) && conversationId !== NEW_CHAT_ID,
    select: (items) => items.find((item) => item.id === conversationId),
  });
  const conversation = conversationId === NEW_CHAT_ID ? undefined : conversationQuery.data;
  const saveDraftMutation = useMutation({
    mutationFn: (input: { partition: NonNullable<typeof partition>; draft: StoredDraft }) =>
      saveStoredDraft(
        input.partition,
        input.draft.conversationId,
        input.draft.text,
        input.draft.selection,
      ),
    onError: (error, input) => {
      if (!input.partition.signal?.aborted)
        showErrorToast(
          error instanceof Error ? error.message : "Your draft could not be saved.",
          error,
          "chat.draft.save",
        );
    },
  });
  const emptyDraft: StoredDraft = { conversationId, text: "", selection: null, attachments: [] };
  const draft = draftQuery.data ?? emptyDraft;
  const resolveSelection = (stored: ComposerSelection | null) => {
    const resolved = resolveComposerSelection(stored, conversationSource(conversation));
    // Auto follows the account entitlement. Losing it falls back to the Chat default rather than
    // sending a model the server would refuse.
    return resolved.chatModelId === AUTO_MODEL_ID && !autoModelEnabled
      ? { ...resolved, chatModelId: defaultComposerSelection().chatModelId }
      : resolved;
  };
  const selection = resolveSelection(draft.selection);
  const editDraft = (changes: Partial<Pick<StoredDraft, "text" | "selection">>) => {
    if (!partition) return;
    // Cancel a stale disk read before publishing an edit. The query cache is the live draft;
    // SQLite owns persistence, and successful writes never hydrate older text over newer edits.
    void queryClient.cancelQueries({ queryKey, exact: true });
    const current = queryClient.getQueryData<StoredDraft>(queryKey) ?? emptyDraft;
    const next = { ...current, ...changes };
    queryClient.setQueryData(queryKey, next);
    saveDraftMutation.mutate({ partition, draft: next });
  };
  const addAttachments = async (attachments: ComposerAttachment[]): Promise<void> => {
    if (!partition) return;
    for (const attachment of attachments) {
      await persistDraftAttachment(partition, conversationId, {
        ...attachment,
        sourceUri: attachment.uri,
      });
    }
    await queryClient.invalidateQueries({ queryKey, exact: true });
  };
  const removeAttachment = async (id: string): Promise<void> => {
    if (!partition) return;
    await removeStoredAttachment(partition, id);
    analytics.capture("attachment_removed");
    await queryClient.invalidateQueries({ queryKey, exact: true });
  };
  return (
    <ChatComposerContext
      value={{
        conversationId,
        value: draft.text,
        attachments: draft.attachments,
        selection,
        locks: {
          engineAndModel: Boolean(conversation && !conversation.provisional),
          isTask: conversation?.kind === "task",
        },
        autoModelEnabled,
        isReady: !partition || draftQuery.isFetched,
        activateConversation: setConversationId,
        addAttachments,
        removeAttachment,
        updateSelection: (update) => {
          // Build on the latest cached draft, not this render's copy, so edits made within one
          // frame, such as quick toggles, all land.
          const latest = queryClient.getQueryData<StoredDraft>(queryKey);
          const current = latest ? resolveSelection(latest.selection) : selection;
          const next = update(current);
          editDraft({ selection: next });
          if (next.engine !== current.engine || selectedModelId(next) !== selectedModelId(current))
            analytics.capture("chat_model_selected", {
              engine: next.engine,
              model_id: selectedModelId(next),
            });
        },
        setValue: (text) => editDraft({ text }),
      }}
    >
      {children}
    </ChatComposerContext>
  );
}

export function useChatComposer(): ChatComposerContextValue {
  const context = use(ChatComposerContext);
  if (!context) throw new Error("useChatComposer must be used inside ChatComposerProvider.");
  return context;
}
