import { describe, expect, it } from "vitest";
import { isDesktopUserAgent } from "@/lib/desktop";

describe("desktop request detection", () => {
  it("recognizes the Electron user-agent marker", () => {
    expect(
      isDesktopUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) opencompanyDesktop/0.1.0",
      ),
    ).toBe(true);
  });

  it("does not treat regular or missing user agents as desktop requests", () => {
    expect(isDesktopUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
    expect(isDesktopUserAgent(null)).toBe(false);
  });
});
