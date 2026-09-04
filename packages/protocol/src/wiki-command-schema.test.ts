import { WIKI_TOOL_COMMANDS } from "@opencompany/wiki/tool";
import { describe, expect, it } from "vitest";
import { InternalWikiCommandRequestSchema, WikiCommandSchema } from "./schemas";

// The runtime validator is derived from the AI-SDK/MCP JSON schema so every
// transport enforces one contract.
describe("WikiCommandSchema", () => {
  it("enumerates the same command set", () => {
    for (const command of WIKI_TOOL_COMMANDS) {
      expect(WikiCommandSchema.safeParse({ command }).success).toBe(true);
    }
    expect(WikiCommandSchema.safeParse({ command: "nonexistent" }).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(WikiCommandSchema.safeParse({ command: "tree", surprise: true }).success).toBe(false);
  });

  it("requires a command", () => {
    expect(WikiCommandSchema.safeParse({}).success).toBe(false);
  });

  it("normalizes empty optional placeholders emitted by structured-output providers", () => {
    const result = WikiCommandSchema.safeParse({
      command: "tree",
      depth: 2,
      pages: "",
      path: "",
      body: "",
      kind: "other",
      title: "",
      query: "",
      since: "",
      to: "",
      recursive: false,
      ignoreCase: true,
      at: "",
      text: "",
      limit: 100,
      offset: 0,
    });

    expect(result).toEqual({
      success: true,
      data: {
        command: "tree",
        depth: 2,
        body: "",
        kind: "other",
        recursive: false,
        ignoreCase: true,
        limit: 100,
        offset: 0,
      },
    });
  });

  it("preserves an empty body because it is a valid page update", () => {
    expect(
      WikiCommandSchema.safeParse({
        command: "write",
        path: "references/conductor-yc-positioning",
        body: "",
        pages: "",
        query: "",
      }),
    ).toEqual({
      success: true,
      data: {
        command: "write",
        path: "references/conductor-yc-positioning",
        body: "",
      },
    });
  });

  it("enforces the shared JSON Schema size bounds", () => {
    expect(
      WikiCommandSchema.safeParse({ command: "write", path: "x".repeat(513), body: "ok" }).success,
    ).toBe(false);
    expect(
      WikiCommandSchema.safeParse({ command: "write", path: "page", title: "x".repeat(161) })
        .success,
    ).toBe(false);
  });
});

describe("InternalWikiCommandRequestSchema", () => {
  it("requires tenancy and a valid command", () => {
    expect(
      InternalWikiCommandRequestSchema.safeParse({
        userWorkosId: "user_1",
        workspaceId: "ws_1",
        command: { command: "write", path: "projects/plan", body: "# Plan" },
      }).success,
    ).toBe(true);
    expect(
      InternalWikiCommandRequestSchema.safeParse({
        workspaceId: "ws_1",
        command: { command: "tree" },
      }).success,
    ).toBe(false);
  });
});
