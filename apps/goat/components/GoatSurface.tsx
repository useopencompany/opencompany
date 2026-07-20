"use client";

import { useChat } from "@ai-sdk/react";
import type { AgentModelId } from "@opencompany/agent-runtime";
import { CODEX_REASONING_EFFORTS } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
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
  Plus,
  Settings,
  Sparkles,
  Square,
  Target,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
import { buildChatTaskLookup } from "@/components/chat/assistant-items";
import {
  GoatComposerAttachments,
  GoatComposerDropOverlay,
} from "@/components/chat/ChatComposerAttachments";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import type { CodexToolAction } from "@/components/chat/ToolCallItem";
import { useGoatChatAttachments } from "@/components/chat/useGoatChatAttachments";
import { useHydrated } from "@/components/useHydrated";
import type { GoatBrainSkillCatalogItem } from "@/lib/brain-skills";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import { GOAT_CHAT_ATTACHMENT_ACCEPT } from "@/lib/chat-attachment-formats";
import {
  compareGoatChatMessageOrder,
  type GoatChatMention,
  type GoatChatMessageMetadata,
  type GoatChatSessionView,
  type GoatChatSummaryView,
  type GoatChatUiAttachment,
  type GoatChatUiMessage,
  type GoatCodexRuntimeView,
  type GoatStoredChatMessage,
  textFromGoatChatUiMessage,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";
import { GOAT_CHAT_OUT_OF_CREDITS_MESSAGE } from "@/lib/chat-validation";
import {
  CODEX_CHAT_DEFAULT_MODEL_ID,
  CODEX_PICKER_VALUE,
  type CodexChatModelId,
  type CodexPickerValue,
  normalizeCodexChatModelId,
} from "@/lib/codex-chat-constants";
import type { GoatCodexComposerSettingsView } from "@/lib/codex-chat-settings";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isRecentGoatHomeActivity } from "@/lib/home-activity";
import { LOCAL_CODEX_PICKER_VALUE, type LocalCodexPickerValue } from "@/lib/local-codex-constants";
import {
  CODEX_MODELS,
  DEFAULT_GOAT_MODEL,
  GOAT_MODELS,
  goatModelContextWindowTokens,
  normalizeGoatModel,
} from "@/lib/model-options";
import {
  createGoatCollections,
  type GoatChatMessageRow,
  type GoatCodexChatSessionRow,
  type GoatLocalCodexSessionRow,
  type GoatTaskRow,
} from "@/lib/task-collections";
import { GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import type { GoatCodexSandboxStatus } from "@/lib/task-runner";
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
const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
const CODEX_GOAL_TOKEN_BUDGET_MAX = 2_000_000;
const CODEX_SANDBOX_STATUS_POLL_INTERVAL_MS = 30_000;
const CODEX_MENTION: GoatChatMention = { kind: "engine", id: "codex" };
const CLOUD_CODEX_ATTACHMENT_CAPABILITIES = { images: true, pdf: true } as const;

type ActiveMentionToken = {
  start: number;
  end: number;
  query: string;
};

type MentionOption =
  | { kind: "engine"; token: "@codex"; label: string; mention: GoatChatMention }
  | {
      kind: "skill";
      token: string;
      label: string;
      description: string;
      mention: GoatChatMention;
    };

type GoatChatModelSelection = AgentModelId | LocalCodexPickerValue | CodexPickerValue;

// Engine chats (Local Codex bridge, cloud Codex sandbox) bypass useChat entirely: sends go to an
// engine endpoint, streaming arrives as Electric row updates, and stop is an interrupt call.
type GoatEngineChatKind = "local_codex" | "codex";
type CodexComposerSettings = GoatCodexComposerSettingsView;
type CodexComposerUiState = {
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  goalModeEnabled: boolean;
  goalObjective: string;
  goalTokenBudget: string;
};

const ENGINE_CHAT_CONFIG: Record<
  GoatEngineChatKind,
  {
    label: string;
    messagesEndpoint: string;
    interruptEndpoint: (chatSessionId: string) => string;
  }
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

type GoatHomeTaskItem =
  | { kind: "background"; task: GoatTaskView }
  | { kind: "codex"; chat: GoatChatSummaryView };

export function GoatSurface({
  tasks,
  schedules = [],
  defaultModel,
  initialChat,
  recentChats = [],
  codexConnected = false,
  localCodexBetaEnabled = false,
  taskSpawningEnabled = false,
  chatResumeEnabled = false,
  userName = "there",
  userWorkosId = "",
}: {
  tasks: readonly GoatTaskView[];
  schedules?: readonly GoatTaskScheduleView[];
  defaultModel: string;
  initialChat: GoatChatSessionView | null;
  recentChats?: readonly GoatChatSummaryView[];
  codexConnected?: boolean;
  localCodexBetaEnabled?: boolean;
  taskSpawningEnabled?: boolean;
  chatResumeEnabled?: boolean;
  userName?: string;
  // Scopes chat attachment uploads; attachments are disabled when absent.
  userWorkosId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputOverlayRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | null>(null);
  const isPinnedAtBottomRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const pendingInputCaretRef = useRef<number | null>(null);
  const initialCodexComposerUiState = codexComposerUiStateForChat(initialChat);
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const activeTurnAssistantMessageIdRef = useRef<string | null>(null);
  const wasAgentWorkingRef = useRef(false);
  const optimisticAttachmentPreviewUrlsRef = useRef<ReadonlyMap<string, string[]>>(new Map());
  const persistedMessageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [input, setInput] = useState("");
  const [mentionToken, setMentionToken] = useState<ActiveMentionToken | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<GoatChatMention[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<GoatBrainSkillCatalogItem[]>([]);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
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
  const [codexModel, setCodexModel] = useState<CodexChatModelId>(() =>
    normalizeCodexChatModelId(initialChat?.model),
  );
  const [engineChatSession, setEngineChatSession] = useState<{
    engine: GoatEngineChatKind;
    chatSessionId: string;
  } | null>(() => {
    const engine = engineChatKindFromChat(initialChat, localCodexBetaEnabled);
    return engine && initialChat ? { engine, chatSessionId: initialChat.id } : null;
  });
  const [codexComposerStateByChatId, setCodexComposerStateByChatId] = useState<
    ReadonlyMap<string, CodexComposerUiState>
  >(() => {
    if (!initialChat || !initialChat.codexComposerSettings) return new Map();
    return new Map([[initialChat.id, initialCodexComposerUiState]]);
  });
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(
    initialCodexComposerUiState.reasoningEffort,
  );
  const [codexPlanModeEnabled, setCodexPlanModeEnabled] = useState(
    initialCodexComposerUiState.planModeEnabled,
  );
  const [codexGoalModeEnabled, setCodexGoalModeEnabled] = useState(
    initialCodexComposerUiState.goalModeEnabled,
  );
  const [codexGoalObjective, setCodexGoalObjective] = useState(
    initialCodexComposerUiState.goalObjective,
  );
  const [codexGoalTokenBudget, setCodexGoalTokenBudget] = useState(
    initialCodexComposerUiState.goalTokenBudget,
  );
  const [codexSandboxStatus, setCodexSandboxStatus] = useState<GoatCodexSandboxStatus | null>(null);
  const [codexRuntime, setCodexRuntime] = useState<GoatCodexRuntimeView | null>(
    initialChat?.codexRuntime ?? null,
  );
  const [engineRunning, setEngineRunning] = useState(false);
  const [engineSubmitting, setEngineSubmitting] = useState(false);
  const [newChatCommandOpen, setNewChatCommandOpen] = useState(false);
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [backgroundChatCount, setBackgroundChatCount] = useState(0);
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
  const [activeTurnStartedAtMs, setActiveTurnStartedAtMs] = useState<number | null>(null);
  const [optimisticTurnDurations, setOptimisticTurnDurations] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [, startArchiveTransition] = useTransition();
  const homeChats = useMemo(
    () =>
      visibleHomeChats(recentChats, optimisticallyArchivedChatIds).filter(
        (chat) => chat.engine !== "codex",
      ),
    [optimisticallyArchivedChatIds, recentChats],
  );
  const homeSchedules = useMemo(
    () => (taskSpawningEnabled ? visibleHomeSchedules(schedules) : []),
    [schedules, taskSpawningEnabled],
  );
  const homeTasks = useMemo(
    () =>
      visibleHomeTasks({
        tasks: taskSpawningEnabled ? tasks : [],
        chats: recentChats,
        optimisticallyArchivedTaskIds: optimisticallyArchivedIds,
        optimisticallyArchivedChatIds,
      }),
    [
      optimisticallyArchivedChatIds,
      optimisticallyArchivedIds,
      recentChats,
      taskSpawningEnabled,
      tasks,
    ],
  );
  const hasHomeActivity = homeTasks.length > 0 || homeChats.length > 0 || homeSchedules.length > 0;
  const homeGreetingName = userName.trim() || "there";

  const beginActiveTurn = useCallback((assistantMessageId: string | null = null) => {
    const startedAtMs = Date.now();
    activeTurnStartedAtRef.current = startedAtMs;
    activeTurnAssistantMessageIdRef.current = assistantMessageId;
    setActiveTurnStartedAtMs(startedAtMs);
  }, []);

  const clearActiveTurn = useCallback(() => {
    activeTurnStartedAtRef.current = null;
    activeTurnAssistantMessageIdRef.current = null;
    setActiveTurnStartedAtMs(null);
  }, []);

  const recordOptimisticTurnDuration = useCallback(
    (assistantMessageId: string | null | undefined) => {
      const startedAtMs = activeTurnStartedAtRef.current;
      if (!assistantMessageId || startedAtMs === null) return;
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      setOptimisticTurnDurations((current) => {
        const next = new Map(current);
        next.set(assistantMessageId, durationMs);
        return next;
      });
    },
    [],
  );

  const releaseOptimisticAttachmentPreviews = useCallback((messageId: string) => {
    const urls = optimisticAttachmentPreviewUrlsRef.current.get(messageId);
    if (!urls) return;
    for (const url of urls) URL.revokeObjectURL(url);
    const next = new Map(optimisticAttachmentPreviewUrlsRef.current);
    next.delete(messageId);
    optimisticAttachmentPreviewUrlsRef.current = next;
  }, []);

  const releaseAllOptimisticAttachmentPreviews = useCallback(() => {
    for (const urls of optimisticAttachmentPreviewUrlsRef.current.values()) {
      for (const url of urls) URL.revokeObjectURL(url);
    }
    optimisticAttachmentPreviewUrlsRef.current = new Map();
  }, []);

  const trackOptimisticAttachmentPreviews = useCallback(
    (messageId: string, attachments: readonly GoatChatUiAttachment[]) => {
      const urls = attachments.flatMap((attachment) =>
        attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (urls.length === 0) return;
      if (persistedMessageIdsRef.current.has(messageId)) {
        for (const url of urls) URL.revokeObjectURL(url);
        return;
      }
      const next = new Map(optimisticAttachmentPreviewUrlsRef.current);
      next.set(messageId, urls);
      optimisticAttachmentPreviewUrlsRef.current = next;
    },
    [],
  );

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
      if (!mountedRef.current) return;
      recordOptimisticTurnDuration(message.id);
      const sessionId = message.metadata?.sessionId;
      if (sessionId) {
        setChatSessionId(sessionId);
      }
      if (!isGoatChatSurfacePath(pathnameRef.current)) return;
      if (sessionId) router.replace(chatHref(sessionId));
      router.refresh();
    },
    onError: (error) => {
      if (error.message?.includes(GOAT_CHAT_OUT_OF_CREDITS_MESSAGE)) {
        toast.error(GOAT_CHAT_OUT_OF_CREDITS_MESSAGE, {
          action: {
            label: "Add credits",
            onClick: () => router.push("/settings/workspace/billing"),
          },
        });
        return;
      }
      toast.error(error.message || "Goat could not answer that right now.");
    },
  });
  const isGenerating = status === "submitted" || status === "streaming";
  const activeInitialChatEngine =
    initialChat && mode === "chat" && chatSessionId === initialChat.id
      ? engineChatKindFromChat(initialChat, localCodexBetaEnabled)
      : null;
  const activeEngineChat = useMemo(() => {
    if (!chatSessionId) return null;
    if (activeInitialChatEngine) return { engine: activeInitialChatEngine, chatSessionId };
    return engineChatSession?.chatSessionId === chatSessionId ? engineChatSession : null;
  }, [activeInitialChatEngine, chatSessionId, engineChatSession]);
  const isLocalCodexMode = localCodexBetaEnabled && chatModel === LOCAL_CODEX_PICKER_VALUE;
  const isCodexMode = chatModel === CODEX_PICKER_VALUE;
  const selectedEngine: GoatEngineChatKind | null = isLocalCodexMode
    ? "local_codex"
    : isCodexMode
      ? "codex"
      : null;
  const activeEngine = activeEngineChat?.engine ?? selectedEngine;
  const isEngineChat = activeEngine !== null;
  const activeSelectedMentions = selectedMentions.filter((mention) => {
    if (!goatChatMentionIsVisible(input, mention)) return false;
    if (mention.kind === "engine") return codexConnected;
    return activeEngine !== "local_codex";
  });
  const mentionOptions = buildMentionOptions({
    token: mentionToken,
    skills: skillCatalog,
    selectedMentions: activeSelectedMentions,
    codexConnected,
    skillsEnabled: activeEngine !== "local_codex",
  });
  const localCodexFeatureDisabledForChat = Boolean(
    initialChat &&
      !localCodexBetaEnabled &&
      mode === "chat" &&
      chatSessionId === initialChat.id &&
      initialChat.engine === "local_codex",
  );
  const attachmentsEnabled =
    Boolean(userWorkosId) && activeEngine !== "local_codex" && !localCodexFeatureDisabledForChat;
  const composerAttachments = useGoatChatAttachments({
    userWorkosId,
    modelName: String(chatModel),
    enabled: attachmentsEnabled && !engineSubmitting,
    ...(activeEngine === "codex" ? { capabilities: CLOUD_CODEX_ATTACHMENT_CAPABILITIES } : {}),
  });

  // Refetch the skill catalog on every mention-menu open (not once per mount): skills
  // created or edited since the last open must appear, and a transient fetch failure
  // must not blank the menu for the rest of the session — keep the previous catalog
  // and let the next open retry.
  const skillMentionMenuOpen = Boolean(
    userWorkosId && mentionToken && activeEngine !== "local_codex",
  );
  useEffect(() => {
    if (!skillMentionMenuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch("/api/brain/skills", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Skill catalog request failed (${response.status})`);
          const payload = (await response.json()) as { skills?: unknown };
          return Array.isArray(payload.skills)
            ? payload.skills.filter(isGoatBrainSkillCatalogItem)
            : [];
        })
        .then(setSkillCatalog)
        .catch(() => {});
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skillMentionMenuOpen]);

  const attachmentFileInputRef = useRef<HTMLInputElement>(null);
  // Render list: Electric-synced rows are the source of truth for persisted
  // messages; the useChat overlay contributes only entries Electric has not
  // delivered yet (the in-flight turn and optimistic sends).
  const persistedMessages = useMemo(() => {
    if (!chatSessionId) return [];
    if (liveChat && liveChat.sessionId === chatSessionId) return liveChat.messages;
    if (initialChat && initialChat.id === chatSessionId) return initialChat.messages;
    return [];
  }, [chatSessionId, initialChat, liveChat]);
  useEffect(() => {
    persistedMessageIdsRef.current = new Set(persistedMessages.map((message) => message.id));
    for (const message of persistedMessages) {
      releaseOptimisticAttachmentPreviews(message.id);
    }
  }, [persistedMessages, releaseOptimisticAttachmentPreviews]);
  const chatMessages = useMemo(() => {
    if (persistedMessages.length === 0) return messages;
    const persistedIds = new Set(persistedMessages.map((message) => message.id));
    const overlay = messages.filter((message) => !persistedIds.has(message.id));
    return overlay.length > 0 ? [...persistedMessages, ...overlay] : persistedMessages;
  }, [messages, persistedMessages]);
  const latestAssistantMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      if (chatMessages[index]?.role === "assistant") return chatMessages[index]?.id ?? null;
    }
    return null;
  }, [chatMessages]);
  const hasMessages = chatMessages.length > 0;
  const isEngineWorking = isEngineChat && (engineRunning || engineSubmitting);
  const isAgentWorking = isGenerating || isEngineWorking;
  const latestActiveTurnStartedAtMs = useMemo(
    () => latestChatTurnStartedAtMs(chatMessages),
    [chatMessages],
  );
  const activeTurnTimerStartedAtMs = activeTurnStartedAtMs ?? latestActiveTurnStartedAtMs;
  const trimmedNewChatPrompt = newChatPrompt.trim();
  const newChatPromptValid =
    trimmedNewChatPrompt.length > 0 &&
    trimmedNewChatPrompt.length <= BACKGROUND_CHAT_PROMPT_MAX_LENGTH;
  const showCodexComposerControls = isEngineChat && !localCodexFeatureDisabledForChat;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseAllOptimisticAttachmentPreviews();
    };
  }, [releaseAllOptimisticAttachmentPreviews]);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (isAgentWorking) {
      wasAgentWorkingRef.current = true;
      setActiveTurnStartedAtMs((current) => {
        if (current !== null) {
          activeTurnStartedAtRef.current = current;
          return current;
        }
        const startedAtMs = latestActiveTurnStartedAtMs ?? Date.now();
        activeTurnStartedAtRef.current = startedAtMs;
        return startedAtMs;
      });
      return;
    }

    if (wasAgentWorkingRef.current) {
      recordOptimisticTurnDuration(activeTurnAssistantMessageIdRef.current);
    }
    wasAgentWorkingRef.current = false;
    clearActiveTurn();
  }, [clearActiveTurn, isAgentWorking, latestActiveTurnStartedAtMs, recordOptimisticTurnDuration]);

  const chatTaskLookup = useMemo(
    () =>
      taskSpawningEnabled
        ? buildChatTaskLookup({
            messages: chatMessages,
            tasks,
            liveTasks: liveChatTasks,
          })
        : new Map(),
    [chatMessages, liveChatTasks, taskSpawningEnabled, tasks],
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
  // Context-window occupancy: the most recent assistant turn that reported usage
  // reflects the current fill level. Undefined until the first turn completes.
  const currentContextTokens = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const tokens = chatMessages[index]?.metadata?.contextTokens;
      if (typeof tokens === "number" && tokens > 0) return tokens;
    }
    return 0;
  }, [chatMessages]);
  const contextMaxTokens = goatModelContextWindowTokens(activeChatModel);

  const applyCodexComposerUiState = useCallback((state: CodexComposerUiState) => {
    setCodexReasoningEffort(state.reasoningEffort);
    setCodexPlanModeEnabled(state.planModeEnabled);
    setCodexGoalModeEnabled(state.goalModeEnabled);
    setCodexGoalObjective(state.goalObjective);
    setCodexGoalTokenBudget(state.goalTokenBudget);
  }, []);

  const openChat = useCallback(
    (
      chat: {
        id: string;
        model: string;
        engine?: GoatChatEngine;
        codexComposerSettings?: CodexComposerSettings | null;
        codexRuntime?: GoatCodexRuntimeView | null;
      } | null,
    ) => {
      if (chatSessionId && isEngineChat && !localCodexFeatureDisabledForChat) {
        const currentComposerState = currentCodexComposerUiState({
          reasoningEffort: codexReasoningEffort,
          planModeEnabled: codexPlanModeEnabled,
          goalModeEnabled: codexGoalModeEnabled,
          goalObjective: codexGoalObjective,
          goalTokenBudget: codexGoalTokenBudget,
        });
        setCodexComposerStateByChatId((current) => {
          const next = new Map(current);
          next.set(chatSessionId, currentComposerState);
          return next;
        });
      }

      const engineTarget = engineChatKindFromChat(chat, localCodexBetaEnabled);
      const nextCodexComposerState = codexComposerUiStateForChat(chat, codexComposerStateByChatId);
      releaseAllOptimisticAttachmentPreviews();
      setChatSessionId(chat?.id ?? null);
      setChatInstanceKey(chat?.id ?? "goat-chat-main");
      setChatModel(
        engineTarget === "local_codex"
          ? LOCAL_CODEX_PICKER_VALUE
          : engineTarget === "codex"
            ? CODEX_PICKER_VALUE
            : normalizeGoatModel(chat?.model ?? defaultModel),
      );
      setCodexModel(normalizeCodexChatModelId(chat?.model));
      setEngineChatSession(
        chat && engineTarget ? { engine: engineTarget, chatSessionId: chat.id } : null,
      );
      applyCodexComposerUiState(nextCodexComposerState);
      setCodexSandboxStatus(null);
      setCodexRuntime(engineTarget === "codex" ? (chat?.codexRuntime ?? null) : null);
      setEngineRunning(false);
      clearActiveTurn();
      setOptimisticTurnDurations(new Map());
      setMessages([]);
      setLocallyStoppedAssistantMessageIds(new Set());
      clearError();
      setMode(chat ? "chat" : "home");
    },
    [
      applyCodexComposerUiState,
      chatSessionId,
      clearActiveTurn,
      clearError,
      codexComposerStateByChatId,
      codexGoalModeEnabled,
      codexGoalObjective,
      codexGoalTokenBudget,
      codexPlanModeEnabled,
      codexReasoningEffort,
      defaultModel,
      isEngineChat,
      localCodexBetaEnabled,
      localCodexFeatureDisabledForChat,
      releaseAllOptimisticAttachmentPreviews,
      setMessages,
    ],
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

  // The visible composer text is painted by an overlay div behind the transparent
  // textarea; once the textarea scrolls past its max height the overlay must follow
  // its scroll position or the painted text freezes while the caret keeps moving.
  const syncInputOverlayScroll = useCallback(() => {
    const overlay = inputOverlayRef.current;
    const el = inputRef.current;
    if (!overlay || !el) return;
    overlay.scrollTop = el.scrollTop;
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    syncInputOverlayScroll();
  }, [input, syncInputOverlayScroll]);

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
    if (chatMessages.length === 0 && !isAgentWorking) return;
    const thread = threadRef.current;
    if (!thread || typeof thread.scrollTo !== "function") return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "auto" });
  }, [chatMessages, isAgentWorking, mode]);

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
    const pendingAttachments = composerAttachments.attachments;
    const readyAttachments = pendingAttachments.filter(
      (attachment) => attachment.status === "ready",
    );
    if (!prompt && readyAttachments.length === 0) return;
    if (localCodexFeatureDisabledForChat) {
      toast.error(LOCAL_CODEX_BETA_DISABLED_MESSAGE);
      return;
    }
    if (pendingAttachments.length > 0 && activeEngine === "local_codex") {
      toast.error("Attachments are not supported in Local Codex chats yet.");
      return;
    }
    if (composerAttachments.isUploading) {
      toast.error("Wait for attachments to finish uploading.");
      return;
    }
    if (composerAttachments.hasFailed) {
      toast.error("Remove failed attachments before sending.");
      return;
    }
    const mentions = activeSelectedMentions.filter((mention) =>
      goatChatMentionIsVisible(prompt, mention),
    );
    // previewUrl rides along for the optimistic bubble render; the server ignores it and
    // re-mints attachment ids on persist.
    const attachmentsMetadata = readyAttachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      // biome-ignore lint/style/noNonNullAssertion: filtered to ready attachments with blob fields
      blobUrl: attachment.blobUrl!,
      // biome-ignore lint/style/noNonNullAssertion: filtered to ready attachments with blob fields
      blobPathname: attachment.blobPathname!,
      ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
    }));

    clearError();
    setMode("chat");
    isPinnedAtBottomRef.current = true;
    setLocallyStoppedAssistantMessageIds(new Set());
    setInput("");
    setMentionToken(null);
    setSelectedMentions([]);
    if (activeEngine) {
      const settings = buildCodexComposerSettings({
        prompt,
        reasoningEffort: codexReasoningEffort,
        planModeEnabled: codexPlanModeEnabled,
        goalModeEnabled: codexGoalModeEnabled,
        goalObjective: codexGoalObjective,
        goalTokenBudget: codexGoalTokenBudget,
      });
      if (!settings.ok) {
        setInput(prompt);
        setSelectedMentions(mentions);
        toast.error(settings.error);
        return;
      }
      const engine = activeEngine;
      const config = ENGINE_CHAT_CONFIG[engine];
      const userMessageId = `goat_chat_msg_${crypto.randomUUID()}`;
      const existingEngineSessionId = activeEngineChat?.chatSessionId ?? null;
      beginActiveTurn();
      setEngineSubmitting(true);
      // Keep the object URLs alive for the optimistic user bubble.
      composerAttachments.setAttachments([]);
      void sendEngineChatMessage({
        endpoint: config.messagesEndpoint,
        errorLabel: config.label,
        prompt,
        sessionId: existingEngineSessionId,
        settings: settings.settings,
        userMessageId,
        attachments: attachmentsMetadata,
        mentions: engine === "codex" ? mentions.filter(isSkillMention) : [],
        ...(engine === "codex" && !existingEngineSessionId ? { model: codexModel } : {}),
      })
        .then((result) => {
          trackOptimisticAttachmentPreviews(result.userMessageId, attachmentsMetadata);
          setChatSessionId(result.sessionId);
          setEngineChatSession({ engine, chatSessionId: result.sessionId });
          activeTurnAssistantMessageIdRef.current = result.assistantMessageId;
          setEngineRunning(true);
          setCodexComposerStateByChatId((current) => {
            const next = new Map(current);
            next.set(result.sessionId, codexComposerUiStateFromSettings(settings.settings));
            return next;
          });
          setCodexPlanModeEnabled(false);
          setCodexGoalModeEnabled(false);
          setCodexGoalObjective("");
          setCodexGoalTokenBudget("");
          setMessages((current) =>
            appendEngineOptimisticMessages(existingEngineSessionId ? current : [], {
              sessionId: result.sessionId,
              userMessageId: result.userMessageId,
              assistantMessageId: result.assistantMessageId,
              prompt,
              attachments: attachmentsMetadata,
            }),
          );
          if (isGoatChatSurfacePath(pathnameRef.current)) {
            router.replace(chatHref(result.sessionId));
            router.refresh();
          }
        })
        .catch((error) => {
          clearActiveTurn();
          setInput(prompt);
          setSelectedMentions(mentions);
          composerAttachments.setAttachments(pendingAttachments);
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

    const metadata: GoatChatMessageMetadata = {
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
    };
    const message =
      Object.keys(metadata).length > 0 ? { text: prompt, metadata } : { text: prompt };
    const model = chatModel;
    beginActiveTurn();
    // Clear without revoking previews: the optimistic bubble still shows them.
    composerAttachments.setAttachments([]);
    void sendMessage(message, { body: { sessionId: chatSessionId, model } }).catch((error) => {
      clearActiveTurn();
      setInput(prompt);
      setSelectedMentions(mentions);
      composerAttachments.setAttachments(pendingAttachments);
      toast.error(error instanceof Error ? error.message : "Goat could not answer that right now.");
    });
  };

  const handleCodexToolAction = async (action: CodexToolAction) => {
    if (action.type === "answer-question") {
      const response = await fetch(
        `/api/codex-chat/interactions/${encodeURIComponent(action.interactionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: action.answers }),
        },
      );
      if (!response.ok) {
        throw new Error((await response.text()) || "Could not send your answer to Codex.");
      }
      return;
    }

    if (action.type === "continue-plan") {
      setCodexPlanModeEnabled(true);
      inputRef.current?.focus();
      return;
    }

    if (engineSubmitting || engineRunning) {
      throw new Error("Wait for the current Codex turn to finish.");
    }
    const engine = activeEngineChat?.engine;
    const sessionId = activeEngineChat?.chatSessionId;
    if (!engine || !sessionId) throw new Error("This Codex session is no longer available.");
    const config = ENGINE_CHAT_CONFIG[engine];
    const prompt = "Implement the plan.";
    const settings: CodexComposerSettings = {
      reasoningEffort: codexReasoningEffort,
      planModeEnabled: false,
      goalMode: null,
    };
    const userMessageId = `goat_chat_msg_${crypto.randomUUID()}`;

    clearError();
    beginActiveTurn();
    setEngineSubmitting(true);
    try {
      const result = await sendEngineChatMessage({
        endpoint: config.messagesEndpoint,
        errorLabel: config.label,
        prompt,
        sessionId,
        settings,
        userMessageId,
        attachments: [],
        mentions: [],
      });
      setChatSessionId(result.sessionId);
      activeTurnAssistantMessageIdRef.current = result.assistantMessageId;
      setEngineRunning(true);
      setCodexPlanModeEnabled(false);
      setCodexComposerStateByChatId((current) => {
        const next = new Map(current);
        next.set(result.sessionId, codexComposerUiStateFromSettings(settings));
        return next;
      });
      setMessages((current) =>
        appendEngineOptimisticMessages(current, {
          sessionId: result.sessionId,
          userMessageId: result.userMessageId,
          assistantMessageId: result.assistantMessageId,
          prompt,
          attachments: [],
        }),
      );
      router.refresh();
    } catch (error) {
      clearActiveTurn();
      throw error;
    } finally {
      if (mountedRef.current) setEngineSubmitting(false);
    }
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
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setMentionOptionIndex((current) =>
          mentionOptions.length === 0
            ? 0
            : (current + direction + mentionOptions.length) % mentionOptions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const option = mentionOptions[mentionOptionIndex];
        if (option) selectMention(option);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const updateMentionToken = (value: string, selectionStart: number | null) => {
    setMentionOptionIndex(0);
    if (selectionStart === null) {
      setMentionToken(null);
      return;
    }
    setMentionToken(findActiveMentionToken(value, selectionStart));
  };

  const onInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextInput = event.target.value;
    setInput(nextInput);
    setSelectedMentions((current) =>
      current.filter((mention) => goatChatMentionIsVisible(nextInput, mention)),
    );
    updateMentionToken(nextInput, event.target.selectionStart);
  };

  const selectMention = (option: MentionOption) => {
    if (!mentionToken) return;
    const before = input.slice(0, mentionToken.start);
    const after = input.slice(mentionToken.end);
    const nextInput = `${before}${option.token} ${after}`;
    const nextCaret = before.length + option.token.length + 1;
    pendingInputCaretRef.current = nextCaret;
    setInput(nextInput);
    setSelectedMentions((current) => {
      if (option.mention.kind === "engine") {
        return [...current.filter((mention) => mention.kind !== "engine"), option.mention];
      }
      return current.some((mention) => mention.kind === "skill" && mention.id === option.mention.id)
        ? current
        : [...current, option.mention];
    });
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
          placeholder={
            taskSpawningEnabled ? "Describe the new chat or task..." : "Describe the new chat..."
          }
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
                  {trimmedNewChatPrompt || "Start another chat with Goat"}
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
            {hasHomeActivity ? (
              <>
                {homeTasks.length > 0 ? (
                  <section className="flex flex-col gap-1">
                    <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                      Tasks
                    </h2>
                    <HomeTaskRows
                      items={homeTasks}
                      onArchiveTask={archiveTask}
                      onArchiveChat={archiveChat}
                      onSelectChat={openChat}
                    />
                  </section>
                ) : null}

                {homeChats.length > 0 ? (
                  <section className="flex flex-col gap-1">
                    <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                      Chats
                    </h2>
                    <ChatHistoryList
                      chats={homeChats}
                      onSelect={openChat}
                      onArchive={archiveChat}
                    />
                  </section>
                ) : null}

                {homeSchedules.length > 0 ? (
                  <section className="flex flex-col gap-1">
                    <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                      Routines
                    </h2>
                    <ScheduleRows schedules={homeSchedules} />
                  </section>
                ) : null}
              </>
            ) : (
              <p className="px-2 text-[15px] leading-6 text-ink-muted">
                welcome back, {homeGreetingName}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 w-full flex-1 flex-col items-center">
          <div className="w-full px-6 pb-2 pt-5">
            <div className="flex w-full items-center justify-between gap-3">
              <ChatTitleHeader
                title={activeChatTitle}
                model={activeChatModel}
                engine={activeChatEngine}
              />
              <div className="flex shrink-0 items-center gap-2">
                {activeEngineChat?.engine === "codex" ? (
                  <CodexSessionStatusIndicator
                    runtime={codexRuntime}
                    optimisticStatus={
                      engineSubmitting ? "starting" : engineRunning ? "running" : null
                    }
                    sandboxStatus={codexSandboxStatus}
                  />
                ) : null}
                {currentContextTokens > 0 ? (
                  <ChatContextMeter used={currentContextTokens} max={contextMaxTokens} />
                ) : null}
              </div>
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
                  durationMs={chatMessageDurationMs(message, optimisticTurnDurations)}
                  onCodexAction={handleCodexToolAction}
                  allowCodexPlanActions={message.id === latestAssistantMessageId}
                />
              ))}
              {isAgentWorking && activeTurnTimerStartedAtMs !== null ? (
                <ThinkingIndicator
                  startedAtMs={activeTurnTimerStartedAtMs}
                  label={
                    isEngineChat
                      ? codexRuntime?.status === "queued"
                        ? "Codex is queued"
                        : "Codex is working"
                      : "Goat is working"
                  }
                />
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
          setSandboxStatus={setCodexSandboxStatus}
          setRuntime={setCodexRuntime}
        />
      ) : null}
      {mode === "chat" && taskSpawningEnabled ? (
        <LiveChatTasks setTasks={setLiveChatTasks} />
      ) : null}

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
          {mentionToken && mentionOptions.length > 0 ? (
            <div
              role="listbox"
              aria-label="Mention menu"
              className="absolute bottom-full left-3 z-20 mb-2 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
            >
              {mentionOptions.map((option, index) => (
                <button
                  key={option.token}
                  type="button"
                  role="option"
                  aria-selected={index === mentionOptionIndex}
                  onMouseEnter={() => setMentionOptionIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectMention(option);
                  }}
                  onClick={() => selectMention(option)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover focus:bg-surface-hover focus:outline-none",
                    index === mentionOptionIndex && "bg-surface-hover",
                  )}
                >
                  {option.kind === "engine" ? (
                    <Code2 size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
                  ) : (
                    <Sparkles
                      size={14}
                      strokeWidth={2}
                      className="mt-0.5 shrink-0 text-ink-subtle"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-4 text-ink">
                      {option.token}
                    </span>
                    {option.kind === "skill" ? (
                      <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
                        {option.label} · {option.description}
                      </span>
                    ) : null}
                  </span>
                  {option.kind === "engine" ? (
                    <span className="text-[12px] leading-4 text-ink-subtle">Codex</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div
            {...composerAttachments.dragHandlers}
            className="relative flex flex-col rounded-2xl border border-border bg-surface shadow-[0_8px_24px_rgba(15,15,15,0.08)] transition-colors duration-150 focus-within:border-border-strong"
          >
            {composerAttachments.isDragActive && attachmentsEnabled ? (
              <GoatComposerDropOverlay />
            ) : null}
            {composerAttachments.attachments.length > 0 ? (
              <div className="px-3.5 pt-3">
                <GoatComposerAttachments
                  attachments={composerAttachments.attachments}
                  onRemove={composerAttachments.removeAttachment}
                />
              </div>
            ) : null}
            <div className="flex items-end gap-2.5 px-3.5 pt-3 pb-1.5">
              <div className="relative min-w-0 flex-1 self-center">
                {input ? (
                  <div
                    ref={inputOverlayRef}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 max-h-32 overflow-hidden whitespace-pre-wrap break-words py-[3px] text-[13.5px] leading-5 text-ink"
                  >
                    {renderComposerInputOverlay(input, activeSelectedMentions)}
                  </div>
                ) : null}
                <textarea
                  ref={inputRef}
                  rows={1}
                  id="prompt"
                  name="prompt"
                  value={input}
                  placeholder={
                    mode === "chat"
                      ? "Reply..."
                      : taskSpawningEnabled
                        ? "Ask a question or describe a task..."
                        : "Ask Goat anything..."
                  }
                  onChange={onInputChange}
                  onBlur={() => setMentionToken(null)}
                  onClick={(event) =>
                    updateMentionToken(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    )
                  }
                  onKeyDown={onKeyDown}
                  onScroll={syncInputOverlayScroll}
                  onPaste={(event) => {
                    composerAttachments.handlePasteFiles(event);
                  }}
                  onSelect={(event) =>
                    updateMentionToken(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    )
                  }
                  disabled={isGenerating || localCodexFeatureDisabledForChat}
                  className="relative z-10 block max-h-32 w-full resize-none bg-transparent py-[3px] text-[13.5px] leading-5 text-transparent caret-ink outline-none placeholder:text-ink-subtle"
                  style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                  maxLength={10_000}
                />
              </div>
              {isEngineChat && engineRunning ? (
                <EngineStopButton
                  label={activeEngine ? ENGINE_CHAT_CONFIG[activeEngine].label : "Codex"}
                  onStop={stopGeneration}
                />
              ) : null}
              <SubmitButton
                disabled={
                  (!input.trim() &&
                    !composerAttachments.attachments.some(
                      (attachment) => attachment.status === "ready",
                    )) ||
                  composerAttachments.isUploading ||
                  engineSubmitting ||
                  localCodexFeatureDisabledForChat
                }
                isGenerating={isGenerating}
                onStop={stopGeneration}
              />
            </div>
            <div className="flex items-center gap-1 border-t border-border px-2.5 py-1.5">
              {attachmentsEnabled ? (
                <>
                  <input
                    ref={attachmentFileInputRef}
                    type="file"
                    multiple
                    accept={GOAT_CHAT_ATTACHMENT_ACCEPT}
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      if (files.length > 0) composerAttachments.acceptFiles(files);
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Attach files"
                    disabled={isGenerating || engineSubmitting}
                    onClick={() => attachmentFileInputRef.current?.click()}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                  >
                    <Plus size={16} strokeWidth={1.9} />
                  </button>
                </>
              ) : null}
              <GoatModelPicker
                value={chatModel}
                onChange={(model) => {
                  setChatModel(model);
                  if (model !== CODEX_PICKER_VALUE && model !== LOCAL_CODEX_PICKER_VALUE) {
                    setCodexPlanModeEnabled(false);
                    setCodexGoalModeEnabled(false);
                    setCodexGoalObjective("");
                    setCodexGoalTokenBudget("");
                  }
                }}
                disabled={isGenerating || Boolean(activeEngineChat)}
                localCodexBetaEnabled={localCodexBetaEnabled}
                codexConnected={codexConnected}
              />
              {showCodexComposerControls ? (
                <CodexComposerControls
                  model={activeEngine === "codex" ? codexModel : null}
                  reasoningEffort={codexReasoningEffort}
                  planModeEnabled={codexPlanModeEnabled}
                  planModeAvailable={activeEngine === "codex"}
                  goalModeEnabled={codexGoalModeEnabled}
                  goalObjective={codexGoalObjective}
                  goalTokenBudget={codexGoalTokenBudget}
                  disabled={engineSubmitting}
                  modelDisabled={engineSubmitting || Boolean(activeEngineChat)}
                  onModelChange={setCodexModel}
                  onReasoningEffortChange={setCodexReasoningEffort}
                  onPlanModeEnabledChange={setCodexPlanModeEnabled}
                  onGoalModeEnabledChange={setCodexGoalModeEnabled}
                  onGoalObjectiveChange={setCodexGoalObjective}
                  onGoalTokenBudgetChange={setCodexGoalTokenBudget}
                />
              ) : null}
            </div>
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

function isGoatChatSurfacePath(pathname: string) {
  return pathname === "/" || pathname.startsWith("/chat/");
}

function visibleHomeChats(
  chats: readonly GoatChatSummaryView[],
  optimisticallyArchivedChatIds: ReadonlySet<string>,
) {
  return chats
    .filter((chat) => !optimisticallyArchivedChatIds.has(chat.id))
    .filter((chat) => isRecentGoatHomeActivity(chat.updatedAt))
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function visibleHomeSchedules(schedules: readonly GoatTaskScheduleView[]) {
  return schedules
    .filter((schedule) => schedule.id)
    .toSorted((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
}

function visibleHomeTasks(input: {
  tasks: readonly GoatTaskView[];
  chats: readonly GoatChatSummaryView[];
  optimisticallyArchivedTaskIds: ReadonlySet<string>;
  optimisticallyArchivedChatIds: ReadonlySet<string>;
}): GoatHomeTaskItem[] {
  const backgroundItems: GoatHomeTaskItem[] = input.tasks
    .filter(
      (task) =>
        !input.optimisticallyArchivedTaskIds.has(task.id) &&
        !task.archivedAt &&
        (isBackgroundTaskActive(task) || isRecentGoatHomeActivity(task.createdAt)),
    )
    .map((task) => ({ kind: "background", task }));
  const codexItems: GoatHomeTaskItem[] = input.chats
    .filter(
      (chat) =>
        chat.engine === "codex" &&
        !input.optimisticallyArchivedChatIds.has(chat.id) &&
        chat.codexRuntime?.status !== "closed" &&
        (Boolean(chat.pinnedAt) ||
          isCodexTaskActive(chat) ||
          isRecentGoatHomeActivity(chat.updatedAt)),
    )
    .map((chat) => ({ kind: "codex", chat }));

  return [...backgroundItems, ...codexItems].toSorted((left, right) => {
    const activeDifference = Number(isHomeTaskActive(right)) - Number(isHomeTaskActive(left));
    if (activeDifference !== 0) return activeDifference;
    return homeTaskUpdatedAtMs(right) - homeTaskUpdatedAtMs(left);
  });
}

function isHomeTaskActive(item: GoatHomeTaskItem) {
  return item.kind === "background"
    ? isBackgroundTaskActive(item.task)
    : isCodexTaskActive(item.chat);
}

function isBackgroundTaskActive(task: GoatTaskView) {
  return task.status === "queued" || task.status === "running";
}

function isCodexTaskActive(chat: GoatChatSummaryView) {
  return (
    chat.codexRuntime?.status === "queued" ||
    chat.codexRuntime?.status === "starting" ||
    chat.codexRuntime?.status === "running"
  );
}

function homeTaskUpdatedAtMs(item: GoatHomeTaskItem) {
  const value =
    item.kind === "background"
      ? item.task.updatedAt
      : (item.chat.codexRuntime?.updatedAt ?? item.chat.updatedAt);
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
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

function chatMessageDurationMs(
  message: GoatChatUiMessage,
  optimisticTurnDurations: ReadonlyMap<string, number>,
) {
  if (message.role !== "assistant") return null;
  const persistedDurationMs = message.metadata?.timing?.durationMs;
  if (typeof persistedDurationMs === "number") return persistedDurationMs;
  return optimisticTurnDurations.get(message.id) ?? null;
}

function latestChatTurnStartedAtMs(messages: readonly GoatChatUiMessage[]) {
  for (const message of messages.toReversed()) {
    const createdAt = message.metadata?.timing?.createdAt;
    if (!createdAt) continue;
    const startedAtMs = Date.parse(createdAt);
    if (Number.isFinite(startedAtMs)) return startedAtMs;
  }
  return null;
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
  settings: CodexComposerSettings;
  userMessageId: string;
  attachments: GoatChatUiAttachment[];
  mentions: GoatChatMention[];
  model?: CodexChatModelId;
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
        ...(input.attachments.length > 0 || input.mentions.length > 0
          ? {
              metadata: {
                ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
                ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
              },
            }
          : {}),
      },
      settings: input.settings,
      ...(input.model ? { model: input.model } : {}),
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
    attachments: GoatChatUiAttachment[];
  },
): GoatChatUiMessage[] {
  const byId = new Set(current.map((message) => message.id));
  const next = [...current];
  if (!byId.has(input.userMessageId)) {
    next.push({
      id: input.userMessageId,
      role: "user",
      metadata: {
        sessionId: input.sessionId,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      },
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

function defaultCodexComposerUiState(): CodexComposerUiState {
  return {
    reasoningEffort: "medium",
    planModeEnabled: false,
    goalModeEnabled: false,
    goalObjective: "",
    goalTokenBudget: "",
  };
}

function codexComposerUiStateForChat(
  chat:
    | {
        id?: string | null;
        codexComposerSettings?: CodexComposerSettings | null;
      }
    | null
    | undefined,
  savedByChatId?: ReadonlyMap<string, CodexComposerUiState>,
): CodexComposerUiState {
  if (chat?.id) {
    const saved = savedByChatId?.get(chat.id);
    if (saved) return saved;
  }
  return codexComposerUiStateFromSettings(chat?.codexComposerSettings ?? null);
}

function codexComposerUiStateFromSettings(
  settings: CodexComposerSettings | null | undefined,
): CodexComposerUiState {
  if (!settings) return defaultCodexComposerUiState();
  const goalMode = settings.goalMode ?? null;
  return {
    reasoningEffort: settings.reasoningEffort,
    planModeEnabled: settings.planModeEnabled,
    goalModeEnabled: goalMode !== null,
    goalObjective: goalMode?.objective ?? "",
    goalTokenBudget: goalMode?.tokenBudget == null ? "" : String(goalMode.tokenBudget),
  };
}

function currentCodexComposerUiState(input: CodexComposerUiState): CodexComposerUiState {
  return { ...input };
}

function buildCodexComposerSettings(input: {
  prompt: string;
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  goalModeEnabled: boolean;
  goalObjective: string;
  goalTokenBudget: string;
}): { ok: true; settings: CodexComposerSettings } | { ok: false; error: string } {
  let goalMode: CodexComposerSettings["goalMode"] = null;
  if (input.goalModeEnabled) {
    const objective = (input.goalObjective.trim() || input.prompt).trim();
    if (!objective) return { ok: false, error: "Goal mode needs an objective." };
    if (objective.length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH) {
      return { ok: false, error: "Goal mode objectives can be at most 4,000 characters." };
    }

    const tokenBudget = input.goalTokenBudget.trim();
    const parsedBudget = tokenBudget ? Number(tokenBudget) : null;
    if (
      parsedBudget !== null &&
      (!Number.isInteger(parsedBudget) ||
        parsedBudget <= 0 ||
        parsedBudget > CODEX_GOAL_TOKEN_BUDGET_MAX)
    ) {
      return { ok: false, error: "Goal token budget must be a positive whole number." };
    }

    goalMode = {
      objective,
      ...(parsedBudget === null ? {} : { tokenBudget: parsedBudget }),
    };
  }

  return {
    ok: true,
    settings: {
      reasoningEffort: input.reasoningEffort,
      planModeEnabled: input.planModeEnabled,
      goalMode,
    },
  };
}

function isSupportedMention(mention: GoatChatMention): mention is GoatChatMention {
  return (
    (mention.kind === "engine" && mention.id === "codex") ||
    (mention.kind === "skill" && Boolean(mention.brainRef) && Boolean(mention.id))
  );
}

function isSkillMention(
  mention: GoatChatMention,
): mention is Extract<GoatChatMention, { kind: "skill" }> {
  return mention.kind === "skill";
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

  return { start, end, query: token.slice(1).toLowerCase() };
}

function goatChatMentionToken(mention: GoatChatMention) {
  return mention.kind === "engine" ? "@codex" : `@skill/${mention.id}`;
}

function goatChatMentionIsVisible(value: string, mention: GoatChatMention) {
  const token = escapeRegExp(goatChatMentionToken(mention));
  return new RegExp(`(^|\\s)${token}(?=\\s|$)`, "i").test(value);
}

function buildMentionOptions(input: {
  token: ActiveMentionToken | null;
  skills: GoatBrainSkillCatalogItem[];
  selectedMentions: GoatChatMention[];
  codexConnected: boolean;
  skillsEnabled: boolean;
}): MentionOption[] {
  if (!input.token) return [];
  const query = input.token.query;
  const options: MentionOption[] = [];
  if (input.codexConnected && (!query || "codex".startsWith(query))) {
    options.push({ kind: "engine", token: "@codex", label: "Codex", mention: CODEX_MENTION });
  }
  if (!input.skillsEnabled) return options;

  const selectedSkillIds = new Set(
    input.selectedMentions.flatMap((mention) => (mention.kind === "skill" ? [mention.id] : [])),
  );
  for (const skill of input.skills) {
    if (selectedSkillIds.has(skill.id)) continue;
    const haystack = `skill/${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    options.push({
      kind: "skill",
      token: `@skill/${skill.id}`,
      label: skill.name,
      description: skill.description,
      mention: { kind: "skill", brainRef: skill.brainRef, id: skill.id },
    });
  }
  return options;
}

function renderComposerInputOverlay(value: string, mentions: GoatChatMention[]) {
  const ranges = mentions
    .flatMap((mention) => {
      const token = goatChatMentionToken(mention);
      const match = new RegExp(`(^|\\s)(${escapeRegExp(token)})(?=\\s|$)`, "i").exec(value);
      if (!match || match.index === undefined) return [];
      const start = match.index + (match[1]?.length ?? 0);
      return [{ start, end: start + (match[2]?.length ?? token.length), kind: mention.kind }];
    })
    .toSorted((left, right) => left.start - right.start);
  if (ranges.length === 0) return value;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(value.slice(cursor, range.start));
    parts.push(
      <span
        key={`${range.start}:${range.end}`}
        data-testid={range.kind === "engine" ? "selected-codex-mention" : "selected-skill-mention"}
        className="rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]"
      >
        {value.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  }
  parts.push(value.slice(cursor));
  return (
    <>
      {/* Keep inline metrics identical to the textarea; paint-only styles preserve caret alignment. */}
      {parts}
    </>
  );
}

function isGoatBrainSkillCatalogItem(value: unknown): value is GoatBrainSkillCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.brainRef === "string" &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.description === "string"
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CodexModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: CodexChatModelId;
  disabled: boolean;
  onChange: (model: CodexChatModelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedModel =
    CODEX_MODELS.find((model) => model.id === value) ??
    CODEX_MODELS.find((model) => model.id === CODEX_CHAT_DEFAULT_MODEL_ID);
  const selectedLabel = selectedModel?.label ?? "Codex model";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Codex model: ${selectedLabel}`}
        title="Codex model"
        disabled={disabled}
        className="flex h-7 max-w-[138px] items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <OpenAIIcon size={12} strokeWidth={1.9} className="shrink-0" />
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={11} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[300px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-0 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <Command className="bg-surface text-ink">
          <CommandList>
            <CommandGroup heading="Codex models">
              {CODEX_MODELS.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label, "Codex", "OpenAI"]}
                  onSelect={() => {
                    onChange(normalizeCodexChatModelId(model.id));
                    setOpen(false);
                  }}
                  title={model.description}
                  className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                >
                  <Check
                    size={13}
                    strokeWidth={2}
                    className={cn(
                      "shrink-0 text-ink",
                      model.id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <OpenAIIcon size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium leading-4">{model.label}</div>
                    <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                      {model.description}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CodexComposerControls({
  model,
  reasoningEffort,
  planModeEnabled,
  planModeAvailable,
  goalModeEnabled,
  goalObjective,
  goalTokenBudget,
  disabled,
  modelDisabled,
  onModelChange,
  onReasoningEffortChange,
  onPlanModeEnabledChange,
  onGoalModeEnabledChange,
  onGoalObjectiveChange,
  onGoalTokenBudgetChange,
}: {
  model: CodexChatModelId | null;
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  planModeAvailable: boolean;
  goalModeEnabled: boolean;
  goalObjective: string;
  goalTokenBudget: string;
  disabled: boolean;
  modelDisabled: boolean;
  onModelChange: (model: CodexChatModelId) => void;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void;
  onPlanModeEnabledChange: (enabled: boolean) => void;
  onGoalModeEnabledChange: (enabled: boolean) => void;
  onGoalObjectiveChange: (objective: string) => void;
  onGoalTokenBudgetChange: (tokenBudget: string) => void;
}) {
  const reasoningLabel = codexReasoningLabel(reasoningEffort);
  return (
    <div className="mb-px flex shrink-0 items-center gap-1 border-l border-border pl-2">
      {model ? (
        <CodexModelPicker value={model} disabled={modelDisabled} onChange={onModelChange} />
      ) : null}
      <button
        type="button"
        aria-label={`Codex reasoning effort: ${reasoningLabel} (click to cycle)`}
        title="Reasoning effort"
        disabled={disabled}
        onClick={() => onReasoningEffortChange(nextCodexReasoningEffort(reasoningEffort))}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ReasoningBars effort={reasoningEffort} size={12} />
        <span className="hidden sm:inline">{reasoningLabel}</span>
      </button>
      {planModeAvailable ? (
        <button
          type="button"
          aria-label="Plan mode"
          aria-pressed={planModeEnabled}
          title="Plan mode for the next message"
          disabled={disabled}
          onClick={() => onPlanModeEnabledChange(!planModeEnabled)}
          className={cn(
            "flex h-7 items-center rounded-lg px-2 text-[12px] font-medium leading-none transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50",
            planModeEnabled
              ? "bg-ink text-canvas hover:bg-ink/90"
              : "text-ink-muted hover:bg-surface-hover hover:text-ink",
          )}
        >
          Plan
        </button>
      ) : null}
      <Popover>
        <PopoverTrigger
          type="button"
          aria-label="Goal mode"
          aria-pressed={goalModeEnabled}
          title="Goal mode for the next message"
          disabled={disabled}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink",
            goalModeEnabled
              ? "bg-ink text-canvas hover:bg-ink/90 data-[popup-open]:bg-ink data-[popup-open]:text-canvas"
              : "text-ink-muted hover:bg-surface-hover hover:text-ink",
          )}
        >
          <Target size={13} strokeWidth={2} className="shrink-0" />
          <span className="hidden sm:inline">Goal</span>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={10}
          className="w-[320px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-3 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
        >
          <div className="flex flex-col gap-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium leading-4 text-ink">Goal mode</span>
              <input
                type="checkbox"
                checked={goalModeEnabled}
                onChange={(event) => onGoalModeEnabledChange(event.target.checked)}
                className="h-4 w-4 accent-ink"
              />
            </label>
            <textarea
              value={goalObjective}
              onChange={(event) => onGoalObjectiveChange(event.target.value)}
              placeholder="Objective"
              maxLength={CODEX_GOAL_OBJECTIVE_MAX_LENGTH}
              disabled={!goalModeEnabled}
              className="min-h-24 resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:bg-surface-subtle disabled:text-ink-subtle"
            />
            <input
              value={goalTokenBudget}
              onChange={(event) => onGoalTokenBudgetChange(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Token budget"
              disabled={!goalModeEnabled}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:bg-surface-subtle disabled:text-ink-subtle"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function codexReasoningLabel(effort: CodexReasoningEffort) {
  return effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function nextCodexReasoningEffort(current: CodexReasoningEffort): CodexReasoningEffort {
  const index = CODEX_REASONING_EFFORTS.indexOf(current);
  return CODEX_REASONING_EFFORTS[(index + 1) % CODEX_REASONING_EFFORTS.length] ?? current;
}

function ReasoningBars({ effort, size = 12 }: { effort: CodexReasoningEffort; size?: number }) {
  const activeBars = CODEX_REASONING_EFFORTS.indexOf(effort) + 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
      aria-hidden="true"
    >
      {[
        { x: 1, height: 4.5 },
        { x: 5, height: 7 },
        { x: 9, height: 9.5 },
        { x: 13, height: 12 },
      ].map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={14 - bar.height}
          width={2}
          height={bar.height}
          rx={1}
          fill="currentColor"
          opacity={index < activeBars ? 1 : 0.28}
        />
      ))}
    </svg>
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
    <div className="flex min-w-0 items-center gap-2 text-ink">
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

// A small ring that fills to the share of the model's context window in use. The
// exact "used / max" figure stays out of the chrome and is surfaced on hover,
// keeping the header quiet — mirrors the web app's meter.
function ChatContextMeter({ used, max }: { used: number; max: number }) {
  const fraction = max > 0 ? Math.min(1, used / max) : 0;
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const detail = `${formatCompactTokens(used)} / ${formatCompactTokens(max)} context · ${Math.round(
    fraction * 100,
  )}%`;
  return (
    <Tooltip>
      <TooltipTrigger
        className="flex shrink-0 items-center rounded-full text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        aria-label={`Context window usage: ${detail}`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            stroke="currentColor"
            className="text-ink/15"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className="text-ink/70 transition-[stroke-dashoffset] duration-500"
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

// Compact token formatter: 980 → "980", 14_200 → "14k", 1_000_000 → "1M".
function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

type CodexRuntimeMeta = {
  kind:
    | "connecting"
    | "queued"
    | "starting"
    | "working"
    | "ready"
    | "asleep"
    | "needs-attention"
    | "stopped";
  label: string;
  dotClass: string;
  textClass: string;
};

function codexRuntimeMeta(runtime: GoatCodexRuntimeView | null): CodexRuntimeMeta {
  if (!runtime) {
    return {
      kind: "connecting",
      label: "Connecting",
      dotClass: "bg-ink/25",
      textClass: "text-ink-subtle",
    };
  }
  if (runtime.status === "queued") {
    return {
      kind: "queued",
      label: "Queued",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "starting") {
    return {
      kind: "starting",
      label: "Starting",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "running") {
    return {
      kind: "working",
      label: "Working",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "failed" || runtime.error) {
    return {
      kind: "needs-attention",
      label: "Needs attention",
      dotClass: "bg-danger",
      textClass: "text-danger",
    };
  }
  if (runtime.status === "idle") {
    return {
      kind: "ready",
      label: "Ready",
      dotClass: "bg-success",
      textClass: "text-success",
    };
  }
  if (runtime.status === "interrupted") {
    return {
      kind: "stopped",
      label: "Stopped",
      dotClass: "bg-ink/30",
      textClass: "text-ink-subtle",
    };
  }
  return {
    kind: "connecting",
    label: "Connecting",
    dotClass: "bg-ink/25",
    textClass: "text-ink-subtle",
  };
}

function CodexSessionStatusIndicator({
  runtime,
  optimisticStatus,
  sandboxStatus,
}: {
  runtime: GoatCodexRuntimeView | null;
  optimisticStatus: "starting" | "running" | null;
  sandboxStatus: GoatCodexSandboxStatus | null;
}) {
  let meta = codexRuntimeMeta(
    optimisticStatus
      ? {
          status: optimisticStatus,
          error: null,
          updatedAt: runtime?.updatedAt ?? "",
        }
      : runtime,
  );
  // A ready session whose sandbox has paused shows as asleep so the green dot never reads as
  // "still running" hours after the last turn. A deleted sandbox stays "Ready": nothing exists
  // anymore and a fresh one starts on the next message.
  if (meta.kind === "ready" && sandboxStatus === "sleeping") {
    meta = {
      kind: "asleep",
      label: "Asleep",
      dotClass: "bg-ink/30",
      textClass: "text-ink-subtle",
    };
  }
  const sandboxDetail =
    sandboxStatus === "sleeping"
      ? " The sandbox is sleeping and will wake automatically on the next message."
      : sandboxStatus === "deleted"
        ? " The previous sandbox expired; a new one will start on the next message."
        : "";
  const title = `Codex is ${meta.label.toLowerCase()}.${sandboxDetail}`;

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-surface-subtle bg-surface px-2.5 py-1 text-[12px] font-medium leading-4 text-ink-muted shadow-[0_1px_3px_rgba(15,15,15,0.04)]"
      title={title}
      aria-label={`Codex status: ${meta.label}`}
    >
      <span className={cn("size-2 rounded-full", meta.dotClass)} aria-hidden="true" />
      <span>{meta.label}</span>
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
      .toSorted((a, b) =>
        compareGoatChatMessageOrder(
          { id: a.id, role: a.role, createdAt: a.created_at },
          { id: b.id, role: b.role, createdAt: b.created_at },
        ),
      )
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
  setSandboxStatus,
  setRuntime,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setSandboxStatus: Dispatch<SetStateAction<GoatCodexSandboxStatus | null>>;
  setRuntime: Dispatch<SetStateAction<GoatCodexRuntimeView | null>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <LiveCodexChatSessionStatusSubscriber
      chatSessionId={chatSessionId}
      setRunning={setRunning}
      setSandboxStatus={setSandboxStatus}
      setRuntime={setRuntime}
    />
  );
}

function LiveCodexChatSessionStatusSubscriber({
  chatSessionId,
  setRunning,
  setSandboxStatus,
  setRuntime,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setSandboxStatus: Dispatch<SetStateAction<GoatCodexSandboxStatus | null>>;
  setRuntime: Dispatch<SetStateAction<GoatCodexRuntimeView | null>>;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) =>
    q.from({ codexChatSession: collections.codexChatSessions }),
  );
  const row =
    ((rows ?? []) as GoatCodexChatSessionRow[]).find(
      (candidate) => candidate.chat_session_id === chatSessionId,
    ) ?? null;
  const status = row?.status ?? null;
  const sandboxId = row?.sandbox_id ?? null;

  useEffect(() => {
    if (isLoading) return;
    setRuntime(
      row
        ? {
            status: row.status,
            error: row.error,
            updatedAt: row.updated_at,
          }
        : null,
    );
    setRunning(status === "queued" || status === "starting" || status === "running");
  }, [isLoading, row, setRunning, setRuntime, status]);

  useEffect(() => {
    if (!status) {
      setSandboxStatus(null);
      return;
    }
    if (!sandboxId) {
      setSandboxStatus(status === "starting" || status === "running" ? "running" : null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    const loadStatus = async () => {
      try {
        const response = await fetch(
          `/api/codex-chat/sessions/${encodeURIComponent(chatSessionId)}/sandbox-status`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { status?: unknown };
        if (!active) return;
        if (body.status === "running" || body.status === "sleeping" || body.status === "deleted") {
          setSandboxStatus(body.status);
        }
      } catch {
        // The session status still tells us when a turn is actively starting/running.
        if (active && (status === "starting" || status === "running")) {
          setSandboxStatus("running");
        }
      }
    };

    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus();
    }, CODEX_SANDBOX_STATUS_POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [chatSessionId, sandboxId, setSandboxStatus, status]);

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
  onArchive,
}: {
  chats: readonly GoatChatSummaryView[];
  onSelect: (chat: GoatChatSummaryView) => void;
  onArchive: (chat: GoatChatSummaryView) => void;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col">
      {chats.map((chat) => {
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
                  <span className="shrink-0 text-[12px] leading-tight text-ink-faint transition-opacity duration-150 group-hover/chat:opacity-0 group-focus-within/chat:opacity-0">
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

function ScheduleRows({ schedules }: { schedules: readonly GoatTaskScheduleView[] }) {
  return schedules.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />);
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

function HomeTaskRows({
  items,
  onArchiveTask,
  onArchiveChat,
  onSelectChat,
}: {
  items: readonly GoatHomeTaskItem[];
  onArchiveTask: (task: GoatTaskView) => void;
  onArchiveChat: (chat: GoatChatSummaryView) => void;
  onSelectChat: (chat: GoatChatSummaryView) => void;
}) {
  return items.map((item) =>
    item.kind === "background" ? (
      <ResultRow key={item.task.id} task={item.task} onArchive={onArchiveTask} />
    ) : (
      <CodexTaskRow
        key={item.chat.id}
        chat={item.chat}
        onArchive={onArchiveChat}
        onSelect={onSelectChat}
      />
    ),
  );
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
    attachments: row.attachments ?? null,
    // attachment_texts is server-only (excluded from the Electric shape).
    attachmentTexts: null,
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

function CodexTaskRow({
  chat,
  onArchive,
  onSelect,
}: {
  chat: GoatChatSummaryView;
  onArchive: (chat: GoatChatSummaryView) => void;
  onSelect: (chat: GoatChatSummaryView) => void;
}) {
  const router = useRouter();
  const meta = codexRuntimeMeta(chat.codexRuntime ?? null);
  const href = chatHref(chat.id);
  const prefetchChat = () => router.prefetch(href);
  const updatedAt = chat.codexRuntime?.updatedAt ?? chat.updatedAt;
  const canArchive = !isCodexTaskActive(chat);
  const errorPreview =
    meta.kind === "needs-attention" ? firstLine(chat.codexRuntime?.error ?? null) : null;

  return (
    <div className="group/task relative flex items-center rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <Link
        href={href}
        prefetch
        onMouseEnter={prefetchChat}
        onFocus={prefetchChat}
        onTouchStart={prefetchChat}
        onClick={() => onSelect(chat)}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span
          role="img"
          aria-label={`Codex task status: ${meta.label}`}
          className={cn("size-2.5 shrink-0 rounded-full", meta.dotClass)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium leading-tight text-ink">
              {chat.title}
            </span>
            <span className="shrink-0 text-[12px] leading-tight text-ink-faint transition-opacity duration-150 group-hover/task:opacity-0 group-focus-within/task:opacity-0">
              {formatRelativeTime(updatedAt)}
            </span>
          </div>
          <p className={cn("truncate text-[12.5px] leading-4", meta.textClass)}>
            Codex · {meta.label}
            {errorPreview ? ` · ${errorPreview}` : ""}
          </p>
        </div>
      </Link>
      {canArchive ? (
        <button
          type="button"
          aria-label={`Archive ${chat.title}`}
          title="Archive"
          onClick={() => onArchive(chat)}
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md bg-surface-hover text-ink-subtle opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-surface-muted hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/task:opacity-100 group-focus-within/task:opacity-100"
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

function EngineStopButton({ label, onStop }: { label: string; onStop: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Interrupt ${label}`}
      title={`Interrupt ${label}`}
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
