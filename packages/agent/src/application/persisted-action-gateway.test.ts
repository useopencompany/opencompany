import { ACTION_MAX_CALLS_PER_TURN, type ActionGatewayRequest } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_EFFECTS_METERED_READ,
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  type ResolvedAction,
  type ResolvedActionCatalog,
} from "../actions/types";
import { executeActionGateway, executeActionHostGateway } from "./persisted-action-gateway";

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
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists connected integration reads and enabled managed capability reads", async () => {
    const readAction = createReadAction();
    const catalog: ResolvedActionCatalog = {
      providers: [
        { id: "gmail", label: "Gmail", description: "Email" },
        { id: "slack", kind: "integration", label: "Slack", description: "Messages" },
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
          id: "slack.search",
          provider: "slack",
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
    const response = await executeActionGateway({
      request: listRequest(),
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => context),
        resolveCatalog: vi.fn(async () => catalog),
      },
    });

    expect(response).toEqual({
      ok: true,
      sources: [
        { id: "gmail", kind: "integration", label: "Gmail", description: "Email" },
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

    const response = await executeActionHostGateway({
      request: { operation: "catalog", sessionId: "session_1", turnId: "turn_1" },
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => interactiveContext),
        resolveCatalog: vi.fn(async () => catalog),
        recordSourceDiscovery,
      },
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

    const response = await executeActionHostGateway({
      request: {
        operation: "approval",
        sessionId: "session_1",
        turnId: "turn_1",
        action: managedAction.id,
        params: { query: "founders" },
        invocationId: "call_1",
      },
      signal: new AbortController().signal,
      dependencies: {
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
      },
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

  it("includes Neon row queries only after their read-only permission is On", async () => {
    const queryAction = createReadAction("neon.run_sql", "neon");
    queryAction.capability = "query";
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "neon", kind: "integration", label: "Neon", description: "Database" }],
      actions: [queryAction],
    };

    await expect(
      executeActionGateway({
        request: listRequest(),
        signal: new AbortController().signal,
        dependencies: {
          loadContext: vi.fn(async () => context),
          resolveCatalog: vi.fn(async () => catalog),
        },
      }),
    ).resolves.toEqual({
      ok: true,
      sources: [{ id: "neon", kind: "integration", label: "Neon", description: "Database" }],
    });

    queryAction.permissionMode = "ask";
    await expect(
      executeActionGateway({
        request: listRequest(),
        signal: new AbortController().signal,
        dependencies: {
          loadContext: vi.fn(async () => context),
          resolveCatalog: vi.fn(async () => catalog),
        },
      }),
    ).resolves.toEqual({ ok: true, sources: [] });
  });

  it("reuses the canonical executor with host-derived identity", async () => {
    const readAction = createReadAction();
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "gmail", kind: "integration", label: "Gmail", description: "Email" }],
      actions: [readAction],
    };
    const response = await executeActionGateway({
      request: {
        operation: "execute",
        sessionId: "codex_session_1",
        turnId: "codex_turn_1",
        action: "gmail.search",
        params: { query: "from:ada" },
        invocationId: "call_1",
      },
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => context),
        resolveCatalog: vi.fn(async () => catalog),
        claimInvocation: admittedInvocation,
        now: () => new Date("2026-07-28T12:00:00.000Z"),
      },
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

    const first = await executeActionGateway({
      request,
      signal: new AbortController().signal,
      dependencies,
    });
    const second = await executeActionGateway({
      request: { ...request, invocationId: "call_2" },
      signal: new AbortController().signal,
      dependencies,
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
      providers: [{ id: "gmail", label: "Gmail", description: "Email" }],
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

    for (let call = 1; call <= ACTION_MAX_CALLS_PER_TURN; call += 1) {
      await expect(
        executeActionGateway({
          request: {
            operation: "execute",
            sessionId: "session_budget",
            turnId: "turn_budget",
            action: readAction.id,
            params: {},
            invocationId: `call_${call}`,
          },
          signal: new AbortController().signal,
          dependencies,
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    await expect(
      executeActionGateway({
        request: {
          operation: "execute",
          sessionId: "session_budget",
          turnId: "turn_budget",
          action: readAction.id,
          params: {},
          invocationId: "call_17",
        },
        signal: new AbortController().signal,
        dependencies,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "call_budget" } });
  });

  it("does not redispatch an admitted invocation after a transport retry", async () => {
    const action = createReadAction();
    const response = await executeActionGateway({
      request: {
        operation: "execute",
        sessionId: "session_retry",
        turnId: "turn_retry",
        action: action.id,
        params: {},
        invocationId: "stable_call_1",
      },
      signal: new AbortController().signal,
      dependencies: {
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
      },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "duplicate_invocation" } });
    expect(action.execute).not.toHaveBeenCalled();
  });

  it("returns a structured internal error when durable governance is unavailable", async () => {
    const action = createReadAction();
    const response = await executeActionGateway({
      request: listRequest("gmail"),
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => context),
        resolveCatalog: vi.fn(async () => ({
          providers: [{ id: "gmail" as const, label: "Gmail", description: "Email" }],
          actions: [action],
        })),
        recordSourceDiscovery: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("fails closed when the turn no longer authorizes access", async () => {
    const resolveCatalog = vi.fn();
    const response = await executeActionGateway({
      request: listRequest(),
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => null),
        resolveCatalog,
      },
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
