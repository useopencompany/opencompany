import { randomUUID } from "node:crypto";

export function mcpInvocationId(
  scope: string,
  transportSessionId: string | undefined,
  requestId: unknown,
) {
  // JSON-RPC ids correlate responses within a client session; they are not durable
  // operation ids. Stateless clients can restart or coexist with identical counters.
  // Give each such dispatch its own identity. Write deduplication and approval replay
  // belong to the action gateway and must remain independent of transport identity.
  const identity = transportSessionId
    ? [transportSessionId, typeof requestId, String(requestId)]
    : ["request", randomUUID()];
  return ["mcp", scope, ...identity].map(encodeURIComponent).join(":");
}
