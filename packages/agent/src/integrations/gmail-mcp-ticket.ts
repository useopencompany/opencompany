import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-gmail-mcp";
const SIGNING_CONTEXT = "opencompany-gmail-mcp-ticket";

export type GmailMcpOperation = RemoteMcpOperation;
export type GmailMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE>;

export function createGmailMcpTicket(
  input: Omit<GmailMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
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

export function verifyGmailMcpTicket(input: { ticket: string; secret: string; now?: number }) {
  return verifyFirstPartyMcpTicket({
    ...input,
    audience: TICKET_AUDIENCE,
    signingContext: SIGNING_CONTEXT,
  });
}
