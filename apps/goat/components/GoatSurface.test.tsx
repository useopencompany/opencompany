import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatChatUiMessage } from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { GoatSurface } from "./GoatSurface";

const chatMock = vi.hoisted(() => ({
  status: "ready" as "ready" | "submitted" | "streaming" | "error",
  sendMessage: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/chat-actions", () => ({
  closeGoatChatSessionAction: vi.fn(async () => ({ ok: true, error: null })),
}));

vi.mock("@/lib/tasks", () => ({
  archiveGoatTaskAction: vi.fn(async () => ({ ok: true, error: null })),
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useChat: (options: { messages?: GoatChatUiMessage[] }) => {
      const [messages, setMessages] = React.useState<GoatChatUiMessage[]>(
        () => options.messages ?? [],
      );

      return {
        id: "test-chat",
        messages,
        setMessages,
        status: chatMock.status,
        error: undefined,
        clearError: vi.fn(),
        stop: () => {
          chatMock.stop();
        },
        sendMessage: async (message: { text: string }) => {
          chatMock.sendMessage(message);
          setMessages((current) => [
            ...current,
            {
              id: "ui_user_1",
              role: "user",
              parts: [{ type: "text", text: message.text }],
            },
          ]);
        },
      };
    },
  };
});

describe("GoatSurface chat streaming UI", () => {
  beforeEach(() => {
    chatMock.status = "ready";
    chatMock.sendMessage.mockReset();
    chatMock.stop.mockReset();
  });

  it("clears the composer and paints the user message immediately", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "Hello Goat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Hello Goat" });
    expect(textarea).toHaveValue("");
    expect(screen.getByText("Hello Goat")).toBeInTheDocument();
  });

  it("disables input and exposes a stop button while streaming", async () => {
    const user = userEvent.setup();
    chatMock.status = "streaming";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    expect(screen.getByPlaceholderText("Ask a question or describe a task...")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(chatMock.stop).toHaveBeenCalledTimes(1);
  });

  it("renders assistant text from UI message parts", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Streaming answer" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Streaming answer")).toBeInTheDocument();
  });

  it("renders a task card from start_goat_task tool output", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [
                { type: "text", text: "Added it to Results." },
                {
                  type: "tool-start_goat_task",
                  toolCallId: "tool_1",
                  state: "output-available",
                  input: {
                    prompt: "Research the market",
                    name: "Research market",
                  },
                  output: {
                    taskId: "task_1",
                    taskDisplayId: "TASK-42",
                    taskName: "Research market",
                    status: "queued",
                    prompt: "Research the market",
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getByText("Added it to Results.")).toBeInTheDocument();
    expect(screen.getByText("Research market")).toBeInTheDocument();
    expect(screen.getByText("TASK-42")).toBeInTheDocument();
  });
});
