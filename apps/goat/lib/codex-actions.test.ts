import type { GoatCodexActionGatewayRequest } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatResolvedActionCatalog, ResolvedGoatAction } from "@/lib/actions/types";
import { executeGoatCodexActionGateway } from "@/lib/codex-actions";

function listRequest(source?: string): GoatCodexActionGatewayRequest {
  return {
    operation: "list",
    codexChatSessionId: "codex_session_1",
    codexChatTurnId: "codex_turn_1",
    ...(source ? { source } : {}),
  };
}

const context = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  chatSessionId: "chat_1",
  userTimezone: "Europe/Paris",
};

describe("executeGoatCodexActionGateway", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists connected integration reads and enabled managed capability reads", async () => {
    const readAction = createReadAction();
    const catalog: GoatResolvedActionCatalog = {
      providers: [
        { id: "gmail", label: "Gmail", description: "Email" },
        { id: "slack", kind: "integration", label: "Slack", description: "Messages" },
        { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" },
      ],
      actions: [
        readAction,
        {
          ...readAction,
          id: "gmail.send",
          capability: "write",
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
        },
      ],
    };
    const response = await executeGoatCodexActionGateway({
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
      ],
    });
  });

  it("reuses the canonical executor with host-derived identity", async () => {
    const readAction = createReadAction();
    const catalog: GoatResolvedActionCatalog = {
      providers: [{ id: "gmail", kind: "integration", label: "Gmail", description: "Email" }],
      actions: [readAction],
    };
    const response = await executeGoatCodexActionGateway({
      request: {
        operation: "execute",
        codexChatSessionId: "codex_session_1",
        codexChatTurnId: "codex_turn_1",
        action: "gmail.search",
        params: { query: "from:ada" },
        toolCallId: "call_1",
      },
      signal: new AbortController().signal,
      dependencies: {
        loadContext: vi.fn(async () => context),
        resolveCatalog: vi.fn(async () => catalog),
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

  it("shares managed capability turn state across calls in the same Codex turn", async () => {
    const managedAction = createReadAction("linkedin.search_posts", "linkedin");
    managedAction.execute = vi.fn(async (_params, actionContext) => {
      const turnState = actionContext.capabilityTurnState;
      if (!turnState) throw new Error("Missing capability turn state");
      turnState.quotedTotalUsdMicros += 10;
      return { quotedTotalUsdMicros: turnState.quotedTotalUsdMicros };
    });
    const catalog: GoatResolvedActionCatalog = {
      providers: [{ id: "linkedin", kind: "managed", label: "LinkedIn", description: "Paid" }],
      actions: [managedAction],
    };
    const request = {
      operation: "execute" as const,
      codexChatSessionId: "codex_session_state",
      codexChatTurnId: "codex_turn_state",
      action: "linkedin.search_posts",
      params: { query: "founders" },
      toolCallId: "call_1",
    };
    const dependencies = {
      loadContext: vi.fn(async () => context),
      resolveCatalog: vi.fn(async () => catalog),
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    };

    const first = await executeGoatCodexActionGateway({
      request,
      signal: new AbortController().signal,
      dependencies,
    });
    const second = await executeGoatCodexActionGateway({
      request: { ...request, toolCallId: "call_2" },
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

  it("fails closed when the turn no longer authorizes access", async () => {
    const resolveCatalog = vi.fn();
    const response = await executeGoatCodexActionGateway({
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
  provider: ResolvedGoatAction["provider"] = "gmail",
): ResolvedGoatAction {
  return {
    id,
    provider,
    capability: "read",
    description: "Search Gmail.",
    params: { type: "object" },
    permissionMode: "on",
    execute: vi.fn(async () => ({ messages: [] })),
  };
}
