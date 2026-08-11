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
import {
  executeGoatBrainCaptureService,
  type GoatBrainCaptureCommand,
  type GoatBrainCaptureContext,
  type GoatBrainCaptureServiceDependencies,
} from "@opencompany/goat-agent/application/brain-capture";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray } from "drizzle-orm";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { saveChatAttachmentsToGoatBrain } from "@/lib/chat-attachment-capture";

const logger = createLogger({
  service: "opencompany-goat",
  runtime: "codex-brain-capture",
});

const defaultDependencies: GoatBrainCaptureServiceDependencies = {
  loadContext: loadGoatCodexBrainCaptureContext,
  defaultBrainSlug: DEFAULT_GOAT_BRAIN_SLUG,
  getBrainAccess: ({ actorId, brainRef }) =>
    getGoatBrainAccess({ userWorkosId: actorId, brainRef }),
  listBrains: ({ actorId, workspaceId }) =>
    listAccessibleGoatBrains({ userWorkosId: actorId, workspaceId }),
  capture: ({ actorId, ...input }) => captureToGoatBrainInbox({ userWorkosId: actorId, ...input }),
  loadMessages: async (conversationId) => {
    const rows = await getDb()
      .select({ role: goatChatMessages.role, attachments: goatChatMessages.attachments })
      .from(goatChatMessages)
      .where(eq(goatChatMessages.sessionId, conversationId));
    return rows.filter(
      (
        row,
      ): row is typeof row & {
        role: "user" | "assistant";
      } => row.role === "user" || row.role === "assistant",
    );
  },
  saveAttachments: ({ actorId, ...input }) =>
    saveChatAttachmentsToGoatBrain({ userWorkosId: actorId, ...input }),
  onError: (error, command) => {
    logger.error("Codex Brain capture failed", {
      event: "goat.codex_brain_capture_failed",
      codex_chat_session_id: command.sessionId,
      codex_chat_turn_id: command.runId,
      error: error instanceof Error ? error.message : "Unknown capture error.",
    });
  },
};

export async function executeGoatCodexBrainCaptureGateway(input: {
  request: GoatCodexBrainCaptureGatewayRequest;
  dependencies?: Partial<GoatBrainCaptureServiceDependencies>;
}): Promise<GoatCodexBrainCaptureGatewayResponse> {
  return executeGoatBrainCaptureService({
    command: brainCaptureCommand(input.request),
    dependencies: { ...defaultDependencies, ...input.dependencies },
  });
}

async function loadGoatCodexBrainCaptureContext(
  command: GoatBrainCaptureCommand,
): Promise<GoatBrainCaptureContext | null> {
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
        eq(goatCodexChatTurns.id, command.runId),
        eq(goatCodexChatTurns.codexChatSessionId, goatCodexChatSessions.id),
        eq(goatCodexChatTurns.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(goatCodexChatSessions.id, command.sessionId),
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
    actorId: row.userWorkosId,
    workspaceId: row.workspaceId,
    brainRef: row.brainRef,
    allowDefaultBrain: row.engine === "opencompany",
    conversationId: row.chatSessionId,
    messageId: row.userMessageId,
  };
}

function brainCaptureCommand(
  request: GoatCodexBrainCaptureGatewayRequest,
): GoatBrainCaptureCommand {
  const { codexChatSessionId, codexChatTurnId, ...input } = request;
  return { ...input, sessionId: codexChatSessionId, runId: codexChatTurnId };
}
