import "@testing-library/jest-dom/vitest";
import { CODEX_PLAN_TOOL_NAME, CODEX_QUESTION_TOOL_NAME } from "@opencompany/agent-runtime";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistLastChatSelection } from "@/lib/chat-composer-selection";
import {
  CHAT_COMPOSER_FOCUS_EVENT,
  HOME_NAVIGATION_EVENT,
  requestChatComposerFocus,
} from "@/lib/chat-navigation";
import { clearAllLocalChatStates, useLocalChatStates } from "@/lib/chat-session-state";
import {
  BRAIN_TOOL_PART_TYPE,
  type ChatMessageMetadata,
  type ChatSummaryView,
  type ChatUiMessage,
  type ConversationRuntimeView,
  START_TASK_TOOL_PART_TYPE,
  START_WORKFLOW_TOOL_PART_TYPE,
  USE_ACTION_TOOL_PART_TYPE,
  WEB_FETCH_TOOL_PART_TYPE,
  WEB_SEARCH_TOOL_PART_TYPE,
} from "@/lib/chat-ui";
import { CLAUDE_CHAT_DEFAULT_MODEL_ID, CODEX_CHAT_DEFAULT_MODEL_ID } from "@/lib/engine-registry";
import { updateHeadlessChatConversation } from "@/lib/headless-chat-commands";
import { HeadlessChatTransport } from "@/lib/headless-chat-transport";
import { DEFAULT_MODEL } from "@/lib/model-options";
import { buildOnboardingKickoffPrompt, queueOnboardingKickoff } from "@/lib/onboarding-kickoff";
import {
  clearAllOptimisticChatSummaries,
  useOptimisticChatSummaries,
} from "@/lib/optimistic-chat-summaries";
import { Surface, type TaskView } from "./Surface";

const chatMock = vi.hoisted(() => ({
  status: "ready" as "ready" | "submitted" | "streaming" | "error",
  sendMessage: vi.fn(),
  stop: vi.fn(),
  resumeStream: vi.fn(async () => undefined),
  finishSessionId: null as string | null,
  startWithSessionId: null as ((sessionId: string, model: string) => void) | null,
  finishWithSessionId: null as ((sessionId: string, model?: string) => void) | null,
  renderAssistantMessage: null as ((message: ChatUiMessage) => void) | null,
  sendError: null as Error | null,
  preparedRequestBodies: [] as unknown[],
  lastResume: null as boolean | null,
}));

const productAnalyticsMock = vi.hoisted(() => ({
  capture: vi.fn(() => true),
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
  canonicalUpload: vi.fn(),
}));

const taskCommandMocks = vi.hoisted(() => ({
  archive: vi.fn(async () => ({})),
  cancel: vi.fn(async () => ({})),
  create: vi.fn(async (command: { goal: string }) => ({
    task: {
      id: "goat_task_created_1",
      displayId: "TASK-7",
      name: command.goal,
      conversationId: "goat_chat_task_created_1",
    },
    transactionId: "1",
  })),
  comment: vi.fn(async () => ({ replayed: false })),
}));

const automationCommandMocks = vi.hoisted(() => ({
  archiveSchedule: vi.fn(async () => ({})),
  invokeWorkflow: vi.fn(async () => ({
    task: {
      id: "goat_task_workflow_1",
      displayId: "TASK-8",
      name: "Workflow task",
      conversationId: "goat_chat_workflow_1",
    },
    transactionId: "1",
  })),
  listWorkflowCatalog: vi.fn(async (options?: { fetch?: typeof globalThis.fetch }) => {
    const response = await (options?.fetch ?? globalThis.fetch)("/api/workflows");
    const payload = (await response.json()) as {
      workflows?: Array<{ id: string; name: string; description: string }>;
    };
    return payload.workflows ?? [];
  }),
  runSchedule: vi.fn(async () => ({
    task: {
      id: "goat_task_1",
      displayId: "TASK-1",
      name: "Recurring Task",
      conversationId: "goat_chat_task_1",
    },
    transactionId: "1",
  })),
  updateSchedule: vi.fn(async () => ({})),
}));

const knowledgeCommandMocks = vi.hoisted(() => ({
  listSkillCatalog: vi.fn(
    async () => [] as Array<{ id: string; name: string; description: string }>,
  ),
}));

const headlessChatMocks = vi.hoisted(() => ({
  startBackground: vi.fn(
    async (input: {
      content: string;
      clientConversationId: string;
      clientMessageId: string;
      model: string;
      engine?: unknown;
    }) => ({
      conversationId: input.clientConversationId,
      runId: "run_background_1",
      completion: Promise.resolve(),
    }),
  ),
}));

const headlessChatCommandMocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({})),
  getRuntimeStatus: vi.fn(async () => null),
  resolveQuestions: vi.fn(async () => ({})),
  updateConversation: vi.fn(async () => ({ transactionId: "1" })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock.value,
}));

vi.mock("@opencompany/analytics/product/client", () => ({
  captureProductEvent: productAnalyticsMock.capture,
}));

vi.mock("@/lib/chat-actions", () => ({
  createChatShareAction: vi.fn(async () => ({
    ok: true,
    shareId: "goat_chat_share_123e4567-e89b-42d3-a456-426614174000",
  })),
  getChatShareAction: vi.fn(async () => ({ ok: true, shareId: null })),
  revokeChatShareAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/headless-chat-commands", () => ({
  cancelHeadlessChatRun: headlessChatCommandMocks.cancel,
  getEngineRuntimeStatus: headlessChatCommandMocks.getRuntimeStatus,
  resolveEngineQuestions: headlessChatCommandMocks.resolveQuestions,
  updateHeadlessChatConversation: headlessChatCommandMocks.updateConversation,
}));

// Server action module; importing it for real drags authkit into jsdom.
vi.mock("@/lib/integration-account-actions", () => ({
  alwaysAllowChatActionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/headless-chat-attachment-upload", () => ({
  uploadHeadlessChatAttachment: attachmentUploadMock.canonicalUpload,
}));

vi.mock("@/lib/headless-chat-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/headless-chat-transport")>()),
  startHeadlessBackgroundChat: headlessChatMocks.startBackground,
}));

vi.mock("@/lib/headless-task-commands", () => ({
  archiveHeadlessTask: taskCommandMocks.archive,
  cancelHeadlessTaskRun: taskCommandMocks.cancel,
  createHeadlessTask: taskCommandMocks.create,
  createHeadlessTaskComment: taskCommandMocks.comment,
  newHeadlessTaskCommentId: () => "task_activity_comment_test",
}));

vi.mock("@/lib/headless-automation-commands", () => ({
  archiveHeadlessTaskSchedule: automationCommandMocks.archiveSchedule,
  invokeHeadlessWorkflow: automationCommandMocks.invokeWorkflow,
  listHeadlessWorkflowCatalog: automationCommandMocks.listWorkflowCatalog,
  runHeadlessTaskScheduleNow: automationCommandMocks.runSchedule,
  updateHeadlessTaskSchedule: automationCommandMocks.updateSchedule,
}));

vi.mock("@/lib/headless-knowledge-commands", () => ({
  listHeadlessSkillCatalog: knowledgeCommandMocks.listSkillCatalog,
}));

vi.mock("@/lib/user-preferences", () => ({
  updateTimezoneAction: vi.fn(async () => ({ ok: true, timezone: "UTC" })),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useChat: (options: {
      messages?: ChatUiMessage[];
      resume?: boolean;
      onFinish?: (event: { message: ChatUiMessage }) => void;
      transport?: {
        prepareSendMessagesRequest?: (request: {
          id: string;
          messages: ChatUiMessage[];
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
      const [messages, setMessages] = React.useState<ChatUiMessage[]>(() => options.messages ?? []);
      chatMock.lastResume = options.resume ?? false;
      const transportRef = React.useRef(options.transport);
      transportRef.current = options.transport;
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
      chatMock.renderAssistantMessage = (message: ChatUiMessage) => {
        setMessages((current) => [
          ...current.filter((candidate) => candidate.id !== message.id),
          message,
        ]);
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
        resumeStream: chatMock.resumeStream,
        sendMessage: async (
          message: { text: string; metadata?: ChatMessageMetadata },
          requestOptions?: { body?: Record<string, unknown> },
        ) => {
          chatMock.sendMessage(message);
          const userMessage: ChatUiMessage = {
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
            api: "/v1/messages",
            trigger: "submit-message",
            messageId: userMessage.id,
          });
          if (preparedRequest) chatMock.preparedRequestBodies.push(preparedRequest.body);
          else if (requestOptions?.body) chatMock.preparedRequestBodies.push(requestOptions.body);
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

function acceptHeadlessConversation(conversationId: string) {
  const handlers = vi
    .mocked(HeadlessChatTransport.prototype.setEventHandlers)
    .mock.calls.at(-1)
    ?.at(0);
  if (!handlers?.onAccepted) throw new Error("Headless Chat accepted handler is not registered.");
  act(() =>
    handlers.onAccepted?.({
      conversationId,
      runId: "run_accepted_1",
      assistantMessageId: "assistant_accepted_1",
      transactionId: "transaction_accepted_1",
    }),
  );
}

class MockDictationWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockDictationWebSocket[] = [];
  readyState = MockDictationWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    MockDictationWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockDictationWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  open() {
    this.readyState = MockDictationWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

class MockAudioContext {
  sampleRate = 48_000;

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }

  close() {
    return Promise.resolve();
  }
}

function installDictationBrowserMocks() {
  MockDictationWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockDictationWebSocket);
  vi.stubGlobal("AudioContext", MockAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/dictation/access") {
        return Response.json({
          websocketUrl: "wss://runner.example.com/goat/dictation",
          ticket: "ticket_1",
          expiresAt: 60_000,
        });
      }
      return Response.json({ skills: [] });
    }),
  );
}

describe("Surface chat streaming UI", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    pathnameMock.value = "/";
    chatMock.status = "ready";
    chatMock.finishSessionId = null;
    chatMock.startWithSessionId = null;
    chatMock.finishWithSessionId = null;
    chatMock.renderAssistantMessage = null;
    chatMock.sendError = null;
    chatMock.sendMessage.mockReset();
    chatMock.stop.mockReset();
    chatMock.resumeStream.mockClear();
    productAnalyticsMock.capture.mockClear();
    routerMock.prefetch.mockReset();
    chatMock.preparedRequestBodies = [];
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    routerMock.replace.mockReset();
    historyMock.replaceState.mockReset();
    vi.spyOn(window.history, "replaceState").mockImplementation(historyMock.replaceState);
    vi.spyOn(HeadlessChatTransport.prototype, "setEventHandlers");
    headlessChatCommandMocks.cancel.mockClear();
    headlessChatCommandMocks.getRuntimeStatus.mockClear();
    headlessChatCommandMocks.resolveQuestions.mockClear();
    headlessChatCommandMocks.updateConversation.mockClear();
    taskCommandMocks.archive.mockClear();
    taskCommandMocks.cancel.mockReset();
    taskCommandMocks.cancel.mockResolvedValue({});
    taskCommandMocks.create.mockClear();
    taskCommandMocks.comment.mockReset();
    taskCommandMocks.comment.mockResolvedValue({ replayed: false });
    automationCommandMocks.invokeWorkflow.mockClear();
    automationCommandMocks.listWorkflowCatalog.mockClear();
    automationCommandMocks.archiveSchedule.mockClear();
    automationCommandMocks.runSchedule.mockClear();
    automationCommandMocks.updateSchedule.mockClear();
    knowledgeCommandMocks.listSkillCatalog.mockReset();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([]);
    headlessChatMocks.startBackground.mockClear();
    attachmentUploadMock.canonicalUpload.mockReset();
    attachmentUploadMock.canonicalUpload.mockResolvedValue({ id: "attachment_1" });
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
    clearAllLocalChatStates();
    clearAllOptimisticChatSummaries();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears the composer and paints the user message immediately", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "Hello opencompany");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Hello opencompany" });
    expect(textarea).toHaveValue("");
    expect(await screen.findAllByText("Hello opencompany")).toHaveLength(2);
  });

  it.each([
    {
      engine: "codex" as const,
      model: CODEX_CHAT_DEFAULT_MODEL_ID,
      connection: { codexConnected: true },
    },
    {
      engine: "claude_code" as const,
      model: CLAUDE_CHAT_DEFAULT_MODEL_ID,
      connection: { claudeCodeConnected: true },
    },
  ])(
    "captures $engine send-to-first-render latency once per foreground turn",
    async ({ engine, model, connection }) => {
      const user = userEvent.setup();
      let currentTime = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => currentTime);

      render(
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={{
            id: `goat_chat_${engine}_latency`,
            title: "Latency test",
            model,
            engine,
            messages: [],
          }}
          workspaceId="workspace_1"
          {...connection}
        />,
      );

      await user.type(screen.getByPlaceholderText("Reply..."), "Measure this turn");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(productAnalyticsMock.capture).not.toHaveBeenCalled();

      currentTime = 2_750;
      acceptHeadlessConversation(`goat_chat_${engine}_latency`);
      act(() => {
        chatMock.renderAssistantMessage?.({
          id: "assistant_accepted_1",
          role: "assistant",
          metadata: {
            sessionId: `goat_chat_${engine}_latency`,
            runId: "run_accepted_1",
            model,
          },
          parts: [{ type: "reasoning", text: "I’ll inspect the repository.", state: "streaming" }],
        });
      });

      await waitFor(() =>
        expect(productAnalyticsMock.capture).toHaveBeenCalledWith("chat_first_output_rendered", {
          workspace_id: "workspace_1",
          session_id: `goat_chat_${engine}_latency`,
          run_id: "run_accepted_1",
          message_id: "assistant_accepted_1",
          engine,
          model,
          selected_model: model,
          is_new_session: false,
          sandbox_status_at_send: "unknown",
          send_source: "composer",
          output_kind: "reasoning",
          time_to_first_output_ms: 1_750,
        }),
      );

      act(() => {
        chatMock.renderAssistantMessage?.({
          id: "assistant_accepted_1",
          role: "assistant",
          metadata: {
            sessionId: `goat_chat_${engine}_latency`,
            runId: "run_accepted_1",
            model,
          },
          parts: [{ type: "text", text: "The repository is ready." }],
        });
      });
      expect(productAnalyticsMock.capture).toHaveBeenCalledOnce();
    },
  );

  it("shows transcript loading instead of an unexplained empty persisted chat", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_loading_1",
          title: "Loading chat",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [],
        }}
      />,
    );

    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
  });

  it("reloads an active opencompany Conversation with Stop targeting its authoritative Run", async () => {
    const user = userEvent.setup();
    const transportCancel = vi
      .spyOn(HeadlessChatTransport.prototype, "cancel")
      .mockResolvedValue(false);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "conversation_opencompany_active",
          title: "Active research",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          runtime: {
            status: "running",
            activeRunId: "run_viewed_conversation",
            hasError: false,
            updatedAt: currentTimestamp(),
          },
          activityState: "working",
          hasUnseen: false,
          messages: [],
        }}
      />,
    );

    const stop = screen.getByRole("button", { name: "Stop response" });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("status", { name: "opencompany is working" }),
    ).toBeInTheDocument();

    await user.click(stop);

    expect(headlessChatCommandMocks.cancel).toHaveBeenCalledWith("run_viewed_conversation");
    expect(transportCancel).not.toHaveBeenCalled();
    expect(chatMock.stop).toHaveBeenCalledOnce();
  });

  it("reloads an active Claude Code Conversation with Working and Stop", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_claude_active",
          title: "Active coding",
          model: DEFAULT_MODEL,
          engine: "claude_code",
          runtime: {
            status: "running",
            activeRunId: "run_claude_active",
            hasError: false,
            updatedAt: currentTimestamp(),
          },
          activityState: "working",
          hasUnseen: false,
          messages: [],
        }}
        claudeCodeConnected
      />,
    );

    expect(screen.getByLabelText("Claude Code status: Working")).toHaveTextContent("Working");
    expect(screen.getByRole("button", { name: "Interrupt Claude Code" })).toBeInTheDocument();
  });

  it("resolves action approvals as durable Run commands before resuming the stream", async () => {
    const user = userEvent.setup();
    const resolveApproval = vi
      .spyOn(HeadlessChatTransport.prototype, "resolveApproval")
      .mockResolvedValue();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_approval_1",
          title: "Approval",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_approval_1",
              role: "assistant",
              metadata: {
                sessionId: "goat_chat_approval_1",
                runId: "run_approval_1",
                model: DEFAULT_MODEL,
              },
              parts: [
                {
                  type: USE_ACTION_TOOL_PART_TYPE,
                  toolCallId: "tool_approval_1",
                  state: "approval-requested",
                  input: {
                    action: "googlecalendar.create_event",
                    params: { title: "Planning" },
                  },
                  approval: { id: "approval_1" },
                },
              ],
            },
          ],
        }}
        codexConnected
      />,
    );

    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith({
        chatId: "goat_chat_approval_1",
        approvalId: "approval_1",
        approved: true,
        runId: "run_approval_1",
        assistantMessageId: "assistant_approval_1",
        model: DEFAULT_MODEL,
      }),
    );
    expect(chatMock.resumeStream).toHaveBeenCalledOnce();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("starts a background chat from the main composer when the message starts with ampersand", async () => {
    const user = userEvent.setup();
    let resolveFirstCompletion: (() => void) | null = null;
    let resolveSecondCompletion: (() => void) | null = null;
    let resolveFirstLaunch:
      | ((launch: { conversationId: string; runId: string; completion: Promise<void> }) => void)
      | null = null;
    const firstLaunch = new Promise<{
      conversationId: string;
      runId: string;
      completion: Promise<void>;
    }>((resolve) => {
      resolveFirstLaunch = resolve;
    });
    const firstCompletion = new Promise<void>((resolve) => {
      resolveFirstCompletion = resolve;
    });
    const secondCompletion = new Promise<void>((resolve) => {
      resolveSecondCompletion = resolve;
    });
    headlessChatMocks.startBackground
      .mockImplementationOnce(async () => firstLaunch)
      .mockImplementationOnce(async (input) => ({
        conversationId: input.clientConversationId,
        runId: "run_background_2",
        completion: secondCompletion,
      }));

    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          userWorkosId="user_1"
          workspaceId="workspace_1"
        />
        <LocalChatStatesProbe />
        <OptimisticChatSummariesProbe />
      </>,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "& Research Q3");
    expect(screen.getByTestId("background-chat-hint")).toHaveTextContent(
      "Sending starts this as a new chat in the background.",
    );
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    const directiveChip = overlay?.querySelector('[data-opencompany-chat-directive="background"]');
    expect(directiveChip).toHaveTextContent("&");
    expect(textarea).toHaveClass("text-transparent");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "Research Q3",
      model: DEFAULT_MODEL,
    });
    expect(body.clientConversationId).toMatch(/^goat_chat_/);
    expect(body.clientMessageId).toMatch(/^ui_background_/);
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent(
      `${body.clientConversationId}:Research Q3`,
    );
    await waitFor(() =>
      expect(screen.getByTestId("local-chat-states")).toHaveTextContent(
        `${body.clientConversationId}:working`,
      ),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea).not.toBeDisabled();

    await user.type(textarea, "& Summarize Q4");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(2));
    const secondBody = headlessChatMocks.startBackground.mock.calls[1]![0];
    expect(secondBody).toMatchObject({ content: "Summarize Q4", model: DEFAULT_MODEL });
    expect(screen.getByTestId("local-chat-states")).toHaveTextContent(
      `${body.clientConversationId}:working`,
    );
    expect(screen.getByTestId("local-chat-states")).toHaveTextContent(
      `${secondBody.clientConversationId}:working`,
    );
    expect(textarea).toHaveValue("");
    expect(textarea).not.toBeDisabled();

    await act(async () => {
      resolveFirstLaunch?.({
        conversationId: body.clientConversationId,
        runId: "run_background_1",
        completion: firstCompletion,
      });
    });
    await act(async () => {
      resolveFirstCompletion?.();
    });
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("local-chat-states")).not.toHaveTextContent(
        `${body.clientConversationId}:working`,
      ),
    );
    expect(screen.getByTestId("local-chat-states")).toHaveTextContent(
      `${secondBody.clientConversationId}:working`,
    );
    await act(async () => {
      resolveSecondCompletion?.();
    });
    await waitFor(() => expect(screen.getByTestId("local-chat-states")).toHaveTextContent("none"));
    expect(textarea).toHaveValue("");
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("keeps an accepted background chat when live completion monitoring fails", async () => {
    const user = userEvent.setup();
    let rejectCompletion: ((error: Error) => void) | null = null;
    const completion = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    headlessChatMocks.startBackground.mockImplementationOnce(async (input) => ({
      conversationId: input.clientConversationId,
      runId: "run_background_1",
      completion,
    }));

    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          userWorkosId="user_1"
          workspaceId="workspace_1"
        />
        <LocalChatStatesProbe />
        <OptimisticChatSummariesProbe />
      </>,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "& Research Q3");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledOnce());
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    await user.type(textarea, "Keep this new draft");
    await act(async () => rejectCompletion?.(new Error("event stream disconnected")));

    await waitFor(() => expect(screen.getByTestId("local-chat-states")).toHaveTextContent("none"));
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent(
      `${body.clientConversationId}:Research Q3`,
    );
    expect(textarea).toHaveValue("Keep this new draft");
  });

  it("starts a bare ampersand message from Home defaults instead of the active Codex runtime", async () => {
    const user = userEvent.setup();
    persistLastChatSelection("user_1", DEFAULT_MODEL);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "conversation_codex_active",
          title: "Codex active",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [],
          runtime: {
            status: "running",
            activeRunId: "run_codex_active",
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
        }}
        codexConnected
        userWorkosId="user_1"
        workspaceId="workspace_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");

    await user.type(textarea, "& summarize the release notes");

    expect(screen.getByTestId("background-chat-hint")).toHaveTextContent(
      "Sending starts this as a new chat in the background.",
    );
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
    expect(screen.queryByRole("button", { name: "Interrupt Codex" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "summarize the release notes",
      model: DEFAULT_MODEL,
    });
    expect(body.engine).toBeUndefined();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(chatMock.stop).not.toHaveBeenCalled();
  });

  it("starts a raw ampersand Codex directive from a running Codex chat as a new background Codex session", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_codex_active",
          title: "Codex active",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [],
          runtime: {
            status: "running",
            activeRunId: "run_codex_active",
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
        }}
        codexConnected
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    expect(screen.getByRole("button", { name: "Interrupt Codex" })).toBeInTheDocument();

    await user.type(textarea, "& @codex refactor the parser");

    expect(screen.getByTestId("background-chat-hint")).toHaveTextContent(
      "Sending starts this as a new Codex chat in the background.",
    );
    expect(screen.queryByRole("button", { name: "Interrupt Codex" })).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Send message" });
    expect(submit).toBeEnabled();

    await user.click(submit);

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "refactor the parser",
      engine: {
        type: "codex",
        schemaVersion: 1,
        settings: { reasoningEffort: "xhigh" },
      },
    });
    expect(body.clientConversationId).toMatch(/^goat_chat_/);
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("starts a selected workflow from a running Codex chat without interrupting Codex", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workflows" && init?.method === "POST") {
        return Response.json(
          {
            task: {
              id: "task_1",
              displayId: "TASK-1",
              name: "Ship feature",
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/workflows") {
        return Response.json({
          workflows: [
            {
              id: "ship-feature",
              name: "Ship feature",
              description: "Use this to ship features.",
            },
          ],
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_codex_active",
          title: "Codex active",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [],
          runtime: {
            status: "running",
            activeRunId: "run_codex_active",
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
        }}
        workspaceId="workspace_1"
        codexConnected
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    expect(screen.getByRole("button", { name: "Interrupt Codex" })).toBeInTheDocument();

    await user.type(textarea, "#");
    await user.click(await screen.findByRole("option", { name: /Ship feature/i }));
    await user.type(textarea, "fix the composer send button");

    expect(screen.getByTestId("workflow-task-hint")).toHaveTextContent(
      "Sending runs workflow Ship feature as a background task.",
    );
    const submit = screen.getByRole("button", { name: "Start task" });
    expect(submit).toBeEnabled();

    await user.click(submit);

    await waitFor(() => expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalled());
    expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalledWith(
      "ship-feature",
      {
        description: "#ship-feature fix the composer send button",
      },
      { scopeKey: "workspace_1" },
    );
    expect(chatMock.stop).not.toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("starts an ampersand ad-hoc task with Enter while the current chat is streaming", async () => {
    const user = userEvent.setup();
    chatMock.status = "streaming";

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_streaming_1",
          title: "Streaming chat",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [
            {
              id: "user_1",
              role: "user",
              parts: [{ type: "text", text: "Think through launch options" }],
            },
          ],
        }}
        taskSpawningEnabled
      />,
    );

    const textarea = screen.getByPlaceholderText("Reply...");
    await user.type(textarea, "& #task research competitors");

    expect(screen.getByTestId("ad-hoc-task-hint")).toHaveTextContent(
      "Sending starts this as an ad-hoc background task.",
    );
    expect(screen.getByRole("button", { name: "Start task" })).toBeEnabled();

    await user.keyboard("{Enter}");

    await waitFor(() => expect(taskCommandMocks.create).toHaveBeenCalledTimes(1));
    expect(taskCommandMocks.create).toHaveBeenCalledWith(
      {
        goal: "research competitors",
        engine: "opencompany",
        model: DEFAULT_MODEL,
      },
      { scopeKey: "" },
    );
    expect(chatMock.stop).not.toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("restores the prior draft when voice dictation is cancelled", async () => {
    installDictationBrowserMocks();
    const user = userEvent.setup();

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "Draft before mic");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    await waitFor(() => expect(MockDictationWebSocket.instances).toHaveLength(1));
    const socket = MockDictationWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.receive({ type: "delta", delta: " add this" }));
    expect(textarea).toHaveValue("Draft before mic add this");

    await user.click(screen.getByRole("button", { name: "Cancel voice dictation" }));

    expect(textarea).toHaveValue("Draft before mic");
    expect(socket.sent.some((message) => message.includes('"type":"cancel"'))).toBe(true);
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps final voice dictation text in the composer for review without sending", async () => {
    installDictationBrowserMocks();
    const user = userEvent.setup();

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "Please");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    await waitFor(() => expect(MockDictationWebSocket.instances).toHaveLength(1));
    const socket = MockDictationWebSocket.instances[0]!;
    act(() => socket.open());
    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));
    expect(screen.getByRole("status", { name: "Processing voice dictation" })).toBeInTheDocument();
    expect(socket.sent.some((message) => message.includes('"type":"stop"'))).toBe(true);

    act(() => socket.receive({ type: "final", text: "send the launch update" }));

    await waitFor(() => expect(textarea).toHaveValue("Please send the launch update"));
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("marks an already-open chat seen again after a live assistant message finishes", async () => {
    const staleSummaryUpdatedAt = "2026-07-04T12:00:00.000Z";
    const initialChat = {
      id: "goat_chat_live_seen",
      title: "Live chat",
      model: DEFAULT_MODEL,
      engine: "opencompany" as const,
      messages: [
        {
          id: "user_1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Start" }],
        },
      ],
    };
    const staleSummary: ChatSummaryView = {
      id: initialChat.id,
      title: initialChat.title,
      model: DEFAULT_MODEL,
      engine: "opencompany",
      preview: "Start",
      updatedAt: staleSummaryUpdatedAt,
      lastSeenAt: staleSummaryUpdatedAt,
      activityState: "idle",
      hasUnseen: true,
      pinnedAt: null,
    };

    const { rerender } = render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={initialChat}
        recentChats={[staleSummary]}
      />,
    );

    await waitFor(() =>
      expect(updateHeadlessChatConversation).toHaveBeenCalledWith(initialChat.id, {
        markSeen: true,
      }),
    );
    headlessChatCommandMocks.updateConversation.mockClear();

    await act(async () => {
      chatMock.status = "streaming";
      chatMock.startWithSessionId?.(initialChat.id, DEFAULT_MODEL);
    });
    expect(updateHeadlessChatConversation).not.toHaveBeenCalled();

    chatMock.status = "ready";
    const completedSummary = {
      ...staleSummary,
      updatedAt: "2026-07-04T12:01:00.000Z",
    };
    rerender(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={initialChat}
        recentChats={[completedSummary]}
      />,
    );

    await waitFor(() =>
      expect(updateHeadlessChatConversation).toHaveBeenCalledWith(initialChat.id, {
        markSeen: true,
      }),
    );
  });

  it("posts a session-backed Task comment verbatim without a Chat LLM hop", async () => {
    const user = userEvent.setup();
    const taskId = "goat_task_1";

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_task_1",
          title: "Morning workflow",
          model: DEFAULT_MODEL,
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
              metadata: {
                sessionId: "goat_chat_task_1",
                taskId: "goat_task_1",
                task: {
                  id: "goat_task_1",
                  displayId: "TASK-1",
                  title: "Morning workflow",
                  status: "succeeded",
                },
              },
              parts: [{ type: "text", text: "The workflow is complete." }],
            },
          ],
        }}
        taskConversation={{
          taskId,
          status: "succeeded",
          startedAtMs: Date.now(),
        }}
        workspaceId="workspace_1"
      />,
    );

    expect(screen.getByText("Morning workflow")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("The workflow is complete.")).toBeInTheDocument();
    expect(screen.queryByText("TASK-1 · Done")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share task run" })).toBeInTheDocument();

    const body = "  Please check the afternoon too.\n  Preserve this indent.  ";
    fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: body } });
    await user.click(screen.getByRole("button", { name: "Post comment" }));

    await waitFor(() =>
      expect(taskCommandMocks.comment).toHaveBeenCalledWith(
        taskId,
        { id: "task_activity_comment_test", body },
        { scopeKey: "workspace_1" },
      ),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Comments are sent verbatim to this task.")).toBeVisible();
  });

  it("attaches a dropped screenshot when continuing a session-backed task", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_task_1",
          title: "Investigate task",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [],
        }}
        taskConversation={{
          taskId: "task_1",
          status: "succeeded",
          startedAtMs: Date.now(),
        }}
        userWorkosId="user_1"
      />,
    );
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();

    const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
    fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [screenshot] },
    });

    await waitFor(() => expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledTimes(1));
    expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledWith({ file: screenshot });
    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Post comment" }));

    expect(taskCommandMocks.comment).toHaveBeenCalledWith(
      "task_1",
      {
        id: "task_activity_comment_test",
        body: "",
        attachmentIds: ["attachment_1"],
      },
      { scopeKey: "" },
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps pre-cutover Task history explicitly read-only", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_task_legacy_1",
          title: "Legacy research",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [
            {
              id: "legacy_assistant_1",
              role: "assistant",
              parts: [{ type: "text", text: "Historical result" }],
            },
          ],
        }}
        taskConversation={{
          taskId: "goat_task_legacy_1",
          status: "succeeded",
          startedAtMs: Date.now(),
        }}
        userWorkosId="user_1"
        readOnlyNotice="This pre-cutover task is available as read-only history. Start a new task to continue the work."
      />,
    );

    expect(screen.getByText(/pre-cutover task is available as read-only history/i)).toBeVisible();
    expect(screen.getByPlaceholderText("Add a comment…")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post comment" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start voice dictation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();

    const form = screen.getByRole("button", { name: "Post comment" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("treats slash text in a Task comment as verbatim content, not a Skill mention", async () => {
    const user = userEvent.setup();
    const taskId = "goat_task_1";
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
      {
        id: "product-work",
        name: "Product work",
        description: "Shape and ship product changes.",
      },
    ]);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_task_1",
          title: "Investigate task",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [],
        }}
        taskConversation={{
          taskId,
          status: "succeeded",
          startedAtMs: Date.now(),
        }}
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Add a comment…");
    await user.type(textarea, "/prod investigate the mention menu");
    expect(screen.queryByRole("option", { name: /Product work/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Post comment" }));

    await waitFor(() =>
      expect(taskCommandMocks.comment).toHaveBeenCalledWith(
        taskId,
        { id: "task_activity_comment_test", body: "/prod investigate the mention menu" },
        { scopeKey: "" },
      ),
    );
    expect(knowledgeCommandMocks.listSkillCatalog).not.toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("disables comments while the Task run is active", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_task_1",
          title: "Morning workflow",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
          ],
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "running",
          startedAtMs: Date.now(),
        }}
        taskSpawningEnabled
      />,
    );

    expect(screen.getByPlaceholderText("Add a comment…")).toBeDisabled();
    expect(screen.getByText("You can comment when the current run finishes.")).toBeVisible();
    expect(screen.queryByTestId("ad-hoc-task-hint")).not.toBeInTheDocument();
    expect(taskCommandMocks.create).not.toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(taskCommandMocks.comment).not.toHaveBeenCalled();
  });

  it("uses the chat stop control for an active workflow task", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
          ],
          runtime: {
            status: "running",
            activeRunId: "run_task_1",
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "running",
          startedAtMs: Date.now(),
          activeRunId: "run_1",
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Interrupt Codex" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(taskCommandMocks.cancel).toHaveBeenCalledWith("run_1");
    await waitFor(() => expect(chatMock.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status", { name: "Stopping task…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stopping task" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();

    rerender(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "task_user_1",
              role: "user",
              parts: [{ type: "text", text: "Run the morning workflow" }],
            },
          ],
          runtime: {
            status: "interrupted",
            activeRunId: null,
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "canceled",
          startedAtMs: Date.now(),
          activeRunId: null,
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Stopping task…" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Post comment" })).toBeInTheDocument();
  });

  it("restores the task stop control when cancellation fails", async () => {
    const user = userEvent.setup();
    taskCommandMocks.cancel.mockRejectedValueOnce(new Error("Could not stop task."));

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_task_1",
          title: "Morning workflow",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [],
        }}
        taskConversation={{
          taskId: "goat_task_1",
          status: "running",
          startedAtMs: Date.now(),
          activeRunId: "run_1",
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
    expect(queueOnboardingKickoff(companyUrl)).toBe(true);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 0),
    );

    const { rerender } = render(
      <StrictMode>
        <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />
      </StrictMode>,
    );

    const prompt = buildOnboardingKickoffPrompt(companyUrl);
    await waitFor(() => expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: prompt }));
    expect(chatMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "moonshotai/kimi-k3",
    });

    rerender(
      <StrictMode>
        <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />
      </StrictMode>,
    );
    expect(chatMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("renders a new chat immediately and navigates only after the reserved id is accepted", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          workspaceId="workspace_1"
        />
        <OptimisticChatSummariesProbe />
      </>,
    );

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start now");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const optimisticSessionId = (chatMock.preparedRequestBodies[0] as { newSessionId: string })
      .newSessionId;
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      newSessionId: optimisticSessionId,
      model: DEFAULT_MODEL,
    });
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent(
      `${optimisticSessionId}:Start now`,
    );
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();

    acceptHeadlessConversation(optimisticSessionId);

    expect(routerMock.replace).toHaveBeenCalledWith(`/chat/${optimisticSessionId}`, {
      scroll: false,
    });
  });

  it("keeps Shift+Enter as a newline in the main composer", async () => {
    const user = userEvent.setup();
    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "Start now");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(textarea).toHaveValue("Start now\n");
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(chatMock.preparedRequestBodies).toHaveLength(0);
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("keeps a new chat local and reuses its reserved id when the first send is retried", async () => {
    const user = userEvent.setup();
    chatMock.sendError = new Error("network failed");
    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          workspaceId="workspace_1"
        />
        <OptimisticChatSummariesProbe />
      </>,
    );

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Try again");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Reply...")).toHaveValue("Try again"));
    const firstRequest = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent("none");

    chatMock.sendError = null;
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(2));
    expect(chatMock.preparedRequestBodies[1]).toMatchObject({
      sessionId: null,
      newSessionId: firstRequest.newSessionId,
    });
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent(
      `${firstRequest.newSessionId}:Try again`,
    );
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();

    acceptHeadlessConversation(firstRequest.newSessionId);

    expect(routerMock.replace).toHaveBeenCalledWith(`/chat/${firstRequest.newSessionId}`, {
      scroll: false,
    });
  });

  it("resets and focuses the blank composer immediately when Home is requested", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [],
        }}
      />,
    );

    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Reply..."), "Unsent draft");
    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));

    const composer = screen.getByPlaceholderText("Ask opencompany anything...");
    expect(composer).toHaveValue("");
    expect(composer).toHaveFocus();
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("restores an unsent composer draft when returning to a chat session", async () => {
    const user = userEvent.setup();
    const chatOne = {
      id: "chat_1",
      title: "First chat",
      model: DEFAULT_MODEL,
      messages: [],
    };
    const chatTwo = {
      id: "chat_2",
      title: "Second chat",
      model: DEFAULT_MODEL,
      messages: [],
    };
    const { rerender } = render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatOne} />,
    );

    await user.type(screen.getByPlaceholderText("Reply..."), "Draft for the first chat");

    rerender(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatTwo} />);
    await nextAnimationFrame();

    expect(screen.getByText("Second chat")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");

    await user.type(screen.getByPlaceholderText("Reply..."), "Draft for the second chat");

    rerender(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatOne} />);
    await nextAnimationFrame();

    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("Draft for the first chat");

    rerender(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatTwo} />);
    await nextAnimationFrame();

    expect(screen.getByText("Second chat")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("Draft for the second chat");
  });

  it("focuses the composer when the requested chat session opens", async () => {
    const user = userEvent.setup();
    const chatOne = {
      id: "chat_1",
      title: "First chat",
      model: DEFAULT_MODEL,
      messages: [],
    };
    const chatTwo = {
      id: "chat_2",
      title: "Second chat",
      model: DEFAULT_MODEL,
      messages: [],
    };
    const { rerender } = render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatOne} />,
    );
    const composer = screen.getByPlaceholderText("Reply...");

    await user.type(composer, "Draft");
    composer.blur();
    act(() => requestChatComposerFocus("chat_2"));

    rerender(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={chatTwo} />);
    await nextAnimationFrame();
    await nextAnimationFrame();

    expect(screen.getByText("Second chat")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply...")).toHaveFocus();
  });

  it("focuses the composer immediately when the active chat session is requested", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [],
        }}
      />,
    );
    const composer = screen.getByPlaceholderText("Reply...");

    composer.blur();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(CHAT_COMPOSER_FOCUS_EVENT, { detail: { sessionId: "chat_1" } }),
      ),
    );

    expect(composer).toHaveFocus();
  });

  it("does not reopen a new chat when its response arrives after Home was clicked", async () => {
    const user = userEvent.setup();
    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const request = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));
    acceptHeadlessConversation(request.newSessionId);

    expect(screen.getByPlaceholderText("Ask opencompany anything...")).toHaveFocus();
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("keeps an active chat locally working after Home until the stream finishes", async () => {
    const user = userEvent.setup();

    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={{
            id: "chat_1",
            title: "Chat",
            model: DEFAULT_MODEL,
            messages: [],
          }}
        />
        <LocalChatStateProbe sessionId="chat_1" />
      </>,
    );

    await user.type(screen.getByPlaceholderText("Reply..."), "Keep working");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    act(() => {
      chatMock.status = "streaming";
      chatMock.startWithSessionId?.("chat_1", DEFAULT_MODEL);
    });
    expect(screen.getByTestId("local-chat-state")).toHaveTextContent("working");

    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));

    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(screen.getByTestId("local-chat-state")).toHaveTextContent("working");

    act(() => chatMock.finishWithSessionId?.("chat_1"));

    await waitFor(() => expect(screen.getByTestId("local-chat-state")).toHaveTextContent("none"));
  });

  it("renders composer input as native textarea text", async () => {
    const user = userEvent.setup();
    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "@codex inspect this long prompt");
    expect(textarea).toHaveClass("text-ink");
    expect(textarea).not.toHaveClass("text-transparent");
    expect(textarea.parentElement?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("selects from the active model list and sends the chosen model", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    const modelPicker = screen.getByRole("button", { name: "Model" });
    expect(modelPicker).toHaveTextContent("Kimi K3");
    await user.click(modelPicker);

    expect(screen.queryByText("Capability / Speed / Cost")).not.toBeInTheDocument();
    expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.6 Sol")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.6 Terra")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();
    expect(screen.getByText("Qwen 3.8 Max")).toBeInTheDocument();
    expect(screen.getByText("Alibaba")).toBeInTheDocument();
    expect(screen.getAllByText("Kimi K3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.queryByText("GPT 5.4 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Codex")).not.toBeInTheDocument();

    await user.click(screen.getByText("Qwen 3.8 Max"));
    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Compare");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      model: "alibaba/qwen3.8-max",
    });
  });

  it("shows Auto only behind its flag and adopts the routed model when the first turn starts", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Picks once from your first message")).not.toBeInTheDocument();

    rerender(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        autoModelRoutingEnabled
      />,
    );
    await user.click(screen.getByText("Picks once from your first message"));
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Auto");

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "What is 2 + 2?");
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
      defaultModel: DEFAULT_MODEL,
      initialChat: null,
      userWorkosId: "user_1",
    } as const;
    const { unmount } = render(<Surface {...props} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Claude Sonnet 5"));
    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Use Sonnet");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5");

    unmount();
    render(<Surface {...props} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5"),
    );
  });

  it("keeps a new session's model fixed when another tab changes the Home preference", async () => {
    const user = userEvent.setup();
    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start with Kimi");
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

    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5"),
    );
    expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
  });

  it("remembers the last main chat engine across a Home reset and remounting", async () => {
    const user = userEvent.setup();
    const sharedProps = {
      tasks: [],
      defaultModel: DEFAULT_MODEL,
      codexConnected: true,
      userWorkosId: "user_1",
    } as const;
    const { unmount } = render(<Surface {...sharedProps} initialChat={null} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    act(() => window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT)));

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");

    unmount();
    render(<Surface {...sharedProps} initialChat={null} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex"),
    );
  });

  it("shows the Codex engine only when Codex is connected", async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Cloud Codex sandbox")).not.toBeInTheDocument();
    unmount();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText("Cloud Codex sandbox")).toBeInTheDocument();
  });

  it("shows Codex controls only for Codex engine chats", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

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

  it("submits Codex engine chats through the canonical Message transport", async () => {
    const user = userEvent.setup();
    let currentTime = 3_000;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        workspaceId="workspace_1"
        codexConnected
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    expect(screen.getByRole("button", { name: "Codex model: GPT 5.6 Sol" })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Clone my repo");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Clone my repo" });
    const body = chatMock.preparedRequestBodies.at(-1) as Record<string, unknown>;
    expect(body).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      engine: {
        type: "codex",
        schemaVersion: 1,
        settings: { reasoningEffort: "xhigh" },
      },
      model: "openai/gpt-5.6-sol",
    });
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();

    currentTime = 4_200;
    acceptHeadlessConversation(String(body.newSessionId));
    act(() => {
      chatMock.renderAssistantMessage?.({
        id: "assistant_accepted_1",
        role: "assistant",
        metadata: {
          sessionId: String(body.newSessionId),
          runId: "run_accepted_1",
          model: CODEX_CHAT_DEFAULT_MODEL_ID,
        },
        parts: [{ type: "text", text: "The sandbox is ready." }],
      });
    });

    expect(routerMock.replace).toHaveBeenCalledWith(`/chat/${body.newSessionId}`, {
      scroll: false,
    });
    await waitFor(() =>
      expect(productAnalyticsMock.capture).toHaveBeenCalledWith("chat_first_output_rendered", {
        workspace_id: "workspace_1",
        session_id: body.newSessionId,
        run_id: "run_accepted_1",
        message_id: "assistant_accepted_1",
        engine: "codex",
        model: CODEX_CHAT_DEFAULT_MODEL_ID,
        selected_model: CODEX_CHAT_DEFAULT_MODEL_ID,
        is_new_session: true,
        sandbox_status_at_send: "not_created",
        send_source: "composer",
        output_kind: "text",
        time_to_first_output_ms: 1_200,
      }),
    );
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
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} claudeCodeConnected />,
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
    await user.type(
      screen.getByPlaceholderText("Ask opencompany anything..."),
      "Inspect this repository",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Inspect this repository" });
    expect(chatMock.preparedRequestBodies.at(-1)).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: "anthropic/claude-opus-4.8",
      engine: {
        type: "claude_code",
        schemaVersion: 1,
        settings: { reasoningEffort: "xhigh" },
      },
    });
  });

  it("submits selected Skills to cloud Codex", async () => {
    const user = userEvent.setup();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
      {
        id: "coding-work",
        name: "Coding work",
        description: "How coding work should happen.",
      },
    ]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "/coding");
    await user.click(await screen.findByRole("option", { name: /coding work/i }));
    await user.type(textarea, "implement this");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "/coding-work implement this",
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
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

    expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledTimes(1);
    const message = chatMock.sendMessage.mock.calls.at(-1)?.[0];
    expect(message.metadata.attachments).toEqual([
      expect.objectContaining({
        id: "attachment_1",
        kind: "pdf",
        filename: "brief.pdf",
      }),
    ]);
  });

  it("restores a cloud Codex attachment when submission fails", async () => {
    const user = userEvent.setup();
    chatMock.sendError = new Error("network failed");
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
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
    expect((await screen.findAllByText("brief.pdf")).length).toBeGreaterThan(0);
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

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

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
    await user.type(
      screen.getByPlaceholderText("Ask opencompany anything..."),
      "Run the failing suite",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies.at(-1)).toMatchObject({
      engine: {
        type: "codex",
        schemaVersion: 1,
        settings: {
          reasoningEffort: "high",
          planModeEnabled: true,
          goalMode: {
            objective: "Fix the flaky tests",
            tokenBudget: 200000,
          },
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex plan",
          model: DEFAULT_MODEL,
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
                } as ChatUiMessage["parts"][number],
              ],
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Implement plan" }));
    expect(chatMock.sendMessage).toHaveBeenCalledWith({ text: "Implement the plan." });
    expect(chatMock.preparedRequestBodies.at(-1)).toMatchObject({
      sessionId: "goat_chat_codex_1",
      engine: {
        type: "codex",
        schemaVersion: 1,
        settings: { reasoningEffort: "high" },
      },
    });
  });

  it("posts an interactive Codex question answer to its durable interaction", async () => {
    const user = userEvent.setup();
    const interactionId = "goat_codex_chat_interaction_123e4567-e89b-12d3-a456-426614174000";

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex question",
          model: DEFAULT_MODEL,
          engine: "codex",
          runtime: {
            status: "running",
            activeRunId: "goat_codex_chat_turn_1",
            hasError: false,
            updatedAt: new Date().toISOString(),
          },
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
                } as ChatUiMessage["parts"][number],
              ],
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Foundational/ }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(headlessChatCommandMocks.resolveQuestions).toHaveBeenCalledWith(
        "goat_codex_chat_turn_1",
        interactionId,
        { scope: { answers: ["Foundational"] } },
      ),
    );
  });

  it("opens existing Codex chats in codex mode with canonical reconnect enabled", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_MODEL,
          engine: "codex",
          messages: [
            {
              id: "codex_user_1",
              role: "user",
              parts: [{ type: "text", text: "Inspect the repo" }],
            },
          ],
        }}
      />,
    );

    expect(chatMock.lastResume).toBe(true);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");
    expect(screen.getByRole("button", { name: "Share Codex chat" })).toBeInTheDocument();
  });

  it("shows the share button for existing Claude Code chats", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        claudeCodeConnected
        initialChat={{
          id: "goat_chat_claude_1",
          title: "Claude Code chat",
          model: DEFAULT_MODEL,
          engine: "claude_code",
          messages: [
            {
              id: "claude_user_1",
              role: "user",
              parts: [{ type: "text", text: "Review the branch" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude");
    expect(screen.getByRole("button", { name: "Share Claude Code chat" })).toBeInTheDocument();
  });

  it("keeps a reloaded Claude session on its persisted model for the next turn", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        claudeCodeConnected
        initialChat={{
          id: "chat_claude_fable",
          title: "Fable session",
          model: "anthropic/claude-fable-5",
          engine: "claude_code",
          messages: [],
        }}
      />,
    );

    const modelPicker = screen.getByRole("button", { name: "Claude model: Claude Fable 5" });
    expect(modelPicker).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Reply..."), "Continue with the same model");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies.at(-1)).toMatchObject({
      sessionId: "chat_claude_fable",
      model: "anthropic/claude-fable-5",
      engine: { type: "claude_code", schemaVersion: 1 },
    });
  });

  it("uses the task readiness status in the Codex detail header", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_MODEL,
          engine: "codex",
          runtime: {
            status: "idle",
            activeRunId: null,
            hasError: false,
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

  it("shows the synced engine session status on a Task Conversation", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "conversation_task_codex_1",
          title: "Codex task",
          model: DEFAULT_MODEL,
          engine: "codex",
          runtime: {
            status: "running",
            activeRunId: "run_1",
            hasError: false,
            updatedAt: currentTimestamp(),
          },
          messages: [],
        }}
        taskConversation={{
          taskId: "task_codex_1",
          status: "running",
          startedAtMs: Date.now(),
        }}
      />,
    );

    expect(screen.getByLabelText("Codex status: Working")).toHaveTextContent("Working");
    expect(screen.queryByLabelText("Codex status: Connecting")).not.toBeInTheDocument();
  });

  it("shows the context token usage in a tooltip", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_MODEL,
          engine: "codex",
          runtime: {
            status: "queued",
            activeRunId: "run_queued_1",
            hasError: false,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        codexConnected
        initialChat={{
          id: "goat_chat_codex_1",
          title: "Codex chat",
          model: DEFAULT_MODEL,
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
            model: DEFAULT_MODEL,
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

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "First message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const firstRequest = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    acceptHeadlessConversation(firstRequest.newSessionId);
    act(() => chatMock.finishWithSessionId?.(firstRequest.newSessionId));

    await user.type(screen.getByPlaceholderText("Reply..."), "Second message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.preparedRequestBodies).toHaveLength(2);
    expect(chatMock.preparedRequestBodies[0]).toMatchObject({
      sessionId: null,
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: DEFAULT_MODEL,
    });
    expect(chatMock.preparedRequestBodies[1]).toMatchObject({
      sessionId: firstRequest.newSessionId,
      model: DEFAULT_MODEL,
    });
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledWith(`/chat/${firstRequest.newSessionId}`, {
      scroll: false,
    });
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
    window.localStorage.setItem("opencompany-goat-main-chat-selection:user_1", DEFAULT_MODEL);

    render(
      <>
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          codexConnected
          userWorkosId="user_1"
          workspaceId="workspace_1"
        />
        <OptimisticChatSummariesProbe />
      </>,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
    await user.type(textarea, "@");

    expect(screen.getByRole("listbox", { name: "Mention menu" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /@codex/i }));
    expect(textarea).toHaveValue("@codex ");
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(overlay?.querySelectorAll('[data-opencompany-chat-mention="engine"]')).toHaveLength(1);
    expect(overlay).toHaveTextContent("@codex");
    expect(textarea).toHaveClass("text-transparent");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Codex");
    expect(screen.getByRole("button", { name: "Codex model: GPT 5.6 Sol" })).toBeInTheDocument();

    await user.type(textarea, "check repo access");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "@codex check repo access" }),
    );
    const body = chatMock.preparedRequestBodies.at(-1) as { newSessionId: string };
    expect(body).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: "openai/gpt-5.6-sol",
      engine: { type: "codex", schemaVersion: 1 },
    });
    expect(screen.getByTestId("optimistic-chat-summaries")).toHaveTextContent(
      `${body.newSessionId}:@codex check repo access`,
    );
    expect(window.localStorage.getItem("opencompany-goat-main-chat-selection:user_1")).toBe(
      DEFAULT_MODEL,
    );

    await user.keyboard("{Escape}");
    await nextAnimationFrame();

    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
  });

  it("uses @claude as a one-shot model selection without changing the remembered model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
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
    window.localStorage.setItem("opencompany-goat-main-chat-selection:user_1", DEFAULT_MODEL);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        claudeCodeConnected
        userWorkosId="user_1"
      />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
    await user.type(textarea, "@");

    expect(screen.getByRole("listbox", { name: "Mention menu" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /@claude/i }));
    expect(textarea).toHaveValue("@claude ");
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(overlay?.querySelectorAll('[data-opencompany-chat-mention="engine"]')).toHaveLength(1);
    expect(overlay).toHaveTextContent("@claude");
    expect(textarea).toHaveClass("text-transparent");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Code");
    expect(
      screen.getByRole("button", { name: "Claude model: Claude Sonnet 5" }),
    ).toBeInTheDocument();

    await user.type(textarea, "check repo access");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "@claude check repo access" }),
    );
    const body = chatMock.preparedRequestBodies.at(-1);
    expect(body).toMatchObject({
      newSessionId: expect.stringMatching(/^goat_chat_/),
      model: CLAUDE_CHAT_DEFAULT_MODEL_ID,
      engine: { type: "claude_code", schemaVersion: 1 },
    });
    expect(window.localStorage.getItem("opencompany-goat-main-chat-selection:user_1")).toBe(
      DEFAULT_MODEL,
    );

    await user.keyboard("{Escape}");
    await nextAnimationFrame();

    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Kimi K3");
  });

  it("starts a selected workflow in the background without creating a chat turn", async () => {
    const user = userEvent.setup();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
      {
        id: "smooth-shadow-ring",
        name: "Smooth shadow ring",
        description: "Polish elevation styles.",
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_MODEL,
          messages: [],
        }}
        workspaceId="workspace_1"
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
    expect(overlay?.querySelectorAll('[data-opencompany-chat-mention="workflow"]')).toHaveLength(1);
    expect(overlay).toHaveTextContent("#morning-test");
    expect(textarea).toHaveClass("text-transparent");
    await user.type(textarea, "run today's checks with /");
    await user.click(await screen.findByRole("option", { name: /Smooth shadow ring/i }));
    await user.type(textarea, "{Enter}");

    await waitFor(() => expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalled());
    expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalledWith(
      "morning-test",
      {
        description: "#morning-test run today's checks with /smooth-shadow-ring",
        skillIds: ["smooth-shadow-ring"],
      },
      { scopeKey: "workspace_1" },
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts a selected workflow with uploaded attachments", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_MODEL,
          messages: [],
        }}
        workspaceId="workspace_1"
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

    await waitFor(() => expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalled());
    expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalledWith(
      "morning-test",
      {
        description: "#morning-test summarize this report",
        attachmentIds: ["attachment_1"],
      },
      { scopeKey: "workspace_1" },
    );
    expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("report.docx")).toBeNull());
  });

  it("offers workflow mentions when Codex is selected in the main composer", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        workspaceId="workspace_1"
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

    await waitFor(() => expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalled());
    expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalledWith(
      "morning-test",
      {
        description: "#morning-test run today's checks",
      },
      { scopeKey: "workspace_1" },
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("messages"),
      expect.anything(),
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Ask a question or describe a task...")).toHaveValue("");
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts a typed #task request as an ad-hoc background task", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workflows") return Response.json({ workflows: [] });
      void init;
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "goat_chat_1",
          title: "Existing chat",
          model: DEFAULT_MODEL,
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

    await waitFor(() => expect(taskCommandMocks.create).toHaveBeenCalledTimes(1));
    expect(taskCommandMocks.create).toHaveBeenCalledWith(
      {
        goal: "research our three closest competitors",
        engine: "opencompany",
        model: DEFAULT_MODEL,
      },
      { scopeKey: "" },
    );
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not load or offer workflow mentions when Tasks & Workflows is disabled", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return Response.json(
        String(input) === "/api/workflows"
          ? {
              workflows: [
                {
                  id: "morning-test",
                  name: "Morning Test",
                  description: "Run the morning checks.",
                },
              ],
            }
          : {},
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "#morning");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(knowledgeCommandMocks.listSkillCatalog).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/workflows")).toBe(false);
    expect(screen.queryByRole("option", { name: /Morning Test/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /#task/i })).not.toBeInTheDocument();
  });

  it("does not show Codex mention options when Codex is not connected", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "@");

    expect(screen.queryByRole("listbox", { name: "Mention menu" })).not.toBeInTheDocument();
  });

  it("does not send steering metadata for manually typed @codex", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "@codex check repo access");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "@codex check repo access",
    });
  });

  it("clears selected mention metadata when visible @codex text is deleted", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "@");
    await user.click(screen.getByRole("option", { name: /@codex/i }));
    await user.clear(textarea);
    await user.type(textarea, "check repo access");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "check repo access",
    });
  });

  it("selects, highlights, and reconciles multiple Skill mentions", async () => {
    const user = userEvent.setup();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
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
    ]);

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "/verification");
    const codingOption = await screen.findByRole("option", { name: /coding work/i });
    await user.click(codingOption);
    await user.type(textarea, "then /writing");
    await user.click(await screen.findByRole("option", { name: /writing work/i }));

    expect(textarea).toHaveValue("/coding-work then /writing-work ");
    const overlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(overlay?.querySelectorAll('[data-opencompany-chat-mention="skill"]')).toHaveLength(2);
    expect(overlay).toHaveTextContent("/coding-work then /writing-work");
    expect(textarea).toHaveClass("text-transparent");

    fireEvent.change(textarea, { target: { value: "/coding-work then continue" } });
    expect(textarea).toHaveValue("/coding-work then continue");
    const reconciledOverlay = textarea.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(
      reconciledOverlay?.querySelectorAll('[data-opencompany-chat-mention="skill"]'),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(chatMock.sendMessage).toHaveBeenCalledWith({
      text: "/coding-work then continue",
      metadata: {
        mentions: [{ kind: "skill", id: "coding-work" }],
      },
    });
  });

  it("does not offer Skills from the @ mention menu", async () => {
    const user = userEvent.setup();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
      {
        id: "coding-work",
        name: "Coding work",
        description: "Use focused verification for code changes.",
      },
    ]);

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "/coding");
    await screen.findByRole("option", { name: /coding work/i });
    await user.clear(textarea);
    await user.type(textarea, "@coding");

    expect(screen.queryByRole("option", { name: /coding work/i })).not.toBeInTheDocument();
  });

  it("resolves exact Skill mentions pasted into the composer", async () => {
    const user = userEvent.setup();
    knowledgeCommandMocks.listSkillCatalog.mockResolvedValue([
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
    ]);

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    const pastedText = "/product-feature use /add-integration-to-main-chat to add attio";
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

  it("retries the Skill catalog on the next mention-menu open after a failed fetch", async () => {
    const user = userEvent.setup();
    let catalogCalls = 0;
    knowledgeCommandMocks.listSkillCatalog.mockImplementation(async () => {
      catalogCalls += 1;
      if (catalogCalls === 1) throw new Error("Skill catalog unavailable.");
      return [
        {
          id: "coding-work",
          name: "Coding work",
          description: "Use focused verification for code changes.",
        },
      ];
    });

    render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
    await user.type(textarea, "/coding");
    await waitFor(() => expect(catalogCalls).toBe(1));
    expect(screen.queryByRole("option", { name: /coding work/i })).not.toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, "/coding");
    await screen.findByRole("option", { name: /coding work/i });
    expect(catalogCalls).toBe(2);
  });

  it("keeps a completed new chat visible while server props refresh", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    await user.type(
      screen.getByPlaceholderText("Ask opencompany anything..."),
      "Hello opencompany",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findAllByText("Hello opencompany")).toHaveLength(2);
    expect(screen.queryByText("No results yet.")).not.toBeInTheDocument();
  });

  it("keeps the home screen clean when there is no activity", () => {
    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userName="Louis" />);

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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
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
            model: DEFAULT_MODEL,
            preview: "Ready to review.",
            updatedAt: currentTimestamp(),
            state: "done_unseen",
          },
          {
            id: "seen_chat",
            title: "Done seen",
            model: DEFAULT_MODEL,
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
      <Surface
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
            version: 1,
            lastRunAt: null,
            nextRunAt: "2026-07-20T07:00:00.000Z",
            createdAt: currentTimestamp(),
            updatedAt: currentTimestamp(),
          },
        ]}
        defaultModel={DEFAULT_MODEL}
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
            model: DEFAULT_MODEL,
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

  it("updates a recurring Task through the versioned schedule command", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        taskSpawningEnabled
        workspaceId="workspace_1"
        tasks={[]}
        schedules={[
          {
            id: "schedule_1",
            name: "Monday update",
            sourceDescription: "Every Monday",
            cron: "0 9 * * 1",
            timezone: "Europe/Berlin",
            prompt: "Prepare the weekly update",
            enabled: true,
            version: 4,
            lastRunAt: null,
            nextRunAt: "2026-07-20T07:00:00.000Z",
            createdAt: currentTimestamp(),
            updatedAt: currentTimestamp(),
          },
        ]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pause Monday update" }));

    await waitFor(() =>
      expect(automationCommandMocks.updateSchedule).toHaveBeenCalledWith(
        "schedule_1",
        { expectedVersion: 4, enabled: false },
        { scopeKey: "workspace_1" },
      ),
    );
  });

  it("shows Codex chats in Chats when background task spawning is disabled", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
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
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={{
            id: `goat_chat_${engine}`,
            title: `${engine} chat`,
            model: DEFAULT_MODEL,
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

    const product = renderChat("opencompany");
    expect(screen.queryByRole("button", { name: "Open workspace" })).not.toBeInTheDocument();
    product.unmount();

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
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
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
              updatedAt: "2026-06-26T17:00:00.000Z",
            }),
            codexChatSummary({
              id: "old_pinned",
              title: "Pinned ready",
              status: "idle",
              updatedAt: "2026-06-26T17:00:00.000Z",
              pinnedAt: "2026-07-04T12:00:00.000Z",
            }),
            codexChatSummary({
              id: "old_hidden",
              title: "Old hidden",
              status: "idle",
              updatedAt: "2026-06-26T17:00:00.000Z",
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
      <Surface
        taskSpawningEnabled
        tasks={[
          {
            id: "task_1",
            displayId: "TASK-1",
            name: "Run market report",
            prompt: "Write a report",
            model: DEFAULT_MODEL,
            status: "succeeded",
            stage: "completed",
            result: "Done",
            error: null,
            archivedAt: null,
            createdAt: currentTimestamp(),
            updatedAt: currentTimestamp(),
          },
        ]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_MODEL,
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

  it("archives canonical results while keeping compatibility results read-only", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        taskSpawningEnabled
        tasks={[
          taskView({
            id: "canonical_task",
            displayId: "TASK-1",
            name: "Canonical result",
            sessionId: "canonical_conversation",
          }),
          taskView({
            id: "legacy_task",
            displayId: "TASK-2",
            name: "Legacy result",
            sessionId: null,
          }),
        ]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive Canonical result" }));

    expect(taskCommandMocks.archive).toHaveBeenCalledWith("canonical_task", { scopeKey: "" });
    expect(screen.queryByRole("button", { name: "Archive Legacy result" })).not.toBeInTheDocument();
  });

  it("hides home chats older than seven days and results older than one day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T17:44:00.000Z"));
    try {
      render(
        <Surface
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
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          recentChats={[
            {
              id: "recent_chat",
              title: "Recent chat",
              model: DEFAULT_MODEL,
              preview: "Visible",
              updatedAt: "2026-07-04T10:00:00.000Z",
            },
            {
              id: "old_chat",
              title: "Old chat",
              model: DEFAULT_MODEL,
              preview: "Hidden",
              updatedAt: "2026-06-26T10:00:00.000Z",
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_MODEL,
            preview: "Compare the latest pricing.",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive Market research" }));

    expect(updateHeadlessChatConversation).toHaveBeenCalledWith("chat_1", { archived: true });
    expect(screen.queryByText("Market research")).not.toBeInTheDocument();
  });

  it("restores a home chat when the archive request rejects", async () => {
    const user = userEvent.setup();
    headlessChatCommandMocks.updateConversation.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Market research",
            model: DEFAULT_MODEL,
            preview: "Compare the latest pricing.",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive Market research" }));

    await waitFor(() => expect(screen.getByText("Market research")).toBeInTheDocument());
    expect(routerMock.refresh).not.toHaveBeenCalled();
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
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText("Search chats or start something new..."),
      "Research Q3",
    );
    await user.click(within(dialog).getByRole("option", { name: 'Start new chat: "Research Q3"' }));
    const quickComposerInput = screen.getByPlaceholderText(
      "Ask opencompany anything, or describe a task...",
    );
    expect(quickComposerInput).toHaveValue("Research Q3");
    // Same controls as the main composer: model picker, attach button, submit button.
    expect(screen.getAllByLabelText("Model")).toHaveLength(2);
    expect(screen.getAllByLabelText("Attach files")).toHaveLength(2);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "Research Q3",
      model: DEFAULT_MODEL,
    });
    expect(body.clientMessageId).toMatch(/^ui_background_/);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(
      screen.queryByPlaceholderText("Ask opencompany anything, or describe a task..."),
    ).not.toBeInTheDocument();
    // Never navigates away from the home screen it was opened on.
    expect(screen.getByText("welcome back, there")).toBeInTheDocument();
  });

  it("highlights and strips an ampersand background directive in Cmd+K compose", async () => {
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
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} userWorkosId="user_1" />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    const quickComposerInput = screen.getByPlaceholderText(
      "Ask opencompany anything, or describe a task...",
    );
    await user.type(quickComposerInput, "& Research Q3");

    expect(screen.getByTestId("background-chat-hint")).toHaveTextContent(
      "Sending starts this as a new chat in the background.",
    );
    const overlay = quickComposerInput.parentElement?.querySelector(
      '[data-testid="composer-mention-overlay"]',
    );
    expect(
      overlay?.querySelector('[data-opencompany-chat-directive="background"]'),
    ).toHaveTextContent("&");
    expect(quickComposerInput).toHaveClass("text-transparent");

    await user.keyboard("{Enter}");

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "Research Q3",
    });
    expect(body.clientConversationId).toMatch(/^goat_chat_/);
  });

  it("routes a dropped file only to the Cmd+K composer while the compose view is open", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    const file = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    fireEvent.drop(window, {
      dataTransfer: {
        types: ["Files"],
        files: [file],
      },
    });

    await waitFor(() => expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledTimes(1));
    expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledWith({
      file,
      pendingId: expect.any(String),
    });
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

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // The model picker's popover content portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));
    await user.type(
      within(dialog).getByPlaceholderText("Ask opencompany anything, or describe a task..."),
      "Clone my repo",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(headlessChatMocks.startBackground).toHaveBeenCalledTimes(1));
    const body = headlessChatMocks.startBackground.mock.calls[0]![0];
    expect(body).toMatchObject({
      content: "Clone my repo",
      engine: { type: "codex", schemaVersion: 1 },
    });
    expect(body.clientConversationId).toMatch(/^goat_chat_/);
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        workspaceId="workspace_1"
        codexConnected
        userWorkosId="user_1"
        taskSpawningEnabled
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    await user.click(screen.getByText("Cloud Codex sandbox"));

    const quickComposerInput = within(dialog).getByPlaceholderText(
      "Ask opencompany anything, or describe a task...",
    );
    await user.type(quickComposerInput, "#");
    const workflowOption = await within(dialog).findByRole("option", { name: /Morning Test/i });
    expect(within(dialog).queryByRole("option", { name: /Ad-hoc task/i })).not.toBeInTheDocument();
    await user.click(workflowOption);
    await user.type(quickComposerInput, "run today's checks");
    await user.click(within(dialog).getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalled());
    expect(automationCommandMocks.invokeWorkflow).toHaveBeenCalledWith(
      "morning-test",
      {
        description: "#morning-test run today's checks",
      },
      { scopeKey: "workspace_1" },
    );
    expect(headlessChatMocks.startBackground).not.toHaveBeenCalled();
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the Cmd+K composer open and the draft intact when goal mode settings are invalid", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} codexConnected />);

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // Popover content (model list, goal mode fields) portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));
    await user.click(within(dialog).getByRole("button", { name: "Goal mode" }));
    await user.click(screen.getByRole("checkbox", { name: "Goal mode" }));
    await user.type(screen.getByPlaceholderText("Objective"), "Fix the flaky tests");
    await user.type(screen.getByPlaceholderText("Token budget"), "abc");
    const quickComposerInput = within(dialog).getByPlaceholderText(
      "Ask opencompany anything, or describe a task...",
    );
    await user.type(quickComposerInput, "Run the failing suite");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));

    // Invalid settings must be caught before the dialog closes or any request fires —
    // otherwise the draft is lost behind a misleading "started" toast (regression guard).
    expect(headlessChatMocks.startBackground).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(quickComposerInput).toHaveValue("Run the failing suite");
  });

  it("does not persist the Cmd+K model choice as the app-wide remembered model", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        codexConnected
        userWorkosId="user_1"
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    await user.click(within(dialog).getByRole("button", { name: "Model" }));
    // The model picker's popover content portals outside the dialog's DOM subtree.
    await user.click(screen.getByText("Cloud Codex sandbox"));

    expect(window.localStorage.getItem("opencompany-goat-main-chat-selection:user_1")).toBeNull();
  });

  it("searches and jumps to an existing chat from the Cmd+K palette", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Q2 planning",
            model: DEFAULT_MODEL,
            preview: "Let's plan Q2",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText("Search chats or start something new..."),
      "Q2 planning",
    );
    const result = await within(dialog).findByText("Q2 planning");
    await user.click(result);

    expect(routerMock.push).toHaveBeenCalledWith("/chat/chat_1");
  });

  it("mixes archived chats into the Cmd+K palette by recency and restores them", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_newest",
            title: "Newest active",
            model: DEFAULT_MODEL,
            preview: "Newest preview",
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
          {
            id: "chat_oldest",
            title: "Oldest active",
            model: DEFAULT_MODEL,
            preview: "Oldest preview",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ]}
        archivedChats={[
          {
            id: "chat_archived",
            title: "Middle archived",
            model: DEFAULT_MODEL,
            preview: "Middle preview",
            updatedAt: "2026-08-08T12:00:00.000Z",
            archived: true,
          },
        ]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    const newestOption = within(dialog).getByRole("option", { name: /Newest active/ });
    const archivedOption = within(dialog).getByRole("option", { name: /Middle archived/ });
    const oldestOption = within(dialog).getByRole("option", { name: /Oldest active/ });

    expect(newestOption.compareDocumentPosition(archivedOption)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(archivedOption.compareDocumentPosition(oldestOption)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(archivedOption).getByText("Archived")).toHaveClass("rounded-full");

    await user.click(archivedOption);

    await waitFor(() =>
      expect(updateHeadlessChatConversation).toHaveBeenCalledWith("chat_archived", {
        archived: false,
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/chat/chat_archived");
  });

  it("drills from Cmd+K search into compose on Enter, prefilled with the typed query", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText("Search chats or start something new..."),
      "Research Q3",
    );
    // The pinned "Start new chat" action is the only forceMounted item, so it stays
    // highlighted as the user types — Enter should drill into compose, not submit yet.
    await user.keyboard("{Enter}");

    const quickComposerInput = within(dialog).getByPlaceholderText(
      "Ask opencompany anything, or describe a task...",
    );
    expect(quickComposerInput).toHaveValue("Research Q3");
  });

  it("backs out of Cmd+K compose to search on Escape, and closes the palette on a second Escape", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={null}
        recentChats={[
          {
            id: "chat_1",
            title: "Q2 planning",
            model: DEFAULT_MODEL,
            preview: "Let's plan Q2",
            updatedAt: currentTimestamp(),
          },
        ]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: "Start new chat" }));
    expect(
      within(dialog).getByPlaceholderText("Ask opencompany anything, or describe a task..."),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText("Search chats or start something new..."),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not navigate again when the stream confirms an accepted session id", async () => {
    const user = userEvent.setup();

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
    const request = chatMock.preparedRequestBodies[0] as { newSessionId: string };
    acceptHeadlessConversation(request.newSessionId);
    act(() => chatMock.finishWithSessionId?.(request.newSessionId));

    expect(historyMock.replaceState).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledWith(`/chat/${request.newSessionId}`, {
      scroll: false,
    });
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("does not route back to chat when a turn finishes after navigating away", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />,
    );

    await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    pathnameMock.value = "/brain";
    rerender(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    act(() => {
      chatMock.finishWithSessionId?.("goat_chat_123");
    });

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("keeps a completed existing chat turn visible while server props refresh", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
    expect(updateHeadlessChatConversation).not.toHaveBeenCalledWith("chat_1", { archived: true });
  });

  it("closes the open chat when Escape is pressed", async () => {
    const user = userEvent.setup();

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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

    render(<Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />);

    const textarea = screen.getByPlaceholderText("Ask opencompany anything...");
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "user_1",
              role: "user",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Hello opencompany" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("status", { name: "opencompany is working" })).toBeInTheDocument();
    expect(screen.getByText(/^\d+\.\ds$/)).toBeInTheDocument();
  });

  it("keeps the live elapsed timer visible once assistant output is visible", () => {
    chatMock.status = "streaming";

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "user_1",
              role: "user",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Hello opencompany" }],
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
    expect(screen.getByRole("status", { name: "opencompany is working" })).toBeInTheDocument();
    expect(screen.getByText(/^\d+\.\ds$/)).toBeInTheDocument();
  });

  it("does not show a live timer for a finalized turn when stream and runtime state are stale", () => {
    chatMock.status = "streaming";

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_completed_1",
          title: "Completed chat",
          model: DEFAULT_MODEL,
          engine: "opencompany",
          runtime: {
            status: "running",
            activeRunId: "run_completed_1",
            hasError: false,
            updatedAt: currentTimestamp(),
          },
          activityState: "working",
          hasUnseen: false,
          messages: [
            {
              id: "assistant_completed_1",
              role: "assistant",
              metadata: {
                sessionId: "chat_completed_1",
                runId: "run_completed_1",
                timing: { durationMs: 40_795 },
              },
              parts: [{ type: "text", text: "Finished answer" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("Turn completed in 40.8s")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "opencompany is working" }),
    ).not.toBeInTheDocument();
  });

  it("renders assistant text from UI message parts", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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

  it("keeps completed assistant text clear of the expanded main composer", async () => {
    let composerHeight = 96;
    let resizeObserverCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this instanceof HTMLFormElement) {
        return domRectWithHeight(composerHeight);
      }
      return domRectWithHeight(0);
    });

    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [{ type: "text", text: "Finished answer" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Finished answer")).toBeInTheDocument();
    const threadContent = screen.getByTestId("chat-thread-content");
    await waitFor(() => expect(threadContent).toHaveStyle({ paddingBottom: "160px" }));

    composerHeight = 252;
    fireEvent.change(screen.getByPlaceholderText("Reply..."), {
      target: { value: "Line one\nLine two\nLine three\nLine four\nLine five" },
    });
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    await waitFor(() => expect(threadContent).toHaveStyle({ paddingBottom: "272px" }));
  });

  it("renders the final elapsed time for completed assistant turns", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
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
      <Surface
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
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
          ],
        }}
      />,
    );

    expect(screen.getByText("TASK-42 · Failed")).toBeInTheDocument();
    expect(screen.queryByText(/Task running/i)).not.toBeInTheDocument();
  });

  it("renders a metadata-only task card from the task state lookup", () => {
    render(
      <Surface
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
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [
                { type: "text", text: "I'll check your Brain." },
                {
                  type: BRAIN_TOOL_PART_TYPE,
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
            } as unknown as ChatUiMessage,
          ],
        }}
      />,
    );

    const intro = screen.getByText("I'll check your Brain.");
    const toolRow = screen.getByTestId("chat-tool-call-goat_brain");

    expect(within(toolRow).getByText("Brain")).toBeInTheDocument();
    expect(within(toolRow).getByText("running")).toBeInTheDocument();
    expect(within(toolRow).getByText("brain query --text hiring --limit 5")).toBeInTheDocument();
    expect(intro.compareDocumentPosition(toolRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders unfinished tool calls from stopped assistant turns as stopped", () => {
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1", aborted: true },
              parts: [
                {
                  type: BRAIN_TOOL_PART_TYPE,
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
            } as unknown as ChatUiMessage,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [
                {
                  type: BRAIN_TOOL_PART_TYPE,
                  toolCallId: "tool_brain_1",
                  state: "output-available",
                  input: {
                    command: "create",
                    flags: {
                      id: "ada-lovelace",
                      title: "Ada Lovelace",
                      type: "person",
                      json: true,
                    },
                    stdin: "Ada Lovelace is a person.",
                  },
                  output: {
                    ok: false,
                    exitCode: 1,
                    command:
                      'create --id ada-lovelace --title "Ada Lovelace" --type person --json --source-ref goat-chat:user_message_1',
                    argv: [
                      "create",
                      "--id",
                      "ada-lovelace",
                      "--title",
                      "Ada Lovelace",
                      "--type",
                      "person",
                      "--json",
                      "--source-ref",
                      "goat-chat:user_message_1",
                    ],
                    stdout: JSON.stringify({
                      ok: true,
                      applied: [{ id: "ada-lovelace" }],
                    }),
                    parsed: {
                      ok: true,
                      applied: [{ id: "ada-lovelace" }],
                    },
                    stderr: "",
                  },
                },
                {
                  type: BRAIN_TOOL_PART_TYPE,
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
            } as unknown as ChatUiMessage,
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
    expect(within(firstBrainCall).getByText(/Ada Lovelace is a person/)).toBeInTheDocument();
    expect(within(firstBrainCall).getByText(/goat-chat:user_message_1/)).toBeInTheDocument();
  });

  it("marks doctor health errors as a failed brain tool call", async () => {
    const user = userEvent.setup();
    render(
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
          messages: [
            {
              id: "assistant_1",
              role: "assistant",
              metadata: { sessionId: "chat_1" },
              parts: [
                {
                  type: BRAIN_TOOL_PART_TYPE,
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
            } as unknown as ChatUiMessage,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
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
      <Surface
        tasks={[]}
        defaultModel={DEFAULT_MODEL}
        initialChat={{
          id: "chat_1",
          title: "Chat",
          model: DEFAULT_MODEL,
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
            } as unknown as ChatUiMessage,
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
        <Surface
          taskSpawningEnabled
          tasks={[taskView({ createdAt: "2026-07-02T17:43:45.000Z" })]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
        />,
      );

      expect(screen.getByText("just now")).toBeInTheDocument();
      expect(screen.queryByText("0m ago")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("pane contract", () => {
    it("only lets the active pane's Cmd/Ctrl+K open the command palette when two panes are mounted", async () => {
      const user = userEvent.setup();
      render(
        <>
          <Surface tasks={[]} defaultModel={DEFAULT_MODEL} initialChat={null} />
          <Surface
            tasks={[]}
            defaultModel={DEFAULT_MODEL}
            initialChat={null}
            isActivePane={false}
          />
        </>,
      );

      await user.keyboard("{Meta>}k{/Meta}");

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });

    it("only lets the active pane's Escape key close its own chat when two panes are mounted", async () => {
      const user = userEvent.setup();
      render(
        <>
          <Surface
            tasks={[]}
            defaultModel={DEFAULT_MODEL}
            initialChat={{
              id: "chat_active_pane",
              title: "Active pane chat",
              model: DEFAULT_MODEL,
              messages: [],
            }}
          />
          <Surface
            tasks={[]}
            defaultModel={DEFAULT_MODEL}
            initialChat={{
              id: "chat_inactive_pane",
              title: "Inactive pane chat",
              model: DEFAULT_MODEL,
              messages: [],
            }}
            isActivePane={false}
          />
        </>,
      );

      expect(screen.getAllByPlaceholderText("Reply...")).toHaveLength(2);

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.getAllByPlaceholderText("Reply...")).toHaveLength(1));
      expect(screen.getByPlaceholderText("Ask opencompany anything...")).toBeInTheDocument();
    });

    it("only lets the active pane consume a window-level file drop when two panes are mounted", async () => {
      render(
        <>
          <Surface
            tasks={[]}
            defaultModel={DEFAULT_MODEL}
            initialChat={null}
            userWorkosId="user_1"
          />
          <Surface
            tasks={[]}
            defaultModel={DEFAULT_MODEL}
            initialChat={null}
            userWorkosId="user_1"
            isActivePane={false}
          />
        </>,
      );

      // A CSV needs no per-model attachment capability, unlike PDFs/images.
      const file = new File(["a,b"], "data.csv", { type: "text/csv" });
      fireEvent.drop(window, { dataTransfer: { types: ["Files"], files: [file] } });

      await waitFor(() => expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledTimes(1));
      expect(attachmentUploadMock.canonicalUpload).toHaveBeenCalledWith({
        file,
        pendingId: expect.any(String),
      });
    });

    it("reports local chat selection changes through onOpenChat", async () => {
      const user = userEvent.setup();
      const onOpenChat = vi.fn();
      render(
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={{
            id: "chat_reported",
            title: "Reported chat",
            model: DEFAULT_MODEL,
            messages: [],
          }}
          onOpenChat={onOpenChat}
        />,
      );

      expect(onOpenChat).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");

      expect(onOpenChat).toHaveBeenCalledWith(null);
    });

    it("reports an optimistic selection before durable resolution without moving the URL when the pane is inactive", async () => {
      const user = userEvent.setup();
      const onOpenChat = vi.fn();
      const onConversationResolved = vi.fn();
      render(
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={null}
          workspaceId="workspace_1"
          isActivePane={false}
          onOpenChat={onOpenChat}
          onConversationResolved={onConversationResolved}
        />,
      );

      await user.type(screen.getByPlaceholderText("Ask opencompany anything..."), "Start now");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => expect(chatMock.preparedRequestBodies).toHaveLength(1));
      const optimisticSessionId = (chatMock.preparedRequestBodies[0] as { newSessionId: string })
        .newSessionId;

      expect(onOpenChat).toHaveBeenCalledWith({
        id: optimisticSessionId,
        model: DEFAULT_MODEL,
        engine: "opencompany",
      });
      expect(onConversationResolved).not.toHaveBeenCalled();

      acceptHeadlessConversation(optimisticSessionId);

      expect(onConversationResolved).toHaveBeenCalledWith({
        optimisticId: optimisticSessionId,
        durableId: optimisticSessionId,
      });
      expect(routerMock.replace).not.toHaveBeenCalled();
    });

    it("detaches a pane on close without cancelling its active durable Run", async () => {
      const user = userEvent.setup();
      const transportCancel = vi
        .spyOn(HeadlessChatTransport.prototype, "cancel")
        .mockResolvedValue(false);
      const onClosePane = vi.fn();

      render(
        <Surface
          tasks={[]}
          defaultModel={DEFAULT_MODEL}
          initialChat={{
            id: "chat_pane_active_run",
            title: "Active pane run",
            model: DEFAULT_MODEL,
            engine: "opencompany",
            runtime: {
              status: "running",
              activeRunId: "run_pane_active",
              hasError: false,
              updatedAt: currentTimestamp(),
            },
            activityState: "working",
            hasUnseen: false,
            messages: [],
          }}
          onClosePane={onClosePane}
        />,
      );

      await screen.findByRole("status", { name: "opencompany is working" });

      await user.keyboard("{Escape}");

      expect(onClosePane).toHaveBeenCalledOnce();
      expect(transportCancel).not.toHaveBeenCalled();
      expect(chatMock.stop).not.toHaveBeenCalled();
      expect(routerMock.replace).not.toHaveBeenCalled();
    });
  });
});

function taskView(overrides: Partial<TaskView> = {}): TaskView {
  const now = currentTimestamp();
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Summarize latest email",
    prompt: "Summarize latest email",
    model: DEFAULT_MODEL,
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
  overrides: Partial<Omit<ChatSummaryView, "runtime">> & {
    status?: ConversationRuntimeView["status"] | null;
    hasError?: boolean;
  } = {},
): ChatSummaryView {
  const now = currentTimestamp();
  const { status = "idle", hasError = false, ...summaryOverrides } = overrides;
  const updatedAt = summaryOverrides.updatedAt ?? now;
  const activityState =
    status === "queued" || status === "starting" || status === "running" ? "working" : "idle";
  return {
    id: "goat_chat_codex_1",
    title: "Codex task",
    model: DEFAULT_MODEL,
    engine: "codex",
    preview: "Codex is working on the repository.",
    updatedAt,
    pinnedAt: null,
    runtime: status ? { status, activeRunId: null, hasError, updatedAt } : null,
    activityState,
    hasUnseen: false,
    ...summaryOverrides,
  };
}

function currentTimestamp() {
  return new Date().toISOString();
}

function domRectWithHeight(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 720,
    height,
    top: 0,
    right: 720,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function LocalChatStateProbe({ sessionId }: { sessionId: string }) {
  const states = useLocalChatStates();
  return <div data-testid="local-chat-state">{states.get(sessionId) ?? "none"}</div>;
}

function LocalChatStatesProbe() {
  const states = useLocalChatStates();
  const entries = [...states.entries()].map(([sessionId, state]) => `${sessionId}:${state}`);
  return <div data-testid="local-chat-states">{entries.join(",") || "none"}</div>;
}

function OptimisticChatSummariesProbe() {
  const summaries = useOptimisticChatSummaries();
  const entries = summaries.map((entry) => `${entry.chat.id}:${entry.chat.title}`);
  return <div data-testid="optimistic-chat-summaries">{entries.join(",") || "none"}</div>;
}

async function nextAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
