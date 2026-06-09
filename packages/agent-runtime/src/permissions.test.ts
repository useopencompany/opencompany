import { describe, expect, it } from "vitest";
import {
  buildDeniedToolOutput,
  classifyByVerbHeuristic,
  classifyGitHubCliArgs,
  classifyMcpTool,
  classifyRuntimeTool,
  classifyTool,
  formatWorkspaceToolPolicyContext,
  mcpInvokeEffectiveToolName,
  policyMapKey,
  resolveToolDecision,
  type WorkspaceToolPolicyMap,
} from "./permissions";

describe("classifyRuntimeTool", () => {
  it("maps first-party tools to provider + group", () => {
    expect(classifyRuntimeTool("exa_search")).toEqual({ providerKey: "exa", group: "read" });
    expect(classifyRuntimeTool("edit_file")).toEqual({ providerKey: "system", group: "modify" });
    expect(classifyRuntimeTool("shell")).toEqual({ providerKey: "system", group: "admin" });
    expect(classifyRuntimeTool("memory")).toEqual({ providerKey: "system", group: "read" });
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
    expect(classifyTool("betterstack__telemetry_query")).toEqual({
      providerKey: "betterstack",
      group: "read",
    });
    expect(classifyTool("betterstack__uptime_create_incident_tool")).toEqual({
      providerKey: "betterstack",
      group: "post",
    });
    expect(classifyTool("betterstack__telemetry_edit_chart_tool")).toEqual({
      providerKey: "betterstack",
      group: "modify",
    });
    expect(classifyTool("betterstack__telemetry_remove_dashboard_tool")).toEqual({
      providerKey: "betterstack",
      group: "admin",
    });
    // Braintrust's MCP server is read-only — every tool maps to read.
    expect(classifyTool("braintrust__sql_query")).toEqual({
      providerKey: "braintrust",
      group: "read",
    });
    expect(classifyTool("braintrust__summarize_experiment")).toEqual({
      providerKey: "braintrust",
      group: "read",
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

describe("classifyGitHubCliArgs", () => {
  it("classifies read-only gh commands as read", () => {
    for (const args of [
      "pr view 301 --json number,title,url",
      "pr list --limit 10",
      "pr diff 301 -- CHANGELOG.md",
      "pr status",
      "pr checks 301",
      "issue view 123",
      "issue list --state open",
      "issue status",
      "release view v1.0.0",
      "release list --limit 10",
      "repo view opencompany/web",
      "repo list opencompany",
      "api repos/opencompany/web/pulls/301",
      "api --method GET repos/opencompany/web/pulls/301",
      "api --method GET repos/opencompany/web/issues -f title=bug",
      "--repo opencompany/web pr diff 301",
    ]) {
      expect(classifyGitHubCliArgs(args)).toBe("read");
    }
  });

  it("classifies gh commands with external side effects as modify", () => {
    for (const args of [
      "pr create --fill",
      "pr edit 301 --title updated",
      "pr comment 301 --body hello",
      "pr close 301",
      "pr reopen 301",
      "pr merge 301 --squash",
      "pr review 301 --approve",
      "issue create --title bug",
      "issue edit 123 --title updated",
      "issue comment 123 --body hello",
      "release create v1.0.0",
      "release edit v1.0.0 --notes updated",
      "release upload v1.0.0 artifact.tgz",
      "gist create notes.md",
      "gist edit abc123 notes.md",
      "repo fork opencompany/web",
      "repo clone opencompany/web work/opencompany-web",
      "api --method POST repos/opencompany/web/issues",
      "api --method PUT repos/opencompany/web/pulls/301/merge",
      "api --method PATCH repos/opencompany/web/issues/123",
      "api repos/opencompany/web/issues -f title=bug",
      "api repos/opencompany/web/issues -F title=bug",
      "api repos/opencompany/web/issues --field title=bug",
      "api repos/opencompany/web/issues --raw-field title=bug",
      "api repos/opencompany/web/issues --input body.json",
      "api repos/opencompany/web/issues --field=title=bug",
      "api repos/opencompany/web/issues --raw-field=title=bug",
      "api repos/opencompany/web/issues --input=body.json",
      "api graphql -f query='mutation { __typename }'",
    ]) {
      expect(classifyGitHubCliArgs(args)).toBe("modify");
    }
  });

  it("classifies destructive, unknown, empty, or malformed gh args as admin", () => {
    for (const args of [
      "repo delete opencompany/web --yes",
      "api --method DELETE repos/opencompany/web/issues/comments/1",
      "pr frobnicate 301",
      "workflow run deploy.yml",
      "",
      "   ",
      "pr view 'unterminated",
    ]) {
      expect(classifyGitHubCliArgs(args)).toBe("admin");
    }
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
    expect(resolveToolDecision({ toolName: "memory", policy: empty, suspendable: true })).toEqual({
      decision: "allow",
      providerKey: "system",
      group: "read",
    });
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

  it("gates the built-in use_tool dispatcher by the underlying tool", () => {
    // Ungated underlying tools resolve to allow regardless of the dispatcher wrapper.
    expect(
      resolveToolDecision({
        toolName: "use_tool",
        toolInput: { tool: "exa_search", arguments: { query: "x" } },
        policy: new Map(),
        suspendable: true,
      }),
    ).toEqual({ decision: "allow", providerKey: "exa", group: "read" });
    expect(
      resolveToolDecision({
        toolName: "use_tool",
        toolInput: { tool: "edit_file", arguments: {} },
        policy: new Map(),
        suspendable: true,
      }),
    ).toEqual({ decision: "allow", providerKey: "system", group: "modify" });

    // A github-gated underlying tool (amp_coder → github/modify) follows the github policy.
    const decision = resolveToolDecision({
      toolName: "use_tool",
      toolInput: { tool: "amp_coder", arguments: {} },
      policy: new Map(),
      suspendable: true,
    });
    expect(decision.providerKey).toBe("github");
    expect(decision.group).toBe("modify");
    expect(decision.decision).toBe("ask");

    const allowModify: WorkspaceToolPolicyMap = new Map([
      [policyMapKey("github", "modify"), "allow"],
    ]);
    expect(
      resolveToolDecision({
        toolName: "use_tool",
        toolInput: { tool: "amp_coder", arguments: {} },
        policy: allowModify,
        suspendable: true,
      }).decision,
    ).toBe("allow");
  });

  it("uses gh args to apply GitHub read/modify/admin policies", () => {
    const allowModify: WorkspaceToolPolicyMap = new Map([
      [policyMapKey("github", "modify"), "allow"],
    ]);

    expect(
      resolveToolDecision({
        toolName: "gh",
        toolInput: { args: "pr diff 301" },
        policy: new Map(),
        suspendable: true,
      }),
    ).toEqual({ decision: "allow", providerKey: "github", group: "read" });
    expect(
      resolveToolDecision({
        toolName: "gh",
        toolInput: { args: "pr create --fill" },
        policy: allowModify,
        suspendable: true,
      }),
    ).toEqual({ decision: "allow", providerKey: "github", group: "modify" });
    expect(
      resolveToolDecision({
        toolName: "gh",
        toolInput: { args: "repo delete opencompany/web --yes" },
        policy: allowModify,
        suspendable: true,
      }),
    ).toEqual({ decision: "ask", providerKey: "github", group: "admin" });
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

  // The lazy MCP invoke tool `{server}__use_tool` carries the real action in its `tool`
  // argument, so the gate must classify by that — not the generic invoke name.
  it("gates the lazy MCP invoke tool by its `tool` argument", () => {
    // A read tool routed through use_tool stays allowed.
    expect(
      resolveToolDecision({
        toolName: "slack__use_tool",
        toolInput: { tool: "search", arguments: { query: "launch" } },
        policy: empty,
        suspendable: true,
      }),
    ).toMatchObject({ decision: "allow", providerKey: "slack", group: "read" });

    // A write tool routed through use_tool still hits its write gate.
    expect(
      resolveToolDecision({
        toolName: "slack__use_tool",
        toolInput: { tool: "chat_postMessage", arguments: {} },
        policy: empty,
        suspendable: true,
      }),
    ).toMatchObject({ decision: "ask", providerKey: "slack", group: "post" });
  });

  it("gates an invoke call with no usable `tool` argument conservatively as admin", () => {
    // No verb to classify → admin fallback → gated (default admin stance is "ask").
    const decision = resolveToolDecision({
      toolName: "slack__use_tool",
      toolInput: { arguments: {} },
      policy: empty,
      suspendable: true,
    });
    expect(decision.group).toBe("admin");
    expect(decision.decision).not.toBe("allow");
  });
});

describe("mcpInvokeEffectiveToolName", () => {
  it("rewrites a use_tool call to the real action name", () => {
    expect(mcpInvokeEffectiveToolName("slack__use_tool", { tool: "chat_postMessage" })).toBe(
      "slack__chat_postMessage",
    );
  });

  it("leaves non-invoke and unparseable tool names unchanged", () => {
    expect(mcpInvokeEffectiveToolName("slack__search_tools", { query: "x" })).toBe(
      "slack__search_tools",
    );
    expect(mcpInvokeEffectiveToolName("shell", { command: "ls" })).toBe("shell");
    // Missing/blank tool arg keeps the invoke name so it classifies as the admin fallback.
    expect(mcpInvokeEffectiveToolName("slack__use_tool", {})).toBe("slack__use_tool");
    expect(mcpInvokeEffectiveToolName("slack__use_tool", { tool: "  " })).toBe("slack__use_tool");
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
