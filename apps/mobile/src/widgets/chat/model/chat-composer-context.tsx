import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, use, useState } from "react";
import anthropicDark from "@/assets/images/model-anthropic-dark.png";
import anthropicLight from "@/assets/images/model-anthropic-light.png";
import deepseekDark from "@/assets/images/model-deepseek-dark.png";
import deepseekLight from "@/assets/images/model-deepseek-light.png";
import moonshotDark from "@/assets/images/model-moonshot-dark.png";
import moonshotLight from "@/assets/images/model-moonshot-light.png";
import openaiDark from "@/assets/images/model-openai-dark.png";
import openaiLight from "@/assets/images/model-openai-light.png";
import qwenDark from "@/assets/images/model-qwen-dark.png";
import qwenLight from "@/assets/images/model-qwen-light.png";
import zaiDark from "@/assets/images/model-zai-dark.png";
import zaiLight from "@/assets/images/model-zai-light.png";
import { throwIfAborted } from "@/shared/lib/abort";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "./chat-coordinator";
import {
  getStoredDraft,
  NEW_CHAT_ID,
  persistDraftAttachment,
  removeStoredAttachment,
  type StoredDraft,
  saveStoredDraft,
} from "./chat-store";

export const CHAT_MODELS = [
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "Anthropic",
    logo: { light: anthropicLight, dark: anthropicDark },
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    logo: { light: anthropicLight, dark: anthropicDark },
  },
  {
    id: "openai/gpt-5.5",
    label: "GPT 5.5",
    provider: "OpenAI",
    logo: { light: openaiLight, dark: openaiDark },
  },
  {
    id: "alibaba/qwen3.8-max",
    label: "Qwen 3.8 Max",
    provider: "Alibaba",
    logo: { light: qwenLight, dark: qwenDark },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    logo: { light: deepseekLight, dark: deepseekDark },
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    provider: "Moonshot",
    logo: { light: moonshotLight, dark: moonshotDark },
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    provider: "Moonshot",
    logo: { light: moonshotLight, dark: moonshotDark },
  },
  {
    id: "zai/glm-5.2",
    label: "GLM 5.2",
    provider: "zai",
    logo: { light: zaiLight, dark: zaiDark },
  },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]["id"];

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

interface ChatComposerContextValue {
  conversationId: string;
  value: string;
  attachments: ComposerAttachment[];
  selectedModelId: ChatModelId;
  activateConversation: (conversationId: string) => void;
  addAttachments: (attachments: ComposerAttachment[]) => Promise<void>;
  clearAfterSend: () => void;
  flushDraft: () => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  selectModel: (id: ChatModelId) => void;
  setValue: (value: string) => void;
}

const ChatComposerContext = createContext<ChatComposerContextValue | null>(null);

export function ChatComposerProvider({ children }: { children: React.ReactNode }) {
  const { partition } = useChatCoordinator();
  const { showErrorToast } = useToast();
  const [conversationId, setConversationId] = useState(NEW_CHAT_ID);
  const queryKey = partition
    ? chatQueryKeys.draft(partition, conversationId)
    : ["chat", "draft", "signed-out"];
  const draftQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const draft = await getStoredDraft(partition!, conversationId);
      throwIfAborted(signal);
      return draft;
    },
    enabled: Boolean(partition),
    staleTime: Infinity,
  });
  const saveDraftMutation = useMutation({
    mutationFn: (input: { partition: NonNullable<typeof partition>; draft: StoredDraft }) =>
      saveStoredDraft(
        input.partition,
        input.draft.conversationId,
        input.draft.text,
        input.draft.modelId,
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
  const emptyDraft: StoredDraft = {
    conversationId,
    text: "",
    modelId: "moonshotai/kimi-k3",
    attachments: [],
  };
  const draft = draftQuery.data ?? emptyDraft;
  const editDraft = (changes: Partial<Pick<StoredDraft, "text" | "modelId">>) => {
    if (!partition) return;
    // Cancel a stale disk read before publishing an edit. The query cache is the live draft;
    // SQLite owns persistence, and successful writes never hydrate older text over newer edits.
    void queryClient.cancelQueries({ queryKey, exact: true });
    const next = { ...(queryClient.getQueryData<StoredDraft>(queryKey) ?? emptyDraft), ...changes };
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
    await queryClient.invalidateQueries({ queryKey, exact: true });
  };
  const flushDraft = async (): Promise<void> => {
    if (!partition) return;
    const current = queryClient.getQueryData<StoredDraft>(queryKey) ?? emptyDraft;
    await saveDraftMutation.mutateAsync({ partition, draft: current });
  };
  const clearAfterSend = () => {
    if (!partition) return;
    void queryClient.invalidateQueries({ queryKey, exact: true });
  };
  return (
    <ChatComposerContext
      value={{
        conversationId,
        value: draft.text,
        attachments: draft.attachments,
        selectedModelId: draft.modelId,
        activateConversation: setConversationId,
        addAttachments,
        removeAttachment,
        flushDraft,
        clearAfterSend,
        selectModel: (modelId) => editDraft({ modelId }),
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
