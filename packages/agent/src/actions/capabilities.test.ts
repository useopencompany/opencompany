import { describe, expect, it } from "vitest";
import {
  effectiveCapabilityMode,
  effectiveToolMode,
  isToolMode,
  providerCapabilities,
} from "./capabilities";

describe("Vercel capabilities", () => {
  it("keeps purchase and CLI actions disabled until explicitly enabled", () => {
    expect(providerCapabilities("vercel")).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
      expect.objectContaining({ id: "draft", defaultMode: "ask" }),
      expect.objectContaining({ id: "write", defaultMode: "off" }),
    ]);
    expect(effectiveCapabilityMode("vercel", "write", {})).toBe("off");
    expect(effectiveCapabilityMode("vercel", "write", { write: "ask" })).toBe("ask");
  });
});

describe("Infisical capabilities", () => {
  it("keeps documentation reads on and feedback disabled", () => {
    expect(providerCapabilities("infisical")).toEqual([
      expect.objectContaining({ id: "read", defaultMode: "on" }),
      expect.objectContaining({ id: "write", defaultMode: "off" }),
    ]);
    expect(effectiveCapabilityMode("infisical", "read", {})).toBe("on");
    expect(effectiveCapabilityMode("infisical", "write", {})).toBe("off");
  });
});

describe("Notion capabilities", () => {
  it("requires approval for reads, agent sessions, and workspace changes", () => {
    expect(providerCapabilities("notion")).toEqual([
      expect.objectContaining({ id: "query", defaultMode: "ask" }),
      expect.objectContaining({ id: "draft", defaultMode: "ask" }),
      expect.objectContaining({ id: "write", defaultMode: "ask" }),
    ]);
    expect(effectiveCapabilityMode("notion", "query", {})).toBe("ask");
    expect(effectiveCapabilityMode("notion", "draft", {})).toBe("ask");
    expect(effectiveCapabilityMode("notion", "write", {})).toBe("ask");
  });
});

describe("effectiveToolMode", () => {
  const curated = {
    provider: "gmail",
    capabilityId: "write" as const,
    curated: true,
    toolId: "trash_thread",
  };

  it("follows the capability group until the tool is pinned", () => {
    expect(effectiveToolMode({ ...curated, capabilityModes: {}, toolModes: {} })).toBe("ask");
    expect(effectiveToolMode({ ...curated, capabilityModes: { write: "on" }, toolModes: {} })).toBe(
      "on",
    );
  });

  it("lets a pinned tool stay stricter than an On group", () => {
    expect(
      effectiveToolMode({
        ...curated,
        capabilityModes: { write: "on" },
        toolModes: { trash_thread: "ask" },
      }),
    ).toBe("ask");
  });

  it("lets a pinned tool stay looser than an Off group", () => {
    expect(
      effectiveToolMode({
        ...curated,
        capabilityModes: { write: "off" },
        toolModes: { trash_thread: "on" },
      }),
    ).toBe("on");
  });

  it("falls back to the registry default when the group is unset", () => {
    expect(
      effectiveToolMode({
        provider: "gmail",
        capabilityId: "draft",
        curated: true,
        toolId: "create_draft",
        capabilityModes: {},
        toolModes: {},
      }),
    ).toBe("on");
  });

  it("holds an uncurated tool at Ask under an On group, matching the gateway", () => {
    expect(
      effectiveToolMode({
        ...curated,
        curated: false,
        capabilityModes: { write: "on" },
        toolModes: {},
      }),
    ).toBe("ask");
  });

  it("still honors an Off group and an explicit override for uncurated tools", () => {
    expect(
      effectiveToolMode({
        ...curated,
        curated: false,
        capabilityModes: { write: "off" },
        toolModes: {},
      }),
    ).toBe("off");
    expect(
      effectiveToolMode({
        ...curated,
        curated: false,
        capabilityModes: { write: "off" },
        toolModes: { trash_thread: "on" },
      }),
    ).toBe("on");
  });

  it("ignores stored values outside the mode vocabulary", () => {
    expect(
      effectiveToolMode({
        ...curated,
        capabilityModes: { write: "on" },
        toolModes: { trash_thread: "sometimes" },
      }),
    ).toBe("on");
  });
});

describe("isToolMode", () => {
  it("accepts inherit alongside the stored modes", () => {
    expect(["on", "ask", "off", "inherit"].every(isToolMode)).toBe(true);
    expect(isToolMode("sometimes")).toBe(false);
    expect(isToolMode(undefined)).toBe(false);
  });
});
