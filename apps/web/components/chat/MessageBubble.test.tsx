import "@testing-library/jest-dom/vitest";
import {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
} from "@opencompany/agent-runtime";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_TOOL_PART_TYPE, type ChatUiMessage, USE_ACTION_TOOL_PART_TYPE } from "@/lib/chat-ui";
import { getVisibleBrainCitationCount } from "./AssistantTextBubble";
import type { ChatTaskLookup } from "./assistant-items";
import { MessageBubble } from "./MessageBubble";

const emptyTaskLookup: ChatTaskLookup = new Map();
const presentationMocks = vi.hoisted(() => ({
  load: vi.fn(),
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppDataOptional: () => ({ user: { email: "louis@acta.so" } }),
}));
vi.mock("@/lib/headless-chat-presentations", () => ({
  loadHeadlessChatMessagePresentation: presentationMocks.load,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  presentationMocks.load.mockReset();
});

describe("MessageBubble historical presentation details", () => {
  it("renders a summary-backed pending use_action approval without loading historical detail", () => {
    const onActionApproval = vi.fn(async () => undefined);
    const summaryMessage = {
      id: "assistant_pending_approval_summary",
      role: "assistant",
      metadata: {
        sessionId: "conversation_1",
        presentation: {
          source: "summary",
          updatedAt: "2026-09-03T10:00:00.000Z",
        },
      },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_slack_search",
          state: "approval-requested",
          input: {
            action: "plugin:slack:slack.slack_search_public_and_private",
            params: { query: "launch plan", include_private: true },
          },
          approval: { id: "approval_slack_search" },
        },
      ],
    } as ChatUiMessage;

    render(
      <MessageBubble
        message={summaryMessage}
        taskLookup={emptyTaskLookup}
        onActionApproval={onActionApproval}
        allowActionApproval
      />,
    );

    expect(screen.getByTestId("chat-action-approval")).toBeVisible();
    expect(screen.getByText("Run Slack · Slack Search Public And Private?")).toBeVisible();
    expect(screen.getByText("launch plan")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Decline" })).toBeVisible();
    expect(presentationMocks.load).not.toHaveBeenCalled();
    expect(onActionApproval).not.toHaveBeenCalled();
  });

  it("shows loading and retry states before replacing a compact tool summary with full detail", async () => {
    const user = userEvent.setup();
    const summaryMessage = {
      id: "assistant_summary",
      role: "assistant",
      metadata: {
        sessionId: "conversation_1",
        presentation: {
          source: "summary",
          updatedAt: "2026-08-10T20:00:01.000Z",
        },
      },
      parts: [
        {
          type: "dynamic-tool",
          toolName: "history_search",
          toolCallId: "tool_1",
          state: "output-available",
          input: { query: "launch" },
          output: { result: "Compact preview" },
        },
      ],
    } as ChatUiMessage;
    const fullMessage = {
      ...summaryMessage,
      parts: [
        {
          type: "dynamic-tool",
          toolName: "history_search",
          toolCallId: "tool_1",
          state: "output-available",
          input: { query: "launch", filters: { owner: "product" } },
          output: { result: "Full provider result with every historical detail" },
        },
      ],
    } as ChatUiMessage;
    let rejectFirst!: (cause: Error) => void;
    presentationMocks.load
      .mockReturnValueOnce(
        new Promise<ChatUiMessage>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockResolvedValueOnce(fullMessage);

    render(<MessageBubble message={summaryMessage} taskLookup={emptyTaskLookup} />);
    await user.click(screen.getByRole("button", { name: /History Search/u }));
    expect(screen.getByText("Loading details…")).toBeVisible();

    await act(async () => rejectFirst(new Error("Temporary trace failure")));
    expect(await screen.findByText("Temporary trace failure")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByText(/Full provider result with every historical detail/u)).toBeVisible(),
    );
    expect(presentationMocks.load).toHaveBeenCalledTimes(2);
  });
});

describe("MessageBubble scheduled wakeups", () => {
  it("renders the synthetic trigger as a centered muted check-in instead of a user bubble", () => {
    const message: ChatUiMessage = {
      id: "scheduled_wakeup_1",
      role: "user",
      metadata: {
        scheduledWakeup: {
          reason: "Wait for CI",
          dueAt: "2026-07-10T09:02:00.000Z",
        },
      },
      parts: [{ type: "text", text: "Scheduled check-in: Wait for CI" }],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByTestId("scheduled-wakeup")).toHaveTextContent(
      "⏱ Scheduled check-in · Wait for CI",
    );
    expect(screen.queryByText("Scheduled check-in: Wait for CI")).not.toBeInTheDocument();
  });
});

describe("MessageBubble generated files", () => {
  const message: ChatUiMessage = {
    id: "assistant_artifact",
    role: "assistant",
    parts: [
      { type: "text", text: "Here is the launch plan." },
      {
        type: "data-artifact-file",
        data: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Launch plan",
          filename: "launch-plan.md",
          mediaType: "text/markdown",
          sizeBytes: 2_048,
          state: "ready",
        },
      },
    ],
  };

  it("renders versioned open and download links", () => {
    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Launch plan")).toBeVisible();
    expect(screen.getByText("launch-plan.md · 2.0 KB · v1")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Launch plan" })).toHaveAttribute(
      "href",
      "/v1/chat-artifacts/artifact_1/versions/version_1",
    );
    expect(screen.getByRole("link", { name: "Download Launch plan" })).toHaveAttribute(
      "href",
      "/v1/chat-artifacts/artifact_1/versions/version_1?download=1",
    );
  });

  it("deletes through the owner route and becomes a tombstone", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, state: "deleted" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    await user.click(screen.getByRole("button", { name: "Delete Launch plan" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/v1/chat-artifacts/artifact_1", {
        method: "DELETE",
      }),
    );
    expect(await screen.findByText("File deleted")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open Launch plan" })).not.toBeInTheDocument();
  });

  it("uses a public share href and hides deletion in read-only chat", () => {
    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        readOnly
        artifactHref={() => "/share/share_1/artifacts/artifact_1/versions/version_1"}
      />,
    );

    expect(screen.getByRole("link", { name: "Open Launch plan" })).toHaveAttribute(
      "href",
      "/share/share_1/artifacts/artifact_1/versions/version_1",
    );
    expect(screen.queryByRole("button", { name: "Delete Launch plan" })).not.toBeInTheDocument();
  });

  it("reacts to a tombstone synced from another card or client", () => {
    const { rerender } = render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);
    const deletedMessage: ChatUiMessage = {
      ...message,
      parts: message.parts.map((part) =>
        part.type === "data-artifact-file"
          ? { ...part, data: { ...part.data, state: "deleted" as const } }
          : part,
      ),
    };

    rerender(<MessageBubble message={deletedMessage} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("File deleted")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open Launch plan" })).not.toBeInTheDocument();
  });
});

describe("MessageBubble assistant errors", () => {
  it("renders a friendly standalone notice when the assistant produced no parts", () => {
    const message: ChatUiMessage = {
      id: "assistant_1",
      role: "assistant",
      metadata: {
        sessionId: "goat_chat_1",
        error: "Codex sandbox could not be started: boom. Send your message again to retry.",
      },
      parts: [],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Response stopped");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The response stopped unexpectedly. Please try again.",
    );
    expect(screen.queryByText(/Codex sandbox could not be started/)).not.toBeInTheDocument();
  });

  it("renders a friendly notice after tool-only turns", () => {
    const message: ChatUiMessage = {
      id: "assistant_2",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1", error: "Codex turn failed." },
      parts: [
        {
          type: "tool-codex_command",
          toolCallId: "item_1",
          state: "output-error",
          input: { command: "npm test" },
          errorText: "exit 1",
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The response stopped unexpectedly. Everything completed above is still available.",
    );
    expect(screen.queryByText("Codex turn failed.")).not.toBeInTheDocument();
  });

  it("preserves partial text styling and appends one friendly notice", () => {
    const message: ChatUiMessage = {
      id: "assistant_3",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1", error: "boom" },
      parts: [{ type: "text", text: "Partial answer before the failure." }],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const partialAnswer = screen.getByText("Partial answer before the failure.");
    expect(partialAnswer).toBeInTheDocument();
    expect(partialAnswer.closest(".bg-danger-bg")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The response stopped unexpectedly. Everything completed above is still available.",
    );
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });

  it("explains content inspection failures without exposing the provider error", () => {
    const message: ChatUiMessage = {
      id: "assistant_4",
      role: "assistant",
      metadata: {
        error:
          "<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.",
      },
      parts: [{ type: "text", text: "Research completed before the failure." }],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Research completed before the failure.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The selected model couldn’t process some content returned by a source. Everything completed above is still available. Try another model to continue.",
    );
    expect(screen.queryByText(/DataInspectionFailed/)).not.toBeInTheDocument();
  });

  it("renders source chips for text after successful brain reads", () => {
    const message: ChatUiMessage = {
      id: "assistant_5",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: BRAIN_TOOL_PART_TYPE,
          toolCallId: "tool_brain_1",
          state: "output-available",
          input: { command: "query", flags: { text: "gtm", limit: 3 } },
          output: {
            ok: true,
            brainRef: "goat_brain_1",
            exitCode: 0,
            stdout: "",
            stderr: "",
            parsed: {
              hits: [
                {
                  id: "ada",
                  title: "Ada Lovelace",
                  folder: "team/gtm",
                  type: "person",
                  kind: "page",
                  status: "active",
                  updatedAt: "2026-07-01T00:00:00.000Z",
                  score: 0.9,
                  signals: ["lexical"],
                  snippet: "Ada leads GTM.",
                  neighbors: [],
                },
              ],
            },
          },
        },
        { type: "text", text: "Ada leads GTM." },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Ada leads GTM.")).toBeInTheDocument();
    const source = screen.getByRole("link", {
      name: "Source 1: Ada Lovelace (team/gtm/ada)",
    });
    expect(source).toHaveAttribute("href", "/brain/goat_brain_1/team/gtm/ada");
    expect(screen.getByLabelText("Sources")).toBeInTheDocument();
  });

  it("cites wiki pages without their underlying evidence", () => {
    const message: ChatUiMessage = {
      id: "assistant_6",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: BRAIN_TOOL_PART_TYPE,
          toolCallId: "tool_brain_2",
          state: "output-available",
          input: { command: "get", flags: { id: "ada" } },
          output: {
            ok: true,
            brainRef: "goat_brain_1",
            exitCode: 0,
            stdout: "",
            stderr: "",
            parsed: {
              documents: [
                {
                  id: "ada",
                  title: "Ada Lovelace",
                  folder: "team/gtm",
                  kind: "page",
                  sources: [{ ref: "github:acme/api:pull:123", title: "acme/api #123" }],
                },
                {
                  id: "ada-hired",
                  title: "Ada was hired",
                  folder: "evidence",
                  kind: "evidence",
                  sources: [
                    {
                      ref: "slack:channel:message:456",
                      title: "Hiring update",
                    },
                  ],
                },
              ],
            },
          },
        },
        { type: "text", text: "Ada leads GTM." },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const sources = screen.getByLabelText("Sources");
    expect(within(sources).getAllByRole("link")).toHaveLength(1);
    expect(
      within(sources).getByRole("link", {
        name: "Source 1: Ada Lovelace (team/gtm/ada)",
      }),
    ).toHaveAttribute("href", "/brain/goat_brain_1/team/gtm/ada");
    expect(screen.queryByText("Ada was hired")).not.toBeInTheDocument();
    expect(screen.queryByText("acme/api #123")).not.toBeInTheDocument();
    expect(screen.queryByText("Hiring update")).not.toBeInTheDocument();
  });

  it("renders use_action parts as expandable input and output details", async () => {
    const user = userEvent.setup();
    const message: ChatUiMessage = {
      id: "assistant_6",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_action_1",
          state: "output-available",
          input: { action: "linear.list_issues", params: { team: "opencompany" } },
          output: {
            ok: true,
            action: "linear.list_issues",
            result: { issues: [] },
          },
        },
        { type: "text", text: "No open issues for the opencompany team." },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const toolCall = screen.getByTestId("chat-tool-call-use_action");
    const disclosure = within(toolCall).getByRole("button", { name: /Linear List Issues/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(within(toolCall).queryByText("Done")).not.toBeInTheDocument();
    expect(within(toolCall).queryByText("Input")).not.toBeInTheDocument();

    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(within(toolCall).getByText("Input")).toBeInTheDocument();
    expect(within(toolCall).getByText("Output")).toBeInTheDocument();
    expect(within(toolCall).getByText(/"team": "opencompany"/)).toBeInTheDocument();
    expect(within(toolCall).getByText(/"issues": \[\]/)).toBeInTheDocument();
    expect(screen.getByText("No open issues for the opencompany team.")).toBeInTheDocument();
  });

  it("confirms a failed GitHub tool is outside install scope before offering Add access", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        checkedAt: "2026-09-02T12:00:00.000Z",
        installations: [],
        target: {
          owner: "opencompany",
          repo: "private-repo",
          state: "missing_installation",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const message: ChatUiMessage = {
      id: "assistant_github_install_gap",
      role: "assistant",
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_github_install_gap",
          state: "output-available",
          input: {
            action: "plugin:github:github.pull_request_read",
            params: { owner: "opencompany", repo: "private-repo", pullNumber: 12 },
          },
          output: {
            ok: false,
            action: "plugin:github:github.pull_request_read",
            error: {
              code: "provider_error",
              source: "github",
              message: "Resource not accessible by integration",
            },
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(await screen.findByTestId("github-install-gap")).toHaveTextContent(
      "GitHub App is not installed on opencompany",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github-user/installations?owner=opencompany",
      expect.objectContaining({ method: "GET" }),
    );
    expect(screen.getByRole("link", { name: "Add access" })).toHaveAttribute(
      "href",
      "/api/integrations/github-user/start?returnTo=%2F&owner=opencompany",
    );
    await userEvent.click(screen.getByRole("link", { name: "Add access" }));
    expect(screen.getByTestId("github-install-gap")).toHaveTextContent(
      "Pending admin approval for opencompany",
    );
  });

  it("keeps private GitHub recovery controls out of shared transcripts", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message: ChatUiMessage = {
      id: "assistant_shared_github_gap",
      role: "assistant",
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_shared_github_gap",
          state: "output-available",
          input: {
            action: "plugin:github:github.pull_request_read",
            params: { owner: "opencompany", repo: "private-repo", pullNumber: 12 },
          },
          output: {
            ok: false,
            action: "plugin:github:github.pull_request_read",
            error: { code: "provider_error", message: "Resource not accessible by integration" },
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} readOnly />);

    expect(screen.queryByTestId("github-install-gap")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents plugin action labels and acting identity without changing the canonical id", async () => {
    const user = userEvent.setup();
    const onActionApproval = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_plugin_approval",
      role: "assistant",
      metadata: { sessionId: "chat_session_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_plugin_approval",
          state: "approval-requested",
          input: {
            action: "plugin:linear:linear.save_comment",
            params: { issueId: "PRO-185", body: "Acceptance test" },
          },
          approval: { id: "approval_plugin_1" },
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onActionApproval={onActionApproval}
        allowActionApproval
      />,
    );

    expect(screen.getByText("Run Linear · Save Comment?")).toBeVisible();
    expect(screen.getByText("as louis@acta.so")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(onActionApproval).toHaveBeenCalledWith({
        approvalId: "approval_plugin_1",
        action: "plugin:linear:linear.save_comment",
        decision: "decline",
      }),
    );
  });

  it("labels a persisted declined plugin action as declined", async () => {
    const user = userEvent.setup();
    const message: ChatUiMessage = {
      id: "assistant_plugin_declined",
      role: "assistant",
      metadata: { sessionId: "chat_session_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_plugin_declined",
          state: "approval-responded",
          input: {
            action: "plugin:linear:linear.save_comment",
            params: { issueId: "PRO-185", body: "Do not create" },
          },
          approval: {
            id: "approval_plugin_declined",
            approved: false,
            reason: "The user declined this action.",
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const disclosure = screen.getByRole("button", {
      name: /Linear · Save Comment.*Declined/u,
    });
    expect(disclosure).toBeVisible();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(screen.getByText("The user declined this action.")).toBeVisible();
  });

  it("renders browser screenshots from the authenticated transcript route", () => {
    const message: ChatUiMessage = {
      id: "assistant_browser",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "tool-browser_screenshot",
          toolCallId: "tool_browser_1",
          state: "output-available",
          input: { fullPage: true },
          output: {
            ok: true,
            command: "browser_screenshot",
            screenshotUrl: "/v1/chat-screenshots/goat_chat_1/1234-aabb.png",
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Screenshot")).toBeInTheDocument();
    expect(screen.getByText("Full page")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Screenshot captured by opencompany's browser" }),
    ).toHaveAttribute("src", "/v1/chat-screenshots/goat_chat_1/1234-aabb.png");
  });

  it("renders shared transcripts without approval requests or task navigation", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message: ChatUiMessage = {
      id: "assistant_shared",
      role: "assistant",
      metadata: {
        taskId: "task_1",
        task: {
          id: "task_1",
          displayId: "TASK-1",
          title: "Private follow-up",
          status: "queued",
        },
      },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_action_approval",
          state: "output-available",
          input: {
            action: "lead.find_person_email",
            params: { email: "ada@example.com" },
          },
          output: {
            ok: false,
            action: "lead.find_person_email",
            error: {
              code: "approval_required",
              source: "lead",
              message: "Approve this paid capability once to continue.",
              approval: {
                runId: "gcr_abc",
                source: "lead",
                action: "lead.find_person_email",
                maxCostUsdMicros: 360_000,
                expiresAt: "2026-07-23T10:15:00.000Z",
                status: "awaiting_approval",
              },
            },
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} readOnly />);

    expect(screen.queryByText("Approve paid capability?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(screen.getByText("Private follow-up")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Private follow-up/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not render task attribution metadata as a card inside a task session", () => {
    const message: ChatUiMessage = {
      id: "assistant_task_session",
      role: "assistant",
      metadata: {
        taskId: "task_1",
        task: {
          id: "task_1",
          displayId: "TASK-1",
          title: "Ship the fix",
          status: "succeeded",
        },
      },
      parts: [{ type: "text", text: "Shipped and merged." }],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} isTaskSession />);

    expect(screen.getByText("Shipped and merged.")).toBeInTheDocument();
    expect(screen.queryByText("Ship the fix")).not.toBeInTheDocument();
    expect(screen.queryByText("TASK-1 · Done")).not.toBeInTheDocument();
  });

  it("renders legacy paid capability approvals as inert historical cards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runId: "gcr_abc",
              status: "expired",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const message: ChatUiMessage = {
      id: "assistant_approval",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_action_approval",
          state: "output-available",
          input: {
            action: "lead.find_person_email",
            params: { email: "ada@example.com" },
          },
          output: {
            ok: false,
            action: "lead.find_person_email",
            error: {
              code: "approval_required",
              source: "lead",
              message: "Approve this paid capability once to continue.",
              approval: {
                runId: "gcr_abc",
                source: "lead",
                action: "lead.find_person_email",
                maxCostUsdMicros: 360_000,
                expiresAt: "2026-07-23T10:15:00.000Z",
                status: "awaiting_approval",
              },
            },
          },
        },
      ],
    };
    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Approve paid capability?")).toBeVisible();
    expect(screen.getByText(/Maximum charge \$0\.36/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(await screen.findByText("Expired")).toBeVisible();
  });

  it("renders a native paid capability approval with cost and distinguishing params", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runId: "gcr_abc",
              source: "lead",
              action: "lead.find_person_email",
              status: "awaiting_approval",
              maxCostUsdMicros: 360_000,
              sessionBudgetUsdMicros: 100_000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const onActionApproval = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_native_approval",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_action_approval",
          state: "approval-requested",
          input: {
            action: "lead.find_person_email",
            params: { email: "ada@example.com" },
          },
          approval: { id: "approval_1" },
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onActionApproval={onActionApproval}
        allowActionApproval
      />,
    );

    expect(screen.getByText("Run paid lookup?")).toBeVisible();
    expect(await screen.findByText(/Up to \$0\.36/)).toBeVisible();
    expect(screen.getByText("ada@example.com")).toBeVisible();
    expect(screen.getByText(/session's \$0\.10 budget/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve for $0.36" }));
    await waitFor(() =>
      expect(onActionApproval).toHaveBeenCalledWith({
        approvalId: "approval_1",
        action: "lead.find_person_email",
        decision: "accept",
      }),
    );
  });

  it("renders an ACP permission as a one-time approval", async () => {
    const user = userEvent.setup();
    const onActionApproval = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_acp_approval",
      role: "assistant",
      metadata: { sessionId: "chat_session_1", runId: "run_1" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_APPROVAL_TOOL_NAME,
          toolCallId: "acp-approval-command_1",
          state: "approval-requested",
          input: { title: "Run tests", action: "bun test" },
          approval: { id: "opencompany_acp_permission_1" },
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onActionApproval={onActionApproval}
        allowActionApproval
      />,
    );

    expect(screen.getByText("Run bun test?")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(onActionApproval).toHaveBeenCalledWith({
        approvalId: "opencompany_acp_permission_1",
        action: "bun test",
        decision: "accept",
      }),
    );
  });

  it("renders proposed X posts instead of coercing structured params to object strings", () => {
    const message: ChatUiMessage = {
      id: "assistant_x_post_approval",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: USE_ACTION_TOOL_PART_TYPE,
          toolCallId: "tool_x_post_approval",
          state: "approval-requested",
          input: {
            action: "x_account.post_tweet",
            params: {
              posts: [
                {
                  account: "@founder",
                  text: "We built this for small teams that want to move faster.",
                },
                {
                  account: "@company",
                  text: "A faster workflow for the small teams building what comes next.",
                },
              ],
            },
          },
          approval: { id: "approval_x_post" },
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onActionApproval={vi.fn(async () => undefined)}
        allowActionApproval
      />,
    );

    expect(screen.getByText("Post to X?")).toBeVisible();
    expect(
      screen.getByText("@founder — We built this for small teams that want to move faster."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "@company — A faster workflow for the small teams building what comes next.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it("renders historical use_capability parts through the generic tool row without crashing", () => {
    const message: ChatUiMessage = {
      id: "assistant_7",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "tool-use_capability",
          toolCallId: "tool_capability_1",
          state: "output-available",
          input: { capability: "linear", request: "Find the launch issue" },
          output: {
            capability: "linear",
            summary: "ENG-123 tracks the launch.",
            entities: [],
          },
        } as unknown as ChatUiMessage["parts"][number],
        { type: "text", text: "ENG-123 tracks the launch." },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Use Capability")).toBeInTheDocument();
    expect(screen.getByText("ENG-123 tracks the launch.")).toBeInTheDocument();
  });
});

describe("MessageBubble Codex interactions", () => {
  it("renders described commands without shell wrappers or internal tool constants", () => {
    const message: ChatUiMessage = {
      id: "assistant_command",
      role: "assistant",
      parts: [
        {
          type: `tool-${CODEX_COMMAND_TOOL_NAME}`,
          toolCallId: "command_1",
          state: "output-available",
          input: {
            description: "Check local copy of spec and git status",
            command: "/bin/bash -lc 'git status --short'",
          },
          output: { status: "completed", exitCode: 0 },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const row = screen.getByTestId(`chat-tool-call-${CODEX_COMMAND_TOOL_NAME}`);
    expect(row).toHaveTextContent("Check local copy of spec and git status");
    expect(row).toHaveTextContent("git status --short");
    expect(row).not.toHaveTextContent("/bin/bash -lc");
    expect(row).not.toHaveTextContent(CODEX_COMMAND_TOOL_NAME);
  });

  it("offers repository access recovery for a failed sandbox git operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          checkedAt: "2026-09-02T12:00:00.000Z",
          installations: [
            {
              id: "123",
              account: {
                id: "987",
                login: "opencompany",
                type: "Organization",
                avatarUrl: null,
                htmlUrl: "https://github.com/opencompany",
              },
              repositorySelection: "selected",
              permissions: { metadata: "read" },
              pendingPermissions: ["actions", "checks", "contents", "issues", "pull_requests"],
              suspendedAt: null,
              repositories: [],
            },
          ],
          target: {
            owner: "opencompany",
            repo: "private-repo",
            state: "missing_repository",
          },
        }),
      ),
    );
    const message: ChatUiMessage = {
      id: "assistant_github_sandbox_gap",
      role: "assistant",
      parts: [
        {
          type: `tool-${CODEX_COMMAND_TOOL_NAME}`,
          toolCallId: "command_github_gap",
          state: "output-available",
          input: {
            command: "git push https://github.com/opencompany/private-repo.git HEAD",
          },
          output: {
            status: "failed",
            exitCode: 128,
            outputPreview: "remote: Resource not accessible by integration",
          },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(await screen.findByTestId("github-install-gap")).toHaveTextContent(
      "GitHub App cannot access opencompany/private-repo",
    );
  });

  it("renders semantic Read and MCP rows with file and tool chips", () => {
    const message: ChatUiMessage = {
      id: "assistant_tools",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_MCP_TOOL_NAME,
          toolCallId: "read_1",
          state: "output-available",
          input: {
            toolName: "Read",
            kind: "read",
            arguments: { file_path: "/workspace/repo/apps/web/lib/chat-ui.ts" },
          },
          output: { status: "completed", result: "  1→one\n  2→two" },
        },
        {
          type: "dynamic-tool",
          toolName: CODEX_MCP_TOOL_NAME,
          toolCallId: "mcp_1",
          state: "output-available",
          input: {
            title: "List available actions",
            server: "opencompany",
            tool: "list_actions",
          },
          output: { status: "completed", result: "[]" },
        },
      ] as ChatUiMessage["parts"],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Read 2 lines")).toBeVisible();
    expect(screen.getByText("chat-ui.ts")).toBeVisible();
    expect(screen.getByText("List available actions")).toBeVisible();
    expect(screen.getByText("opencompany · list_actions")).toBeVisible();
    expect(screen.queryByText(CODEX_MCP_TOOL_NAME)).not.toBeInTheDocument();
  });

  it("shows a one-line Thinking preview and keeps the full reasoning expandable", async () => {
    const message: ChatUiMessage = {
      id: "assistant_reasoning",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "Inspecting **the adapter**\nfor stale labels.",
          state: "done",
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const row = screen.getByTestId("chat-reasoning-item");
    const disclosure = within(row).getByRole("button");
    expect(within(row).getByText("Thinking")).toBeVisible();
    expect(within(row).getByTitle("Inspecting **the adapter** for stale labels.")).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("the adapter")).toBeVisible();
  });

  it("renders the terminal Plan-mode implementation choice", async () => {
    const onCodexAction = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_plan",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_PLAN_TOOL_NAME,
          toolCallId: "plan_1",
          state: "output-available",
          input: { label: "Plan" },
          output: {
            status: "completed",
            text: "1. Inspect\n2. Patch\n3. Verify",
            implementationAvailable: true,
          },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onCodexAction={onCodexAction}
        allowCodexPlanActions
      />,
    );
    expect(screen.getByText("Implement this plan?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Implement plan" }));
    await waitFor(() => expect(onCodexAction).toHaveBeenCalledWith({ type: "implement-plan" }));
  });

  it("collects option answers and notes for an app-server question", async () => {
    const onCodexAction = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_question",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_QUESTION_TOOL_NAME,
          toolCallId: "question_1",
          state: "approval-requested",
          input: {
            label: "Question",
            interactionId: "goat_codex_chat_interaction_123",
            question: "How broad should the fix be?",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "How broad should the fix be?",
                isOther: true,
                options: [
                  {
                    label: "Foundational",
                    description: "Harden the full protocol path.",
                  },
                ],
              },
            ],
          },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onCodexAction={onCodexAction}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Foundational/ }));
    await userEvent.type(
      screen.getByPlaceholderText("Optional note or describe Other"),
      "recovery",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(onCodexAction).toHaveBeenCalledWith({
        type: "answer-question",
        interactionId: "goat_codex_chat_interaction_123",
        answers: {
          scope: { answers: ["Foundational", "user_note: recovery"] },
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Answer sent" })).toBeDisabled();
  });

  it("sends a free-text answer raw, without the user_note prefix", async () => {
    const onCodexAction = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_question",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_QUESTION_TOOL_NAME,
          toolCallId: "question_1",
          state: "approval-requested",
          input: {
            label: "Question",
            interactionId: "goat_codex_chat_interaction_123",
            question: "Which tests should run?",
            questions: [
              {
                id: "tests",
                header: "Tests",
                question: "Which tests should run?",
              },
            ],
          },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onCodexAction={onCodexAction}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Your answer"), "targeted and typecheck");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(onCodexAction).toHaveBeenCalledWith({
        type: "answer-question",
        interactionId: "goat_codex_chat_interaction_123",
        answers: { tests: { answers: ["targeted and typecheck"] } },
      }),
    );
  });

  it("requires a note for Other and sends the note as the answer", async () => {
    const onCodexAction = vi.fn(async () => undefined);
    const message: ChatUiMessage = {
      id: "assistant_question",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_QUESTION_TOOL_NAME,
          toolCallId: "question_1",
          state: "approval-requested",
          input: {
            label: "Question",
            interactionId: "goat_codex_chat_interaction_123",
            question: "How broad should the fix be?",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "How broad should the fix be?",
                isOther: true,
                options: [
                  {
                    label: "Foundational",
                    description: "Harden the full protocol path.",
                  },
                ],
              },
            ],
          },
        } as ChatUiMessage["parts"][number],
      ],
    };

    render(
      <MessageBubble
        message={message}
        taskLookup={emptyTaskLookup}
        onCodexAction={onCodexAction}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Other" }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onCodexAction).not.toHaveBeenCalled();
    expect(screen.getByText("Describe your Other answer before continuing.")).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Optional note or describe Other"),
      "revert the migration",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(onCodexAction).toHaveBeenCalledWith({
        type: "answer-question",
        interactionId: "goat_codex_chat_interaction_123",
        answers: { scope: { answers: ["revert the migration"] } },
      }),
    );
  });
});

describe("getVisibleBrainCitationCount", () => {
  it("keeps every source when they fit on one row", () => {
    expect(
      getVisibleBrainCitationCount({
        availableWidth: 158,
        chipWidths: [50, 50, 50],
        overflowWidths: { 1: 90, 2: 90 },
        gap: 4,
      }),
    ).toBe(3);
  });

  it("collapses wrapped sources behind an overflow control", () => {
    expect(
      getVisibleBrainCitationCount({
        availableWidth: 304,
        chipWidths: [90, 90, 90, 90, 90, 90],
        overflowWidths: { 1: 116, 2: 116, 3: 116, 4: 116, 5: 116 },
        gap: 4,
      }),
    ).toBe(2);
  });

  it("keeps the first source visible when the row is very narrow", () => {
    expect(
      getVisibleBrainCitationCount({
        availableWidth: 80,
        chipWidths: [120, 120, 120],
        overflowWidths: { 1: 110, 2: 110 },
        gap: 4,
      }),
    ).toBe(1);
  });
});
