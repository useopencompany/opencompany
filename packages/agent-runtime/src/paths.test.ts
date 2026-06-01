import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, shellQuote } from "./paths";

describe("resolveWorkspacePath", () => {
  it("resolves paths inside configured workspace roots", () => {
    expect(resolveWorkspacePath("/home/user/workspace", "work/src/index.ts")).toBe(
      "/home/user/workspace/work/src/index.ts",
    );
    expect(resolveWorkspacePath("/home/user/workspace", "brain/context.md")).toBe(
      "/home/user/workspace/brain/context.md",
    );
    expect(resolveWorkspacePath("/home/user/workspace", "agent/memory.md")).toBe(
      "/home/user/workspace/agent/memory.md",
    );
  });

  it("rejects bare paths outside configured workspace roots", () => {
    expect(() => resolveWorkspacePath("/home/user/workspace", "notes.md")).toThrow(
      "Path must be inside work/, brain/, or agent/",
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
