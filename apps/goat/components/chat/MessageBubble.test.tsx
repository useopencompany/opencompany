import "@testing-library/jest-dom/vitest";
import { CODEX_PLAN_TOOL_NAME, CODEX_QUESTION_TOOL_NAME } from "@opencompany/agent-runtime";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  GOAT_BRAIN_TOOL_PART_TYPE,
  type GoatChatUiMessage,
  USE_CAPABILITY_TOOL_PART_TYPE,
} from "@/lib/chat-ui";
import { getVisibleBrainCitationCount } from "./AssistantTextBubble";
import type { ChatTaskLookup } from "./assistant-items";
import { MessageBubble } from "./MessageBubble";

const emptyTaskLookup: ChatTaskLookup = new Map();

describe("MessageBubble assistant errors", () => {
  it("renders the turn error even when the assistant produced no parts", () => {
    const message: GoatChatUiMessage = {
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
    const message: GoatChatUiMessage = {
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
        } as GoatChatUiMessage["parts"][number],
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    expect(screen.getByText("Codex turn failed.")).toBeInTheDocument();
  });

  it("does not duplicate the error when a text bubble already carries it", () => {
    const message: GoatChatUiMessage = {
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
    const message: GoatChatUiMessage = {
      id: "assistant_4",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: GOAT_BRAIN_TOOL_PART_TYPE,
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
    const source = screen.getByRole("link", { name: "Source 1: Ada Lovelace (team/gtm/ada)" });
    expect(source).toHaveAttribute("href", "/brain/goat_brain_1/team/gtm/ada");
    expect(screen.getByLabelText("Sources")).toBeInTheDocument();
  });

  it("cites wiki pages without their underlying evidence", () => {
    const message: GoatChatUiMessage = {
      id: "assistant_5",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: GOAT_BRAIN_TOOL_PART_TYPE,
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
                  sources: [{ ref: "slack:channel:message:456", title: "Hiring update" }],
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
      within(sources).getByRole("link", { name: "Source 1: Ada Lovelace (team/gtm/ada)" }),
    ).toHaveAttribute("href", "/brain/goat_brain_1/team/gtm/ada");
    expect(screen.queryByText("Ada was hired")).not.toBeInTheDocument();
    expect(screen.queryByText("acme/api #123")).not.toBeInTheDocument();
    expect(screen.queryByText("Hiring update")).not.toBeInTheDocument();
  });

  it("renders capability entities as external source chips", () => {
    const message: GoatChatUiMessage = {
      id: "assistant_6",
      role: "assistant",
      metadata: { sessionId: "goat_chat_1" },
      parts: [
        {
          type: USE_CAPABILITY_TOOL_PART_TYPE,
          toolCallId: "tool_capability_1",
          state: "output-available",
          input: { capability: "linear", operation: "read", request: "Find the launch issue" },
          output: {
            capability: "linear",
            summary: "ENG-123 tracks the launch.",
            entities: [
              {
                type: "linear_issue",
                id: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                title: "Launch tracking",
              },
            ],
          },
        },
        { type: "text", text: "ENG-123 tracks the launch." },
      ],
    };

    render(<MessageBubble message={message} taskLookup={emptyTaskLookup} />);

    const source = screen.getByRole("link", {
      name: "Source 1: Launch tracking (ENG-123)",
    });
    expect(source).toHaveAttribute("href", "https://linear.app/acme/issue/ENG-123");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByLabelText("Sources")).toBeInTheDocument();
  });
});

describe("MessageBubble Codex interactions", () => {
  it("renders the terminal Plan-mode implementation choice", async () => {
    const onCodexAction = vi.fn(async () => undefined);
    const message: GoatChatUiMessage = {
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
        } as GoatChatUiMessage["parts"][number],
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
    const message: GoatChatUiMessage = {
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
                options: [{ label: "Foundational", description: "Harden the full protocol path." }],
              },
            ],
          },
        } as GoatChatUiMessage["parts"][number],
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
    const message: GoatChatUiMessage = {
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
        } as GoatChatUiMessage["parts"][number],
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
    const message: GoatChatUiMessage = {
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
                options: [{ label: "Foundational", description: "Harden the full protocol path." }],
              },
            ],
          },
        } as GoatChatUiMessage["parts"][number],
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
