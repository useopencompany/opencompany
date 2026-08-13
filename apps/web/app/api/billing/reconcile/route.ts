import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const runtime = "nodejs";

// Keep the Vercel cron URL stable while the canonical API owns reconciliation.
export function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["billing", "reconcile"], { basePath: "" });
}
