import type { ActionProviderId } from "./types";

// Human-readable permission "capabilities" for chat actions. Keep these
// provider-level groups legible to non-technical users while separating
// materially different outcomes (for example, saving a Gmail draft versus
// sending an email). Providers absent from the registry have no configurable
// capabilities: their actions behave as read=on, today's behavior, and the
// settings UI shows nothing for them.
//
// This module must stay pure and client-safe — it is imported by both the
// server-side action catalog and the settings panel.

export type CapabilityMode = "on" | "off" | "ask";
export type CapabilityId = "read" | "query" | "draft" | "write";

export type ProviderCapability = {
  id: CapabilityId;
  label: string;
  description: string;
  defaultMode: CapabilityMode;
};

export const CAPABILITY_MODES: readonly CapabilityMode[] = ["on", "ask", "off"];

export const PROVIDER_CAPABILITIES: Partial<
  Record<ActionProviderId, readonly ProviderCapability[]>
> = {
  gmail: [
    {
      id: "read",
      label: "Read emails",
      description: "Search and read messages and threads in your Gmail account.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read Gmail",
      description: "Search and read messages, threads, drafts, and labels in your Gmail account.",
      defaultMode: "ask",
    },
    {
      id: "draft",
      label: "Create drafts",
      description: "Save new email drafts in Gmail for you to review and send.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Send emails",
      description: "Send new emails from your Gmail account.",
      defaultMode: "ask",
    },
  ],
  google_drive: [
    {
      id: "read",
      label: "Find & read files",
      description: "Search Google Drive and inspect files you can access.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read files & permissions",
      description: "Read or download file contents and inspect who can access a file.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Edit Docs & Sheets",
      description: "Create or copy Drive files, or edit supported Google Docs and Sheets.",
      defaultMode: "ask",
    },
  ],
  google_calendar: [
    {
      id: "read",
      label: "Check calendars & availability",
      description: "List calendars and inspect availability without reading event details.",
      defaultMode: "ask",
    },
    {
      id: "query",
      label: "Read calendar events",
      description: "Search and read event details from your calendars.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage calendar events",
      description: "Create, update, delete, and respond to events on your calendars.",
      defaultMode: "ask",
    },
  ],
  github_user: [
    {
      id: "read",
      label: "Read GitHub",
      description:
        "Inspect repositories, code, issues, pull requests, releases, and GitHub Actions results.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Manage GitHub",
      description:
        "Change repository content, issues, and pull requests, including merging pull requests.",
      defaultMode: "ask",
    },
  ],
  linear: [
    {
      id: "read",
      label: "Read Linear",
      description: "Look up issues, comments, projects, teams, and members.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Manage issues",
      description: "Create and update issues, and add comments in your Linear workspace.",
      defaultMode: "ask",
    },
  ],
  jamie: [
    {
      id: "read",
      label: "Browse Jamie organization",
      description: "List the meeting templates and tags available in your Jamie account.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read meeting data",
      description: "Search and read meetings, transcripts, people, and action items.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage Jamie content",
      description: "Create tasks and manage meeting templates, tags, and tag sharing.",
      defaultMode: "ask",
    },
    {
      id: "draft",
      label: "Permanently delete tags",
      description: "Delete a Jamie tag and remove it from every meeting that uses it.",
      defaultMode: "off",
    },
  ],
  hubspot: [
    {
      id: "read",
      label: "Inspect HubSpot structure",
      description:
        "Inspect your HubSpot user access, object schemas, and property definitions without reading CRM records.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read CRM & marketing data",
      description:
        "Read CRM records, conversations, owners, campaigns, content, and marketing analytics.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Change HubSpot",
      description:
        "Create or update CRM records, campaigns, marketing emails, landing pages, and blog posts.",
      defaultMode: "ask",
    },
  ],
  posthog: [
    {
      id: "read",
      label: "Read analytics",
      description: "Explore dashboards, saved insights, events, properties, and query results.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Create insights",
      description: "Save new product insights, optionally adding them to a dashboard.",
      defaultMode: "ask",
    },
  ],
  stripe: [
    {
      id: "read",
      label: "Learn about Stripe",
      description: "Search Stripe documentation and inspect API reference details.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read Stripe data",
      description: "Read account, customer, payment, billing, balance, and analytics data.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage Stripe",
      description:
        "Create, update, or delete Stripe resources, including refunds and billing changes.",
      defaultMode: "ask",
    },
  ],
  slack: [
    {
      id: "read",
      label: "Search public Slack",
      description: "Search public channels, users, and emoji available to your Slack account.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read private Slack",
      description:
        "Read private channels, direct messages, threads, canvases, files, and profiles.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Change Slack",
      description: "Send or schedule messages, upload files, add reactions, and change canvases.",
      defaultMode: "ask",
    },
  ],
  attio: [
    {
      id: "read",
      label: "Read Attio",
      description: "Look up CRM records, lists, fields, and pipeline entries.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Update Attio",
      description:
        "Update CRM records, add them to lists, change list-entry fields, and add comments.",
      defaultMode: "ask",
    },
  ],
  latitude: [
    {
      id: "read",
      label: "Read Latitude",
      description: "Inspect projects, traces, signals, datasets, evaluations, and workspace data.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Manage Latitude",
      description: "Create or change resources in your Latitude organization.",
      defaultMode: "ask",
    },
  ],
  neon: [
    {
      id: "read",
      label: "Inspect Neon structure",
      description:
        "List accessible projects and branches, and inspect database tables and schemas.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Query database data",
      description: "Run provider-enforced read-only SQL against databases you can access in Neon.",
      defaultMode: "ask",
    },
  ],
  betterstack: [
    {
      id: "read",
      label: "Search Better Stack docs",
      description: "Search Better Stack's public product documentation.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Inspect observability data",
      description:
        "Read monitors, incidents, on-call schedules, logs, metrics, errors, dashboards, and team access.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage Better Stack",
      description:
        "Change monitoring, incidents, dashboards, alerts, status pages, error state, and team access.",
      defaultMode: "ask",
    },
  ],
  render: [
    {
      id: "read",
      label: "Inspect Render resources",
      description: "List workspaces, services, deploys, Postgres databases, and Key Value stores.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read operational data",
      description: "Read logs and metrics, and run provider-enforced read-only database queries.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage Render infrastructure",
      description:
        "Create services and datastores, change environment variables, and trigger deploys.",
      defaultMode: "ask",
    },
  ],
  signoz: [
    {
      id: "read",
      label: "Read SigNoz documentation",
      description: "Search SigNoz's public product documentation.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Inspect observability data",
      description:
        "Query logs, metrics, traces, alerts, dashboards, views, and notification channels.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage SigNoz",
      description:
        "Create, update, import, or delete alerts, dashboards, views, and notification channels.",
      defaultMode: "ask",
    },
  ],
  x_account: [
    {
      id: "read",
      label: "Research public X data",
      description:
        "Search and inspect public posts, profiles, lists, communities, trends, and news.",
      defaultMode: "on",
    },
    {
      id: "query",
      label: "Read account & private X data",
      description:
        "Read account-specific data such as analytics, timelines, bookmarks, messages, and usage.",
      defaultMode: "ask",
    },
    {
      id: "write",
      label: "Manage X",
      description:
        "Post and delete content or make other changes through your connected X account.",
      defaultMode: "ask",
    },
  ],
};

export function isCapabilityMode(value: unknown): value is CapabilityMode {
  return value === "on" || value === "off" || value === "ask";
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return value === "read" || value === "query" || value === "draft" || value === "write";
}

// The lookups accept any provider string (integration rows carry providers
// with no chat actions, e.g. jamie or hubspot); unknown providers simply have
// no capabilities.
export function providerCapabilities(provider: string): readonly ProviderCapability[] {
  return PROVIDER_CAPABILITIES[provider as ActionProviderId] ?? [];
}

export function providerCapability(
  provider: string,
  capabilityId: CapabilityId,
): ProviderCapability | undefined {
  return providerCapabilities(provider).find((capability) => capability.id === capabilityId);
}

// Resolves the mode for one capability of one connection from its stored
// sparse overrides (the connection's capability_modes jsonb). Unknown values
// and unknown capabilities fall back to the registry default, then "on".
export function effectiveCapabilityMode(
  provider: string,
  capabilityId: CapabilityId,
  stored: unknown,
): CapabilityMode {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const value = (stored as Record<string, unknown>)[capabilityId];
    if (isCapabilityMode(value)) return value;
  }
  return providerCapability(provider, capabilityId)?.defaultMode ?? "on";
}
