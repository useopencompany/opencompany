import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const runtime = "nodejs";

// Preserve the Stripe Dashboard URL while streaming the untouched signed body
// to the canonical API-owned handler.
export function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "stripe"], { basePath: "" });
}
