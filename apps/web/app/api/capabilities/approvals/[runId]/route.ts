import { serverApiClient } from "@/lib/server-api-client";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const response = await (await serverApiClient()).v1["capability-approvals"][":runId"].$get({
    param: { runId },
  });
  if (!response.ok) return legacyApprovalError(response);
  return Response.json((await response.json()).data);
}

async function legacyApprovalError(response: Response) {
  return Response.json(
    { error: response.status === 401 ? "Unauthorized" : "Approval not found" },
    { status: response.status === 401 ? 401 : 404 },
  );
}
