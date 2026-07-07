"use client";

import { useChat } from "@ai-sdk/react";
import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@opencompany/ui/components/command";
import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import { DefaultChatTransport } from "ai";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDotDashed,
  Clock,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Play,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Markdown } from "@/components/Markdown";
import { useHydrated } from "@/components/useHydrated";
import {
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolOutput,
  type GoatChatSessionView,
  type GoatChatSummaryView,
  type GoatChatUiMessage,
  type GoatStoredChatMessage,
  type GoatTaskCardMetadata,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_TASK_TOOL_PART_TYPE,
  type StartTaskToolOutput,
  textFromGoatChatUiMessage,
  toGoatChatUiMessage,
  WEB_SEARCH_TOOL_NAME,
} from "@/lib/chat-ui";
import {
  createGoatCollections,
  type GoatChatMessageRow,
  type GoatTaskRow,
  type GoatTaskScheduleRow,
} from "@/lib/task-collections";
import { GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import {
  deleteGoatTaskScheduleAction,
  type GoatTaskScheduleView,
  runGoatTaskScheduleNowAction,
  setGoatTaskScheduleEnabledAction,
  updateGoatTaskScheduleAction,
} from "@/lib/task-schedules";
import { archiveGoatTaskAction } from "@/lib/tasks";
import { updateGoatTimezoneAction } from "@/lib/user-preferences";

const TEXTAREA_MAX_HEIGHT_PX = 128;
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
const BACKGROUND_CHAT_PROMPT_MAX_LENGTH = 10_000;

export type GoatTaskView = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
  model: string;
  scheduleId?: string | null;
  scheduledFor?: string | null;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function GoatSurface({
  tasks,
  schedules = [],
  defaultModel,
  initialChat,
  recentChats = [],
}: {
  tasks: readonly GoatTaskView[];
  schedules?: readonly GoatTaskScheduleView[];
  defaultModel: string;
  initialChat: GoatChatSessionView | null;
  recentChats?: readonly GoatChatSummaryView[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | null>(null);
  const locallyHiddenSessionIdsRef = useRef<Set<string>>(new Set());
  const isPinnedAtBottomRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"home" | "chat">(() => (initialChat ? "chat" : "home"));
  const [chatSessionId, setChatSessionId] = useState<string | null>(initialChat?.id ?? null);
  const [chatModel, setChatModel] = useState(initialChat?.model ?? defaultModel);
  const [newChatCommandOpen, setNewChatCommandOpen] = useState(false);
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [backgroundChatCount, setBackgroundChatCount] = useState(0);
  const [locallyStoppedAssistantMessageIds, setLocallyStoppedAssistantMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [optimisticallyArchivedIds, setOptimisticallyArchivedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [liveChatTasks, setLiveChatTasks] = useState<readonly GoatTaskView[] | null>(null);
  const [, startArchiveTransition] = useTransition();
  const transport = useMemo(
    () =>
      new DefaultChatTransport<GoatChatUiMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            sessionId: chatSessionId,
            model: chatModel,
            message: messages.at(-1),
          },
        }),
      }),
    [chatModel, chatSessionId],
  );
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error: chatError,
    clearError,
  } = useChat<GoatChatUiMessage>({
    id: initialChat?.id ?? "goat-chat-main",
    messages: initialChat?.messages ?? [],
    transport,
    onFinish: ({ message }) => {
      const sessionId = message.metadata?.sessionId;
      if (sessionId) {
        locallyHiddenSessionIdsRef.current.delete(sessionId);
        setChatSessionId(sessionId);
        router.replace(`/?chat=${encodeURIComponent(sessionId)}`);
      }
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message || "Goat could not answer that right now.");
    },
  });
  const isGenerating = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;
  const showThinkingBubble = isGenerating && shouldShowThinkingBubble(messages);
  const trimmedNewChatPrompt = newChatPrompt.trim();
  const newChatPromptValid =
    trimmedNewChatPrompt.length > 0 &&
    trimmedNewChatPrompt.length <= BACKGROUND_CHAT_PROMPT_MAX_LENGTH;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const chatTaskLookup = useMemo(
    () =>
      buildChatTaskLookup({
        messages,
        tasks,
        liveTasks: liveChatTasks,
      }),
    [liveChatTasks, messages, tasks],
  );

  useEffect(() => {
    if (isGenerating) return;
    // router.refresh() can lag one render behind local useChat state. Keep local
    // turns visible until the server props catch up for both new and existing chats.
    const localHasChat = mode === "chat" && (messages.length > 0 || Boolean(chatSessionId));
    const serverMessageCount = initialChat?.messages.length ?? 0;
    const serverIsSameChat = Boolean(
      initialChat && chatSessionId && initialChat.id === chatSessionId,
    );
    const serverIsBehindLocal =
      localHasChat &&
      ((!initialChat && messages.length > 0) ||
        (serverIsSameChat && messages.length > serverMessageCount));
    if (serverIsBehindLocal) return;
    if (initialChat && locallyHiddenSessionIdsRef.current.has(initialChat.id)) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      setChatSessionId(initialChat?.id ?? null);
      setChatModel(initialChat?.model ?? defaultModel);
      setMessages(initialChat?.messages ?? []);
      setMode(initialChat ? "chat" : "home");
    });
    return () => cancelAnimationFrame(frame);
  }, [chatSessionId, defaultModel, initialChat, isGenerating, messages.length, mode, setMessages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  useLayoutEffect(() => {
    if (mode !== "chat" || !hasMessages) return;
    const thread = threadRef.current;
    if (!thread || typeof thread.scrollTo !== "function") return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "auto" });
    isPinnedAtBottomRef.current = true;
  }, [hasMessages, mode]);

  useEffect(() => {
    if (mode !== "chat" || !isPinnedAtBottomRef.current) return;
    if (messages.length === 0 && status !== "submitted" && status !== "streaming") return;
    const thread = threadRef.current;
    if (!thread || typeof thread.scrollTo !== "function") return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "auto" });
  }, [messages, mode, status]);

  useEffect(() => {
    if (!chatError || chatError.message === lastError.current) return;
    lastError.current = chatError.message;
    setMode("chat");
  }, [chatError]);

  useEffect(
    () => () => {
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    void updateGoatTimezoneAction(timezone).catch(() => undefined);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== "n" || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }

      event.preventDefault();
      setNewChatCommandOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const archiveTask = (task: GoatTaskView) => {
    setOptimisticallyArchivedIds((current) => new Set(current).add(task.id));
    startArchiveTransition(async () => {
      const result = await archiveGoatTaskAction(task.id);
      if (result.ok) {
        return;
      }

      setOptimisticallyArchivedIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
      toast.error(result.error ?? "Could not archive task.");
    });
  };

  const startBackgroundChat = useCallback(
    (prompt: string) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return;
      if (trimmedPrompt.length > BACKGROUND_CHAT_PROMPT_MAX_LENGTH) {
        toast.error(
          `Messages can be at most ${BACKGROUND_CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
        );
        return;
      }

      setNewChatCommandOpen(false);
      setNewChatPrompt("");
      setBackgroundChatCount((count) => count + 1);
      toast("Started a new chat in the background.");

      void runBackgroundChatTurn({
        prompt: trimmedPrompt,
        model: defaultModel,
      })
        .then(() => {
          if (!mountedRef.current) return;
          router.refresh();
          toast.success("Background chat is ready.");
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          toast.error(error instanceof Error ? error.message : "Could not start that chat.");
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setBackgroundChatCount((count) => Math.max(0, count - 1));
        });
    },
    [defaultModel, router],
  );

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isGenerating) return;

    const prompt = input.trim();
    if (!prompt) return;

    clearError();
    setMode("chat");
    isPinnedAtBottomRef.current = true;
    setLocallyStoppedAssistantMessageIds(new Set());
    setInput("");
    void sendMessage({ text: prompt }).catch((error) => {
      setInput(prompt);
      toast.error(error instanceof Error ? error.message : "Goat could not answer that right now.");
    });
  };

  const closeChat = useCallback(() => {
    const hidingSessionId = chatSessionId;
    if (isGenerating) void stop();
    if (hidingSessionId) locallyHiddenSessionIdsRef.current.add(hidingSessionId);
    setMode("home");
    setMessages([]);
    setChatSessionId(null);
    clearError();
    router.replace("/");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [chatSessionId, clearError, isGenerating, router, setMessages, stop]);

  const stopGeneration = useCallback(() => {
    const lastAssistantMessage = messages.findLast((message) => message.role === "assistant");
    if (lastAssistantMessage) {
      setLocallyStoppedAssistantMessageIds((current) =>
        new Set(current).add(lastAssistantMessage.id),
      );
    }
    void stop();
  }, [messages, stop]);

  useEffect(() => {
    if (mode !== "chat") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeChat();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeChat, mode]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const markUserScrollIntent = () => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = setTimeout(() => {
      userScrollIntentRef.current = false;
    }, 250);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden">
      <CommandDialog
        open={newChatCommandOpen}
        onOpenChange={setNewChatCommandOpen}
        title="New Goat Chat"
        description="Create a new Goat chat in the background."
        className="top-[22%] max-w-xl translate-y-0 border-border bg-surface p-0 text-ink shadow-[0_18px_60px_rgba(15,15,15,0.18)]"
      >
        <CommandInput
          value={newChatPrompt}
          onValueChange={setNewChatPrompt}
          placeholder="Describe the new chat or task..."
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            startBackgroundChat(newChatPrompt);
          }}
        />
        <CommandList>
          <CommandEmpty>Type what Goat should do.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem
              value={`Create new chat ${newChatPrompt}`}
              disabled={!newChatPromptValid}
              onSelect={() => startBackgroundChat(newChatPrompt)}
              className="gap-3"
            >
              {backgroundChatCount > 0 ? (
                <LoaderCircle
                  size={16}
                  strokeWidth={2}
                  className="shrink-0 animate-spin text-ink-subtle"
                />
              ) : (
                <MessageSquarePlus size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">
                  Create new background chat
                </p>
                <p className="truncate text-[12px] text-ink-subtle">
                  {trimmedNewChatPrompt || "Start a chat that can spawn a task"}
                </p>
              </div>
              <CommandShortcut>Enter</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      {mode === "home" ? (
        <div className="absolute right-4 top-4 z-20 flex items-center gap-1">
          <Link
            href="/brain"
            aria-label="Brain"
            title="Brain"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <BookOpen size={16} strokeWidth={2} />
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Settings size={16} strokeWidth={2} />
          </Link>
        </div>
      ) : null}

      {mode === "home" ? (
        <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-[560px] flex-col gap-8 pb-40 pt-24">
            <header>
              <h1 className="text-[42px] font-semibold leading-none tracking-normal text-ink">
                Goat
              </h1>
            </header>

            <section className="flex flex-col gap-1">
              <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Chats
              </h2>
              <ChatHistoryList
                chats={recentChats}
                onSelect={(chatId) => locallyHiddenSessionIdsRef.current.delete(chatId)}
              />
            </section>

            <section className="flex flex-col gap-1">
              <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Routines
              </h2>
              <LiveSchedulesList schedules={schedules} />
            </section>

            <section className="flex flex-col gap-1">
              <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Results
              </h2>
              <LiveResultsList
                tasks={tasks}
                optimisticallyArchivedIds={optimisticallyArchivedIds}
                onArchive={archiveTask}
              />
            </section>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 w-full flex-1 flex-col items-center">
          <div className="w-full px-6 pb-2 pt-5">
            <div className="mx-auto flex w-full max-w-[720px] items-center justify-end">
              <button
                type="button"
                aria-label="Close chat"
                onClick={closeChat}
                className="flex items-center gap-1 rounded-full border border-surface-subtle bg-surface px-2.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:border-ink/15 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                Close
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          </div>

          <div
            ref={threadRef}
            className="min-h-0 w-full flex-1 justify-center overflow-y-auto px-6"
            onWheel={markUserScrollIntent}
            onTouchMove={markUserScrollIntent}
            onScroll={(event) => {
              if (!userScrollIntentRef.current) return;
              const el = event.currentTarget;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              isPinnedAtBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
            }}
          >
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 pb-40 pt-2">
              {messages.map((message) => (
                <Bubble
                  key={message.id}
                  message={message}
                  taskLookup={chatTaskLookup}
                  stopped={locallyStoppedAssistantMessageIds.has(message.id)}
                />
              ))}
              {showThinkingBubble ? <ThinkingBubble /> : null}
            </div>
          </div>
        </div>
      )}

      {mode === "chat" && chatSessionId ? (
        <LiveChatMessages sessionId={chatSessionId} setMessages={setMessages} />
      ) : null}
      {mode === "chat" ? <LiveChatTasks setTasks={setLiveChatTasks} /> : null}

      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-canvas via-canvas to-transparent px-6 pb-6 pt-8"
      >
        <div className="pointer-events-auto flex w-full max-w-[720px] flex-col gap-2">
          {chatError ? (
            <p
              className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              role="alert"
            >
              {chatError.message || "Goat could not answer that right now."}
            </p>
          ) : null}
          <div className="flex items-end gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-2.5 shadow-[0_8px_24px_rgba(15,15,15,0.08)] transition-colors duration-150 focus-within:border-border-strong">
            <textarea
              ref={inputRef}
              rows={1}
              id="prompt"
              name="prompt"
              value={input}
              placeholder={mode === "chat" ? "Reply..." : "Ask a question or describe a task..."}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={isGenerating}
              className="max-h-32 flex-1 resize-none self-center bg-transparent py-[3px] text-[13.5px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
              style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              maxLength={10_000}
              required
            />
            <SubmitButton
              disabled={!input.trim()}
              isGenerating={isGenerating}
              onStop={stopGeneration}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

function LiveChatMessages({
  sessionId,
  setMessages,
}: {
  sessionId: string;
  setMessages: React.Dispatch<React.SetStateAction<GoatChatUiMessage[]>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <LiveChatMessageSubscriber sessionId={sessionId} setMessages={setMessages} />;
}

function LiveChatMessageSubscriber({
  sessionId,
  setMessages,
}: {
  sessionId: string;
  setMessages: React.Dispatch<React.SetStateAction<GoatChatUiMessage[]>>;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const messagesCollection = useMemo(
    () => collections.chatMessages(sessionId),
    [collections, sessionId],
  );
  const { data: rows } = useLiveQuery((q) => q.from({ message: messagesCollection }));
  const liveMessages = useMemo(() => {
    return ((rows ?? []) as GoatChatMessageRow[])
      .toSorted((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map(chatMessageRowToUiMessage);
  }, [rows]);

  useEffect(() => {
    if (liveMessages.length === 0) return;
    setMessages((current) => {
      const currentIds = new Set(current.map((message) => message.id));
      const missingMessages = liveMessages.filter((message) => !currentIds.has(message.id));
      if (missingMessages.length === 0) return current;
      return [...current, ...missingMessages];
    });
  }, [liveMessages, setMessages]);

  return null;
}

function LiveChatTasks({
  setTasks,
}: {
  setTasks: Dispatch<SetStateAction<readonly GoatTaskView[] | null>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <LiveChatTaskSubscriber setTasks={setTasks} />;
}

function LiveChatTaskSubscriber({
  setTasks,
}: {
  setTasks: Dispatch<SetStateAction<readonly GoatTaskView[] | null>>;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows } = useLiveQuery((q) => q.from({ task: collections.tasks }));
  const liveTasks = useMemo(() => (rows ?? []).map(taskRowToView), [rows]);

  useEffect(() => {
    setTasks(liveTasks);
  }, [liveTasks, setTasks]);

  return null;
}

function ChatHistoryList({
  chats,
  onSelect,
}: {
  chats: readonly GoatChatSummaryView[];
  onSelect: (chatId: string) => void;
}) {
  if (chats.length === 0) {
    return <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">No chats yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {chats.map((chat) => (
        <Link
          key={chat.id}
          href={`/?chat=${encodeURIComponent(chat.id)}`}
          onClick={() => onSelect(chat.id)}
          className="group/chat flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Clock
            size={15}
            strokeWidth={2}
            className="shrink-0 text-ink-subtle group-hover/chat:text-ink-muted"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[14px] font-medium leading-tight text-ink">
                {chat.title}
              </span>
              <span className="shrink-0 text-[12px] leading-tight text-ink-subtle">
                {formatRelativeTime(chat.updatedAt)}
              </span>
            </div>
            <p className="truncate text-[12.5px] leading-4 text-ink-subtle">{chat.preview}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}

function LiveSchedulesList({ schedules }: { schedules: readonly GoatTaskScheduleView[] }) {
  const hydrated = useHydrated();
  if (!hydrated) return <ScheduleRows schedules={schedules} />;
  return <LiveSchedulesSubscriber initialSchedules={schedules} />;
}

function LiveSchedulesSubscriber({
  initialSchedules,
}: {
  initialSchedules: readonly GoatTaskScheduleView[];
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) =>
    q.from({ schedule: collections.taskSchedules }),
  );
  const liveSchedules = useMemo(
    () => (rows ?? []).filter((row) => !row.deleted_at).map(taskScheduleRowToView),
    [rows],
  );
  const schedules = isLoading && initialSchedules.length > 0 ? initialSchedules : liveSchedules;
  return <ScheduleRows schedules={schedules} />;
}

function ScheduleRows({ schedules }: { schedules: readonly GoatTaskScheduleView[] }) {
  const visible = schedules
    .filter((schedule) => schedule.id)
    .toSorted((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());

  if (visible.length === 0) {
    return (
      <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">No recurring tasks yet.</p>
    );
  }

  return visible.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />);
}

function ScheduleRow({ schedule }: { schedule: GoatTaskScheduleView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(schedule.name);
  const [editCron, setEditCron] = useState(schedule.cron);
  const [editTimezone, setEditTimezone] = useState(schedule.timezone);
  const [editPrompt, setEditPrompt] = useState(schedule.prompt);

  const openEdit = () => {
    setEditName(schedule.name);
    setEditCron(schedule.cron);
    setEditTimezone(schedule.timezone);
    setEditPrompt(schedule.prompt);
    setIsEditing(true);
  };

  const saveEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateGoatTaskScheduleAction(schedule.id, {
        name: editName,
        sourceDescription: `${editCron.trim()} - ${editTimezone.trim()}`,
        cron: editCron,
        timezone: editTimezone,
        prompt: editPrompt,
      });
      if (result.ok) {
        setIsEditing(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="group/routine rounded-lg transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <div className="flex min-h-12 items-center gap-3 px-2 py-1.5">
        <CalendarClock
          size={16}
          strokeWidth={2}
          className={schedule.enabled ? "shrink-0 text-emerald-600" : "shrink-0 text-ink-subtle"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium leading-tight text-ink">
              {schedule.name}
            </span>
            <span className="shrink-0 text-[12px] leading-tight text-ink-subtle">
              {schedule.enabled ? formatScheduleNextRun(schedule.nextRunAt) : "Paused"}
            </span>
          </div>
          <p className="truncate text-[12.5px] leading-4 text-ink-subtle">
            {schedule.sourceDescription || `${schedule.cron} - ${schedule.timezone}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/routine:opacity-100 group-focus-within/routine:opacity-100">
          <button
            type="button"
            aria-label={`Run ${schedule.name} now`}
            title="Run now"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await runGoatTaskScheduleNowAction(schedule.id);
                if (result.ok) {
                  router.push(`/tasks/${encodeURIComponent(result.task.displayId)}`);
                } else {
                  toast.error(result.error);
                }
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            <Play size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={`Edit ${schedule.name}`}
            title="Edit"
            disabled={isPending}
            onClick={() => {
              if (isEditing) {
                setIsEditing(false);
              } else {
                openEdit();
              }
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            <Settings size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
            title={schedule.enabled ? "Pause" : "Resume"}
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await setGoatTaskScheduleEnabledAction(
                  schedule.id,
                  !schedule.enabled,
                );
                if (!result.ok) toast.error(result.error);
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            {schedule.enabled ? (
              <Pause size={13} strokeWidth={2} />
            ) : (
              <Play size={13} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            aria-label={`Delete ${schedule.name}`}
            title="Delete"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await deleteGoatTaskScheduleAction(schedule.id);
                if (!result.ok) toast.error(result.error);
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger-bg disabled:opacity-60"
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {isEditing ? (
        <form className="flex flex-col gap-2 px-2 pb-2" onSubmit={saveEdit}>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="Name"
              disabled={isPending}
              className="min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
              required
            />
            <input
              value={editCron}
              onChange={(event) => setEditCron(event.target.value)}
              placeholder="0 9 * * 1"
              disabled={isPending}
              className="min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
              required
            />
          </div>
          <input
            value={editTimezone}
            onChange={(event) => setEditTimezone(event.target.value)}
            placeholder="Europe/Berlin"
            disabled={isPending}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
            required
          />
          <textarea
            value={editPrompt}
            onChange={(event) => setEditPrompt(event.target.value)}
            disabled={isPending}
            className="min-h-20 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
            required
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => setIsEditing(false)}
              className="rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function taskScheduleRowToView(row: GoatTaskScheduleRow): GoatTaskScheduleView {
  return {
    id: row.id,
    name: row.name,
    sourceDescription: row.source_description,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatScheduleNextRun(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Next run unknown";
  const minutes = Math.max(1, Math.ceil((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `Next in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `Next in ${hours}h`;
  const days = Math.round(minutes / 1440);
  return `Next in ${days}d`;
}

function LiveResultsList({
  tasks,
  optimisticallyArchivedIds,
  onArchive,
}: {
  tasks: readonly GoatTaskView[];
  optimisticallyArchivedIds: ReadonlySet<string>;
  onArchive: (task: GoatTaskView) => void;
}) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <ResultRows
        tasks={tasks}
        optimisticallyArchivedIds={optimisticallyArchivedIds}
        onArchive={onArchive}
      />
    );
  }
  return (
    <LiveResultsSubscriber
      initialTasks={tasks}
      optimisticallyArchivedIds={optimisticallyArchivedIds}
      onArchive={onArchive}
    />
  );
}

function LiveResultsSubscriber({
  initialTasks,
  optimisticallyArchivedIds,
  onArchive,
}: {
  initialTasks: readonly GoatTaskView[];
  optimisticallyArchivedIds: ReadonlySet<string>;
  onArchive: (task: GoatTaskView) => void;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ task: collections.tasks }));
  const liveTasks = useMemo(() => (rows ?? []).map(taskRowToView), [rows]);
  const tasks = isLoading && initialTasks.length > 0 ? initialTasks : liveTasks;

  return (
    <ResultRows
      tasks={tasks}
      optimisticallyArchivedIds={optimisticallyArchivedIds}
      onArchive={onArchive}
    />
  );
}

function ResultRows({
  tasks,
  optimisticallyArchivedIds,
  onArchive,
}: {
  tasks: readonly GoatTaskView[];
  optimisticallyArchivedIds: ReadonlySet<string>;
  onArchive: (task: GoatTaskView) => void;
}) {
  const sortedTasks = tasks
    .filter((task) => !optimisticallyArchivedIds.has(task.id) && !task.archivedAt)
    .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (sortedTasks.length === 0) {
    return <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">No results yet.</p>;
  }

  return sortedTasks.map((task) => <ResultRow key={task.id} task={task} onArchive={onArchive} />);
}

function taskRowToView(row: GoatTaskRow): GoatTaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatMessageRowToUiMessage(row: GoatChatMessageRow): GoatChatUiMessage {
  return toGoatChatUiMessage({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    taskId: row.task_id,
    debugTrace: row.debug_trace as GoatStoredChatMessage["debugTrace"],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  });
}

function ResultRow({
  task,
  onArchive,
}: {
  task: GoatTaskView;
  onArchive: (task: GoatTaskView) => void;
}) {
  const meta = getTaskMeta(task);
  const Icon = meta.icon;
  const title = task.name;
  const canArchive =
    task.status === "succeeded" || task.status === "failed" || task.status === "canceled";
  return (
    <div className="group/result relative flex items-center rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <Link
        href={`/tasks/${encodeURIComponent(task.displayId)}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Icon
          size={16}
          strokeWidth={2}
          className={`${meta.className} shrink-0 ${meta.spin ? "animate-[spin_3s_linear_infinite]" : ""}`}
        />

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[14px] font-medium leading-tight text-ink">{title}</span>
          <span className="hidden truncate text-[12.5px] leading-tight text-ink-subtle sm:inline">
            {task.displayId} · {meta.detail}
          </span>
        </div>

        <span
          className={`shrink-0 text-[12px] text-ink-subtle transition-opacity duration-150 ${
            canArchive ? "group-hover/result:opacity-0 group-focus-within/result:opacity-0" : ""
          }`}
        >
          {formatRelativeTime(task.createdAt)}
        </span>
      </Link>
      {canArchive ? (
        <button
          type="button"
          aria-label={`Archive ${title}`}
          title="Archive"
          onClick={() => onArchive(task)}
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md bg-surface-hover text-ink-subtle opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-surface-muted hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/result:opacity-100 group-focus-within/result:opacity-100"
        >
          <Archive size={14} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

function Bubble({
  message,
  taskLookup,
  stopped = false,
}: {
  message: GoatChatUiMessage;
  taskLookup: ChatTaskLookup;
  stopped?: boolean;
}) {
  const isUser = message.role === "user";
  const text = textFromGoatChatUiMessage(message);
  const error = message.metadata?.error;

  if (!isUser) {
    const items = getOrderedAssistantItems(
      message,
      taskLookup,
      stopped || message.metadata?.aborted === true,
    );

    return (
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          if (item.type === "text") {
            return (
              <AssistantTextBubble key={item.key} text={item.text} {...(error ? { error } : {})} />
            );
          }
          if (item.type === "task") return <TaskCard key={item.key} task={item.task} />;
          return <ToolCallRow key={item.key} tool={item.tool} />;
        })}
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 ${
          isUser
            ? "rounded-br-md bg-ink text-canvas"
            : error
              ? "rounded-bl-md bg-danger-bg text-danger"
              : "rounded-bl-md bg-surface-muted text-ink"
        }`}
      >
        {isUser ? text : <Markdown content={text} />}
      </div>
    </div>
  );
}

function AssistantTextBubble({ text, error }: { text: string; error?: string | undefined }) {
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[80%] text-[13px] leading-5 ${
          error ? "rounded-2xl rounded-bl-md bg-danger-bg px-3 py-2 text-danger" : "text-ink"
        }`}
      >
        <Markdown content={text} />
      </div>
    </div>
  );
}

function TaskCard({ task }: { task: ChatTaskCardView }) {
  const meta = getChatTaskCardMeta(task.status);
  const Icon = meta.icon;
  const linkId = task.displayId ?? task.id;
  const displayLabel = task.displayId ?? "Task";
  const title = task.title ?? "Task";
  return (
    <Link
      href={`/tasks/${encodeURIComponent(linkId)}`}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <Icon
        size={16}
        strokeWidth={2}
        className={`${meta.className} shrink-0 ${meta.spin ? "animate-[spin_3s_linear_infinite]" : ""}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium leading-tight text-ink">{title}</span>
        <span className="text-[12px] leading-tight text-ink-subtle">
          {displayLabel} · {meta.label}
        </span>
      </div>
      <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-ink-muted">
        {displayLabel}
      </span>
    </Link>
  );
}

function ToolCallRow({ tool }: { tool: ToolCallView }) {
  if (tool.name === GOAT_BRAIN_TOOL_NAME) {
    return <BrainToolCallRow tool={tool} />;
  }

  const meta = getToolCallMeta(tool);
  const Icon = meta.icon;
  return (
    <div
      data-testid={`chat-tool-call-${tool.name}`}
      className="flex max-w-[80%] items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
    >
      <Icon
        size={14}
        strokeWidth={2}
        className={`shrink-0 ${meta.className} ${meta.spin ? "animate-[spin_3s_linear_infinite]" : ""}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium leading-4 text-ink">{tool.label}</span>
          <span className={`${meta.className} shrink-0 text-[11px] leading-4`}>
            {tool.statusText}
          </span>
        </div>
        {tool.detail ? <p className="truncate leading-4 text-ink-subtle">{tool.detail}</p> : null}
      </div>
    </div>
  );
}

function BrainToolCallRow({ tool }: { tool: ToolCallView }) {
  const [expanded, setExpanded] = useState(false);
  const detail = tool.detail ?? "goat_brain";
  const commandPreview = brainOutputCommand(tool.output);
  const stdoutPreview = brainOutputStdout(tool.output);
  const parsedPreview = brainOutputParsed(tool.output);
  const stderrPreview = brainOutputStderr(tool.output);
  const errorPreview = brainOutputError(tool.output, tool.errorText);
  return (
    <div
      data-testid={`chat-tool-call-${tool.name}`}
      className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
            <BookOpen size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 font-medium text-ink/65">Brain</span>
          <span
            title={detail}
            className="inline-flex min-w-0 max-w-[min(440px,calc(100vw-180px))] items-center rounded bg-ink/5 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink/55"
          >
            <span className="min-w-0 truncate">{detail}</span>
          </span>
          <BrainStatusText status={tool.status} />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          <BrainPreviewBlock label="Input" value={formatDebugValue(tool.input)} />
          {commandPreview ? <BrainPreviewBlock label="Command" value={commandPreview} /> : null}
          {stdoutPreview ? <BrainPreviewBlock label="Stdout" value={stdoutPreview} /> : null}
          {parsedPreview ? <BrainPreviewBlock label="Parsed" value={parsedPreview} /> : null}
          {stderrPreview ? <BrainPreviewBlock label="Stderr" value={stderrPreview} /> : null}
          {errorPreview ? <BrainPreviewBlock label="Error" value={errorPreview} /> : null}
          {!isGoatBrainToolOutput(tool.output) && !tool.errorText ? (
            <div className="py-1 text-[11px] text-ink-subtle">Waiting for result</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BrainStatusText({ status }: { status: ToolCallView["status"] }) {
  if (status === "completed") return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
        status === "failed" ? "text-danger" : "text-ink-subtle"
      }`}
    >
      {status === "failed" ? (
        <AlertCircle size={9} strokeWidth={1.9} />
      ) : (
        <CircleDotDashed
          size={9}
          strokeWidth={2}
          className="animate-[spin_3s_linear_infinite] text-warning"
        />
      )}
      {status}
    </span>
  );
}

function BrainPreviewBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1 first:pt-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-ink-subtle">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
        {value}
      </pre>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        aria-live="polite"
        aria-label="Goat is thinking"
        className="rounded-2xl rounded-bl-md bg-surface-muted px-3 py-2"
      >
        <span className="inline-block animate-[goat-thinking-shimmer_1.45s_ease-in-out_infinite] bg-[linear-gradient(100deg,var(--color-ink-subtle)_0%,var(--color-ink)_45%,var(--color-ink-subtle)_90%)] bg-[length:220%_100%] bg-clip-text text-[13px] font-medium leading-5 text-transparent">
          Thinking
        </span>
      </div>
    </div>
  );
}

function shouldShowThinkingBubble(messages: readonly GoatChatUiMessage[]) {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role === "user") return true;
  return getOrderedAssistantItems(lastMessage, new Map<string, ChatTaskCardView>()).length === 0;
}

function SubmitButton({
  disabled,
  isGenerating,
  onStop,
}: {
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
}) {
  if (isGenerating) {
    return (
      <button
        type="button"
        aria-label="Stop response"
        title="Stop response"
        onClick={onStop}
        className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-canvas transition-opacity duration-150 hover:opacity-90 focus:outline-none"
      >
        <Square size={12} strokeWidth={2.2} fill="currentColor" />
      </button>
    );
  }

  return (
    <button
      type="submit"
      aria-label="Send message"
      disabled={disabled}
      className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-canvas transition-opacity duration-150 hover:opacity-90 focus:outline-none disabled:opacity-30"
    >
      <ArrowUp size={15} strokeWidth={2.2} />
    </button>
  );
}

type AssistantRenderItem =
  | { type: "text"; key: string; text: string }
  | { type: "task"; key: string; task: ChatTaskCardView }
  | { type: "tool"; key: string; tool: ToolCallView };

type ChatTaskCardView = {
  id: string;
  displayId: string | null;
  title: string | null;
  status: GoatTaskStatus | null;
};

type ChatTaskLookup = ReadonlyMap<string, ChatTaskCardView>;

type ToolCallView = {
  name: string;
  label: string;
  status: "running" | "completed" | "failed" | "waiting" | "stopped";
  statusText: string;
  detail: string | null;
  input: unknown;
  output: unknown;
  errorText: string | null;
};

function getOrderedAssistantItems(
  message: GoatChatUiMessage,
  taskLookup: ChatTaskLookup,
  stopped = false,
) {
  const items: AssistantRenderItem[] = [];
  let textBuffer = "";

  const flushText = (key: string) => {
    const text = textBuffer.trim();
    textBuffer = "";
    if (!text) return;
    items.push({ type: "text", key, text });
  };

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      textBuffer += part.text;
      continue;
    }
    if (!isToolPartRecord(part)) continue;
    const tool = toolCallViewFromPart(part, stopped);
    if (!tool) continue;
    flushText(`text-${index}`);
    if (
      part.type === START_TASK_TOOL_PART_TYPE &&
      part.state === "output-available" &&
      isStartTaskToolOutput(part.output)
    ) {
      items.push({
        type: "task",
        key: `task-${index}`,
        task: resolveChatTaskCard(taskFromOutput(part.output), taskLookup),
      });
      continue;
    }
    items.push({
      type: "tool",
      key: `tool-${index}`,
      tool,
    });
  }

  flushText("text-end");

  const metadataTask = metadataTaskCard(message.metadata);
  if (!items.some((item) => item.type === "task") && metadataTask) {
    items.push({
      type: "task",
      key: "task-metadata",
      task: resolveChatTaskCard(metadataTask, taskLookup),
    });
  }

  return items;
}

function metadataTaskCard(metadata: GoatChatUiMessage["metadata"]): GoatTaskCardMetadata | null {
  if (metadata?.task) return metadata.task;
  if (metadata?.taskId) return { id: metadata.taskId };
  return null;
}

function toolCallViewFromPart(
  part: Record<string, unknown> & { type: string },
  stopped = false,
): ToolCallView | null {
  const name = toolNameFromPart(part);
  if (!name) return null;
  const state = typeof part.state === "string" ? part.state : "";
  const output = part.output;
  const failedGoatBrain =
    name === GOAT_BRAIN_TOOL_NAME && state === "output-available" && isGoatBrainToolOutput(output)
      ? !goatBrainToolOutputSucceeded(output)
      : false;
  const status = failedGoatBrain ? "failed" : toolStatusFromState(state, stopped);
  return {
    name,
    label: toolLabel(name),
    status,
    statusText: toolStatusText(status, state),
    detail: toolDetail(name, part, status),
    input: part.input,
    output: part.output,
    errorText: typeof part.errorText === "string" ? part.errorText : null,
  };
}

function isToolPartRecord(value: unknown): value is Record<string, unknown> & { type: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

function toolNameFromPart(part: Record<string, unknown> & { type: string }) {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  return part.type.slice("tool-".length);
}

function toolStatusFromState(state: string, stopped = false): ToolCallView["status"] {
  if (state === "output-error" || state === "output-denied") return "failed";
  if (state === "output-available") return "completed";
  if (state === "approval-requested" || state === "approval-responded") return "waiting";
  if (stopped) return "stopped";
  return "running";
}

function toolStatusText(status: ToolCallView["status"], state: string) {
  if (state === "output-denied") return "Denied";
  if (state === "approval-requested") return "Waiting";
  if (state === "approval-responded") return "Approved";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "stopped") return "Stopped";
  return "Running";
}

function toolLabel(name: string) {
  if (name === GOAT_BRAIN_TOOL_NAME) return "Brain";
  if (name === START_TASK_TOOL_NAME) return "Task";
  if (name === SCHEDULE_TASK_TOOL_NAME) return "Recurring task";
  if (name === EDIT_TASK_SCHEDULE_TOOL_NAME) return "Edit routine";
  if (name === DELETE_TASK_SCHEDULE_TOOL_NAME) return "Delete routine";
  if (name === WEB_SEARCH_TOOL_NAME) return "Web Search";
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toolDetail(
  name: string,
  part: Record<string, unknown> & { type: string },
  status: ToolCallView["status"],
) {
  if (part.state === "output-error" && typeof part.errorText === "string") {
    return truncateToolPreview(part.errorText);
  }

  if (name === GOAT_BRAIN_TOOL_NAME) {
    return goatBrainToolDetail(part, status);
  }

  if (name === START_TASK_TOOL_NAME) {
    return startTaskToolDetail(part);
  }

  if (name === SCHEDULE_TASK_TOOL_NAME) {
    return scheduleTaskToolDetail(part);
  }
  if (name === EDIT_TASK_SCHEDULE_TOOL_NAME || name === DELETE_TASK_SCHEDULE_TOOL_NAME) {
    return taskScheduleMutationToolDetail(part);
  }

  return formatToolInput(part.input);
}

function goatBrainToolDetail(
  part: Record<string, unknown> & { type: string },
  status: ToolCallView["status"],
) {
  if (part.state === "output-available" && isGoatBrainToolOutput(part.output)) {
    if (!goatBrainToolOutputSucceeded(part.output)) {
      return truncateToolPreview(
        firstNonEmptyLine(part.output.error, part.output.stderr, part.output.stdout) ??
          formatToolInput(part.input),
      );
    }
    return truncateToolPreview(
      firstNonEmptyLine(
        goatBrainCliSuccessSummary(part.output.stdout),
        part.output.stdout,
        part.output.stderr,
      ) ?? formatToolInput(part.input),
    );
  }

  const inputPreview = formatToolInput(part.input);
  if (inputPreview) return inputPreview;
  return status === "running" ? "Running goat_brain" : null;
}

function startTaskToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.input)) {
    const name = typeof part.input.name === "string" ? part.input.name : null;
    const prompt = typeof part.input.prompt === "string" ? part.input.prompt : null;
    return truncateToolPreview(name ?? prompt);
  }
  return formatToolInput(part.input);
}

function scheduleTaskToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.output)) {
    const name = typeof part.output.scheduleName === "string" ? part.output.scheduleName : null;
    const cron = typeof part.output.cron === "string" ? part.output.cron : null;
    const timezone = typeof part.output.timezone === "string" ? part.output.timezone : null;
    return truncateToolPreview([name, cron, timezone].filter(Boolean).join(" - "));
  }
  if (isRecord(part.input)) {
    const source =
      typeof part.input.sourceDescription === "string" ? part.input.sourceDescription : null;
    const cron = typeof part.input.cron === "string" ? part.input.cron : null;
    return truncateToolPreview([source, cron].filter(Boolean).join(" - "));
  }
  return formatToolInput(part.input);
}

function taskScheduleMutationToolDetail(part: Record<string, unknown>) {
  if (isRecord(part.output)) {
    const ok = part.output.ok === true;
    const name =
      typeof part.output.scheduleName === "string"
        ? part.output.scheduleName
        : typeof part.output.error === "string"
          ? part.output.error
          : null;
    return truncateToolPreview([ok ? "Done" : "Issue", name].filter(Boolean).join(" - "));
  }
  if (isRecord(part.input)) {
    const scheduleName =
      typeof part.input.scheduleName === "string"
        ? part.input.scheduleName
        : typeof part.input.scheduleId === "string"
          ? part.input.scheduleId
          : null;
    return truncateToolPreview(scheduleName ?? formatToolInput(part.input));
  }
  return formatToolInput(part.input);
}

function formatToolInput(value: unknown) {
  if (typeof value === "string") return truncateToolPreview(value);
  if (!isRecord(value)) return null;
  if (typeof value.args === "string") return truncateToolPreview(`goat_brain ${value.args}`);
  if (typeof value.command === "string") {
    return truncateToolPreview(`goat_brain ${formatGoatBrainCommandInput(value)}`);
  }
  if (typeof value.action === "string") {
    const detail =
      typeof value.text === "string"
        ? value.text
        : typeof value.id === "string"
          ? value.id
          : undefined;
    return truncateToolPreview(detail ? `${value.action}: ${detail}` : value.action);
  }
  if (typeof value.query === "string") return truncateToolPreview(`query: ${value.query}`);
  if (typeof value.prompt === "string") return truncateToolPreview(value.prompt);
  try {
    return truncateToolPreview(JSON.stringify(value));
  } catch {
    return null;
  }
}

function formatGoatBrainCommandInput(input: Record<string, unknown>) {
  const command = input.command;
  const flags = isRecord(input.flags) ? input.flags : {};
  const parts = [String(command)];
  for (const [rawName, value] of Object.entries(flags)) {
    const name = rawName
      .replace(/_/g, "-")
      .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
      .replace(/^-+/, "")
      .replace(/-+/g, "-");
    if (typeof value === "boolean") {
      if (value) parts.push(`--${name}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(`--${name}`, formatToolArg(item));
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`--${name}`, formatToolArg(String(value)));
    }
  }
  return parts.join(" ");
}

function formatToolArg(value: string) {
  if (/^[a-zA-Z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function formatDebugValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function brainOutputCommand(value: unknown) {
  if (!isGoatBrainToolOutput(value)) return null;
  const lines: string[] = [];
  if (value.command) lines.push(`goat_brain ${value.command}`);
  if (Array.isArray(value.argv)) lines.push(`argv: ${JSON.stringify(value.argv)}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

function brainOutputStdout(value: unknown) {
  return isGoatBrainToolOutput(value) && value.stdout.trim() ? value.stdout : null;
}

function brainOutputStderr(value: unknown) {
  return isGoatBrainToolOutput(value) && value.stderr.trim() ? value.stderr : null;
}

function brainOutputParsed(value: unknown) {
  return isGoatBrainToolOutput(value) && value.parsed !== undefined
    ? formatDebugValue(value.parsed)
    : null;
}

function brainOutputError(value: unknown, errorText: string | null) {
  if (errorText?.trim()) return errorText;
  return isGoatBrainToolOutput(value) && value.error?.trim() ? value.error : null;
}

function isGoatBrainToolOutput(value: unknown): value is GoatBrainToolOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    (typeof value.stdout === "string" || value.stdout === undefined) &&
    (typeof value.stderr === "string" || value.stderr === undefined) &&
    (typeof value.error === "string" || value.error === undefined)
  );
}

function goatBrainToolOutputSucceeded(output: GoatBrainToolOutput) {
  if (output.ok) return true;
  return parseGoatBrainCliJson(output.stdout)?.ok === true;
}

function goatBrainCliSuccessSummary(stdout: string | undefined) {
  const parsed = parseGoatBrainCliJson(stdout);
  if (!parsed || parsed.ok !== true) return null;
  const appliedCount = Array.isArray(parsed.applied) ? parsed.applied.length : null;
  if (typeof appliedCount === "number" && appliedCount > 0) {
    return `Ingested ${appliedCount} brain change${appliedCount === 1 ? "" : "s"}.`;
  }
  const planCount = Array.isArray(parsed.plan) ? parsed.plan.length : null;
  if (parsed.dryRun === true && typeof planCount === "number") {
    return `Dry run planned ${planCount} brain change${planCount === 1 ? "" : "s"}.`;
  }
  return null;
}

function parseGoatBrainCliJson(stdout: string | undefined): Record<string, unknown> | null {
  if (!stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstNonEmptyLine(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const line = value?.trim().split(/\r?\n/, 1)[0]?.trim();
    if (line) return line;
  }
  return null;
}

function truncateToolPreview(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
}

function getToolCallMeta(tool: ToolCallView): {
  icon: typeof FileText;
  className: string;
  spin: boolean;
} {
  if (tool.status === "failed") {
    return { icon: AlertCircle, className: "text-danger", spin: false };
  }
  if (tool.status === "completed") {
    return { icon: CheckCircle2, className: "text-emerald-600", spin: false };
  }
  if (tool.status === "waiting") {
    return { icon: Clock, className: "text-ink-subtle", spin: false };
  }
  if (tool.status === "stopped") {
    return { icon: Square, className: "text-ink-subtle", spin: false };
  }
  return {
    icon:
      tool.name === GOAT_BRAIN_TOOL_NAME
        ? BookOpen
        : tool.name === SCHEDULE_TASK_TOOL_NAME ||
            tool.name === EDIT_TASK_SCHEDULE_TOOL_NAME ||
            tool.name === DELETE_TASK_SCHEDULE_TOOL_NAME
          ? CalendarClock
          : CircleDotDashed,
    className: "text-amber-500",
    spin:
      tool.name !== GOAT_BRAIN_TOOL_NAME &&
      tool.name !== SCHEDULE_TASK_TOOL_NAME &&
      tool.name !== EDIT_TASK_SCHEDULE_TOOL_NAME &&
      tool.name !== DELETE_TASK_SCHEDULE_TOOL_NAME,
  };
}

function buildChatTaskLookup(input: {
  messages: readonly GoatChatUiMessage[];
  tasks: readonly GoatTaskView[];
  liveTasks: readonly GoatTaskView[] | null;
}): ChatTaskLookup {
  const lookup = new Map<string, ChatTaskCardView>();

  for (const message of input.messages) {
    const task = metadataTaskCard(message.metadata);
    if (task) setChatTaskLookupValue(lookup, task);
  }

  for (const task of input.tasks) {
    setChatTaskLookupValue(lookup, taskCardFromTask(task));
  }

  for (const task of input.liveTasks ?? []) {
    setChatTaskLookupValue(lookup, taskCardFromTask(task));
  }

  return lookup;
}

function setChatTaskLookupValue(lookup: Map<string, ChatTaskCardView>, task: GoatTaskCardMetadata) {
  const existing = lookup.get(task.id);
  lookup.set(task.id, {
    id: task.id,
    displayId: task.displayId ?? existing?.displayId ?? null,
    title: task.title ?? existing?.title ?? null,
    status: task.status ?? existing?.status ?? null,
  });
}

function taskCardFromTask(task: GoatTaskView): ChatTaskCardView {
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.name,
    status: task.status,
  };
}

function resolveChatTaskCard(
  fallback: GoatTaskCardMetadata,
  lookup: ChatTaskLookup,
): ChatTaskCardView {
  const resolved = lookup.get(fallback.id);
  return {
    id: fallback.id,
    displayId: resolved?.displayId ?? fallback.displayId ?? null,
    title: resolved?.title ?? fallback.title ?? null,
    status: resolved?.status ?? fallback.status ?? null,
  };
}

function taskFromOutput(output: StartTaskToolOutput): GoatTaskCardMetadata {
  return {
    id: output.taskId,
    displayId: output.taskDisplayId,
    title: output.taskName,
    status: output.status === "queued" ? "queued" : null,
  };
}

function isStartTaskToolOutput(value: unknown): value is StartTaskToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.taskId === "string" &&
    typeof output.taskDisplayId === "string" &&
    typeof output.taskName === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function runBackgroundChatTurn(input: { prompt: string; model: string }) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: null,
      model: input.model,
      message: {
        id: newBackgroundChatMessageId(),
        role: "user",
        parts: [{ type: "text", text: input.prompt }],
      },
    }),
  });

  if (!response.ok) {
    const details = (await response.text().catch(() => "")).trim();
    throw new Error(details || "Could not start that chat.");
  }

  await consumeResponseBody(response);
}

async function consumeResponseBody(response: Response) {
  if (!response.body) return;

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function newBackgroundChatMessageId() {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `ui_background_${randomId}`;
}

function getTaskMeta(task: GoatTaskView): {
  icon: typeof FileText;
  className: string;
  detail: string;
  spin: boolean;
} {
  const recurringPrefix = task.scheduleId ? "Recurring - " : "";
  if (task.status === "failed") {
    return {
      icon: AlertCircle,
      className: "text-danger",
      detail: `${recurringPrefix}${task.error ?? GOAT_STATUS_COPY.failed}`,
      spin: false,
    };
  }
  if (task.status === "canceled") {
    return {
      icon: X,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${task.error ?? GOAT_STATUS_COPY.canceled}`,
      spin: false,
    };
  }
  if (task.status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      detail: `${recurringPrefix}${firstLine(task.result) ?? GOAT_STATUS_COPY.succeeded}`,
      spin: false,
    };
  }
  if (task.status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${GOAT_STAGE_COPY[task.stage]}`,
      spin: false,
    };
  }
  return {
    icon: CircleDotDashed,
    className: "text-amber-500",
    detail: `${recurringPrefix}${GOAT_STAGE_COPY[task.stage]}`,
    spin: true,
  };
}

function getChatTaskCardMeta(status: GoatTaskStatus | null): {
  icon: typeof FileText;
  className: string;
  label: string;
  spin: boolean;
} {
  if (status === "failed") {
    return {
      icon: AlertCircle,
      className: "text-danger",
      label: GOAT_STATUS_COPY.failed,
      spin: false,
    };
  }
  if (status === "canceled") {
    return {
      icon: X,
      className: "text-ink-subtle",
      label: GOAT_STATUS_COPY.canceled,
      spin: false,
    };
  }
  if (status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      label: GOAT_STATUS_COPY.succeeded,
      spin: false,
    };
  }
  if (status === "running") {
    return {
      icon: CircleDotDashed,
      className: "text-amber-500",
      label: GOAT_STATUS_COPY.running,
      spin: true,
    };
  }
  if (status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      label: GOAT_STATUS_COPY.queued,
      spin: false,
    };
  }
  return {
    icon: Clock,
    className: "text-ink-subtle",
    label: "Status pending",
    spin: false,
  };
}

function firstLine(value: string | null) {
  const line = value?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  return line.length > 72 ? `${line.slice(0, 72).trimEnd()}...` : line;
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "just now";

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
