import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the pre-key per-integration Jamie webhook URL shape. The canonical API owns integration lookup, API-key verification, and the meeting ingest; this route streams the request through unmodified.
export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await context.params;
  return proxyHeadlessApiRequest(request, ["webhooks", "jamie", integrationId], { basePath: "" });
}
