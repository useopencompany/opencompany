import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, use, useEffect, useRef, useState } from "react";
import { until } from "until-async";
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

interface PendingAttachment {
  conversationId: string;
  attachment: ComposerAttachment;
  /** Saved to the draft. It leaves this list once the draft query shows the stored copy. */
  saved: boolean;
  /** Removed by the user while it was still saving. Its stored copy is deleted once saved. */
  removed: boolean;
}

interface ChatComposerContextValue {
  conversationId: string;
  value: string;
  /** The draft's attachments, followed by any still being prepared and saved. */
  attachments: ComposerAttachment[];
  /** Some attachments are still saving, so the draft cannot send yet. */
  hasPendingAttachments: boolean;
  /** The selection the composer shows and sends, with conversation locks applied. */
  selection: ComposerSelection;
  locks: ComposerLocks;
  autoModelEnabled: boolean;
  isReady: boolean;
  activateConversation: (conversationId: string) => void;
  addAttachments: (attachments: ComposerAttachment[]) => Promise<void>;
  /**
   * Shows attachments in the composer at once while `save` prepares and stores them. When `save`
   * reports failure they leave the composer again.
   */
  showWhileSaving: <T extends { status: string }>(
    attachments: ComposerAttachment[],
    save: () => Promise<T>,
  ) => Promise<T>;
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
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
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
  // Attachments the user removed while they were still saving. Their stored copies are deleted as
  // soon as the save lands.
  const removedWhileSavingRef = useRef(new Set<string>());
  const removedIds = new Set(
    pendingAttachments.filter((pending) => pending.removed).map((pending) => pending.attachment.id),
  );
  const storedAttachments = draft.attachments.filter(
    (attachment) => !removedIds.has(attachment.id),
  );
  const storedIds = new Set(draft.attachments.map((attachment) => attachment.id));
  const pendingHere = pendingAttachments.filter(
    (pending) =>
      pending.conversationId === conversationId &&
      !pending.removed &&
      !storedIds.has(pending.attachment.id),
  );
  // A saved attachment stays pending until the draft query renders its stored copy, so its
  // preview never drops out for a frame between the two.
  useEffect(() => {
    const isShownFromDraft = (pending: PendingAttachment) =>
      pending.saved && !pending.removed && storedIds.has(pending.attachment.id);
    if (pendingAttachments.some(isShownFromDraft))
      setPendingAttachments((current) => current.filter((pending) => !isShownFromDraft(pending)));
  }, [pendingAttachments, draft.attachments]);
  const dropPending = (ids: Set<string>) => {
    for (const id of ids) removedWhileSavingRef.current.delete(id);
    setPendingAttachments((current) =>
      current.filter((pending) => !ids.has(pending.attachment.id)),
    );
  };
  const showWhileSaving = async <T extends { status: string }>(
    attachments: ComposerAttachment[],
    save: () => Promise<T>,
  ): Promise<T> => {
    const ids = new Set(attachments.map((attachment) => attachment.id));
    setPendingAttachments((current) => [
      ...current,
      ...attachments.map((attachment) => ({
        conversationId,
        attachment,
        saved: false,
        removed: false,
      })),
    ]);
    const result = await save();
    if (result.status !== "added" || !partition) {
      dropPending(ids);
      return result;
    }
    const removed = new Set([...ids].filter((id) => removedWhileSavingRef.current.has(id)));
    setPendingAttachments((current) =>
      current.map((pending) =>
        ids.has(pending.attachment.id) && !removed.has(pending.attachment.id)
          ? { ...pending, saved: true }
          : pending,
      ),
    );
    if (removed.size > 0) {
      const [removeError] = await until(async () => {
        for (const id of removed) await removeStoredAttachment(partition, id);
        await queryClient.invalidateQueries({ queryKey, exact: true });
      });
      if (removeError)
        showErrorToast(
          "A removed attachment could not be deleted.",
          removeError,
          "chat.attachment.remove",
        );
      dropPending(removed);
    }
    return result;
  };
  const removeAttachment = async (id: string): Promise<void> => {
    if (!partition) return;
    if (pendingHere.some((pending) => pending.attachment.id === id)) {
      removedWhileSavingRef.current.add(id);
      setPendingAttachments((current) =>
        current.map((pending) =>
          pending.attachment.id === id ? { ...pending, removed: true } : pending,
        ),
      );
      analytics.capture("attachment_removed");
      return;
    }
    await removeStoredAttachment(partition, id);
    analytics.capture("attachment_removed");
    await queryClient.invalidateQueries({ queryKey, exact: true });
  };
  return (
    <ChatComposerContext
      value={{
        conversationId,
        value: draft.text,
        attachments: [...storedAttachments, ...pendingHere.map((pending) => pending.attachment)],
        hasPendingAttachments: pendingHere.some((pending) => !pending.saved),
        selection,
        locks: {
          engineAndModel: Boolean(conversation && !conversation.provisional),
          isTask: conversation?.kind === "task",
        },
        autoModelEnabled,
        isReady: !partition || draftQuery.isFetched,
        activateConversation: setConversationId,
        addAttachments,
        showWhileSaving,
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
