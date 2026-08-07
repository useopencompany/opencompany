import { getCapabilityApproval } from "@opencompany/db/capabilities";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const context = await currentUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const row = await getCapabilityApproval({
    id: runId,
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
  });
  if (!row) return Response.json({ error: "Approval not found" }, { status: 404 });
  return Response.json(approvalView(row));
}

function approvalView(row: NonNullable<Awaited<ReturnType<typeof getCapabilityApproval>>>) {
  return {
    runId: row.id,
    source: row.source,
    action: row.action,
    status: row.status,
    maxCostUsdMicros: row.quoteTotalCostUsdMicros,
    expiresAt: row.approvalExpiresAt?.toISOString() ?? null,
    settledCostUsdMicros: row.totalCostUsdMicros ?? null,
  };
}
