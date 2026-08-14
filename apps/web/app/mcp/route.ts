import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const runtime = "nodejs";
export const maxDuration = 120;

async function handleMcpRequest(request: Request) {
  return proxyHeadlessApiRequest(request, ["mcp"], { basePath: "" });
}

export { handleMcpRequest as DELETE, handleMcpRequest as GET, handleMcpRequest as POST };
