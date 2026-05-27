import { getDb } from "@opencompany/db/client";
import { agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { appendRuntimeEvent } from "./events";
import {
  claimRunLease as claimDbRunLease,
  finishRunLease as finishDbRunLease,
} from "./run-control";

export async function acquireRunLease(input: {
  sessionId: string;
  messageId: string;
  leaseId: string;
  leaseOwner: string;
  modelProvider: string;
  modelName: string;
}) {
  return claimDbRunLease(input);
}

export async function isRunLeaseCurrent(sessionId: string, leaseId: string, leaseOwner: string) {
  const [session] = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  return Boolean(session);
}

export async function updateSandboxForLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  sandboxId: string,
) {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ e2bSandboxId: sandboxId, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

export async function createAssistantMessageForLease(input: {
  id: string;
  sessionId: string;
  responseToMessageId?: string;
  leaseId: string;
  leaseOwner: string;
  internal?: boolean;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const insert = getDb()
    .insert(agentSessionMessages)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      role: "assistant",
      status: "running",
      internal: input.internal ?? false,
      responseToMessageId: input.responseToMessageId ?? null,
    });
  // Regular assistant responses are idempotent by responseToMessageId. Internal
  // after-session messages do not respond to a user message, so their duplicate
  // guard lives at the after-session run/lease layer instead.
  const [message] = await (input.responseToMessageId
    ? insert
        .onConflictDoNothing({ target: agentSessionMessages.responseToMessageId })
        .returning({ id: agentSessionMessages.id })
    : insert.returning({ id: agentSessionMessages.id }));

  if (!message) {
    if (!input.responseToMessageId) return false;

    const [existing] = await getDb()
      .select({ id: agentSessionMessages.id, status: agentSessionMessages.status })
      .from(agentSessionMessages)
      .where(
        and(
          eq(agentSessionMessages.sessionId, input.sessionId),
          eq(agentSessionMessages.responseToMessageId, input.responseToMessageId),
        ),
      )
      .limit(1);

    return Boolean(existing && existing.id === input.id && existing.status !== "completed");
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.id,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "message.created",
      payload: { messageId: input.id, role: "assistant", internal: input.internal ?? false },
    }),
  );
  return true;
}

export async function completeAssistantMessageForLease(input: {
  sessionId: string;
  assistantMessageId: string;
  leaseId: string;
  leaseOwner: string;
  content: string;
  modelMessage: Record<string, unknown>;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const [updated] = await getDb()
    .update(agentSessionMessages)
    .set({
      status: "completed",
      content: input.content,
      modelMessage: input.modelMessage,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionMessages.id, input.assistantMessageId),
        eq(agentSessionMessages.sessionId, input.sessionId),
      ),
    )
    .returning({ id: agentSessionMessages.id });

  return Boolean(updated);
}

export async function insertToolMessageForLease(input: {
  id: string;
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
  content: string;
  modelMessage: Record<string, unknown>;
  toolName: string;
  toolCallId: string;
  internal?: boolean;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const [message] = await getDb()
    .insert(agentSessionMessages)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      role: "tool",
      status: "completed",
      internal: input.internal ?? false,
      content: input.content,
      modelMessage: input.modelMessage,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      completedAt: new Date(),
    })
    .returning({ id: agentSessionMessages.id });

  return Boolean(message);
}

export async function appendRuntimeEventForLease(
  input: Parameters<typeof appendRuntimeEvent>[1] & { leaseId: string; leaseOwner: string },
) {
  const { leaseId, leaseOwner, ...event } = input;
  if (!(await isRunLeaseCurrent(input.sessionId, leaseId, leaseOwner))) return false;
  await appendRuntimeEvent(getDb(), event);
  return true;
}

export async function releaseRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "completed",
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: null });
}

export async function failRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "aborting" | "failed",
  message: string,
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: message });
}

export async function requireLeaseWrite(write: Promise<boolean> | boolean) {
  if (!(await write)) {
    throw new StaleRunLeaseError();
  }
}

export class StaleRunLeaseError extends Error {
  constructor() {
    super("Run lease is no longer current.");
  }
}
