import { after, NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  GoatBrainSkillMentionError,
  readGoatBrainSkillMentionRefs,
  resolveGoatBrainSkillMentions,
} from "@/lib/brain-skills";
import { parseGoatChatAttachmentsInput } from "@/lib/chat-attachments";
import { parseOptimisticGoatChatSessionId } from "@/lib/chat-navigation";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import { type GoatChatUiMessage, textFromGoatChatUiMessage } from "@/lib/chat-ui";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";

export const runtime = "nodejs";

// Claude Code engine chats ride the same session/turn queue as cloud codex chats;
// this route only differs from /api/codex-chat/messages in the engine it requests.

type ClaudeChatMessageBody = {
  sessionId?: unknown;
  newSessionId?: unknown;
  prompt?: unknown;
  message?: unknown;
  model?: unknown;
};

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const body = await readJsonBody<ClaudeChatMessageBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });
  if (!isMessageBody(body.value)) {
    return new Response("Invalid Claude chat message.", { status: 400 });
  }

  const prompt = readPrompt(body.value);
  const messageMetadata = isUiMessage(body.value.message) ? body.value.message.metadata : undefined;
  const parsedAttachments = parseGoatChatAttachmentsInput(
    messageMetadata?.attachments,
    context.user.workosUserId,
  );
  if (!parsedAttachments.ok) return new Response(parsedAttachments.error, { status: 400 });
  if (!prompt && parsedAttachments.attachments.length === 0) {
    return new Response("Invalid Claude chat message.", { status: 400 });
  }

  const parsedSkillMentions = readGoatBrainSkillMentionRefs(messageMetadata?.mentions);
  if (!parsedSkillMentions.ok) {
    return new Response(parsedSkillMentions.error, { status: 400 });
  }
  let resolvedSkills;
  try {
    resolvedSkills = await resolveGoatBrainSkillMentions({
      activeBrainRef: context.activeBrain?.id ?? null,
      mentions: parsedSkillMentions.mentions,
    });
  } catch (error) {
    if (error instanceof GoatBrainSkillMentionError) {
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
    skills: resolvedSkills.map((skill) => ({
      ...skill,
      brainRef: context.activeBrain?.id ?? "",
    })),
    attachments: parsedAttachments.attachments,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(body.value.model !== undefined ? { model: body.value.model } : {}),
    engine: "claude_code",
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

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

  return NextResponse.json(result, { status: 202 });
}

function readPrompt(body: ClaudeChatMessageBody) {
  if (typeof body.prompt === "string") return body.prompt.trim();
  if (!isUiMessage(body.message)) return "";
  return textFromGoatChatUiMessage(body.message);
}

function isUiMessage(value: unknown): value is GoatChatUiMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; parts?: unknown };
  return message.role === "user" && Array.isArray(message.parts);
}

function isMessageBody(value: unknown): value is ClaudeChatMessageBody {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}
