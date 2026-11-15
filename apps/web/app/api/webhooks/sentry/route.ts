import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "sentry"], { basePath: "" });
}
