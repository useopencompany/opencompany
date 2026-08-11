import { getDb } from "@opencompany/db/client";
import {
  goatChatAttachmentUploads,
  goatChatCommandIdempotency,
  goatChatSessions,
  goatCodexChatSessions,
  goatUsers,
  goatWorkspaceMembers,
} from "@opencompany/db/goat-schema";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { resolveAutoGoatModel } from "../chat-model-router";
import {
  AutoModelRoutingError,
  type AutoModelRoutingResolution,
  resolveAutoModelRouting,
} from "./auto-model-routing";

type DbLike = any;

export async function resolvePersistedAutoModelRouting(input: {
  actorId: string;
  workspaceId: string;
  idempotencyKey: string;
  conversationId?: string;
  clientMessageId?: string;
  prompt: string;
  attachmentIds: readonly string[];
  gatewayApiKey: string | undefined;
  db?: DbLike;
}): Promise<AutoModelRoutingResolution> {
  const db = input.db ?? getDb();
  return resolveAutoModelRouting({
    ...input,
    dependencies: {
      loadEligibility: (request) => loadEligibility(request, db),
      loadIdempotentModel: (request) => loadIdempotentModel(request, db),
      loadConversationModel: (request) => loadConversationModel(request, db),
      loadAttachmentFormats: (request) => loadAttachmentFormats(request, db),
      route: async (request) => {
        if (!input.gatewayApiKey) {
          throw new AutoModelRoutingError("unavailable", "Chat model routing is not configured.");
        }
        return resolveAutoGoatModel({ ...request, gatewayApiKey: input.gatewayApiKey });
      },
      now: () => new Date(),
    },
  });
}

async function loadEligibility(input: { actorId: string; workspaceId: string }, db: DbLike) {
  const [row] = await db
    .select({ enabled: goatUsers.autoModelRoutingEnabled, membershipId: goatWorkspaceMembers.id })
    .from(goatUsers)
    .innerJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.userWorkosId, goatUsers.workosUserId),
        eq(goatWorkspaceMembers.workspaceId, input.workspaceId),
      ),
    )
    .where(eq(goatUsers.workosUserId, input.actorId))
    .limit(1);
  return { isMember: Boolean(row?.membershipId), enabled: row?.enabled === true };
}

async function loadIdempotentModel(
  input: {
    actorId: string;
    workspaceId: string;
    idempotencyKey: string;
  },
  db: DbLike,
) {
  const [row] = await db
    .select({ model: goatChatSessions.model })
    .from(goatChatCommandIdempotency)
    .innerJoin(goatChatSessions, eq(goatChatSessions.id, goatChatCommandIdempotency.conversationId))
    .where(
      and(
        eq(goatChatCommandIdempotency.userWorkosId, input.actorId),
        eq(goatChatCommandIdempotency.workspaceId, input.workspaceId),
        eq(goatChatCommandIdempotency.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  return row?.model ?? null;
}

async function loadConversationModel(
  input: {
    actorId: string;
    workspaceId: string;
    conversationId: string;
  },
  db: DbLike,
) {
  const [row] = await db
    .select({ model: goatChatSessions.model })
    .from(goatChatSessions)
    .innerJoin(
      goatCodexChatSessions,
      and(
        eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id),
        eq(goatCodexChatSessions.userWorkosId, goatChatSessions.userWorkosId),
        eq(goatCodexChatSessions.workspaceId, input.workspaceId),
        eq(goatCodexChatSessions.engine, "opencompany"),
      ),
    )
    .where(
      and(
        eq(goatChatSessions.id, input.conversationId),
        eq(goatChatSessions.userWorkosId, input.actorId),
      ),
    )
    .limit(1);
  return row?.model ?? null;
}

async function loadAttachmentFormats(
  input: {
    actorId: string;
    workspaceId: string;
    clientMessageId: string | undefined;
    attachmentIds: readonly string[];
    now: Date;
  },
  db: DbLike,
) {
  if (input.attachmentIds.length === 0) return [];
  const rows = await db
    .select({ format: goatChatAttachmentUploads.format })
    .from(goatChatAttachmentUploads)
    .where(
      and(
        inArray(goatChatAttachmentUploads.id, [...input.attachmentIds]),
        eq(goatChatAttachmentUploads.userWorkosId, input.actorId),
        eq(goatChatAttachmentUploads.workspaceId, input.workspaceId),
        gt(goatChatAttachmentUploads.expiresAt, input.now),
        input.clientMessageId
          ? or(
              isNull(goatChatAttachmentUploads.claimedAt),
              eq(goatChatAttachmentUploads.claimedMessageId, input.clientMessageId),
            )
          : isNull(goatChatAttachmentUploads.claimedAt),
      ),
    )
    .limit(input.attachmentIds.length);
  return rows.map((row: { format: string }) => row.format);
}
