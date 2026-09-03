import type { RemoteMcpOperation } from "../actions/remote-mcp";
import {
  createFirstPartyMcpTicket,
  type FirstPartyMcpTicketPayload,
  verifyFirstPartyMcpTicket,
} from "./first-party-mcp-ticket";

const TICKET_AUDIENCE = "opencompany-google-drive-mcp";
const SIGNING_CONTEXT = "opencompany-google-drive-mcp-ticket";

export type GoogleDriveMcpOperation = RemoteMcpOperation;
export type GoogleDriveMcpTicketPayload = FirstPartyMcpTicketPayload<typeof TICKET_AUDIENCE>;

export function createGoogleDriveMcpTicket(
  input: Omit<GoogleDriveMcpTicketPayload, "v" | "aud" | "expiresAt"> & {
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

export function verifyGoogleDriveMcpTicket(input: {
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
