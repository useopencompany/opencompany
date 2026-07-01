import { agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentConfig,
  createLeaseDb,
  createStateLeaseWriteStore,
  env,
  type LeaseDbState,
  type MessageState,
} from "./agent-loop-test-support";
import {
  consumeCodexPlanModeForLease,
  resumableCodexSessionId,
  runCodexTurn,
} from "./codex-session";
import { setLeaseWriteStoreForTests } from "./lease-writes";

const executionOrder = vi.hoisted(() => [] as string[]);

const billingMocks = vi.hoisted(() => ({
  hasPositiveWorkspaceBalance: vi.fn(),
  recordWorkspaceUsageDebit: vi.fn(),
}));

const codexAppServerMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

const codexToolMocks = vi.hoisted(() => ({
  codexApiKeyFallbackEnabled: vi.fn(),
  codexHostedToolUsage: vi.fn(),
  codexRuntimeEventsFromJsonEvent: vi.fn(),
  ensureCodexInstalled: vi.fn(),
  loadWorkspaceCodexCliAuth: vi.fn(),
  persistRefreshedWorkspaceCodexAuth: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  appendRuntimeEvent: vi.fn(),
}));

const leaseWriteMocks = vi.hoisted(() => ({
  failRunLease: vi.fn(),
}));

const sessionLifecycleMocks = vi.hoisted(() => ({
  acquireCodexSandboxForTurn: vi.fn(),
  isSessionArchived: vi.fn(),
  loadAssistantResponseForMessage: vi.fn(),
  loadSession: vi.fn(),
  loadUserMessage: vi.fn(),
  parkSandboxWhenIdle: vi.fn(),
  resolveSandboxBilling: vi.fn(),
  setStatus: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  commandExitResult: vi.fn(),
  killSandbox: vi.fn(),
  sandboxLayout: vi.fn(),
}));

vi.mock("@opencompany/billing", async (importActual) => {
  const actual = await importActual<typeof import("@opencompany/billing")>();
  return {
    ...actual,
    hasPositiveWorkspaceBalance: billingMocks.hasPositiveWorkspaceBalance,
    recordWorkspaceUsageDebit: billingMocks.recordWorkspaceUsageDebit,
  };
});

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  endTimingTrace: vi.fn(),
  startTimingTrace: vi.fn(() => ({ startedAt: performance.now() })),
  timeAsync: vi.fn(async (_trace, _name, run) => run()),
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  flushBraintrust: vi.fn(),
  logBraintrustCurrentSpan: vi.fn(),
  traceBraintrust: vi.fn(async (_input, run) => run()),
  traceBraintrustStep: vi.fn(async (_name, run) => run(undefined)),
}));

vi.mock("./active-runs", () => ({
  clearActiveRun: vi.fn(),
  setActiveRun: vi.fn(),
}));

vi.mock("./amp-tool", () => ({
  loadConnectedGitHubInstallation: vi.fn(async () => null),
}));

vi.mock("./codex-app-server", () => ({
  runCodexAppServerTurn: codexAppServerMocks.runCodexAppServerTurn,
}));

vi.mock("./codex-tool", () => ({
  codexApiKeyFallbackEnabled: codexToolMocks.codexApiKeyFallbackEnabled,
  codexHostedToolUsage: codexToolMocks.codexHostedToolUsage,
  codexRuntimeEventsFromJsonEvent: codexToolMocks.codexRuntimeEventsFromJsonEvent,
  ensureCodexInstalled: codexToolMocks.ensureCodexInstalled,
  loadWorkspaceCodexCliAuth: codexToolMocks.loadWorkspaceCodexCliAuth,
  persistRefreshedWorkspaceCodexAuth: codexToolMocks.persistRefreshedWorkspaceCodexAuth,
}));

vi.mock("./delegation", () => ({
  completeDelegatedChildRunForParent: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => globalThis.__codexSessionTestDb,
}));

vi.mock("./durable-streams", () => ({
  detachSessionStream: vi.fn(),
}));

vi.mock("./events", () => ({
  appendRuntimeEvent: eventMocks.appendRuntimeEvent,
}));

vi.mock("./github", () => ({
  getGitHubWorkInstallationToken: vi.fn(),
}));

vi.mock("./lease-writes", async (importActual) => {
  const actual = await importActual<typeof import("./lease-writes")>();
  leaseWriteMocks.failRunLease.mockImplementation(
    async (
      sessionId: string,
      leaseId: string,
      leaseOwner: string,
      status: "aborting" | "failed",
      message: string,
    ) => {
      executionOrder.push("failRunLease");
      return actual.failRunLease(sessionId, leaseId, leaseOwner, status, message);
    },
  );
  return {
    ...actual,
    failRunLease: leaseWriteMocks.failRunLease,
  };
});

vi.mock("./llm-broker-tokens", () => ({
  withBrokerDelegation: vi.fn(),
}));

vi.mock("./run-control", async (importActual) => {
  const actual = await importActual<typeof import("./run-control")>();
  return {
    ...actual,
    createRunControlGate: vi.fn((input: { controller: AbortController }) => async () => {
      if (input.controller.signal.aborted) {
        throw new actual.RunAbortError();
      }
    }),
  };
});

vi.mock("./sandbox", () => ({
  commandExitResult: sandboxMocks.commandExitResult,
  killSandbox: sandboxMocks.killSandbox,
  sandboxLayout: sandboxMocks.sandboxLayout,
}));

vi.mock("./session-lifecycle", () => ({
  acquireCodexSandboxForTurn: sessionLifecycleMocks.acquireCodexSandboxForTurn,
  isSessionArchived: sessionLifecycleMocks.isSessionArchived,
  loadAssistantResponseForMessage: sessionLifecycleMocks.loadAssistantResponseForMessage,
  loadSession: sessionLifecycleMocks.loadSession,
  loadUserMessage: sessionLifecycleMocks.loadUserMessage,
  parkSandboxWhenIdle: sessionLifecycleMocks.parkSandboxWhenIdle,
  resolveSandboxBilling: sessionLifecycleMocks.resolveSandboxBilling,
  setStatus: sessionLifecycleMocks.setStatus,
}));

vi.mock("./skills", () => ({
  materializeCodexSkillsForSession: vi.fn(async () => ({ fingerprint: "skills-test" })),
}));

declare global {
  // eslint-disable-next-line no-var
  var __codexSessionTestDb: unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  executionOrder.length = 0;
  globalThis.__codexSessionTestDb = undefined;
  billingMocks.hasPositiveWorkspaceBalance.mockResolvedValue(true);
  billingMocks.recordWorkspaceUsageDebit.mockResolvedValue({ ledgerId: 1 });
  codexToolMocks.codexApiKeyFallbackEnabled.mockReturnValue(true);
  codexToolMocks.codexHostedToolUsage.mockReturnValue(null);
  codexToolMocks.codexRuntimeEventsFromJsonEvent.mockReturnValue([]);
  codexToolMocks.ensureCodexInstalled.mockResolvedValue(undefined);
  codexToolMocks.loadWorkspaceCodexCliAuth.mockResolvedValue(null);
  codexToolMocks.persistRefreshedWorkspaceCodexAuth.mockResolvedValue(undefined);
  eventMocks.appendRuntimeEvent.mockImplementation(async (_db, input) => {
    if (input.type === "session.sandbox_usage") {
      executionOrder.push("session.sandbox_usage");
    }
    return {
      id: executionOrder.length + 1,
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt: new Date(),
    };
  });
  sandboxMocks.commandExitResult.mockReturnValue(null);
  sandboxMocks.killSandbox.mockResolvedValue(undefined);
  sandboxMocks.sandboxLayout.mockReturnValue({
    codexRoot: "/workspace/codex",
  });
  sessionLifecycleMocks.acquireCodexSandboxForTurn.mockResolvedValue(createSandbox());
  sessionLifecycleMocks.isSessionArchived.mockResolvedValue(false);
  sessionLifecycleMocks.loadAssistantResponseForMessage.mockResolvedValue(null);
  sessionLifecycleMocks.loadSession.mockResolvedValue(createLoadedCodexSession());
  sessionLifecycleMocks.loadUserMessage.mockResolvedValue({ id: "msg_user" });
  sessionLifecycleMocks.parkSandboxWhenIdle.mockResolvedValue(undefined);
  sessionLifecycleMocks.resolveSandboxBilling.mockReturnValue({
    template: "codex",
    vcpu: 2,
    ramMib: 512,
  });
  sessionLifecycleMocks.setStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  setLeaseWriteStoreForTests(undefined);
});

describe("runCodexTurn sandbox usage exit paths", () => {
  it("records sandbox usage before failing the lease on abort after sandbox billing is populated", async () => {
    const abortController = new AbortController();
    const db = installCodexTurnDb();
    codexAppServerMocks.runCodexAppServerTurn.mockImplementationOnce(async (input) => {
      abortController.abort();
      await input.checkAbort();
    });

    await runCodexTurn({
      sessionId: "ses_123",
      messageId: "msg_user",
      env: env({ instanceId: "runner-test" }),
      externalSignal: abortController.signal,
    });

    expect(db.state.sandboxUsage).toHaveLength(1);
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "session.sandbox_usage" }),
    );
    expect(executionOrder).toContain("session.sandbox_usage");
    expect(executionOrder).toContain("failRunLease");
    expect(executionOrder.indexOf("session.sandbox_usage")).toBeLessThan(
      executionOrder.indexOf("failRunLease"),
    );
  });

  it("records sandbox usage before failing the lease on generic errors after sandbox billing is populated", async () => {
    const db = installCodexTurnDb();
    codexAppServerMocks.runCodexAppServerTurn.mockRejectedValueOnce(new Error("Codex exploded"));

    await expect(
      runCodexTurn({
        sessionId: "ses_123",
        messageId: "msg_user",
        env: env({ instanceId: "runner-test" }),
      }),
    ).rejects.toThrow("Codex exploded");

    expect(db.state.sandboxUsage).toHaveLength(1);
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "session.sandbox_usage" }),
    );
    expect(executionOrder).toContain("session.sandbox_usage");
    expect(executionOrder).toContain("failRunLease");
    expect(executionOrder.indexOf("session.sandbox_usage")).toBeLessThan(
      executionOrder.indexOf("failRunLease"),
    );
  });

  it("does not record sandbox usage when a failure happens before sandbox billing is populated", async () => {
    const db = installCodexTurnDb();
    sessionLifecycleMocks.acquireCodexSandboxForTurn.mockRejectedValueOnce(
      new Error("Sandbox unavailable"),
    );

    await expect(
      runCodexTurn({
        sessionId: "ses_123",
        messageId: "msg_user",
        env: env({ instanceId: "runner-test" }),
      }),
    ).rejects.toThrow("Sandbox unavailable");

    expect(db.state.sandboxUsage).toHaveLength(0);
    expect(executionOrder).not.toContain("session.sandbox_usage");
    expect(executionOrder).toContain("failRunLease");
  });
});

describe("consumeCodexPlanModeForLease", () => {
  it("clears the one-shot Codex plan mode latch under the active run lease", async () => {
    const returning = vi.fn(async () => [{ id: "ses_123" }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    globalThis.__codexSessionTestDb = { update };

    await consumeCodexPlanModeForLease({
      sessionId: "ses_123",
      leaseId: "lease_123",
      leaseOwner: "runner-a",
    });

    expect(update).toHaveBeenCalledWith(agentSessions);
    expect(set).toHaveBeenCalledWith({
      codexPlanModeEnabled: false,
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledWith({ id: agentSessions.id });
  });
});

function installCodexTurnDb() {
  const db = createCodexTurnDb();
  globalThis.__codexSessionTestDb = db;
  setLeaseWriteStoreForTests(createStateLeaseWriteStore(() => db.state as LeaseDbState));
  return db;
}

function createCodexTurnDb() {
  const userMessage: MessageState = {
    id: "msg_user",
    sessionId: "ses_123",
    role: "user",
    content: "Run Codex",
    modelMessage: { role: "user", content: "Run Codex" },
  };
  const db = createLeaseDb({ messages: [userMessage] });

  return {
    ...db,
    select: vi.fn(() => ({
      from(table: unknown) {
        const query = {
          innerJoin: () => query,
          where: () => query,
          limit: async () => {
            if (table === agentSessionMessages) {
              return db.state.messages
                .filter((message) => message.id === "msg_user" && message.role === "user")
                .map((message) => ({
                  id: message.id,
                  content: message.content ?? "",
                  modelMessage: message.modelMessage ?? null,
                }));
            }
            return [];
          },
        };
        return query;
      },
    })),
  };
}

function createLoadedCodexSession() {
  return {
    session: {
      id: "ses_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      agentId: "agt_123",
      status: "ready",
      source: "user",
      archivedAt: null,
      engine: "codex",
      modelName: "openai/gpt-5.5",
      codexPlanModeEnabled: false,
      codexPlanModeReasoningEffort: "medium",
      codexReasoningEffort: "medium",
      engineSessionId: null,
      e2bSandboxId: null,
      workdir: "/workspace",
    },
    agent: {
      id: "agt_123",
      isDefault: false,
      config: agentConfig({ engine: "codex" }),
    },
    workspace: {
      id: "wks_123",
    },
  };
}

function createSandbox() {
  return {
    sandboxId: "sbx_123",
    commands: {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}

describe("resumableCodexSessionId", () => {
  it("keeps a Codex session id from failed turns so retry messages can resume context", () => {
    expect(
      resumableCodexSessionId({
        sessionId: "019efe9c-a0a5-7f81-98a4-6fab601b4a76",
      }),
    ).toBe("019efe9c-a0a5-7f81-98a4-6fab601b4a76");
  });

  it("does not persist a missing Codex session id", () => {
    expect(resumableCodexSessionId({ sessionId: null })).toBeNull();
  });
});
