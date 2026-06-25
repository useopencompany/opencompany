import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfig, env } from "./agent-loop-test-support";

const e2bMocks = vi.hoisted(() => ({
  connect: vi.fn(),
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

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

const durableStreamMocks = vi.hoisted(() => ({
  closeSessionStream: vi.fn(),
  publishToDurableStream: vi.fn(),
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

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("./durable-streams", () => ({
  closeSessionStream: durableStreamMocks.closeSessionStream,
  publishToDurableStream: durableStreamMocks.publishToDurableStream,
}));

import { agentSessionEvents } from "@opencompany/db/schema";
import {
  acquireCodexSandboxForTurn,
  completeSpawnedAfterSessionRunForChild,
  ensureSandbox,
  optionalUserContext,
  resolveSandboxBilling,
  summarizeAfterSessionNote,
} from "./session-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  analyticsMocks.captureServerEvent.mockResolvedValue(undefined);
  materializeMocks.materializeAgentBundleForSession.mockResolvedValue(undefined);
  materializeMocks.materializeBrainForSession.mockResolvedValue(undefined);
  materializeMocks.materializeSkillsForSession.mockResolvedValue(undefined);
  durableStreamMocks.publishToDurableStream.mockResolvedValue(undefined);
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

describe("completeSpawnedAfterSessionRunForChild", () => {
  it("marks the spawned parent run completed and appends a parent completion event", async () => {
    const updates: Record<string, unknown>[] = [];
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 12,
                sessionId: "ses_parent",
                lastUserMessageId: "msg_user",
                status: "spawned",
              },
            ],
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => undefined };
        },
      })),
      insert: vi.fn((table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return {
            returning: async () => [
              {
                id: 101,
                sessionId: values.sessionId,
                messageId: values.messageId ?? null,
                type: values.type,
                payload: values.payload,
                createdAt: new Date("2026-06-09T10:00:00.000Z"),
              },
            ],
          };
        },
      })),
    };
    dbMocks.getDb.mockReturnValue(db);

    await completeSpawnedAfterSessionRunForChild({
      childSessionId: "ses_memory",
      status: "completed",
    });

    expect(updates[0]).toMatchObject({
      status: "completed",
      lastError: null,
    });
    expect(inserts).toEqual([
      {
        table: agentSessionEvents,
        values: {
          sessionId: "ses_parent",
          messageId: null,
          type: "after_session.completed",
          payload: {
            runId: 12,
            messageId: "msg_user",
            childSessionId: "ses_memory",
          },
        },
      },
    ]);
    expect(durableStreamMocks.publishToDurableStream).toHaveBeenCalledWith(
      "ses_parent",
      expect.objectContaining({
        type: "after_session.completed",
        payload: expect.objectContaining({ childSessionId: "ses_memory" }),
      }),
    );
  });

  it("forwards the keeper's summary into the parent completion event payload", async () => {
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 12,
                sessionId: "ses_parent",
                lastUserMessageId: "msg_user",
                status: "spawned",
              },
            ],
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: () => ({ where: async () => undefined }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return {
            returning: async () => [
              {
                id: 101,
                sessionId: values.sessionId,
                messageId: values.messageId ?? null,
                type: values.type,
                payload: values.payload,
                createdAt: new Date("2026-06-09T10:00:00.000Z"),
              },
            ],
          };
        },
      })),
    };
    dbMocks.getDb.mockReturnValue(db);

    await completeSpawnedAfterSessionRunForChild({
      childSessionId: "ses_memory",
      status: "completed",
      summary: "Remembered the integration-connection-pill product idea.",
    });

    expect(inserts[0]?.values).toMatchObject({
      type: "after_session.completed",
      payload: {
        runId: 12,
        messageId: "msg_user",
        childSessionId: "ses_memory",
        summary: "Remembered the integration-connection-pill product idea.",
      },
    });
  });
});

describe("summarizeAfterSessionNote", () => {
  it("collapses whitespace and caps the note length", () => {
    expect(summarizeAfterSessionNote("  Saved a fact.\nAnd another.  ")).toBe(
      "Saved a fact. And another.",
    );
    expect(summarizeAfterSessionNote("")).toBeUndefined();
    expect(summarizeAfterSessionNote("   \n  ")).toBeUndefined();
    const long = "x".repeat(400);
    expect(summarizeAfterSessionNote(long)).toHaveLength(280);
    expect(summarizeAfterSessionNote(long)?.endsWith("...")).toBe(true);
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

describe("acquireCodexSandboxForTurn", () => {
  it("connects to an existing sandbox without rematerializing the filesystem", async () => {
    const sandbox = {
      sandboxId: "sbx_existing",
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };
    e2bMocks.connect.mockResolvedValue(sandbox);

    const row = loadedSessionRow({ e2bSandboxId: "sbx_existing", engine: "codex" });

    await expect(acquireCodexSandboxForTurn(row as never, env())).resolves.toBe(sandbox);

    expect(e2bMocks.connect).toHaveBeenCalledWith("sbx_existing", {
      timeoutMs: 3_600_000,
      requestTimeoutMs: 30_000,
    });
    expect(e2bMocks.create).not.toHaveBeenCalled();
    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(materializeMocks.materializeBrainForSession).not.toHaveBeenCalled();
    expect(materializeMocks.materializeAgentBundleForSession).not.toHaveBeenCalled();
    expect(materializeMocks.materializeSkillsForSession).not.toHaveBeenCalled();
    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "e2b_sandbox_latency",
      "user_123",
      expect.objectContaining({
        phase: "e2b_request",
        operation: "connect",
        outcome: "success",
        existing_sandbox: true,
        sandbox_id: "sbx_existing",
        requested_sandbox_id: "sbx_existing",
      }),
    );
    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "e2b_sandbox_latency",
      "user_123",
      expect.objectContaining({
        phase: "sandbox_ready",
        operation: "connect",
        outcome: "success",
        existing_sandbox: true,
        sandbox_id: "sbx_existing",
        requested_sandbox_id: "sbx_existing",
      }),
    );
  });

  it("fully hydrates when the session has no sandbox id", async () => {
    const sandbox = hydratedSandbox("sbx_new");
    e2bMocks.create.mockResolvedValue(sandbox);

    const row = loadedSessionRow({ e2bSandboxId: null, engine: "codex" });

    await expect(
      acquireCodexSandboxForTurn(row as never, env({ ampE2bTemplate: "custom-amp-template" })),
    ).resolves.toBe(sandbox);

    expect(e2bMocks.connect).not.toHaveBeenCalled();
    expect(e2bMocks.create).toHaveBeenCalledTimes(1);
    expect(e2bMocks.create).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        timeoutMs: 30_000,
        lifecycle: { onTimeout: "pause", autoResume: true },
      }),
    );
    expect(sandbox.commands.run).toHaveBeenCalled();
    expect(materializeMocks.materializeAgentBundleForSession).toHaveBeenCalled();
    expect(materializeMocks.materializeSkillsForSession).toHaveBeenCalled();
  });

  it("falls back to full hydration for stale sandbox ids without a second connect attempt", async () => {
    const sandbox = hydratedSandbox("sbx_replacement");
    e2bMocks.connect.mockRejectedValue(new Error("sandbox not found"));
    e2bMocks.create.mockResolvedValue(sandbox);

    const row = loadedSessionRow({ e2bSandboxId: "sbx_stale", engine: "codex" });

    await expect(acquireCodexSandboxForTurn(row as never, env())).resolves.toBe(sandbox);

    expect(e2bMocks.connect).toHaveBeenCalledTimes(1);
    expect(e2bMocks.connect).toHaveBeenCalledWith("sbx_stale", {
      timeoutMs: 3_600_000,
      requestTimeoutMs: 30_000,
    });
    expect(e2bMocks.create).toHaveBeenCalledTimes(1);
    expect(materializeMocks.materializeAgentBundleForSession).toHaveBeenCalled();
    expect(materializeMocks.materializeSkillsForSession).toHaveBeenCalled();
    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "e2b_sandbox_latency",
      "user_123",
      expect.objectContaining({
        phase: "e2b_request",
        operation: "connect",
        outcome: "not_found",
        existing_sandbox: true,
        requested_sandbox_id: "sbx_stale",
      }),
    );
  });
});

describe("resolveSandboxBilling", () => {
  it("uses the Codex template and 8 vCPU / 8 GiB allocation for Codex sessions", () => {
    const row = loadedSessionRow({ e2bSandboxId: null, engine: "codex" });

    expect(
      resolveSandboxBilling(row as never, env({ ampE2bTemplate: "custom-amp-template" })),
    ).toEqual({
      template: "codex",
      vcpu: 8,
      ramMib: 8192,
    });
  });

  it("keeps non-Codex coding agents on the AMP template and base allocation", () => {
    const row = loadedSessionRow({
      e2bSandboxId: null,
      engine: "opencompany",
      tools: [{ id: "opencode", type: "builtin" }],
    });

    expect(
      resolveSandboxBilling(row as never, env({ ampE2bTemplate: "custom-amp-template" })),
    ).toEqual({
      template: "custom-amp-template",
      vcpu: 2,
      ramMib: 512,
    });
  });
});

function hydratedSandbox(sandboxId: string) {
  return {
    sandboxId,
    setTimeout: vi.fn().mockResolvedValue(undefined),
    commands: {
      run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    },
    files: {
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function loadedSessionRow(input: {
  e2bSandboxId: string | null;
  engine?: "opencompany" | "codex";
  tools?: ReturnType<typeof agentConfig>["tools"];
}) {
  const engine = input.engine ?? "codex";
  return {
    session: {
      id: "session_123",
      userId: "user_123",
      workspaceId: "workspace_123",
      agentId: "agent_123",
      e2bSandboxId: input.e2bSandboxId,
      workdir: "/home/user/workspace",
      engine,
    },
    workspace: { id: "workspace_123" },
    agent: {
      id: "agent_123",
      isDefault: false,
      config: agentConfig({
        engine,
        ...(input.tools ? { tools: input.tools } : {}),
      }),
    },
  };
}
