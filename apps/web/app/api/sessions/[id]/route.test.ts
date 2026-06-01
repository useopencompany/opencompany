import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import { currentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agent-sessions/data", () => ({
  loadAgentSessionDetailForWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const loadAgentSessionDetailForWorkspaceMock = vi.mocked(loadAgentSessionDetailForWorkspace);
const currentWorkspaceMock = vi.mocked(currentWorkspace);

describe("session detail API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("returns serialized session detail for the current workspace user", async () => {
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue({
      session: {
        id: "ses_123",
        agentId: "agt_123",
        agentName: "Leo",
        agentPath: "agents/leo/agent.agent",
        title: "Fix issue",
        status: "running",
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
        updatedAt: "2026-05-24T10:01:00.000Z",
      },
      related: {
        parent: null,
        children: [
          {
            id: "ses_child",
            title: "Research",
            status: "completed",
            agentName: "Research",
            agentPath: "agents/research/agent.agent",
            parentMessageId: "msg_parent",
            parentToolCallId: "call_delegate",
            createdAt: "2026-05-24T10:02:00.000Z",
            updatedAt: "2026-05-24T10:03:00.000Z",
          },
        ],
      },
      messages: [],
      events: [],
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
    });

    const response = await GET(new Request("https://app.example.com/api/sessions/ses_123"), {
      params: Promise.resolve({ id: "ses_123" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      detail: expect.objectContaining({
        session: expect.objectContaining({ id: "ses_123", agentName: "Leo" }),
        related: expect.objectContaining({
          children: [expect.objectContaining({ id: "ses_child" })],
        }),
      }),
    });
    expect(loadAgentSessionDetailForWorkspaceMock).toHaveBeenCalledWith(
      "ses_123",
      "usr_123",
      "wks_123",
    );
  });

  it("returns 404 for missing sessions", async () => {
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue(null);

    const response = await GET(new Request("https://app.example.com/api/sessions/missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Session not found." });
  });

  it("propagates auth redirects instead of returning session detail", async () => {
    currentWorkspaceMock.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      GET(new Request("https://app.example.com/api/sessions/ses_123"), {
        params: Promise.resolve({ id: "ses_123" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(loadAgentSessionDetailForWorkspaceMock).not.toHaveBeenCalled();
  });
});
