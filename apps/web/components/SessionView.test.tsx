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

import type { ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import type { AssistantTurnPart, RuntimeEvent, SessionMessage } from "@/lib/agent-sessions/runtime-events";
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

// Phase C: useSessionEventStream mock — controlled per-test via the exported setter.
const mockStreamStatus = { value: "idle" as string };
vi.mock("@/components/useSessionEventStream", () => ({
  useSessionEventStream: () => ({ status: mockStreamStatus.value, errorMessage: null }),
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

    // ReasoningSummaryCard renders the formatted duration (formatThinkingDuration: "Thought for N seconds")
    expect(screen.getByText("Thought for 5 seconds")).toBeInTheDocument();
    // WorkingIndicator footer persists
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders all parts (text + tool-call + reasoning) while message is running", () => {
    const message = makeMessage({ status: "running" });
    const parts = [makeTextPart("Here are the results:"), makeToolCallPart("running"), makeReasoningPart()];
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

    expect(screen.getByText("Search files")).toBeInTheDocument();
    // Completed tool call has no "running" badge
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    // No WorkingIndicator
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // No placeholder dots
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });

  it("renders text + completed tool call without WorkingIndicator", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [makeTextPart("Done."), makeToolCallPart("completed")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.getByText("Search files")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders reasoning part without WorkingIndicator when completed", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [makeReasoningPart()];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Thought for 5 seconds")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

function makeSession(overrides: Partial<AgentSessionDetailPayload["session"]> = {}): AgentSessionDetailPayload["session"] {
  // Use a fresh updatedAt by default so the data-freshness stale check does not
  // trigger in tests that don't explicitly set fake timers or a stale timestamp.
  return {
    id: "sess_001",
    agentId: "agent_001",
    agentName: "Test Agent",
    agentPath: null,
    title: "Test Session",
    status: "running",
    modelProvider: "anthropic",
    modelName: "claude-3-5-sonnet",
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
    usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, inputNoCacheTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 0, outputReasoningTokens: 0 },
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: { totalCostUsdMicros: 0, modelCostUsdMicros: 0, toolCostUsdMicros: 0, providerCostUsdMicros: 0, platformFeeUsdMicros: 0 },
    runnerUrl: "https://runner.example.com",
    ...overrides,
  };
}

function renderSessionViewContent(
  detail: AgentSessionDetailPayload,
  streamStatus = "idle",
) {
  mockStreamStatus.value = streamStatus;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionViewContent detail={detail} workspaceId="wks_test" />
    </QueryClientProvider>,
  );
}

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
    const banner = allStatusEls.find((el) =>
      el.textContent?.includes("Connection idle"),
    );
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

    mockStreamStatus.value = "stale";
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

const STALE_THRESHOLD_MS = 15_000;

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

    mockStreamStatus.value = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Advance 1s to trigger the setInterval tick.
    act(() => { vi.advanceTimersByTime(1_000); });

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

    mockStreamStatus.value = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Advance 1s to trigger the setInterval tick.
    act(() => { vi.advanceTimersByTime(1_000); });

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

    mockStreamStatus.value = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detailStale} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Trigger tick → banner appears.
    act(() => { vi.advanceTimersByTime(1_000); });
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
    mockStreamStatus.value = "stale";
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
