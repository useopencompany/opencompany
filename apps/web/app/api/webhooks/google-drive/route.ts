import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: Google Drive watch channels deliver header-only push
// notifications to this public web path. The canonical API owns channel/token
// verification and the durable cursor wake; this route forwards unchanged.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "google-drive"], { basePath: "" });
}
