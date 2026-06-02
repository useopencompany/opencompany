/**
 * Phase B tests for AssistantMessageContent live-part rendering.
 * Phase C tests for the stale-stream banner in SessionViewContent.
 * Phase C2 tests for the data-freshness stale detection (PRO-91 fix).
 *
 * Phase B verifies that tool-call and reasoning parts show up immediately in
 * the message body while the message is still running (status === "running"),
 * and that WorkingIndicator stays visible as a footer for the entire duration
 * of a running message — regardless of whether parts are already present.
 *
 * Phase C verifies that the stale-connection banner appears only when the SSE
 * stream is stale AND there is a running assistant message, and that the Retry
 * button triggers a credential cache invalidation.
 *
 * Phase C2 verifies data-freshness detection: the banner also appears when
 * stream.status is "open" but no new runtime event has arrived within
 * STALE_THRESHOLD_MS (15s), matching the real-world dead-session scenario where
 * SSE reconnects keep flipping stream.status away from "stale".
 */

import { captureEvent } from "@opencompany/analytics/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitAgentSessionMessage } from "@/lib/agent-sessions/actions";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { addUserMessageToSessionDetail } from "@/lib/agent-sessions/payload";
import type {
  AssistantTurnPart,
  RuntimeEvent,
  SessionMessage,
} from "@/lib/agent-sessions/runtime-events";
import { AssistantMessageContent, SessionViewContent } from "./SessionView";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({
  default: (input: ComponentProps<"a"> & { prefetch?: boolean }) => {
    const { href, children, prefetch, ...props } = input;
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : ""} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ workspaceId: "wks_test" }),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => ({ showError: vi.fn() }),
}));

vi.mock("@opencompany/analytics/client", () => ({
  captureEvent: vi.fn(),
}));

// Phase C: useSessionEventStream mock — controlled per-test via streamMock.
const streamMock = vi.hoisted(() => ({
  status: "idle" as string,
  input: null as null | { onEvent: (event: RuntimeEvent) => void },
}));
vi.mock("@/components/useSessionEventStream", () => ({
  useSessionEventStream: (input: { onEvent: (event: RuntimeEvent) => void }) => {
    streamMock.input = input;
    return { status: streamMock.status, errorMessage: null };
  },
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  abortAgentSession: vi.fn(),
  submitAgentSessionMessage: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  fetchAgentSession: vi.fn(),
  fetchSessionStreamCredential: vi.fn(),
  addUserMessageToSessionDetail: vi.fn(),
  applyRuntimeEventToSessionDetail: vi.fn(),
  invalidateRelatedCachesForSessionEvent: vi.fn(),
  mergeAgentSessionDetail: vi.fn(),
  seedSessionQueries: vi.fn(),
  sessionQueryKeys: {
    detail: (workspaceId: string, id: string) => ["session-detail", workspaceId, id],
    streamCredential: (workspaceId: string, id: string) => ["stream-credential", workspaceId, id],
  },
  updateSessionStatusInDetail: vi.fn(),
  SESSIONS_QUERY_STALE_TIME_MS: 30_000,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg_001",
    role: "assistant",
    content: "",
    status: "running",
    ...overrides,
  };
}

function makeToolCallPart(status: "running" | "completed" = "running"): AssistantTurnPart {
  return {
    type: "tool-call",
    toolCall: {
      id: "call_001",
      name: "search_files",
      status,
      inputPreview: '{"pattern":"*.ts"}',
      activityPreview: "",
      outputPreview: status === "completed" ? "3 files found" : "",
      startedEventId: 1,
      completedEventId: status === "completed" ? 2 : null,
    },
  };
}

function makeReasoningPart(): AssistantTurnPart {
  return {
    type: "reasoning",
    text: "I should look for TypeScript files.",
    durationSeconds: 5,
  };
}

function makeTextPart(text = "Here are the results:"): AssistantTurnPart {
  return { type: "text", text };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AssistantMessageContent — Phase A regression: running with no parts", () => {
  it("shows WorkingIndicator when message is running and has no parts", () => {
    const message = makeMessage({ status: "running" });
    render(<AssistantMessageContent message={message} parts={[]} sessionCanGenerate={true} />);

    // WorkingIndicator renders with role="status"
    expect(screen.getByRole("status")).toBeInTheDocument();
    // No placeholder dots shown
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });

  it("shows '...' placeholder when message is completed and has no parts", () => {
    const message = makeMessage({ status: "completed" });
    render(<AssistantMessageContent message={message} parts={[]} sessionCanGenerate={true} />);

    expect(screen.getByText("...")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("AssistantMessageContent — Phase B: running with parts renders all parts + footer indicator", () => {
  it("renders a running ToolCallCard while message is still running", () => {
    const message = makeMessage({ status: "running" });
    const parts = [makeToolCallPart("running")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // The tool call name appears (formatToolName capitalises first letter only)
    expect(screen.getByText("Search files")).toBeInTheDocument();
    // The inline running badge inside ToolCallCard
    expect(screen.getByText("running")).toBeInTheDocument();
    // WorkingIndicator footer persists
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders a reasoning part while message is still running", () => {
    const message = makeMessage({ status: "running" });
    const parts = [makeReasoningPart()];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // ReasoningCard renders the formatted duration (formatThinkingDuration: "Thought for N seconds")
    expect(screen.getByText("Thought for 5 seconds")).toBeInTheDocument();
    // WorkingIndicator footer persists
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders all parts (text + tool-call + reasoning) while message is running", () => {
    const message = makeMessage({ status: "running" });
    const parts = [
      makeTextPart("Here are the results:"),
      makeToolCallPart("running"),
      makeReasoningPart(),
    ];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Here are the results:")).toBeInTheDocument();
    expect(screen.getByText("Search files")).toBeInTheDocument();
    expect(screen.getByText("Thought for 5 seconds")).toBeInTheDocument();
    // WorkingIndicator still visible as footer
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("AssistantMessageContent — completed message regression", () => {
  it("renders a completed ToolCallCard without WorkingIndicator", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [makeToolCallPart("completed")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("1 step")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });

  it("renders text + completed tool call without WorkingIndicator", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [makeTextPart("Done."), makeToolCallPart("completed")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("1 step")).toBeInTheDocument();
    expect(screen.queryByText("Done.")).not.toBeInTheDocument();
    expect(screen.queryByText("Search files")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders reasoning part without WorkingIndicator when completed", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [makeReasoningPart()];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Thought for 5 seconds")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders completed reasoning without a made-up duration", () => {
    const message = makeMessage({ status: "completed" });
    const parts: AssistantTurnPart[] = [{ type: "reasoning", text: "Reviewed the request." }];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Thought")).toBeInTheDocument();
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument();
  });
});

// ── Phase B-extra: AssistantStoppedNotice on abort ────────────────────────

describe("AssistantMessageContent — abort: stopped notice renders regardless of parts", () => {
  it("shows AssistantStoppedNotice when message is running but session cannot generate (no parts)", () => {
    const message = makeMessage({ status: "running" });
    render(<AssistantMessageContent message={message} parts={[]} sessionCanGenerate={false} />);

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
    // WorkingIndicator should NOT be shown
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows AssistantStoppedNotice when message is running but session cannot generate (has parts)", () => {
    const message = makeMessage({ status: "running" });
    const parts = [makeToolCallPart("running")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={false} />);

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
    // WorkingIndicator should NOT be shown — session cannot generate
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows AssistantStoppedNotice for a failed message (no parts)", () => {
    const message = makeMessage({ status: "failed" });
    render(<AssistantMessageContent message={message} parts={[]} sessionCanGenerate={true} />);

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
  });

  it("shows AssistantStoppedNotice for a failed message (has parts)", () => {
    const message = makeMessage({ status: "failed" });
    const parts = [makeTextPart("Partial output…")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
    expect(screen.getByText("Partial output…")).toBeInTheDocument();
  });

  it("does NOT show AssistantStoppedNotice when message is running and session can generate", () => {
    const message = makeMessage({ status: "running" });
    render(<AssistantMessageContent message={message} parts={[]} sessionCanGenerate={true} />);

    expect(screen.queryByText("Stopped before finishing")).not.toBeInTheDocument();
    // WorkingIndicator is visible instead
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

// ── Phase C: Stale-stream banner ───────────────────────────────────────────

function makeSession(
  overrides: Partial<AgentSessionDetailPayload["session"]> = {},
): AgentSessionDetailPayload["session"] {
  // Use a fresh updatedAt by default so the data-freshness stale check does not
  // trigger in tests that don't explicitly set fake timers or a stale timestamp.
  return {
    id: "sess_001",
    agentId: "agent_001",
    agentName: "Test Agent",
    agentPath: null,
    title: "Test Session",
    status: "running",
    source: "user",
    modelProvider: "anthropic",
    modelName: "claude-3-5-sonnet",
    parentSessionId: null,
    parentMessageId: null,
    parentToolCallId: null,
    e2bSandboxId: null,
    workdir: "/tmp",
    runLeaseId: null,
    abortRequestedAt: null,
    lastError: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunningAssistantMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg_running",
    role: "assistant",
    content: "Thinking…",
    status: "running",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<AgentSessionDetailPayload> = {}): AgentSessionDetailPayload {
  return {
    session: makeSession(),
    related: { parent: null, children: [] },
    messages: [],
    events: [],
    usage: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
    },
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: {
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
    },
    runnerUrl: "https://runner.example.com",
    ...overrides,
  };
}

function renderSessionViewContent(detail: AgentSessionDetailPayload, streamStatus = "idle") {
  streamMock.status = streamStatus;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionViewContent detail={detail} workspaceId="wks_test" />
    </QueryClientProvider>,
  );
}

describe("SessionViewContent — active turn timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the triggering user message time for a running assistant turn", () => {
    const now = new Date("2026-05-28T10:00:10.000Z").getTime();
    vi.setSystemTime(now);
    const userCreatedAt = new Date(now - 5000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: new Date(now).toISOString() }),
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Run tests",
          status: "completed",
          createdAt: userCreatedAt,
        },
        makeRunningAssistantMessage({
          createdAt: new Date(now).toISOString(),
          responseToMessageId: "msg_user",
        }),
      ],
    });

    renderSessionViewContent(detail, "open");

    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.queryByText("0s")).not.toBeInTheDocument();
  });
});

describe("SessionViewContent — live reasoning rendering", () => {
  it("shows live reasoning delta text inside the expandable reasoning card", async () => {
    const user = userEvent.setup();
    const detail = makeDetail({
      messages: [makeRunningAssistantMessage({ content: "" })],
      events: [
        {
          id: null,
          type: "message.reasoning_delta",
          messageId: "msg_running",
          payload: { messageId: "msg_running", delta: "Considering constraints." },
        },
      ],
    });

    renderSessionViewContent(detail, "open");

    await user.click(screen.getByRole("button", { name: /Thought/ }));

    expect(screen.getByText("Considering constraints.")).toBeInTheDocument();
  });

  it("copies only assistant answer text when live reasoning is present", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const detail = makeDetail({
        messages: [
          {
            id: "msg_done",
            role: "assistant",
            content: "Final answer",
            status: "completed",
          },
        ],
        events: [
          {
            id: null,
            type: "message.reasoning_delta",
            messageId: "msg_done",
            payload: { messageId: "msg_done", delta: "Do not copy this reasoning." },
          },
        ],
      });

      renderSessionViewContent(detail, "open");

      await user.click(screen.getByRole("button", { name: "Copy message" }));

      expect(writeText).toHaveBeenCalledWith("Final answer");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});

describe("SessionViewContent — felt TTFT", () => {
  beforeEach(() => {
    streamMock.status = "idle";
    streamMock.input = null;
    vi.mocked(captureEvent).mockReset();
    vi.mocked(submitAgentSessionMessage).mockReset();
  });

  it("records reasoning as the first visible assistant activity", async () => {
    const user = userEvent.setup();
    let now = 1_000;
    const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(submitAgentSessionMessage).mockResolvedValue({
      ok: true,
      messageId: "msg_user_new",
    });

    try {
      const detail = makeDetail({
        session: makeSession({
          status: "ready",
          modelProvider: "openrouter",
          modelName: "moonshotai/kimi-k2.6",
        }),
      });
      renderSessionViewContent(detail, "open");

      await user.type(screen.getByPlaceholderText("Ask this agent to do something"), "continue");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(submitAgentSessionMessage).toHaveBeenCalledWith("sess_001", "continue"),
      );
      await waitFor(() =>
        expect(screen.getByPlaceholderText("Ask this agent to do something")).toHaveValue(""),
      );

      now = 1_240;
      act(() => {
        streamMock.input?.onEvent({
          id: null,
          type: "message.reasoning_delta",
          messageId: "msg_assistant",
          payload: { messageId: "msg_assistant", delta: "Considering the next step." },
        });
      });

      expect(captureEvent).toHaveBeenCalledWith(
        "session_first_token",
        expect.objectContaining({
          workspace_id: "wks_test",
          agent_id: "agent_001",
          session_id: "sess_001",
          message_id: "msg_user_new",
          model_provider: "openrouter",
          model_name: "moonshotai/kimi-k2.6",
          ttft_ms: 240,
          first_token_kind: "reasoning",
        }),
      );
    } finally {
      performanceNowSpy.mockRestore();
    }
  });
});

describe("SessionViewContent — Phase C: stale-stream banner", () => {
  it("shows banner when stream is stale AND there is a running assistant message", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "stale");

    expect(screen.getByText("Connection idle — waiting for updates…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("banner has role=status and aria-live=polite", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "stale");

    // There may be multiple role="status" elements (WorkingIndicator also uses it).
    // Identify the banner by its unique text content.
    const allStatusEls = screen.getAllByRole("status");
    const banner = allStatusEls.find((el) => el.textContent?.includes("Connection idle"));
    expect(banner).toBeDefined();
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent("Connection idle — waiting for updates…");
  });

  it("does NOT show banner when stream is stale but no running assistant message", () => {
    const detail = makeDetail({
      messages: [{ id: "msg_done", role: "assistant", content: "Done.", status: "completed" }],
    });
    renderSessionViewContent(detail, "stale");

    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("does NOT show banner when stream is healthy (open) even with a running message", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "open");

    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("does NOT show banner when stream is idle even with a running message", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "idle");

    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("does NOT show banner when stream is errored (error has its own UX)", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "error");

    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("Retry button calls queryClient.invalidateQueries to trigger reconnect", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    streamMock.status = "stale";
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });

    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });
});

// ── Phase C2: Data-freshness stale detection ───────────────────────────────
//
// These tests verify that the banner triggers from data freshness (no new
// runtime event for > STALE_THRESHOLD_MS) regardless of SSE stream.status.
// Uses vi.useFakeTimers() so setInterval ticks and Date.now() are controllable.

function makeEventFixture(id: number): RuntimeEvent {
  return { id, type: "message.delta", messageId: "msg_running", payload: {} };
}

describe("SessionViewContent — Phase C2: data-freshness stale detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT show banner when stream is open and a recent event landed (< STALE_THRESHOLD_MS ago)", () => {
    // Set the fake clock so "now" is 2000-01-01T00:00:30Z.
    // updatedAt is set to 25s before now — within the 15s threshold from the last event.
    const now = new Date("2000-01-01T00:00:30.000Z").getTime();
    vi.setSystemTime(now);

    // An event exists, initialized 5s ago relative to now.
    const recentUpdatedAt = new Date(now - 5_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: recentUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(1)],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Advance 1s to trigger the setInterval tick.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // Still within threshold (5s + 1s = 6s < 15s), no banner.
    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("shows banner when stream is open but no event for > STALE_THRESHOLD_MS", () => {
    // Set the fake clock so "now" is 2000-01-01T00:01:00Z.
    const now = new Date("2000-01-01T00:01:00.000Z").getTime();
    vi.setSystemTime(now);

    // updatedAt is 20s in the past — stale by the time the first tick fires.
    const staleUpdatedAt = new Date(now - 50_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: staleUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [], // No events yet; component falls back to session.updatedAt.
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Advance 1s to trigger the setInterval tick.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // 20s + 1s tick = 21s > 15s threshold → banner must appear.
    expect(screen.getByText("Connection idle — waiting for updates…")).toBeInTheDocument();
  });

  it("hides banner once a new event arrives after being shown", () => {
    const now = new Date("2000-01-01T00:02:00.000Z").getTime();
    vi.setSystemTime(now);

    const staleUpdatedAt = new Date(now - 50_000).toISOString();
    const detailStale = makeDetail({
      session: makeSession({ updatedAt: staleUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detailStale} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Trigger tick → banner appears.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("Connection idle — waiting for updates…")).toBeInTheDocument();

    // A new event arrives: rerender with a new event in the list.
    // The component sees lastEventId change → resets lastRuntimeActivityMs to now.
    const freshDetail = makeDetail({
      session: makeSession({ updatedAt: new Date(now - 19_000).toISOString() }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(42)],
    });

    act(() => {
      rerender(
        <QueryClientProvider client={queryClient}>
          <SessionViewContent detail={freshDetail} workspaceId="wks_test" />
        </QueryClientProvider>,
      );
    });

    // Banner should be gone — event just landed.
    expect(screen.queryByText("Connection idle — waiting for updates…")).not.toBeInTheDocument();
  });

  it("still shows banner when stream.status is stale (regression of original Phase C behaviour)", () => {
    // stream.status = "stale" path still works independently of data freshness.
    const now = new Date("2000-01-01T00:03:00.000Z").getTime();
    vi.setSystemTime(now);

    // updatedAt is recent (1s ago) so data-freshness path alone would NOT fire.
    const recentUpdatedAt = new Date(now - 1_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: recentUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(99)],
    });

    // Force status to stale (SSE path).
    streamMock.status = "stale";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Banner must appear immediately (stream.status === "stale") without needing tick.
    expect(screen.getByText("Connection idle — waiting for updates…")).toBeInTheDocument();
  });
});

// ── PRO-124: snap-to-top on send ───────────────────────────────────────────
//
// Verifies the headline behaviour: on send, the just-sent user message snaps to
// the TOP of the viewport, and the streaming bottom-auto-scroll does NOT override
// it on the next render (the bug the review flagged).

describe("SessionViewContent — PRO-124: snap user message to top on send", () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;
  let originalScrollTo: PropertyDescriptor | undefined;

  beforeEach(() => {
    // jsdom does not implement scrollTo; install a spy so the snap effect runs.
    scrollToSpy = vi.fn();
    originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });
    // Give the scroll container a non-zero clientHeight so the spacer seeds.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    // scrollHeight just above clientHeight so a scroll event lands within the
    // bottom threshold (distanceFromBottom = 860 - 0 - 800 = 60 ≤ 80) yet > 1, so
    // the streaming follow would fire if it were (wrongly) re-armed.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 860,
    });
  });

  afterEach(() => {
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    } else {
      // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
      delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    }
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { clientHeight?: unknown }).clientHeight;
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    vi.clearAllMocks();
  });

  it("scrolls the just-sent user message toward the top and does not follow to bottom on the next render", async () => {
    const user = userEvent.setup();
    const userMessage: SessionMessage = {
      id: "msg_user_snap",
      role: "user",
      content: "Hello there",
      status: "completed",
    };

    // The submit action resolves with the id of the user message already present
    // in the detail, so the snap effect can find its DOM node.
    vi.mocked(submitAgentSessionMessage).mockResolvedValue({
      ok: true,
      messageId: "msg_user_snap",
    } as Awaited<ReturnType<typeof submitAgentSessionMessage>>);
    // Keep the query cache untouched so visibleMessages stays driven by props.
    vi.mocked(addUserMessageToSessionDetail).mockImplementation((detail) => detail);

    // A completed assistant turn follows the user message so the composer shows the
    // "Send message" button initially (not the waiting/abort state), while the user
    // message remains present in the DOM for the snap effect to target.
    const detail = makeDetail({
      messages: [
        userMessage,
        {
          id: "msg_prev_assistant",
          role: "assistant",
          content: "Earlier reply",
          status: "completed",
        },
      ],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByPlaceholderText("Ask this agent to do something"), "Hello there");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The snap effect ran: a scrollTo was issued. It is a "top" snap (behavior
    // "smooth"), NOT the streaming bottom-follow (which uses behavior "auto").
    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalled();
    });
    const snapCall = scrollToSpy.mock.calls.at(-1)?.[0];
    expect(snapCall).toMatchObject({ behavior: "smooth" });

    scrollToSpy.mockClear();

    // Simulate the response streaming in: a running assistant message appears.
    const streamingDetail = makeDetail({
      messages: [
        userMessage,
        {
          id: "msg_prev_assistant",
          role: "assistant",
          content: "Earlier reply",
          status: "completed",
        },
        { id: "msg_assistant", role: "assistant", content: "Working…", status: "running" },
      ],
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // The bottom-auto-scroll must NOT fire after the snap (snapInProgress + not
    // pinned). No scroll-to-bottom (behavior "auto") should override the snap.
    await waitFor(() => {
      // A real bottom-follow scrolls toward scrollHeight (≥ clientHeight 800); the
      // maintain pass issues upward "auto" scrolls toward the top, which are NOT a
      // follow-to-bottom.
      const followedToBottom = scrollToSpy.mock.calls.some(
        ([arg]) => arg?.behavior === "auto" && (arg?.top ?? 0) >= 800,
      );
      expect(followedToBottom).toBe(false);
    });
  });

  // Drives send → snap, then returns handles to simulate the streaming render.
  async function sendAndSnap() {
    const user = userEvent.setup();
    const userMessage: SessionMessage = {
      id: "msg_user_snap",
      role: "user",
      content: "Hello there",
      status: "completed",
    };
    vi.mocked(submitAgentSessionMessage).mockResolvedValue({
      ok: true,
      messageId: "msg_user_snap",
    } as Awaited<ReturnType<typeof submitAgentSessionMessage>>);
    vi.mocked(addUserMessageToSessionDetail).mockImplementation((detail) => detail);

    const baseMessages: SessionMessage[] = [
      userMessage,
      {
        id: "msg_prev_assistant",
        role: "assistant",
        content: "Earlier reply",
        status: "completed",
      },
    ];
    const detail = makeDetail({ messages: baseMessages });
    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByPlaceholderText("Ask this agent to do something"), "Hello there");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());
    scrollToSpy.mockClear();

    const streamingDetail = makeDetail({
      messages: [
        ...baseMessages,
        { id: "msg_assistant", role: "assistant", content: "Working…", status: "running" },
      ],
    });
    const scroller = view.container.querySelector(".overflow-y-auto");
    return { ...view, queryClient, scroller, streamingDetail };
  }

  it("does not let a programmatic / layout-driven scroll near the bottom override the snap", async () => {
    const { rerender, queryClient, scroller, streamingDetail } = await sendAndSnap();

    // A scroll event fires WITHOUT any user gesture — e.g. the reserved spacer
    // shrinking or the viewport height changing right after the snap. It lands within
    // the bottom threshold (distanceFromBottom = 60 ≤ 80) but must NOT be mistaken for
    // "the user returned to the bottom" (the PRO-124 follow-up bug).
    if (scroller) fireEvent.scroll(scroller);
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      // A real bottom-follow scrolls toward scrollHeight (≥ clientHeight 800); the
      // maintain pass issues upward "auto" scrolls toward the top, which are NOT a
      // follow-to-bottom.
      const followedToBottom = scrollToSpy.mock.calls.some(
        ([arg]) => arg?.behavior === "auto" && (arg?.top ?? 0) >= 800,
      );
      expect(followedToBottom).toBe(false);
    });
  });

  it("re-arms the streaming follow when the USER scrolls back to the bottom", async () => {
    const { rerender, queryClient, scroller, streamingDetail } = await sendAndSnap();

    // A genuine user gesture (wheel) precedes the scroll, so reaching the bottom IS
    // user intent → the streaming follow may resume.
    if (scroller) {
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller);
    }
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      // A real bottom-follow scrolls toward scrollHeight (≥ clientHeight 800); the
      // maintain pass issues upward "auto" scrolls toward the top, which are NOT a
      // follow-to-bottom.
      const followedToBottom = scrollToSpy.mock.calls.some(
        ([arg]) => arg?.behavior === "auto" && (arg?.top ?? 0) >= 800,
      );
      expect(followedToBottom).toBe(true);
    });
  });

  it("releases the snap when the user scrolls UP (not to the bottom) mid-generation — no re-pin", async () => {
    const { rerender, queryClient, scroller, streamingDetail } = await sendAndSnap();

    // The user scrolls UP to read: a real wheel gesture landing FAR from the bottom
    // (distanceFromBottom = 1000 - 0 - 800 = 200 > SCROLL_BOTTOM_THRESHOLD_PX). This
    // must hand control to the user — releasing the snap so the maintain pass does NOT
    // yank the message back to the top on the next streamed render.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    if (scroller) {
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller);
    }
    scrollToSpy.mockClear();
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Neither the maintain pass (re-pin toward the top) nor the bottom-follow may
    // scroll — the user's just-chosen position is left untouched.
    await waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });
});
