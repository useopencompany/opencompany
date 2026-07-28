import type { GoatActionProviderId } from "./types";

// Human-readable permission "capabilities" for chat actions. Deliberately
// coarse (read/write per provider) so the settings UI stays legible to
// non-technical users. Providers absent from the registry have no
// configurable capabilities: their actions behave as read=on, today's
// behavior, and the settings UI shows nothing for them.
//
// This module must stay pure and client-safe — it is imported by both the
// server-side action catalog and the settings panel.

export type GoatCapabilityMode = "on" | "off" | "ask";
export type GoatCapabilityId = "read" | "write";

export type GoatProviderCapability = {
  id: GoatCapabilityId;
  label: string;
  description: string;
  defaultMode: GoatCapabilityMode;
};

export const GOAT_CAPABILITY_MODES: readonly GoatCapabilityMode[] = ["on", "ask", "off"];

export const GOAT_PROVIDER_CAPABILITIES: Partial<
  Record<GoatActionProviderId, readonly GoatProviderCapability[]>
> = {
  gmail: [
    {
      id: "read",
      label: "Read emails",
      description: "Search and read messages and threads in your Gmail account.",
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
      description: "Search Google Drive and read the contents of Google Docs.",
      defaultMode: "on",
    },
    {
      id: "write",
      label: "Edit Google Docs",
      description: "Replace text in Google Docs you can edit.",
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
      description: "Update CRM records, add them to lists, and change list-entry fields.",
      defaultMode: "ask",
    },
  ],
};

export function isGoatCapabilityMode(value: unknown): value is GoatCapabilityMode {
  return value === "on" || value === "off" || value === "ask";
}

export function isGoatCapabilityId(value: unknown): value is GoatCapabilityId {
  return value === "read" || value === "write";
}

// The lookups accept any provider string (integration rows carry providers
// with no chat actions, e.g. jamie or hubspot); unknown providers simply have
// no capabilities.
export function providerCapabilities(provider: string): readonly GoatProviderCapability[] {
  return GOAT_PROVIDER_CAPABILITIES[provider as GoatActionProviderId] ?? [];
}

export function providerCapability(
  provider: string,
  capabilityId: GoatCapabilityId,
): GoatProviderCapability | undefined {
  return providerCapabilities(provider).find((capability) => capability.id === capabilityId);
}

// Resolves the mode for one capability of one connection from its stored
// sparse overrides (the connection's capability_modes jsonb). Unknown values
// and unknown capabilities fall back to the registry default, then "on".
export function effectiveCapabilityMode(
  provider: string,
  capabilityId: GoatCapabilityId,
  stored: unknown,
): GoatCapabilityMode {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const value = (stored as Record<string, unknown>)[capabilityId];
    if (isGoatCapabilityMode(value)) return value;
  }
  return providerCapability(provider, capabilityId)?.defaultMode ?? "on";
}
