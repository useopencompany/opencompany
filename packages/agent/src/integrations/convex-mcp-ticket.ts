import { createHash } from "node:crypto";
import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-convex-mcp";
const SIGNING_CONTEXT = "opencompany-convex-mcp-ticket";

export type ConvexMcpOperation = RemoteMcpOperation;
export type ConvexMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE> & {
  connectionVersion: string;
};

export function createConvexMcpTicket(
  input: Omit<ConvexMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
    secret: string;
    now?: number;
    ttlMs?: number;
  },
) {
  return createFirstPartyMcpTicket({
    ...input,
    audience: TICKET_AUDIENCE,
    signingContext: SIGNING_CONTEXT,
  });
}

export function convexCredentialVersion(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function verifyConvexMcpTicket(input: { ticket: string; secret: string; now?: number }) {
  const payload = verifyFirstPartyMcpTicket({
    ...input,
    audience: TICKET_AUDIENCE,
    signingContext: SIGNING_CONTEXT,
  });
  return payload?.connectionVersion ? (payload as ConvexMcpTicketPayload) : null;
}
