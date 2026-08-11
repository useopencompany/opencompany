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
import { and, eq, inArray } from "drizzle-orm";
import { createGoatBrainAssetForUser } from "../brain-assets";
import { captureToGoatBrainInbox } from "../brain-capture";
import { nextAvailableGoatBrainId } from "../brain-files";
import {
  type GoatChatAttachmentCaptureDependencies,
  saveChatAttachmentsToGoatBrain,
} from "../chat-attachment-capture";
import {
  copyGoatChatAttachmentToBrain,
  downloadGoatChatAttachment,
} from "../chat-attachment-storage";
import {
  executeGoatBrainCaptureService,
  type GoatBrainCaptureCommand,
  type GoatBrainCaptureContext,
  type GoatBrainCaptureServiceDependencies,
} from "./brain-capture";

export type PersistedGoatBrainCaptureDependencies = Pick<
  GoatBrainCaptureServiceDependencies,
  "onError"
> & {
  wakeIngest: () => Promise<unknown>;
  service?: Partial<GoatBrainCaptureServiceDependencies>;
};

export function executePersistedGoatBrainCapture(input: {
  request: GoatCodexBrainCaptureGatewayRequest;
  dependencies: PersistedGoatBrainCaptureDependencies;
}): Promise<GoatCodexBrainCaptureGatewayResponse> {
  const attachmentDependencies: GoatChatAttachmentCaptureDependencies = {
    downloadAttachment: downloadGoatChatAttachment,
    copyToBrain: copyGoatChatAttachmentToBrain,
    createBrainAsset: ({ actorId, ...asset }) =>
      createGoatBrainAssetForUser({ ...asset, userWorkosId: actorId }),
    wakeIngest: input.dependencies.wakeIngest,
  };
  const dependencies: GoatBrainCaptureServiceDependencies = {
    loadContext: loadGoatCodexBrainCaptureContext,
    defaultBrainSlug: DEFAULT_GOAT_BRAIN_SLUG,
    getBrainAccess: ({ actorId, brainRef }) =>
      getGoatBrainAccess({ userWorkosId: actorId, brainRef }),
    listBrains: ({ actorId, workspaceId }) =>
      listAccessibleGoatBrains({ userWorkosId: actorId, workspaceId }),
    capture: ({ actorId, ...command }) =>
      captureToGoatBrainInbox(
        { ...command, actorId },
        {
          nextAvailableBrainId: nextAvailableGoatBrainId,
          wakeIngest: input.dependencies.wakeIngest,
        },
      ),
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
    saveAttachments: (command) => saveChatAttachmentsToGoatBrain(command, attachmentDependencies),
    ...(input.dependencies.onError ? { onError: input.dependencies.onError } : {}),
    ...input.dependencies.service,
  };
  return executeGoatBrainCaptureService({
    command: brainCaptureCommand(input.request),
    dependencies,
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
  const { codexChatSessionId, codexChatTurnId, ...command } = request;
  return { ...command, sessionId: codexChatSessionId, runId: codexChatTurnId };
}
