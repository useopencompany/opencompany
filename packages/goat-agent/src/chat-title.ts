import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import {
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import { createGateway, generateText } from "ai";

const TITLE_MODEL = "openai/gpt-5.4-mini";
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_CHARS = 4000;

export async function generateGoatChatTitle(input: {
  content: string;
  fallbackTitle: string;
  apiKey: string;
  userWorkosId?: string | null;
  chatSessionId?: string | null;
}) {
  const gateway = createGateway({ apiKey: input.apiKey });
  const attribution = createGoatGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "chat-title",
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
  });
  const result = await generateText({
    model: gateway(TITLE_MODEL),
    system:
      "You write compact chat titles. Return only the title, with no quotes and no punctuation at the end.",
    prompt: `Write a very short, specific title for this first user message. Keep it under ${MAX_TITLE_LENGTH} characters.\n\nMessage:\n${input.content.slice(
      0,
      MAX_PROMPT_CHARS,
    )}`,
    maxOutputTokens: 20,
    temperature: 0,
    providerOptions: goatGatewayProviderOptions(attribution, GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS),
  });

  return sanitizeGoatChatTitle(result.text, input.fallbackTitle);
}

export function sanitizeGoatChatTitle(title: string, fallbackTitle: string) {
  const normalized = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/[.!?;:,-]+$/g, "")
    .trim();

  return truncateGoatChatTitle(normalized || fallbackTitle || "New chat");
}

export function goatChatTitleFromPrompt(content: string) {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncateGoatChatTitle(firstLine ?? "New chat");
}

function truncateGoatChatTitle(title: string) {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}
