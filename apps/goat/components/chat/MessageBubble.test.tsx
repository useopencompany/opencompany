import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GOAT_BRAIN_TOOL_PART_TYPE, type GoatChatUiMessage } from "@/lib/chat-ui";
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
    expect(screen.getByLabelText("Brain sources")).toBeInTheDocument();
  });
});
