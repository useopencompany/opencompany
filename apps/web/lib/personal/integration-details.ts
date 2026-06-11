import type { PersonalIntegrationId } from "@/lib/personal/actions";

// Per-integration connection details for the personal Integrations tab — who is connected, what
// the connection can reach (repositories, calendars, MCP endpoint), and how healthy it is. Built
// server-side from state the /personal layout already loads (see integration-details-server.ts)
// and threaded to the client, so expanding a row never needs a round-trip.

export type PersonalIntegrationResourceDetail = {
  id: string;
  name: string;
  /** Secondary line, e.g. "Default branch main" or "Primary calendar". */
  detail: string | null;
  /** Set when access to this resource is degraded, e.g. "Access lost" — rendered as a warning badge. */
  warning: string | null;
};

export type PersonalIntegrationAccountDetail = {
  id: string;
  /** "@login" for GitHub, the account email for Google. */
  label: string;
  /** e.g. "Organization" or "User". */
  detail: string | null;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason: string | null;
  /** ISO timestamp of the last sync/update, shown as relative time. */
  updatedAt: string | null;
  resources: PersonalIntegrationResourceDetail[];
};

export type PersonalIntegrationDetail = {
  /** Replaces the catalog description on the collapsed row when connected, e.g. "Connected as @acme · 12 repositories". */
  summary: string | null;
  accounts: PersonalIntegrationAccountDetail[];
  /** Heading for the resource lists, e.g. "Repositories" or "Calendars". */
  resourcesLabel: string | null;
  /** Connection-level error detail (e.g. an MCP server in an error state). */
  statusReason: string | null;
};

export type PersonalIntegrationDetails = Partial<
  Record<PersonalIntegrationId, PersonalIntegrationDetail>
>;
