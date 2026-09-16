import { randomInt, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "./client";
import {
  chatSessions,
  codexChatSessions,
  type ImessageBinding,
  imessageBindings,
  users,
  workspaceMembers,
} from "./product-schema";

type DbLike = any;

export const IMESSAGE_LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_PATTERN = /^\d{6}$/;

export function isImessageLinkCode(text: string) {
  return LINK_CODE_PATTERN.test(text.trim());
}

export async function getImessageBinding(
  input: { userWorkosId: string },
  db: DbLike = getDb(),
): Promise<ImessageBinding | null> {
  const [row] = await db
    .select()
    .from(imessageBindings)
    .where(eq(imessageBindings.userWorkosId, input.userWorkosId))
    .limit(1);
  return row ?? null;
}

// Mints (or re-mints) the six-digit code the member texts to the shared line. Re-linking a
// pending row just rotates its code; a linked row is left alone so the caller can show it.
export async function startImessageLink(
  input: { userWorkosId: string; workspaceId: string; now?: Date },
  db: DbLike = getDb(),
): Promise<ImessageBinding> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + IMESSAGE_LINK_CODE_TTL_MS);
  const existing = await getImessageBinding(input, db);
  if (existing?.status === "linked") return existing;
  const linkCode = await unusedLinkCode(db, now);
  if (existing) {
    const [updated] = await db
      .update(imessageBindings)
      .set({
        linkCode,
        linkCodeExpiresAt: expiresAt,
        workspaceId: input.workspaceId,
        updatedAt: now,
      })
      .where(eq(imessageBindings.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(imessageBindings)
    .values({
      id: `imessage_binding_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      status: "pending",
      linkCode,
      linkCodeExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

export async function deleteImessageBinding(input: { userWorkosId: string }, db: DbLike = getDb()) {
  await db.delete(imessageBindings).where(eq(imessageBindings.userWorkosId, input.userWorkosId));
}

export type LinkedImessageBinding = {
  binding: ImessageBinding;
  // Both must hold for a text to start a Run: the member still has the feature on and still
  // belongs to the bound workspace. The webhook answers with a fixed notice otherwise.
  imessageEnabled: boolean;
  workspaceRole: string | null;
};

export async function findLinkedImessageBinding(
  input: { handle: string },
  db: DbLike = getDb(),
): Promise<LinkedImessageBinding | null> {
  const [row] = await db
    .select({
      binding: imessageBindings,
      imessageEnabled: users.imessageEnabled,
      workspaceRole: workspaceMembers.role,
    })
    .from(imessageBindings)
    .innerJoin(users, eq(users.workosUserId, imessageBindings.userWorkosId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, imessageBindings.workspaceId),
        eq(workspaceMembers.userWorkosId, imessageBindings.userWorkosId),
      ),
    )
    .where(and(eq(imessageBindings.handle, input.handle), eq(imessageBindings.status, "linked")))
    .limit(1);
  if (!row) return null;
  return {
    binding: row.binding,
    imessageEnabled: row.imessageEnabled === true,
    workspaceRole: row.workspaceRole ?? null,
  };
}

// Binds the texting handle to the pending row that holds this code, creating the personal-agent
// Conversation and its workspace-bound idle runtime in the same transaction. Returns null when no
// live pending code matches, when the handle is already paired elsewhere, or when the member
// turned the feature off after requesting the code.
export async function completeImessageLink(
  input: { code: string; handle: string; model: string; now?: Date },
  db: DbLike = getDb(),
): Promise<ImessageBinding | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx: DbLike) => {
    const [pending] = await tx
      .select({ binding: imessageBindings, enabled: users.imessageEnabled })
      .from(imessageBindings)
      .innerJoin(users, eq(users.workosUserId, imessageBindings.userWorkosId))
      .where(
        and(
          eq(imessageBindings.status, "pending"),
          eq(imessageBindings.linkCode, input.code.trim()),
          gt(imessageBindings.linkCodeExpiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!pending || !pending.enabled) return null;
    const taken = await tx
      .select({ id: imessageBindings.id })
      .from(imessageBindings)
      .where(eq(imessageBindings.handle, input.handle))
      .limit(1);
    if (taken.length > 0) return null;

    const conversationId = `conversation_${randomUUID()}`;
    await tx.insert(chatSessions).values({
      id: conversationId,
      userWorkosId: pending.binding.userWorkosId,
      title: "iMessage",
      model: input.model,
      engine: "opencompany",
      kind: "chat",
    });
    await tx.insert(codexChatSessions).values({
      id: randomUUID(),
      userWorkosId: pending.binding.userWorkosId,
      chatSessionId: conversationId,
      workspaceId: pending.binding.workspaceId,
      engine: "opencompany",
      harness: "personal_agent",
      model: input.model,
      status: "idle",
    });
    const [linked] = await tx
      .update(imessageBindings)
      .set({
        status: "linked",
        handle: input.handle,
        conversationId,
        linkCode: null,
        linkCodeExpiresAt: null,
        linkedAt: now,
        updatedAt: now,
      })
      .where(eq(imessageBindings.id, pending.binding.id))
      .returning();
    return linked ?? null;
  });
}

export async function touchImessageBindingInbound(
  input: { bindingId: string; at?: Date },
  db: DbLike = getDb(),
) {
  const at = input.at ?? new Date();
  await db
    .update(imessageBindings)
    .set({ lastInboundAt: at, updatedAt: at })
    .where(eq(imessageBindings.id, input.bindingId));
}

// The runner resolves the binding from the Conversation a turn belongs to, so the send tool can
// address the paired handle without trusting anything in the prompt.
export async function getImessageBindingForConversation(
  input: { conversationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<ImessageBinding | null> {
  const [row] = await db
    .select()
    .from(imessageBindings)
    .where(
      and(
        eq(imessageBindings.conversationId, input.conversationId),
        eq(imessageBindings.userWorkosId, input.userWorkosId),
        eq(imessageBindings.status, "linked"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function unusedLinkCode(db: DbLike, now: Date) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const [clash] = await db
      .select({ id: imessageBindings.id })
      .from(imessageBindings)
      .where(
        and(
          eq(imessageBindings.linkCode, code),
          gt(imessageBindings.linkCodeExpiresAt, now),
          isNull(imessageBindings.handle),
        ),
      )
      .limit(1);
    if (!clash) return code;
  }
  throw new Error("Could not allocate an iMessage link code.");
}
