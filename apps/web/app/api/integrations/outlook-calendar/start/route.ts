import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "outlook-calendar", "start"], {
    basePath: "",
  });
}
