import type {
  GoatChatHostBootstrap,
  GoatChatHostToolGatewayRequest,
} from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { loadGoatOpenCompanyHostTools } from "./goat-opencompany-host-tools";

const bootstrap: GoatChatHostBootstrap = {
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

describe("loadGoatOpenCompanyHostTools", () => {
  it("composes shared tools and authenticated browser profiles through one persisted service", async () => {
    const requests: GoatChatHostToolGatewayRequest[] = [];
    const execute = vi.fn(async ({ request }: { request: GoatChatHostToolGatewayRequest }) => {
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

    const tools = await loadGoatOpenCompanyHostTools(context(), {
      execute,
    });

    expect(tools?.activeSkills).toHaveLength(1);
    await expect(
      tools?.browserProfiles?.useProfile({ profile: "GitHub", reason: "Read the issue" }),
    ).resolves.toMatchObject({ ok: true, profile: { name: "GitHub" } });
    await expect(
      tools?.browserTools?.({ name: "browser_open", args: { url: "https://github.com" } }),
    ).resolves.toMatchObject({ ok: true, output: "opened" });
    await tools?.close();

    expect(requests.map((request) => request.operation)).toEqual([
      "bootstrap",
      "browser_use_profile",
      "browser",
      "browser_end_profile",
    ]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not call the web origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const tools = await loadGoatOpenCompanyHostTools(context(), {
      execute: async () => ({ ok: true, result: bootstrap }),
    });

    expect(tools?.bootstrap).toEqual(bootstrap);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    env: { vercelAiGatewayApiKey: "gateway-key", goatBrowserEnabled: true },
    signal: new AbortController().signal,
    mentionedSkillIds: ["sales"],
    approvalContinuation: false,
  };
}
