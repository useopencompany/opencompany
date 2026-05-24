import { describe, expect, it } from "vitest";
import {
  type AgentSessionDetailPayload,
  applyRuntimeEventToSessionDetail,
  mergeAgentSessionDetail,
  removeSidebarSession,
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

  it("merges refetched detail without discarding streamed events or content", () => {
    const current = detail({
      events: [
        { id: 1, type: "message.created", messageId: "msg_1", payload: { messageId: "msg_1" } },
        { id: 2, type: "message.delta", messageId: "msg_1", payload: { delta: "hello world" } },
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
        { id: 1, type: "message.created", messageId: "msg_1", payload: { messageId: "msg_1" } },
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
