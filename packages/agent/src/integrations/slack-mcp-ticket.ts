import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-slack-mcp";
const SIGNING_CONTEXT = "opencompany-slack-mcp-ticket";

export type SlackMcpOperation = RemoteMcpOperation;
export type SlackMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE>;

export function createSlackMcpTicket(
  input: Omit<SlackMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
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

export function verifySlackMcpTicket(input: { ticket: string; secret: string; now?: number }) {
  return verifyFirstPartyMcpTicket({
    ...input,
    audience: TICKET_AUDIENCE,
    signingContext: SIGNING_CONTEXT,
  });
}
