"use client";

import { useChat } from "@ai-sdk/react";
import type { AgentModelId } from "@opencompany/agent-runtime";
import type { GoatChatEngine, GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@opencompany/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { AnthropicIcon, MoonshotIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import { DefaultChatTransport } from "ai";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDotDashed,
  Clock,
  Code2,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Play,
  Settings,
  Sparkles,
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
import { buildChatTaskLookup, shouldShowThinkingBubble } from "@/components/chat/assistant-items";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { useHydrated } from "@/components/useHydrated";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import {
  type GoatChatMention,
  type GoatChatMessageMetadata,
  type GoatChatSessionView,
  type GoatChatSummaryView,
  type GoatChatUiMessage,
  type GoatStoredChatMessage,
  textFromGoatChatUiMessage,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";
import { CODEX_PICKER_VALUE, type CodexPickerValue } from "@/lib/codex-chat-constants";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isRecentGoatHomeActivity } from "@/lib/home-activity";
import { LOCAL_CODEX_PICKER_VALUE, type LocalCodexPickerValue } from "@/lib/local-codex-constants";
import { DEFAULT_GOAT_MODEL, GOAT_MODELS, normalizeGoatModel } from "@/lib/model-options";
import {
  createGoatCollections,
  type GoatChatMessageRow,
  type GoatCodexChatSessionRow,
  type GoatLocalCodexSessionRow,
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
const CODEX_MENTION: GoatChatMention = { kind: "engine", id: "codex" };

type ActiveMentionToken = {
  start: number;
  end: number;
  query: string;
};

type GoatChatModelSelection = AgentModelId | LocalCodexPickerValue | CodexPickerValue;

// Engine chats (Local Codex bridge, cloud Codex sandbox) bypass useChat entirely: sends go to an
// engine endpoint, streaming arrives as Electric row updates, and stop is an interrupt call.
type GoatEngineChatKind = "local_codex" | "codex";

const ENGINE_CHAT_CONFIG: Record<
  GoatEngineChatKind,
  { label: string; messagesEndpoint: string; interruptEndpoint: (chatSessionId: string) => string }
> = {
  local_codex: {
    label: "Local Codex",
    messagesEndpoint: "/api/local-codex/messages",
    interruptEndpoint: (chatSessionId) =>
      `/api/local-codex/sessions/${encodeURIComponent(chatSessionId)}/interrupt`,
  },
  codex: {
    label: "Codex",
    messagesEndpoint: "/api/codex-chat/messages",
    interruptEndpoint: (chatSessionId) =>
      `/api/codex-chat/sessions/${encodeURIComponent(chatSessionId)}/interrupt`,
  },
};

function engineChatKindFromChat(
  chat: { engine?: GoatChatEngine } | null | undefined,
  localCodexBetaEnabled: boolean,
): GoatEngineChatKind | null {
  if (!chat) return null;
  if (chat.engine === "codex") return "codex";
  if (chat.engine === "local_codex" && localCodexBetaEnabled) return "local_codex";
  return null;
}

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
  codexConnected = false,
  localCodexBetaEnabled = false,
  chatResumeEnabled = false,
}: {
  tasks: readonly GoatTaskView[];
  schedules?: readonly GoatTaskScheduleView[];
  defaultModel: string;
  initialChat: GoatChatSessionView | null;
  recentChats?: readonly GoatChatSummaryView[];
  codexConnected?: boolean;
  localCodexBetaEnabled?: boolean;
  chatResumeEnabled?: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | null>(null);
  const isPinnedAtBottomRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const pendingInputCaretRef = useRef<number | null>(null);
  const [input, setInput] = useState("");
  const [mentionToken, setMentionToken] = useState<ActiveMentionToken | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<GoatChatMention[]>([]);
  const [mode, setMode] = useState<"home" | "chat">(() => (initialChat ? "chat" : "home"));
  const [chatSessionId, setChatSessionId] = useState<string | null>(initialChat?.id ?? null);
  // Keyed useChat instance: changes only when the user opens a different chat,
  // NOT when a new session gets its server id mid-turn (that would discard the
  // in-flight stream state).
  const [chatInstanceKey, setChatInstanceKey] = useState(() => initialChat?.id ?? "goat-chat-main");
  // Persisted messages for the active session, synced live from Electric.
  const [liveChat, setLiveChat] = useState<{
    sessionId: string;
    messages: GoatChatUiMessage[];
  } | null>(null);
  const [chatModel, setChatModel] = useState<GoatChatModelSelection>(() => {
    const engine = engineChatKindFromChat(initialChat, localCodexBetaEnabled);
    if (engine === "codex") return CODEX_PICKER_VALUE;
    if (engine === "local_codex") return LOCAL_CODEX_PICKER_VALUE;
    return normalizeGoatModel(initialChat?.model ?? defaultModel);
  });
  const [engineChatSession, setEngineChatSession] = useState<{
    engine: GoatEngineChatKind;
    chatSessionId: string;
  } | null>(() => {
    const engine = engineChatKindFromChat(initialChat, localCodexBetaEnabled);
    return engine && initialChat ? { engine, chatSessionId: initialChat.id } : null;
  });
  const [engineRunning, setEngineRunning] = useState(false);
  const [engineSubmitting, setEngineSubmitting] = useState(false);
  const [newChatCommandOpen, setNewChatCommandOpen] = useState(false);
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [backgroundChatCount, setBackgroundChatCount] = useState(0);
  const activeSelectedMentions = codexConnected ? selectedMentions : [];
  const shouldHighlightCodexMention =
    activeSelectedMentions.length > 0 && hasCodexMentionToken(input);
  const [locallyStoppedAssistantMessageIds, setLocallyStoppedAssistantMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [optimisticallyArchivedIds, setOptimisticallyArchivedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [optimisticallyArchivedChatIds, setOptimisticallyArchivedChatIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [liveChatTasks, setLiveChatTasks] = useState<readonly GoatTaskView[] | null>(null);
  const [, startArchiveTransition] = useTransition();

  const prepareSendMessagesRequest = useCallback(
    ({
      body,
      messages,
    }: {
      body: Record<string, unknown> | undefined;
      messages: GoatChatUiMessage[];
    }) => {
      const message = messages.at(-1);
      const mentions = mentionsFromMessageMetadata(message?.metadata);
      const requestSessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      const requestModel = typeof body?.model === "string" ? body.model : undefined;
      return {
        body: {
          sessionId: requestSessionId,
          ...(requestModel ? { model: requestModel } : {}),
          message,
          ...(mentions.length ? { mentions } : {}),
        },
      };
    },
    [],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<GoatChatUiMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest,
      }),
    [prepareSendMessagesRequest],
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
    id: chatInstanceKey,
    // useChat holds only this surface's in-flight overlay; persisted history
    // comes from the Electric-synced liveChat state and is merged below.
    resume:
      chatResumeEnabled &&
      Boolean(initialChat) &&
      (initialChat?.engine ?? "opencompany") === "opencompany",
    // Batch stream chunks into ~20fps UI updates instead of rendering the
    // whole thread on every token.
    experimental_throttle: 50,
    transport,
    onFinish: ({ message }) => {
      const sessionId = message.metadata?.sessionId;
      if (sessionId) {
        setChatSessionId(sessionId);
        router.replace(chatHref(sessionId));
      }
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message || "Goat could not answer that right now.");
    },
  });
  const isGenerating = status === "submitted" || status === "streaming";
  const activeInitialChatEngine =
    initialChat && mode === "chat" && chatSessionId === initialChat.id
      ? engineChatKindFromChat(initialChat, localCodexBetaEnabled)
      : null;
  const activeEngineChat = chatSessionId
    ? activeInitialChatEngine
      ? { engine: activeInitialChatEngine, chatSessionId }
      : engineChatSession?.chatSessionId === chatSessionId
        ? engineChatSession
        : null
    : null;
  const isLocalCodexMode = localCodexBetaEnabled && chatModel === LOCAL_CODEX_PICKER_VALUE;
  const isCodexMode = chatModel === CODEX_PICKER_VALUE;
  const selectedEngine: GoatEngineChatKind | null = isLocalCodexMode
    ? "local_codex"
    : isCodexMode
      ? "codex"
      : null;
  const activeEngine = activeEngineChat?.engine ?? selectedEngine;
  const isEngineChat = activeEngine !== null;
  const localCodexFeatureDisabledForChat = Boolean(
    initialChat &&
      !localCodexBetaEnabled &&
      mode === "chat" &&
      chatSessionId === initialChat.id &&
      initialChat.engine === "local_codex",
  );
  // Render list: Electric-synced rows are the source of truth for persisted
  // messages; the useChat overlay contributes only entries Electric has not
  // delivered yet (the in-flight turn and optimistic sends).
  const persistedMessages = useMemo(() => {
    if (!chatSessionId) return [];
    if (liveChat && liveChat.sessionId === chatSessionId) return liveChat.messages;
    if (initialChat && initialChat.id === chatSessionId) return initialChat.messages;
    return [];
  }, [chatSessionId, initialChat, liveChat]);
  const chatMessages = useMemo(() => {
    if (persistedMessages.length === 0) return messages;
    const persistedIds = new Set(persistedMessages.map((message) => message.id));
    const overlay = messages.filter((message) => !persistedIds.has(message.id));
    return overlay.length > 0 ? [...persistedMessages, ...overlay] : persistedMessages;
  }, [messages, persistedMessages]);
  const hasMessages = chatMessages.length > 0;
  const showThinkingBubble =
    (isGenerating || (isEngineChat && engineRunning)) && shouldShowThinkingBubble(chatMessages);
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
        messages: chatMessages,
        tasks,
        liveTasks: liveChatTasks,
      }),
    [chatMessages, liveChatTasks, tasks],
  );
  const activeChatSummary = chatSessionId
    ? (recentChats.find((chat) => chat.id === chatSessionId) ?? null)
    : null;
  const activeChatTitle =
    activeChatSummary?.title ??
    (initialChat?.id === chatSessionId ? initialChat.title : null) ??
    titleFromChatMessages(chatMessages) ??
    "Chat";
  const activeChatModel =
    activeChatSummary?.model ??
    (initialChat?.id === chatSessionId ? initialChat.model : null) ??
    (isEngineChat ? DEFAULT_GOAT_MODEL : chatModel);
  const activeChatEngine =
    activeChatSummary?.engine ??
    (initialChat?.id === chatSessionId ? initialChat.engine : null) ??
    activeEngine ??
    "opencompany";

  const openChat = useCallback(
    (chat: { id: string; model: string; engine?: GoatChatEngine } | null) => {
      const engineTarget = engineChatKindFromChat(chat, localCodexBetaEnabled);
      setChatSessionId(chat?.id ?? null);
      setChatInstanceKey(chat?.id ?? "goat-chat-main");
      setChatModel(
        engineTarget === "local_codex"
          ? LOCAL_CODEX_PICKER_VALUE
          : engineTarget === "codex"
            ? CODEX_PICKER_VALUE
            : normalizeGoatModel(chat?.model ?? defaultModel),
      );
      setEngineChatSession(
        chat && engineTarget ? { engine: engineTarget, chatSessionId: chat.id } : null,
      );
      setEngineRunning(false);
      setMessages([]);
      setLocallyStoppedAssistantMessageIds(new Set());
      clearError();
      setMode(chat ? "chat" : "home");
    },
    [clearError, defaultModel, localCodexBetaEnabled, setMessages],
  );

  // Adopt URL-driven chat changes (history links, back/forward). This reacts
  // to prop *transitions* rather than prop/state mismatches, so server props
  // that lag behind local navigation (e.g. a new session adopted from stream
  // metadata before router.refresh lands) never clobber local state.
  const initialChatId = initialChat?.id ?? null;
  const lastInitialChatIdRef = useRef(initialChatId);
  useEffect(() => {
    if (lastInitialChatIdRef.current === initialChatId) return;
    const frame = requestAnimationFrame(() => {
      lastInitialChatIdRef.current = initialChatId;
      if (initialChatId === chatSessionId) return;
      openChat(initialChat ?? null);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatSessionId, initialChat, initialChatId, openChat]);

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
    const caret = pendingInputCaretRef.current;
    if (caret === null) return;
    pendingInputCaretRef.current = null;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(caret, caret);
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
    if (chatMessages.length === 0 && status !== "submitted" && status !== "streaming") return;
    const thread = threadRef.current;
    if (!thread || typeof thread.scrollTo !== "function") return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "auto" });
  }, [chatMessages, mode, status]);

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
      if (key !== "k" || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) {
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

  const archiveChat = (chat: GoatChatSummaryView) => {
    setOptimisticallyArchivedChatIds((current) => new Set(current).add(chat.id));
    startArchiveTransition(async () => {
      const result = await closeGoatChatSessionAction(chat.id);
      if (result.ok) {
        router.refresh();
        return;
      }

      setOptimisticallyArchivedChatIds((current) => {
        const next = new Set(current);
        next.delete(chat.id);
        return next;
      });
      toast.error(result.error ?? "Could not archive chat.");
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
    if (isGenerating || engineSubmitting) return;

    const prompt = input.trim();
    if (!prompt) return;
    if (localCodexFeatureDisabledForChat) {
      toast.error(LOCAL_CODEX_BETA_DISABLED_MESSAGE);
      return;
    }
    const mentions =
      activeSelectedMentions.length > 0 && hasCodexMentionToken(prompt)
        ? activeSelectedMentions
        : [];

    clearError();
    setMode("chat");
    isPinnedAtBottomRef.current = true;
    setLocallyStoppedAssistantMessageIds(new Set());
    setInput("");
    setMentionToken(null);
    setSelectedMentions([]);
    if (activeEngine) {
      const engine = activeEngine;
      const config = ENGINE_CHAT_CONFIG[engine];
      const userMessageId = `goat_chat_msg_${crypto.randomUUID()}`;
      const existingEngineSessionId = activeEngineChat?.chatSessionId ?? null;
      setEngineSubmitting(true);
      void sendEngineChatMessage({
        endpoint: config.messagesEndpoint,
        errorLabel: config.label,
        prompt,
        sessionId: existingEngineSessionId,
        userMessageId,
      })
        .then((result) => {
          setChatSessionId(result.sessionId);
          setEngineChatSession({ engine, chatSessionId: result.sessionId });
          setEngineRunning(true);
          setMessages((current) =>
            appendEngineOptimisticMessages(existingEngineSessionId ? current : [], {
              sessionId: result.sessionId,
              userMessageId: result.userMessageId,
              assistantMessageId: result.assistantMessageId,
              prompt,
            }),
          );
          router.replace(chatHref(result.sessionId));
          router.refresh();
        })
        .catch((error) => {
          setInput(prompt);
          toast.error(
            error instanceof Error ? error.message : `${config.label} could not start that turn.`,
          );
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setEngineSubmitting(false);
        });
      return;
    }

    const message =
      mentions.length > 0 ? { text: prompt, metadata: { mentions } } : { text: prompt };
    const model = chatModel;
    void sendMessage(message, { body: { sessionId: chatSessionId, model } }).catch((error) => {
      setInput(prompt);
      setSelectedMentions(mentions);
      toast.error(error instanceof Error ? error.message : "Goat could not answer that right now.");
    });
  };

  const closeChat = useCallback(() => {
    if (isGenerating) void stop();
    openChat(null);
    router.replace("/");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isGenerating, openChat, router, stop]);

  const stopGeneration = useCallback(() => {
    if (activeEngineChat) {
      const config = ENGINE_CHAT_CONFIG[activeEngineChat.engine];
      setEngineRunning(false);
      void fetch(config.interruptEndpoint(activeEngineChat.chatSessionId), {
        method: "POST",
      }).catch(() => {
        toast.error(`Could not interrupt ${config.label}.`);
      });
      return;
    }

    const lastAssistantMessage = messages.findLast((message) => message.role === "assistant");
    if (lastAssistantMessage) {
      setLocallyStoppedAssistantMessageIds((current) =>
        new Set(current).add(lastAssistantMessage.id),
      );
    }
    // With resumable streams, aborting the connection is only a disconnect;
    // the stop endpoint cancels the server-side generation itself.
    if (chatResumeEnabled) {
      const stopSessionId = chatSessionId ?? lastAssistantMessage?.metadata?.sessionId ?? null;
      if (stopSessionId) {
        void fetch(`/api/chat/${encodeURIComponent(stopSessionId)}/stop`, {
          method: "POST",
        }).catch(() => undefined);
      }
    }
    void stop();
  }, [activeEngineChat, chatResumeEnabled, chatSessionId, messages, stop]);

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
    if (mentionToken) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMentionToken(null);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectCodexMention();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const updateMentionToken = (value: string, selectionStart: number | null) => {
    if (selectionStart === null) {
      setMentionToken(null);
      return;
    }
    setMentionToken(codexConnected ? findActiveMentionToken(value, selectionStart) : null);
  };

  const onInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextInput = event.target.value;
    setInput(nextInput);
    setSelectedMentions((current) =>
      current.length > 0 && !hasCodexMentionToken(nextInput) ? [] : current,
    );
    updateMentionToken(nextInput, event.target.selectionStart);
  };

  const selectCodexMention = () => {
    if (!codexConnected || !mentionToken) return;
    const before = input.slice(0, mentionToken.start);
    const after = input.slice(mentionToken.end);
    const nextInput = `${before}@codex ${after}`;
    const nextCaret = before.length + "@codex ".length;
    pendingInputCaretRef.current = nextCaret;
    setInput(nextInput);
    setSelectedMentions([CODEX_MENTION]);
    setMentionToken(null);
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
        <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-[560px] flex-col gap-8 pb-40 pt-16 sm:pt-24">
            <section className="flex flex-col gap-1">
              <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Chats
              </h2>
              <ChatHistoryList
                chats={recentChats}
                optimisticallyArchivedChatIds={optimisticallyArchivedChatIds}
                onSelect={openChat}
                onArchive={archiveChat}
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
            <div className="mx-auto flex w-full max-w-[720px] items-center justify-start">
              <ChatTitleHeader
                title={activeChatTitle}
                model={activeChatModel}
                engine={activeChatEngine}
              />
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
              {chatMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  taskLookup={chatTaskLookup}
                  stopped={locallyStoppedAssistantMessageIds.has(message.id)}
                />
              ))}
              {showThinkingBubble ? (
                <ThinkingIndicator {...(isEngineChat ? { label: "Codex is working" } : {})} />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {mode === "chat" && chatSessionId ? (
        <LiveChatMessages sessionId={chatSessionId} onChange={setLiveChat} />
      ) : null}
      {mode === "chat" && activeEngineChat?.engine === "local_codex" ? (
        <LiveLocalCodexSessionStatus
          chatSessionId={activeEngineChat.chatSessionId}
          setRunning={setEngineRunning}
        />
      ) : null}
      {mode === "chat" && activeEngineChat?.engine === "codex" ? (
        <LiveCodexChatSessionStatus
          chatSessionId={activeEngineChat.chatSessionId}
          setRunning={setEngineRunning}
        />
      ) : null}
      {mode === "chat" ? <LiveChatTasks setTasks={setLiveChatTasks} /> : null}

      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-canvas via-canvas to-transparent px-6 pb-6 pt-8"
      >
        <div className="pointer-events-auto relative flex w-full max-w-[720px] flex-col gap-2">
          {chatError ? (
            <p
              className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              role="alert"
            >
              {chatError.message || "Goat could not answer that right now."}
            </p>
          ) : null}
          {localCodexFeatureDisabledForChat ? (
            <p
              className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              role="status"
            >
              {LOCAL_CODEX_BETA_DISABLED_MESSAGE}
            </p>
          ) : null}
          {mentionToken ? (
            <div
              role="listbox"
              aria-label="Mention menu"
              className="absolute bottom-full left-3 z-20 mb-2 w-56 rounded-lg border border-border bg-surface p-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
            >
              <button
                type="button"
                role="option"
                aria-selected="true"
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectCodexMention();
                }}
                onClick={selectCodexMention}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover focus:bg-surface-hover focus:outline-none"
              >
                <Code2 size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                <span className="text-[13px] font-medium leading-4 text-ink">@codex</span>
                <span className="ml-auto text-[12px] leading-4 text-ink-subtle">Codex</span>
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-2.5 shadow-[0_8px_24px_rgba(15,15,15,0.08)] transition-colors duration-150 focus-within:border-border-strong">
            <div className="relative min-w-0 flex-1 self-center">
              {input ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 max-h-32 overflow-hidden whitespace-pre-wrap break-words py-[3px] text-[13.5px] leading-5 text-ink"
                >
                  {renderComposerInputOverlay(input, shouldHighlightCodexMention)}
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                rows={1}
                id="prompt"
                name="prompt"
                value={input}
                placeholder={mode === "chat" ? "Reply..." : "Ask a question or describe a task..."}
                onChange={onInputChange}
                onBlur={() => setMentionToken(null)}
                onClick={(event) =>
                  updateMentionToken(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                onKeyDown={onKeyDown}
                onSelect={(event) =>
                  updateMentionToken(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                disabled={isGenerating || localCodexFeatureDisabledForChat}
                className="relative z-10 block max-h-32 w-full resize-none bg-transparent py-[3px] text-[13.5px] leading-5 text-transparent caret-ink outline-none placeholder:text-ink-subtle"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                maxLength={10_000}
                required
              />
            </div>
            <GoatModelPicker
              value={chatModel}
              onChange={setChatModel}
              disabled={isGenerating || Boolean(activeEngineChat)}
              localCodexBetaEnabled={localCodexBetaEnabled}
              codexConnected={codexConnected}
            />
            {isEngineChat && engineRunning ? <EngineStopButton onStop={stopGeneration} /> : null}
            <SubmitButton
              disabled={!input.trim() || engineSubmitting || localCodexFeatureDisabledForChat}
              isGenerating={isGenerating}
              onStop={stopGeneration}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

function mentionsFromMessageMetadata(metadata: GoatChatMessageMetadata | undefined) {
  const mentions = metadata?.mentions ?? [];
  return mentions.filter(isSupportedMention);
}

function chatHref(sessionId: string) {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

function titleFromChatMessages(messages: readonly GoatChatUiMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage ? textFromGoatChatUiMessage(firstUserMessage) : "";
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}...`;
}

type EngineChatMessageResponse = {
  ok: true;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  mode: "started" | "steered" | "queued";
};

async function sendEngineChatMessage(input: {
  endpoint: string;
  errorLabel: string;
  prompt: string;
  sessionId: string | null;
  userMessageId: string;
}): Promise<EngineChatMessageResponse> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      message: {
        id: input.userMessageId,
        role: "user",
        parts: [{ type: "text", text: input.prompt }],
      },
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `${input.errorLabel} could not start that turn.`);
  }
  return response.json() as Promise<EngineChatMessageResponse>;
}

function appendEngineOptimisticMessages(
  current: GoatChatUiMessage[],
  input: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string | null;
    prompt: string;
  },
): GoatChatUiMessage[] {
  const byId = new Set(current.map((message) => message.id));
  const next = [...current];
  if (!byId.has(input.userMessageId)) {
    next.push({
      id: input.userMessageId,
      role: "user",
      metadata: { sessionId: input.sessionId },
      parts: [{ type: "text", text: input.prompt }],
    });
  }
  if (input.assistantMessageId && !byId.has(input.assistantMessageId)) {
    next.push({
      id: input.assistantMessageId,
      role: "assistant",
      metadata: { sessionId: input.sessionId },
      parts: [],
    });
  }
  return next;
}

function isSupportedMention(mention: GoatChatMention): mention is GoatChatMention {
  return mention.kind === "engine" && mention.id === "codex";
}

function hasCodexMentionToken(value: string) {
  return /(^|\s)@codex(?=\s|$)/i.test(value);
}

function findActiveMentionToken(value: string, caret: number): ActiveMentionToken | null {
  const beforeCaret = value.slice(0, caret);
  const boundary = Math.max(
    beforeCaret.lastIndexOf(" "),
    beforeCaret.lastIndexOf("\n"),
    beforeCaret.lastIndexOf("\t"),
  );
  const start = boundary + 1;
  const suffix = value.slice(caret);
  const nextWhitespace = suffix.search(/\s/);
  const end = nextWhitespace === -1 ? value.length : caret + nextWhitespace;
  const token = value.slice(start, end);
  if (!token.startsWith("@")) return null;

  const query = token.slice(1).toLowerCase();
  if (!query || "codex".startsWith(query)) {
    return { start, end, query };
  }
  return null;
}

function renderComposerInputOverlay(value: string, highlightCodexMention: boolean) {
  if (!highlightCodexMention) return value;
  const match = /(^|\s)(@codex)(?=\s|$)/i.exec(value);
  if (!match || match.index === undefined) return value;

  const leadingWhitespace = match[1] ?? "";
  const mention = match[2] ?? "@codex";
  const mentionStart = match.index + leadingWhitespace.length;
  const mentionEnd = mentionStart + mention.length;
  return (
    <>
      {value.slice(0, mentionStart)}
      {/* Keep inline metrics identical to the textarea; paint-only styles preserve caret alignment. */}
      <span
        data-testid="selected-codex-mention"
        className="rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]"
      >
        {value.slice(mentionStart, mentionEnd)}
      </span>
      {value.slice(mentionEnd)}
    </>
  );
}

function ChatTitleHeader({
  title,
  model,
  engine,
}: {
  title: string;
  model: string;
  engine: GoatChatEngine;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-full border border-surface-subtle bg-surface px-2.5 py-1 text-ink shadow-[0_1px_3px_rgba(15,15,15,0.04)]">
      {engine === "local_codex" ? (
        <Code2 size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
      ) : engine === "codex" ? (
        <OpenAIIcon size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
      ) : (
        <GoatModelProviderIcon
          modelId={model}
          size={14}
          strokeWidth={1.9}
          className="shrink-0 text-ink-muted"
        />
      )}
      <span className="max-w-[min(420px,calc(100vw-7rem))] truncate text-[12.5px] font-medium leading-4">
        {title}
      </span>
    </div>
  );
}

type LiveChatMessagesChange = Dispatch<
  SetStateAction<{ sessionId: string; messages: GoatChatUiMessage[] } | null>
>;

function LiveChatMessages({
  sessionId,
  onChange,
}: {
  sessionId: string;
  onChange: LiveChatMessagesChange;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <LiveChatMessageSubscriber sessionId={sessionId} onChange={onChange} />;
}

function LiveChatMessageSubscriber({
  sessionId,
  onChange,
}: {
  sessionId: string;
  onChange: LiveChatMessagesChange;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const messagesCollection = useMemo(
    () => collections.chatMessages(sessionId),
    [collections, sessionId],
  );
  const { data: rows, isLoading } = useLiveQuery(
    (q) => q.from({ message: messagesCollection }),
    [messagesCollection],
  );
  const liveMessages = useMemo(() => {
    return ((rows ?? []) as GoatChatMessageRow[])
      .toSorted((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map(chatMessageRowToUiMessage);
  }, [rows]);

  useEffect(() => {
    if (isLoading) return;
    onChange({ sessionId, messages: liveMessages });
  }, [isLoading, liveMessages, onChange, sessionId]);

  return null;
}

function LiveLocalCodexSessionStatus({
  chatSessionId,
  setRunning,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <LiveLocalCodexSessionStatusSubscriber chatSessionId={chatSessionId} setRunning={setRunning} />
  );
}

function LiveLocalCodexSessionStatusSubscriber({
  chatSessionId,
  setRunning,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const localCodexSessionCollection = useMemo(
    () => collections.localCodexSessions(chatSessionId),
    [chatSessionId, collections],
  );
  const { data: rows } = useLiveQuery((q) =>
    q.from({ localCodexSession: localCodexSessionCollection }),
  );
  const status = ((rows ?? []) as GoatLocalCodexSessionRow[])[0]?.status ?? null;

  useEffect(() => {
    if (!status) return;
    setRunning(status === "starting" || status === "running");
  }, [setRunning, status]);

  return null;
}

function LiveCodexChatSessionStatus({
  chatSessionId,
  setRunning,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <LiveCodexChatSessionStatusSubscriber chatSessionId={chatSessionId} setRunning={setRunning} />
  );
}

function LiveCodexChatSessionStatusSubscriber({
  chatSessionId,
  setRunning,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const codexChatSessionCollection = useMemo(
    () => collections.codexChatSessions(chatSessionId),
    [chatSessionId, collections],
  );
  const { data: rows } = useLiveQuery((q) =>
    q.from({ codexChatSession: codexChatSessionCollection }),
  );
  const status = ((rows ?? []) as GoatCodexChatSessionRow[])[0]?.status ?? null;

  useEffect(() => {
    if (!status) return;
    setRunning(status === "starting" || status === "running");
  }, [setRunning, status]);

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
  optimisticallyArchivedChatIds,
  onSelect,
  onArchive,
}: {
  chats: readonly GoatChatSummaryView[];
  optimisticallyArchivedChatIds: ReadonlySet<string>;
  onSelect: (chat: GoatChatSummaryView) => void;
  onArchive: (chat: GoatChatSummaryView) => void;
}) {
  const router = useRouter();
  const visibleChats = chats
    .filter((chat) => !optimisticallyArchivedChatIds.has(chat.id))
    .filter((chat) => isRecentGoatHomeActivity(chat.updatedAt))
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (visibleChats.length === 0) {
    return <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">No chats yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {visibleChats.map((chat) => {
        const href = chatHref(chat.id);
        const prefetchChat = () => router.prefetch(href);
        return (
          <div
            key={chat.id}
            className="group/chat relative flex items-center rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover"
          >
            <Link
              href={href}
              prefetch
              onMouseEnter={prefetchChat}
              onFocus={prefetchChat}
              onTouchStart={prefetchChat}
              onClick={() => onSelect(chat)}
              className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
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
                  <span className="shrink-0 text-[12px] leading-tight text-ink-subtle transition-opacity duration-150 group-hover/chat:opacity-0 group-focus-within/chat:opacity-0">
                    {formatRelativeTime(chat.updatedAt)}
                  </span>
                </div>
                <p className="truncate text-[12.5px] leading-4 text-ink-subtle">{chat.preview}</p>
              </div>
            </Link>
            <button
              type="button"
              aria-label={`Archive ${chat.title}`}
              title="Archive"
              onClick={() => onArchive(chat)}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md bg-surface-hover text-ink-subtle opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-surface-muted hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100"
            >
              <Archive size={14} strokeWidth={2} />
            </button>
          </div>
        );
      })}
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
    .filter(
      (task) =>
        !optimisticallyArchivedIds.has(task.id) &&
        !task.archivedAt &&
        isRecentGoatHomeActivity(task.createdAt),
    )
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
  const router = useRouter();
  const meta = getTaskMeta(task);
  const Icon = meta.icon;
  const title = task.name;
  const href = `/tasks/${encodeURIComponent(task.displayId)}`;
  const prefetchTask = () => router.prefetch(href);
  const canArchive =
    task.status === "succeeded" || task.status === "failed" || task.status === "canceled";
  return (
    <div className="group/result relative flex items-center rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <Link
        href={href}
        prefetch
        onMouseEnter={prefetchTask}
        onFocus={prefetchTask}
        onTouchStart={prefetchTask}
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

function GoatModelPicker({
  value,
  onChange,
  disabled,
  localCodexBetaEnabled,
  codexConnected = false,
}: {
  value: GoatChatModelSelection;
  onChange: (modelId: GoatChatModelSelection) => void;
  disabled: boolean;
  localCodexBetaEnabled: boolean;
  codexConnected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isLocalCodexSelected = localCodexBetaEnabled && value === LOCAL_CODEX_PICKER_VALUE;
  const isCodexSelected = value === CODEX_PICKER_VALUE;
  const isEngineSelected = isLocalCodexSelected || isCodexSelected;
  const selectedModel = !isEngineSelected
    ? (findGoatModel(value) ?? findGoatModel(DEFAULT_GOAT_MODEL))
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Model"
        disabled={disabled}
        className="mb-px flex h-7 max-w-[170px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        {isLocalCodexSelected ? (
          <Code2 size={13} strokeWidth={1.9} className="shrink-0" />
        ) : isCodexSelected ? (
          <OpenAIIcon size={13} strokeWidth={1.9} className="shrink-0" />
        ) : (
          <GoatModelProviderIcon
            modelId={selectedModel?.id ?? DEFAULT_GOAT_MODEL}
            size={13}
            strokeWidth={1.9}
            className="shrink-0"
          />
        )}
        <span className="truncate">
          {isLocalCodexSelected
            ? "Local Codex"
            : isCodexSelected
              ? "Codex"
              : (selectedModel?.label ?? "Model")}
        </span>
        <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-0 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <Command className="bg-surface text-ink">
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[min(320px,calc(100vh-9rem))]">
            <CommandEmpty>No models found.</CommandEmpty>
            {codexConnected || localCodexBetaEnabled ? (
              <CommandGroup heading="Engines">
                {codexConnected ? (
                  <CommandItem
                    value={CODEX_PICKER_VALUE}
                    keywords={["Codex", "cloud", "sandbox", "engine"]}
                    onSelect={() => {
                      onChange(CODEX_PICKER_VALUE);
                      setOpen(false);
                    }}
                    title="Chat with Codex in a persistent cloud sandbox."
                    className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                  >
                    <Check
                      size={13}
                      strokeWidth={2}
                      className={cn(
                        "shrink-0 text-ink",
                        isCodexSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <OpenAIIcon size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-4">Codex</div>
                      <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                        Cloud Codex sandbox
                      </div>
                    </div>
                  </CommandItem>
                ) : null}
                {localCodexBetaEnabled ? (
                  <CommandItem
                    value={LOCAL_CODEX_PICKER_VALUE}
                    keywords={["Local Codex", "Codex", "local repo", "worktree"]}
                    onSelect={() => {
                      onChange(LOCAL_CODEX_PICKER_VALUE);
                      setOpen(false);
                    }}
                    title="Run Codex locally in a clean session folder."
                    className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                  >
                    <Check
                      size={13}
                      strokeWidth={2}
                      className={cn(
                        "shrink-0 text-ink",
                        isLocalCodexSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <Code2 size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-4">Local Codex</div>
                      <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                        Local session bridge
                      </div>
                    </div>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Models">
              {GOAT_MODELS.map((model) => {
                const isSelected = !isLocalCodexSelected && model.id === selectedModel?.id;
                return (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    keywords={[model.label, modelProviderLabel(model.id)]}
                    onSelect={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                    title={model.description}
                    className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                  >
                    <Check
                      size={13}
                      strokeWidth={2}
                      className={cn("shrink-0 text-ink", isSelected ? "opacity-100" : "opacity-0")}
                    />
                    <GoatModelProviderIcon
                      modelId={model.id}
                      size={14}
                      strokeWidth={1.85}
                      className="shrink-0 text-ink-muted"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-4">{model.label}</div>
                      <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                        {modelProviderLabel(model.id)}
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function findGoatModel(id: string) {
  return GOAT_MODELS.find((model) => model.id === id);
}

function GoatModelProviderIcon({
  modelId,
  size,
  strokeWidth,
  className,
}: {
  modelId: string;
  size: number;
  strokeWidth: number;
  className?: string;
}) {
  const provider = modelId.split("/")[0] ?? "";
  if (provider === "anthropic") {
    return <AnthropicIcon size={size} strokeWidth={strokeWidth} className={className} />;
  }
  if (provider === "moonshotai") {
    return <MoonshotIcon size={size} strokeWidth={strokeWidth} className={className} />;
  }
  if (provider === "openai") {
    return <OpenAIIcon size={size} strokeWidth={strokeWidth} className={className} />;
  }
  return <Sparkles size={size} strokeWidth={strokeWidth} className={className} />;
}

function modelProviderLabel(id: string) {
  const provider = id.split("/")[0] ?? "";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "moonshotai") return "Moonshot";
  if (provider === "openai") return "OpenAI";
  return provider;
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

function EngineStopButton({ onStop }: { onStop: () => void }) {
  return (
    <button
      type="button"
      aria-label="Interrupt Local Codex"
      title="Interrupt Local Codex"
      onClick={onStop}
      className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-ink-muted transition-colors duration-150 hover:border-danger-border hover:bg-danger-bg hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <Square size={11} strokeWidth={2.2} fill="currentColor" />
    </button>
  );
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
