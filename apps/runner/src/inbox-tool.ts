import { randomUUID } from "node:crypto";
import { agentSessions, agents, type InboxItemArtifact, inboxItems } from "@opencompany/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";

// The inbox tools run in the runner process (kind: "internal"), not the sandbox: they write to
// Postgres directly (the sandbox has no DB access) and are hard-gated to the user's personal agent
// (see resolveRuntimeToolNamesForConfigTools `personalInboxEnabled`). Every operation is scoped to
// the current session's (workspace, user) so an agent can only touch the acting user's inbox.
//
// inbox_add does not need the lease/txid handshake the synchronous tools use: the user is not
// optimistically waiting on the write, and Electric streams the new row to the open /personal inbox.

type RecoverableError = {
  ok: false;
  error: { message: string; code: string; recoverable: boolean };
};

function invalidInput(message: string): RecoverableError {
  return { ok: false, error: { message, code: "invalid_tool_input", recoverable: true } };
}

type SessionScope = { workspaceId: string; userId: string; agentName: string };

async function resolveScope(sessionId: string): Promise<SessionScope | null> {
  const rows = await getDb()
    .select({
      workspaceId: agentSessions.workspaceId,
      userId: agentSessions.userId,
      agentName: agents.name,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

type InboxItemRow = typeof inboxItems.$inferSelect;

function serializeItem(row: InboxItemRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    steps: row.steps ?? [],
    priority: row.priority,
    dueAt: row.dueAt?.toISOString() ?? null,
    status: row.status,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    dedupKey: row.dedupKey,
    source: row.source,
    sourceSessionId: row.sourceSessionId,
    createdAt: row.createdAt.toISOString(),
  };
}

function parsePriority(value: unknown): "urgent" | "high" | "med" | "low" | undefined {
  return value === "urgent" || value === "high" || value === "med" || value === "low"
    ? value
    : undefined;
}

function parseDueAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseSteps(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.filter((step): step is string => typeof step === "string");
  return steps.length ? steps : undefined;
}

async function runInboxList(scope: SessionScope, args: Record<string, unknown>): Promise<unknown> {
  const includeResolved = args.include_resolved === true;
  const statuses: InboxItemRow["status"][] = includeResolved
    ? ["open", "snoozed", "done", "dismissed"]
    : ["open", "snoozed"];
  const rows = await getDb()
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, scope.workspaceId),
        eq(inboxItems.userId, scope.userId),
        inArray(inboxItems.status, statuses),
      ),
    )
    .orderBy(desc(inboxItems.createdAt))
    .limit(50);
  const items = rows.map(serializeItem);
  return { ok: true, itemCount: items.length, items };
}

async function findLiveByDedupKey(
  scope: SessionScope,
  dedupKey: string,
): Promise<InboxItemRow | undefined> {
  const rows = await getDb()
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, scope.workspaceId),
        eq(inboxItems.userId, scope.userId),
        eq(inboxItems.dedupKey, dedupKey),
        inArray(inboxItems.status, ["open", "snoozed"]),
      ),
    )
    .limit(1);
  return rows[0];
}

async function runInboxAdd(
  sessionId: string,
  scope: SessionScope,
  args: Record<string, unknown>,
): Promise<unknown> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return invalidInput("inbox_add requires a non-empty `title`.");

  const dueAt = parseDueAt(args.due_at);
  if (dueAt === undefined && args.due_at !== undefined) {
    return invalidInput("`due_at` must be an ISO-8601 timestamp.");
  }

  const dedupKey =
    typeof args.dedup_key === "string" && args.dedup_key.trim() ? args.dedup_key.trim() : null;

  if (dedupKey) {
    const existing = await findLiveByDedupKey(scope, dedupKey);
    if (existing) {
      return { ok: true, deduped: true, item: serializeItem(existing) };
    }
  }

  const body = typeof args.body === "string" && args.body.trim() ? args.body : null;
  const source =
    typeof args.source === "string" && args.source.trim() ? args.source.trim() : scope.agentName;
  const artifact: InboxItemArtifact = { kind: "fyi" };

  const values = {
    id: `inbox_${randomUUID()}`,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    sourceSessionId: sessionId,
    source,
    title,
    body,
    steps: parseSteps(args.steps) ?? null,
    priority: parsePriority(args.priority) ?? null,
    dueAt: dueAt ?? null,
    artifact,
    status: "open" as const,
    dedupKey,
  };

  try {
    const [inserted] = await getDb().insert(inboxItems).values(values).returning();
    return { ok: true, item: serializeItem(inserted!) };
  } catch (error) {
    // Lost a race on the live dedup unique index — return the winner instead of erroring.
    if (dedupKey && isUniqueViolation(error)) {
      const existing = await findLiveByDedupKey(scope, dedupKey);
      if (existing) return { ok: true, deduped: true, item: serializeItem(existing) };
    }
    throw error;
  }
}

async function runInboxUpdate(
  scope: SessionScope,
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return invalidInput("inbox_update requires the `id` of the item to update.");

  const update: Partial<typeof inboxItems.$inferInsert> = { updatedAt: new Date() };

  if (args.status !== undefined) {
    if (args.status !== "open" && args.status !== "done" && args.status !== "dismissed") {
      return invalidInput("`status` must be one of open, done, dismissed.");
    }
    update.status = args.status;
    update.resolvedAt = args.status === "open" ? null : new Date();
    if (args.status === "open") update.snoozedUntil = null;
  }
  if (typeof args.title === "string" && args.title.trim()) update.title = args.title.trim();
  if (typeof args.body === "string") update.body = args.body;
  if (args.priority !== undefined) {
    const priority = parsePriority(args.priority);
    if (!priority) return invalidInput("`priority` must be one of urgent, high, med, low.");
    update.priority = priority;
  }
  if (args.due_at !== undefined) {
    const dueAt = parseDueAt(args.due_at);
    if (dueAt === undefined) return invalidInput("`due_at` must be an ISO-8601 timestamp.");
    update.dueAt = dueAt;
  }

  const [updated] = await getDb()
    .update(inboxItems)
    .set(update)
    .where(
      and(
        eq(inboxItems.id, id),
        eq(inboxItems.workspaceId, scope.workspaceId),
        eq(inboxItems.userId, scope.userId),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      error: {
        message: `No inbox item ${id} found in this user's inbox.`,
        code: "inbox_item_not_found",
        recoverable: true,
      },
    };
  }
  return { ok: true, item: serializeItem(updated) };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export async function runInboxTool(input: {
  name: "inbox_list" | "inbox_add" | "inbox_update";
  sessionId: string;
  args: unknown;
}): Promise<unknown> {
  const scope = await resolveScope(input.sessionId);
  if (!scope) {
    return {
      ok: false,
      error: {
        message: "Could not resolve the current session to scope the inbox.",
        code: "session_not_found",
        recoverable: false,
      },
    };
  }
  const args = (input.args ?? {}) as Record<string, unknown>;
  switch (input.name) {
    case "inbox_list":
      return runInboxList(scope, args);
    case "inbox_add":
      return runInboxAdd(input.sessionId, scope, args);
    case "inbox_update":
      return runInboxUpdate(scope, args);
  }
}
