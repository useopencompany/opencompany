import { randomInt, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "./client";
import {
  chatSessions,
  codexChatSessions,
  imessageBindings as imessageTable,
  type ImessageBinding as PhoneChannelBinding,
  users,
  whatsappBindings,
  workspaceMembers,
} from "./product-schema";

type DbLike = any;

const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export function createPhoneChannelBindings(channel: "imessage" | "whatsapp") {
  const table = channel === "imessage" ? imessageTable : whatsappBindings;
  const enabledColumn = channel === "imessage" ? users.imessageEnabled : users.whatsappEnabled;
  async function getBinding(
    input: { userWorkosId: string },
    db: DbLike = getDb(),
  ): Promise<PhoneChannelBinding | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.userWorkosId, input.userWorkosId))
      .limit(1);
    return row ?? null;
  }

  // Mints (or re-mints) the link code the member texts to the shared line. Re-linking a
  // pending row just rotates its code; a linked row is left alone so the caller can show it.
  async function startLink(
    input: { userWorkosId: string; workspaceId: string; now?: Date },
    db: DbLike = getDb(),
  ): Promise<PhoneChannelBinding> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
    const existing = await getBinding(input, db);
    if (existing?.status === "linked") return existing;
    const linkCode = await unusedLinkCode(db, now);
    if (existing) {
      const [updated] = await db
        .update(table)
        .set({
          linkCode,
          linkCodeExpiresAt: expiresAt,
          workspaceId: input.workspaceId,
          updatedAt: now,
        })
        .where(eq(table.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(table)
      .values({
        id: `${channel}_binding_${randomUUID()}`,
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

  async function unlink(input: { userWorkosId: string }, db: DbLike = getDb()) {
    await db.delete(table).where(eq(table.userWorkosId, input.userWorkosId));
  }

  type LinkedBinding = {
    binding: PhoneChannelBinding;
    // Both must hold for a text to start a Run: the member still has the feature on and still
    // belongs to the bound workspace. The webhook answers with a fixed notice otherwise.
    enabled: boolean;
    workspaceRole: string | null;
  };

  async function findLinkedBinding(
    input: { handle: string },
    db: DbLike = getDb(),
  ): Promise<LinkedBinding | null> {
    const [row] = await db
      .select({
        binding: table,
        enabled: enabledColumn,
        workspaceRole: workspaceMembers.role,
      })
      .from(table)
      .innerJoin(users, eq(users.workosUserId, table.userWorkosId))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, table.workspaceId),
          eq(workspaceMembers.userWorkosId, table.userWorkosId),
        ),
      )
      .where(and(eq(table.handle, input.handle), eq(table.status, "linked")))
      .limit(1);
    if (!row) return null;
    return {
      binding: row.binding,
      enabled: row.enabled === true,
      workspaceRole: row.workspaceRole ?? null,
    };
  }

  // Binds the texting handle to the pending row that holds this code, creating the personal-agent
  // Conversation and its workspace-bound idle runtime in the same transaction. Returns null when no
  // live pending code matches, when the handle is already paired elsewhere, or when the member
  // turned the feature off after requesting the code.
  async function completeLink(
    input: { code: string; handle: string; model: string; now?: Date },
    db: DbLike = getDb(),
  ): Promise<PhoneChannelBinding | null> {
    const now = input.now ?? new Date();
    return db.transaction(async (tx: DbLike) => {
      const [pending] = await tx
        .select({ binding: table, enabled: enabledColumn })
        .from(table)
        .innerJoin(users, eq(users.workosUserId, table.userWorkosId))
        .where(
          and(
            eq(table.status, "pending"),
            eq(table.linkCode, input.code.trim()),
            gt(table.linkCodeExpiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      if (!pending || !pending.enabled) return null;
      const [membership] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, pending.binding.workspaceId),
            eq(workspaceMembers.userWorkosId, pending.binding.userWorkosId),
          ),
        )
        .limit(1);
      if (!membership) return null;
      const taken = await tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.handle, input.handle))
        .limit(1);
      if (taken.length > 0) return null;

      const conversationId = `conversation_${randomUUID()}`;
      await tx.insert(chatSessions).values({
        id: conversationId,
        userWorkosId: pending.binding.userWorkosId,
        title: channel === "imessage" ? "iMessage" : "WhatsApp",
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
        .update(table)
        .set({
          status: "linked",
          handle: input.handle,
          conversationId,
          linkCode: null,
          linkCodeExpiresAt: null,
          linkedAt: now,
          updatedAt: now,
        })
        .where(eq(table.id, pending.binding.id))
        .returning();
      return linked ?? null;
    });
  }

  async function touchInbound(input: { bindingId: string; at?: Date }, db: DbLike = getDb()) {
    const at = input.at ?? new Date();
    await db
      .update(table)
      .set({ lastInboundAt: at, updatedAt: at })
      .where(eq(table.id, input.bindingId));
  }

  // The runner resolves the binding from the Conversation a turn belongs to, so the send tool can
  // address the paired handle without trusting anything in the prompt.
  async function getBindingForConversation(
    input: { conversationId: string; userWorkosId: string },
    db: DbLike = getDb(),
  ): Promise<PhoneChannelBinding | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.conversationId, input.conversationId),
          eq(table.userWorkosId, input.userWorkosId),
          eq(table.status, "linked"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function unusedLinkCode(db: DbLike, now: Date) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomInt(0, channel === "whatsapp" ? 1_000_000_000_000 : 1_000_000)
        .toString()
        .padStart(channel === "whatsapp" ? 12 : 6, "0");
      const [clash] = await db
        .select({ id: table.id })
        .from(table)
        .where(
          and(eq(table.linkCode, code), gt(table.linkCodeExpiresAt, now), isNull(table.handle)),
        )
        .limit(1);
      if (!clash) return code;
    }
    throw new Error("Could not allocate a phone link code.");
  }

  return {
    getBinding: getBinding,
    startLink: startLink,
    unlink: unlink,
    findLinked: findLinkedBinding,
    completeLink: completeLink,
    touchInbound: touchInbound,
    getForConversation: getBindingForConversation,
  };
}
