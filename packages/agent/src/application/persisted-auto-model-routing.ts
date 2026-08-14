import { getDb } from "@opencompany/db/client";
import {
  chatAttachmentUploads,
  chatCommandIdempotency,
  chatSessions,
  codexChatSessions,
  users,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { resolveAutoModel } from "../chat-model-router";
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
        return resolveAutoModel({ ...request, gatewayApiKey: input.gatewayApiKey });
      },
      now: () => new Date(),
    },
  });
}

async function loadEligibility(input: { actorId: string; workspaceId: string }, db: DbLike) {
  const [row] = await db
    .select({ enabled: users.autoModelRoutingEnabled, membershipId: workspaceMembers.id })
    .from(users)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userWorkosId, users.workosUserId),
        eq(workspaceMembers.workspaceId, input.workspaceId),
      ),
    )
    .where(eq(users.workosUserId, input.actorId))
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
    .select({ model: chatSessions.model })
    .from(chatCommandIdempotency)
    .innerJoin(chatSessions, eq(chatSessions.id, chatCommandIdempotency.conversationId))
    .where(
      and(
        eq(chatCommandIdempotency.userWorkosId, input.actorId),
        eq(chatCommandIdempotency.workspaceId, input.workspaceId),
        eq(chatCommandIdempotency.idempotencyKey, input.idempotencyKey),
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
    .select({ model: chatSessions.model })
    .from(chatSessions)
    .innerJoin(
      codexChatSessions,
      and(
        eq(codexChatSessions.chatSessionId, chatSessions.id),
        eq(codexChatSessions.userWorkosId, chatSessions.userWorkosId),
        eq(codexChatSessions.workspaceId, input.workspaceId),
        eq(codexChatSessions.engine, "opencompany"),
      ),
    )
    .where(
      and(eq(chatSessions.id, input.conversationId), eq(chatSessions.userWorkosId, input.actorId)),
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
    .select({ format: chatAttachmentUploads.format })
    .from(chatAttachmentUploads)
    .where(
      and(
        inArray(chatAttachmentUploads.id, [...input.attachmentIds]),
        eq(chatAttachmentUploads.userWorkosId, input.actorId),
        eq(chatAttachmentUploads.workspaceId, input.workspaceId),
        gt(chatAttachmentUploads.expiresAt, input.now),
        input.clientMessageId
          ? or(
              isNull(chatAttachmentUploads.claimedAt),
              eq(chatAttachmentUploads.claimedMessageId, input.clientMessageId),
            )
          : isNull(chatAttachmentUploads.claimedAt),
      ),
    )
    .limit(input.attachmentIds.length);
  return rows.map((row: { format: string }) => row.format);
}
