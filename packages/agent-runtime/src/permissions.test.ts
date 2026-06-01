import { describe, expect, it } from "vitest";
import {
  buildDeniedToolOutput,
  classifyByVerbHeuristic,
  classifyMcpTool,
  classifyRuntimeTool,
  classifyTool,
  policyMapKey,
  resolveToolDecision,
  type WorkspaceToolPolicyMap,
} from "./permissions";

describe("classifyRuntimeTool", () => {
  it("maps first-party tools to provider + group", () => {
    expect(classifyRuntimeTool("exa_search")).toEqual({ providerKey: "exa", group: "read" });
    expect(classifyRuntimeTool("edit_file")).toEqual({ providerKey: "system", group: "modify" });
    expect(classifyRuntimeTool("shell")).toEqual({ providerKey: "system", group: "admin" });
    expect(classifyRuntimeTool("gh")).toEqual({ providerKey: "github", group: "admin" });
    expect(classifyRuntimeTool("amp_coder")).toEqual({ providerKey: "github", group: "modify" });
  });

  it("treats delegation and tool help as never gated", () => {
    expect(classifyRuntimeTool("delegate_to_agent")).toBeNull();
    expect(classifyRuntimeTool("tool_help")).toBeNull();
  });
});

describe("classifyByVerbHeuristic", () => {
  it("classifies by leading/contained verb with admin precedence", () => {
    expect(classifyByVerbHeuristic("list_issues")).toBe("read");
    expect(classifyByVerbHeuristic("create_issue")).toBe("post");
    expect(classifyByVerbHeuristic("update_issue")).toBe("modify");
    expect(classifyByVerbHeuristic("delete_message")).toBe("admin");
    expect(classifyByVerbHeuristic("archive_channel")).toBe("admin");
  });

  it("falls back to admin for unrecognized verbs", () => {
    expect(classifyByVerbHeuristic("frobnicate_widget")).toBe("admin");
  });
});

describe("classifyMcpTool", () => {
  it("resolves provider from prefix and uses static map", () => {
    expect(classifyTool("slack__chat_postMessage")).toEqual({
      providerKey: "slack",
      group: "post",
    });
    expect(classifyTool("linear__create_issue")).toEqual({ providerKey: "linear", group: "post" });
    expect(classifyTool("linear__update_issue")).toEqual({
      providerKey: "linear",
      group: "modify",
    });
  });

  it("falls back to the verb heuristic for unmapped MCP tools", () => {
    expect(classifyMcpTool("linear__list_cycles")).toEqual({
      providerKey: "linear",
      group: "read",
    });
    expect(classifyMcpTool("acme__delete_widget")).toEqual({ providerKey: "acme", group: "admin" });
  });
});

describe("resolveToolDecision", () => {
  const empty: WorkspaceToolPolicyMap = new Map();

  it("allows ungated providers regardless of policy", () => {
    expect(
      resolveToolDecision({ toolName: "read_file", policy: empty, interactive: true }),
    ).toEqual({ decision: "allow", providerKey: "system", group: "read" });
    expect(
      resolveToolDecision({ toolName: "shell", policy: empty, interactive: true }).decision,
    ).toBe("allow");
    expect(
      resolveToolDecision({ toolName: "exa_search", policy: empty, interactive: true }).decision,
    ).toBe("allow");
  });

  it("applies the default hybrid stance for gated providers", () => {
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: empty, interactive: true }).decision,
    ).toBe("allow");
    expect(
      resolveToolDecision({ toolName: "slack__chat_postMessage", policy: empty, interactive: true })
        .decision,
    ).toBe("ask");
  });

  it("honors configured policy over the default stance", () => {
    const policy: WorkspaceToolPolicyMap = new Map([[policyMapKey("slack", "post"), "allow"]]);
    expect(
      resolveToolDecision({ toolName: "slack__chat_postMessage", policy, interactive: true })
        .decision,
    ).toBe("allow");

    const denyRead: WorkspaceToolPolicyMap = new Map([[policyMapKey("slack", "read"), "deny"]]);
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: denyRead, interactive: true })
        .decision,
    ).toBe("deny");
  });

  it("collapses ask to deny in non-interactive runs", () => {
    expect(
      resolveToolDecision({
        toolName: "slack__chat_postMessage",
        policy: empty,
        interactive: false,
      }).decision,
    ).toBe("deny");
    // deny stays deny; allow stays allow.
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: empty, interactive: false })
        .decision,
    ).toBe("allow");
  });
});

describe("buildDeniedToolOutput", () => {
  it("produces a non-recoverable permission_denied result", () => {
    const output = buildDeniedToolOutput({
      toolName: "slack__chat_postMessage",
      providerKey: "slack",
      group: "post",
      source: "user",
    });
    expect(output.ok).toBe(false);
    expect(output.denied).toBe(true);
    expect(output.error.code).toBe("permission_denied");
    expect(output.error.recoverable).toBe(false);
    expect(output.error.message).toContain("Slack");
    expect(output.error.message).toContain("Do not retry");
  });
});
