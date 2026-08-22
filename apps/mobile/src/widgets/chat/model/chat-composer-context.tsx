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

export const CHAT_MODELS = [
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "Anthropic",
    logo: {
      light: anthropicLight,
      dark: anthropicDark,
    },
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    logo: {
      light: anthropicLight,
      dark: anthropicDark,
    },
  },
  {
    id: "openai/gpt-5.5",
    label: "GPT 5.5",
    provider: "OpenAI",
    logo: {
      light: openaiLight,
      dark: openaiDark,
    },
  },
  {
    id: "alibaba/qwen3.8-max",
    label: "Qwen 3.8 Max",
    provider: "Alibaba",
    logo: {
      light: qwenLight,
      dark: qwenDark,
    },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    logo: {
      light: deepseekLight,
      dark: deepseekDark,
    },
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    provider: "Moonshot",
    logo: {
      light: moonshotLight,
      dark: moonshotDark,
    },
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    provider: "Moonshot",
    logo: {
      light: moonshotLight,
      dark: moonshotDark,
    },
  },
  {
    id: "zai/glm-5.2",
    label: "GLM 5.2",
    provider: "zai",
    logo: {
      light: zaiLight,
      dark: zaiDark,
    },
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
  attachments: ComposerAttachment[];
  selectedModelId: ChatModelId;
  addAttachments: (attachments: ComposerAttachment[]) => void;
  clearAttachments: () => void;
  removeAttachment: (id: string) => void;
  selectModel: (id: ChatModelId) => void;
}

const ChatComposerContext = createContext<ChatComposerContextValue | null>(null);

export function ChatComposerProvider({ children }: { children: React.ReactNode }) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<ChatModelId>("moonshotai/kimi-k3");

  const addAttachments = (nextAttachments: ComposerAttachment[]) => {
    setAttachments((currentAttachments) => [...currentAttachments, ...nextAttachments]);
  };

  const clearAttachments = () => {
    setAttachments([]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.id !== id),
    );
  };

  return (
    <ChatComposerContext
      value={{
        attachments,
        selectedModelId,
        addAttachments,
        clearAttachments,
        removeAttachment,
        selectModel: setSelectedModelId,
      }}
    >
      {children}
    </ChatComposerContext>
  );
}

export function useChatComposer() {
  const context = use(ChatComposerContext);

  if (!context) {
    throw new Error("useChatComposer must be used inside ChatComposerProvider.");
  }

  return context;
}
