import {
  ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
  ACTION_HOST_TOOL_CONTRACT_VERSION_V3,
  ACTION_HOST_TOOL_CONTRACT_VERSION_V4,
  ACTION_MAX_CALLS_PER_TURN,
  type ActionGatewayRequest,
  CHAT_HOST_TOOL_CONTRACT_VERSION_V3,
  CHAT_HOST_TOOL_CONTRACT_VERSION_V4,
} from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_EFFECTS_METERED_READ,
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  type ResolvedAction,
  type ResolvedActionCatalog,
} from "../actions/types";
import type { ActionGatewayServiceDependencies } from "./action-gateway";
import {
  createActionGateway,
  createActionHostGateway,
  createActionPrincipalGateway,
} from "./persisted-action-gateway";

function listRequest(source?: string): ActionGatewayRequest {
  return {
    operation: "list",
    sessionId: "codex_session_1",
    turnId: "codex_turn_1",
    ...(source ? { source } : {}),
  };
}

const context = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  conversationId: "chat_1",
  userTimezone: "Europe/Paris",
};

const interactiveContext = {
  ...context,
  policy: "foregroundInteractive" as const,
};

describe("executeActionGateway", () => {
  it("admits an identical non-idempotent write only once across fresh tool ids and gateway instances", async () => {
    const action = {
      ...createReadAction(),
      effects: ACTION_EFFECTS_WRITE,
      capability: "write" as const,
    };
    const admitted = new Set<string>();
    const claimInvocation = vi.fn<ActionGatewayServiceDependencies["claimInvocation"]>(
      async ({ run, invocationId, deduplicationKey }) => {
        const keys = [invocationId, ...(deduplicationKey ? [deduplicationKey] : [])].map(
          (key) => `${run.runId}:${key}`,
        );
        const duplicate = keys.some((key) => admitted.has(key));
        if (!duplicate) for (const key of keys) admitted.add(key);
        return { ok: true as const, duplicate, callCount: admitted.size };
      },
    );
    const executeAction = vi.fn(async () => ({
      ok: true as const,
      action: action.id,
      result: { id: "original_result" },
    }));
    const dependencies = {
      loadContext: vi.fn(async () => interactiveContext),
      resolveCatalog: vi.fn(async () => ({
        providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
        actions: [action],
      })),
      claimInvocation,
      executeAction,
    };
    const call = (invocationId: string, params: Record<string, unknown>, turnId = "turn_1") =>
      createActionGateway(dependencies)({
        request: {
          operation: "execute",
          sessionId: "session_1",
          turnId,
          action: action.id,
          invocationId,
          params,
        },
        signal: new AbortController().signal,
      });
    const results = await Promise.all([
      call("approved_call", { title: "Planning", time: "10:00" }),
      call("regenerated_call", { time: "10:00", title: "Planning" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "duplicate_invocation" }),
      }),
    );
    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "approved_call" }),
    );
    expect((await call("approved_call", { title: "Changed input", time: "12:00" })).ok).toBe(false);
    expect((await call("different_write", { title: "Planning", time: "11:00" })).ok).toBe(true);
    expect((await call("next_turn", { title: "Planning", time: "10:00" }, "turn_2")).ok).toBe(true);
    expect(executeAction).toHaveBeenCalledTimes(3);
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([ACTION_EFFECTS_READ, { ...ACTION_EFFECTS_WRITE, idempotent: true }])(
    "retains invocation-based admission for retry-safe effects %j",
    async (effects) => {
      const action = { ...createReadAction(), effects };
      const claimInvocation = vi.fn<ActionGatewayServiceDependencies["claimInvocation"]>(
        async () => ({
          ok: true as const,
          callCount: 1,
          duplicate: false,
        }),
      );
      const gateway = createActionGateway({
        loadContext: vi.fn(async () => interactiveContext),
        resolveCatalog: vi.fn(async () => ({
          providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
          actions: [action],
        })),
        claimInvocation,
        executeAction: vi.fn(async () => ({ ok: true as const, action: action.id, result: {} })),
      });
      for (const invocationId of ["call_1", "call_2"]) {
        expect(
          (
            await gateway({
              request: {
                operation: "execute",
                sessionId: "session_1",
                turnId: "turn_1",
                invocationId,
                action: action.id,
                params: {},
              },
              signal: new AbortController().signal,
            })
          ).ok,
        ).toBe(true);
      }
      for (const [claim] of claimInvocation.mock.calls) {
        expect(claim).not.toHaveProperty("deduplicationKey");
      }
    },
  );

  it.each([
    ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
    ACTION_HOST_TOOL_CONTRACT_VERSION_V3,
    ACTION_HOST_TOOL_CONTRACT_VERSION_V4,
    CHAT_HOST_TOOL_CONTRACT_VERSION_V3,
    CHAT_HOST_TOOL_CONTRACT_VERSION_V4,
  ])(
    "preserves full listing definitions for persisted %s sessions",
    async (hostToolContractVersion) => {
      const action = createReadAction();
      const gateway = createActionGateway({
        loadContext: vi.fn(async () => ({ ...context, hostToolContractVersion })),
        resolveCatalog: vi.fn(async () => ({
          providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
          actions: [action],
        })),
        recordSourceDiscovery: vi.fn(),
      });
      const response = await gateway({
        request: listRequest("gmail"),
        signal: new AbortController().signal,
      });
      expect(response).toMatchObject({
        ok: true,
        actions: [
          {
            id: action.id,
            description: action.description,
            params: action.params,
            permissionMode: action.permissionMode,
          },
        ],
      });
      expect(
        await gateway({
          request: {
            operation: "describe",
            sessionId: "session",
            turnId: "turn",
            actions: [action.id],
          },
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    },
  );

  it("describes only policy-available definitions and records discovery without approval or execution", async () => {
    const read = createReadAction();
    const write = {
      ...createReadAction("linkedin.search", "linkedin"),
      effects: ACTION_EFFECTS_METERED_READ,
      permissionMode: "ask" as const,
    };
    const recordSourceDiscovery = vi.fn();
    const claimInvocation = vi.fn();
    const executeAction = vi.fn();
    const registerApproval = vi.fn();
    const resolveCatalog = vi.fn(async () => ({
      providers: [
        { id: "gmail" as const, label: "Gmail", description: "Email" },
        {
          id: "linkedin" as const,
          kind: "managed" as const,
          label: "LinkedIn",
          description: "People",
        },
      ],
      actions: [read, write],
    }));
    const gateway = createActionGateway({
      loadContext: vi.fn(async () => ({ ...context, policy: "headless" as const })),
      resolveCatalog,
      recordSourceDiscovery,
      claimInvocation,
      executeAction,
      registerApproval,
    });
    const response = await gateway({
      request: {
        operation: "describe",
        sessionId: "session",
        turnId: "turn",
        actions: [read.id, write.id, "missing", read.id],
      },
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({
      ok: true,
      actions: [{ id: read.id, params: read.params }],
      not_found: [write.id, "missing"],
    });
    expect(recordSourceDiscovery).toHaveBeenCalledTimes(1);
    expect(recordSourceDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "gmail" }),
    );
    expect(resolveCatalog).toHaveBeenCalledTimes(1);
    expect(claimInvocation).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(registerApproval).not.toHaveBeenCalled();
  });

  it("lists the full interactive catalog for external engines", async () => {
    const readAction = createReadAction();
    const catalog: ResolvedActionCatalog = {
      providers: [
        { id: "gmail" as const, label: "Gmail", description: "Email" },
        {
          id: "plugin:slack:slack",
          kind: "integration",
          label: "Slack",
          description: "Messages",
        },
        { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" },
        { id: "posthog", kind: "integration", label: "PostHog", description: "Analytics" },
      ],
      actions: [
        readAction,
        {
          ...readAction,
          id: "gmail.send",
          capability: "write",
          effects: ACTION_EFFECTS_WRITE,
        },
        {
          ...readAction,
          id: "plugin:slack:slack.search",
          provider: "plugin:slack:slack",
          permissionMode: "ask",
        },
        {
          ...readAction,
          id: "linkedin.search",
          provider: "linkedin",
          effects: ACTION_EFFECTS_METERED_READ,
        },
        {
          ...readAction,
          id: "posthog.query",
          provider: "posthog",
          capability: "query",
        },
      ],
    };
    const response = await createActionGateway({
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
    })({
      request: listRequest(),
      signal: new AbortController().signal,
    });

    expect(response).toEqual({
      ok: true,
      sources: [
        { id: "gmail", kind: "integration", label: "Gmail", description: "Email" },
        {
          id: "plugin:slack:slack",
          kind: "integration",
          label: "Slack",
          description: "Messages",
        },
        { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" },
        { id: "posthog", kind: "integration", label: "PostHog", description: "Analytics" },
      ],
    });
  });

  it("returns the full interactive catalog only for a host-authorized opencompany turn", async () => {
    const readAction = createReadAction();
    const writeAction = {
      ...createReadAction("gmail.send"),
      capability: "write" as const,
      effects: ACTION_EFFECTS_WRITE,
      permissionMode: "ask" as const,
    };
    const managedAction = {
      ...createReadAction("linkedin.search", "linkedin"),
      effects: ACTION_EFFECTS_METERED_READ,
    };
    const recordSourceDiscovery = vi.fn();
    const catalog: ResolvedActionCatalog = {
      providers: [
        { id: "gmail", kind: "integration", label: "Gmail", description: "Email" },
        { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" },
      ],
      actions: [readAction, writeAction, managedAction],
    };

    const response = await createActionHostGateway({
      loadContext: vi.fn(async () => interactiveContext),
      resolveCatalog: vi.fn(async () => catalog),
      recordSourceDiscovery,
    })({
      request: { operation: "catalog", sessionId: "session_1", turnId: "turn_1" },
      signal: new AbortController().signal,
    });

    expect(response).toEqual({
      ok: true,
      catalog: {
        sources: [
          { id: "gmail", kind: "integration", label: "Gmail", description: "Email" },
          { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" },
        ],
        actions: [
          expect.objectContaining({ id: "gmail.search", permissionMode: "on" }),
          expect.objectContaining({ id: "gmail.send", permissionMode: "ask" }),
          expect.objectContaining({ id: "linkedin.search", permissionMode: "on" }),
        ],
      },
    });
    expect(recordSourceDiscovery).not.toHaveBeenCalled();
  });

  it("evaluates managed approval with durable turn state for interactive turns", async () => {
    const managedAction = {
      ...createReadAction("linkedin.search", "linkedin"),
      effects: ACTION_EFFECTS_METERED_READ,
    };
    const evaluateApproval = vi.fn(async () => true);
    const recordSourceDiscovery = vi.fn(async () => undefined);
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" }],
      actions: [managedAction],
    };

    const response = await createActionHostGateway({
      loadContext: vi.fn(async () => interactiveContext),
      resolveCatalog: vi.fn(async () => catalog),
      getCapabilityTurnState: () => ({
        quotedTotalUsdMicros: 0,
        admittedToolCallIds: [],
        quotesByToolCallId: new Map(),
        asyncRunsStarted: 0,
      }),
      evaluateApproval,
      recordSourceDiscovery,
    })({
      request: {
        operation: "approval",
        sessionId: "session_1",
        turnId: "turn_1",
        action: managedAction.id,
        params: { query: "founders" },
        invocationId: "call_1",
      },
      signal: new AbortController().signal,
    });

    expect(response).toEqual({ ok: true, needsApproval: true });
    expect(recordSourceDiscovery).toHaveBeenCalledWith({
      run: expect.objectContaining({ policy: "foregroundInteractive", runId: "turn_1" }),
      sourceId: "linkedin",
    });
    expect(evaluateApproval).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ invocationId: "call_1" }) }),
    );
  });

  it("includes ask-mode integration actions in the external-engine catalog", async () => {
    const queryAction = createReadAction("neon.run_sql", "neon");
    queryAction.capability = "query";
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "neon", kind: "integration", label: "Neon", description: "Database" }],
      actions: [queryAction],
    };
    const gateway = createActionGateway({
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
    });

    await expect(
      gateway({
        request: listRequest(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: true,
      sources: [{ id: "neon", kind: "integration", label: "Neon", description: "Database" }],
    });

    queryAction.permissionMode = "ask";
    await expect(
      gateway({
        request: listRequest(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: true,
      sources: [{ id: "neon", kind: "integration", label: "Neon", description: "Database" }],
    });
  });

  it.each([false, true])(
    "persists ask approval and dispatches only after approval (durable task: %s)",
    async (durableTaskApprovals) => {
      const action = createReadAction("gmail.send");
      action.capability = "write";
      action.effects = ACTION_EFFECTS_WRITE;
      action.permissionMode = "ask";
      const catalog: ResolvedActionCatalog = {
        providers: [{ id: "gmail", kind: "integration", label: "Gmail", description: "Email" }],
        actions: [action],
      };
      const registerApproval = vi
        .fn()
        .mockResolvedValueOnce({
          actionId: action.id,
          sourceId: action.provider,
          capabilityId: action.capability,
          inputHash: "input_hash",
          status: "pending" as const,
        })
        .mockResolvedValueOnce({
          actionId: action.id,
          sourceId: action.provider,
          capabilityId: action.capability,
          inputHash: "input_hash",
          status: "approved" as const,
        });
      const request = {
        operation: "execute" as const,
        sessionId: "session_approval",
        turnId: "turn_approval",
        action: action.id,
        params: { to: "customer@example.com" },
        invocationId: "call_approval",
      };
      const dependencies = {
        loadContext: vi.fn(async () => ({
          ...interactiveContext,
          policy: durableTaskApprovals ? ("headless" as const) : ("foregroundInteractive" as const),
          durableTaskApprovals,
        })),
        resolveCatalog: vi.fn(async () => catalog),
        registerApproval,
        claimInvocation: admittedInvocation,
      };
      const gateway = createActionGateway(dependencies);

      await expect(
        gateway({ request, signal: new AbortController().signal }),
      ).resolves.toMatchObject({ ok: false, error: { code: "approval_required" } });
      expect(action.execute).not.toHaveBeenCalled();

      await expect(
        gateway({ request, signal: new AbortController().signal }),
      ).resolves.toMatchObject({ ok: true, action: action.id });
      expect(action.execute).toHaveBeenCalledOnce();
      expect(registerApproval).toHaveBeenCalledTimes(2);
    },
  );

  it("binds custom MCP approvals to the current connection revision", async () => {
    const action = {
      ...createReadAction("plugin:custom-test:mcp.send"),
      provider: "plugin:custom-test:mcp" as const,
      permissionMode: "ask" as const,
      approvalContext: "revision-1",
    };
    const registerApproval = vi.fn(async ({ approvalContext }: { approvalContext?: string }) =>
      approvalContext === "revision-1"
        ? {
            actionId: action.id,
            sourceId: action.provider,
            capabilityId: action.capability,
            inputHash: "hash",
            status: "pending" as const,
          }
        : null,
    );
    const gateway = createActionGateway({
      loadContext: vi.fn(async () => interactiveContext),
      resolveCatalog: vi.fn(async () => ({
        providers: [{ id: action.provider, label: "Custom", description: "Custom tools" }],
        actions: [action],
      })),
      registerApproval,
      claimInvocation: admittedInvocation,
    });
    const request = {
      operation: "execute" as const,
      sessionId: "session",
      turnId: "turn",
      action: action.id,
      params: {},
      invocationId: "invocation",
    };
    await expect(gateway({ request, signal: new AbortController().signal })).resolves.toMatchObject(
      { ok: false, error: { code: "approval_required" } },
    );
    expect(registerApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalContext: "revision-1" }),
    );
    action.approvalContext = "revision-2";
    await expect(gateway({ request, signal: new AbortController().signal })).resolves.toMatchObject(
      { ok: false, error: { code: "invalid_params" } },
    );
    expect(action.execute).not.toHaveBeenCalled();
  });

  it("does not ask again when an invocation is already approved", async () => {
    const action = createReadAction("gmail.send");
    action.capability = "write";
    action.effects = ACTION_EFFECTS_WRITE;
    action.permissionMode = "ask";

    await expect(
      createActionHostGateway({
        loadContext: vi.fn(async () => interactiveContext),
        resolveCatalog: vi.fn(async () => ({
          providers: [
            {
              id: "gmail" as const,
              kind: "integration" as const,
              label: "Gmail",
              description: "Email",
            },
          ],
          actions: [action],
        })),
        registerApproval: vi.fn(async () => ({
          actionId: action.id,
          sourceId: action.provider,
          capabilityId: action.capability,
          inputHash: "input_hash",
          status: "approved" as const,
        })),
      })({
        request: {
          operation: "approval",
          sessionId: "session_approval",
          turnId: "turn_approval",
          action: action.id,
          params: { to: "customer@example.com" },
          invocationId: "call_approval",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ ok: true, needsApproval: false });
  });

  it("auto-denies ask actions through the headless gateway and records the decision", async () => {
    const action = createReadAction("gmail.send");
    action.capability = "write";
    action.effects = ACTION_EFFECTS_WRITE;
    action.permissionMode = "ask";
    const registerApproval = vi.fn(async () => ({
      actionId: action.id,
      sourceId: action.provider,
      capabilityId: action.capability,
      inputHash: "input_hash",
      status: "denied" as const,
    }));
    const dependencies = {
      resolveCatalog: vi.fn(async () => ({
        providers: [
          {
            id: "gmail" as const,
            kind: "integration" as const,
            label: "Gmail",
            description: "Email",
          },
        ],
        actions: [action],
      })),
      registerApproval,
    };
    const principal = { ...context, policy: "headless" as const };
    const gateway = createActionPrincipalGateway(dependencies);
    const request = {
      sessionId: "task_session",
      turnId: "task_turn",
      action: action.id,
      params: { to: "customer@example.com" },
      invocationId: "task_call",
    };

    await expect(
      gateway({
        request: { ...request, operation: "approval" },
        principal,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ ok: true, needsApproval: false });
    await expect(
      gateway({
        request: { ...request, operation: "execute" },
        principal,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_permitted" } });
    expect(registerApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        run: {
          sessionId: "task_session",
          runId: "task_turn",
          actorId: "user_1",
          workspaceId: "workspace_1",
          policy: "headless",
        },
        actionId: "gmail.send",
        sourceId: "gmail",
        capabilityId: "write",
        decision: "denied",
      }),
    );
    expect(action.execute).not.toHaveBeenCalled();
  });

  it("reuses the canonical executor with host-derived identity", async () => {
    const readAction = createReadAction();
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "gmail", kind: "integration", label: "Gmail", description: "Email" }],
      actions: [readAction],
    };
    const response = await createActionGateway({
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
      claimInvocation: admittedInvocation,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    })({
      request: {
        operation: "execute",
        sessionId: "codex_session_1",
        turnId: "codex_turn_1",
        action: "gmail.search",
        params: { query: "from:ada" },
        invocationId: "call_1",
      },
      signal: new AbortController().signal,
    });

    expect(response).toEqual({
      ok: true,
      action: "gmail.search",
      result: { messages: [] },
    });
    expect(readAction.execute).toHaveBeenCalledWith(
      { query: "from:ada" },
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
        toolCallId: "call_1",
        userTimezone: "Europe/Paris",
      }),
    );
  });

  it("shares managed capability turn state across calls in the same turn", async () => {
    const managedAction = createReadAction("linkedin.search_posts", "linkedin");
    managedAction.effects = ACTION_EFFECTS_METERED_READ;
    managedAction.execute = vi.fn(async (_params, actionContext) => {
      const turnState = actionContext.capabilityTurnState;
      if (!turnState) throw new Error("Missing capability turn state");
      turnState.quotedTotalUsdMicros += 10;
      return { quotedTotalUsdMicros: turnState.quotedTotalUsdMicros };
    });
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" }],
      actions: [managedAction],
    };
    const request = {
      operation: "execute" as const,
      sessionId: "codex_session_state",
      turnId: "codex_turn_state",
      action: "linkedin.search_posts",
      params: { query: "founders" },
      invocationId: "call_1",
    };
    const capabilityTurnState = {
      quotedTotalUsdMicros: 0,
      admittedToolCallIds: [],
      quotesByToolCallId: new Map(),
      asyncRunsStarted: 0,
    };
    const dependencies = {
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
      claimInvocation: admittedInvocation,
      getCapabilityTurnState: () => capabilityTurnState,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    };
    const gateway = createActionGateway(dependencies);

    const first = await gateway({
      request,
      signal: new AbortController().signal,
    });
    const second = await gateway({
      request: { ...request, invocationId: "call_2" },
      signal: new AbortController().signal,
    });

    expect(first).toEqual({
      ok: true,
      action: "linkedin.search_posts",
      result: { quotedTotalUsdMicros: 10 },
    });
    expect(second).toEqual({
      ok: true,
      action: "linkedin.search_posts",
      result: { quotedTotalUsdMicros: 20 },
    });
  });

  it("rejects call 17 through the shared gateway budget", async () => {
    const readAction = createReadAction();
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
      actions: [readAction],
    };
    let count = 0;
    const claimInvocation = vi.fn(async () => {
      if (count >= ACTION_MAX_CALLS_PER_TURN) {
        return { ok: false as const, reason: "call_budget" as const };
      }
      count += 1;
      return { ok: true as const, callCount: count, duplicate: false };
    });
    const dependencies = {
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
      claimInvocation,
    };
    const gateway = createActionGateway(dependencies);

    for (let call = 1; call <= ACTION_MAX_CALLS_PER_TURN; call += 1) {
      await expect(
        gateway({
          request: {
            operation: "execute",
            sessionId: "session_budget",
            turnId: "turn_budget",
            action: readAction.id,
            params: {},
            invocationId: `call_${call}`,
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    await expect(
      gateway({
        request: {
          operation: "execute",
          sessionId: "session_budget",
          turnId: "turn_budget",
          action: readAction.id,
          params: {},
          invocationId: "call_17",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "call_budget" } });
  });

  it("does not redispatch an admitted invocation after a transport retry", async () => {
    const action = createReadAction();
    const response = await createActionGateway({
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => ({
        providers: [
          {
            id: "gmail" as const,
            label: "Gmail",
            description: "Email",
          },
        ],
        actions: [action],
      })),
      claimInvocation: vi.fn(async () => ({
        ok: true as const,
        callCount: 1,
        duplicate: true,
      })),
    })({
      request: {
        operation: "execute",
        sessionId: "session_retry",
        turnId: "turn_retry",
        action: action.id,
        params: {},
        invocationId: "stable_call_1",
      },
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({ ok: false, error: { code: "duplicate_invocation" } });
    expect(action.execute).not.toHaveBeenCalled();
  });

  it("returns a structured internal error when durable governance is unavailable", async () => {
    const action = createReadAction();
    const response = await createActionGateway({
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => ({
        providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
        actions: [action],
      })),
      recordSourceDiscovery: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    })({
      request: listRequest("gmail"),
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("fails closed when the turn no longer authorizes access", async () => {
    const resolveCatalog = vi.fn();
    const response = await createActionGateway({
      loadContext: vi.fn(async () => null),
      resolveCatalog,
    })({
      request: listRequest(),
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "not_permitted" },
    });
    expect(resolveCatalog).not.toHaveBeenCalled();
  });
});

function createReadAction(
  id = "gmail.search",
  provider: ResolvedAction["provider"] = "gmail",
): ResolvedAction {
  return {
    id,
    provider,
    capability: "read",
    effects: ACTION_EFFECTS_READ,
    description: "Search Gmail.",
    params: { type: "object" },
    permissionMode: "on",
    execute: vi.fn(async () => ({ messages: [] })),
  };
}

const admittedInvocation = vi.fn(async () => ({
  ok: true as const,
  callCount: 1,
  duplicate: false,
}));
