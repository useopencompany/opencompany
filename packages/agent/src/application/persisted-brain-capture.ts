import {
  ACTION_HOST_TOOL_CONTRACT_VERSIONS,
  CHAT_HOST_TOOL_CONTRACT_VERSIONS,
  type CodexBrainCaptureGatewayRequest,
  type CodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  chatMessages,
  codexChatSessions,
  codexChatTurns,
  workspaces,
} from "@opencompany/db/product-schema";
import {
  DEFAULT_BRAIN_SLUG,
  getBrainAccess,
  listAccessibleBrains,
} from "@opencompany/db/workspaces";
import { and, eq, inArray } from "drizzle-orm";
import { createBrainAssetForUser } from "../brain-assets";
import { captureToBrainInbox } from "../brain-capture";
import { nextAvailableBrainId } from "../brain-files";
import {
  type ChatAttachmentCaptureDependencies,
  saveChatAttachmentsToBrain,
} from "../chat-attachment-capture";
import { copyChatAttachmentToBrain, downloadChatAttachment } from "../chat-attachment-storage";
import {
  type BrainCaptureCommand,
  type BrainCaptureContext,
  type BrainCaptureServiceDependencies,
  executeBrainCaptureService,
} from "./brain-capture";

export type PersistedBrainCaptureDependencies = Pick<BrainCaptureServiceDependencies, "onError"> & {
  wakeIngest: () => Promise<unknown>;
  service?: Partial<BrainCaptureServiceDependencies>;
};

export function executePersistedBrainCapture(input: {
  request: CodexBrainCaptureGatewayRequest;
  dependencies: PersistedBrainCaptureDependencies;
}): Promise<CodexBrainCaptureGatewayResponse> {
  const attachmentDependencies: ChatAttachmentCaptureDependencies = {
    downloadAttachment: downloadChatAttachment,
    copyToBrain: copyChatAttachmentToBrain,
    createBrainAsset: ({ actorId, ...asset }) =>
      createBrainAssetForUser({ ...asset, userWorkosId: actorId }),
    wakeIngest: input.dependencies.wakeIngest,
  };
  const dependencies: BrainCaptureServiceDependencies = {
    loadContext: loadCodexBrainCaptureContext,
    defaultBrainSlug: DEFAULT_BRAIN_SLUG,
    getBrainAccess: ({ actorId, brainRef }) => getBrainAccess({ userWorkosId: actorId, brainRef }),
    listBrains: ({ actorId, workspaceId }) =>
      listAccessibleBrains({ userWorkosId: actorId, workspaceId }),
    capture: ({ actorId, ...command }) =>
      captureToBrainInbox(
        { ...command, actorId },
        {
          nextAvailableBrainId: nextAvailableBrainId,
          wakeIngest: input.dependencies.wakeIngest,
        },
      ),
    loadMessages: async (conversationId) => {
      const rows = await getDb()
        .select({ role: chatMessages.role, attachments: chatMessages.attachments })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, conversationId));
      return rows.filter(
        (
          row,
        ): row is typeof row & {
          role: "user" | "assistant";
        } => row.role === "user" || row.role === "assistant",
      );
    },
    saveAttachments: (command) => saveChatAttachmentsToBrain(command, attachmentDependencies),
    ...(input.dependencies.onError ? { onError: input.dependencies.onError } : {}),
    ...input.dependencies.service,
  };
  return executeBrainCaptureService({
    command: brainCaptureCommand(input.request),
    dependencies,
  });
}

async function loadCodexBrainCaptureContext(
  command: BrainCaptureCommand,
): Promise<BrainCaptureContext | null> {
  const [row] = await getDb()
    .select({
      userWorkosId: codexChatSessions.userWorkosId,
      workspaceId: codexChatSessions.workspaceId,
      brainRef: codexChatSessions.brainRef,
      chatSessionId: codexChatSessions.chatSessionId,
      userMessageId: codexChatTurns.userMessageId,
      engine: codexChatSessions.engine,
    })
    .from(codexChatSessions)
    .innerJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.id, command.runId),
        eq(codexChatTurns.codexChatSessionId, codexChatSessions.id),
        eq(codexChatTurns.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, codexChatSessions.workspaceId))
    .where(
      and(
        eq(codexChatSessions.id, command.sessionId),
        inArray(codexChatSessions.hostToolContractVersion, [
          ...ACTION_HOST_TOOL_CONTRACT_VERSIONS,
          ...CHAT_HOST_TOOL_CONTRACT_VERSIONS,
        ]),
        eq(codexChatTurns.status, "running"),
        eq(workspaces.legacyBrainEnabled, true),
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

function brainCaptureCommand(request: CodexBrainCaptureGatewayRequest): BrainCaptureCommand {
  const { codexChatSessionId, codexChatTurnId, ...command } = request;
  return { ...command, sessionId: codexChatSessionId, runId: codexChatTurnId };
}
