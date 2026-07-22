import "@testing-library/jest-dom/vitest";
import { CODEX_PLAN_TOOL_NAME, CODEX_QUESTION_TOOL_NAME } from "@opencompany/agent-runtime";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import { GOAT_HOME_NAVIGATION_EVENT } from "@/lib/chat-navigation";
import {
  GOAT_BRAIN_TOOL_PART_TYPE,
  type GoatChatMessageMetadata,
  type GoatChatSummaryView,
  type GoatChatUiMessage,
  type GoatCodexRuntimeView,
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
  finishWithSessionId: null as ((sessionId: string) => void) | null,
  sendError: null as Error | null,
  preparedRequestBodies: [] as unknown[],
  lastResume: null as boolean | null,
}));

const routerMock = vi.hoisted(() => ({
  prefetch: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

const pathnameMock = vi.hoisted(() => ({
  value: "/",
}));

const historyMock = vi.hoisted(() => ({
  replaceState: vi.fn(),
}));

const attachmentUploadMock = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock.value,
}));

vi.mock("@/lib/chat-actions", () => ({
  closeGoatChatSessionAction: vi.fn(async () => ({ ok: true, error: null })),
}));

vi.mock("@/lib/chat-attachment-upload", () => ({
  uploadGoatChatAttachmentBlob: attachmentUploadMock.upload,
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
      resume?: boolean;
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
      chatMock.lastResume = options.resume ?? false;
      const transportRef = React.useRef(options.transport);
      chatMock.finishWithSessionId = (sessionId: string) => {
        options.onFinish?.({
          message: {
            id: "assistant_1",
            role: "assistant",
            metadata: { sessionId },
            parts: [{ type: "text", text: "Done." }],
          },
        });
      };

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
          if (chatMock.sendError) throw chatMock.sendError;
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

function requestChatSessionId(init: RequestInit | undefined, fallback: string) {
  if (!init?.body) return fallback;
  const body = JSON.parse(String(init.body)) as {
    sessionId?: unknown;
    newSessionId?: unknown;
  };
  if (typeof body.newSessionId === "string") return body.newSessionId;
  if (typeof body.sessionId === "string") return body.sessionId;
  return fallback;
}

describe("GoatSurface chat streaming UI", () => {
  beforeEach(() => {
    pathnameMock.value = "/";
    chatMock.status = "ready";
    chatMock.finishSessionId = null;
    chatMock.finishWithSessionId = null;
    chatMock.sendError = null;
    chatMock.sendMessage.mockReset();
    chatMock.stop.mockReset();
    routerMock.prefetch.mockReset();
    chatMock.preparedRequestBodies = [];
    routerMock.refresh.mockReset();
    routerMock.replace.mockReset();
    historyMock.replaceState.mockReset();
    vi.spyOn(window.history, "replaceState").mockImplementation(historyMock.replaceState);
    vi.mocked(closeGoatChatSessionAction).mockClear();
    attachmentUploadMock.upload.mockReset();
    attachmentUploadMock.upload.mockResolvedValue({
      blobUrl: "https://blob.test/goat-chat/user_1/brief.pdf",
      blobPathname: "goat-chat/user_1/brief.pdf",
    });
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
    vi.restoreAllMocks();
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

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "Hello Goat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Hello Goat" });
    expect(textarea).toHaveValue("");
    expect(await screen.findAllByText("Hello Goat")).toHaveLength(2);
  });

  it("updates the URL without a server navigation and sends the reserved id", async () => {
    const user = userEvent.setup();
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start now");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const optimisticHref = historyMock.replaceState.mock.calls[0]?.[2];
    expect(optimisticHref).toMatch(
      /^\/chat\/goat_chat_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(historyMock.replaceState).toHaveBeenCalledWith(null, "", optimisticHref);
    const optimisticSessionId = String(optimisticHref).slice("/chat/".length);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      newSessionId: optimisticSessionId,
      model: DEFAULT_GOAT_MODEL,
    });
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("keeps the reserved detail URL and reuses its id when the first send is retried", async () => {
    const user = userEvent.setup();
    chatMock.sendError = new Error("network failed");
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Try again");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Reply...")).toHaveValue("Try again"));
    const firstRequest = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    expect(historyMock.replaceState).toHaveBeenCalledTimes(1);

    chatMock.sendError = null;
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(2));
    expect(chatMock.preparedRequestBodies[1]).toMatchObject({
      sessionId: null,
      newSessionId: firstRequest.newSessionId,
    });
    expect(historyMock.replaceState).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("resets and focuses the blank composer immediately when Home is requested", async () => {
    const user = userEvent.setup();
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [],
        }}
      />,
    );

    await user.type(screen.getByPlaceholderText("Reply..."), "Unsent draft");
    act(() => window.dispatchEvent(new Event(GOAT_HOME_NAVIGATION_EVENT)));

    const composer = screen.getByPlaceholderText("Ask Goat anything...");
    expect(composer).toHaveValue("");
    expect(composer).toHaveFocus();
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("does not reopen a new chat when its response arrives after Home was clicked", async () => {
    const user = userEvent.setup();
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    act(() => window.dispatchEvent(new Event(GOAT_HOME_NAVIGATION_EVENT)));
    act(() => chatMock.finishWithSessionId?.("goat_chat_returned_late"));

    expect(screen.getByPlaceholderText("Ask Goat anything...")).toHaveFocus();
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(historyMock.replaceState).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("keeps the painted composer overlay aligned with textarea scrolling", async () => {
    const user = userEvent.setup();
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "@codex inspect this long prompt");
    const overlay = textarea.previousElementSibling as HTMLDivElement | null;
    expect(overlay).toHaveAttribute("aria-hidden", "true");

    textarea.scrollTop = 48;
    fireEvent.scroll(textarea);
    expect(overlay?.scrollTop).toBe(48);

    textarea.scrollTop = 72;
    await user.type(textarea, " after resizing");
    expect(overlay?.scrollTop).toBe(72);
  });

  it("selects from the active goat model list and sends the chosen model", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.queryByText("Capability / Speed / Cost")).not.toBeInTheDocument();
    expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();
    expect(screen.getByText("Kimi K3")).toBeInTheDocument();
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.queryByText("GPT 5.4 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Codex")).not.toBeInTheDocument();

    await user.click(screen.getByText("Kimi K3"));
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Compare");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "moonshotai/kimi-k3",
    });
  });

  it("shows Local Codex only when the beta flag is enabled and submits to the local endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_local_1"),
          userMessageId: "goat_chat_msg_local_user",
          assistantMessageId: "goat_chat_msg_local_assistant",
          mode: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        localCodexBetaEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Local Codex"));
    expect(screen.queryByRole("button", { name: "Plan mode" })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Inspect");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/local-codex/messages", expect.any(Object)),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/local-codex/messages")!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      message: {
        id: expect.stringMatching(/^goat_chat_msg_/),
        role: "user",
        parts: [{ type: "text", text: "Inspect" }],
      },
      settings: {
        reasoningEffort: "medium",
        planModeEnabled: false,
        goalMode: null,
      },
    });
    expect(historyMock.replaceState).toHaveBeenCalledWith(null, "", `/chat/${body.newSessionId}`);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("shows the Codex engine only when Codex is connected", async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Cloud Codex sandbox")).not.toBeInTheDocument();
    unmount();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText("Cloud Codex sandbox")).toBeInTheDocument();
  });

  it("shows Codex controls only for Codex engine chats", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    expect(screen.queryByRole("button", { name: /Codex reasoning effort/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Goal mode" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));

    expect(
      screen.getByRole("button", { name: "Codex reasoning effort: XHigh (click to cycle)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Goal mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("submits Codex engine chats to the codex-chat endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
          userMessageId: "goat_chat_msg_codex_user",
          assistantMessageId: "goat_chat_msg_codex_assistant",
          mode: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    expect(screen.getByRole("button", { name: "Codex model: GPT 5.6 Sol" })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Clone my repo");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/codex-chat/messages")!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      message: {
        id: expect.stringMatching(/^goat_chat_msg_/),
        role: "user",
        parts: [{ type: "text", text: "Clone my repo" }],
      },
      settings: {
        reasoningEffort: "xhigh",
        planModeEnabled: false,
        goalMode: null,
      },
      model: "openai/gpt-5.6-sol",
    });
    expect(historyMock.replaceState).toHaveBeenCalledWith(null, "", `/chat/${body.newSessionId}`);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("submits selected Brain skills to cloud Codex", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/brain/skills") {
        return new Response(
          JSON.stringify({
            skills: [
              {
                brainRef: "goat_brain_1",
                id: "coding-work",
                name: "Coding work",
                description: "How coding work should happen.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
          userMessageId: "goat_chat_msg_codex_user",
          assistantMessageId: "goat_chat_msg_codex_assistant",
          mode: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "@skill/coding");
    await user.click(await screen.findByRole("option", { name: /coding work/i }));
    await user.type(textarea, "implement this");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    const postCall = fetchMock.mock.calls.find(([input]) => input === "/api/codex-chat/messages");
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body.message).toMatchObject({
      parts: [{ type: "text", text: "@skill/coding-work implement this" }],
      metadata: {
        mentions: [{ kind: "skill", brainRef: "goat_brain_1", id: "coding-work" }],
      },
    });
  });

  it("uploads files and includes them in cloud Codex message metadata", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
          userMessageId: "goat_chat_msg_codex_user",
          assistantMessageId: "goat_chat_msg_codex_assistant",
          mode: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
      },
    });
    await screen.findByText("PDF");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([url]) => url === "/api/codex-chat/messages")?.[1]?.body),
    );
    expect(body.message.metadata.attachments).toEqual([
      expect.objectContaining({
        kind: "pdf",
        filename: "brief.pdf",
        blobUrl: "https://blob.test/goat-chat/user_1/brief.pdf",
      }),
    ]);
  });

  it("restores a cloud Codex attachment when submission fails", async () => {
    const user = userEvent.setup();
    let rejectRequest: ((error: Error) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      ),
    );
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
      },
    });
    await screen.findByText("PDF");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.queryByText("brief.pdf")).not.toBeInTheDocument());
    act(() => rejectRequest?.(new Error("network failed")));

    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
  });

  it("submits Codex reasoning, plan, and goal settings", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
          userMessageId: "goat_chat_msg_codex_user",
          assistantMessageId: "goat_chat_msg_codex_assistant",
          mode: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    const reasoningControl = screen.getByRole("button", {
      name: "Codex reasoning effort: XHigh (click to cycle)",
    });
    await user.click(reasoningControl);
    await user.click(reasoningControl);
    await user.click(reasoningControl);
    await user.click(screen.getByRole("button", { name: "Plan mode" }));
    await user.click(screen.getByRole("button", { name: "Goal mode" }));
    await user.click(screen.getByRole("checkbox", { name: "Goal mode" }));
    await user.type(screen.getByPlaceholderText("Objective"), "Fix the flaky tests");
    await user.type(screen.getByPlaceholderText("Token budget"), "200000");
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Run the failing suite");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/codex-chat/messages")!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      settings: {
        reasoningEffort: "high",
        planModeEnabled: true,
        goalMode: {
          objective: "Fix the flaky tests",
          tokenBudget: 200000,
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });

  it("starts plan implementation as a default-mode Codex follow-up", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json(
        {
          ok: true,
          sessionId: "goat_chat_codex_1",
          userMessageId: "goat_chat_msg_implement_user",
          assistantMessageId: "goat_chat_msg_implement_assistant",
          mode: "started",
        },
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex plan",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          codexComposerSettings: {
            reasoningEffort: "high",
            planModeEnabled: true,
            goalMode: null,
          },
          messages: [
            {
              id: "assistant_plan",
              role: "assistant",
              metadata: { sessionId: "goat_chat_codex_1" },
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
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Implement plan" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/codex-chat/messages")!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      sessionId: "goat_chat_codex_1",
      message: { role: "user", parts: [{ type: "text", text: "Implement the plan." }] },
      settings: { reasoningEffort: "high", planModeEnabled: false, goalMode: null },
    });
  });

  it("posts an interactive Codex question answer to its durable interaction", async () => {
    const user = userEvent.setup();
    const interactionId = "goat_codex_chat_interaction_123e4567-e89b-12d3-a456-426614174000";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ ok: true }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex question",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "assistant_question",
              role: "assistant",
              metadata: { sessionId: "goat_chat_codex_1" },
              parts: [
                {
                  type: "dynamic-tool",
                  toolName: CODEX_QUESTION_TOOL_NAME,
                  toolCallId: "question_1",
                  state: "approval-requested",
                  input: {
                    label: "Question",
                    interactionId,
                    question: "Which scope?",
                    questions: [
                      {
                        id: "scope",
                        header: "Scope",
                        question: "Which scope?",
                        options: [{ label: "Foundational", description: "Harden everything." }],
                      },
                    ],
                  },
                } as GoatChatUiMessage["parts"][number],
              ],
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Foundational/ }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/codex-chat/interactions/${interactionId}`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => url === `/api/codex-chat/interactions/${interactionId}`,
    )!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      answers: { scope: { answers: ["Foundational"] } },
    });
  });

  it("opens existing Codex chats in codex mode without enabling resume", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        chatResumeEnabled
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          messages: [],
        }}
      />,
    );

    expect(chatMock.lastResume).toBe(false);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");
  });

  it("uses the task readiness status in the Codex detail header", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          codexRuntime: {
            status: "idle",
            error: null,
            updatedAt: currentTimestamp(),
          },
          messages: [],
        }}
      />,
    );

    expect(screen.getByLabelText("Codex status: Ready")).toHaveTextContent("Ready");
    expect(screen.queryByText("Sleeping")).not.toBeInTheDocument();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
  });

  it("shows the context token usage in a tooltip", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { contextTokens: 14_200 },
              parts: [{ type: "text", text: "Done." }],
            },
          ],
        }}
      />,
    );

    const contextMeter = screen.getByLabelText("Context window usage: 14k / 1M context · 1%");
    await user.hover(contextMeter);

    expect(await screen.findByText("14k / 1M context · 1%")).toBeVisible();
  });

  it("shows when a Codex chat is waiting for runner capacity", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          codexRuntime: {
            status: "queued",
            error: null,
            updatedAt: currentTimestamp(),
          },
          messages: [],
        }}
      />,
    );

    expect(screen.getByLabelText("Codex status: Queued")).toHaveTextContent("Queued");
  });

  it("restores Codex composer controls when returning to a Codex chat", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          codexComposerSettings: {
            reasoningEffort: "high",
            planModeEnabled: true,
            goalMode: { objective: "Fix flaky tests", tokenBudget: 200000 },
          },
          messages: [],
        }}
        recentChats={[
          {
            id: "goat_chat_codex_1",
            title: "Codex chat",
            model: DEFAULT_GOAT_MODEL,
            engine: "codex",
            preview: "Run the failing suite",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Codex reasoning effort: High (click to cycle)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Goal mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{Escape}");
    await nextAnimationFrame();
    await user.click(screen.getByRole("link", { name: /Codex chat/ }));

    expect(
      screen.getByRole("button", { name: "Codex reasoning effort: High (click to cycle)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Goal mode" }));
    expect(screen.getByRole("button", { name: "Goal mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByPlaceholderText("Objective")).toHaveValue("Fix flaky tests");
    expect(screen.getByPlaceholderText("Token budget")).toHaveValue("200000");
  });

  it("keeps existing local Codex chats read-only when the beta flag is disabled", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_local_1",
          title: "Local Codex",
          model: DEFAULT_GOAT_MODEL,
          engine: "local_codex",
          messages: [],
        }}
      />,
    );

    expect(
      screen.getByText(
        "Local Codex beta is disabled. Enable it in Goat Settings to use Local Codex.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("keeps using the returned chat session id when the AI SDK transport is long-lived", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "First message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const firstRequest = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    act(() => chatMock.finishWithSessionId?.(firstRequest.newSessionId));

    await user.type(screen.getByPlaceholderText("Reply..."), "Second message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies).toHaveLength(2);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: DEFAULT_GOAT_MODEL,
    });
    expect(chatMock.preparedRequestBodies[1]).toMatchObject({
      sessionId: firstRequest.newSessionId,
      model: DEFAULT_GOAT_MODEL,
    });
    expect(historyMock.replaceState).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
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

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
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

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
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

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
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

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
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

  it("selects, highlights, and reconciles multiple Brain skill mentions", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                brainRef: "goat_brain_1",
                id: "coding-work",
                name: "Coding work",
                description: "Use focused verification for code changes.",
              },
              {
                brainRef: "goat_brain_1",
                id: "writing-work",
                name: "Writing work",
                description: "Write clear product copy.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "@verification");
    const codingOption = await screen.findByRole("option", { name: /coding work/i });
    await user.click(codingOption);
    await user.type(textarea, "then @skill/writing");
    await user.click(await screen.findByRole("option", { name: /writing work/i }));

    expect(screen.getAllByTestId("selected-skill-mention")).toHaveLength(2);
    expect(textarea).toHaveValue("@skill/coding-work then @skill/writing-work ");

    fireEvent.change(textarea, { target: { value: "@skill/coding-work then continue" } });
    expect(screen.getAllByTestId("selected-skill-mention")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "@skill/coding-work then continue",
      metadata: {
        mentions: [{ kind: "skill", brainRef: "goat_brain_1", id: "coding-work" }],
      },
    });
  });

  it("resolves exact Brain skill mentions pasted into the composer", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                brainRef: "goat_brain_1",
                id: "product-feature",
                name: "Product feature",
                description: "Plan and shape a product feature.",
              },
              {
                brainRef: "goat_brain_1",
                id: "add-integration-to-main-chat",
                name: "Add integration to main chat",
                description: "Add a new integration to the main chat.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    const pastedText =
      "@skill/product-feature use @skill/add-integration-to-main-chat to add attio";
    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (format: string) => (format === "text/plain" ? pastedText : ""),
        items: [],
      },
    });

    expect(textarea).toHaveValue(pastedText);
    expect(await screen.findAllByTestId("selected-skill-mention")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: pastedText,
      metadata: {
        mentions: [
          { kind: "skill", brainRef: "goat_brain_1", id: "product-feature" },
          {
            kind: "skill",
            brainRef: "goat_brain_1",
            id: "add-integration-to-main-chat",
          },
        ],
      },
    });
  });

  it("retries the Brain skill catalog on the next mention-menu open after a failed fetch", async () => {
    const user = userEvent.setup();
    let catalogCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/brain/skills") {
        catalogCalls += 1;
        if (catalogCalls === 1) return new Response("nope", { status: 500 });
        return new Response(
          JSON.stringify({
            skills: [
              {
                brainRef: "goat_brain_1",
                id: "coding-work",
                name: "Coding work",
                description: "Use focused verification for code changes.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "@coding");
    await waitFor(() => expect(catalogCalls).toBe(1));
    expect(screen.queryByRole("option", { name: /coding work/i })).not.toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, "@coding");
    await screen.findByRole("option", { name: /coding work/i });
    expect(catalogCalls).toBe(2);
  });

  it("does not offer Brain skills in Local Codex mode", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        localCodexBetaEnabled
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Local Codex"));
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "@skill/coding");

    await new Promise((resolve) => setTimeout(resolve, 120));
    // The credit-balance hook fetches on mount; no skill-catalog request may fire.
    const skillCatalogCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).startsWith("/api/billing/balance"),
    );
    expect(skillCatalogCalls).toHaveLength(0);
    expect(screen.queryByRole("listbox", { name: "Mention menu" })).not.toBeInTheDocument();
  });

  it("keeps a completed new chat visible while server props refresh", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Hello Goat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findAllByText("Hello Goat")).toHaveLength(2);
    expect(screen.queryByText("No results yet.")).not.toBeInTheDocument();
  });

  it("keeps the home screen clean when there is no activity", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userName="Louis"
      />,
    );

    expect(screen.getByText("welcome back, Louis")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Routines" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Results" })).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No recurring tasks yet.")).not.toBeInTheDocument();
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
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    const chatLink = screen.getByRole("link", { name: /Market research/ });
    expect(chatLink).toHaveAttribute("href", "/chat/chat_1");
    expect(screen.getByText("Compare the latest pricing.")).toBeInTheDocument();
  });

  it("projects Cloud Codex sessions into Tasks without duplicating them in Chats", () => {
    const { container } = render(
      <GoatSurface
        taskSpawningEnabled
        tasks={[taskView({ id: "task_1", name: "Prepare report" })]}
        schedules={[
          {
            id: "schedule_1",
            name: "Monday update",
            sourceDescription: "Every Monday",
            cron: "0 9 * * 1",
            timezone: "Europe/Berlin",
            prompt: "Prepare the weekly update",
            enabled: true,
            lastRunAt: null,
            nextRunAt: "2026-07-20T07:00:00.000Z",
            createdAt: currentTimestamp(),
            updatedAt: currentTimestamp(),
          },
        ]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          codexChatSummary({ id: "codex_1", title: "Fix deployment" }),
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_GOAT_MODEL,
            engine: "opencompany",
            preview: "Compare the latest pricing.",
            updatedAt: currentTimestamp(),
          },
          {
            id: "local_1",
            title: "Local cleanup",
            model: DEFAULT_GOAT_MODEL,
            engine: "local_codex",
            preview: "Clean local files.",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    const tasksSection = screen.getByRole("heading", { name: "Tasks" }).closest("section");
    const chatsSection = screen.getByRole("heading", { name: "Chats" }).closest("section");
    expect(tasksSection).not.toBeNull();
    expect(chatsSection).not.toBeNull();
    expect(within(tasksSection!).getByRole("link", { name: /Fix deployment/ })).toHaveAttribute(
      "href",
      "/chat/codex_1",
    );
    expect(within(tasksSection!).getByRole("link", { name: /Prepare report/ })).toHaveAttribute(
      "href",
      "/tasks/TASK-1",
    );
    expect(within(tasksSection!).getByText("Codex · Ready")).toBeInTheDocument();
    expect(
      within(tasksSection!).getByRole("img", { name: "Codex task status: Ready" }),
    ).toHaveClass("bg-success");
    expect(within(chatsSection!).queryByText("Fix deployment")).not.toBeInTheDocument();
    expect(within(chatsSection!).getByText("Market research")).toBeInTheDocument();
    expect(within(chatsSection!).getByText("Local cleanup")).toBeInTheDocument();
    expect(
      within(container)
        .getAllByRole("heading")
        .map((heading) => heading.textContent)
        .filter((heading) => ["Tasks", "Chats", "Routines"].includes(heading ?? "")),
    ).toEqual(["Tasks", "Chats", "Routines"]);
  });

  it("shows Cloud Codex tasks when background task spawning is disabled", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[codexChatSummary()]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Codex task/ })).toHaveAttribute(
      "href",
      "/chat/goat_chat_codex_1",
    );
  });

  it("renders every Cloud Codex task status with text and an accessible dot", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          codexChatSummary({ id: "queued", title: "Queued task", status: "queued" }),
          codexChatSummary({ id: "starting", title: "Starting task", status: "starting" }),
          codexChatSummary({ id: "running", title: "Working task", status: "running" }),
          codexChatSummary({ id: "ready", title: "Ready task", status: "idle" }),
          codexChatSummary({
            id: "error",
            title: "Failed task",
            status: "idle",
            error: "The repository could not be cloned.",
          }),
          codexChatSummary({ id: "failed", title: "Failed runtime", status: "failed" }),
          codexChatSummary({ id: "stopped", title: "Stopped task", status: "interrupted" }),
          codexChatSummary({ id: "connecting", title: "Connecting task", status: null }),
          codexChatSummary({ id: "closed", title: "Closed task", status: "closed" }),
        ]}
      />,
    );

    for (const label of ["Queued", "Starting", "Working", "Ready", "Stopped", "Connecting"]) {
      expect(screen.getByRole("img", { name: `Codex task status: ${label}` })).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`Codex · ${label}`))).toBeInTheDocument();
    }
    expect(screen.getAllByRole("img", { name: "Codex task status: Needs attention" })).toHaveLength(
      2,
    );
    expect(screen.getByText(/The repository could not be cloned/)).toBeInTheDocument();
    expect(screen.queryByText("Closed task")).not.toBeInTheDocument();
  });

  it("updates a Cloud Codex task from Working to Ready without a route refresh", () => {
    const renderSurface = (status: GoatCodexRuntimeView["status"]) => (
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[codexChatSummary({ status })]}
      />
    );
    const { rerender } = render(renderSurface("running"));

    expect(screen.getByRole("img", { name: "Codex task status: Working" })).toBeInTheDocument();
    rerender(renderSurface("idle"));
    expect(screen.getByRole("img", { name: "Codex task status: Ready" })).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("keeps active and pinned Codex tasks visible and sorts active work first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T17:44:00.000Z"));
    try {
      render(
        <GoatSurface
          tasks={[]}
          defaultModel={DEFAULT_GOAT_MODEL}
          initialChat={null}
          recentChats={[
            codexChatSummary({
              id: "recent_ready",
              title: "Recent ready",
              status: "idle",
              updatedAt: "2026-07-04T17:00:00.000Z",
            }),
            codexChatSummary({
              id: "old_running",
              title: "Old but working",
              status: "running",
              updatedAt: "2026-07-01T17:00:00.000Z",
            }),
            codexChatSummary({
              id: "old_pinned",
              title: "Pinned ready",
              status: "idle",
              updatedAt: "2026-07-01T17:00:00.000Z",
              pinnedAt: "2026-07-04T12:00:00.000Z",
            }),
            codexChatSummary({
              id: "old_hidden",
              title: "Old hidden",
              status: "idle",
              updatedAt: "2026-07-01T17:00:00.000Z",
            }),
          ]}
        />,
      );

      const tasksSection = screen.getByRole("heading", { name: "Tasks" }).closest("section");
      const links = within(tasksSection!).getAllByRole("link");
      expect(links[0]).toHaveTextContent("Old but working");
      expect(within(tasksSection!).getByText("Pinned ready")).toBeInTheDocument();
      expect(within(tasksSection!).queryByText("Old hidden")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefetches recent chats and task results before navigation", async () => {
    const user = userEvent.setup();
    render(
      <GoatSurface
        taskSpawningEnabled
        tasks={[
          {
            id: "task_1",
            displayId: "TASK-1",
            name: "Run market report",
            prompt: "Write a report",
            model: DEFAULT_GOAT_MODEL,
            status: "succeeded",
            stage: "completed",
            result: "Done",
            error: null,
            archivedAt: null,
            createdAt: currentTimestamp(),
            updatedAt: currentTimestamp(),
          },
        ]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_GOAT_MODEL,
            preview: "Compare the latest pricing.",
            updatedAt: currentTimestamp(),
          },
          codexChatSummary({
            id: "codex_chat_1",
            title: "Fix deployment",
            status: "idle",
            updatedAt: currentTimestamp(),
          }),
        ]}
      />,
    );

    await user.hover(screen.getByRole("link", { name: /Market research/ }));
    await user.hover(screen.getByRole("link", { name: /Fix deployment/ }));
    await user.hover(screen.getByRole("link", { name: /Run market report/ }));

    expect(routerMock.prefetch).toHaveBeenCalledWith("/chat/chat_1");
    expect(routerMock.prefetch).toHaveBeenCalledWith("/chat/codex_chat_1");
    expect(routerMock.prefetch).toHaveBeenCalledWith("/tasks/TASK-1");
  });

  it("hides home chats and results older than one day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T17:44:00.000Z"));
    try {
      render(
        <GoatSurface
          taskSpawningEnabled
          tasks={[
            taskView({
              id: "recent_task",
              displayId: "TASK-1",
              name: "Recent result",
              createdAt: "2026-07-04T10:00:00.000Z",
              updatedAt: "2026-07-04T10:00:00.000Z",
            }),
            taskView({
              id: "old_task",
              displayId: "TASK-2",
              name: "Old result",
              createdAt: "2026-07-02T10:00:00.000Z",
              updatedAt: "2026-07-02T10:00:00.000Z",
            }),
          ]}
          defaultModel={DEFAULT_GOAT_MODEL}
          initialChat={null}
          recentChats={[
            {
              id: "recent_chat",
              title: "Recent chat",
              model: DEFAULT_GOAT_MODEL,
              preview: "Visible",
              updatedAt: "2026-07-04T10:00:00.000Z",
            },
            {
              id: "old_chat",
              title: "Old chat",
              model: DEFAULT_GOAT_MODEL,
              preview: "Hidden",
              updatedAt: "2026-07-02T10:00:00.000Z",
            },
          ]}
        />,
      );

      expect(screen.getByText("Recent chat")).toBeInTheDocument();
      expect(screen.queryByText("Old chat")).not.toBeInTheDocument();
      expect(screen.getByText("Recent result")).toBeInTheDocument();
      expect(screen.queryByText("Old result")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives a chat from the home list", async () => {
    const user = userEvent.setup();
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
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive Market research" }));

    expect(closeGoatChatSessionAction).toHaveBeenCalledWith("chat_1");
    expect(screen.queryByText("Market research")).not.toBeInTheDocument();
  });

  it("opens the new chat command with Cmd+K and starts a background chat", async () => {
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

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      screen.getByPlaceholderText("Search chats or describe a new one..."),
      "Research Q3",
    );
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
      screen.queryByPlaceholderText("Search chats or describe a new one..."),
    ).not.toBeInTheDocument();
  });

  it("does not navigate or refresh when the stream confirms the reserved session id", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const request = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    act(() => chatMock.finishWithSessionId?.(request.newSessionId));

    expect(historyMock.replaceState).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("does not route back to chat when a turn finishes after navigating away", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />,
    );

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    pathnameMock.value = "/brain";
    rerender(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    act(() => {
      chatMock.finishWithSessionId?.("goat_chat_123");
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
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

  it("keeps chat closed while server props refresh after Escape", async () => {
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

    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close chat" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await nextAnimationFrame();

    expect(screen.queryByText("Earlier answer")).not.toBeInTheDocument();
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
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
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("disables input and exposes a stop button while streaming", async () => {
    const user = userEvent.setup();
    chatMock.status = "streaming";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    expect(screen.getByPlaceholderText("Ask Goat anything...")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(chatMock.stop).toHaveBeenCalledTimes(1);
  });

  it("shows a live elapsed timer while streaming before assistant output arrives", () => {
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

    expect(screen.getByRole("status", { name: "Goat is working" })).toBeInTheDocument();
    expect(screen.getByText(/^\d+\.\ds$/)).toBeInTheDocument();
  });

  it("keeps the live elapsed timer visible once assistant output is visible", () => {
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
    expect(screen.getByRole("status", { name: "Goat is working" })).toBeInTheDocument();
    expect(screen.getByText(/^\d+\.\ds$/)).toBeInTheDocument();
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

  it("renders the final elapsed time for completed assistant turns", () => {
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
              metadata: {
                sessionId: "chat_1",
                timing: { durationMs: 153_400 },
              },
              parts: [{ type: "text", text: "Streaming answer" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Streaming answer")).toBeInTheDocument();
    expect(screen.getByLabelText("Turn completed in 2m, 33.4s")).toBeInTheDocument();
    expect(screen.getByText("2m, 33.4s")).toBeInTheDocument();
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
        taskSpawningEnabled
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
        taskSpawningEnabled
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

    expect(within(toolRow).getByText("Brain")).toBeInTheDocument();
    expect(within(toolRow).getByText("running")).toBeInTheDocument();
    expect(
      within(toolRow).getByText("goat_brain query --text hiring --limit 5"),
    ).toBeInTheDocument();
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
          taskSpawningEnabled
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
  const now = currentTimestamp();
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function codexChatSummary(
  overrides: Partial<Omit<GoatChatSummaryView, "codexRuntime">> & {
    status?: GoatCodexRuntimeView["status"] | null;
    error?: string | null;
  } = {},
): GoatChatSummaryView {
  const now = currentTimestamp();
  const { status = "idle", error = null, ...summaryOverrides } = overrides;
  const updatedAt = summaryOverrides.updatedAt ?? now;
  return {
    id: "goat_chat_codex_1",
    title: "Codex task",
    model: DEFAULT_GOAT_MODEL,
    engine: "codex",
    preview: "Codex is working on the repository.",
    updatedAt,
    pinnedAt: null,
    codexRuntime: status ? { status, error, updatedAt } : null,
    ...summaryOverrides,
  };
}

function currentTimestamp() {
  return new Date().toISOString();
}

async function nextAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
