import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentSessionDetailPayload,
  archiveSidebarSessionOptimistically,
  parseAgentSessionDetailResponse,
  parseSidebarSessionPayload,
  parseSidebarSessionsResponse,
  removeSidebarSession,
  type SidebarSessionPayload,
  seedSessionQueries,
  serializeAgentSessionDetail,
  sessionQueryKeys,
  setSidebarSessionStar,
  upsertSidebarSession,
} from "@/lib/agent-sessions/payload";

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
      sandboxCostUsdMicros: 0,
    },
    runnerUrl: null,
  };
}
