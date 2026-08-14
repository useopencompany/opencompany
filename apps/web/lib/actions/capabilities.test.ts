import { describe, expect, it } from "vitest";
import {
  effectiveCapabilityMode,
  isCapabilityId,
  isCapabilityMode,
  PROVIDER_CAPABILITIES,
  providerCapability,
} from "@/lib/actions/capabilities";

describe("PROVIDER_CAPABILITIES", () => {
  it("registers Gmail reads and drafts on by default and sends behind ask", () => {
    expect(PROVIDER_CAPABILITIES.gmail).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "draft", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Drive reads on by default and document writes behind ask", () => {
    expect(PROVIDER_CAPABILITIES.google_drive).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Google Calendar with read on by default and write behind ask", () => {
    expect(PROVIDER_CAPABILITIES.google_calendar).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Linear with read on by default and issue management behind ask", () => {
    expect(PROVIDER_CAPABILITIES.linear).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Slack as one broad read permission", () => {
    expect(PROVIDER_CAPABILITIES.slack).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
    ]);
  });

  it("registers Attio reads on by default and updates behind ask", () => {
    expect(PROVIDER_CAPABILITIES.attio).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("keeps Neon structure visible but gates database-row queries by default", () => {
    expect(PROVIDER_CAPABILITIES.neon).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
    ]);
  });

  it("uses human-readable labels for every registered capability", () => {
    for (const capabilities of Object.values(PROVIDER_CAPABILITIES)) {
      for (const capability of capabilities) {
        expect(capability.label).toMatch(/^[A-Z][a-z]/);
        expect(capability.description.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("effectiveCapabilityMode", () => {
  it("honors stored overrides", () => {
    expect(effectiveCapabilityMode("google_calendar", "write", { write: "on" })).toBe("on");
    expect(effectiveCapabilityMode("google_calendar", "write", { write: "off" })).toBe("off");
    expect(effectiveCapabilityMode("google_calendar", "read", { read: "ask" })).toBe("ask");
  });

  it("falls back to the registry default for missing or invalid stored values", () => {
    expect(effectiveCapabilityMode("google_calendar", "write", {})).toBe("ask");
    expect(effectiveCapabilityMode("google_calendar", "write", null)).toBe("ask");
    expect(effectiveCapabilityMode("google_calendar", "write", { write: "banana" })).toBe("ask");
    expect(effectiveCapabilityMode("google_calendar", "write", ["write"])).toBe("ask");
    expect(effectiveCapabilityMode("google_calendar", "read", undefined)).toBe("on");
  });

  it("treats unregistered providers as read on", () => {
    expect(effectiveCapabilityMode("github", "read", {})).toBe("on");
    expect(effectiveCapabilityMode("github", "write", {})).toBe("on");
    expect(effectiveCapabilityMode("github", "read", { read: "off" })).toBe("off");
  });
});

describe("mode helpers", () => {
  it("validates capability modes", () => {
    expect(isCapabilityMode("on")).toBe(true);
    expect(isCapabilityMode("ask")).toBe(true);
    expect(isCapabilityMode("off")).toBe(true);
    expect(isCapabilityMode("enabled")).toBe(false);
    expect(isCapabilityMode(undefined)).toBe(false);
  });

  it("recognizes provider-specific capability ids", () => {
    expect(isCapabilityId("read")).toBe(true);
    expect(isCapabilityId("query")).toBe(true);
    expect(isCapabilityId("draft")).toBe(true);
    expect(isCapabilityId("write")).toBe(true);
    expect(isCapabilityId("send")).toBe(false);
  });

  it("looks up registered capabilities", () => {
    expect(providerCapability("gmail", "draft")?.label).toBe("Create drafts");
    expect(providerCapability("gmail", "write")?.label).toBe("Send emails");
    expect(providerCapability("google_drive", "read")?.label).toBe("Find & read files");
    expect(providerCapability("google_drive", "write")?.label).toBe("Edit Docs & Sheets");
    expect(providerCapability("google_calendar", "write")?.label).toBe("Add events");
    expect(providerCapability("linear", "write")?.label).toBe("Manage issues");
    expect(providerCapability("slack", "read")?.label).toBe("Read Slack");
    expect(providerCapability("attio", "write")?.label).toBe("Update Attio");
    expect(providerCapability("neon", "read")?.label).toBe("Inspect Neon structure");
    expect(providerCapability("neon", "query")?.label).toBe("Query database data");
    expect(providerCapability("slack", "write")).toBeUndefined();
  });
});
