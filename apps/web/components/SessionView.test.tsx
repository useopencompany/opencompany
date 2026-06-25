/**
 * Tests for SessionView rendering: AssistantMessageContent live-part rendering
 * (tool calls + reasoning show immediately while a message is running, with the
 * WorkingIndicator footer), tool approvals/questions, the active-turn timer, and
 * the snap-to-top-on-send scroll behaviour. The transcript is materialized from
 * the Durable Stream (`useSessionStream`, mocked); the full-component tests drive
 * the transcript via the `detail` fallback.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSkillCatalogEntry } from "@/components/agent-editor/tools";
import {
  type PersonalAgentContextValue,
  PersonalAgentProvider,
} from "@/components/personal/PersonalAgentContext";
import {
  continueInterruptedSession,
  createAgentSession,
  submitAgentSessionMessage,
  submitAgentSessionQuestionResponse,
} from "@/lib/agent-sessions/actions";
import { type AgentSessionDetailPayload, seedSessionQueries } from "@/lib/agent-sessions/payload";
import { TOOL_STEP_LIMIT_EXCEEDED_MESSAGE } from "@/lib/agent-sessions/resumable";
import type {
  AssistantTurnPart,
  RuntimeToolCall,
  SessionMessage,
  SessionRuntimeState,
} from "@/lib/agent-sessions/runtime-events";
import type { SessionStreamStatus } from "@/lib/agent-sessions/session-stream";
import { AssistantMessageContent, pastedTextFile, SessionViewContent } from "./SessionView";

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

// Mutable so surface-aware tests can render under /personal/... vs /company/... pages.
const navigationMock = vi.hoisted(() => ({ pathname: "/" }));
const routerMock = vi.hoisted(() => ({
  prefetch: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => navigationMock.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ workspaceId: "wks_test" }),
}));

// useLiveQuery + the workspace collections are only read by the default SessionView
// export (these tests render SessionViewContent directly). Stub both so importing
// SessionView does not pull CollectionsProvider's server-action import chain into the
// test — mirrors Sidebar.test.
vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/components/CollectionsProvider", () => ({
  useCollections: () => ({ agentSessions: {}, agents: {} }),
}));

const toastMock = vi.hoisted(() => ({
  showError: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("@/components/ToastProvider", () => ({
  useToast: () => toastMock,
}));

vi.mock("@opencompany/analytics/client", () => ({
  captureEvent: vi.fn(),
}));

// The transcript is materialized from the Durable Stream via useSessionStream. The
// full-component tests pass `detail` (used as the pre-catch-up fallback), so the
// mock returns an empty stream state + a controllable status per test.
const streamMock = vi.hoisted(() => ({
  status: "live" as SessionStreamStatus,
  state: {
    events: [],
    messages: [],
    usage: {},
    toolUsage: {},
    cost: {},
    currentStatus: "",
    lastError: null,
  } as unknown as SessionRuntimeState,
  // Last `options` argument seen by useSessionStream — lets a test assert which
  // seedFromEnd value SessionView derived from the snapshot status (regression
  // surface for the #306 startup-race fix).
  lastOptions: undefined as { seedFromEnd?: boolean } | undefined,
}));
vi.mock("@/components/useSessionStream", () => ({
  useSessionStream: (_sessionId: string, options?: { seedFromEnd?: boolean }) => {
    streamMock.lastOptions = options;
    return {
      state: streamMock.state,
      status: streamMock.status,
    };
  },
}));

const actionMocks = vi.hoisted(() => ({
  abortAgentSession: vi.fn(),
  cancelAgentSessionQuestion: vi.fn(),
  continueInterruptedSession: vi.fn(),
  createAgentSession: vi.fn(),
  createAgentSessionFromPrompt: vi.fn(),
  resolveToolApproval: vi.fn(),
  submitAgentSessionMessage: vi.fn(),
  submitAgentSessionQuestionResponse: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  abortAgentSession: actionMocks.abortAgentSession,
  cancelAgentSessionQuestion: actionMocks.cancelAgentSessionQuestion,
  continueInterruptedSession: actionMocks.continueInterruptedSession,
  createAgentSession: actionMocks.createAgentSession,
  createAgentSessionFromPrompt: actionMocks.createAgentSessionFromPrompt,
  markSessionSeen: vi.fn(),
  resolveToolApproval: actionMocks.resolveToolApproval,
  submitAgentSessionMessage: actionMocks.submitAgentSessionMessage,
  submitAgentSessionQuestionResponse: actionMocks.submitAgentSessionQuestionResponse,
}));

const payloadMocks = vi.hoisted(() => ({
  seedSessionQueries: vi.fn(),
}));
vi.mock("@/lib/agent-sessions/payload", () => ({
  fetchAgentSession: vi.fn(async () => null),
  seedSessionQueries: payloadMocks.seedSessionQueries,
  sessionQueryKeys: {
    detail: (workspaceId: string, id: string) => ["session-detail", workspaceId, id],
  },
  SESSIONS_QUERY_STALE_TIME_MS: 30_000,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock;
Element.prototype.scrollIntoView ??= vi.fn();

afterEach(() => {
  actionMocks.cancelAgentSessionQuestion.mockReset();
  actionMocks.continueInterruptedSession.mockReset();
  actionMocks.createAgentSession.mockReset();
  actionMocks.createAgentSessionFromPrompt.mockReset();
  actionMocks.resolveToolApproval.mockReset();
  actionMocks.submitAgentSessionQuestionResponse.mockReset();
  actionMocks.submitAgentSessionMessage.mockReset();
  payloadMocks.seedSessionQueries.mockReset();
  routerMock.prefetch.mockReset();
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  toastMock.showError.mockReset();
  toastMock.showToast.mockReset();
  streamMock.status = "live";
  streamMock.state = emptyStreamState();
  streamMock.lastOptions = undefined;
  navigationMock.pathname = "/";
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

  it("does not keep showing the approval prompt after the approval is decided", () => {
    const message = makeMessage({ status: "running" });
    const parts = [
      makeApprovalToolCallPart({
        status: "approved",
        providerKey: "linear",
        permissionGroup: "post",
        requestedAt: "2026-06-02T08:51:35.162Z",
        decisionSource: "user",
      }),
    ];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your approval.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("keeps an approved running tool visible when the suspended assistant message is completed", () => {
    const message = makeMessage({ status: "completed" });
    const parts = [
      makeApprovalToolCallPart({
        status: "approved",
        providerKey: "linear",
        permissionGroup: "post",
        requestedAt: "2026-06-02T08:51:35.162Z",
        decisionSource: "user",
      }),
    ];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.getByText("Saving Linear comment")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.queryByText("1 step")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for your approval.")).not.toBeInTheDocument();
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

  it("shows the session error detail when a stopped assistant turn failed in the runner", () => {
    const message = makeMessage({ status: "running" });
    render(
      <AssistantMessageContent
        message={message}
        parts={[]}
        sessionCanGenerate={false}
        stoppedError="Missing required parameter: 'input[5].arguments'."
      />,
    );

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
    expect(screen.getByText(/Missing required parameter/)).toBeInTheDocument();
  });

  it("shows AssistantStoppedNotice when message is running but session cannot generate (has parts)", () => {
    const message = makeMessage({ status: "running" });
    const parts = [makeToolCallPart("running")];
    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={false} />);

    expect(screen.getByText("Stopped before finishing")).toBeInTheDocument();
    // WorkingIndicator should NOT be shown — session cannot generate
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("marks still-running tools as interrupted for an interrupted session", async () => {
    const user = userEvent.setup();
    const message = makeMessage({ status: "running" });
    const parts = [makeToolCallPart("running")];
    render(
      <AssistantMessageContent
        message={message}
        parts={parts}
        sessionCanGenerate={false}
        sessionIsInterrupted
      />,
    );

    expect(screen.getByText("interrupted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /search files/i }));
    expect(screen.getByText("Interrupted before this tool returned a result.")).toBeInTheDocument();
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
    engine: "opencompany",
    modelProvider: "anthropic",
    modelName: "claude-3-5-sonnet",
    codexReasoningEffort: "medium",
    codexPlanModeEnabled: false,
    codexPlanModeReasoningEffort: "high",
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
    currentContextTokens: 0,
    latestEventId: 0,
    ...overrides,
  };
}

function makeCreateSessionResult(sessionId: string) {
  const detail = makeDetail({
    session: makeSession({ id: sessionId, title: "New session", status: "created" }),
  });
  return {
    result: {
      ok: true,
      session: { id: sessionId },
      detail,
    } as Awaited<ReturnType<typeof createAgentSession>>,
    detail,
  };
}

function emptyStreamState(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return {
    events: [],
    messages: [],
    usage: makeDetail().usage,
    toolUsage: makeDetail().toolUsage,
    cost: makeDetail().cost,
    currentStatus: "",
    lastError: null,
    statusObserved: false,
    ...overrides,
  };
}

function makePersonalAgentContext(
  overrides: Partial<PersonalAgentContextValue> = {},
): PersonalAgentContextValue {
  const config: PersonalAgentContextValue["config"] = {
    schemaVersion: "agent.v1",
    engine: "opencompany",
    title: "Personal Agent",
    instructions: "Help me.",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    skills: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  };

  return {
    agent: {
      id: "agent_001",
      name: "Personal Agent",
      defaultModel: "openai/gpt-5.4-mini",
      path: "agents/personal",
      config,
      body: "Help me.",
      content: { type: "doc" },
    },
    bundleDir: "agents/personal",
    userName: "Test User",
    userEmail: "test@example.com",
    userTimezone: "UTC",
    userTimezoneSource: "manual",
    workspaceName: "Test Workspace",
    initialSessions: [],
    personalSkills: [],
    githubIntegrationStatus: "not_connected",
    githubRepositories: [],
    integrationConnections: {
      github: false,
      gmail: false,
      google_calendar: false,
      google_drive: false,
      linear: false,
      slack: false,
      posthog: false,
      betterstack: false,
      braintrust: false,
      notion: false,
    },
    integrationDetails: {},
    toolPolicies: {},
    config,
    setConfig: vi.fn(),
    githubRequested: false,
    proMode: false,
    setProMode: vi.fn(),
    companySurfaceEnabled: false,
    setCompanySurfaceEnabled: vi.fn(),
    setUserTimezone: vi.fn(),
    setUserTimezoneSource: vi.fn(),
    getDraft: () => ({ body: "Help me.", content: { type: "doc" } }),
    setDraft: vi.fn(),
    files: [],
    upsertFile: vi.fn(),
    addIntegration: vi.fn(async () => true),
    addTool: vi.fn(async () => undefined),
    addSkill: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderSessionViewContent(
  detail: AgentSessionDetailPayload,
  streamStatus: SessionStreamStatus = "live",
  options: {
    personalAgent?: PersonalAgentContextValue;
    workspaceSkills?: AgentSkillCatalogEntry[];
    // Snapshot fetch time (react-query dataUpdatedAt) for the stream-staleness
    // authority rule. Omitted (0) = "snapshot age unknown" → stream stays
    // authoritative, matching the pre-staleness behavior most tests assume.
    detailUpdatedAt?: number;
  } = {},
) {
  streamMock.status = streamStatus;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["workspace-skills", "wks_test"], options.workspaceSkills ?? []);
  const content = (
    <SessionViewContent
      detail={detail}
      workspaceId="wks_test"
      {...(options.detailUpdatedAt !== undefined
        ? { detailUpdatedAt: options.detailUpdatedAt }
        : {})}
    />
  );
  return render(
    <QueryClientProvider client={queryClient}>
      {options.personalAgent ? (
        <PersonalAgentProvider value={options.personalAgent}>{content}</PersonalAgentProvider>
      ) : (
        content
      )}
    </QueryClientProvider>,
  );
}

function setComposerValue(value: string) {
  const composer = screen.getByPlaceholderText("Ask this agent to do something");
  fireEvent.change(composer, {
    target: { value, selectionStart: value.length },
  });
  composer.focus();
}

describe("SessionViewContent — stream-sourced pending turn", () => {
  it("shows waiting state, not the previous terminal error, after a new user message starts a turn", () => {
    const detail = makeDetail({
      session: makeSession({
        id: "sess_retry",
        status: "failed",
        lastError: "Gateway down",
      }),
      messages: [
        {
          id: "msg_old_user",
          role: "user",
          content: "First try",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
      ],
    });

    streamMock.state = emptyStreamState({
      events: [
        {
          id: 1,
          type: "message.created",
          messageId: "msg_new_user",
          createdAt: "2026-06-04T10:01:00.000Z",
          payload: {
            messageId: "msg_new_user",
            role: "user",
            content: "Try again",
            status: "completed",
          },
        },
      ],
      messages: [
        {
          id: "msg_old_user",
          role: "user",
          content: "First try",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
        {
          id: "msg_new_user",
          role: "user",
          content: "Try again",
          status: "completed",
          createdAt: "2026-06-04T10:01:00.000Z",
        },
      ],
      currentStatus: "running",
      lastError: null,
      // The stream reduced a non-internal user message.created — a status-bearing
      // event — so its scalar status/error are authoritative over the snapshot.
      statusObserved: true,
    });

    renderSessionViewContent(detail);

    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("Stopped before finishing")).not.toBeInTheDocument();
    expect(screen.queryByText("Gateway down")).not.toBeInTheDocument();
  });

  it("keeps the snapshot's status/error while the stream has only emitted non-status events", () => {
    // Reopening a session whose snapshot carries an error: the stream connects and
    // delivers a stray non-status event (e.g. a late usage delta) but has not yet
    // observed any session.status/error — statusObserved stays false. The snapshot
    // must remain authoritative so the error does not flicker away and back.
    const detail = makeDetail({
      session: makeSession({ id: "sess_err", status: "failed", lastError: "Gateway down" }),
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Do the thing",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
      ],
    });

    streamMock.state = emptyStreamState({
      events: [{ id: 1, type: "session.usage", messageId: null, payload: {} }],
      // statusObserved defaults to false: a usage delta is not status-bearing.
    });

    renderSessionViewContent(detail);

    // Rendered in both the inline transcript banner and the inspector runtime panel.
    expect(screen.getAllByText("Gateway down").length).toBeGreaterThan(0);
  });

  it("renders recoverable failed tools without a session-level stopped notice", async () => {
    const user = userEvent.setup();
    const detail = makeDetail({
      session: makeSession({ id: "sess_tool_failure", status: "completed", lastError: null }),
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Read a file",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
        {
          id: "msg_assistant",
          role: "assistant",
          content: "",
          status: "completed",
          responseToMessageId: "msg_user",
          createdAt: "2026-06-04T10:00:01.000Z",
          completedAt: "2026-06-04T10:00:02.000Z",
          modelMessage: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_read",
                toolName: "read_file",
                input: { path: "../secret.txt" },
              },
            ],
          },
        },
      ],
      events: [
        {
          id: 1,
          type: "tool.failed",
          messageId: "msg_assistant",
          createdAt: "2026-06-04T10:00:02.000Z",
          payload: {
            messageId: "msg_assistant",
            toolCallId: "call_read",
            name: "read_file",
            error: {
              message: "Path must be inside work/ or brain/ for this session.",
              code: "invalid_sandbox_path",
              recoverable: true,
            },
            outputPreview:
              '{\n  "ok": false,\n  "error": {\n    "code": "invalid_sandbox_path"\n  }\n}',
          },
        },
      ],
    });

    renderSessionViewContent(detail);

    expect(screen.queryByText("Stopped before finishing")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /1 step/ }));
    expect(screen.getByText("failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Reading \.\./ }));
    expect(screen.getByText(/invalid_sandbox_path/)).toBeInTheDocument();
  });
});

// Regression for #306. On the first page load of a newly-started session, the
// snapshot status is a startup value (`created`/`provisioning`/`ready`) while the
// runner is starting up. The pre-fix predicate `!ACTIVE_STREAMING_STATUSES.has(...)`
// returned `true` for those, so the stream tailed from HEAD — and if the runner had
// already emitted `message.created(assistant)` by then, the overlay missed it and
// the assistant message could never reach `completed`. When status later flipped to
// `awaiting_approval`, the UI rendered "Stopped before finishing" until refresh.
describe("SessionViewContent — #306: startup-status snapshot must not seedFromEnd", () => {
  it.each([
    "created",
    "provisioning",
    "ready",
    "running",
    "aborting",
  ])("passes seedFromEnd=false to useSessionStream for snapshot status %s", (status) => {
    const detail = makeDetail({ session: makeSession({ id: "sess_startup", status }) });
    renderSessionViewContent(detail);
    expect(streamMock.lastOptions?.seedFromEnd).toBe(false);
  });

  it.each([
    "completed",
    "failed",
    "aborted",
    "archived",
    "awaiting_approval",
    "awaiting_input",
  ])("passes seedFromEnd=true to useSessionStream for settled/paused status %s", (status) => {
    const detail = makeDetail({ session: makeSession({ id: "sess_settled", status }) });
    renderSessionViewContent(detail);
    expect(streamMock.lastOptions?.seedFromEnd).toBe(true);
  });

  it("does not flash 'Stopped before finishing' when the overlay carries the full assistant turn", () => {
    // Post-fix runtime: snapshot is `ready` (the page loaded mid-startup) and only
    // has the user message, but the stream replayed from "-1" so the overlay holds
    // the complete assistant turn (created → deltas → completed) plus the
    // `awaiting_approval` status flip. The merge must yield a completed assistant
    // message and suppress the stopped-after-user notice.
    const detail = makeDetail({
      session: makeSession({ id: "sess_new", status: "ready" }),
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "do the thing",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
      ],
    });

    streamMock.state = emptyStreamState({
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "do the thing",
          status: "completed",
          createdAt: "2026-06-04T10:00:00.000Z",
        },
        makeRunningAssistantMessage({
          id: "msg_assistant",
          content: "Here's what I'll do.",
          status: "completed",
          createdAt: "2026-06-04T10:00:01.000Z",
          completedAt: "2026-06-04T10:00:05.000Z",
        }),
      ],
      currentStatus: "awaiting_approval",
      statusObserved: true,
    });

    renderSessionViewContent(detail);

    expect(screen.queryByText("Stopped before finishing")).not.toBeInTheDocument();
    expect(screen.getByText("Here's what I'll do.")).toBeInTheDocument();
  });
});

// A Durable Stream subscription can die while the tab is hidden (the client's
// pause/resume race, an exhausted retry budget) and freeze on its last observed
// state — typically "running" mid-turn. On return, the focus refetch brings the
// finished turn in the snapshot; the merge must let that strictly-fresher snapshot
// beat the dead overlay (scalars AND message copies) instead of showing the frozen
// thinking spinner forever. A LIVE stream that is merely behind on durable ids
// (web appends ride with id null) must keep authority, or the just-sent-message
// flow would regress to "Stopped before finishing".
describe("SessionViewContent — dead-stream overlay vs fresher snapshot", () => {
  const userMessage = {
    id: "msg_user",
    role: "user",
    content: "run the report",
    status: "completed",
    createdAt: "2026-06-04T10:00:00.000Z",
  };

  function fresherCompletedDetail() {
    return makeDetail({
      session: makeSession({ id: "sess_frozen", status: "completed", lastError: null }),
      messages: [
        userMessage,
        {
          id: "msg_assistant",
          role: "assistant",
          content: "All done — here is the report.",
          status: "completed",
          createdAt: "2026-06-04T10:00:01.000Z",
          completedAt: "2026-06-04T10:01:30.000Z",
        },
      ],
      // The snapshot has seen durable events beyond the overlay's high-water (5).
      latestEventId: 9,
    });
  }

  function frozenRunningOverlay(lastEventReceivedAt: number) {
    return emptyStreamState({
      events: [
        {
          id: 5,
          type: "message.created",
          messageId: "msg_assistant",
          createdAt: "2026-06-04T10:00:01.000Z",
          payload: { messageId: "msg_assistant", role: "assistant", status: "running" },
        },
      ],
      messages: [
        userMessage,
        makeRunningAssistantMessage({
          id: "msg_assistant",
          content: "Working on it",
          status: "running",
          createdAt: "2026-06-04T10:00:01.000Z",
        }),
      ],
      currentStatus: "running",
      statusObserved: true,
      lastEventReceivedAt,
    });
  }

  it("renders the snapshot's finished turn when the overlay is dead (behind AND silent since the fetch)", () => {
    // Overlay last delivered at t=1000; snapshot fetched at t=2000 with newer events.
    streamMock.state = frozenRunningOverlay(1_000);
    renderSessionViewContent(fresherCompletedDetail(), "error", { detailUpdatedAt: 2_000 });

    // The final assistant content (snapshot copy) wins over the frozen partial.
    expect(screen.getByText("All done — here is the report.")).toBeInTheDocument();
    expect(screen.queryByText("Working on it")).not.toBeInTheDocument();
    // No thinking spinner, no misread stop notice.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Stopped before finishing")).not.toBeInTheDocument();
  });

  it("keeps a live-but-id-behind overlay authoritative (delivered since the snapshot fetch)", () => {
    // Same id gap, but the overlay delivered AFTER the snapshot was fetched — it is
    // live (e.g. the id-null web append path), so its running state must win.
    streamMock.state = frozenRunningOverlay(3_000);
    renderSessionViewContent(fresherCompletedDetail(), "live", { detailUpdatedAt: 2_000 });

    expect(screen.getByText("Working on it")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps stream authority when the snapshot fetch time is unknown (default prop)", () => {
    // Without detailUpdatedAt the staleness clause must never fire — pre-existing
    // behavior for callers that do not thread the fetch time through.
    streamMock.state = frozenRunningOverlay(0);
    renderSessionViewContent(fresherCompletedDetail(), "live");

    expect(screen.getByText("Working on it")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("SessionViewContent — user message attachments", () => {
  it("renders an <img> and a pdf chip for a user message's attachments", () => {
    const detail = makeDetail({
      messages: [
        {
          id: "msg_with_attachments",
          role: "user",
          content: "Have a look at these",
          status: "completed",
          createdAt: "2026-06-05T10:00:00.000Z",
          attachments: [
            {
              id: "att_img",
              kind: "image",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            {
              id: "att_pdf",
              kind: "pdf",
              mediaType: "application/pdf",
              filename: "report.pdf",
            },
          ],
        },
      ],
    });

    renderSessionViewContent(detail);

    // The text body still renders.
    expect(screen.getByText("Have a look at these")).toBeInTheDocument();

    // The image attachment renders an <img> served through the auth-scoped byte route.
    const image = screen.getByAltText("screenshot.png");
    expect(image).toHaveAttribute("src", "/api/attachments/att_img");

    // The pdf attachment renders a chip/link with the filename, also through the route.
    const pdfLink = screen.getByText("report.pdf").closest("a");
    expect(pdfLink).toHaveAttribute("href", "/api/attachments/att_pdf");
  });

  it("prefers a local preview URL for an optimistic just-sent image (Bug 2)", () => {
    // An optimistic message carries a local object-URL preview so the image shows instantly,
    // before the `/api/attachments/{id}` row exists. The renderer must use that preview, not the
    // not-yet-valid served URL.
    const detail = makeDetail({
      messages: [
        {
          id: "msg_optimistic",
          role: "user",
          content: "Just sent this",
          status: "completed",
          createdAt: "2026-06-05T10:00:00.000Z",
          attachments: [
            {
              id: "att_local",
              kind: "image",
              mediaType: "image/png",
              filename: "fresh.png",
              previewUrl: "blob:fake-preview-url",
            },
          ],
        },
      ],
    });

    renderSessionViewContent(detail);

    const image = screen.getByAltText("fresh.png");
    expect(image).toHaveAttribute("src", "blob:fake-preview-url");
    // The open-in-new-tab link also points at the preview while optimistic.
    expect(image.closest("a")).toHaveAttribute("href", "blob:fake-preview-url");
  });
});

describe("SessionViewContent — optimistic send", () => {
  it("clears the composer and paints the user message immediately on Enter", async () => {
    const user = userEvent.setup();
    let resolveSubmit!: (value: Awaited<ReturnType<typeof submitAgentSessionMessage>>) => void;
    const submitPromise = new Promise<Awaited<ReturnType<typeof submitAgentSessionMessage>>>(
      (resolve) => {
        resolveSubmit = resolve;
      },
    );
    vi.mocked(submitAgentSessionMessage).mockReturnValue(submitPromise);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "ready" }) }));

    const composer = screen.getByPlaceholderText("Ask this agent to do something");
    await user.type(composer, "Fast replay");
    await user.keyboard("{Enter}");

    expect(submitAgentSessionMessage).toHaveBeenCalledWith("sess_001", "Fast replay", [], "steer");
    expect(composer).toHaveValue("");
    expect(screen.getByText("Fast replay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();

    await act(async () => {
      resolveSubmit({ ok: true, messageId: "msg_real" });
      await submitPromise;
    });
  });
});

describe("SessionViewContent — interrupted continue", () => {
  it("shows a compact Continue action only for interrupted sessions", () => {
    const { rerender } = renderSessionViewContent(
      makeDetail({ session: makeSession({ status: "interrupted" }) }),
    );

    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getAllByText("Interrupted").length).toBeGreaterThan(0);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent
          detail={makeDetail({ session: makeSession({ status: "completed" }) })}
          workspaceId="wks_test"
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("shows a compact Continue action for failed sessions that reached the tool-step limit", () => {
    renderSessionViewContent(
      makeDetail({
        session: makeSession({
          status: "failed",
          lastError: TOOL_STEP_LIMIT_EXCEEDED_MESSAGE,
        }),
      }),
    );

    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByText("Step limit reached")).toBeInTheDocument();
    expect(screen.queryByText(TOOL_STEP_LIMIT_EXCEEDED_MESSAGE)).not.toBeInTheDocument();
  });

  it("does not show Continue for ordinary failed sessions", () => {
    renderSessionViewContent(
      makeDetail({
        session: makeSession({
          status: "failed",
          lastError: "Gateway down",
        }),
      }),
    );

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Gateway down").length).toBeGreaterThan(0);
  });

  it("clicking Continue inserts an optimistic message and dispatches the action", async () => {
    const user = userEvent.setup();
    let resolveContinue!: (value: Awaited<ReturnType<typeof continueInterruptedSession>>) => void;
    const continuePromise = new Promise<Awaited<ReturnType<typeof continueInterruptedSession>>>(
      (resolve) => {
        resolveContinue = resolve;
      },
    );
    vi.mocked(continueInterruptedSession).mockReturnValue(continuePromise);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "interrupted" }) }));

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(continueInterruptedSession).toHaveBeenCalledWith("sess_001");
    expect(screen.getAllByText("Continue").length).toBeGreaterThan(0);

    await act(async () => {
      resolveContinue({ ok: true, messageId: "msg_continue" });
      await continuePromise;
    });
  });
});

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

    renderSessionViewContent(detail, "live");

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

    renderSessionViewContent(detail, "live");

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

      renderSessionViewContent(detail, "live");

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

    streamMock.status = "live";
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
    streamMock.status = "live";
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

// ── PRO-173: reading-position safety net across a work-collapse ─────────────
//
// When the "work" block (reasoning / N-steps) collapses ABOVE the fold while the user is
// scrolled up reading, native overflow-anchor does not compensate and the answer lurches up.
// The safety-net layout effect anchors to the leaf at the viewport top (captured on a genuine
// scroll) and nudges scrollTop so that leaf — and the answer the user is reading — holds still.

describe("SessionViewContent — PRO-173: reading-position safety net across work-collapse", () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;
  let originalScrollTo: PropertyDescriptor | undefined;
  let originalRect: PropertyDescriptor | undefined;
  let originalEFP: PropertyDescriptor | undefined;
  // Per-element viewport top, so we can move the anchored leaf to simulate a collapse above it.
  const rectTop = new WeakMap<Element, number>();

  beforeEach(() => {
    scrollToSpy = vi.fn();
    originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    // Far from the bottom (distanceFromBottom = 1000 - 0 - 800 = 200 > 80) so a user scroll
    // leaves isPinnedAtBottom = false → reading mode.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        const top = rectTop.get(this) ?? 0; // container defaults to viewport top 0
        return {
          top,
          bottom: top + 20,
          left: 0,
          right: 800,
          width: 800,
          height: 20,
          x: 0,
          y: top,
          toJSON() {},
        } as DOMRect;
      },
    });
    originalEFP = Object.getOwnPropertyDescriptor(Document.prototype, "elementFromPoint");
  });

  afterEach(() => {
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    } else {
      // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
      delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    }
    if (originalRect) {
      Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", originalRect);
    }
    if (originalEFP) {
      Object.defineProperty(Document.prototype, "elementFromPoint", originalEFP);
    } else {
      // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
      delete (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { clientHeight?: unknown }).clientHeight;
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    // (rectTop is a WeakMap keyed by per-test DOM nodes — stale entries are GC'd, no clear needed)
    vi.clearAllMocks();
  });

  function renderScrolledUp() {
    const detail = makeDetail({
      messages: [
        { id: "msg_u", role: "user", content: "Question", status: "completed" },
        {
          id: "msg_a",
          role: "assistant",
          content: "A long completed answer with collapsible work above it.",
          status: "completed",
        },
      ],
    });
    streamMock.status = "live";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );
    const scroller = view.container.querySelector(".overflow-y-auto") as HTMLElement;
    const anchor = scroller.querySelector("[data-message-id]") as HTMLElement;
    // elementFromPoint resolves to the leaf at the viewport top → our anchor.
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => anchor,
    });
    return { view, queryClient, detail, scroller, anchor };
  }

  it("corrects scrollTop when work collapses above the reading position", async () => {
    const { view, queryClient, detail, scroller, anchor } = renderScrolledUp();
    // The user is reading: the anchored leaf sits 400px below the container's top edge.
    rectTop.set(anchor, 400);
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller); // onScroll: not pinned → captures the anchor at viewportTop 400
    scrollToSpy.mockClear();

    // Work above the fold collapses by 318px → the anchored leaf moves UP to 82.
    rectTop.set(anchor, 82);
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // The safety net pulls scrollTop back by the 318px drift (scrollTop 0 + (82 - 400)),
    // so the reading position is preserved.
    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: -318, behavior: "auto" }),
      );
    });
  });

  it("does not correct when the anchored leaf stays put (e.g. streaming appends below it)", async () => {
    const { view, queryClient, detail, scroller, anchor } = renderScrolledUp();
    rectTop.set(anchor, 400);
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    scrollToSpy.mockClear();

    // A later render where the anchored leaf does NOT move (content changed below it).
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });
});

// ── Tool-call elapsed counter ─────────────────────────────────────────────

describe("ToolCallCardDefault — elapsed counter for long-running tool calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRunningToolCallPartWithStartedAt(startedAt: string): AssistantTurnPart {
    return {
      type: "tool-call",
      toolCall: {
        id: "call_long",
        name: "search_files",
        status: "running",
        inputPreview: '{"pattern":"*.ts"}',
        activityPreview: "",
        outputPreview: "",
        startedEventId: 1,
        completedEventId: null,
        startedAt,
      },
    };
  }

  it("does NOT show the elapsed counter when the tool call has been running for less than 20s", () => {
    const now = new Date("2026-06-09T10:00:00.000Z");
    vi.setSystemTime(now);
    // Tool started 10s ago — under the 20s threshold
    const startedAt = new Date(now.getTime() - 10_000).toISOString();
    const message = makeMessage({ status: "running" });
    const parts = [makeRunningToolCallPartWithStartedAt(startedAt)];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // Running badge shows plain "running" without elapsed suffix
    expect(screen.getByText("running")).toBeInTheDocument();
    // No time text in the badge (no "10s" or "·")
    expect(screen.queryByText(/running · /)).not.toBeInTheDocument();
  });

  it("shows the elapsed counter once the tool call crosses 20s", () => {
    const now = new Date("2026-06-09T10:00:00.000Z");
    vi.setSystemTime(now);
    // Tool started 19s ago — just under threshold
    const startedAt = new Date(now.getTime() - 19_000).toISOString();
    const message = makeMessage({ status: "running" });
    const parts = [makeRunningToolCallPartWithStartedAt(startedAt)];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // Before threshold: no counter
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();

    // Advance 1s to hit 20s total
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // After threshold: counter appears
    expect(screen.getByText("20s")).toBeInTheDocument();
  });

  it("increments the elapsed counter every second after it appears", () => {
    const now = new Date("2026-06-09T10:00:00.000Z");
    vi.setSystemTime(now);
    // Tool started 20s ago — right at threshold
    const startedAt = new Date(now.getTime() - 20_000).toISOString();
    const message = makeMessage({ status: "running" });
    const parts = [makeRunningToolCallPartWithStartedAt(startedAt)];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    // At 20s the counter is shown
    expect(screen.getByText("20s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("21s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.getByText("30s")).toBeInTheDocument();
  });

  it("does NOT show the elapsed counter for a completed tool call", () => {
    const now = new Date("2026-06-09T10:00:00.000Z");
    vi.setSystemTime(now);
    const message = makeMessage({ status: "completed" });
    // Even with a startedAt 60s ago, completed calls must not show the counter
    const parts: AssistantTurnPart[] = [
      {
        type: "tool-call",
        toolCall: {
          id: "call_done",
          name: "search_files",
          status: "completed",
          inputPreview: '{"pattern":"*.ts"}',
          activityPreview: "",
          outputPreview: "3 files found",
          startedEventId: 1,
          completedEventId: 2,
          startedAt: new Date(now.getTime() - 60_000).toISOString(),
        },
      },
    ];

    render(<AssistantMessageContent message={message} parts={parts} sessionCanGenerate={true} />);

    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/60s/)).not.toBeInTheDocument();
    // The step summary is shown (collapsed), but no running/elapsed chrome
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });
});

// ── Surface-aware inspector links ────────────────────────────────────────────
// Session pages render under both /company and /personal; related-session and
// session-page links must stay within the surface the user is on.

function makeRelatedChild(
  overrides: Partial<AgentSessionDetailPayload["related"]["children"][number]> = {},
): AgentSessionDetailPayload["related"]["children"][number] {
  return {
    id: "sess_child",
    title: "Child session",
    status: "completed",
    source: "agent",
    agentName: "Test Agent",
    agentPath: null,
    parentMessageId: null,
    parentToolCallId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SessionViewContent — surface-aware inspector links", () => {
  it("keeps runtime details collapsed by default for past personal sessions", () => {
    navigationMock.pathname = "/personal/session/sess_001";
    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    expect(screen.getByRole("button", { name: "Expand runtime details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps runtime details collapsed by default for company sessions without related sessions", () => {
    navigationMock.pathname = "/company/session/sess_001";
    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    expect(screen.getByRole("button", { name: "Expand runtime details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps runtime details collapsed by default for company sessions with related sessions", () => {
    navigationMock.pathname = "/company/session/sess_child";
    renderSessionViewContent(
      makeDetail({
        session: makeSession({
          id: "sess_child",
          status: "completed",
          parentSessionId: "sess_001",
        }),
        related: { parent: makeRelatedChild({ id: "sess_001" }), children: [] },
      }),
    );

    expect(screen.getByRole("button", { name: "Expand runtime details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("does not expand runtime details when related sessions arrive after first paint", () => {
    navigationMock.pathname = "/company/session/sess_001";
    const { rerender } = renderSessionViewContent(
      makeDetail({ session: makeSession({ status: "running" }) }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent
          detail={makeDetail({
            session: makeSession({ status: "running" }),
            related: { parent: null, children: [makeRelatedChild()] },
          })}
          workspaceId="wks_test"
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Expand runtime details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("resets runtime details to collapsed when navigating to a different session", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/company/session/sess_001";
    const { rerender } = renderSessionViewContent(
      makeDetail({ session: makeSession({ id: "sess_001", status: "running" }) }),
    );

    await user.click(screen.getByRole("button", { name: "Expand runtime details" }));
    expect(
      screen.getByRole("button", { name: "Collapse runtime details", expanded: true }),
    ).toHaveAttribute("aria-expanded", "true");

    navigationMock.pathname = "/company/session/sess_child";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent
          detail={makeDetail({
            session: makeSession({
              id: "sess_child",
              status: "ready",
              parentSessionId: "sess_001",
            }),
            related: { parent: makeRelatedChild({ id: "sess_001" }), children: [] },
          })}
          workspaceId="wks_test"
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Expand runtime details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("links child sessions under /personal when viewed on the personal surface", () => {
    navigationMock.pathname = "/personal/session/sess_001";
    const detail = makeDetail({
      related: { parent: null, children: [makeRelatedChild()] },
    });
    renderSessionViewContent(detail);

    const childLink = screen.getByTitle("Child session");
    expect(childLink).toHaveAttribute("href", "/personal/session/sess_child");
    expect(screen.getByText("Session page").parentElement?.querySelector("a")).toHaveAttribute(
      "href",
      "/personal/session/sess_001",
    );
  });

  it("keeps child-session links under /company on the company surface", () => {
    navigationMock.pathname = "/company/session/sess_001";
    const detail = makeDetail({
      related: { parent: null, children: [makeRelatedChild()] },
    });
    renderSessionViewContent(detail);

    const childLink = screen.getByTitle("Child session");
    expect(childLink).toHaveAttribute("href", "/company/session/sess_child");
  });
});

describe("SessionViewContent — surface-aware slash command navigation", () => {
  it("pipes enabled personal-agent built-in skill slash commands into the composer", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/personal/session/sess_001";
    const personalAgent = makePersonalAgentContext();
    personalAgent.config = {
      ...personalAgent.config,
      skills: [{ id: "humanizer" }],
    };
    personalAgent.agent = { ...personalAgent.agent, config: personalAgent.config };

    renderSessionViewContent(
      makeDetail({ session: makeSession({ status: "completed" }) }),
      "live",
      {
        personalAgent,
      },
    );

    setComposerValue("/hum");
    await screen.findByRole("option", { name: /Humanizer/i });
    await user.keyboard("{Tab}");

    expect(screen.getByPlaceholderText("Ask this agent to do something")).toHaveValue(
      "@skill/humanizer ",
    );
  });

  it("pipes personal skill slash commands into the composer", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/personal/session/sess_001";
    const personalAgent = makePersonalAgentContext({
      personalSkills: [
        {
          id: "weekly-digest",
          name: "Weekly digest",
          description: "Summarize the week.",
          command: "digest",
          origin: "personal",
        },
      ],
    });

    renderSessionViewContent(
      makeDetail({ session: makeSession({ status: "completed" }) }),
      "live",
      {
        personalAgent,
      },
    );

    setComposerValue("/digest");
    await screen.findByRole("option", { name: /\/digest/i });
    await user.keyboard("{Enter}");

    expect(screen.getByPlaceholderText("Ask this agent to do something")).toHaveValue(
      "@skill/weekly-digest ",
    );
  });

  it("keeps /clear-created sessions under /personal when invoked from a personal session", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/personal/session/sess_001";
    const { result, detail: createdDetail } = makeCreateSessionResult("sess_clear");
    vi.mocked(createAgentSession).mockResolvedValue(result);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    setComposerValue("/clear ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/personal/session/sess_clear");
    });
    expect(createAgentSession).toHaveBeenCalledWith("agent_001", { surface: "personal" });
    expect(seedSessionQueries).toHaveBeenCalledWith(
      expect.any(QueryClient),
      "wks_test",
      createdDetail,
    );
  });

  it("keeps /clear-created sessions under /company when invoked from a company session", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/company/session/sess_001";
    const { result } = makeCreateSessionResult("sess_clear");
    vi.mocked(createAgentSession).mockResolvedValue(result);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    setComposerValue("/clear ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/company/session/sess_clear");
    });
    expect(createAgentSession).toHaveBeenCalledWith("agent_001", { surface: "company" });
  });

  it("shows an out-of-credits toast instead of redirecting immediately from /clear", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/personal/session/sess_001";
    vi.mocked(createAgentSession).mockResolvedValue({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/personal/settings?billing=insufficient",
    } as Awaited<ReturnType<typeof createAgentSession>>);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    setComposerValue("/clear ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(toastMock.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ label: "Add credits" }),
          title: "You're out of credits",
          tone: "error",
        }),
      );
    });
    expect(routerMock.push).not.toHaveBeenCalled();

    const toast = toastMock.showToast.mock.calls.at(-1)?.[0];
    toast?.action?.onClick();

    expect(routerMock.push).toHaveBeenCalledWith("/personal/settings?billing=insufficient");
  });

  it("opens /btw-created sessions under /personal from the toast action", async () => {
    const user = userEvent.setup();
    navigationMock.pathname = "/personal/session/sess_001";
    const { result } = makeCreateSessionResult("sess_btw");
    vi.mocked(createAgentSession).mockResolvedValue(result);

    renderSessionViewContent(makeDetail({ session: makeSession({ status: "completed" }) }));

    setComposerValue("/btw ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(toastMock.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ label: "Open" }),
          title: "New session started",
        }),
      );
    });

    const toast = toastMock.showToast.mock.calls.at(-1)?.[0];
    toast?.action?.onClick();

    expect(routerMock.push).toHaveBeenCalledWith("/personal/session/sess_btw");
    expect(createAgentSession).toHaveBeenCalledWith("agent_001", { surface: "personal" });
  });
});

describe("pastedTextFile — oversized paste → attachment", () => {
  it("wraps the pasted text in a plain-text File", async () => {
    const file = pastedTextFile("a".repeat(5000), []);
    expect(file.name).toBe("pasted-text.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("a".repeat(5000));
  });

  it("numbers subsequent pastes against pending pasted-text attachments", () => {
    const pending = [{ filename: "pasted-text.txt" }, { filename: "notes.md" }] as Parameters<
      typeof pastedTextFile
    >[1];
    expect(pastedTextFile("more text", pending).name).toBe("pasted-text-2.txt");
  });
});

// ── Open chat scrolled to the bottom ────────────────────────────────────────
describe("SessionViewContent — opens a chat scrolled to the bottom", () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;
  let originalScrollTo: PropertyDescriptor | undefined;

  beforeEach(() => {
    scrollToSpy = vi.fn();
    originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 2000,
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

  it("snaps an idle session with existing messages to the bottom on open", async () => {
    const detail = makeDetail({
      messages: [
        { id: "m_user", role: "user", content: "Question", status: "completed" },
        { id: "m_assistant", role: "assistant", content: "Answer", status: "completed" },
      ],
    });
    streamMock.status = "live";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const wentToBottom = scrollToSpy.mock.calls.some(
        ([arg]) => arg?.behavior === "auto" && (arg?.top ?? 0) >= 800,
      );
      expect(wentToBottom).toBe(true);
    });
  });
});
