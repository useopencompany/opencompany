import { describe, expect, it, vi } from "vitest";
import type { ChatHostToolServiceDependencies } from "./host-tools";
import { executePersistedChatHostTool, taskSpawnIdempotencyKey } from "./persisted-host-tools";

const listSkillCatalog = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../skills", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSkillCatalog,
}));

function executeHostTool(input: {
  request: Parameters<typeof executePersistedChatHostTool>[0]["request"];
  dependencies?: Partial<ChatHostToolServiceDependencies>;
}) {
  return executePersistedChatHostTool({
    request: input.request,
    runtime: {
      wakeTaskWorker: vi.fn(),
      defer: vi.fn(),
      gatewayApiKey: "gateway-key",
      planHarness: vi.fn(),
    },
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

describe("headless Chat host tools", () => {
  it("forwards company scope and the acting member through the persisted task catalog adapter", async () => {
    const response = await executeHostTool({
      request: { operation: "bootstrap", sessionId: "runtime_1", turnId: "turn_1", input: {} },
      dependencies: {
        loadContext: async () => ({
          actorId: "user_1",
          workspaceId: "workspace_1",
          workspaceName: "opencompany",
          conversationId: "task_conversation",
          messageId: "message_1",
          brainRef: null,
          email: "ada@example.test",
          firstName: "Ada",
          lastName: "Lovelace",
          timezone: "UTC",
          taskToolsEnabled: false,
          taskConversation: true,
          skillToolsEnabled: true,
          subagentsEnabled: false,
          legacyBrainEnabled: false,
        }),
        listBrains: async () => [],
        browserProfilesAvailable: () => false,
        activateAndListSkills: async () => [],
      },
    });
    expect(response.ok).toBe(true);
    expect(listSkillCatalog).toHaveBeenCalledWith("workspace_1", undefined, "user_1", "company");
  });

  it("derives stable, distinct task idempotency keys from each tool call", () => {
    expect(taskSpawnIdempotencyKey("turn_1", "call_1")).toBe(
      taskSpawnIdempotencyKey("turn_1", "call_1"),
    );
    expect(taskSpawnIdempotencyKey("turn_1", "call_1")).not.toBe(
      taskSpawnIdempotencyKey("turn_1", "call_2"),
    );
    expect(taskSpawnIdempotencyKey("turn_1")).toBe("agent:turn_1");
    expect(taskSpawnIdempotencyKey("turn_1", "provider id with spaces")).toMatch(
      /^agent:turn_1:tool:[a-f0-9]{64}$/,
    );
  });

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
          taskConversation: false,
          actorId: "user_1",
          workspaceId: "workspace_1",
          workspaceName: "opencompany",
          conversationId: "conversation_1",
          messageId: "message_1",
          brainRef: null,
          email: "ada@example.test",
          firstName: "Ada",
          lastName: "Lovelace",
          timezone: "Europe/London",
          taskToolsEnabled: true,
          skillToolsEnabled: true,
          subagentsEnabled: false,
          legacyBrainEnabled: false,
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
