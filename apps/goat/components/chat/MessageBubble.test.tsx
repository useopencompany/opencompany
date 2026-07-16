import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GoatChatUiMessage } from "@/lib/chat-ui";
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
});
