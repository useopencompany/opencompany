import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfig, env } from "./agent-loop-test-support";

const e2bMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
}));

const materializeMocks = vi.hoisted(() => ({
  materializeAgentBundleForSession: vi.fn(),
  materializeBrainForSession: vi.fn(),
  materializeSkillsForSession: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: e2bMocks,
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: analyticsMocks.captureServerEvent,
}));

vi.mock("./agent-bundle", () => ({
  materializeAgentBundleForSession: materializeMocks.materializeAgentBundleForSession,
}));

vi.mock("./brain", () => ({
  materializeBrainForSession: materializeMocks.materializeBrainForSession,
}));

vi.mock("./skills", () => ({
  materializeSkillsForSession: materializeMocks.materializeSkillsForSession,
}));

import { ensureSandbox, optionalUserContext } from "./session-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  analyticsMocks.captureServerEvent.mockResolvedValue(undefined);
  materializeMocks.materializeAgentBundleForSession.mockResolvedValue(undefined);
  materializeMocks.materializeBrainForSession.mockResolvedValue(undefined);
  materializeMocks.materializeSkillsForSession.mockResolvedValue(undefined);
});

describe("optionalUserContext", () => {
  it("passes explicit first and last name fields from the loaded user row", () => {
    expect(
      optionalUserContext({
        email: "jonas.morgner@example.com",
        firstName: "Jonas",
        lastName: "C. Morgner",
      }),
    ).toEqual({
      userName: "Jonas C. Morgner",
      userFirstName: "Jonas",
      userLastName: "C. Morgner",
      userEmail: "jonas.morgner@example.com",
    });
  });

  it("keeps an email fallback when the auth provider has no profile name", () => {
    expect(
      optionalUserContext({
        email: "ada@example.com",
        firstName: null,
        lastName: null,
      }),
    ).toEqual({
      userEmail: "ada@example.com",
    });
  });
});

describe("ensureSandbox analytics", () => {
  it("captures raw E2B request and ready-with-files latency events", async () => {
    const sandbox = {
      sandboxId: "sbx_new",
      setTimeout: vi.fn().mockResolvedValue(undefined),
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };
    e2bMocks.create.mockResolvedValue(sandbox);

    const row = {
      session: {
        id: "session_123",
        userId: "user_123",
        e2bSandboxId: null,
        workdir: "/home/user/workspace",
      },
      workspace: { id: "workspace_123" },
      agent: { id: "agent_123", config: agentConfig() },
    };

    await expect(ensureSandbox(row as never, env())).resolves.toBe(sandbox);

    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "e2b_sandbox_latency",
      "user_123",
      expect.objectContaining({
        user_id: "user_123",
        workspace_id: "workspace_123",
        agent_id: "agent_123",
        session_id: "session_123",
        phase: "e2b_request",
        operation: "create",
        outcome: "success",
        existing_sandbox: false,
        template: "default",
        sandbox_id: "sbx_new",
        latency_ms: expect.any(Number),
      }),
    );
    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "e2b_sandbox_latency",
      "user_123",
      expect.objectContaining({
        phase: "sandbox_ready",
        operation: "hydrate",
        outcome: "success",
        existing_sandbox: false,
        template: "default",
        sandbox_id: "sbx_new",
        latency_ms: expect.any(Number),
      }),
    );
    const readyCallIndex = analyticsMocks.captureServerEvent.mock.calls.findIndex(
      (call) => call[2]?.phase === "sandbox_ready",
    );
    expect(readyCallIndex).toBeGreaterThanOrEqual(0);
    const readyCallOrder =
      analyticsMocks.captureServerEvent.mock.invocationCallOrder[readyCallIndex];
    expect(readyCallOrder).toBeDefined();
    expect(materializeMocks.materializeSkillsForSession.mock.invocationCallOrder[0]).toBeLessThan(
      readyCallOrder!,
    );
  });
});
