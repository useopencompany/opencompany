import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-google-calendar-mcp";
const SIGNING_CONTEXT = "opencompany-google-calendar-mcp-ticket";

export type GoogleCalendarMcpOperation = RemoteMcpOperation;
export type GoogleCalendarMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE>;

export function createGoogleCalendarMcpTicket(
  input: Omit<GoogleCalendarMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
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

export function verifyGoogleCalendarMcpTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}) {
  return verifyFirstPartyMcpTicket({
    ...input,
    audience: TICKET_AUDIENCE,
    signingContext: SIGNING_CONTEXT,
  });
}
