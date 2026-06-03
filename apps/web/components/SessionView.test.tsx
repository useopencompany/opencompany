/**
 * Phase B tests for AssistantMessageContent live-part rendering.
 * Phase C tests for stale-connection handling in SessionViewContent.
 * Phase C2 tests for the data-freshness stale detection (PRO-91 fix).
 *
 * Phase B verifies that tool-call and reasoning parts show up immediately in
 * the message body while the message is still running (status === "running"),
 * and that WorkingIndicator stays visible as a footer for the entire duration
 * of a running message — regardless of whether parts are already present.
 *
 * Phase C verifies that a stale connection never surfaces a banner in the chat
 * composer (that was found to be noisy during normal streaming), and instead is
 * surfaced quietly in the inspector's Runtime section.
 *
 * Phase C2 verifies data-freshness detection: a stale connection is also
 * detected when stream.status is "open" but no new runtime event has arrived
 * within STALE_THRESHOLD_MS (45s) — matching the real-world dead-session
 * scenario where SSE reconnects keep flipping stream.status away from "stale".
 * In all cases recovery still refetches silently and the inspector reflects the
 * stale state, but no composer banner is rendered.
 */

import { captureEvent } from "@opencompany/analytics/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  submitAgentSessionMessage,
  submitAgentSessionQuestionResponse,
} from "@/lib/agent-sessions/actions";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { addUserMessageToSessionDetail } from "@/lib/agent-sessions/payload";
import type {
  AssistantTurnPart,
  RuntimeEvent,
  RuntimeToolCall,
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
// The composer banner was removed — this text must never appear in the chat UX.
const STALE_BANNER_TEXT = "Connection idle — reconnecting and refreshing progress…";
// Stale connection is now surfaced only here, in the inspector's Runtime section.
const INSPECTOR_STALE_TEXT =
  "The live session stream is not responding. Reconnecting and refreshing persisted progress.";
vi.mock("@/components/useSessionEventStream", () => ({
  useSessionEventStream: (input: { onEvent: (event: RuntimeEvent) => void }) => {
    streamMock.input = input;
    return { status: streamMock.status, errorMessage: null };
  },
}));

const actionMocks = vi.hoisted(() => ({
  abortAgentSession: vi.fn(),
  cancelAgentSessionQuestion: vi.fn(),
  resolveToolApproval: vi.fn(),
  submitAgentSessionMessage: vi.fn(),
  submitAgentSessionQuestionResponse: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  abortAgentSession: actionMocks.abortAgentSession,
  cancelAgentSessionQuestion: actionMocks.cancelAgentSessionQuestion,
  resolveToolApproval: actionMocks.resolveToolApproval,
  submitAgentSessionMessage: actionMocks.submitAgentSessionMessage,
  submitAgentSessionQuestionResponse: actionMocks.submitAgentSessionQuestionResponse,
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  fetchAgentSession: vi.fn(async () => null),
  fetchSessionStreamCredential: vi.fn(async () => null),
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

afterEach(() => {
  actionMocks.cancelAgentSessionQuestion.mockReset();
  actionMocks.resolveToolApproval.mockReset();
  actionMocks.submitAgentSessionQuestionResponse.mockReset();
});

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

function makeApprovalToolCallPart(
  approval: NonNullable<RuntimeToolCall["approval"]>,
): AssistantTurnPart {
  return {
    type: "tool-call",
    toolCall: {
      id: "call_approval",
      name: "linear__save_comment",
      label: "Saving Linear comment",
      status: "running",
      inputPreview: '{\n  "issueId": "OC-222"\n}',
      activityPreview: "",
      outputPreview: "",
      approval,
      startedEventId: null,
      completedEventId: null,
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

describe("AssistantMessageContent — tool approvals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T08:51:35.162Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a pending approval with clear copy", () => {
    const message = makeMessage({ status: "running" });
    const parts = [
      makeApprovalToolCallPart({
        status: "required",
        providerKey: "linear",
        permissionGroup: "post",
        requestedAt: "2026-06-02T08:51:35.162Z",
      }),
    ];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // The pause is durable (7-day backstop), so there is no short auto-deny countdown.
    expect(screen.getByText("Waiting for your approval.")).toBeInTheDocument();
    expect(screen.getByText("Create issues and add comments.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("keeps showing the approval prompt once the run has durably paused", () => {
    // Regression: after suspend the assistant message is `completed` and the session is
    // `awaiting_approval` (sessionCanGenerate=false). The pending tool call is still
    // status "running" — it must NOT be flipped to "Stopped before finishing"; the
    // approval prompt must stay rendered.
    const message = makeMessage({ status: "completed" });
    const parts = [
      makeApprovalToolCallPart({
        status: "required",
        providerKey: "linear",
        permissionGroup: "post",
        requestedAt: "2026-06-02T08:51:35.162Z",
      }),
    ];

    render(
      <AssistantMessageContent
        message={message}
        parts={parts}
        sessionCanGenerate={false}
        sessionIsPaused={true}
      />,
    );

    expect(screen.getByText("Waiting for your approval.")).toBeInTheDocument();
    expect(screen.queryByText("Stopped before finishing.")).not.toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();
  });

  it("keeps the persisted paused approval prompt visible after model parts are saved", () => {
    const detail = makeDetail({
      session: makeSession({ id: "sess_approval", status: "awaiting_approval" }),
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Post a test comment",
          status: "completed",
          createdAt: "2026-06-02T08:51:30.000Z",
        },
        {
          id: "msg_approval",
          role: "assistant",
          content: "I found an issue and I am posting a comment now.",
          status: "completed",
          responseToMessageId: "msg_user",
          createdAt: "2026-06-02T08:51:31.000Z",
          completedAt: "2026-06-02T08:51:35.000Z",
          modelMessage: {
            role: "assistant",
            content: [
              { type: "text", text: "I found an issue." },
              {
                type: "tool-call",
                toolCallId: "call_read",
                toolName: "linear__list_issues",
                input: { query: "test", limit: 5 },
              },
              { type: "text", text: "I am posting a comment now." },
              {
                type: "tool-call",
                toolCallId: "call_approval",
                toolName: "linear__save_comment",
                input: { issueId: "OC-184", body: "Test comment" },
              },
            ],
          },
        },
      ],
      events: [
        {
          id: 1,
          type: "tool.completed",
          messageId: "msg_approval",
          createdAt: "2026-06-02T08:51:32.000Z",
          payload: {
            messageId: "msg_approval",
            toolCallId: "call_read",
            name: "linear__list_issues",
            outputPreview: "{ issues: [] }",
          },
        },
        {
          id: 2,
          type: "tool.approval_required",
          messageId: "msg_approval",
          createdAt: "2026-06-02T08:51:35.000Z",
          payload: {
            messageId: "msg_approval",
            toolCallId: "call_approval",
            name: "linear__save_comment",
            providerKey: "linear",
            permissionGroup: "post",
            inputPreview: '{\n  "issueId": "OC-184"\n}',
            requestedAt: "2026-06-02T08:51:35.000Z",
          },
        },
      ],
      runnerUrl: null,
    });

    renderSessionViewContent(detail);

    expect(screen.getByText("Waiting for your approval.")).toBeInTheDocument();
    expect(screen.getByText("Paused: waiting for your approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(screen.queryByText("Stopped before finishing.")).not.toBeInTheDocument();
  });

  it("keeps a disabled resolving state after the user denies", async () => {
    vi.useRealTimers();
    actionMocks.resolveToolApproval.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const detail = makeDetail({
      session: makeSession({ id: "sess_approval" }),
      messages: [makeRunningAssistantMessage({ id: "msg_approval", content: "" })],
      events: [
        {
          id: 1,
          type: "tool.approval_required",
          messageId: "msg_approval",
          createdAt: "2026-06-02T08:51:35.162Z",
          payload: {
            messageId: "msg_approval",
            toolCallId: "call_approval",
            name: "linear__save_comment",
            providerKey: "linear",
            permissionGroup: "post",
            inputPreview: '{\n  "issueId": "OC-222"\n}',
            requestedAt: "2026-06-02T08:51:35.162Z",
          },
        },
      ],
      runnerUrl: null,
    });

    renderSessionViewContent(detail);
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(actionMocks.resolveToolApproval).toHaveBeenCalledWith({
      sessionId: "sess_approval",
      toolCallId: "call_approval",
      decision: "denied",
    });
    expect(screen.getByText("Denying...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("renders a timeout-resolved approval as timed out instead of running", () => {
    const message = makeMessage({ status: "running" });
    const parts = [
      makeApprovalToolCallPart({
        status: "denied",
        providerKey: "linear",
        permissionGroup: "post",
        requestedAt: "2026-06-02T08:51:35.162Z",
        decisionSource: "timeout",
      }),
    ];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("timed out")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
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
      sandboxCostUsdMicros: 0,
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

describe("SessionViewContent — ask tool questions", () => {
  it("turns the selected Other option into the custom answer input", async () => {
    const user = userEvent.setup();
    vi.mocked(submitAgentSessionQuestionResponse).mockResolvedValue({ ok: true });
    const detail = makeDetail({
      session: makeSession({ id: "sess_question", status: "awaiting_input" }),
      messages: [
        {
          id: "msg_question",
          role: "assistant",
          content: "",
          status: "completed",
          modelMessage: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_question",
                toolName: "ask_user_question",
                input: { questions: [] },
              },
            ],
          },
        },
      ],
      events: [
        {
          id: 1,
          type: "question.requested",
          messageId: "msg_question",
          createdAt: "2026-06-02T08:51:35.162Z",
          payload: {
            messageId: "msg_question",
            toolCallId: "call_question",
            questions: [
              {
                header: "Env",
                question: "Which environment?",
                options: [{ label: "Production" }, { label: "Staging" }],
                allowMultiple: false,
                allowOther: true,
              },
            ],
            requestedAt: "2026-06-02T08:51:35.162Z",
          },
        },
      ],
    });

    renderSessionViewContent(detail);

    const otherOption = screen.getByRole("radio", { name: "Other answer" });
    await user.click(otherOption);

    const otherInput = screen.getByRole("textbox", { name: "Other answer text" });
    expect(otherOption).toContainElement(otherInput);

    await user.type(otherInput, "Canary");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(submitAgentSessionQuestionResponse).toHaveBeenCalledWith({
        sessionId: "sess_question",
        toolCallId: "call_question",
        answers: [{ selectedLabels: [], otherText: "Canary" }],
      }),
    );
  });
});

describe("SessionViewContent — active turn timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setVisibility("visible");
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

describe("SessionViewContent — Phase C: no composer connection banner", () => {
  it("does NOT render a composer banner when stream is stale with a running message", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "stale");

    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("surfaces a stale stream in the inspector Runtime section instead", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "stale");

    expect(screen.getByText(INSPECTOR_STALE_TEXT)).toBeInTheDocument();
  });

  it("does NOT render a composer banner when stream is healthy (open)", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "open");

    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(INSPECTOR_STALE_TEXT)).not.toBeInTheDocument();
  });

  it("does NOT render a composer banner when stream is idle", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "idle");

    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(INSPECTOR_STALE_TEXT)).not.toBeInTheDocument();
  });

  it("does NOT render a composer banner when stream is errored (error has its own UX)", () => {
    const detail = makeDetail({ messages: [makeRunningAssistantMessage()] });
    renderSessionViewContent(detail, "error");

    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(INSPECTOR_STALE_TEXT)).not.toBeInTheDocument();
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
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("does NOT show banner when stream is open and a recent event landed (< STALE_THRESHOLD_MS ago)", () => {
    // Set the fake clock so "now" is 2000-01-01T00:00:30Z.
    // updatedAt is set to 5s before now — within the 45s threshold from the last event.
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

    // Still within threshold (5s + 1s = 6s < 45s) — nothing stale anywhere.
    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(INSPECTOR_STALE_TEXT)).not.toBeInTheDocument();
  });

  it("flags the inspector (not a composer banner) when stream is open but no event for > STALE_THRESHOLD_MS", () => {
    // Set the fake clock so "now" is 2000-01-01T00:01:00Z.
    const now = new Date("2000-01-01T00:01:00.000Z").getTime();
    vi.setSystemTime(now);

    // updatedAt is 50s in the past — stale by the time the first tick fires.
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

    // 50s + 1s tick = 51s > 45s threshold: inspector reflects it, composer stays clean.
    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(INSPECTOR_STALE_TEXT)).toBeInTheDocument();
  });

  it("refetches session detail automatically when active work has stale data", () => {
    const now = new Date("2000-01-01T00:01:30.000Z").getTime();
    vi.setSystemTime(now);

    const staleUpdatedAt = new Date(now - 50_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: staleUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["session-detail"]) }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });

  it("clears the inspector stale flag once a new event arrives after being shown", () => {
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

    // Trigger tick → inspector flags stale (no composer banner).
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(INSPECTOR_STALE_TEXT)).toBeInTheDocument();

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

    // Inspector flag should clear — event just landed (and never a composer banner).
    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(INSPECTOR_STALE_TEXT)).not.toBeInTheDocument();
  });

  it("still flags the inspector when stream.status is stale (regression of original Phase C behaviour)", () => {
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

    // Inspector reflects it immediately (stream.status === "stale") without a tick,
    // and the composer never shows a banner.
    expect(screen.queryByText(STALE_BANNER_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(INSPECTOR_STALE_TEXT)).toBeInTheDocument();
  });

  it("refetches session detail and stream credential when stream status is stale", () => {
    const now = new Date("2000-01-01T00:03:30.000Z").getTime();
    vi.setSystemTime(now);

    const recentUpdatedAt = new Date(now - 1_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: recentUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(100)],
    });

    streamMock.status = "stale";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["session-detail"]) }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });

  it("refreshes stream credential when stream becomes stale during the recovery throttle window", () => {
    const now = new Date("2000-01-01T00:03:45.000Z").getTime();
    vi.setSystemTime(now);

    const staleUpdatedAt = new Date(now - 50_000).toISOString();
    const detail = makeDetail({
      session: makeSession({ updatedAt: staleUpdatedAt }),
      messages: [makeRunningAssistantMessage()],
      events: [],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["session-detail"]) }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );

    invalidateSpy.mockClear();
    streamMock.status = "stale";

    act(() => {
      rerender(
        <QueryClientProvider client={queryClient}>
          <SessionViewContent detail={detail} workspaceId="wks_test" />
        </QueryClientProvider>,
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });

  it("refreshes the stream credential before an active session token expires", () => {
    const now = new Date("2000-01-01T00:03:50.000Z").getTime();
    vi.setSystemTime(now);

    const detail = makeDetail({
      session: makeSession({ updatedAt: new Date(now - 1_000).toISOString() }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(101)],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const streamCredentialKey = ["stream-credential", "wks_test", detail.session.id];
    queryClient.setQueryData(streamCredentialKey, {
      runnerUrl: "https://runner.example.com",
      streamToken: "token_123",
      streamTokenExpiresAt: now + 5 * 60 * 1000 + 1_000,
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(999);
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: streamCredentialKey }),
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: streamCredentialKey }),
    );
  });

  it("refreshes the stream credential before a paused (awaiting_approval) session token expires", () => {
    // Regression: a durably paused run keeps its SSE stream open, so its token must keep
    // refreshing even though the assistant is not actively working (awaitingAssistantWork
    // is false while `awaiting_approval`). Without this the token silently expires and
    // reconnects retry expired URLs.
    const now = new Date("2000-01-01T00:03:50.000Z").getTime();
    vi.setSystemTime(now);

    const detail = makeDetail({
      session: makeSession({
        status: "awaiting_approval",
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
      messages: [makeRunningAssistantMessage({ status: "completed" })],
      events: [makeEventFixture(101)],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const streamCredentialKey = ["stream-credential", "wks_test", detail.session.id];
    queryClient.setQueryData(streamCredentialKey, {
      runnerUrl: "https://runner.example.com",
      streamToken: "token_123",
      streamTokenExpiresAt: now + 5 * 60 * 1000 + 1_000,
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(999);
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: streamCredentialKey }),
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: streamCredentialKey }),
    );
  });

  it("refetches session detail when an active session returns to the foreground", () => {
    const now = new Date("2000-01-01T00:04:00.000Z").getTime();
    vi.setSystemTime(now);
    setVisibility("hidden");

    const detail = makeDetail({
      session: makeSession({ updatedAt: new Date(now - 5_000).toISOString() }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(101)],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["session-detail"]) }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });

  it("refetches session detail when an active session comes back online", () => {
    const now = new Date("2000-01-01T00:04:30.000Z").getTime();
    vi.setSystemTime(now);

    const detail = makeDetail({
      session: makeSession({ updatedAt: new Date(now - 5_000).toISOString() }),
      messages: [makeRunningAssistantMessage()],
      events: [makeEventFixture(102)],
    });

    streamMock.status = "open";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["session-detail"]) }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["stream-credential"]) }),
    );
  });
});

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

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

    // The snap effect ran: a scrollTo was issued toward the TOP (drift brings the
    // message up to the padding offset, so top is small/≤ 0), NOT a streaming
    // bottom-follow (which targets scrollHeight ≥ clientHeight 800).
    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalled();
    });
    const snapCall = scrollToSpy.mock.calls.at(-1)?.[0];
    expect(snapCall?.top ?? 0).toBeLessThan(800);

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

    // The bottom-follow must NOT fire after the one-shot snap (the snap sets
    // isPinnedAtBottom=false). No scroll-to-bottom should override the snap.
    await waitFor(() => {
      // A bottom-follow scrolls toward scrollHeight (≥ clientHeight 800).
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

  it("does not re-scroll on later streaming renders — the snap is one-shot, not a per-frame re-pin (no jitter)", async () => {
    const { rerender, queryClient, streamingDetail } = await sendAndSnap();

    // The one-shot snap already ran (sendAndSnap awaited and cleared the spy). The whole
    // point of the new design: the message is held at the top by CSS (min-height on the
    // last turn) + native scroll anchoring, NOT by a JS loop that re-pins every frame.
    // So further streamed renders must issue NO additional programmatic scroll — that
    // per-frame correction was the source of the visible jitter.
    scrollToSpy.mockClear();
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });

  it("engages the streaming follow when the user is scrolled to the bottom", async () => {
    const { rerender, queryClient, scroller, streamingDetail } = await sendAndSnap();

    // A genuine user gesture (wheel) flags the scroll as user-driven, and it lands within
    // the bottom threshold → the streaming follow keeps the latest content in view.
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
      // A bottom-follow scrolls toward scrollHeight (≥ clientHeight 800).
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
    // leaves isPinnedAtBottom false, so the streaming follow does NOT yank the message
    // back to the bottom on the next streamed render.
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

    // The bottom-follow must not scroll — the user's just-chosen position is untouched.
    await waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });

  // A layout-driven scroll (reflow / overflow-anchor adjustment) fires a bare `scroll`
  // with NO wheel/touch gesture, and with the reserved min-height it can land within the
  // bottom threshold. It must NOT be mistaken for the user reaching the bottom — otherwise
  // the streaming follow engages and yanks the just-snapped message away. (A real scrollbar
  // drag / keyboard scroll without wheel is the same, accepted, minor edge.)
  it("ignores a non-user (layout-driven) scroll near the bottom — does not engage the follow", async () => {
    const { rerender, queryClient, scroller, streamingDetail } = await sendAndSnap();

    // Bare scroll, no wheel/touch → not flagged as user intent. Default scrollHeight 860
    // gives distanceFromBottom = 60 ≤ threshold, so it WOULD pin if wrongly treated as user.
    if (scroller) {
      fireEvent.scroll(scroller);
    }
    scrollToSpy.mockClear();
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={streamingDetail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });
});
