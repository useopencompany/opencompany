import { describe, expect, it } from "vitest";
import {
  effectiveCapabilityMode,
  isCapabilityId,
  isCapabilityMode,
  PROVIDER_CAPABILITIES,
  providerCapability,
} from "@/lib/actions/capabilities";

describe("PROVIDER_CAPABILITIES", () => {
  it("preserves legacy Gmail defaults and adds sensitive plugin reads behind ask", () => {
    expect(PROVIDER_CAPABILITIES.gmail).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
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

  it("guards all Google Calendar data and mutations behind ask by default", () => {
    expect(PROVIDER_CAPABILITIES.google_calendar).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "ask" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
  });

  it("registers personal GitHub reads on by default and all writes behind ask", () => {
    expect(PROVIDER_CAPABILITIES.github_user).toEqual([
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

  it("registers public Slack search on and guards private reads and writes", () => {
    expect(PROVIDER_CAPABILITIES.slack).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
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

  it("keeps SigNoz docs visible but gates telemetry reads and mutations", () => {
    expect(PROVIDER_CAPABILITIES.signoz).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
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
    expect(effectiveCapabilityMode("google_calendar", "read", undefined)).toBe("ask");
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
    expect(providerCapability("google_calendar", "write")?.label).toBe("Manage calendar events");
    expect(providerCapability("github_user", "read")?.label).toBe("Read GitHub");
    expect(providerCapability("github_user", "write")?.label).toBe("Manage GitHub");
    expect(providerCapability("linear", "write")?.label).toBe("Manage issues");
    expect(providerCapability("slack", "read")?.label).toBe("Search public Slack");
    expect(providerCapability("attio", "write")?.label).toBe("Update Attio");
    expect(providerCapability("neon", "read")?.label).toBe("Inspect Neon structure");
    expect(providerCapability("neon", "query")?.label).toBe("Query database data");
    expect(providerCapability("signoz", "read")?.label).toBe("Read SigNoz documentation");
    expect(providerCapability("signoz", "query")?.label).toBe("Inspect observability data");
    expect(providerCapability("slack", "query")?.label).toBe("Read private Slack");
    expect(providerCapability("slack", "write")?.label).toBe("Change Slack");
  });
});
