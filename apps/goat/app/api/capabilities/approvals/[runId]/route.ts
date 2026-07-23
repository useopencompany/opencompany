import {
  approveGoatCapabilityRun,
  cancelGoatCapabilityRun,
  getGoatCapabilityApproval,
} from "@opencompany/db/goat-capabilities";
import { GOAT_METRICS, recordGoatCounter } from "@opencompany/goat-observability";
import { currentGoatUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const row = await getGoatCapabilityApproval({
    id: runId,
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
  });
  if (!row) return Response.json({ error: "Approval not found" }, { status: 404 });
  return Response.json(approvalView(row));
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const value = await request.json().catch(() => null);
  const decision =
    value && typeof value === "object" && "decision" in value
      ? (value as { decision?: unknown }).decision
      : null;
  if (decision !== "approve" && decision !== "cancel") {
    return Response.json({ error: "Invalid approval decision" }, { status: 400 });
  }
  const { runId } = await params;
  const row =
    decision === "approve"
      ? await approveGoatCapabilityRun({
          id: runId,
          userWorkosId: context.user.workosUserId,
          workspaceId: context.workspace.id,
        })
      : await cancelGoatCapabilityRun({
          id: runId,
          userWorkosId: context.user.workosUserId,
          workspaceId: context.workspace.id,
        });
  if (!row) return Response.json({ error: "Approval not found" }, { status: 404 });
  recordGoatCounter(GOAT_METRICS.capabilityApprovalsTotal, 1, {
    "goat.capability_source": row.source,
    "goat.capability_action": row.action,
    "goat.approval_decision": decision,
    "goat.outcome": row.status,
  });
  return Response.json(approvalView(row));
}

function approvalView(row: NonNullable<Awaited<ReturnType<typeof getGoatCapabilityApproval>>>) {
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
