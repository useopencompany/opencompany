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
  it("composes web-owned tools and authenticated browser profiles through one host gateway", async () => {
    const requests: GoatChatHostToolGatewayRequest[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as GoatChatHostToolGatewayRequest;
      requests.push(request);
      return Response.json({
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
      });
    });

    const tools = await loadGoatOpenCompanyHostTools(context(), {
      fetch: fetch as typeof globalThis.fetch,
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
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer runner-secret",
    });
  });

  it("fails closed when the internal host is not configured", async () => {
    await expect(
      loadGoatOpenCompanyHostTools({
        ...context(),
        env: { goatAppUrl: undefined, internalToken: "runner-secret" },
      }),
    ).resolves.toBeNull();
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    env: { goatAppUrl: "https://app.example.com", internalToken: "runner-secret" },
    signal: new AbortController().signal,
    mentionedSkillIds: ["sales"],
    approvalContinuation: false,
  };
}
