import { beforeEach, describe, expect, it, vi } from "vitest";

const actionMocks = vi.hoisted(() => ({
  listGmailLabels: vi.fn(),
  listGranolaFolders: vi.fn(),
  listLinearTeams: vi.fn(),
  listPostHogEvents: vi.fn(),
}));

vi.mock("@/lib/brain-source-actions", () => ({
  listGmailLabelsAction: actionMocks.listGmailLabels,
  listGranolaFoldersAction: actionMocks.listGranolaFolders,
  listLinearTeamsAction: actionMocks.listLinearTeams,
}));

vi.mock("@/lib/integrations/posthog-events-actions", () => ({
  listPostHogEventDefinitionsAction: actionMocks.listPostHogEvents,
}));

import {
  loadWorkflowEventFilterOptions,
  workflowEventFilterLoaderKey,
} from "./workflow-event-filters";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Gmail label filter options", () => {
  it("offers the connected account's labels for the declared resource type", async () => {
    actionMocks.listGmailLabels.mockResolvedValue({
      ok: true,
      labels: [
        { id: "Label_2", name: "Customers/Acme" },
        { id: "INBOX", name: "Inbox" },
      ],
    });

    await expect(
      loadWorkflowEventFilterOptions({
        provider: "gmail",
        resourceType: "label",
        integrationId: "integration_1",
        event: "email.received",
      }),
    ).resolves.toEqual({
      ok: true,
      options: [
        { id: "Label_2", name: "Customers/Acme" },
        { id: "INBOX", name: "Inbox" },
      ],
    });
    expect(actionMocks.listGmailLabels).toHaveBeenCalledWith("integration_1");
  });

  it("passes a revoked connection through so the author is sent to the account", async () => {
    actionMocks.listGmailLabels.mockResolvedValue({
      ok: false,
      error: "Reconnect Gmail in Plugins first.",
    });

    await expect(
      loadWorkflowEventFilterOptions({
        provider: "gmail",
        resourceType: "label",
        integrationId: "integration_1",
        event: "email.received",
      }),
    ).resolves.toEqual({ ok: false, error: "Reconnect Gmail in Plugins first." });
  });

  it("reports an undeclared resource type instead of silently offering nothing", async () => {
    const result = await loadWorkflowEventFilterOptions({
      provider: "gmail",
      resourceType: "sender",
      integrationId: "integration_1",
      event: "email.received",
    });

    expect(result).toEqual({
      ok: false,
      error: "This event filter is not available yet. Update the plugin.",
    });
    expect(actionMocks.listGmailLabels).not.toHaveBeenCalled();
  });

  it("keys the registry by provider and resource type", () => {
    expect(workflowEventFilterLoaderKey("gmail", "label")).toBe("gmail:label");
  });
});

describe("PostHog event filter options", () => {
  it("offers event names from the connected project", async () => {
    actionMocks.listPostHogEvents.mockResolvedValue({
      ok: true,
      events: [
        { id: "signup", name: "signup" },
        { id: "subscription_started", name: "subscription_started" },
      ],
      partial: false,
    });

    await expect(
      loadWorkflowEventFilterOptions({
        provider: "posthog",
        resourceType: "event",
        integrationId: "gint_posthog_events",
        event: "event.captured",
      }),
    ).resolves.toEqual({
      ok: true,
      options: [
        { id: "signup", name: "signup" },
        { id: "subscription_started", name: "subscription_started" },
      ],
    });
    expect(actionMocks.listPostHogEvents).toHaveBeenCalledWith("gint_posthog_events");
  });
});
