import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import {
  GOAT_BRAIN_TOOL_PART_TYPE,
  type GoatChatUiMessage,
  START_TASK_TOOL_PART_TYPE,
  WEB_SEARCH_TOOL_PART_TYPE,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { GoatSurface, type GoatTaskView } from "./GoatSurface";

const chatMock = vi.hoisted(() => ({
  status: "ready" as "ready" | "submitted" | "streaming" | "error",
  sendMessage: vi.fn(),
  stop: vi.fn(),
  finishSessionId: null as string | null,
}));

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
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
    useChat: (options: {
      messages?: GoatChatUiMessage[];
      onFinish?: (event: { message: GoatChatUiMessage }) => void;
    }) => {
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
          if (chatMock.finishSessionId) {
            options.onFinish?.({
              message: {
                id: "assistant_1",
                role: "assistant",
                metadata: { sessionId: chatMock.finishSessionId },
                parts: [{ type: "text", text: "Done." }],
              },
            });
          }
        },
      };
    },
  };
});

describe("GoatSurface chat streaming UI", () => {
  beforeEach(() => {
    chatMock.status = "ready";
    chatMock.finishSessionId = null;
    chatMock.sendMessage.mockReset();
    chatMock.stop.mockReset();
    routerMock.refresh.mockReset();
    routerMock.replace.mockReset();
    vi.mocked(closeGoatChatSessionAction).mockClear();
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

  it("keeps a completed new chat visible while server props refresh", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(
      screen.getByPlaceholderText("Ask a question or describe a task..."),
      "Hello Goat",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await nextAnimationFrame();

    expect(screen.getByText("Hello Goat")).toBeInTheDocument();
    expect(screen.queryByText("No results yet.")).not.toBeInTheDocument();
  });

  it("renders recent chat history with links to each chat", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_GOAT_MODEL,
            preview: "Compare the latest pricing.",
            updatedAt: "2026-07-02T17:44:00.000Z",
          },
        ]}
      />,
    );

    const chatLink = screen.getByRole("link", { name: /Market research/ });
    expect(chatLink).toHaveAttribute("href", "/?chat=chat_1");
    expect(screen.getByText("Compare the latest pricing.")).toBeInTheDocument();
  });

  it("updates the URL when a new chat returns a session id", async () => {
    const user = userEvent.setup();
    chatMock.finishSessionId = "goat_chat_123";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask a question or describe a task..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(routerMock.replace).toHaveBeenCalledWith("/?chat=goat_chat_123");
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it("keeps a completed existing chat turn visible while server props refresh", async () => {
    const user = userEvent.setup();

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
              parts: [{ type: "text", text: "Earlier answer" }],
            },
          ],
        }}
      />,
    );

    await user.type(screen.getByPlaceholderText("Reply..."), "Follow-up");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await nextAnimationFrame();

    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByText("Follow-up")).toBeInTheDocument();
  });

  it("keeps chat closed while server props refresh", async () => {
    const user = userEvent.setup();

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
              parts: [{ type: "text", text: "Earlier answer" }],
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close chat" }));
    await nextAnimationFrame();

    expect(screen.queryByText("Earlier answer")).not.toBeInTheDocument();
    expect(screen.getByText("No results yet.")).toBeInTheDocument();
    expect(routerMock.replace).toHaveBeenCalledWith("/");
    expect(closeGoatChatSessionAction).not.toHaveBeenCalled();
  });

  it("closes the open chat when Escape is pressed", async () => {
    const user = userEvent.setup();

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
              parts: [{ type: "text", text: "Earlier answer" }],
            },
          ],
        }}
      />,
    );

    await user.keyboard("{Escape}");
    await nextAnimationFrame();

    expect(screen.queryByText("Earlier answer")).not.toBeInTheDocument();
    expect(screen.getByText("No results yet.")).toBeInTheDocument();
  });

  it("disables input and exposes a stop button while streaming", async () => {
    const user = userEvent.setup();
    chatMock.status = "streaming";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    expect(screen.getByPlaceholderText("Ask a question or describe a task...")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(chatMock.stop).toHaveBeenCalledTimes(1);
  });

  it("shows a thinking indicator while streaming before assistant output arrives", () => {
    chatMock.status = "streaming";

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
              id: "user_1",
              role: "user",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Hello Goat" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("status", { name: "Goat is thinking" })).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("hides the thinking indicator once assistant output is visible", () => {
    chatMock.status = "streaming";

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
              id: "user_1",
              role: "user",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Hello Goat" }],
            },
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
    expect(screen.queryByRole("status", { name: "Goat is thinking" })).not.toBeInTheDocument();
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

    const assistantText = screen.getByText("Streaming answer");
    expect(assistantText).toBeInTheDocument();
    expect(assistantText.closest(".bg-surface-muted")).toBeNull();
  });

  it("renders a task card from start_task tool output", () => {
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
                  type: START_TASK_TOOL_PART_TYPE,
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

  it("renders assistant text and task cards in message part order", () => {
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
                { type: "text", text: "I'll start now." },
                {
                  type: START_TASK_TOOL_PART_TYPE,
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
                { type: "text", text: "You'll get the report in Results." },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    const firstText = screen.getByText("I'll start now.");
    const taskCard = screen.getByRole("link", { name: /Research market/ });
    const lastText = screen.getByText("You'll get the report in Results.");

    expect(
      firstText.compareDocumentPosition(taskCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      taskCard.compareDocumentPosition(lastText) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders running brain tool calls in assistant message order", () => {
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
                { type: "text", text: "I'll check your Brain." },
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_1",
                  state: "input-available",
                  input: {
                    args: 'query --text "hiring" --limit 5',
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    const intro = screen.getByText("I'll check your Brain.");
    const toolRow = screen.getByTestId("chat-tool-call-goat_brain");

    expect(screen.getByText("Brain")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText('goat_brain query --text "hiring" --limit 5')).toBeInTheDocument();
    expect(intro.compareDocumentPosition(toolRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders completed and failed brain tool calls", () => {
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
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_1",
                  state: "output-available",
                  input: { args: "doctor" },
                  output: {
                    ok: true,
                    exitCode: 0,
                    stdout: "No issues found.\nAll folders are valid.",
                    stderr: "",
                  },
                },
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_2",
                  state: "output-available",
                  input: { args: "rewrite bad-id" },
                  output: {
                    ok: false,
                    exitCode: 1,
                    stdout: "",
                    stderr: "Document was not found.",
                    error: "Document was not found.",
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getAllByTestId("chat-tool-call-goat_brain")).toHaveLength(2);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("No issues found.")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Document was not found.")).toBeInTheDocument();
  });

  it("renders persisted web search tool calls with a generic tool row", () => {
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
                {
                  type: WEB_SEARCH_TOOL_PART_TYPE,
                  toolCallId: "tool_web_1",
                  state: "output-available",
                  input: { query: "latest Google updates" },
                  output: {
                    ok: true,
                    query: "latest Google updates",
                    searchedAt: "2026-07-04T12:00:00.000Z",
                    results: [
                      {
                        title: "Google Blog",
                        url: "https://blog.google",
                        highlights: ["Google shared a current product update."],
                      },
                    ],
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getByTestId("chat-tool-call-web_search")).toBeInTheDocument();
    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("query: latest Google updates")).toBeInTheDocument();
  });

  it("labels freshly created result rows as just now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T17:44:00.000Z"));
    try {
      render(
        <GoatSurface
          tasks={[taskView({ createdAt: "2026-07-02T17:43:45.000Z" })]}
          defaultModel={DEFAULT_GOAT_MODEL}
          initialChat={null}
        />,
      );

      expect(screen.getByText("just now")).toBeInTheDocument();
      expect(screen.queryByText("0m ago")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

function taskView(overrides: Partial<GoatTaskView> = {}): GoatTaskView {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Summarize latest email",
    prompt: "Summarize latest email",
    model: DEFAULT_GOAT_MODEL,
    status: "succeeded",
    stage: "completed",
    result: "Done.",
    error: null,
    archivedAt: null,
    createdAt: "2026-07-02T17:44:00.000Z",
    updatedAt: "2026-07-02T17:44:00.000Z",
    ...overrides,
  };
}

async function nextAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
