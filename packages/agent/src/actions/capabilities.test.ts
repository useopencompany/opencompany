import { describe, expect, it } from "vitest";
import { effectiveCapabilityMode, providerCapabilities } from "./capabilities";

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
