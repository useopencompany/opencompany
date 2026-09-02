import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const path = ["integrations", "github-user", "installations"] as const;

export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, path, { basePath: "" });
}

export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, path, { basePath: "" });
}
