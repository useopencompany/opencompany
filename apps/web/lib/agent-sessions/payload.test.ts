import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type AgentSessionDetailPayload,
  applyRuntimeEventToSessionDetail,
  invalidateRelatedCachesForSessionEvent,
  mergeAgentSessionDetail,
  removeSidebarSession,
  type SidebarSessionPayload,
  seedSessionQueries,
  sessionQueryKeys,
  upsertSidebarSession,
} from "@/lib/agent-sessions/payload";
import { agentQueryKeys } from "@/lib/agents/payload";

describe("session payload cache helpers", () => {
  it("prepends and sorts sidebar sessions by update time", () => {
    expect(
      upsertSidebarSession(
        [
          {
            id: "ses_old",
            title: "Old",
            status: "completed",
            modelName: "model",
            lastError: null,
            createdAt: "2026-05-24T09:00:00.000Z",
            updatedAt: "2026-05-24T09:00:00.000Z",
          },
        ],
        {
          id: "ses_new",
          title: "New",
          status: "running",
          modelName: "model",
          lastError: null,
          createdAt: "2026-05-24T10:00:00.000Z",
          updatedAt: "2026-05-24T10:00:00.000Z",
        },
      ).map((session) => session.id),
    ).toEqual(["ses_new", "ses_old"]);
  });

  it("removes archived sessions from sidebar history", () => {
    expect(
      removeSidebarSession(
        [sidebarSession("ses_keep", "Keep"), sidebarSession("ses_archive", "Archive")],
        "ses_archive",
      ),
    ).toEqual([sidebarSession("ses_keep", "Keep")]);
  });

  it("merges refetched detail without discarding streamed events or content", () => {
    const current = detail({
      events: [
        {
          id: 1,
          type: "message.created",
          messageId: "msg_1",
          payload: { messageId: "msg_1", role: "assistant" },
        },
        {
          id: 2,
          type: "message.delta",
          messageId: "msg_1",
          payload: { messageId: "msg_1", delta: " world" },
        },
      ],
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "hello world",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
        },
      ],
    });
    const incoming = detail({
      events: [
        {
          id: 1,
          type: "message.created",
          messageId: "msg_1",
          payload: { messageId: "msg_1", role: "assistant" },
        },
      ],
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "hello",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
        },
      ],
    });

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.events.map((event) => event.id)).toEqual([1, 2]);
    expect(merged.messages[0]?.content).toBe("hello world");
  });

  it("merges refetched detail without discarding streamed usage and costs", () => {
    const current = applyRuntimeEventToSessionDetail(
      detail(),
      {
        id: 1,
        type: "session.usage",
        messageId: "msg_1",
        payload: {
          messageId: "msg_1",
          inputTokens: 10,
          inputNoCacheTokens: 8,
          inputCacheReadTokens: 1,
          inputCacheWriteTokens: 1,
          outputTokens: 6,
          outputTextTokens: 5,
          outputReasoningTokens: 1,
          totalTokens: 16,
          providerCostUsdMicros: 40,
          platformFeeUsdMicros: 10,
          chargedCostUsdMicros: 50,
        },
      },
      "2026-05-24T10:02:00.000Z",
    );
    const incoming = detail();

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.events.map((event) => event.id)).toEqual([1]);
    expect(merged.usage.totalTokens).toBe(16);
    expect(merged.usage.outputReasoningTokens).toBe(1);
    expect(merged.cost.providerCostUsdMicros).toBe(40);
    expect(merged.cost.platformFeeUsdMicros).toBe(10);
    expect(merged.cost.totalCostUsdMicros).toBe(50);
    expect(merged.cost.modelCostUsdMicros).toBe(50);
  });

  it("merges refetched detail without discarding streamed tool usage", () => {
    const current = applyRuntimeEventToSessionDetail(
      detail(),
      {
        id: 1,
        type: "session.tool_usage",
        messageId: "msg_1",
        payload: {
          provider: "e2b",
          operation: "sandbox",
          costUsdMicros: 25,
          platformFeeUsdMicros: 5,
          chargedCostUsdMicros: 30,
        },
      },
      "2026-05-24T10:02:00.000Z",
    );
    const incoming = detail();

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.toolUsage.totalCostUsdMicros).toBe(25);
    expect(merged.toolUsage.byProviderOperation).toEqual([
      { provider: "e2b", operation: "sandbox", costUsdMicros: 25, calls: 1 },
    ]);
    expect(merged.cost.providerCostUsdMicros).toBe(25);
    expect(merged.cost.platformFeeUsdMicros).toBe(5);
    expect(merged.cost.totalCostUsdMicros).toBe(30);
    expect(merged.cost.toolCostUsdMicros).toBe(30);
  });

  it("does not replay events the server already aggregated when the events list is capped", () => {
    // Simulate: server has events 1..3 (cap reached at 3) with usage from all three already
    // reflected in incoming.usage. Client local has those plus a stale earlier copy of event 2
    // that pre-dates incoming. The naive set-difference replay would double-count event 2.
    const incoming = detail();
    incoming.events = [
      { id: 1, type: "session.status", messageId: null, payload: { status: "ready" } },
      { id: 3, type: "session.status", messageId: null, payload: { status: "running" } },
    ];
    incoming.usage = {
      inputTokens: 100,
      inputNoCacheTokens: 100,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 50,
      outputTextTokens: 50,
      outputReasoningTokens: 0,
      totalTokens: 150,
    };

    const current = detail();
    current.events = [
      { id: 1, type: "session.status", messageId: null, payload: { status: "ready" } },
      {
        id: 2,
        type: "session.usage",
        messageId: "msg_1",
        payload: {
          inputTokens: 100,
          inputNoCacheTokens: 100,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 50,
          outputTextTokens: 50,
          outputReasoningTokens: 0,
          totalTokens: 150,
        },
      },
      { id: 3, type: "session.status", messageId: null, payload: { status: "running" } },
    ];

    const merged = mergeAgentSessionDetail(current, incoming);

    // Without the guard, event 2's usage would be replayed on top of incoming.usage (already 150),
    // producing 300. With the guard, only events with id > 3 are replayed → no double-count.
    expect(merged.usage.totalTokens).toBe(150);
  });

  it("still replays truly newer local events past the highest incoming id", () => {
    const incoming = detail();
    incoming.events = [
      { id: 1, type: "session.status", messageId: null, payload: { status: "ready" } },
    ];

    const current = detail();
    current.events = [
      { id: 1, type: "session.status", messageId: null, payload: { status: "ready" } },
      {
        id: 2,
        type: "session.usage",
        messageId: "msg_1",
        payload: {
          inputTokens: 10,
          inputNoCacheTokens: 10,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 5,
          outputTextTokens: 5,
          outputReasoningTokens: 0,
          totalTokens: 15,
        },
      },
    ];

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.events.map((event) => event.id)).toEqual([1, 2]);
    expect(merged.usage.totalTokens).toBe(15);
  });

  it("keeps live session state without discarding authoritative server fields", () => {
    const current = detail();
    const incoming = detail();
    current.session = {
      ...current.session,
      status: "running",
      title: "Live title",
      e2bSandboxId: null,
      runLeaseId: null,
      updatedAt: "2026-05-24T10:02:00.000Z",
    };
    incoming.session = {
      ...incoming.session,
      status: "ready",
      title: "Original",
      e2bSandboxId: "sbx_123",
      runLeaseId: "run_123",
      updatedAt: "2026-05-24T10:01:00.000Z",
    };

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.session.status).toBe("running");
    expect(merged.session.title).toBe("Live title");
    expect(merged.session.e2bSandboxId).toBe("sbx_123");
    expect(merged.session.runLeaseId).toBe("run_123");
    expect(merged.session.updatedAt).toBe("2026-05-24T10:02:00.000Z");
  });

  it("treats completed-message reasoning tokens from the server as authoritative", () => {
    const current = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "answer",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
          outputReasoningTokens: 42,
        },
      ],
    });
    const incoming = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "answer",
          status: "completed",
          createdAt: "2026-05-24T10:00:00.000Z",
          completedAt: "2026-05-24T10:00:30.000Z",
          outputReasoningTokens: 12,
        },
      ],
    });

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.messages[0]?.status).toBe("completed");
    expect(merged.messages[0]?.outputReasoningTokens).toBe(12);
  });

  it("preserves the streamed reasoning-token max while the assistant message is still running", () => {
    const current = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "answer",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
          outputReasoningTokens: 42,
        },
      ],
    });
    const incoming = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "answer",
          status: "running",
          createdAt: "2026-05-24T10:00:00.000Z",
          outputReasoningTokens: 8,
        },
      ],
    });

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.messages[0]?.outputReasoningTokens).toBe(42);
  });

  it("does not churn the sidebar cache on content-only runtime events", () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const initialDetail = detail();
    const sidebarSeed: SidebarSessionPayload[] = [
      {
        id: initialDetail.session.id,
        title: initialDetail.session.title,
        status: initialDetail.session.status,
        modelName: initialDetail.session.modelName,
        lastError: initialDetail.session.lastError,
        createdAt: initialDetail.session.createdAt,
        updatedAt: initialDetail.session.updatedAt,
      },
    ];
    queryClient.setQueryData(sessionQueryKeys.list(workspaceId), sidebarSeed);

    seedSessionQueries(queryClient, workspaceId, initialDetail);
    const sidebarAfterSeed = queryClient.getQueryData(sessionQueryKeys.list(workspaceId));

    const next = applyRuntimeEventToSessionDetail(initialDetail, {
      id: 1,
      type: "message.delta",
      messageId: "msg_1",
      payload: { messageId: "msg_1", delta: "hello" },
    });
    seedSessionQueries(queryClient, workspaceId, next);

    expect(queryClient.getQueryData(sessionQueryKeys.list(workspaceId))).toBe(sidebarAfterSeed);
    expect(
      queryClient.getQueryData(sessionQueryKeys.detail(workspaceId, next.session.id)),
    ).toStrictEqual(next);
  });

  it("refreshes the sidebar cache when session-level fields change", () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const initialDetail = detail();
    seedSessionQueries(queryClient, workspaceId, initialDetail);
    const sidebarAfterSeed = queryClient.getQueryData(sessionQueryKeys.list(workspaceId));

    const next = applyRuntimeEventToSessionDetail(
      initialDetail,
      {
        id: 1,
        type: "session.status",
        messageId: null,
        payload: { status: "running" },
      },
      "2026-05-24T10:05:00.000Z",
    );
    seedSessionQueries(queryClient, workspaceId, next);

    const sidebarAfterStatus = queryClient.getQueryData<SidebarSessionPayload[]>(
      sessionQueryKeys.list(workspaceId),
    );
    expect(sidebarAfterStatus).not.toBe(sidebarAfterSeed);
    expect(sidebarAfterStatus?.[0]?.status).toBe("running");
    expect(sidebarAfterStatus?.[0]?.updatedAt).toBe("2026-05-24T10:05:00.000Z");
  });

  it("invalidates agent caches when a brain event arrives", () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const agentId = "agt_123";
    const invalidated: unknown[][] = [];
    queryClient.invalidateQueries = (filters) => {
      invalidated.push((filters as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    };

    invalidateRelatedCachesForSessionEvent(queryClient, workspaceId, agentId, {
      id: 1,
      type: "brain.file_changed",
      messageId: null,
      payload: { path: "docs/x.md" },
    });

    expect(invalidated).toEqual([
      agentQueryKeys.list(workspaceId),
      agentQueryKeys.detail(workspaceId, agentId),
    ]);
  });

  it("does not invalidate agent caches for non-brain events", () => {
    const queryClient = new QueryClient();
    let invalidations = 0;
    queryClient.invalidateQueries = () => {
      invalidations += 1;
      return Promise.resolve();
    };

    invalidateRelatedCachesForSessionEvent(queryClient, "wks_123", "agt_123", {
      id: 1,
      type: "message.delta",
      messageId: "msg_1",
      payload: { messageId: "msg_1", delta: "hi" },
    });

    expect(invalidations).toBe(0);
  });

  it("applies runtime status, error, and title updates to detail", () => {
    let current = detail();

    current = applyRuntimeEventToSessionDetail(
      current,
      {
        id: 1,
        type: "session.status",
        messageId: null,
        payload: { status: "running" },
      },
      "2026-05-24T10:02:00.000Z",
    );
    current = applyRuntimeEventToSessionDetail(
      current,
      {
        id: 2,
        type: "session.title_updated",
        messageId: null,
        payload: { title: "New title" },
      },
      "2026-05-24T10:03:00.000Z",
    );

    expect(current.session.status).toBe("running");
    expect(current.session.title).toBe("New title");
    expect(current.session.updatedAt).toBe("2026-05-24T10:03:00.000Z");
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
      agentPath: "agents/leo.agent",
      title: "Original",
      status: "created",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      e2bSandboxId: null,
      workdir: "/workspace",
      runLeaseId: null,
      abortRequestedAt: null,
      lastError: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
    },
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
    },
    runnerUrl: null,
    streamToken: null,
  };
}
