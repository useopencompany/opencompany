import { describe, expect, it } from "vitest";
import { isAllowedPreviewPort, parseListeningPorts } from "./goat-codex-runtime";

describe("Goat Codex preview port discovery", () => {
  it("normalizes, de-duplicates, and filters listening ports", () => {
    expect(parseListeningPorts("5173\n3000\n22\n50005\n3000\n65536\nnot-a-port\n8080")).toEqual([
      5_173, 3_000, 8_080,
    ]);
  });

  it("rejects privileged, internal, non-integer, and out-of-range ports", () => {
    expect(isAllowedPreviewPort(80)).toBe(false);
    expect(isAllowedPreviewPort(49_983)).toBe(false);
    expect(isAllowedPreviewPort(50_005)).toBe(false);
    expect(isAllowedPreviewPort(3_000.5)).toBe(false);
    expect(isAllowedPreviewPort(65_536)).toBe(false);
    expect(isAllowedPreviewPort(3_000)).toBe(true);
  });
});
