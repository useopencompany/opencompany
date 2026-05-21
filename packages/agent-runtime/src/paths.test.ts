import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, shellQuote } from "./paths";

describe("resolveWorkspacePath", () => {
  it("resolves relative paths inside the workspace", () => {
    expect(resolveWorkspacePath("/home/user/workspace", "src/index.ts")).toBe(
      "/home/user/workspace/src/index.ts",
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(() => resolveWorkspacePath("/home/user/workspace", "../secret")).toThrow(
      "Path must stay inside",
    );
  });
});

describe("shellQuote", () => {
  it("quotes shell strings containing apostrophes", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
