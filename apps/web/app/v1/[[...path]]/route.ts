import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 800;
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path?: string[] }> };

export async function proxyV1Request(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyHeadlessApiRequest(request, path);
}

export const GET = proxyV1Request;
export const POST = proxyV1Request;
export const PUT = proxyV1Request;
export const PATCH = proxyV1Request;
export const DELETE = proxyV1Request;
export const OPTIONS = proxyV1Request;
export const HEAD = proxyV1Request;
