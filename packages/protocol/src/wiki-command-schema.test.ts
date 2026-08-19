import { WIKI_TOOL_COMMANDS, WIKI_TOOL_INPUT_JSON_SCHEMA } from "@opencompany/wiki/tool";
import { describe, expect, it } from "vitest";
import { InternalWikiCommandRequestSchema, WikiCommandSchema } from "./schemas";

// The AI-SDK/MCP JSON schema and the runtime validator describe the same tool
// contract from two angles. These assertions fail the build if they drift.
describe("WikiCommandSchema", () => {
  it("accepts exactly the fields of WIKI_TOOL_INPUT_JSON_SCHEMA", () => {
    const jsonKeys = Object.keys(WIKI_TOOL_INPUT_JSON_SCHEMA.properties).sort();
    const zodKeys = Object.keys(WikiCommandSchema.shape).sort();
    expect(zodKeys).toEqual(jsonKeys);
  });

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
