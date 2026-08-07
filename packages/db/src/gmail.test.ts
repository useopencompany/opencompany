import { describe, expect, it } from "vitest";
import {
  GOAT_GMAIL_INSTRUCTIONS_MAX_LENGTH,
  goatGmailEventTypeForDirection,
  goatGmailRouteMatchesEvent,
  goatGmailSelectedEventTypes,
  parseGoatGmailBrainSourceConfig,
  sanitizeGoatGmailInstructions,
} from "./gmail";

describe("Goat Gmail brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseGoatGmailBrainSourceConfig({});

    expect(goatGmailSelectedEventTypes(config)).toBeNull();
    expect(goatGmailRouteMatchesEvent(config, "email_received")).toBe(true);
    expect(goatGmailRouteMatchesEvent(config, "email_sent")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseGoatGmailBrainSourceConfig({ events: [] });

    expect(goatGmailSelectedEventTypes(config)).toEqual(new Set());
    expect(goatGmailRouteMatchesEvent(config, "email_received")).toBe(false);
  });

  it("parses selected event ids and drops unknown events", () => {
    const config = parseGoatGmailBrainSourceConfig({
      events: [{ id: "email_received" }, "email_sent", { id: "unknown" }],
    });

    expect(goatGmailSelectedEventTypes(config)).toEqual(new Set(["email_received", "email_sent"]));
  });

  it("trims and caps the ingestion instructions", () => {
    expect(sanitizeGoatGmailInstructions("  only investor emails  ")).toBe("only investor emails");
    expect(sanitizeGoatGmailInstructions("   ")).toBeUndefined();
    expect(sanitizeGoatGmailInstructions(42)).toBeUndefined();
    expect(sanitizeGoatGmailInstructions("x".repeat(5000))).toHaveLength(
      GOAT_GMAIL_INSTRUCTIONS_MAX_LENGTH,
    );
  });

  it("drops empty instructions when parsing config", () => {
    expect(parseGoatGmailBrainSourceConfig({ instructions: "  " })).toEqual({});
    expect(parseGoatGmailBrainSourceConfig({ instructions: "keep customer emails" })).toEqual({
      instructions: "keep customer emails",
    });
  });

  it("maps message directions to event types", () => {
    expect(goatGmailEventTypeForDirection("sent")).toBe("email_sent");
    expect(goatGmailEventTypeForDirection("received")).toBe("email_received");
  });
});
