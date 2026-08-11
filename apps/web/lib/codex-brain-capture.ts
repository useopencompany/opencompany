import { createHash } from "node:crypto";
import {
  GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION,
  GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
  type GoatCodexBrainCaptureGatewayRequest,
  type GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  goatChatMessages,
  goatCodexChatSessions,
  goatCodexChatTurns,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_SLUG,
  getGoatBrainAccess,
  listAccessibleGoatBrains,
} from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray } from "drizzle-orm";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { saveChatAttachmentsToGoatBrain } from "@/lib/chat-attachment-capture";

const logger = createLogger({
  service: "opencompany-goat",
  runtime: "codex-brain-capture",
});

type GoatCodexBrainCaptureContext = {
  userWorkosId: string;
  workspaceId: string;
  brainRef: string | null;
  allowDefaultBrain?: boolean;
  chatSessionId: string;
  userMessageId: string;
};

type GoatCodexBrainCaptureDependencies = {
  loadContext: (
    request: GoatCodexBrainCaptureGatewayRequest,
  ) => Promise<GoatCodexBrainCaptureContext | null>;
  getBrainAccess: (input: {
    userWorkosId: string;
    brainRef: string;
  }) => Promise<{ brain: { workspaceId: string } } | null>;
  listBrains: typeof listAccessibleGoatBrains;
  capture: typeof captureToGoatBrainInbox;
  loadMessages: (
    chatSessionId: string,
  ) => Promise<Parameters<typeof saveChatAttachmentsToGoatBrain>[0]["sessionMessages"]>;
  saveAttachments: typeof saveChatAttachmentsToGoatBrain;
};

const defaultDependencies: GoatCodexBrainCaptureDependencies = {
  loadContext: loadGoatCodexBrainCaptureContext,
  getBrainAccess: (input) => getGoatBrainAccess(input),
  listBrains: (input) => listAccessibleGoatBrains(input),
  capture: captureToGoatBrainInbox,
  loadMessages: async (chatSessionId) => {
    const rows = await getDb()
      .select({ role: goatChatMessages.role, attachments: goatChatMessages.attachments })
      .from(goatChatMessages)
      .where(eq(goatChatMessages.sessionId, chatSessionId));
    return rows.filter(
      (
        row,
      ): row is typeof row & {
        role: "user" | "assistant";
      } => row.role === "user" || row.role === "assistant",
    );
  },
  saveAttachments: saveChatAttachmentsToGoatBrain,
};

export async function executeGoatCodexBrainCaptureGateway(input: {
  request: GoatCodexBrainCaptureGatewayRequest;
  dependencies?: Partial<GoatCodexBrainCaptureDependencies>;
}): Promise<GoatCodexBrainCaptureGatewayResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const context = await dependencies.loadContext(input.request);
  if (!context) {
    return {
      ok: false,
      error: "This Codex turn can no longer save to the pinned Brain.",
    };
  }

  let brainRef = context.brainRef;
  if (!brainRef && context.allowDefaultBrain) {
    const brains = await dependencies.listBrains({
      userWorkosId: context.userWorkosId,
      workspaceId: context.workspaceId,
    });
    brainRef =
      brains.find((candidate) => candidate.slug === DEFAULT_GOAT_BRAIN_SLUG)?.id ??
      brains[0]?.id ??
      null;
  }
  if (!brainRef) {
    return { ok: false, error: "This chat does not have an accessible Brain." };
  }
  const access = await dependencies.getBrainAccess({
    userWorkosId: context.userWorkosId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspaceId) {
    return {
      ok: false,
      error: "You no longer have access to the Brain pinned to this Codex chat.",
    };
  }

  const content = optionalString(input.request.content);
  const title = optionalString(input.request.title);
  const intent = optionalString(input.request.intent);
  const sourceRef = optionalString(input.request.sourceRef);
  const integrationId = optionalString(input.request.integrationId);
  const fallbackContent = optionalString(input.request.fallbackContent);
  const attachmentIds = input.request.attachmentIds ?? [];
  if (!content && !sourceRef && attachmentIds.length === 0) {
    return { ok: false, error: "save_to_brain needs content, sourceRef, or attachmentIds." };
  }

  try {
    if (attachmentIds.length > 0) {
      const sessionMessages = await dependencies.loadMessages(context.chatSessionId);
      return dependencies.saveAttachments({
        brainRef,
        userWorkosId: context.userWorkosId,
        attachmentIds,
        sessionMessages,
      });
    }
    const captured = await dependencies.capture({
      brainRef,
      userWorkosId: context.userWorkosId,
      ...(content ? { text: content } : {}),
      ...(title ? { title } : {}),
      ...(intent ? { intent } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(integrationId ? { integrationId } : {}),
      ...(fallbackContent ? { fallbackText: fallbackContent } : {}),
      source: {
        kind: "chat",
        connectionId: context.chatSessionId,
        itemId: context.userMessageId,
        idempotencyKey: brainCaptureIdempotencyKey({
          brainRef,
          userMessageId: context.userMessageId,
          content,
          title,
          intent,
          sourceRef,
          integrationId,
          fallbackContent,
        }),
      },
    });
    if (!captured.ok) return captured;
    return {
      ok: true,
      status: captured.quotaPaused
        ? "paused_by_plan"
        : captured.alreadyCaptured
          ? "already_captured"
          : "captured",
      ...(captured.quotaPaused
        ? {
            message:
              "Saved to the brain inbox. Ingestion is paused by the workspace plan; see Settings → Usage or Billing to review the limit or upgrade.",
          }
        : {}),
      draftId: captured.draftBrainId,
      path: captured.path,
      title: captured.title,
    };
  } catch (error) {
    logger.error("Codex Brain capture failed", {
      event: "goat.codex_brain_capture_failed",
      codex_chat_session_id: input.request.codexChatSessionId,
      codex_chat_turn_id: input.request.codexChatTurnId,
      error: error instanceof Error ? error.message : "Unknown capture error.",
    });
    return {
      ok: false,
      error: "The Codex Brain capture could not be saved.",
    };
  }
}

function brainCaptureIdempotencyKey(input: {
  brainRef: string;
  userMessageId: string;
  content: string | null;
  title: string | null;
  intent: string | null;
  sourceRef: string | null;
  integrationId: string | null;
  fallbackContent: string | null;
}) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.brainRef,
        input.userMessageId,
        input.content,
        input.title,
        input.intent,
        input.sourceRef,
        input.integrationId,
        input.fallbackContent,
      ]),
    )
    .digest("hex");
  return `codex-save:${hash}`;
}

async function loadGoatCodexBrainCaptureContext(
  request: GoatCodexBrainCaptureGatewayRequest,
): Promise<GoatCodexBrainCaptureContext | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: goatCodexChatSessions.userWorkosId,
      workspaceId: goatCodexChatSessions.workspaceId,
      brainRef: goatCodexChatSessions.brainRef,
      chatSessionId: goatCodexChatSessions.chatSessionId,
      userMessageId: goatCodexChatTurns.userMessageId,
      engine: goatCodexChatSessions.engine,
    })
    .from(goatCodexChatSessions)
    .innerJoin(
      goatCodexChatTurns,
      and(
        eq(goatCodexChatTurns.id, request.codexChatTurnId),
        eq(goatCodexChatTurns.codexChatSessionId, goatCodexChatSessions.id),
        eq(goatCodexChatTurns.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(goatCodexChatSessions.id, request.codexChatSessionId),
        inArray(goatCodexChatSessions.hostToolContractVersion, [
          GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION,
          GOAT_CHAT_HOST_TOOL_CONTRACT_VERSION,
        ]),
        eq(goatCodexChatTurns.status, "running"),
      ),
    )
    .limit(1);

  if (!row?.workspaceId || (!row.brainRef && row.engine !== "opencompany")) return null;
  return {
    userWorkosId: row.userWorkosId,
    workspaceId: row.workspaceId,
    brainRef: row.brainRef,
    allowDefaultBrain: row.engine === "opencompany",
    chatSessionId: row.chatSessionId,
    userMessageId: row.userMessageId,
  };
}

function optionalString(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
