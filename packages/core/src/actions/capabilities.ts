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

export const GOAT_CAPABILITY_MODES: readonly CapabilityMode[] = ["on", "ask", "off"];

export const GOAT_PROVIDER_CAPABILITIES: Partial<
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
      description: "Search Google Drive and read the contents of Google Docs and Sheets.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Edit Docs & Sheets",
      description: "Create and edit Google Docs, and update spreadsheets you can edit.",
      defaultMode: "ask",
    },
  ],
  google_calendar: [
    {
      id: "read",
      label: "Read calendar",
      description: "Look up events on your calendars.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Add events",
      description: "Create new events on your calendars.",
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
  slack: [
    {
      id: "read",
      label: "Read Slack",
      description: "Search and read channels, direct messages, threads, and people in Slack.",
      defaultMode: "on",
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
  return GOAT_PROVIDER_CAPABILITIES[provider as ActionProviderId] ?? [];
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
