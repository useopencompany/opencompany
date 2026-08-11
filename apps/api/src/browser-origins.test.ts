import { describe, expect, it } from "vitest";
import { parseBrowserOrigins } from "./browser-origins";

describe("parseBrowserOrigins", () => {
  it("normalizes and deduplicates configured origins", () => {
    expect(
      parseBrowserOrigins(
        "https://my.opencompany.chat/, http://localhost:3000, https://my.opencompany.chat",
      ),
    ).toEqual(["https://my.opencompany.chat", "http://localhost:3000"]);
  });

  it("rejects paths, credentials, and non-HTTP origins", () => {
    for (const value of [
      "https://example.com/path",
      "https://user@example.com",
      "javascript:alert(1)",
      "https://example.com?redirect=unsafe",
    ]) {
      expect(() => parseBrowserOrigins(value)).toThrow("HTTP origins only");
    }
  });
});
