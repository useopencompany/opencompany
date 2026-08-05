import type { GoatCodexChatEngine } from "@opencompany/db/goat-schema";
import { after, NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatChatMessageSent } from "@/lib/chat-analytics";
import { parseGoatChatAttachmentsInput } from "@/lib/chat-attachments";
import { parseOptimisticGoatChatSessionId } from "@/lib/chat-navigation";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import { type GoatChatUiMessage, textFromGoatChatUiMessage } from "@/lib/chat-ui";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";
import {
  GoatSkillMentionError,
  type GoatSkillMentionRef,
  goatSkillMentionRefsFromSlashInvocation,
  listGoatSkillCatalog,
  readGoatSkillMentionRefs,
  resolveGoatSkillMentions,
} from "@/lib/skills";

type CloudChatMessageBody = {
  sessionId?: unknown;
  newSessionId?: unknown;
  prompt?: unknown;
  message?: unknown;
  settings?: unknown;
  model?: unknown;
};

export function createCloudChatMessageHandler(input: {
  engine: GoatCodexChatEngine;
  invalidMessage: string;
}) {
  return async function POST(request: Request) {
    const context = await currentGoatUser({ optional: true });
    if (!context) return new Response("Unauthorized", { status: 401 });

    const body = await readJsonBody<CloudChatMessageBody>(request);
    if (!body.ok) return new Response(body.error, { status: 400 });
    if (!isMessageBody(body.value)) {
      return new Response(input.invalidMessage, { status: 400 });
    }

    const prompt = readPrompt(body.value);
    const messageMetadata = isUiMessage(body.value.message)
      ? body.value.message.metadata
      : undefined;
    const parsedAttachments = parseGoatChatAttachmentsInput(
      messageMetadata?.attachments,
      context.user.workosUserId,
    );
    if (!parsedAttachments.ok) return new Response(parsedAttachments.error, { status: 400 });
    if (!prompt && parsedAttachments.attachments.length === 0) {
      return new Response(input.invalidMessage, { status: 400 });
    }

    const parsedSkillMentions = readGoatSkillMentionRefs(messageMetadata?.mentions);
    if (!parsedSkillMentions.ok) {
      return new Response(parsedSkillMentions.error, { status: 400 });
    }
    const skillMentions = await skillMentionRefsForCloudChatPrompt({
      workspaceId: context.workspace.id,
      prompt,
      structured: parsedSkillMentions.mentions,
    });
    let resolvedSkills;
    try {
      resolvedSkills = await resolveGoatSkillMentions({
        workspaceId: context.workspace.id,
        mentions: skillMentions,
      });
    } catch (error) {
      if (error instanceof GoatSkillMentionError) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }

    const sessionId = typeof body.value.sessionId === "string" ? body.value.sessionId.trim() : null;
    const parsedNewSessionId = parseOptimisticGoatChatSessionId(body.value.newSessionId);
    if (!parsedNewSessionId.ok) return new Response(parsedNewSessionId.error, { status: 400 });
    if (sessionId && parsedNewSessionId.sessionId) {
      return new Response("A chat request cannot continue and create a session at the same time.", {
        status: 400,
      });
    }
    const clientMessageId =
      isUiMessage(body.value.message) && typeof body.value.message.id === "string"
        ? body.value.message.id
        : null;

    const result = await createGoatCodexChatMessage({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      brainRef: context.activeBrain?.id ?? null,
      ...(sessionId ? { sessionId } : {}),
      ...(parsedNewSessionId.sessionId ? { newSessionId: parsedNewSessionId.sessionId } : {}),
      prompt,
      // The snapshot's provenance ref (chat_session_skills.brain_ref) carries
      // the workspace id; skills are workspace-scoped, not Brain-scoped.
      skills: resolvedSkills.map((skill) => ({
        ...skill,
        brainRef: context.workspace.id,
      })),
      attachments: parsedAttachments.attachments,
      ...(clientMessageId ? { clientMessageId } : {}),
      settings: body.value.settings,
      ...(body.value.model !== undefined ? { model: body.value.model } : {}),
      engine: input.engine,
    });
    if (!result.ok) return new Response(result.error, { status: result.status });
    const { analytics, ...responseBody } = result;

    const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
    if (!sessionId && prompt) {
      after(
        generateGoatChatTitleForMessage({
          sessionId: result.sessionId,
          messageId: result.userMessageId,
          ...(gatewayApiKey ? { apiKey: gatewayApiKey } : {}),
        }).catch(() => undefined),
      );
    }
    after(
      captureGoatChatMessageSent({
        user: context.user,
        workspaceId: context.workspace.id,
        sessionId: result.sessionId,
        isFirstMessage: analytics.isFirstMessage,
        engine: analytics.engine,
        model: analytics.model,
        messageLength: prompt.length,
      }),
    );

    return NextResponse.json(responseBody, { status: 202 });
  };
}

async function skillMentionRefsForCloudChatPrompt(input: {
  workspaceId: string;
  prompt: string;
  structured: GoatSkillMentionRef[];
}) {
  const catalog = input.prompt.trimStart().startsWith("/")
    ? await listGoatSkillCatalog(input.workspaceId).catch(() => [])
    : [];
  const slash = goatSkillMentionRefsFromSlashInvocation(input.prompt, catalog);
  return dedupeSkillMentionRefs([...input.structured, ...slash]);
}

function dedupeSkillMentionRefs(mentions: GoatSkillMentionRef[]) {
  return [...new Map(mentions.map((mention) => [mention.id, mention])).values()];
}

function readPrompt(body: CloudChatMessageBody) {
  if (typeof body.prompt === "string") return body.prompt.trim();
  if (!isUiMessage(body.message)) return "";
  return textFromGoatChatUiMessage(body.message);
}

function isUiMessage(value: unknown): value is GoatChatUiMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; parts?: unknown };
  return message.role === "user" && Array.isArray(message.parts);
}

function isMessageBody(value: unknown): value is CloudChatMessageBody {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}
