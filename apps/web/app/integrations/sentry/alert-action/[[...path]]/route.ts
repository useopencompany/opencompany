import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";
export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await context.params;
  return proxyHeadlessApiRequest(request, ["integrations", "sentry", "alert-action", ...path], {
    basePath: "",
  });
}

export const GET = POST;
