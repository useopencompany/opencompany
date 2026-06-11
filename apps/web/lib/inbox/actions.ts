"use server";

import { getDb } from "@opencompany/db/client";
import { inboxItems } from "@opencompany/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";
import { batchWithTxid } from "@/lib/db/txid";

// Fixed snooze window: a snoozed item drops out of the user's inbox for this long, then reappears.
const SNOOZE_HOURS = 6;

type InboxActionResult = { ok: true; txid: number } | { ok: false; error: string };

// Shared write: flip an item the current user owns to a new lifecycle state, returning the txid
// Electric reconciles the optimistic mutation against. Scoped to (workspace, user) so a user can
// only triage their own inbox. `extraSet` carries status-specific columns (snoozed_until / resolved_at).
async function transitionInboxItem(
  itemId: string,
  status: "snoozed" | "done" | "dismissed",
  extraSet: Record<string, unknown>,
): Promise<InboxActionResult> {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  const txid = await batchWithTxid(
    db
      .update(inboxItems)
      .set({ status, updatedAt: new Date(), ...extraSet })
      .where(
        and(
          eq(inboxItems.id, itemId),
          eq(inboxItems.workspaceId, workspace.id),
          eq(inboxItems.userId, user.id),
          // Only live items can be triaged; a no-op on an already-resolved item still returns a txid.
          inArray(inboxItems.status, ["open", "snoozed"]),
        ),
      ),
  );
  return { ok: true, txid };
}

export async function snoozeInboxItem(itemId: string): Promise<InboxActionResult> {
  return transitionInboxItem(itemId, "snoozed", {
    snoozedUntil: sql`now() + interval '${sql.raw(String(SNOOZE_HOURS))} hours'`,
    resolvedAt: null,
  });
}

export async function completeInboxItem(itemId: string): Promise<InboxActionResult> {
  return transitionInboxItem(itemId, "done", { resolvedAt: new Date() });
}

export async function dismissInboxItem(itemId: string): Promise<InboxActionResult> {
  return transitionInboxItem(itemId, "dismissed", { resolvedAt: new Date() });
}
