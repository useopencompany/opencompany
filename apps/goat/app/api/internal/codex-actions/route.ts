import { POST as actionGatewayPost } from "../action-gateway/route";

// Compatibility endpoint for runners on the previous deployment. New runners
// use the harness-neutral /api/internal/action-gateway route. Translate only
// transport identity fields; authorization and request validation stay owned
// by the neutral route.
export { maxDuration, runtime } from "../action-gateway/route";

export async function POST(request: Request) {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(body) || !("codexChatSessionId" in body || "codexChatTurnId" in body)) {
    return actionGatewayPost(request);
  }

  const translated = {
    ...body,
    sessionId: body.codexChatSessionId,
    turnId: body.codexChatTurnId,
    ...(body.operation === "execute" ? { invocationId: body.toolCallId } : {}),
  };
  return actionGatewayPost(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(translated),
      signal: request.signal,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
