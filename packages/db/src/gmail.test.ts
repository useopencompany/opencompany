import { describe, expect, it, vi } from "vitest";
import {
  GMAIL_INSTRUCTIONS_MAX_LENGTH,
  gmailEventTypeForDirection,
  gmailRouteMatchesEvent,
  gmailSelectedEventTypes,
  listEnabledGmailWikiSourceRoutes,
  parseGmailBrainSourceConfig,
  parseGmailWikiSourceConfig,
  sanitizeGmailInstructions,
} from "./gmail";

describe("opencompany Gmail brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseGmailBrainSourceConfig({});

    expect(gmailSelectedEventTypes(config)).toBeNull();
    expect(gmailRouteMatchesEvent(config, "email_received")).toBe(true);
    expect(gmailRouteMatchesEvent(config, "email_sent")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseGmailBrainSourceConfig({ events: [] });

    expect(gmailSelectedEventTypes(config)).toEqual(new Set());
    expect(gmailRouteMatchesEvent(config, "email_received")).toBe(false);
  });

  it("parses selected event ids and drops unknown events", () => {
    const config = parseGmailBrainSourceConfig({
      events: [{ id: "email_received" }, "email_sent", { id: "unknown" }],
    });

    expect(gmailSelectedEventTypes(config)).toEqual(new Set(["email_received", "email_sent"]));
  });

  it("trims and caps the ingestion instructions", () => {
    expect(sanitizeGmailInstructions("  only investor emails  ")).toBe("only investor emails");
    expect(sanitizeGmailInstructions("   ")).toBeUndefined();
    expect(sanitizeGmailInstructions(42)).toBeUndefined();
    expect(sanitizeGmailInstructions("x".repeat(5000))).toHaveLength(GMAIL_INSTRUCTIONS_MAX_LENGTH);
  });

  it("drops empty instructions when parsing config", () => {
    expect(parseGmailBrainSourceConfig({ instructions: "  " })).toEqual({});
    expect(parseGmailBrainSourceConfig({ instructions: "keep customer emails" })).toEqual({
      instructions: "keep customer emails",
    });
  });

  it("maps message directions to event types", () => {
    expect(gmailEventTypeForDirection("sent")).toBe("email_sent");
    expect(gmailEventTypeForDirection("received")).toBe("email_received");
  });

  it("uses the same event and instruction contract for wiki routes", () => {
    const config = parseGmailWikiSourceConfig({
      events: [{ id: "email_received" }],
      instructions: "  customer commitments only  ",
    });

    expect(config).toEqual({
      events: [{ id: "email_received" }],
      instructions: "customer commitments only",
    });
    expect(gmailRouteMatchesEvent(config, "email_received")).toBe(true);
    expect(gmailRouteMatchesEvent(config, "email_sent")).toBe(false);
  });

  it("resolves enabled wiki rows into workspace-scoped routes", async () => {
    const rows = [
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { events: [{ id: "email_sent" }] },
      },
    ];
    const where = vi.fn(async () => rows);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };

    await expect(listEnabledGmailWikiSourceRoutes(["integration_1"], db)).resolves.toEqual([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { events: [{ id: "email_sent" }] },
      },
    ]);
    expect(where).toHaveBeenCalledOnce();
  });
});
