import { describe, expect, it } from "vitest";
import {
  ancestorDirectoryPaths,
  formatFileSize,
  parentDirectoryPath,
  parseWorkspaceFileMessage,
} from "./coding-workspace-files";

describe("parseWorkspaceFileMessage", () => {
  it("accepts a directory listing and drops malformed entries", () => {
    const message = parseWorkspaceFileMessage(
      JSON.stringify({
        type: "files.listing",
        path: "apps",
        truncated: true,
        entries: [
          { name: "web", path: "apps/web", type: "directory", size: 0, symlink: false },
          { name: "broken", path: "apps/broken", type: "socket", size: 0, symlink: false },
          { name: "missing-size", path: "apps/x", type: "file", symlink: false },
        ],
      }),
    );

    expect(message).toEqual({
      type: "files.listing",
      path: "apps",
      truncated: true,
      entries: [{ name: "web", path: "apps/web", type: "directory", size: 0, symlink: false }],
    });
  });

  it("accepts text content and defaults editable to false", () => {
    expect(
      parseWorkspaceFileMessage(
        JSON.stringify({
          type: "files.content",
          path: "a.ts",
          kind: "text",
          content: "const a = 1;",
          revision: "abc",
          size: 12,
        }),
      ),
    ).toMatchObject({ kind: "text", editable: false });
  });

  it("rejects an image payload that is not an inline base64 image", () => {
    for (const dataUrl of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "https://example.com/a.png",
    ]) {
      expect(
        parseWorkspaceFileMessage(
          JSON.stringify({
            type: "files.content",
            path: "logo.png",
            kind: "image",
            dataUrl,
            size: 4,
          }),
        ),
      ).toBeNull();
    }

    expect(
      parseWorkspaceFileMessage(
        JSON.stringify({
          type: "files.content",
          path: "logo.png",
          kind: "image",
          dataUrl: "data:image/png;base64,AQID",
          size: 3,
        }),
      ),
    ).toMatchObject({ kind: "image" });
  });

  it("keeps the error scope and falls back to a safe scope and code", () => {
    expect(
      parseWorkspaceFileMessage(
        JSON.stringify({
          type: "files.error",
          scope: "save",
          path: "a.ts",
          code: "conflict",
          message: "Changed on disk.",
        }),
      ),
    ).toEqual({
      type: "files.error",
      scope: "save",
      path: "a.ts",
      code: "conflict",
      message: "Changed on disk.",
    });

    expect(
      parseWorkspaceFileMessage(
        JSON.stringify({ type: "files.error", path: "a.ts", message: "Nope." }),
      ),
    ).toMatchObject({ scope: "open", code: "failed" });
  });

  it("ignores unrelated, malformed, and non-string payloads", () => {
    expect(parseWorkspaceFileMessage(JSON.stringify({ type: "ports", ports: [] }))).toBeNull();
    expect(parseWorkspaceFileMessage("{not json")).toBeNull();
    expect(parseWorkspaceFileMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseWorkspaceFileMessage(JSON.stringify({ type: "files.listing" }))).toBeNull();
  });
});

describe("workspace path helpers", () => {
  it("derives parents and ancestors", () => {
    expect(parentDirectoryPath("apps/web/page.tsx")).toBe("apps/web");
    expect(parentDirectoryPath("README.md")).toBe("");
    expect(ancestorDirectoryPaths("apps/web/page.tsx")).toEqual(["apps", "apps/web"]);
    expect(ancestorDirectoryPaths("README.md")).toEqual([]);
  });

  it("formats sizes in units people read", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2_048)).toBe("2.0 KB");
    expect(formatFileSize(204_800)).toBe("200 KB");
    expect(formatFileSize(5_242_880)).toBe("5.0 MB");
  });
});
