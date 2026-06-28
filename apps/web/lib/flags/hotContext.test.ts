import { describe, expect, it } from "vitest";
import { isHotContextEnabled } from "./hotContext";

describe("isHotContextEnabled", () => {
  it("returns the per-user hot-context flag", () => {
    expect(isHotContextEnabled({ hotContext: true })).toBe(true);
    expect(isHotContextEnabled({ hotContext: false })).toBe(false);
  });
});
