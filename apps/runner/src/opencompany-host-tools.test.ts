import type { ChatHostBootstrap, ChatHostToolGatewayRequest } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
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
  wikiEnabled: true,
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
    await tools?.close();

    expect(requests.map((request) => request.operation)).toEqual([
      "bootstrap",
      "browser_use_profile",
      "browser",
      "start_task",
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
    expect(execute).toHaveBeenCalledTimes(5);
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
      apiOrigin: "http://localhost:3001",
      apiInternalToken: "api-internal-secret",
    },
    signal: new AbortController().signal,
    mentionedSkillIds: ["sales"],
    approvalContinuation: false,
  };
}
