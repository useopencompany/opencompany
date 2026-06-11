import {
  BarChart3,
  CalendarDays,
  FlaskConical,
  GitBranch,
  ListTodo,
  type LucideIcon,
  Mail,
  MessageSquare,
  Monitor,
} from "lucide-react";
import type { PersonalIntegrationId } from "@/lib/personal/actions";

// The integrations a /personal agent can attach. Each entry maps to the same @-mention the agent
// could write itself (see PERSONAL_INTEGRATION_MENTIONS) — first-party OAuth integrations
// (GitHub, Gmail, Google Calendar) and workspace MCP servers (Linear, Slack, PostHog, Better Stack)
// are all surfaced together as "integrations". `connectUrl` points at the existing OAuth start route; the
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
  // What connecting grants the agent, in user terms. Shown in the row's expanded detail — both as
  // a preview before connecting and as the access summary afterwards. Mirrors the actual scopes
  // requested by each connect flow (e.g. GOOGLE_PROVIDER_CONFIG scopes, the GitHub App's
  // permissions, what each MCP server exposes) — keep in sync when those change.
  permissions: string[];
};

// Whether each integration is connected at the workspace level (OAuth/MCP credentials present).
// Derived server-side and threaded to the personal surface so rows + the add modal can show
// "Connected" vs "Connect" without a client round-trip.
export type PersonalIntegrationConnections = Record<PersonalIntegrationId, boolean>;

export const PERSONAL_INTEGRATIONS_CATALOG: PersonalIntegrationCatalogEntry[] = [
  {
    id: "github",
    label: "GitHub",
    description:
      "Clone, edit, and open pull requests against any repository the connection can reach. Mention a repo (@owner/repo) in Behavior to scope it down.",
    icon: GitBranch,
    kind: "github",
    connectUrl: (returnTo) =>
      `/api/integrations/github/start?intent=settings&returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read and write code in the repositories you grant",
      "Create branches and open pull requests",
      "Read repository metadata and default branches",
      "No access to repositories outside the installation",
    ],
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Read mail from a connected Google account (read-only).",
    icon: Mail,
    kind: "google",
    connectUrl: (returnTo) =>
      `/api/integrations/gmail/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read mail in the connected account",
      "Read-only — cannot send, modify, or delete mail",
    ],
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Read and manage events on selected calendars.",
    icon: CalendarDays,
    kind: "google",
    connectUrl: (returnTo) =>
      `/api/integrations/google-calendar/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "List the account's calendars",
      "Read events on selected calendars",
      "Create, update, and delete events",
    ],
  },
  {
    id: "linear",
    label: "Linear",
    description: "Read and manage Linear issues and projects.",
    icon: ListTodo,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/linear/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read and search issues, projects, and teams",
      "Create and update issues and comments",
      "Acts as the Linear account you authorize",
    ],
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read messages and channels from your Slack workspace.",
    icon: MessageSquare,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/slack/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read channels and messages you can see",
      "Search workspace conversations",
      "Acts as the Slack account you authorize",
    ],
  },
  {
    id: "posthog",
    label: "PostHog",
    description: "Query product analytics, insights, and dashboards.",
    icon: BarChart3,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/posthog/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Query analytics, insights, and dashboards",
      "Read feature flags and experiments",
      "Acts as the PostHog account you authorize",
    ],
  },
  {
    id: "betterstack",
    label: "Better Stack",
    description: "Query observability, incidents, monitors, and status pages.",
    icon: Monitor,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/betterstack/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read monitors, incidents, and status pages",
      "Query logs and uptime data",
      "Acts as the Better Stack account you authorize",
    ],
  },
  {
    id: "braintrust",
    label: "Braintrust",
    description: "Query experiments, datasets, logs, and prompts.",
    icon: FlaskConical,
    kind: "mcp",
    connectUrl: (returnTo) => `/api/mcp/braintrust/start?returnTo=${encodeURIComponent(returnTo)}`,
    permissions: [
      "Read experiments, datasets, and logs",
      "Read and run prompts",
      "Acts as the Braintrust account you authorize",
    ],
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
  "betterstack",
  "braintrust",
]);
