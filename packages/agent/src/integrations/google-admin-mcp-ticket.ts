import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-google-admin-mcp";
const SIGNING_CONTEXT = "opencompany-google-admin-mcp-ticket";

export type GoogleAdminMcpOperation = RemoteMcpOperation;
export type GoogleAdminMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE>;

export function createGoogleAdminMcpTicket(
  input: Omit<GoogleAdminMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
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

export function verifyGoogleAdminMcpTicket(input: {
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
