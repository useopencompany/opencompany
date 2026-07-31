import "@testing-library/jest-dom/vitest";
import { CODEX_PLAN_TOOL_NAME, CODEX_QUESTION_TOOL_NAME } from "@opencompany/agent-runtime";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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
  START_WORKFLOW_TOOL_PART_TYPE,
  WEB_FETCH_TOOL_PART_TYPE,
  WEB_SEARCH_TOOL_PART_TYPE,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  buildGoatOnboardingKickoffPrompt,
  queueGoatOnboardingKickoff,
} from "@/lib/onboarding-kickoff";
import { cancelGoatTaskAction, continueGoatTaskAction } from "@/lib/tasks";
import { GoatSurface, type GoatTaskView } from "./GoatSurface";

const chatMock = vi.hoisted(() => ({
  status: "ready" as "ready" | "submitted" | "streaming" | "error",
  sendMessage: vi.fn(),
  stop: vi.fn(),
  finishSessionId: null as string | null,
  startWithSessionId: null as ((sessionId: string, model: string) => void) | null,
  finishWithSessionId: null as ((sessionId: string, model?: string) => void) | null,
  sendError: null as Error | null,
  preparedRequestBodies: [] as unknown[],
  lastResume: null as boolean | null,
}));

const routerMock = vi.hoisted(() => ({
  prefetch: vi.fn(),
  push: vi.fn(),
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
  markGoatChatSeenAction: vi.fn(async () => ({ ok: true, error: null })),
}));

// Server action module; importing it for real drags authkit into jsdom.
vi.mock("@/lib/integration-account-actions", () => ({
  alwaysAllowGoatChatActionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/chat-attachment-upload", () => ({
  uploadGoatChatAttachmentBlob: attachmentUploadMock.upload,
}));

vi.mock("@/lib/tasks", () => ({
  archiveGoatTaskAction: vi.fn(async () => ({ ok: true, error: null })),
  cancelGoatTaskAction: vi.fn(async () => ({ ok: true, error: null })),
  continueGoatTaskAction: vi.fn(async (_taskId: string, _prompt: string, messageId: string) => ({
    ok: true,
    error: null,
    messageId,
  })),
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
      chatMock.startWithSessionId = (sessionId: string, model: string) => {
        setMessages((current) => [
          ...current,
          {
            id: "assistant_1",
            role: "assistant",
            metadata: { sessionId, model },
            parts: [],
          },
        ]);
      };
      chatMock.finishWithSessionId = (sessionId: string, model?: string) => {
        options.onFinish?.({
          message: {
            id: "assistant_1",
            role: "assistant",
            metadata: { sessionId, ...(model ? { model } : {}) },
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
    window.localStorage.clear();
    window.sessionStorage.clear();
    pathnameMock.value = "/";
    chatMock.status = "ready";
    chatMock.finishSessionId = null;
    chatMock.startWithSessionId = null;
    chatMock.finishWithSessionId = null;
    chatMock.sendError = null;
    chatMock.sendMessage.mockReset();
    chatMock.stop.mockReset();
    routerMock.prefetch.mockReset();
    chatMock.preparedRequestBodies = [];
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    routerMock.replace.mockReset();
    historyMock.replaceState.mockReset();
    vi.spyOn(window.history, "replaceState").mockImplementation(historyMock.replaceState);
    vi.mocked(closeGoatChatSessionAction).mockClear();
    vi.mocked(cancelGoatTaskAction).mockClear();
    vi.mocked(continueGoatTaskAction).mockClear();
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

  it("continues a session-backed workflow task through the same chat composer", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_task_1",
          title: "Morning workflow",
          model: DEFAULT_GOAT_MODEL,
          engine: "opencompany",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
            {
              id: "task_assistant_1",
              role: "assistant",
              parts: [{ type: "text", text: "The workflow is complete." }],
            },
          ],
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "succeeded",
          startedAtMs: Date.now(),
          sessionBacked: true,
        }}
      />,
    );

    expect(screen.getByText("Morning workflow")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("The workflow is complete.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /share/i })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Reply..."), "Please check the afternoon too");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(continueGoatTaskAction).toHaveBeenCalledWith(
        "goat_task_1",
        "Please check the afternoon too",
        expect.stringMatching(/^goat_chat_msg_[0-9a-f-]{36}$/),
      ),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Please check the afternoon too")).toBeInTheDocument();
  });

  it("uses the chat stop control for an active workflow task", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
          ],
          codexRuntime: {
            status: "running",
            error: null,
            updatedAt: new Date().toISOString(),
          },
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "running",
          startedAtMs: Date.now(),
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Interrupt Codex" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(cancelGoatTaskAction).toHaveBeenCalledWith("goat_task_1");
    expect(chatMock.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Stopping task…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stopping task" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();

    rerender(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
          ],
          codexRuntime: {
            status: "interrupted",
            error: null,
            updatedAt: new Date().toISOString(),
          },
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "canceled",
          startedAtMs: Date.now(),
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Stopping task…" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("restores the task stop control when cancellation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(cancelGoatTaskAction).mockResolvedValueOnce({
      ok: false,
      error: "Could not stop task.",
    });

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_GOAT_MODEL,
          engine: "codex",
          messages: [],
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "running",
          startedAtMs: Date.now(),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Stop response" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument(),
    );
  });

  it("consumes the onboarding kickoff and sends it once through main chat", async () => {
    const companyUrl = "https://opencompany.ai/";
    expect(queueGoatOnboardingKickoff(companyUrl)).toBe(true);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 0),
    );

    const { rerender } = render(
      <StrictMode>
        <GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />
      </StrictMode>,
    );

    const prompt = buildGoatOnboardingKickoffPrompt(companyUrl);
    await waitFor(() => expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: prompt }));
    expect(chatMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "moonshotai/kimi-k3",
    });

    rerender(
      <StrictMode>
        <GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />
      </StrictMode>,
    );
    expect(chatMock.sendMessage).toHaveBeenCalledTimes(1);
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

  it("submits Shift+Enter from the main composer as a foreground chat", async () => {
    const user = userEvent.setup();
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start now");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const optimisticHref = historyMock.replaceState.mock.calls[0]?.[2];
    expect(optimisticHref).toMatch(/^\/chat\/goat_chat_/);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      newSessionId: String(optimisticHref).slice("/chat/".length),
      model: DEFAULT_GOAT_MODEL,
    });
    expect(screen.getByPlaceholderText("Reply...")).toBeInTheDocument();
    expect(screen.queryByText("welcome back, there")).not.toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalled();
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

    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();

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

  it("renders composer input as native textarea text", async () => {
    const user = userEvent.setup();
    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    await user.type(textarea, "@codex inspect this long prompt");
    expect(textarea).toHaveClass("text-ink");
    expect(textarea).not.toHaveClass("text-transparent");
    expect(textarea.parentElement?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("selects from the active goat model list and sends the chosen model", async () => {
    const user = userEvent.setup();

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const modelPicker = screen.getByRole("button", { name: "Model" });
    expect(modelPicker).toHaveTextContent("Kimi K3");
    await user.click(modelPicker);

    expect(screen.queryByText("Capability / Speed / Cost")).not.toBeInTheDocument();
    expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();
    expect(screen.getAllByText("Kimi K3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.queryByText("GPT 5.4 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Codex")).not.toBeInTheDocument();

    await user.click(screen.getByText("Claude Opus 4.8"));
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Compare");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "anthropic/claude-opus-4.8",
    });
  });

  it("shows Auto only behind its flag and adopts the routed model when the first turn starts", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Picks once from your first message")).not.toBeInTheDocument();

    rerender(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        autoModelRoutingEnabled
      />,
    );
    await user.click(screen.getByText("Picks once from your first message"));
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Auto");

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "What is 2 + 2?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies[0]).toMatchObject({ model: "auto" });
    const sessionId = (chatMock.preparedRequestBodies[0] as { newSessionId: string }).newSessionId;
    act(() => chatMock.startWithSessionId?.(sessionId, "moonshotai/kimi-k2.6"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K2.6"),
    );
    expect(screen.getByRole("button", { name: "Model" })).toBeDisabled();
  });

  it("remembers the last main chat model when returning Home and remounting", async () => {
    const user = userEvent.setup();
    const props = {
      tasks: [],
      defaultModel: DEFAULT_GOAT_MODEL,
      initialChat: null,
      userWorkosId: "user_1",
    } as const;
    const { unmount } = render(<GoatSurface {...props} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Claude Sonnet 5"));
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Use Sonnet");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    act(() => window.dispatchEvent(new Event(GOAT_HOME_NAVIGATION_EVENT)));

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5");

    unmount();
    render(<GoatSurface {...props} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5"),
    );
  });

  it("keeps a new session's model fixed when another tab changes the Home preference", async () => {
    const user = userEvent.setup();
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userWorkosId="user_1"
      />,
    );

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Start with Kimi");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const modelPicker = screen.getByRole("button", { name: "Model" });
    expect(modelPicker).toHaveTextContent("Kimi K3");
    expect(modelPicker).toBeDisabled();

    const storageKey = "opencompany-goat-main-chat-selection:user_1";
    window.localStorage.setItem(storageKey, "anthropic/claude-sonnet-5");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          newValue: "anthropic/claude-sonnet-5",
          storageArea: window.localStorage,
        }),
      );
    });

    expect(modelPicker).toHaveTextContent("Kimi K3");

    act(() => window.dispatchEvent(new Event(GOAT_HOME_NAVIGATION_EVENT)));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5"),
    );
    expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
  });

  it("remembers the last main chat engine across a Home reset and remounting", async () => {
    const user = userEvent.setup();
    const sharedProps = {
      tasks: [],
      defaultModel: DEFAULT_GOAT_MODEL,
      codexConnected: true,
      userWorkosId: "user_1",
    } as const;
    const { unmount } = render(<GoatSurface {...sharedProps} initialChat={null} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    act(() => window.dispatchEvent(new Event(GOAT_HOME_NAVIGATION_EVENT)));

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");

    unmount();
    render(<GoatSurface {...sharedProps} initialChat={null} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex"),
    );
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

  it("selects a Claude model and submits per-turn reasoning effort", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: requestChatSessionId(init, "goat_chat_claude_1"),
          userMessageId: "goat_chat_msg_claude_user",
          assistantMessageId: "goat_chat_msg_claude_assistant",
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
        claudeCodeConnected
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Claude Code sandbox"));

    expect(
      screen.getByRole("button", { name: "Claude model: Claude Sonnet 5" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Claude reasoning effort: High (click to cycle)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Goal mode" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Claude model: Claude Sonnet 5" }));
    await user.click(screen.getByRole("option", { name: /Claude Haiku 4\.5/ }));
    expect(
      screen.queryByRole("button", { name: /Claude reasoning effort/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Claude model: Claude Haiku 4.5" }));
    await user.click(screen.getByRole("option", { name: /Claude Opus 4\.8/ }));
    await user.click(
      screen.getByRole("button", { name: "Claude reasoning effort: High (click to cycle)" }),
    );
    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "Inspect this repository");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/claude-chat/messages", expect.any(Object)),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/claude-chat/messages")!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: "anthropic/claude-opus-4.8",
      settings: { reasoningEffort: "xhigh" },
      message: {
        role: "user",
        parts: [{ type: "text", text: "Inspect this repository" }],
      },
    });
  });

  it("submits selected Brain skills to cloud Codex", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/skills") {
        return new Response(
          JSON.stringify({
            skills: [
              {
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
        mentions: [{ kind: "skill", id: "coding-work" }],
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

    const contextMeter = screen.getByLabelText("Context window usage: 14k / 1.0M context · 1%");
    await user.hover(contextMeter);

    expect(await screen.findByText("14k / 1.0M context · 1%")).toBeVisible();
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

  it("uses @codex as a one-shot model selection without changing the remembered model", async () => {
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
    window.localStorage.setItem("opencompany-goat-main-chat-selection:user_1", DEFAULT_GOAT_MODEL);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
    await user.type(textarea, "@");

    expect(screen.getByRole("listbox", { name: "Mention menu" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /@codex/i }));
    expect(textarea).toHaveValue("@codex ");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");
    expect(screen.getByRole("button", { name: "Codex model: GPT 5.6 Sol" })).toBeInTheDocument();

    await user.type(textarea, "check repo access");
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
        role: "user",
        parts: [{ type: "text", text: "@codex check repo access" }],
      },
      model: "openai/gpt-5.6-sol",
    });
    expect(window.localStorage.getItem("opencompany-goat-main-chat-selection:user_1")).toBe(
      DEFAULT_GOAT_MODEL,
    );

    await user.keyboard("{Escape}");
    await nextAnimationFrame();

    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
  });

  it("starts a selected workflow in the background without creating a chat turn", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills") {
        return Response.json({ skills: [] });
      }
      if (url === "/api/workflows" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Morning Test",
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/workflows") {
        return Response.json({
          workflows: [
            {
              id: "morning-test",
              name: "Morning Test",
              description: "Run the morning checks.",
            },
          ],
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [],
        }}
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    await user.type(textarea, "#");
    await user.click(await screen.findByRole("option", { name: /Morning Test/i }));
    expect(textarea).toHaveValue("#morning-test ");
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(overlay?.querySelectorAll('[data-goat-chat-mention="workflow"]')).toHaveLength(1);
    expect(overlay).toHaveTextContent("#morning-test");
    expect(textarea).toHaveClass("text-transparent");
    await user.type(textarea, "run today's checks");
    await user.type(textarea, "{Enter}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, request] = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/workflows" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(request?.body))).toEqual({
      workflow: {
        kind: "workflow",
        id: "morning-test",
      },
      description: "#morning-test run today's checks",
    });
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts a selected workflow with uploaded attachments", async () => {
    const user = userEvent.setup();
    attachmentUploadMock.upload.mockResolvedValueOnce({
      blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
      blobPathname: "goat-chat/user_1/report.docx",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/workflows" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Morning Test",
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/workflows") {
        return Response.json({
          workflows: [
            {
              id: "morning-test",
              name: "Morning Test",
              description: "Run the morning checks.",
            },
          ],
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [],
        }}
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["doc"], "report.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
        ],
      },
    });
    await screen.findByText("report.docx");
    await screen.findByText("DOCX");

    const textarea = screen.getByPlaceholderText("Reply...");
    await user.type(textarea, "#");
    await user.click(await screen.findByRole("option", { name: /Morning Test/i }));
    await user.type(textarea, "summarize this report");
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, request] = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/workflows" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(request?.body))).toEqual({
      workflow: {
        kind: "workflow",
        id: "morning-test",
      },
      description: "#morning-test summarize this report",
      attachments: [
        expect.objectContaining({
          kind: "docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "report.docx",
          blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
          blobPathname: "goat-chat/user_1/report.docx",
        }),
      ],
    });
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("report.docx")).toBeNull());
  });

  it("offers workflow mentions when Codex is selected in the main composer", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/workflows" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Morning Test",
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/workflows") {
        return Response.json({
          workflows: [
            {
              id: "morning-test",
              name: "Morning Test",
              description: "Run the morning checks.",
            },
          ],
        });
      }
      return Response.json({
        ok: true,
        sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
        userMessageId: "goat_chat_msg_codex_user",
        assistantMessageId: "goat_chat_msg_codex_assistant",
        mode: "started",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));

    const textarea = screen.getByPlaceholderText("Ask a question or describe a task...");
    await user.type(textarea, "#");
    const workflowOption = await screen.findByRole("option", { name: /Morning Test/i });
    expect(screen.queryByRole("option", { name: /Ad-hoc task/i })).not.toBeInTheDocument();
    await user.click(workflowOption);

    await user.type(textarea, "run today's checks");
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, request] = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/workflows" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(request?.body))).toEqual({
      workflow: {
        kind: "workflow",
        id: "morning-test",
      },
      description: "#morning-test run today's checks",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/codex-chat/messages")).toBe(
      false,
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Ask a question or describe a task...")).toHaveValue("");
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts a typed #task request as an ad-hoc background task", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/workflows") return Response.json({ workflows: [] });
      if (url === "/api/tasks" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Research competitors",
            },
          },
          { status: 201 },
        );
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_GOAT_MODEL,
          messages: [],
        }}
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    await user.type(textarea, "#task research our three closest competitors");

    expect(textarea).toHaveValue("#task research our three closest competitors");
    expect(screen.getByTestId("ad-hoc-task-hint")).toHaveTextContent(
      "Sending starts this as an ad-hoc background task.",
    );
    await user.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, request] = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/tasks" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(request?.body))).toEqual({
      description: "#task research our three closest competitors",
      model: DEFAULT_GOAT_MODEL,
    });
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not load or offer workflow mentions when Tasks & Workflows is disabled", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/skills") return Response.json({ skills: [] });
      return Response.json({
        workflows: [
          {
            id: "morning-test",
            name: "Morning Test",
            description: "Run the morning checks.",
          },
        ],
      });
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

    await user.type(screen.getByPlaceholderText("Ask Goat anything..."), "#morning");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/skills")).toBe(true),
    );

    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/workflows")).toBe(false);
    expect(screen.queryByRole("option", { name: /Morning Test/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /#task/i })).not.toBeInTheDocument();
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
                id: "coding-work",
                name: "Coding work",
                description: "Use focused verification for code changes.",
              },
              {
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

    expect(textarea).toHaveValue("@skill/coding-work then @skill/writing-work ");
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(overlay?.querySelectorAll('[data-goat-chat-mention="skill"]')).toHaveLength(2);
    expect(overlay).toHaveTextContent("@skill/coding-work then @skill/writing-work");
    expect(textarea).toHaveClass("text-transparent");

    fireEvent.change(textarea, { target: { value: "@skill/coding-work then continue" } });
    expect(textarea).toHaveValue("@skill/coding-work then continue");
    const reconciledOverlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(reconciledOverlay?.querySelectorAll('[data-goat-chat-mention="skill"]')).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "@skill/coding-work then continue",
      metadata: {
        mentions: [{ kind: "skill", id: "coding-work" }],
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
                id: "product-feature",
                name: "Product feature",
                description: "Plan and shape a product feature.",
              },
              {
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

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: pastedText,
      metadata: {
        mentions: [
          { kind: "skill", id: "product-feature" },
          {
            kind: "skill",
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
      if (String(input) === "/api/skills") {
        catalogCalls += 1;
        if (catalogCalls === 1) return new Response("nope", { status: 500 });
        return new Response(
          JSON.stringify({
            skills: [
              {
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

  it("renders home chat state indicators", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          codexChatSummary({
            id: "working_chat",
            title: "Working chat",
            status: "running",
          }),
          {
            id: "unseen_chat",
            title: "Done unseen",
            model: DEFAULT_GOAT_MODEL,
            preview: "Ready to review.",
            updatedAt: currentTimestamp(),
            state: "done_unseen",
          },
          {
            id: "seen_chat",
            title: "Done seen",
            model: DEFAULT_GOAT_MODEL,
            preview: "Already opened.",
            updatedAt: currentTimestamp(),
            state: "done_seen",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /Working chat/ })).toHaveAttribute(
      "href",
      "/chat/working_chat",
    );
    expect(screen.getByRole("link", { name: /Done unseen/ })).toHaveAttribute(
      "href",
      "/chat/unseen_chat",
    );
    expect(screen.getByRole("link", { name: /Done seen/ })).toHaveAttribute(
      "href",
      "/chat/seen_chat",
    );
    expect(screen.getByTestId("home-chat-working")).toBeInTheDocument();
    expect(screen.getByTestId("home-chat-unseen")).toBeInTheDocument();
    expect(screen.getByTestId("home-chat-seen")).toBeInTheDocument();
  });

  it("keeps Codex and Claude Code sessions in Chats while Tasks show real tasks", () => {
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
          codexChatSummary({
            id: "claude_1",
            title: "Update docs",
            engine: "claude_code",
            preview: "Claude is updating the docs.",
          }),
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_GOAT_MODEL,
            engine: "opencompany",
            preview: "Compare the latest pricing.",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    const tasksSection = screen.getByRole("heading", { name: "Tasks" }).closest("section");
    const chatsSection = screen.getByRole("heading", { name: "Chats" }).closest("section");
    expect(tasksSection).not.toBeNull();
    expect(chatsSection).not.toBeNull();
    expect(within(tasksSection!).getByRole("link", { name: /Prepare report/ })).toHaveAttribute(
      "href",
      "/tasks/TASK-1",
    );
    expect(within(tasksSection!).queryByText("Fix deployment")).not.toBeInTheDocument();
    expect(within(tasksSection!).queryByText("Update docs")).not.toBeInTheDocument();
    expect(within(chatsSection!).getByRole("link", { name: /Fix deployment/ })).toHaveAttribute(
      "href",
      "/chat/codex_1",
    );
    expect(within(chatsSection!).getByRole("link", { name: /Update docs/ })).toHaveAttribute(
      "href",
      "/chat/claude_1",
    );
    expect(within(chatsSection!).getByText("Market research")).toBeInTheDocument();
    expect(
      within(container)
        .getAllByRole("heading")
        .map((heading) => heading.textContent)
        .filter((heading) => ["Tasks", "Chats", "Routines"].includes(heading ?? "")),
    ).toEqual(["Tasks", "Chats", "Routines"]);
  });

  it("shows Codex chats in Chats when background task spawning is disabled", () => {
    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[codexChatSummary()]}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Codex task/ })).toHaveAttribute(
      "href",
      "/chat/goat_chat_codex_1",
    );
  });

  it("renders coding workspaces only for persistent Codex and Claude Code chats", () => {
    const renderChat = (
      engine: "codex" | "claude_code" | "opencompany",
      taskConversation?: {
        taskId: string;
        status: "succeeded";
        startedAtMs: number;
      },
    ) =>
      render(
        <GoatSurface
          tasks={[]}
          defaultModel={DEFAULT_GOAT_MODEL}
          initialChat={{
            id: `goat_chat_${engine}`,
            title: `${engine} chat`,
            model: DEFAULT_GOAT_MODEL,
            engine,
            messages: [],
          }}
          {...(taskConversation ? { taskConversation } : {})}
        />,
      );

    const codex = renderChat("codex");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(screen.getByLabelText("Codex workspace")).toBeInTheDocument();
    codex.unmount();

    const claude = renderChat("claude_code");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(screen.getByLabelText("Claude Code workspace")).toBeInTheDocument();
    claude.unmount();

    const openCompany = renderChat("opencompany");
    expect(screen.queryByRole("button", { name: "Open workspace" })).not.toBeInTheDocument();
    openCompany.unmount();

    const backgroundTask = renderChat("opencompany", {
      taskId: "goat_task_1",
      status: "succeeded",
      startedAtMs: Date.now(),
    });
    expect(screen.queryByRole("button", { name: "Open workspace" })).not.toBeInTheDocument();
    backgroundTask.unmount();
  });

  it("keeps active and pinned coding chats visible outside the recent window", () => {
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

      const chatsSection = screen.getByRole("heading", { name: "Chats" }).closest("section");
      expect(chatsSection).not.toBeNull();
      expect(within(chatsSection!).getByText("Recent ready")).toBeInTheDocument();
      expect(within(chatsSection!).getByText("Old but working")).toBeInTheDocument();
      expect(within(chatsSection!).getByText("Pinned ready")).toBeInTheDocument();
      expect(within(chatsSection!).queryByText("Old hidden")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();
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

  it("opens the same composer as main chat with Cmd+K and starts a background chat without navigating", async () => {
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

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        userWorkosId="user_1"
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const quickComposerInput = screen.getByPlaceholderText(
      "Ask Goat anything, or describe a task...",
    );
    // Same controls as the main composer: model picker, attach button, submit button.
    expect(screen.getAllByLabelText("Model")).toHaveLength(2);
    expect(screen.getAllByLabelText("Attach files")).toHaveLength(2);
    await user.type(quickComposerInput, "Research Q3");
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
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(
      screen.queryByPlaceholderText("Ask Goat anything, or describe a task..."),
    ).not.toBeInTheDocument();
    // Never navigates away from the home screen it was opened on.
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("routes a dropped file only to the Cmd+K composer while the palette is open", async () => {
    const user = userEvent.setup();
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
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    const file = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    fireEvent.drop(window, {
      dataTransfer: {
        types: ["Files"],
        files: [file],
      },
    });

    await waitFor(() => expect(attachmentUploadMock.upload).toHaveBeenCalledTimes(1));
    expect(attachmentUploadMock.upload).toHaveBeenCalledWith("user_1", file, "application/pdf");
    expect(await within(dialog).findByText("PDF")).toBeInTheDocument();
  });

  it("submits Codex engine chats from Cmd+K in the background without adopting them into view", async () => {
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

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // The model picker's popover content portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));
    await user.type(
      within(dialog).getByPlaceholderText("Ask Goat anything, or describe a task..."),
      "Clone my repo",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/codex-chat/messages", expect.any(Object)),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/codex-chat/messages")!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Clone my repo" }] },
    });
    expect(body.newSessionId).toMatch(/^goat_chat_/);
    // Never adopted into the visible thread and never navigated to.
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers workflow mentions when Codex is selected in Cmd+K compose", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills") return Response.json({ skills: [] });
      if (url === "/api/workflows" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Morning Test",
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/workflows") {
        return Response.json({
          workflows: [
            {
              id: "morning-test",
              name: "Morning Test",
              description: "Run the morning checks.",
            },
          ],
        });
      }
      return Response.json({
        ok: true,
        sessionId: requestChatSessionId(init, "goat_chat_codex_1"),
        userMessageId: "goat_chat_msg_codex_user",
        assistantMessageId: "goat_chat_msg_codex_assistant",
        mode: "started",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));

    const quickComposerInput = within(dialog).getByPlaceholderText(
      "Ask Goat anything, or describe a task...",
    );
    await user.type(quickComposerInput, "#");
    const workflowOption = await within(dialog).findByRole("option", { name: /Morning Test/i });
    expect(within(dialog).queryByRole("option", { name: /Ad-hoc task/i })).not.toBeInTheDocument();
    await user.click(workflowOption);
    await user.type(quickComposerInput, "run today's checks");
    await user.click(within(dialog).getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, request] = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/workflows" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(request?.body))).toEqual({
      workflow: {
        kind: "workflow",
        id: "morning-test",
      },
      description: "#morning-test run today's checks",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/codex-chat/messages")).toBe(
      false,
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the Cmd+K composer open and the draft intact when goal mode settings are invalid", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // Popover content (model list, goal mode fields) portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));
    await user.click(within(dialog).getByRole("button", { name: "Goal mode" }));
    await user.click(screen.getByRole("checkbox", { name: "Goal mode" }));
    await user.type(screen.getByPlaceholderText("Objective"), "Fix the flaky tests");
    await user.type(screen.getByPlaceholderText("Token budget"), "abc");
    const quickComposerInput = within(dialog).getByPlaceholderText(
      "Ask Goat anything, or describe a task...",
    );
    await user.type(quickComposerInput, "Run the failing suite");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));

    // Invalid settings must be caught before the dialog closes or any request fires —
    // otherwise the draft is lost behind a misleading "started" toast (regression guard).
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/codex-chat/messages")).toBe(false);
    expect(routerMock.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(quickComposerInput).toHaveValue("Run the failing suite");
  });

  it("does not persist the Cmd+K model choice as the app-wide remembered model", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // The model picker's popover content portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));

    expect(window.localStorage.getItem("opencompany-goat-main-chat-selection:user_1")).toBeNull();
  });

  it("searches and jumps to an existing chat from the Cmd+K palette without affecting the quick composer", async () => {
    const user = userEvent.setup();

    render(
      <GoatSurface
        tasks={[]}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Q2 planning",
            model: DEFAULT_GOAT_MODEL,
            preview: "Let's plan Q2",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Search chats..."), "Q2 planning");
    const result = await within(dialog).findByText("Q2 planning");
    await user.click(result);

    expect(routerMock.push).toHaveBeenCalledWith("/chat/chat_1");
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

  it("allows drafting but blocks Enter submission while streaming", async () => {
    const user = userEvent.setup();
    chatMock.status = "streaming";

    render(<GoatSurface tasks={[]} defaultModel={DEFAULT_GOAT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask Goat anything...");
    expect(textarea).toBeEnabled();

    await user.type(textarea, "My next message");
    await user.keyboard("{Enter}");

    expect(textarea).toHaveValue("My next message");
    expect(chatMock.sendMessage).not.toHaveBeenCalled();

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

  it("renders a task card from start_workflow tool output", () => {
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
                { type: "text", text: "Started that workflow as a Task." },
                {
                  type: START_WORKFLOW_TOOL_PART_TYPE,
                  toolCallId: "tool_1",
                  state: "output-available",
                  input: {
                    workflowId: "customer-interview-synthesis",
                    prompt: "Synthesize the Acme interview.",
                  },
                  output: {
                    taskId: "task_1",
                    taskDisplayId: "TASK-42",
                    taskName: "Customer interview synthesis",
                    status: "queued",
                    prompt: "Synthesize the Acme interview.",
                  },
                },
                {
                  type: START_TASK_TOOL_PART_TYPE,
                  toolCallId: "tool_2",
                  state: "output-available",
                  input: {
                    name: "Fallback task",
                    prompt: "Synthesize the Acme interview.",
                  },
                  output: {
                    taskId: "task_1",
                    taskDisplayId: "TASK-42",
                    taskName: "Customer interview synthesis",
                    status: "already_started",
                    prompt: "Synthesize the Acme interview.",
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getByText("Started that workflow as a Task.")).toBeInTheDocument();
    expect(screen.getAllByText("Customer interview synthesis")).toHaveLength(1);
    expect(screen.getByText("TASK-42 · Queued")).toBeInTheDocument();
    expect(screen.queryByText("Workflow")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    expect(screen.getByText("query: latest Google updates")).toBeInTheDocument();
  });

  it("renders persisted failed web fetch tool calls with a generic tool row", () => {
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
                  type: WEB_FETCH_TOOL_PART_TYPE,
                  toolCallId: "tool_fetch_1",
                  state: "output-available",
                  input: { url: "https://example.com/article" },
                  output: {
                    ok: false,
                    error: "Web fetch returned no readable page content.",
                  },
                },
              ],
            } as unknown as GoatChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getByTestId("chat-tool-call-web_fetch")).toBeInTheDocument();
    expect(screen.getByText("Web Fetch")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByText("Web fetch returned no readable page content.")).toBeInTheDocument();
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
