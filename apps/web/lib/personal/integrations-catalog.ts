import {
  BarChart3,
  CalendarDays,
  GitBranch,
  ListTodo,
  type LucideIcon,
  Mail,
  MessageSquare,
} from "lucide-react";
import type { PersonalIntegrationId } from "@/lib/personal/actions";

// The integrations a /personal agent can attach. Each entry maps to the same @-mention the agent
// could write itself (see PERSONAL_INTEGRATION_MENTIONS) — first-party OAuth integrations
// (GitHub, Gmail, Google Calendar) and workspace MCP servers (Linear, Slack, PostHog) are all
// surfaced together as "integrations". `connectUrl` points at the existing OAuth start route; the
// connect flow runs in a popup window that lands on /onboarding/connected (a tiny popup-closer that
// messages the opener and closes), so the integrations tab never navigates away.

export const PERSONAL_INTEGRATIONS_RETURN_TO = "/onboarding/connected";

export type PersonalIntegrationKind = "github" | "google" | "mcp";

export type PersonalIntegrationCatalogEntry = {
  id: PersonalIntegrationId;
  label: string;
  description: string;
  icon: LucideIcon;
  kind: PersonalIntegrationKind;
  // Builds the OAuth start URL (full-page navigation) for the in-tab connect flow.
  connectUrl: (returnTo: string) => string;
};

// Whether each integration is connected at the workspace level (OAuth/MCP credentials present).
// Derived server-side and threaded to the personal surface so rows + the add modal can show
// "Connected" vs "Connect" without a client round-trip.
export type PersonalIntegrationConnections = Record<PersonalIntegrationId, boolean>;

export const PERSONAL_INTEGRATIONS_CATALOG: PersonalIntegrationCatalogEntry[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Clone, edit, and open pull requests against your repositories.",
    icon: GitBranch,
    kind: "github",
    connectUrl: (returnTo) =>
      `/api/integrations/github/start?intent=settings&returnTo=${encodeURIComponent(returnTo)}`,
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Read mail from a connected Google account (read-only).",
    icon: Mail,
    kind: "google",
    connectUrl: (returnTo) =>
      `/api/integrations/gmail/start?returnTo=${encodeURIComponent(returnTo)}`,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Read and manage events on selected calendars.",
    icon: CalendarDays,
    kind: "google",
    connectUrl: (returnTo) =>
      `/api/integrations/google-calendar/start?returnTo=${encodeURIComponent(returnTo)}`,
  },
  {
    id: "linear",
    label: "Linear",
    description: "Read and manage Linear issues and projects.",
    icon: ListTodo,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/linear/start?returnTo=${encodeURIComponent(returnTo)}`,
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read messages and channels from your Slack workspace.",
    icon: MessageSquare,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/slack/start?returnTo=${encodeURIComponent(returnTo)}`,
  },
  {
    id: "posthog",
    label: "PostHog",
    description: "Query product analytics, insights, and dashboards.",
    icon: BarChart3,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/posthog/start?returnTo=${encodeURIComponent(returnTo)}`,
  },
];

const CATALOG_BY_ID = new Map(PERSONAL_INTEGRATIONS_CATALOG.map((entry) => [entry.id, entry]));

export function personalIntegrationById(
  id: PersonalIntegrationId,
): PersonalIntegrationCatalogEntry | undefined {
  return CATALOG_BY_ID.get(id);
}

export function personalIntegrationConnectUrl(entry: PersonalIntegrationCatalogEntry): string {
  return entry.connectUrl(PERSONAL_INTEGRATIONS_RETURN_TO);
}

// The agent's @-mention tool ids that correspond to integrations (everything except GitHub, which
// is surfaced via its repositories/`@github` rather than a tool). Used to keep these out of the
// Tools tab so each integration only appears under Integrations.
export const PERSONAL_INTEGRATION_TOOL_IDS = new Set<string>([
  "gmail",
  "google_calendar",
  "linear",
  "slack",
  "posthog",
]);
