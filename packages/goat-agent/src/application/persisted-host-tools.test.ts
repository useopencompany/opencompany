import { describe, expect, it, vi } from "vitest";
import type { GoatChatHostToolServiceDependencies } from "./host-tools";
import { executePersistedGoatChatHostTool } from "./persisted-host-tools";

function executeHostTool(input: {
  request: Parameters<typeof executePersistedGoatChatHostTool>[0]["request"];
  dependencies?: Partial<GoatChatHostToolServiceDependencies>;
}) {
  return executePersistedGoatChatHostTool({
    request: input.request,
    runtime: {
      wakeTaskWorker: vi.fn(),
      defer: vi.fn(),
      planHarness: vi.fn(),
    },
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

describe("headless Chat host tools", () => {
  it("reattaches the matching authenticated browser profile after a worker recovery", async () => {
    const createAgentSession = vi.fn();
    const endAgentSession = vi.fn();
    const activeSession = {
      profile: {
        id: "profile_1",
        name: "GitHub",
        siteHost: "github.com",
        allowedHosts: ["github.com"],
      },
      sessionId: "browserbase_1",
      connectUrl: "wss://browser.example.test/session",
      liveViewPath: "/api/browser-profiles/profile_1/live-view?sessionId=browserbase_1",
      startedAt: new Date("2026-08-11T00:00:00.000Z"),
    };

    const response = await executeHostTool({
      request: {
        operation: "browser_use_profile",
        sessionId: "runtime_1",
        turnId: "run_1",
        input: { profile: "GitHub", reason: "Review the issue" },
      },
      dependencies: {
        loadContext: vi.fn(async () => ({
          actorId: "user_1",
          workspaceId: "workspace_1",
          workspaceName: "OpenCompany",
          conversationId: "conversation_1",
          messageId: "message_1",
          brainRef: null,
          email: "ada@example.test",
          firstName: "Ada",
          lastName: "Lovelace",
          timezone: "Europe/London",
          taskToolsEnabled: true,
          wikiEnabled: true,
        })),
        browserProfilesAvailable: () => true,
        listBrowserProfiles: vi.fn(async () => [activeSession.profile]),
        resolveActiveAgentSession: vi.fn(async () => activeSession),
        createAgentSession,
        endAgentSession,
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        ok: true,
        profile: { id: "profile_1", name: "GitHub", siteHost: "github.com" },
        liveViewUrl: activeSession.liveViewPath,
      },
    });
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(endAgentSession).not.toHaveBeenCalled();
  });
});
