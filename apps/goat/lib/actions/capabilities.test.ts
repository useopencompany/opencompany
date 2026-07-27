import { describe, expect, it } from "vitest";
import {
  effectiveCapabilityMode,
  GOAT_PROVIDER_CAPABILITIES,
  isGoatCapabilityMode,
  providerCapability,
} from "@/lib/actions/capabilities";

describe("GOAT_PROVIDER_CAPABILITIES", () => {
  it("registers Gmail reads on by default and sends behind ask", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.gmail).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Drive reads on by default and document edits behind ask", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.google_drive).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Google Calendar with read on by default and write behind ask", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.google_calendar).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Linear with read on by default and issue management behind ask", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.linear).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers Slack as one broad read permission", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.slack).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
    ]);
  });

  it("registers Attio reads on by default and updates behind ask", () => {
    expect(GOAT_PROVIDER_CAPABILITIES.attio).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("uses human-readable labels for every registered capability", () => {
    for (const capabilities of Object.values(GOAT_PROVIDER_CAPABILITIES)) {
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
    expect(isGoatCapabilityMode("on")).toBe(true);
    expect(isGoatCapabilityMode("ask")).toBe(true);
    expect(isGoatCapabilityMode("off")).toBe(true);
    expect(isGoatCapabilityMode("enabled")).toBe(false);
    expect(isGoatCapabilityMode(undefined)).toBe(false);
  });

  it("looks up registered capabilities", () => {
    expect(providerCapability("gmail", "write")?.label).toBe("Send emails");
    expect(providerCapability("google_drive", "read")?.label).toBe("Find & read files");
    expect(providerCapability("google_drive", "write")?.label).toBe("Edit Google Docs");
    expect(providerCapability("google_calendar", "write")?.label).toBe("Add events");
    expect(providerCapability("linear", "write")?.label).toBe("Manage issues");
    expect(providerCapability("slack", "read")?.label).toBe("Read Slack");
    expect(providerCapability("attio", "write")?.label).toBe("Update Attio");
    expect(providerCapability("slack", "write")).toBeUndefined();
  });
});
