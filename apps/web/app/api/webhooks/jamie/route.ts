import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: Jamie deliveries target this URL with the x-jamie-api-key header. The canonical API owns API-key resolution and the meeting ingest; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "jamie"], { basePath: "" });
}
