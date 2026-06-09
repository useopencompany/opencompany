import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type AgentSessionDetailPayload,
  parseAgentSessionDetailResponse,
  parseSidebarSessionPayload,
  parseSidebarSessionsResponse,
  seedSessionQueries,
  serializeAgentSessionDetail,
  sessionQueryKeys,
} from "@/lib/agent-sessions/payload";

describe("session payload cache helpers", () => {
  it("seeds the detail cache for a session", () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const sessionDetail = detail();

    seedSessionQueries(queryClient, workspaceId, sessionDetail);

    expect(
      queryClient.getQueryData(sessionQueryKeys.detail(workspaceId, sessionDetail.session.id)),
    ).toEqual(sessionDetail);
  });

  it("normalizes failed session payloads with stale running assistant messages", () => {
    const sessionDetail = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
          completedAt: null,
        },
      ],
    });
    sessionDetail.session = {
      ...sessionDetail.session,
      status: "failed",
      lastError: "Gateway down",
      updatedAt: "2026-05-24T10:02:00.000Z",
    };

    const parsed = parseAgentSessionDetailResponse({ detail: sessionDetail });

    expect(parsed.detail.messages[0]).toMatchObject({
      status: "failed",
      completedAt: "2026-05-24T10:02:00.000Z",
    });
  });

  it("parses session API payloads at the fetch boundary", () => {
    const sessionDetail = detail({
      events: [
        {
          id: 1,
          type: "session.status",
          messageId: null,
          payload: { status: "running" },
          createdAt: "2026-05-24T10:00:01.000Z",
        },
      ],
      messages: [{ id: "msg_1", role: "user", content: "Ship it", status: "completed" }],
    });

    expect(parseAgentSessionDetailResponse({ detail: sessionDetail })).toEqual({
      detail: sessionDetail,
    });
    expect(parseSidebarSessionsResponse({ sessions: [sidebarSession("ses_1", "One")] })).toEqual({
      sessions: [sidebarSession("ses_1", "One")],
    });
  });

  it("serializes runtime event timestamps in session details", () => {
    const base = detail();
    const serialized = serializeAgentSessionDetail({
      usage: base.usage,
      toolUsage: base.toolUsage,
      cost: base.cost,
      currentContextTokens: base.currentContextTokens,
      related: { parent: null, children: [] },
      session: {
        ...base.session,
        abortRequestedAt: null,
        createdAt: new Date("2026-05-24T10:00:00.000Z"),
        updatedAt: new Date("2026-05-24T10:00:02.000Z"),
      },
      messages: [],
      events: [
        {
          id: 1,
          type: "message.reasoning_delta",
          messageId: "msg_1",
          payload: { messageId: "msg_1", delta: "Thinking" },
          createdAt: new Date("2026-05-24T10:00:01.000Z"),
        },
      ],
    });

    expect(serialized.events[0]).toMatchObject({
      id: 1,
      createdAt: "2026-05-24T10:00:01.000Z",
    });
  });

  it("round-trips currentContextTokens through serialize and parse", () => {
    const base = detail();
    const serialized = serializeAgentSessionDetail({
      usage: base.usage,
      toolUsage: base.toolUsage,
      cost: base.cost,
      currentContextTokens: 14_200,
      related: { parent: null, children: [] },
      session: {
        ...base.session,
        abortRequestedAt: null,
        createdAt: new Date("2026-05-24T10:00:00.000Z"),
        updatedAt: new Date("2026-05-24T10:00:02.000Z"),
      },
      messages: [],
      events: [],
    });

    expect(serialized.currentContextTokens).toBe(14_200);
    expect(
      parseAgentSessionDetailResponse({ detail: serialized }).detail.currentContextTokens,
    ).toBe(14_200);
  });

  it("defaults currentContextTokens to 0 for payloads cached before the field shipped", () => {
    const { currentContextTokens: _omitted, ...legacy } = detail();

    expect(parseAgentSessionDetailResponse({ detail: legacy }).detail.currentContextTokens).toBe(0);
  });

  it("rejects invalid session detail payloads", () => {
    expect(() => parseAgentSessionDetailResponse({ detail: { session: null } })).toThrow(
      "Invalid session.",
    );
  });

  it("rejects sidebar sessions with blank display fields", () => {
    expect(() =>
      parseSidebarSessionPayload({
        ...sidebarSession("ses_1", " "),
      }),
    ).toThrow("Invalid title.");
    expect(() =>
      parseSidebarSessionPayload({
        ...sidebarSession("ses_1", "One"),
        status: "",
      }),
    ).toThrow("Invalid status.");
    expect(() =>
      parseSidebarSessionPayload({
        ...sidebarSession("ses_1", "One"),
        modelName: "",
      }),
    ).toThrow("Invalid modelName.");
  });

  it("parses related parent and child sessions", () => {
    const parsed = parseAgentSessionDetailResponse({
      detail: {
        ...detail(),
        related: {
          parent: {
            id: "ses_parent",
            title: "Parent",
            status: "completed",
            agentName: "Leo",
            agentPath: "agents/leo/leo.agent",
            parentMessageId: null,
            parentToolCallId: null,
            createdAt: "2026-05-24T09:00:00.000Z",
            updatedAt: "2026-05-24T09:30:00.000Z",
          },
          children: [
            {
              id: "ses_child",
              title: "Child",
              status: "running",
              agentName: "Research",
              agentPath: "agents/research/research.agent",
              parentMessageId: "msg_parent",
              parentToolCallId: "call_delegate",
              createdAt: "2026-05-24T10:00:00.000Z",
              updatedAt: "2026-05-24T10:01:00.000Z",
            },
          ],
        },
      },
    });

    expect(parsed.detail.related.parent?.id).toBe("ses_parent");
    expect(parsed.detail.related.children[0]?.parentToolCallId).toBe("call_delegate");
  });

  it("round-trips the latest model-request debug snapshot", () => {
    const sessionDetail: AgentSessionDetailPayload = {
      ...detail(),
      latestModelRequest: {
        systemPrompt: "You are Leo.",
        toolsSentToModel: [{ name: "read_file", description: "Read a file", parameters: {} }],
        deferredToolsNotSent: [{ name: "exa_search", description: "Web search" }],
      },
    };

    const parsed = parseAgentSessionDetailResponse({ detail: sessionDetail });

    expect(parsed.detail.latestModelRequest).toEqual(sessionDetail.latestModelRequest);
  });

  it("drops a non-object model-request snapshot and omits the key when absent", () => {
    expect(parseAgentSessionDetailResponse({ detail: detail() }).detail).not.toHaveProperty(
      "latestModelRequest",
    );
    expect(
      parseAgentSessionDetailResponse({
        detail: { ...detail(), latestModelRequest: "nope" },
      }).detail,
    ).not.toHaveProperty("latestModelRequest");
  });

  it("rejects malformed related sessions", () => {
    expect(() =>
      parseAgentSessionDetailResponse({
        detail: {
          ...detail(),
          related: {
            parent: null,
            children: [{ id: "ses_child", title: "Child" }],
          },
        },
      }),
    ).toThrow("Invalid status.");
  });
});

function sidebarSession(id: string, title: string) {
  return {
    id,
    title,
    status: "completed",
    modelName: "model",
    lastError: null,
    createdAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:00:00.000Z",
    starredAt: null,
    unseen: false,
  };
}

function detail(
  overrides: Partial<Pick<AgentSessionDetailPayload, "events" | "messages">> = {},
): AgentSessionDetailPayload {
  return {
    session: {
      id: "ses_123",
      agentId: "agt_123",
      agentName: "Leo",
      agentPath: "agents/leo/leo.agent",
      title: "Original",
      status: "created",
      source: "user",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      parentSessionId: null,
      parentMessageId: null,
      parentToolCallId: null,
      e2bSandboxId: null,
      workdir: "/workspace",
      runLeaseId: null,
      abortRequestedAt: null,
      lastError: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
    },
    related: { parent: null, children: [] },
    messages: overrides.messages ?? [],
    events: overrides.events ?? [],
    usage: {
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
      totalTokens: 0,
    },
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: {
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
      sandboxCostUsdMicros: 0,
    },
    currentContextTokens: 0,
  };
}
