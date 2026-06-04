import { describe, expect, it } from "vitest";
import {
  buildDeniedToolOutput,
  classifyByVerbHeuristic,
  classifyMcpTool,
  classifyRuntimeTool,
  classifyTool,
  formatWorkspaceToolPolicyContext,
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
    expect(classifyRuntimeTool("x_search_posts")).toEqual({ providerKey: "x", group: "read" });
    expect(classifyRuntimeTool("youtube_get_transcript")).toEqual({
      providerKey: "youtube",
      group: "read",
    });
    expect(classifyRuntimeTool("tiktok_get_metadata")).toEqual({
      providerKey: "tiktok",
      group: "read",
    });
    expect(classifyRuntimeTool("tiktok_list_profile_posts")).toEqual({
      providerKey: "tiktok",
      group: "read",
    });
    expect(classifyRuntimeTool("instagram_get_transcript")).toEqual({
      providerKey: "instagram",
      group: "read",
    });
    expect(classifyRuntimeTool("instagram_search_profiles")).toEqual({
      providerKey: "instagram",
      group: "read",
    });
    expect(classifyRuntimeTool("social_get_job")).toEqual({
      providerKey: "system",
      group: "read",
    });
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
    // Upsert verbs degrade to modify, not the admin fallback.
    expect(classifyByVerbHeuristic("save_widget")).toBe("modify");
    expect(classifyByVerbHeuristic("upsert_record")).toBe("modify");
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
    // PostHog tool names resolve via the snake_case static map (normalizeRawToolName
    // folds the hyphenated runtime names before lookup).
    expect(classifyTool("posthog__get-sql-insight")).toEqual({
      providerKey: "posthog",
      group: "read",
    });
    expect(classifyTool("posthog__create-feature-flag")).toEqual({
      providerKey: "posthog",
      group: "post",
    });
    expect(classifyTool("posthog__update-feature-flag")).toEqual({
      providerKey: "posthog",
      group: "modify",
    });
    expect(classifyTool("posthog__delete-feature-flag")).toEqual({
      providerKey: "posthog",
      group: "admin",
    });
    // Admin gating for "*-set-active" must survive both hyphenated and sanitized
    // (underscored) name forms — otherwise the verb heuristic reads "set" as modify.
    for (const name of [
      "posthog__project-set-active",
      "posthog__project_set_active",
      "posthog__organization-set-active",
      "posthog__organization_set_active",
    ]) {
      expect(classifyTool(name)).toEqual({ providerKey: "posthog", group: "admin" });
    }
    // Linear's `save_*` upsert family classifies as modify (static map).
    expect(classifyTool("linear__save_comment")).toEqual({
      providerKey: "linear",
      group: "modify",
    });
    expect(classifyTool("linear__save_issue")).toEqual({
      providerKey: "linear",
      group: "modify",
    });
  });

  it("falls back to the verb heuristic for unmapped MCP tools", () => {
    expect(classifyMcpTool("linear__list_cycles")).toEqual({
      providerKey: "linear",
      group: "read",
    });
    // An unlisted Linear `save_*` tool degrades to modify via the verb heuristic,
    // not the admin fallback.
    expect(classifyMcpTool("linear__save_customer_need")).toEqual({
      providerKey: "linear",
      group: "modify",
    });
    expect(classifyMcpTool("acme__delete_widget")).toEqual({ providerKey: "acme", group: "admin" });
  });
});

describe("resolveToolDecision", () => {
  const empty: WorkspaceToolPolicyMap = new Map();

  it("allows ungated providers regardless of policy", () => {
    expect(
      resolveToolDecision({ toolName: "read_file", policy: empty, suspendable: true }),
    ).toEqual({ decision: "allow", providerKey: "system", group: "read" });
    expect(
      resolveToolDecision({ toolName: "shell", policy: empty, suspendable: true }).decision,
    ).toBe("allow");
    expect(
      resolveToolDecision({ toolName: "exa_search", policy: empty, suspendable: true }).decision,
    ).toBe("allow");
  });

  it("applies the default hybrid stance for gated providers", () => {
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: empty, suspendable: true }).decision,
    ).toBe("allow");
    expect(
      resolveToolDecision({ toolName: "slack__chat_postMessage", policy: empty, suspendable: true })
        .decision,
    ).toBe("ask");
  });

  it("honors configured policy over the default stance", () => {
    const policy: WorkspaceToolPolicyMap = new Map([[policyMapKey("slack", "post"), "allow"]]);
    expect(
      resolveToolDecision({ toolName: "slack__chat_postMessage", policy, suspendable: true })
        .decision,
    ).toBe("allow");

    const denyRead: WorkspaceToolPolicyMap = new Map([[policyMapKey("slack", "read"), "deny"]]);
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: denyRead, suspendable: true })
        .decision,
    ).toBe("deny");

    // save_comment is an upsert tool classified as `modify`, so the modify policy governs it.
    const denyLinearModify: WorkspaceToolPolicyMap = new Map([
      [policyMapKey("linear", "modify"), "deny"],
    ]);
    expect(
      resolveToolDecision({
        toolName: "linear__save_comment",
        policy: denyLinearModify,
        suspendable: true,
      }).decision,
    ).toBe("deny");

    // A post-only policy does not affect a modify-classified tool; it falls back to the
    // default modify stance ("ask").
    const denyLinearPost: WorkspaceToolPolicyMap = new Map([
      [policyMapKey("linear", "post"), "deny"],
    ]);
    expect(
      resolveToolDecision({
        toolName: "linear__save_comment",
        policy: denyLinearPost,
        suspendable: true,
      }).decision,
    ).toBe("ask");
  });

  it("collapses ask to deny in non-suspendable runs", () => {
    expect(
      resolveToolDecision({
        toolName: "slack__chat_postMessage",
        policy: empty,
        suspendable: false,
      }).decision,
    ).toBe("deny");
    // deny stays deny; allow stays allow.
    expect(
      resolveToolDecision({ toolName: "slack__search", policy: empty, suspendable: false })
        .decision,
    ).toBe("allow");
  });
});

describe("formatWorkspaceToolPolicyContext", () => {
  it("summarizes effective Linear policy decisions for the model", () => {
    const policy: WorkspaceToolPolicyMap = new Map([
      [policyMapKey("linear", "read"), "ask"],
      [policyMapKey("linear", "post"), "deny"],
      [policyMapKey("linear", "modify"), "deny"],
      [policyMapKey("linear", "admin"), "deny"],
    ]);

    expect(
      formatWorkspaceToolPolicyContext({
        providerKeys: ["linear"],
        policy,
        suspendable: true,
      }),
    ).toContain("Linear: Read=ask first, Post=deny, Modify=deny, Admin=deny.");
  });

  it("describes ask policies as denied for non-suspendable runs", () => {
    const policy: WorkspaceToolPolicyMap = new Map([[policyMapKey("linear", "read"), "ask"]]);

    const context = formatWorkspaceToolPolicyContext({
      providerKeys: ["linear"],
      policy,
      suspendable: false,
    });

    expect(context).toContain("Ask-first permissions cannot pause this run");
    expect(context).toContain("Linear: Read=deny");
  });

  it("omits ungated or unavailable providers", () => {
    expect(
      formatWorkspaceToolPolicyContext({
        providerKeys: ["exa", "missing"],
        policy: new Map(),
        suspendable: true,
      }),
    ).toBeNull();
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
