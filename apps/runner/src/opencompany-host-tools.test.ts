import { createProductChatToolContext } from "@opencompany/agent/chat-agent";
import { createProductChatSystemPrompt } from "@opencompany/agent/prompts";
import type { ChatHostBootstrap, ChatHostToolGatewayRequest } from "@opencompany/agent-runtime";
import { assert, describe, expect, it, vi } from "vitest";
import { loadHostTools } from "./opencompany-host-tools";

const bootstrap: ChatHostBootstrap = {
  userContext: {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    timezone: "Europe/London",
  },
  workspaceName: "Analytical Engines",
  taskToolsEnabled: true,
  skillToolsEnabled: true,
  subagentsEnabled: false,
  browserToolsEnabled: true,
  browserProfiles: [{ id: "profile_1", name: "GitHub", siteHost: "github.com" }],
  skills: [{ id: "sales", name: "Sales", description: "Sell thoughtfully." }],
  activeSkills: [
    {
      id: "sales",
      name: "Sales",
      description: "Sell thoughtfully.",
      instructions: "Verify every claim.",
    },
  ],
  workflows: [{ id: "research", name: "Research", description: "Research a market." }],
  recurringSchedules: [],
};

describe("loadHostTools", () => {
  it("keeps task execution tools but removes delegation tools and routing instructions", async () => {
    const hostTools = await loadHostTools(context(), {
      execute: async () => ({
        ok: true,
        result: { ...bootstrap, taskToolsEnabled: false, workflows: [], recurringSchedules: [] },
      }),
    });
    assert(hostTools);
    const { tools } = createProductChatToolContext({
      model: "moonshotai/kimi-k2.6" as never,
      ...hostTools,
      runWiki: hostTools.runWiki as never,
    });
    for (const name of [
      "start_task",
      "start_workflow",
      "schedule_task",
      "edit_task_schedule",
      "delete_task_schedule",
    ]) {
      expect(tools).not.toHaveProperty(name);
    }
    expect(tools).toHaveProperty("wiki");
    expect(tools).toHaveProperty("write_artifact");
    expect(tools).toHaveProperty("list_skills");

    const prompt = createProductChatSystemPrompt({
      taskToolsEnabled: hostTools.bootstrap.taskToolsEnabled,
      scheduleToolsEnabled: hostTools.bootstrap.taskToolsEnabled,
      workflows: hostTools.bootstrap.workflows,
    });
    expect(prompt).not.toContain("still call the task tool instead of refusing");
    expect(prompt).not.toContain("start_task");
    expect(prompt).not.toContain("start_workflow");
  });

  it("composes shared tools and authenticated browser profiles through one persisted service", async () => {
    const requests: ChatHostToolGatewayRequest[] = [];
    const execute = vi.fn(async ({ request }: { request: ChatHostToolGatewayRequest }) => {
      requests.push(request);
      return {
        ok: true,
        result:
          request.operation === "bootstrap"
            ? bootstrap
            : request.operation === "browser_use_profile"
              ? {
                  ok: true,
                  profile: { id: "profile_1", name: "GitHub", siteHost: "github.com" },
                }
              : request.operation === "browser"
                ? { ok: true, command: "browser_open", output: "opened" }
                : { ok: true },
      } as const;
    });

    const tools = await loadHostTools(context(), {
      execute,
    });

    expect(tools?.activeSkills).toHaveLength(1);
    await expect(
      tools?.browserProfiles?.useProfile({ profile: "GitHub", reason: "Read the issue" }),
    ).resolves.toMatchObject({ ok: true, profile: { name: "GitHub" } });
    await expect(
      tools?.browserTools?.({ name: "browser_open", args: { url: "https://github.com" } }),
    ).resolves.toMatchObject({ ok: true, output: "opened" });
    await tools?.startTask?.(
      {
        name: "Review code",
        prompt: "Review the code.",
        model: "openai/gpt-5.6-sol",
        engine: "codex",
      },
      { toolCallId: "call_task_1" },
    );
    await tools?.createWorkspaceSkill?.(
      {
        name: "customer-health-review",
        description: "Review customer health.",
        instructions: "Review the account signals.",
      },
      { toolCallId: "call_skill_1" },
    );
    await tools?.editWorkspaceSkill?.(
      {
        name: "add-mcp-provider-plugin",
        description: "Add an MCP provider plugin.",
        instructions: "Preserve the workflow and add provider steps.",
      },
      { toolCallId: "call_skill_edit_1" },
    );
    await tools?.writeArtifact(
      { filename: "report.md", title: "Report", content: "# Report" },
      { toolCallId: "call_artifact_1" },
    );
    await tools?.close();

    expect(requests.map((request) => request.operation)).toEqual([
      "bootstrap",
      "browser_use_profile",
      "browser",
      "start_task",
      "create_workspace_skill",
      "edit_workspace_skill",
      "write_artifact",
      "browser_end_profile",
    ]);
    expect(requests[3]).toMatchObject({
      operation: "start_task",
      toolCallId: "call_task_1",
      input: {
        model: "openai/gpt-5.6-sol",
        engine: "codex",
      },
    });
    expect(requests[4]).toMatchObject({
      operation: "create_workspace_skill",
      toolCallId: "call_skill_1",
      input: { name: "customer-health-review" },
    });
    expect(requests[5]).toMatchObject({
      operation: "edit_workspace_skill",
      toolCallId: "call_skill_edit_1",
      input: { name: "add-mcp-provider-plugin" },
    });
    expect(requests[6]).toMatchObject({
      operation: "write_artifact",
      toolCallId: "call_artifact_1",
      input: { filename: "report.md", title: "Report", content: "# Report" },
    });
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("does not call the web origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const tools = await loadHostTools(context(), {
      execute: async () => ({ ok: true, result: bootstrap }),
    });

    expect(tools?.bootstrap).toEqual(bootstrap);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("prelists skills discovered on earlier chat turns while they remain available", async () => {
    const execute = vi.fn(async ({ request }: { request: ChatHostToolGatewayRequest }) => ({
      ok: true as const,
      result:
        request.operation === "bootstrap"
          ? bootstrap
          : {
              ok: true,
              skill: {
                id: "sales",
                name: "Sales",
                description: "Sell thoughtfully.",
                instructions: "Verify every claim.",
              },
            },
    }));
    const tools = await loadHostTools(
      { ...context(), prelistedSkillIds: ["sales", "removed-skill"] },
      { execute },
    );
    assert(tools);
    const productTools = createProductChatToolContext({
      model: "moonshotai/kimi-k2.6" as never,
      ...tools,
      runWiki: tools.runWiki as never,
    }).tools;
    const useSkill = productTools.use_skill as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await expect(useSkill.execute({ skill: "sales" })).resolves.toMatchObject({
      ok: true,
      skill: { id: "sales" },
    });
    expect(tools.skills?.prelistedSkillIds).toEqual(["sales"]);
    expect(execute.mock.calls.map(([call]) => call.request.operation)).toEqual([
      "bootstrap",
      "use_skill",
    ]);
  });

  it("prelists every available skill for an approval continuation", async () => {
    const tools = await loadHostTools(
      { ...context(), approvalContinuation: true },
      { execute: async () => ({ ok: true, result: bootstrap }) },
    );

    expect(tools?.skills?.prelistedSkillIds).toEqual(["sales"]);
  });

  it("rejects unsafe Skill file paths before crossing the runner host boundary", async () => {
    const execute = vi.fn(async ({ request }: { request: ChatHostToolGatewayRequest }) => ({
      ok: true as const,
      result: request.operation === "bootstrap" ? bootstrap : {},
    }));
    const tools = await loadHostTools(context(), { execute });

    expect(() =>
      tools?.skills?.readFile?.({ skill: "sales", path: "../secrets", offset: 0, maxBytes: 64 }),
    ).toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    env: {
      vercelAiGatewayApiKey: "gateway-key",
      browserEnabled: true,
      subagentsEnabled: false,
      apiOrigin: "http://localhost:3001",
      apiInternalToken: "api-internal-secret",
    },
    signal: new AbortController().signal,
    mentionedSkillIds: ["sales"],
    approvalContinuation: false,
  };
}
