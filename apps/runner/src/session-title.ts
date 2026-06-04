import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import { calculateModelUsageCost, recordWorkspaceUsageDebit } from "@opencompany/billing";
import { agentSessionMessages, agentSessions, agentSessionUsage } from "@opencompany/db/schema";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import { createGateway, type LanguageModelUsage } from "ai";
import * as ai from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { normalizeModelUsage } from "./usage";

const TITLE_MODEL = "openai/gpt-5.4-mini";
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_CHARS = 4000;

type TitleGenerationResult =
  | { ok: true; title: string }
  | { ok: false; skipped: "session_not_found" | "message_not_first_user_message" };

export async function generateSessionTitleForMessage(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
}): Promise<TitleGenerationResult> {
  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, input.sessionId), isNull(agentSessions.archivedAt)))
    .limit(1);

  if (!session) return { ok: false, skipped: "session_not_found" };

  const firstUserMessage = await loadFirstUserMessage(input.sessionId);
  if (!firstUserMessage || firstUserMessage.id !== input.messageId) {
    return { ok: false, skipped: "message_not_first_user_message" };
  }

  const fallbackTitle = titleFromPrompt(firstUserMessage.content);
  const titleResult = await generateSessionTitleWithUsage({
    content: firstUserMessage.content,
    fallbackTitle,
    apiKey: input.env.vercelAiGatewayApiKey,
  });
  const title = titleResult.title;

  const [updated] = await db
    .update(agentSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, input.sessionId), isNull(agentSessions.archivedAt)))
    .returning({ id: agentSessions.id });

  if (!updated) return { ok: false, skipped: "session_not_found" };

  if (titleResult.usage) {
    await recordTitleUsage({
      sessionId: input.sessionId,
      messageId: input.messageId,
      usage: titleResult.usage,
      response: titleResult.response,
    });
  }

  await appendRuntimeEvent(db, {
    sessionId: input.sessionId,
    messageId: input.messageId,
    type: "session.title_updated",
    payload: { title },
  });

  return { ok: true, title };
}

export async function generateSessionTitle(input: {
  content: string;
  fallbackTitle: string;
  apiKey: string;
}) {
  const result = await generateSessionTitleWithUsage(input);
  return result.title;
}

async function generateSessionTitleWithUsage(input: {
  content: string;
  fallbackTitle: string;
  apiKey: string;
}) {
  const gateway = createGateway({ apiKey: input.apiKey });
  // Traced by Braintrust's `wrapAISDK` when enabled; falls back to the unwrapped `ai` otherwise.
  const { generateText } = getBraintrustAISDK(ai);
  const result = await generateText({
    model: gateway(TITLE_MODEL),
    system:
      "You write compact chat session titles. Return only the title, with no quotes and no punctuation at the end.",
    prompt: `Write a very short, specific title for this first user message. Keep it under ${MAX_TITLE_LENGTH} characters.\n\nMessage:\n${input.content.slice(
      0,
      MAX_PROMPT_CHARS,
    )}`,
    maxOutputTokens: 20,
    temperature: 0,
    providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
  });

  return {
    title: sanitizeSessionTitle(result.text, input.fallbackTitle),
    usage: result.usage,
    response: result.response,
  };
}

export function sanitizeSessionTitle(title: string, fallbackTitle: string) {
  const normalized = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/[.!?;:,-]+$/g, "")
    .trim();

  const base = normalized || fallbackTitle || "Untitled session";
  return truncateTitle(base);
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return truncateTitle(firstLine ?? "Untitled session");
}

function truncateTitle(title: string) {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}

async function loadFirstUserMessage(sessionId: string) {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      content: agentSessionMessages.content,
    })
    .from(agentSessionMessages)
    .where(
      and(eq(agentSessionMessages.sessionId, sessionId), eq(agentSessionMessages.role, "user")),
    )
    .orderBy(asc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

async function recordTitleUsage(input: {
  sessionId: string;
  messageId: string;
  usage: LanguageModelUsage;
  response?: { id?: string; modelId?: string; timestamp?: Date };
}) {
  const db = getDb();
  const usage = normalizeModelUsage(input.usage);
  const cost = calculateModelUsageCost({
    modelName: TITLE_MODEL,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  const responseModelId = input.response?.modelId ?? TITLE_MODEL;

  const [usageRow] = await db
    .insert(agentSessionUsage)
    .values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      runLeaseId: null,
      stepIndex: 0,
      modelProvider: "vercel-ai-gateway",
      modelName: TITLE_MODEL,
      responseId: input.response?.id ?? null,
      responseModelId,
      finishReason: "stop",
      rawFinishReason: "title_generation",
      inputTokens: usage.inputTokens,
      inputNoCacheTokens: usage.inputNoCacheTokens,
      inputCacheReadTokens: usage.inputCacheReadTokens,
      inputCacheWriteTokens: usage.inputCacheWriteTokens,
      outputTokens: usage.outputTokens,
      outputTextTokens: usage.outputTextTokens,
      outputReasoningTokens: usage.outputReasoningTokens,
      totalTokens: usage.totalTokens,
      rawUsage: usage.rawUsage,
      providerCreatedAt: input.response?.timestamp ?? null,
    })
    .returning({ id: agentSessionUsage.id });

  if (!usageRow || !cost.billable) return;

  await recordWorkspaceUsageDebit({
    db,
    sessionId: input.sessionId,
    messageId: input.messageId,
    modelUsageId: usageRow.id,
    source: "model_usage",
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    totalCostUsdMicros: cost.totalCostUsdMicros,
    costBasis: {
      ...cost.costBasis,
      usageType: "title_generation",
    },
    metadata: {
      usageType: "title_generation",
      responseModelId,
    },
  });
}
