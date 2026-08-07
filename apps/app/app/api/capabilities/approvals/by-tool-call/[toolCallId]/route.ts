import {
  getCapabilityApprovalByToolCall,
  getCapabilitySessionBudgetUsdMicros,
} from "@opencompany/db/capabilities";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ toolCallId: string }> },
) {
  const context = await currentUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { toolCallId } = await params;
  const [row, sessionBudgetUsdMicros] = await Promise.all([
    getCapabilityApprovalByToolCall({
      toolCallId,
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
    }),
    getCapabilitySessionBudgetUsdMicros(context.workspace.id),
  ]);
  if (!row) return Response.json({ error: "Approval not found" }, { status: 404 });
  return Response.json({
    runId: row.id,
    source: row.source,
    action: row.action,
    status: row.status,
    maxCostUsdMicros: row.quoteTotalCostUsdMicros,
    expiresAt: row.approvalExpiresAt?.toISOString() ?? null,
    settledCostUsdMicros: row.totalCostUsdMicros ?? null,
    sessionBudgetUsdMicros,
  });
}
