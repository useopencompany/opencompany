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
