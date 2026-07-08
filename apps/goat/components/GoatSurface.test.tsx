import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import {
  GOAT_BRAIN_TOOL_PART_TYPE,
  type GoatChatMessageMetadata,
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
  preparedRequestBodies: [] as unknown[],
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

vi.mock("@/lib/task-schedules", () => ({
  deleteGoatTaskScheduleAction: vi.fn(async () => ({ ok: true })),
  runGoatTaskScheduleNowAction: vi.fn(async () => ({
    ok: true,
    task: { id: "goat_task_1", displayId: "TASK-1" },
  })),
  setGoatTaskScheduleEnabledAction: vi.fn(async () => ({ ok: true })),
  updateGoatTaskScheduleAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/user-preferences", () => ({
  updateGoatTimezoneAction: vi.fn(async () => ({ ok: true, timezone: "UTC" })),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useChat: (options: {
      messages?: GoatChatUiMessage[];
      onFinish?: (event: { message: GoatChatUiMessage }) => void;
      transport?: {
        prepareSendMessagesRequest?: (request: {
          id: string;
          messages: GoatChatUiMessage[];
          requestMetadata: unknown;
          body: Record<string, unknown> | undefined;
          credentials: RequestCredentials | undefined;
          headers: HeadersInit | undefined;
          api: string;
          trigger: "submit-message";
          messageId: string | undefined;
        }) => { body: object } | PromiseLike<{ body: object }>;
      };
    }) => {
      const [messages, setMessages] = React.useState<GoatChatUiMessage[]>(
        () => options.messages ?? [],
      );
      const transportRef = React.useRef(options.transport);

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
        sendMessage: async (
          message: { text: string; metadata?: GoatChatMessageMetadata },
          requestOptions?: { body?: Record<string, unknown> },
        ) => {
          chatMock.sendMessage(message);
          const userMessage: GoatChatUiMessage = {
            id: `ui_user_${messages.length + 1}`,
            role: "user",
            ...(message.metadata ? { metadata: message.metadata } : {}),
            parts: [{ type: "text", text: message.text }],
          };
          const nextMessages = [...messages, userMessage];
          setMessages(nextMessages);
          const preparedRequest = await transportRef.current?.prepareSendMessagesRequest?.({
            id: "test-chat",
            messages: nextMessages,
            requestMetadata: undefined,
            body: requestOptions?.body,
            credentials: undefined,
            headers: undefined,
            api: "/api/chat",
            trigger: "submit-message",
            messageId: userMessage.id,
          });
          if (preparedRequest) chatMock.preparedRequestBodies.push(preparedRequest.body);
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
    chatMock.preparedRequestBodies = [];
    routerMock.refresh.mockReset();
    routerMock.replace.mockReset();
    vi.mocked(closeGoatChatSessionAction).mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears the composer and paints the user message immediately", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "Hello Goat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Hello Goat" });
    expect(textarea).toHaveValue("");
    expect(await screen.findByText("Hello Goat")).toBeInTheDocument();
  });

  it("selects from the active goat model list and sends the chosen model", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.queryByText("GPT 5.4 Mini")).not.toBeInTheDocument();

    await user.click(screen.getByText("Kimi K2.6"));
    await user.type(screen.getByPlaceholderText("Ask a question or describe a task..."), "Compare");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("keeps using the returned chat session id when the AI SDK transport is long-lived", async () => {
    const user = userEvent.setup();
    chatMock.finishSessionId = "chat_1";

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "First message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/?chat=chat_1");
    });

    await user.type(screen.getByPlaceholderText("Reply..."), "Second message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies).toHaveLength(2);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      model: DEFAULT_GOAT_MODEL,
    });
    expect(chatMock.preparedRequestBodies[1]).toMatchObject({
      sessionId: "chat_1",
      model: DEFAULT_GOAT_MODEL,
    });
  });

  it("shows the Codex mention menu and submits selected mention metadata", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "@");

    expect(screen.getByRole("listbox", { name: "Mention menu" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /@codex/i }));
    expect(textarea).toHaveValue("@codex ");
    const selectedMention = screen.getByTestId("selected-codex-mention");
    expect(selectedMention).toHaveTextContent("@codex");
    expect(selectedMention).not.toHaveClass("px-1");
    expect(selectedMention).not.toHaveClass("font-medium");

    await user.type(textarea, "check repo access");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "@codex check repo access",
      metadata: { mentions: [{ kind: "engine", id: "codex" }] },
    });
  });

  it("does not show Codex mention options when Codex is not connected", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "@");

    expect(screen.queryByRole("listbox", { name: "Mention menu" })).not.toBeInTheDocument();
  });

  it("does not send steering metadata for manually typed @codex", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "@codex check repo access");
    expect(screen.queryByTestId("selected-codex-mention")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "@codex check repo access",
    });
  });

  it("clears selected mention metadata when visible @codex text is deleted", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "@");
    await user.click(screen.getByRole("option", { name: /@codex/i }));
    await user.clear(textarea);
    await user.type(textarea, "check repo access");
    expect(screen.queryByTestId("selected-codex-mention")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "check repo access",
    });
  });

  it("keeps a completed new chat visible while server props refresh", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(
      screen.getByPlaceholderText("Ask a question or describe a task..."),
      "Hello Goat",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Hello Goat")).toBeInTheDocument();
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

  it("opens the new chat command with Cmd+N and starts a background chat", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (String(input).includes("/api/electric/")) {
        return new Response("", {
          headers: {
            "electric-handle": "test-handle",
            "electric-offset": "0",
            "electric-schema": "[]",
          },
        });
      }

      return new Response("done", { status: 200 });
    });
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.keyboard("{Meta>}n{/Meta}");
    await user.type(screen.getByPlaceholderText("Describe the new chat or task..."), "Research Q3");
    await user.keyboard("{Enter}");

    const chatRequests = () => fetchMock.mock.calls.filter(([url]) => url === "/api/chat");
    await waitFor(() => expect(chatRequests()).toHaveLength(1));
    const [, init] = chatRequests()[0]!;
    expect(init).toBeDefined();
    const body = JSON.parse(String((init as RequestInit).body));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(body).toMatchObject({
      sessionId: null,
      model: DEFAULT_GOAT_MODEL,
      message: {
        role: "user",
        parts: [{ type: "text", text: "Research Q3" }],
      },
    });
    expect(body.message.id).toMatch(/^ui_background_/);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(
      screen.queryByPlaceholderText("Describe the new chat or task..."),
    ).not.toBeInTheDocument();
  });

  it("updates the URL when a new chat returns a session id", async () => {
    const user = userEvent.setup();
    chatMock.finishSessionId = "goat_chat_123";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask a question or describe a task..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/?chat=goat_chat_123");
    });
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

  it("renders assistant soft line breaks as visible line breaks", () => {
    const { container } = render(
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
              parts: [{ type: "text", text: "First line\nSecond line\nThird line" }],
            },
          ],
        }}
      />,
    );

    const paragraph = container.querySelector(".session-markdown p");
    expect(paragraph?.textContent).toBe("First line\nSecond line\nThird line");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(2);
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
    expect(screen.getByText("TASK-42 · Queued")).toBeInTheDocument();
  });

  it("renders current task status from task state instead of start_task output", () => {
    render(
      <GoatSurface
        tasks={[
          taskView({
            id: "task_1",
            displayId: "TASK-42",
            name: "Research market",
            status: "failed",
            stage: "failed",
            error: "Runner failed.",
          }),
        ]}
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

    expect(screen.getByText("TASK-42 · Failed")).toBeInTheDocument();
    expect(screen.queryByText(/Task running/i)).not.toBeInTheDocument();
  });

  it("renders a metadata-only task card from the task state lookup", () => {
    render(
      <GoatSurface
        tasks={[
          taskView({
            id: "task_1",
            displayId: "TASK-42",
            name: "Research market",
            status: "succeeded",
            stage: "completed",
          }),
        ]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1", taskId: "task_1" },
              parts: [{ type: "text", text: "Added it to Results." }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Added it to Results.")).toBeInTheDocument();
    const taskCard = screen.getByRole("link", { name: /Research market/ });
    expect(taskCard).toHaveAttribute("href", "/tasks/TASK-42");
    expect(screen.getByText("TASK-42 · Done")).toBeInTheDocument();
  });

  it("uses a neutral fallback when only the task id is known", () => {
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
              metadata: { sessionId: "chat_1", taskId: "task_unknown" },
              parts: [],
            },
          ],
        }}
      />,
    );

    const taskCard = screen.getByRole("link", { name: /Status pending/ });
    expect(taskCard).toHaveAttribute("href", "/tasks/task_unknown");
    expect(screen.getByText("Task · Status pending")).toBeInTheDocument();
    expect(screen.queryByText(/Task running/i)).not.toBeInTheDocument();
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
                    command: "query",
                    flags: {
                      text: "hiring",
                      limit: 5,
                    },
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
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("goat_brain query --text hiring --limit 5")).toBeInTheDocument();
    expect(intro.compareDocumentPosition(toolRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders unfinished tool calls from stopped assistant turns as stopped", () => {
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
              metadata: { sessionId: "chat_1", aborted: true },
              parts: [
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_1",
                  state: "input-available",
                  input: {
                    command: "query",
                    flags: {
                      text: "hiring",
                    },
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    const toolRow = screen.getByTestId("chat-tool-call-goat_brain");

    expect(within(toolRow).getByText("stopped")).toBeInTheDocument();
    expect(within(toolRow).queryByText("running")).not.toBeInTheDocument();
  });

  it("renders expandable completed and failed brain tool calls", async () => {
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
              parts: [
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_1",
                  state: "output-available",
                  input: {
                    command: "create",
                    flags: {
                      id: "louis-morgner",
                      title: "Louis Morgner",
                      type: "person",
                      json: true,
                    },
                    stdin: "Louis Morgner is a person.",
                  },
                  output: {
                    ok: false,
                    exitCode: 1,
                    command:
                      'create --id louis-morgner --title "Louis Morgner" --type person --json --source-ref goat-chat:user_message_1',
                    argv: [
                      "create",
                      "--id",
                      "louis-morgner",
                      "--title",
                      "Louis Morgner",
                      "--type",
                      "person",
                      "--json",
                      "--source-ref",
                      "goat-chat:user_message_1",
                    ],
                    stdout: JSON.stringify({
                      ok: true,
                      applied: [{ id: "louis-morgner" }],
                    }),
                    parsed: {
                      ok: true,
                      applied: [{ id: "louis-morgner" }],
                    },
                    stderr: "",
                  },
                },
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_2",
                  state: "output-available",
                  input: { command: "rewrite", flags: { id: "bad-id", truth: "Noop" } },
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

    const brainCalls = screen.getAllByTestId("chat-tool-call-goat_brain");
    expect(brainCalls).toHaveLength(2);
    expect(screen.getByText("Ingested 1 brain change.")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("Document was not found.")).toBeInTheDocument();

    const firstBrainCall = brainCalls[0]!;
    expect(within(firstBrainCall).queryByText("Input")).not.toBeInTheDocument();

    await user.click(within(firstBrainCall).getByRole("button", { name: /Brain/i }));

    expect(within(firstBrainCall).getByText("Input")).toBeInTheDocument();
    expect(within(firstBrainCall).getByText("Command")).toBeInTheDocument();
    expect(within(firstBrainCall).getByText("Stdout")).toBeInTheDocument();
    expect(within(firstBrainCall).getByText("Parsed")).toBeInTheDocument();
    expect(within(firstBrainCall).getByText(/Louis Morgner is a person/)).toBeInTheDocument();
    expect(within(firstBrainCall).getByText(/goat-chat:user_message_1/)).toBeInTheDocument();
  });

  it("marks doctor health errors as a failed brain tool call", async () => {
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
              parts: [
                {
                  type: GOAT_BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_doctor",
                  state: "output-available",
                  input: { command: "doctor" },
                  output: {
                    ok: false,
                    exitCode: 1,
                    command: "doctor",
                    argv: ["doctor"],
                    stdout: "",
                    stderr:
                      "12 files checked - 2 error(s), 0 warning(s).\nERROR invalid bad-doc: Missing type.",
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    const doctorCall = screen.getByTestId("chat-tool-call-goat_brain");
    expect(within(doctorCall).getByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/12 files checked/)).toBeInTheDocument();

    await user.click(within(doctorCall).getByRole("button", { name: /Brain/i }));

    expect(within(doctorCall).getByText("Stderr")).toBeInTheDocument();
    expect(within(doctorCall).getByText(/Missing type/)).toBeInTheDocument();
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
