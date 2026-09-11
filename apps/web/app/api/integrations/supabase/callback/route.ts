import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Supabase redirects here; the canonical API verifies state and persists credentials.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "supabase", "callback"], {
    basePath: "",
  });
}
