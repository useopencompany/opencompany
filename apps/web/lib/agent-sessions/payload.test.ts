import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentSessionDetailPayload,
  addUserMessageToSessionDetail,
  applyRuntimeEventToSessionDetail,
  archiveSidebarSessionOptimistically,
  invalidateRelatedCachesForSessionEvent,
  isSidebarSessionActive,
  mergeAgentSessionDetail,
  parseAgentSessionDetailResponse,
  parseSessionStreamCredentialResponse,
  parseSidebarSessionPayload,
  parseSidebarSessionsResponse,
  removeSidebarSession,
  type SidebarSessionPayload,
  seedSessionQueries,
  serializeAgentSessionDetail,
  sessionQueryKeys,
  setSidebarSessionStar,
  sidebarSessionFromDetail,
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

  it("sets and clears server-truth star state on a sidebar session", () => {
    const sessions = [sidebarSession("ses_1", "One"), sidebarSession("ses_2", "Two")];

    const starred = setSidebarSessionStar(sessions, "ses_2", "2026-05-29T10:00:00.000Z");
    expect(starred.find((session) => session.id === "ses_2")?.starredAt).toBe(
      "2026-05-29T10:00:00.000Z",
    );
    expect(starred.find((session) => session.id === "ses_1")?.starredAt).toBeNull();

    const unstarred = setSidebarSessionStar(starred, "ses_2", null);
    expect(unstarred.find((session) => session.id === "ses_2")?.starredAt).toBeNull();
  });

  it("preserves an existing star when a detail projection upserts the same session", () => {
    const starred: SidebarSessionPayload = {
      ...sidebarSession("ses_1", "One"),
      starredAt: "2026-05-29T10:00:00.000Z",
      updatedAt: "2026-05-24T09:00:00.000Z",
    };

    // Detail projections always carry starredAt = null; the upsert must not clobber the star.
    const next = upsertSidebarSession([starred], {
      ...sidebarSession("ses_1", "One updated"),
      updatedAt: "2026-05-24T11:00:00.000Z",
    });

    expect(next.find((session) => session.id === "ses_1")?.starredAt).toBe(
      "2026-05-29T10:00:00.000Z",
    );
    expect(next.find((session) => session.id === "ses_1")?.title).toBe("One updated");
  });

  it("does not add agent-generated sessions to the sidebar cache", () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const childDetail = detail();
    childDetail.session.source = "agent";

    queryClient.setQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId), [
      sidebarSession(childDetail.session.id, "Generated child"),
      sidebarSession("ses_keep", "Keep"),
    ]);

    seedSessionQueries(queryClient, workspaceId, childDetail);

    expect(
      queryClient.getQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId)),
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

  it("does not revive a failed assistant message when refetching a failed session", () => {
    const current = detail({
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          content: "",
          status: "failed",
          createdAt: "2026-05-24T10:00:00.000Z",
          completedAt: "2026-05-24T10:02:00.000Z",
        },
      ],
    });
    current.session = {
      ...current.session,
      status: "failed",
      lastError: "Gateway down",
      updatedAt: "2026-05-24T10:02:00.000Z",
    };
    const incoming = detail({
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
    incoming.session = current.session;

    const merged = mergeAgentSessionDetail(current, incoming);

    expect(merged.messages[0]).toMatchObject({
      status: "failed",
      completedAt: "2026-05-24T10:02:00.000Z",
    });
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

  it("fills an empty user message placeholder created by the live event stream", () => {
    const current = applyRuntimeEventToSessionDetail(detail(), {
      id: 1,
      type: "message.created",
      messageId: "msg_user",
      payload: { messageId: "msg_user", role: "user" },
    });

    const next = addUserMessageToSessionDetail(current, {
      messageId: "msg_user",
      content: "Ship it",
      createdAt: "2026-05-24T10:01:00.000Z",
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: "msg_user",
      role: "user",
      content: "Ship it",
      status: "completed",
    });
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
        starredAt: null,
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

  it("invalidates the current session detail when delegated sessions change", () => {
    const queryClient = new QueryClient();
    const invalidated: unknown[][] = [];
    queryClient.invalidateQueries = (filters) => {
      invalidated.push((filters as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    };

    invalidateRelatedCachesForSessionEvent(
      queryClient,
      "wks_123",
      "agt_123",
      {
        id: 1,
        type: "tool.completed",
        messageId: "msg_1",
        payload: {
          name: "delegate_to_agent",
          output: { childSessionId: "ses_child" },
        },
      },
      { sessionId: "ses_parent" },
    );

    expect(invalidated).toEqual([sessionQueryKeys.detail("wks_123", "ses_parent")]);
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
    expect(
      parseSessionStreamCredentialResponse({
        runnerUrl: "https://runner.example.com",
        streamToken: "token",
      }),
    ).toEqual({
      runnerUrl: "https://runner.example.com",
      streamToken: "token",
    });
  });

  it("serializes runtime event timestamps in session details", () => {
    const base = detail();
    const serialized = serializeAgentSessionDetail({
      usage: base.usage,
      toolUsage: base.toolUsage,
      cost: base.cost,
      runnerUrl: base.runnerUrl,
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

describe("archiveSidebarSessionOptimistically", () => {
  it("removes the session from the sidebar before the archive resolves", async () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    queryClient.setQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId), [
      sidebarSession("ses_keep", "Keep"),
      sidebarSession("ses_archive", "Archive"),
    ]);

    let listDuringArchive: SidebarSessionPayload[] | undefined;
    const archive = vi.fn(async () => {
      // Capture the cache state while the server action is still in flight: the optimistic
      // update must have already removed the session at this point.
      listDuringArchive = queryClient.getQueryData<SidebarSessionPayload[]>(
        sessionQueryKeys.list(workspaceId),
      );
      return { ok: true } as const;
    });

    const result = await archiveSidebarSessionOptimistically({
      queryClient,
      workspaceId,
      sessionId: "ses_archive",
      archive,
    });

    expect(result).toEqual({ ok: true });
    expect(listDuringArchive?.map((session) => session.id)).toEqual(["ses_keep"]);
    expect(
      queryClient
        .getQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId))
        ?.map((session) => session.id),
    ).toEqual(["ses_keep"]);
  });

  it("rolls back the sidebar when the archive action returns an error", async () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    const initialList = [
      sidebarSession("ses_keep", "Keep"),
      sidebarSession("ses_archive", "Archive"),
    ];
    queryClient.setQueryData<SidebarSessionPayload[]>(
      sessionQueryKeys.list(workspaceId),
      initialList,
    );

    const archive = vi.fn(async () => ({ ok: false, error: "Session not found." }) as const);

    const result = await archiveSidebarSessionOptimistically({
      queryClient,
      workspaceId,
      sessionId: "ses_archive",
      archive,
    });

    expect(result).toEqual({ ok: false, error: "Session not found." });
    expect(
      queryClient
        .getQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId))
        ?.map((session) => session.id),
    ).toEqual(["ses_keep", "ses_archive"]);
  });

  it("rolls back the sidebar when the archive action throws", async () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    queryClient.setQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId), [
      sidebarSession("ses_keep", "Keep"),
      sidebarSession("ses_archive", "Archive"),
    ]);

    const archive = vi.fn(async () => {
      throw new Error("Network down");
    });

    const result = await archiveSidebarSessionOptimistically({
      queryClient,
      workspaceId,
      sessionId: "ses_archive",
      archive,
    });

    expect(result).toEqual({ ok: false, error: "Network down" });
    expect(
      queryClient
        .getQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId))
        ?.map((session) => session.id),
    ).toEqual(["ses_keep", "ses_archive"]);
  });

  it("drops the detail cache and refetches the list after a successful archive", async () => {
    const queryClient = new QueryClient();
    const workspaceId = "wks_123";
    queryClient.setQueryData<SidebarSessionPayload[]>(sessionQueryKeys.list(workspaceId), [
      sidebarSession("ses_archive", "Archive"),
    ]);
    queryClient.setQueryData(sessionQueryKeys.detail(workspaceId, "ses_archive"), detail());

    const invalidated: unknown[][] = [];
    queryClient.invalidateQueries = (filters) => {
      invalidated.push((filters as { queryKey: unknown[] }).queryKey);
      return Promise.resolve();
    };

    await archiveSidebarSessionOptimistically({
      queryClient,
      workspaceId,
      sessionId: "ses_archive",
      archive: async () => ({ ok: true }) as const,
    });

    expect(
      queryClient.getQueryData(sessionQueryKeys.detail(workspaceId, "ses_archive")),
    ).toBeUndefined();
    expect(invalidated).toEqual([sessionQueryKeys.list(workspaceId)]);
  });
});

function sidebarSession(id: string, title: string) {
  return {
    id,
    title,
    status: "completed",
    active: false,
    modelName: "model",
    lastError: null,
    createdAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:00:00.000Z",
    starredAt: null,
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
    },
    runnerUrl: null,
  };
}

describe("sidebar session active indicator", () => {
  it("treats running/provisioning statuses as active regardless of messages", () => {
    expect(isSidebarSessionActive("running", false, false)).toBe(true);
    expect(isSidebarSessionActive("provisioning", false, false)).toBe(true);
    expect(isSidebarSessionActive("ready", false, false)).toBe(false);
    expect(isSidebarSessionActive("completed", false, false)).toBe(false);
  });

  it("is active when an assistant message streams in a session that can still generate", () => {
    // The persisted "running" session status often lags; a streaming assistant
    // message in a generatable state still lights the dot.
    expect(isSidebarSessionActive("created", true, false)).toBe(true);
    expect(isSidebarSessionActive("ready", true, false)).toBe(true);
  });

  it("ignores orphaned running messages on failed/aborted/errored sessions", () => {
    // A failed or aborted session can leave a "running" assistant message behind
    // (a zombie). That must not light the dot — mirrors SessionView's
    // `sessionCanGenerate` guard so the sidebar agrees with the main panel.
    expect(isSidebarSessionActive("failed", true, false)).toBe(false);
    expect(isSidebarSessionActive("aborting", true, false)).toBe(false);
    expect(isSidebarSessionActive("archived", true, false)).toBe(false);
    expect(isSidebarSessionActive("ready", true, true)).toBe(false);
  });

  it("projects active=true from a detail with a running assistant message and stale status", () => {
    const projected = sidebarSessionFromDetail(
      detail({
        messages: [
          {
            id: "msg_1",
            role: "assistant",
            content: "still writing…",
            status: "running",
            createdAt: "2026-05-24T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(projected.active).toBe(true);
  });

  it("projects active=false when no assistant message is running and status is idle", () => {
    const projected = sidebarSessionFromDetail(
      detail({
        messages: [
          {
            id: "msg_1",
            role: "assistant",
            content: "done",
            status: "completed",
            createdAt: "2026-05-24T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(projected.active).toBe(false);
  });
});
