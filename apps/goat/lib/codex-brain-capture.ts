import { createHash } from "node:crypto";
import {
  GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION,
  type GoatCodexBrainCaptureGatewayRequest,
  type GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatCodexChatSessions, goatCodexChatTurns } from "@opencompany/db/goat-schema";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";

const logger = createLogger({
  service: "opencompany-goat",
  runtime: "codex-brain-capture",
});

type GoatCodexBrainCaptureContext = {
  userWorkosId: string;
  workspaceId: string;
  brainRef: string;
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
  capture: typeof captureToGoatBrainInbox;
};

const defaultDependencies: GoatCodexBrainCaptureDependencies = {
  loadContext: loadGoatCodexBrainCaptureContext,
  getBrainAccess: (input) => getGoatBrainAccess(input),
  capture: captureToGoatBrainInbox,
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

  const access = await dependencies.getBrainAccess({
    userWorkosId: context.userWorkosId,
    brainRef: context.brainRef,
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
  if (!content && !sourceRef) {
    return { ok: false, error: "save_to_brain needs content or sourceRef." };
  }

  try {
    const captured = await dependencies.capture({
      brainRef: context.brainRef,
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
          brainRef: context.brainRef,
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
        eq(goatCodexChatSessions.hostToolContractVersion, GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION),
        eq(goatCodexChatTurns.status, "running"),
      ),
    )
    .limit(1);

  if (!row?.workspaceId || !row.brainRef) return null;
  return {
    userWorkosId: row.userWorkosId,
    workspaceId: row.workspaceId,
    brainRef: row.brainRef,
    chatSessionId: row.chatSessionId,
    userMessageId: row.userMessageId,
  };
}

function optionalString(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
