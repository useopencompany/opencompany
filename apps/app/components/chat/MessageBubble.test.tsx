import "@testing-library/jest-dom/vitest";
import { CODEX_PLAN_TOOL_NAME, CODEX_QUESTION_TOOL_NAME } from "@opencompany/agent-runtime";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_TOOL_PART_TYPE, type ChatUiMessage, USE_ACTION_TOOL_PART_TYPE } from "@/lib/chat-ui";
import { getVisibleBrainCitationCount } from "./AssistantTextBubble";
import type { ChatTaskLookup } from "./assistant-items";
import { MessageBubble } from "./MessageBubble";

const emptyTaskLookup: ChatTaskLookup = new Map();

afterEach(() => {
  vi.unstubAllGlobals();
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

describe("MessageBubble assistant errors", () => {
  it("renders the turn error even when the assistant produced no parts", () => {
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

    expect(screen.getByText(/Codex sandbox could not be started/)).toBeInTheDocument();
  });

  it("renders the error after tool-only turns", () => {
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

    expect(screen.getByText("Codex turn failed.")).toBeInTheDocument();
  });

  it("does not duplicate the error when a text bubble already carries it", () => {
    const message: ChatUiMessage = {
      id: "assistant_3",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1", error: "boom" },
      parts: [{ type: "text", text: "Partial answer before the failure." }],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Partial answer before the failure.")).toBeInTheDocument();
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });

  it("renders source chips for text after successful brain reads", () => {
    const message: ChatUiMessage = {
      id: "assistant_4",
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
      id: "assistant_5",
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
          input: { action: "linear.list_issues", params: { team: "Acme" } },
          output: {
            ok: true,
            action: "linear.list_issues",
            result: { issues: [] },
          },
        },
        { type: "text", text: "No open issues for the Acme team." },
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
    expect(within(toolCall).getByText(/"team": "Acme"/)).toBeInTheDocument();
    expect(within(toolCall).getByText(/"issues": \[\]/)).toBeInTheDocument();
    expect(screen.getByText("No open issues for the Acme team.")).toBeInTheDocument();
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
            screenshotUrl: "/api/chat-screenshots/goat_chat_1/1234-aabb.png",
          },
        },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Screenshot")).toBeInTheDocument();
    expect(screen.getByText("Full page")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Screenshot captured by the app's browser" }),
    ).toHaveAttribute("src", "/api/chat-screenshots/goat_chat_1/1234-aabb.png");
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
