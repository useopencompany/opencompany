import { agentToolApprovals } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

// The approval flow no longer blocks in-run: a tool that hits an "ask" gate suspends the
// whole run (see RunSuspendedError) and the approval row is the durable handoff. The
// resume run reads the decided row here to know whether to execute or deny the tool. The
// 7-day backstop that auto-denies an undecided approval lives in the web cron sweep, not
// in a per-run timer (the run has already exited).

export type ToolApprovalRow = {
  status: "pending" | "approved" | "denied";
  decisionSource: "user" | "timeout" | "abort" | null;
  messageId: string | null;
  toolName: string;
  providerKey: string;
  permissionGroup: "read" | "post" | "modify" | "admin";
};

export async function loadToolApproval(
  sessionId: string,
  toolCallId: string,
): Promise<ToolApprovalRow | null> {
  const [row] = await getDb()
    .select({
      status: agentToolApprovals.status,
      decisionSource: agentToolApprovals.decisionSource,
      messageId: agentToolApprovals.messageId,
      toolName: agentToolApprovals.toolName,
      providerKey: agentToolApprovals.providerKey,
      permissionGroup: agentToolApprovals.permissionGroup,
    })
    .from(agentToolApprovals)
    .where(
      and(
        eq(agentToolApprovals.sessionId, sessionId),
        eq(agentToolApprovals.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  return row ?? null;
}
