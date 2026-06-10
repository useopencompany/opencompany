import { agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";

// The `fetch_transcript` tool runs in the runner process (kind: "internal"), not the sandbox: it
// queries Postgres directly (the sandbox has no DB access). It returns the full, ordered transcript
// of one session, scoped so a caller can only read its own sessions (same workspace + user + agent)
// or the parent session it was explicitly spawned to review (the memory-keeper case).
export async function runFetchTranscriptTool(input: {
  callerSessionId: string;
  args: unknown;
}): Promise<unknown> {
  const targetSessionId = parseFetchTranscriptArgs(input.args);
  if (!targetSessionId) {
    return {
      ok: false,
      error: {
        message: "fetch_transcript requires a non-empty `sessionId` string.",
        code: "invalid_tool_input",
        recoverable: true,
      },
    };
  }

  const db = getDb();
  const [caller, target] = await Promise.all([
    db
      .select({
        workspaceId: agentSessions.workspaceId,
        userId: agentSessions.userId,
        agentId: agentSessions.agentId,
        parentSessionId: agentSessions.parentSessionId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.callerSessionId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        workspaceId: agentSessions.workspaceId,
        userId: agentSessions.userId,
        agentId: agentSessions.agentId,
        title: agentSessions.title,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, targetSessionId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  if (!caller) {
    return {
      ok: false,
      error: {
        message: "Could not resolve the current session to scope fetch_transcript.",
        code: "session_not_found",
        recoverable: false,
      },
    };
  }
  if (!target) {
    return {
      ok: false,
      error: {
        message: `No session found with id ${targetSessionId}.`,
        code: "session_not_found",
        recoverable: true,
      },
    };
  }

  if (!transcriptAccessAllowed(caller, target, targetSessionId)) {
    return {
      ok: false,
      error: {
        message: "You can only fetch transcripts of your own sessions with this user.",
        code: "forbidden",
        recoverable: false,
      },
    };
  }

  const rows = await db
    .select({
      role: agentSessionMessages.role,
      content: agentSessionMessages.content,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, targetSessionId),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .orderBy(asc(agentSessionMessages.createdAt));

  const lines = formatTranscriptLines(rows);

  return {
    ok: true,
    sessionId: targetSessionId,
    title: target.title,
    messageCount: lines.length,
    transcript: lines.join("\n\n"),
  };
}

// Authorization: same workspace and user, and either the target is the session this caller was
// spawned to review (parentSessionId match — lets a memory-keeper read across agent ids), or the
// target belongs to the same agent (lets a live agent read its own past sessions).
export function transcriptAccessAllowed(
  caller: { workspaceId: string; userId: string; agentId: string; parentSessionId: string | null },
  target: { workspaceId: string; userId: string; agentId: string },
  targetSessionId: string,
): boolean {
  const sameTenant = caller.workspaceId === target.workspaceId && caller.userId === target.userId;
  if (!sameTenant) return false;
  const isParent = caller.parentSessionId === targetSessionId;
  const sameAgent = caller.agentId === target.agentId;
  return isParent || sameAgent;
}

// Renders ordered, already-internal-filtered message rows into readable "Role: text" lines,
// dropping any whose content is empty after trimming.
export function formatTranscriptLines(rows: ReadonlyArray<{ role: string; content: string }>) {
  return rows
    .map((row) => ({ role: formatRole(row.role), content: row.content.trim() }))
    .filter((row) => row.content.length > 0)
    .map((row) => `${row.role}: ${row.content}`);
}

function formatRole(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function parseFetchTranscriptArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  return typeof record.sessionId === "string" ? record.sessionId.trim() : "";
}
