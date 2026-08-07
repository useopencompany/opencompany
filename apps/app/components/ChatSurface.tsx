"use client";

import { useChat } from "@ai-sdk/react";
import {
  CLOUD_CODING_ENGINE_CONFIG,
  CODEX_REASONING_EFFORTS,
  claudeCodeModelSupportsReasoningEffort,
} from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import {
  type ChatMention,
  type ChatMessageMetadata,
  type ChatSessionView,
  type ChatSummaryView,
  type ChatUiAttachment,
  type ChatUiMessage,
  type CodexRuntimeView,
  chatSummaryState,
  compareChatMessageOrder,
  isChatRuntimeActive,
  type StoredChatMessage,
  textFromChatUiMessage,
  toChatUiMessage,
} from "@opencompany/core/chat-ui";
import {
  type CodexComposerSettingsView,
  DEFAULT_CODEX_CHAT_REASONING_EFFORT,
} from "@opencompany/core/codex-chat-settings";
import type {
  ChatEngine,
  TaskReportedOutcome,
  TaskStage,
  TaskStatus,
} from "@opencompany/db/schema";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@opencompany/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { AnthropicIcon, DeepSeekIcon, MoonshotIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDotDashed,
  Clock,
  Code2,
  CornerDownLeft,
  FileText,
  LoaderCircle,
  MessageSquare,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  SquarePen,
  Target,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { ChatStateIndicator } from "@/components/ChatStateIndicator";
import {
  CodingWorkspacePanel,
  type CodingWorkspacePanelHandle,
} from "@/components/CodingWorkspacePanel";
import { buildChatTaskLookup } from "@/components/chat/assistant-items";
import {
  ComposerAttachments,
  ComposerDropOverlay,
} from "@/components/chat/ChatComposerAttachments";
import { ChatShareButton } from "@/components/chat/ChatShareButton";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PendingActivityIndicator, ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import type { ActionApprovalRequest, CodexToolAction } from "@/components/chat/ToolCallItem";
import { useChatAttachments } from "@/components/chat/useChatAttachments";
import { useCreditBalance } from "@/components/chat/useCreditBalance";
import { useHydrated } from "@/components/useHydrated";
import {
  AD_HOC_TASK_ID,
  AD_HOC_TASK_TOKEN,
  descriptionFromAdHocTaskPrompt,
  hasAdHocTaskToken,
} from "@/lib/ad-hoc-task";
import {
  closeChatSessionAction,
  markChatSeenAction,
  reopenChatSessionAction,
} from "@/lib/chat-actions";
import { CHAT_ATTACHMENT_ACCEPT } from "@/lib/chat-attachment-formats";
import { AUTO_MODEL_ATTACHMENT_CAPABILITIES, AUTO_MODEL_SELECTION } from "@/lib/chat-auto-model";
import {
  type ChatModelSelection,
  persistLastChatSelection,
  readLastChatSelection,
  subscribeLastChatSelection,
} from "@/lib/chat-composer-selection";
import {
  CHAT_COMPOSER_FOCUS_EVENT,
  consumePendingChatComposerFocus,
  HOME_NAVIGATION_EVENT,
  newOptimisticChatSessionId,
} from "@/lib/chat-navigation";
import {
  clearLocalChatState,
  setLocalChatState,
  useLocalChatStates,
} from "@/lib/chat-session-state";
import { CHAT_OUT_OF_CREDITS_MESSAGE } from "@/lib/chat-validation";
import {
  CLAUDE_CHAT_DEFAULT_MODEL_ID,
  CLAUDE_PICKER_VALUE,
  type ClaudeChatModelId,
  normalizeClaudeChatModelId,
} from "@/lib/claude-chat-constants";
import { DEFAULT_CLAUDE_CHAT_REASONING_EFFORT } from "@/lib/claude-chat-settings";
import {
  CODEX_CHAT_DEFAULT_MODEL_ID,
  CODEX_PICKER_VALUE,
  type CodexChatModelId,
  normalizeCodexChatModelId,
} from "@/lib/codex-chat-constants";
import { isRecentHomeActivity } from "@/lib/home-activity";
import { alwaysAllowChatActionAction } from "@/lib/integration-account-actions";
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  DEFAULT_MODEL,
  MODELS,
  modelContextWindowTokens,
  normalizeModel,
} from "@/lib/model-options";
import { consumeOnboardingKickoffPrompt } from "@/lib/onboarding-kickoff";
import type { SkillCatalogItem } from "@/lib/skills";
import {
  type ChatMessageRow,
  type CodexChatSessionRow,
  createCollections,
  type TaskRow,
} from "@/lib/task-collections";
import { STAGE_COPY, STATUS_COPY } from "@/lib/task-display";
import type { CodexSandboxStatus } from "@/lib/task-runner";
import {
  deleteTaskScheduleAction,
  runTaskScheduleNowAction,
  setTaskScheduleEnabledAction,
  type TaskScheduleView,
  updateTaskScheduleAction,
} from "@/lib/task-schedules";
import { deriveTaskWorkflowSteps, type TaskWorkflowStepView } from "@/lib/task-workflow-activity";
import { archiveTaskAction, cancelTaskAction, continueTaskAction } from "@/lib/tasks";
import { updateTimezoneAction } from "@/lib/user-preferences";
import type { WorkflowCatalogItem } from "@/lib/workflows";

const TEXTAREA_MAX_HEIGHT_PX = 128;
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
const CHAT_THREAD_MIN_BOTTOM_PADDING_PX = 160;
const CHAT_THREAD_COMPOSER_GAP_PX = 20;
const BACKGROUND_CHAT_PROMPT_MAX_LENGTH = 10_000;
const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
const CODEX_GOAL_TOKEN_BUDGET_MAX = 2_000_000;
const CODEX_SANDBOX_STATUS_POLL_INTERVAL_MS = 30_000;
const CODEX_MENTION: ChatMention = { kind: "engine", id: "codex" };
const CLAUDE_MENTION: ChatMention = { kind: "engine", id: "claude" };
const CLOUD_CODEX_ATTACHMENT_CAPABILITIES = { images: true, pdf: true } as const;
const COMPOSER_MENTION_CHIP_CLASS =
  "rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]";

type ActiveMentionToken = {
  start: number;
  end: number;
  query: string;
  // "@" opens engine/skill mentions; "#" opens task/workflow mentions.
  sigil: "@" | "#";
};

type MentionOption =
  | { kind: "engine"; token: "@codex" | "@claude"; label: string; mention: ChatMention }
  | {
      kind: "task";
      token: typeof AD_HOC_TASK_TOKEN;
      label: string;
      description: string;
    }
  | {
      kind: "skill";
      token: string;
      label: string;
      description: string;
      mention: ChatMention;
    }
  | {
      kind: "workflow";
      token: string;
      label: string;
      description: string;
      mention: ChatMention;
    };

// Coding-engine chats bypass useChat entirely: sends go to an engine endpoint,
// streaming arrives as Electric row updates, and stop is an interrupt call.
type EngineChatKind = "codex" | "claude_code";
type CodexComposerSettings = CodexComposerSettingsView;
type EngineComposerSettings = {
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled?: boolean;
  goalMode?: CodexComposerSettings["goalMode"];
};
type CodexComposerUiState = {
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  goalModeEnabled: boolean;
  goalObjective: string;
  goalTokenBudget: string;
};
type ChatComposerDraft = {
  input: string;
  mentions: ChatMention[];
};

function chatThreadBottomPaddingForComposerHeight(composerHeightPx: number) {
  return Math.max(
    CHAT_THREAD_MIN_BOTTOM_PADDING_PX,
    Math.ceil(composerHeightPx) + CHAT_THREAD_COMPOSER_GAP_PX,
  );
}

const ENGINE_CHAT_CONFIG: Record<
  EngineChatKind,
  {
    label: string;
    messagesEndpoint: string;
    interruptEndpoint: (chatSessionId: string) => string;
  }
> = {
  codex: {
    label: CLOUD_CODING_ENGINE_CONFIG.codex.label,
    messagesEndpoint: "/api/codex-chat/messages",
    interruptEndpoint: (chatSessionId) =>
      `/api/codex-chat/sessions/${encodeURIComponent(chatSessionId)}/interrupt`,
  },
  claude_code: {
    label: CLOUD_CODING_ENGINE_CONFIG.claude_code.label,
    messagesEndpoint: "/api/claude-chat/messages",
    // Claude chats share the codex_chat session/turn rows, so the codex interrupt
    // and sandbox-status routes are engine-agnostic.
    interruptEndpoint: (chatSessionId) =>
      `/api/codex-chat/sessions/${encodeURIComponent(chatSessionId)}/interrupt`,
  },
};

function engineChatKindFromChat(
  chat: { engine?: ChatEngine } | null | undefined,
): EngineChatKind | null {
  if (!chat) return null;
  if (chat.engine === "codex") return "codex";
  if (chat.engine === "claude_code") return "claude_code";
  return null;
}

function chatModelSelectionFromEngineMention(
  mention: ChatMention | null | undefined,
): ChatModelSelection | null {
  if (!mention || mention.kind !== "engine") return null;
  if (mention.id === "codex") return CODEX_PICKER_VALUE;
  if (mention.id === "claude") return CLAUDE_PICKER_VALUE;
  return null;
}

function shareSubjectForActiveChat(input: {
  isTask: boolean;
  engine?: ChatEngine | null;
}): "chat" | "task run" | "Codex chat" | "Claude Code chat" {
  if (input.isTask) return "task run";
  if (input.engine === "codex") return "Codex chat";
  if (input.engine === "claude_code") return "Claude Code chat";
  return "chat";
}

// Cloud coding-CLI chats (Codex + Claude Code) share the same home card and status
// indicator; only the display label differs by engine. Defaults to "Codex" so the
// shared surface stays labeled for any non-Claude engine that reaches it.
function codexEngineLabel(engine: ChatEngine | null | undefined): string {
  return engine === "claude_code"
    ? ENGINE_CHAT_CONFIG.claude_code.label
    : ENGINE_CHAT_CONFIG.codex.label;
}

export type TaskView = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
  model: string;
  sessionId?: string | null;
  scheduleId?: string | null;
  scheduledFor?: string | null;
  workflowId?: string | null;
  status: TaskStatus;
  stage: TaskStage;
  result: string | null;
  error: string | null;
  reportedOutcome?: TaskReportedOutcome | null;
  outcomeComment?: string | null;
  workflowSteps?: TaskWorkflowStepView[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskConversation = {
  taskId: string;
  status: TaskStatus;
  startedAtMs: number;
  sessionBacked?: boolean;
};

export function ChatSurface({
  tasks,
  schedules = [],
  defaultModel,
  initialChat,
  recentChats = [],
  archivedChats = [],
  codexConnected = false,
  claudeCodeConnected = false,
  taskSpawningEnabled = false,
  autoModelRoutingEnabled = false,
  chatResumeEnabled = false,
  userName = "there",
  userWorkosId = "",
  taskConversation = null,
}: {
  tasks: readonly TaskView[];
  schedules?: readonly TaskScheduleView[];
  defaultModel: string;
  initialChat: ChatSessionView | null;
  recentChats?: readonly ChatSummaryView[];
  archivedChats?: readonly ChatSummaryView[];
  codexConnected?: boolean;
  claudeCodeConnected?: boolean;
  taskSpawningEnabled?: boolean;
  autoModelRoutingEnabled?: boolean;
  chatResumeEnabled?: boolean;
  userName?: string;
  // Scopes chat attachment uploads; attachments are disabled when absent.
  userWorkosId?: string;
  // Workflow task details reuse this chat surface, while task messages remain
  // backed by the durable task transcript instead of chat session rows.
  taskConversation?: TaskConversation | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputOverlayRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const workspacePanelRef = useRef<CodingWorkspacePanelHandle>(null);
  const workspaceToggleButtonRef = useRef<HTMLButtonElement>(null);
  const lastError = useRef<string | null>(null);
  const isPinnedAtBottomRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const routedChatSessionIdRef = useRef(initialChat?.id ?? null);
  const pendingNewSessionIdRef = useRef<string | null>(null);
  const pendingInputCaretRef = useRef<number | null>(null);
  const pendingProgrammaticPromptRef = useRef<string | null>(null);
  const backgroundTaskFocusOriginRef = useRef<Element | null>(null);
  const onboardingKickoffReadRef = useRef(false);
  const onboardingKickoffPromptRef = useRef<string | null>(null);
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const activeTurnAssistantMessageIdRef = useRef<string | null>(null);
  const activeTurnChatSessionIdRef = useRef<string | null>(initialChat?.id ?? null);
  const lastSeenMarkRef = useRef<string | null>(null);
  const wasAgentWorkingRef = useRef(false);
  const optimisticAttachmentPreviewUrlsRef = useRef<ReadonlyMap<string, string[]>>(new Map());
  const persistedMessageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [workspacePanelExpanded, setWorkspacePanelExpanded] = useState(false);
  const [workspacePanelSessionId, setWorkspacePanelSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [mentionToken, setMentionToken] = useState<ActiveMentionToken | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ChatMention[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);
  const [workflowCatalog, setWorkflowCatalog] = useState<WorkflowCatalogItem[]>([]);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [mode, setMode] = useState<"home" | "chat">(() => (initialChat ? "chat" : "home"));
  const [chatSessionId, setChatSessionId] = useState<string | null>(initialChat?.id ?? null);
  const [persistedChatSessionId, setPersistedChatSessionId] = useState<string | null>(
    initialChat?.id ?? null,
  );
  // Keyed useChat instance: changes only when the user opens a different chat,
  // NOT when a new session gets its server id mid-turn (that would discard the
  // in-flight stream state).
  const [chatInstanceKey, setChatInstanceKey] = useState(() => initialChat?.id ?? "goat-chat-main");
  // Persisted messages for the active session, synced live from Electric.
  const [liveChat, setLiveChat] = useState<{
    sessionId: string;
    messages: ChatUiMessage[];
  } | null>(null);
  const rememberedChatModel = useSyncExternalStore(
    subscribeLastChatSelection,
    () =>
      readLastChatSelection(userWorkosId, {
        codexConnected,
        claudeCodeConnected,
        autoModelRoutingEnabled,
      }),
    () => normalizeModel(defaultModel),
  );
  const [chatModelOverride, setChatModelOverride] = useState<ChatModelSelection | null>(() => {
    if (!initialChat) return null;
    const engine = engineChatKindFromChat(initialChat);
    if (engine === "codex") return CODEX_PICKER_VALUE;
    if (engine === "claude_code") return CLAUDE_PICKER_VALUE;
    return normalizeModel(initialChat.model);
  });
  // The remembered selection is a Home default. Opening or reserving a session sets the override
  // so cross-tab preference updates apply only to the next chat.
  const baseChatModel = chatModelOverride ?? rememberedChatModel;
  const initialCodexComposerUiState = initialChat
    ? codexComposerUiStateForChat(initialChat)
    : defaultCodexComposerUiState(
        baseChatModel === CLAUDE_PICKER_VALUE
          ? DEFAULT_CLAUDE_CHAT_REASONING_EFFORT
          : DEFAULT_CODEX_CHAT_REASONING_EFFORT,
      );
  const [codexModel, setCodexModel] = useState<CodexChatModelId>(() =>
    normalizeCodexChatModelId(initialChat?.model),
  );
  const [claudeModel, setClaudeModel] = useState<ClaudeChatModelId>(() =>
    normalizeClaudeChatModelId(initialChat?.model),
  );
  const [engineChatSession, setEngineChatSession] = useState<{
    engine: EngineChatKind;
    chatSessionId: string;
  } | null>(() => {
    const engine = engineChatKindFromChat(initialChat);
    return engine && initialChat ? { engine, chatSessionId: initialChat.id } : null;
  });
  const [codexComposerStateByChatId, setCodexComposerStateByChatId] = useState<
    ReadonlyMap<string, CodexComposerUiState>
  >(() => {
    if (!initialChat || !initialChat.codexComposerSettings) return new Map();
    return new Map([[initialChat.id, initialCodexComposerUiState]]);
  });
  const [composerDraftsByChatId, setComposerDraftsByChatId] = useState<
    ReadonlyMap<string, ChatComposerDraft>
  >(() => new Map());
  const [chatThreadBottomPaddingPx, setChatThreadBottomPaddingPx] = useState(
    CHAT_THREAD_MIN_BOTTOM_PADDING_PX,
  );
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
  const [codexSandboxStatus, setCodexSandboxStatus] = useState<CodexSandboxStatus | null>(null);
  const [codexRuntime, setCodexRuntime] = useState<CodexRuntimeView | null>(
    initialChat?.codexRuntime ?? null,
  );
  const [engineRunning, setEngineRunning] = useState(() =>
    isCodexRuntimeActive(initialChat?.codexRuntime),
  );
  const [engineSubmitting, setEngineSubmitting] = useState(false);
  const [backgroundTaskSubmitting, setBackgroundTaskSubmitting] = useState(false);
  const [taskMessageSubmitting, setTaskMessageSubmitting] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [newChatCommandOpen, setNewChatCommandOpen] = useState(false);
  const [commandPaletteView, setCommandPaletteView] = useState<"search" | "compose">("search");
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [restoringChatId, setRestoringChatId] = useState<string | null>(null);
  const [locallyStoppedAssistantMessageIds, setLocallyStoppedAssistantMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [optimisticallyArchivedIds, setOptimisticallyArchivedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [optimisticallyArchivedChatIds, setOptimisticallyArchivedChatIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [liveChatTasks, setLiveChatTasks] = useState<readonly TaskView[] | null>(null);
  const [activeTurnStartedAtMs, setActiveTurnStartedAtMs] = useState<number | null>(null);
  const [optimisticTurnDurations, setOptimisticTurnDurations] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [, startArchiveTransition] = useTransition();
  const localChatStates = useLocalChatStates();
  const homeChats = useMemo(
    () => visibleHomeChats(recentChats, optimisticallyArchivedChatIds, localChatStates),
    [localChatStates, optimisticallyArchivedChatIds, recentChats],
  );
  const homeSchedules = useMemo(
    () => (taskSpawningEnabled ? visibleHomeSchedules(schedules) : []),
    [schedules, taskSpawningEnabled],
  );
  const homeTasks = useMemo(
    () =>
      visibleHomeTasks({
        tasks: taskSpawningEnabled ? tasks : [],
        optimisticallyArchivedTaskIds: optimisticallyArchivedIds,
      }),
    [optimisticallyArchivedIds, taskSpawningEnabled, tasks],
  );
  const hasHomeActivity = homeTasks.length > 0 || homeChats.length > 0 || homeSchedules.length > 0;
  const homeGreetingName = userName.trim() || "there";
  const activeTaskConversation =
    taskConversation && initialChat?.id === chatSessionId ? taskConversation : null;
  const backgroundInputDirective = parseBackgroundChatDirective(input);
  const backgroundDirectiveActive = Boolean(backgroundInputDirective);
  const workflowMentionsEnabled =
    taskSpawningEnabled && (!activeTaskConversation || backgroundDirectiveActive);
  const skillMentionsEnabled =
    !activeTaskConversation || activeTaskConversation.sessionBacked || backgroundDirectiveActive;
  const activeSelectedMentions = selectedMentions.filter((mention) => {
    if (!chatMentionIsVisible(input, mention)) return false;
    if (mention.kind === "engine") {
      return mention.id === "claude" ? claudeCodeConnected : codexConnected;
    }
    if (mention.kind === "workflow") return workflowMentionsEnabled;
    return skillMentionsEnabled;
  });
  const chatModel =
    chatModelSelectionFromEngineMention(
      activeSelectedMentions.find((mention) => mention.kind === "engine"),
    ) ?? baseChatModel;
  const isAutoChatModel = chatModel === AUTO_MODEL_SELECTION;
  const activeTaskId = activeTaskConversation?.taskId ?? null;
  const activeTaskStatus = activeTaskConversation?.status ?? null;
  const isTaskConversationStopping = Boolean(
    activeTaskId &&
      stoppingTaskId === activeTaskId &&
      (activeTaskStatus === "queued" || activeTaskStatus === "running"),
  );

  if (
    stoppingTaskId &&
    (taskConversation?.taskId !== stoppingTaskId ||
      (taskConversation.status !== "queued" && taskConversation.status !== "running"))
  ) {
    setStoppingTaskId(null);
  }

  const beginActiveTurn = useCallback((assistantMessageId: string | null = null) => {
    const startedAtMs = Date.now();
    const sessionId = routedChatSessionIdRef.current;
    activeTurnStartedAtRef.current = startedAtMs;
    activeTurnAssistantMessageIdRef.current = assistantMessageId;
    activeTurnChatSessionIdRef.current = sessionId;
    if (sessionId) setLocalChatState(sessionId, "working");
    setActiveTurnStartedAtMs(startedAtMs);
  }, []);

  const clearLocalActiveTurnState = useCallback((sessionId: string | null | undefined) => {
    clearLocalChatState(sessionId ?? activeTurnChatSessionIdRef.current, "working");
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

  const adoptResolvedAutoModel = useCallback(
    (message: ChatUiMessage) => {
      if (!isAutoChatModel) return;
      const metadata = message.metadata;
      if (
        !metadata?.model ||
        !metadata.sessionId ||
        metadata.sessionId !== routedChatSessionIdRef.current
      ) {
        return;
      }
      setChatModelOverride(normalizeModel(metadata.model));
    },
    [isAutoChatModel, setChatModelOverride],
  );

  const trackOptimisticAttachmentPreviews = useCallback(
    (messageId: string, attachments: readonly ChatUiAttachment[]) => {
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
      messages: ChatUiMessage[];
    }) => {
      const message = messages.at(-1);
      const mentions = mentionsFromMessageMetadata(message?.metadata);
      // Approval continuations are auto-resent without a custom body; the
      // assistant message's own metadata carries the session id then.
      const requestSessionId =
        typeof body?.sessionId === "string"
          ? body.sessionId
          : message?.role === "assistant"
            ? (message.metadata?.sessionId ?? null)
            : null;
      const requestNewSessionId =
        typeof body?.newSessionId === "string" ? body.newSessionId : undefined;
      const requestModel = typeof body?.model === "string" ? body.model : undefined;
      return {
        body: {
          sessionId: requestSessionId,
          ...(requestNewSessionId ? { newSessionId: requestNewSessionId } : {}),
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
      new DefaultChatTransport<ChatUiMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest,
      }),
    [prepareSendMessagesRequest],
  );
  const { balance: creditBalance, refetch: refetchCreditBalance } = useCreditBalance();
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error: chatError,
    clearError,
    addToolApprovalResponse,
  } = useChat<ChatUiMessage>({
    id: chatInstanceKey,
    // useChat holds only this surface's in-flight overlay; persisted history
    // comes from the Electric-synced liveChat state and is merged below.
    resume:
      chatResumeEnabled &&
      !taskConversation &&
      Boolean(initialChat) &&
      (initialChat?.engine ?? "opencompany") === "opencompany",
    // Batch stream chunks into ~20fps UI updates instead of rendering the
    // whole thread on every token.
    experimental_throttle: 50,
    transport,
    // Once every pending tool approval on the last assistant message has a
    // decision, auto-resend it so the server executes the approved calls and
    // the model continues the turn.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ message }) => {
      const sessionId = message.metadata?.sessionId;
      clearLocalActiveTurnState(sessionId);
      if (!mountedRef.current) return;
      void refetchCreditBalance();
      recordOptimisticTurnDuration(message.id);
      const pendingNewSessionId = pendingNewSessionIdRef.current;
      const ownsRoute = Boolean(sessionId && routedChatSessionIdRef.current === sessionId);
      if (sessionId && ownsRoute) {
        setChatSessionId(sessionId);
        setPersistedChatSessionId(sessionId);
        if (pendingNewSessionId === sessionId) {
          pendingNewSessionIdRef.current = null;
        }
      }
      adoptResolvedAutoModel(message);
    },
    onError: (error) => {
      clearLocalActiveTurnState(null);
      if (error.message?.includes(CHAT_OUT_OF_CREDITS_MESSAGE)) {
        void refetchCreditBalance();
        toast.error(CHAT_OUT_OF_CREDITS_MESSAGE, {
          action: {
            label: "Add credits",
            onClick: () => router.push("/settings/workspace/billing"),
          },
        });
        return;
      }
      toast.error(error.message || "opencompany could not answer that right now.");
    },
  });
  const isGenerating = status === "submitted" || status === "streaming";
  const activeInitialChatEngine =
    initialChat && mode === "chat" && chatSessionId === initialChat.id
      ? engineChatKindFromChat(initialChat)
      : null;
  const activeEngineChat = useMemo(() => {
    if (!chatSessionId) return null;
    if (activeInitialChatEngine) return { engine: activeInitialChatEngine, chatSessionId };
    return engineChatSession?.chatSessionId === chatSessionId ? engineChatSession : null;
  }, [activeInitialChatEngine, chatSessionId, engineChatSession]);
  // The workspace panel remounts (via its `key`) on every session switch, so its own
  // expanded state always resets — mirror that here during render so the header
  // toggle icon never flashes "collapse" for a session that just mounted collapsed.
  if (workspacePanelSessionId !== (activeEngineChat?.chatSessionId ?? null)) {
    setWorkspacePanelSessionId(activeEngineChat?.chatSessionId ?? null);
    setWorkspacePanelExpanded(false);
  }
  const isCodexMode = chatModel === CODEX_PICKER_VALUE;
  const isClaudeMode = chatModel === CLAUDE_PICKER_VALUE;
  const selectedEngine: EngineChatKind | null = isCodexMode
    ? "codex"
    : isClaudeMode
      ? "claude_code"
      : null;
  const activeEngine = activeEngineChat?.engine ?? selectedEngine;
  const isEngineChat = activeEngine !== null;
  // Hard stop: with enforcement on and an empty balance, block new sends
  // before they 402. Codex-engine chats stay exempt, matching the server gate.
  const outOfCredits = Boolean(
    creditBalance && creditBalance.enforcementEnabled && creditBalance.balanceUsdMicros <= 0,
  );
  const backgroundChatDirective = backgroundInputDirective;
  const backgroundDirectiveTargetEngine = backgroundChatDirective
    ? (backgroundChatDirective.engine ?? activeEngine)
    : null;
  const composerEngine = backgroundDirectiveTargetEngine ?? activeEngine;
  const chatSendBlocked = outOfCredits && !composerEngine;
  const lowCreditBalance = Boolean(
    creditBalance &&
      creditBalance.balanceUsdMicros > 0 &&
      creditBalance.balanceUsdMicros < creditBalance.lowBalanceWarnUsdMicros,
  );
  const adHocTaskMentionEnabled = taskSpawningEnabled && !activeEngine && !activeTaskConversation;
  const backgroundAdHocTaskSelected = Boolean(
    backgroundChatDirective &&
      taskSpawningEnabled &&
      hasAdHocTaskToken(backgroundChatDirective.prompt),
  );
  const selectedAdHocTask =
    backgroundAdHocTaskSelected ||
    (!backgroundChatDirective && adHocTaskMentionEnabled && hasAdHocTaskToken(input));
  const mentionOptions = buildMentionOptions({
    token: mentionToken,
    skills: skillCatalog,
    workflows: workflowCatalog,
    selectedMentions: activeSelectedMentions,
    codexConnected,
    claudeCodeConnected,
    skillsEnabled: skillMentionsEnabled,
    workflowsEnabled: workflowMentionsEnabled,
    adHocTaskEnabled: adHocTaskMentionEnabled || Boolean(backgroundChatDirective),
  });
  const selectedWorkflowMention = selectedAdHocTask
    ? null
    : (activeSelectedMentions.find(isWorkflowMention) ?? null);
  const selectedWorkflowName = selectedWorkflowMention
    ? (workflowCatalog.find((workflow) => workflow.id === selectedWorkflowMention.id)?.name ??
      selectedWorkflowMention.id)
    : null;
  const attachmentsEnabled = Boolean(userWorkosId) && !activeTaskConversation;
  const composerAttachments = useChatAttachments({
    userWorkosId,
    modelName: String(chatModel),
    // The Cmd+K compose view mounts a second composer with its own window-level drop
    // listener. Keep the main composer visible behind the modal, but let only the quick
    // composer consume dropped files while that view is showing.
    enabled:
      attachmentsEnabled &&
      !engineSubmitting &&
      !(newChatCommandOpen && commandPaletteView === "compose"),
    ...(composerEngine === "codex" || composerEngine === "claude_code"
      ? { capabilities: CLOUD_CODEX_ATTACHMENT_CAPABILITIES }
      : isAutoChatModel
        ? { capabilities: AUTO_MODEL_ATTACHMENT_CAPABILITIES }
        : {}),
  });
  const applyDictatedInput = useCallback(
    (nextInput: string) => {
      setInput(nextInput);
      setMentionToken(null);
      setSelectedMentions((current) =>
        current.filter((mention) => chatMentionIsVisible(nextInput, mention)),
      );
    },
    [setSelectedMentions],
  );
  const voiceDictation = useComposerVoiceDictation({
    input,
    inputRef,
    onInputChange: applyDictatedInput,
  });
  const clearComposerAttachments = composerAttachments.clearAttachments;

  // Refetch the skill catalog on every mention-menu open (not once per mount): skills
  // created or edited since the last open must appear, and a transient fetch failure
  // must not blank the menu for the rest of the session — keep the previous catalog
  // and let the next open retry.
  const skillMentionMenuOpen = Boolean(userWorkosId && mentionToken && skillMentionsEnabled);
  useEffect(() => {
    if (!skillMentionMenuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchBrainSkillCatalog(controller.signal)
        .then(setSkillCatalog)
        .catch(() => {});
      if (workflowMentionsEnabled) {
        void fetchBrainWorkflowCatalog(controller.signal)
          .then(setWorkflowCatalog)
          .catch(() => {});
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skillMentionMenuOpen, workflowMentionsEnabled]);

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
    // An approval continuation streams into an assistant id that is already
    // persisted (the paused turn wrote it); while streaming, the overlay copy
    // is fresher than the Electric row, so it replaces in place.
    const streaming = status === "submitted" || status === "streaming";
    const base = streaming
      ? (() => {
          const overlayById = new Map(messages.map((message) => [message.id, message]));
          return persistedMessages.map((message) => overlayById.get(message.id) ?? message);
        })()
      : persistedMessages;
    return overlay.length > 0 ? [...base, ...overlay] : base;
  }, [messages, persistedMessages, status]);
  useEffect(() => {
    if (!isAutoChatModel) return;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      adoptResolvedAutoModel(message);
      break;
    }
  }, [adoptResolvedAutoModel, isAutoChatModel, messages]);
  const latestAssistantMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      if (chatMessages[index]?.role === "assistant") return chatMessages[index]?.id ?? null;
    }
    return null;
  }, [chatMessages]);
  const hasMessages = chatMessages.length > 0;
  const isEngineWorking = isEngineChat && (engineRunning || engineSubmitting);
  const isTaskConversationWorking = Boolean(
    activeTaskConversation &&
      !isTaskConversationStopping &&
      (activeTaskConversation.status === "queued" ||
        activeTaskConversation.status === "running" ||
        taskMessageSubmitting),
  );
  const isAgentWorking = isGenerating || isEngineWorking || isTaskConversationWorking;
  const isInteractionPending = isAgentWorking || isTaskConversationStopping;
  const isBackgroundSubmit = backgroundDirectiveActive || Boolean(selectedWorkflowMention);
  const latestActiveTurnStartedAtMs = useMemo(
    () => latestChatTurnStartedAtMs(chatMessages),
    [chatMessages],
  );
  const activeTurnTimerStartedAtMs =
    activeTurnStartedAtMs ??
    latestActiveTurnStartedAtMs ??
    activeTaskConversation?.startedAtMs ??
    null;
  const paletteRecentChats = useMemo(
    () => recentChats.filter((chat) => !optimisticallyArchivedChatIds.has(chat.id)),
    [optimisticallyArchivedChatIds, recentChats],
  );
  const showEngineComposerControls = composerEngine !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseAllOptimisticAttachmentPreviews();
    };
  }, [releaseAllOptimisticAttachmentPreviews]);

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
  useEffect(() => {
    if (!chatSessionId || persistedChatSessionId !== chatSessionId) return;
    const state = isAgentWorking ? "working" : mode === "chat" ? "done_seen" : null;
    setLocalChatState(chatSessionId, state);
    return () => {
      if (state !== "working") setLocalChatState(chatSessionId, null);
    };
  }, [chatSessionId, isAgentWorking, mode, persistedChatSessionId]);

  useEffect(() => {
    if (mode !== "chat" || !chatSessionId || persistedChatSessionId !== chatSessionId) {
      return;
    }
    if (isAgentWorking) {
      lastSeenMarkRef.current = null;
      return;
    }

    const markKey = [
      chatSessionId,
      activeChatSummary?.updatedAt ?? "no-summary-update",
      latestAssistantMessageId ?? "no-assistant-message",
      chatMessages.length,
    ].join(":");
    if (lastSeenMarkRef.current === markKey) return;
    lastSeenMarkRef.current = markKey;
    void markChatSeenAction(chatSessionId).catch(() => undefined);
  }, [
    activeChatSummary?.updatedAt,
    chatMessages.length,
    chatSessionId,
    isAgentWorking,
    latestAssistantMessageId,
    mode,
    persistedChatSessionId,
  ]);
  const activeChatTitle =
    activeChatSummary?.title ??
    (initialChat?.id === chatSessionId ? initialChat.title : null) ??
    titleFromChatMessages(chatMessages) ??
    "Chat";
  const activeChatModel =
    activeChatSummary?.model ??
    (initialChat?.id === chatSessionId ? initialChat.model : null) ??
    (isEngineChat ? DEFAULT_MODEL : chatModel);
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
  const contextMaxTokens = modelContextWindowTokens(activeChatModel);

  const applyCodexComposerUiState = useCallback(
    (state: CodexComposerUiState) => {
      setCodexReasoningEffort(state.reasoningEffort);
      setCodexPlanModeEnabled(state.planModeEnabled);
      setCodexGoalModeEnabled(state.goalModeEnabled);
      setCodexGoalObjective(state.goalObjective);
      setCodexGoalTokenBudget(state.goalTokenBudget);
    },
    [
      setCodexGoalModeEnabled,
      setCodexGoalObjective,
      setCodexGoalTokenBudget,
      setCodexPlanModeEnabled,
      setCodexReasoningEffort,
    ],
  );

  const saveComposerDraft = useCallback((sessionId: string | null, draft: ChatComposerDraft) => {
    if (!sessionId) return;
    const visibleMentions = draft.mentions.filter((mention) =>
      chatMentionIsVisible(draft.input, mention),
    );
    setComposerDraftsByChatId((current) => {
      const next = new Map(current);
      if (draft.input.length > 0) {
        next.set(sessionId, { input: draft.input, mentions: visibleMentions });
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }, []);

  const clearComposerDraft = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    setComposerDraftsByChatId((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const openChat = useCallback(
    (
      chat: {
        id: string;
        model: string;
        engine?: ChatEngine;
        codexComposerSettings?: CodexComposerSettings | null;
        codexRuntime?: CodexRuntimeView | null;
      } | null,
    ) => {
      if (chatSessionId && isEngineChat) {
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

      const engineTarget = engineChatKindFromChat(chat);
      const nextCodexComposerState = codexComposerUiStateForChat(chat, codexComposerStateByChatId);
      saveComposerDraft(chatSessionId, { input, mentions: selectedMentions });
      const nextDraft = chat ? (composerDraftsByChatId.get(chat.id) ?? null) : null;
      releaseAllOptimisticAttachmentPreviews();
      routedChatSessionIdRef.current = chat?.id ?? null;
      pendingNewSessionIdRef.current = null;
      setChatSessionId(chat?.id ?? null);
      setPersistedChatSessionId(chat?.id ?? null);
      setChatInstanceKey(chat?.id ?? `goat-chat-main-${crypto.randomUUID()}`);
      setChatModelOverride(
        engineTarget === "codex"
          ? CODEX_PICKER_VALUE
          : engineTarget === "claude_code"
            ? CLAUDE_PICKER_VALUE
            : chat
              ? normalizeModel(chat.model)
              : null,
      );
      setCodexModel(normalizeCodexChatModelId(chat?.model));
      setClaudeModel(normalizeClaudeChatModelId(chat?.model));
      setEngineChatSession(
        chat && engineTarget ? { engine: engineTarget, chatSessionId: chat.id } : null,
      );
      applyCodexComposerUiState(nextCodexComposerState);
      setCodexSandboxStatus(null);
      setCodexRuntime(
        engineTarget === "codex" || engineTarget === "claude_code"
          ? (chat?.codexRuntime ?? null)
          : null,
      );
      setEngineRunning(isCodexRuntimeActive(chat?.codexRuntime));
      clearActiveTurn();
      setOptimisticTurnDurations(new Map());
      setMessages([]);
      setLocallyStoppedAssistantMessageIds(new Set());
      setInput(nextDraft?.input ?? "");
      setMentionToken(null);
      setSelectedMentions(nextDraft?.mentions ?? []);
      clearError();
      setMode(chat ? "chat" : "home");
      if (chat && consumePendingChatComposerFocus(chat.id)) {
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      }
    },
    [
      applyCodexComposerUiState,
      chatSessionId,
      clearActiveTurn,
      clearError,
      composerDraftsByChatId,
      codexComposerStateByChatId,
      codexGoalModeEnabled,
      codexGoalObjective,
      codexGoalTokenBudget,
      codexPlanModeEnabled,
      codexReasoningEffort,
      input,
      isEngineChat,
      releaseAllOptimisticAttachmentPreviews,
      saveComposerDraft,
      setChatModelOverride,
      setClaudeModel,
      setCodexModel,
      setMessages,
      setSelectedMentions,
      selectedMentions,
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

  useEffect(() => {
    const handleHomeNavigation = () => {
      openChat(null);
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      clearComposerAttachments();
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener(HOME_NAVIGATION_EVENT, handleHomeNavigation);
    return () => window.removeEventListener(HOME_NAVIGATION_EVENT, handleHomeNavigation);
  }, [clearComposerAttachments, openChat]);

  useEffect(() => {
    const handleChatComposerFocusRequest = (event: Event) => {
      const sessionId =
        event instanceof CustomEvent && typeof event.detail?.sessionId === "string"
          ? event.detail.sessionId
          : null;
      if (!sessionId || sessionId !== routedChatSessionIdRef.current) return;
      consumePendingChatComposerFocus(sessionId);
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener(CHAT_COMPOSER_FOCUS_EVENT, handleChatComposerFocusRequest);
    return () =>
      window.removeEventListener(CHAT_COMPOSER_FOCUS_EVENT, handleChatComposerFocusRequest);
  }, []);

  useLayoutEffect(() => {
    if (mode !== "chat" || !chatSessionId) return;
    if (!consumePendingChatComposerFocus(chatSessionId)) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [chatSessionId, mode]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      if (inputOverlayRef.current) inputOverlayRef.current.scrollTop = 0;
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    if (inputOverlayRef.current) inputOverlayRef.current.scrollTop = el.scrollTop;
  }, [input]);

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const updateBottomPadding = () => {
      setChatThreadBottomPaddingPx(
        chatThreadBottomPaddingForComposerHeight(form.getBoundingClientRect().height),
      );
    };

    updateBottomPadding();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateBottomPadding);
      return () => window.removeEventListener("resize", updateBottomPadding);
    }

    const observer = new ResizeObserver(updateBottomPadding);
    observer.observe(form);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const caret = pendingInputCaretRef.current;
    if (caret === null) return;
    pendingInputCaretRef.current = null;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(caret, caret);
  }, [input]);

  useLayoutEffect(() => {
    if (mode !== "home" || pathname !== "/") return;
    inputRef.current?.focus({ preventScroll: true });
  }, [mode, pathname]);

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

  useLayoutEffect(() => {
    if (mode !== "chat" || !isPinnedAtBottomRef.current) return;
    const thread = threadRef.current;
    if (!thread || typeof thread.scrollTo !== "function") return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "auto" });
  }, [chatThreadBottomPaddingPx, mode]);

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
    void updateTimezoneAction(timezone).catch(() => undefined);
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

  const archiveTask = (task: TaskView) => {
    setOptimisticallyArchivedIds((current) => new Set(current).add(task.id));
    startArchiveTransition(async () => {
      const result = await archiveTaskAction(task.id);
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

  const archiveChat = (chat: ChatSummaryView) => {
    setOptimisticallyArchivedChatIds((current) => new Set(current).add(chat.id));
    startArchiveTransition(async () => {
      const result = await closeChatSessionAction(chat.id);
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

  const closeCommandPalette = useCallback(() => {
    setNewChatCommandOpen(false);
    setChatSearchQuery("");
    setCommandPaletteView("search");
  }, []);

  const openCommandPaletteCompose = useCallback(() => {
    setCommandPaletteView("compose");
  }, []);

  const backToCommandPaletteSearch = useCallback(() => {
    setCommandPaletteView("search");
  }, []);

  const prepareMainComposerFocusRestoreAfterBackgroundTask = () => {
    const activeElement = document.activeElement;
    backgroundTaskFocusOriginRef.current =
      activeElement &&
      (activeElement === inputRef.current || Boolean(formRef.current?.contains(activeElement)))
        ? activeElement
        : null;
  };

  const refocusMainComposerAfterBackgroundTask = () => {
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      const focusOrigin = backgroundTaskFocusOriginRef.current;
      backgroundTaskFocusOriginRef.current = null;
      if (!focusOrigin) return;
      const activeElement = document.activeElement;
      if (
        activeElement &&
        activeElement !== document.body &&
        activeElement !== focusOrigin &&
        activeElement !== inputRef.current
      ) {
        return;
      }
      inputRef.current?.focus({ preventScroll: true });
    });
  };

  const jumpToChat = useCallback(
    (chat: ChatSummaryView) => {
      closeCommandPalette();
      router.push(chatHref(chat.id));
    },
    [closeCommandPalette, router],
  );

  const restoreAndOpenChat = useCallback(
    (chat: ChatSummaryView) => {
      if (restoringChatId) return;
      setRestoringChatId(chat.id);
      closeCommandPalette();
      startArchiveTransition(async () => {
        // The chat route only serves open sessions, so the archived chat must be
        // reopened before we navigate — otherwise the page would render empty.
        const result = await reopenChatSessionAction(chat.id);
        if (result.ok) {
          router.push(chatHref(chat.id));
          router.refresh();
          setRestoringChatId(null);
          return;
        }
        setRestoringChatId(null);
        toast.error(result.error ?? "Could not restore that chat.");
      });
    },
    [closeCommandPalette, restoringChatId, router, startArchiveTransition],
  );

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = (pendingProgrammaticPromptRef.current ?? input).trim();
    pendingProgrammaticPromptRef.current = null;
    const backgroundChat = parseBackgroundChatDirective(prompt);
    const backgroundEngine = backgroundChat ? (backgroundChat.engine ?? activeEngine) : null;
    if ((isInteractionPending && !isBackgroundSubmit) || backgroundTaskSubmitting) return;
    if (outOfCredits && !(backgroundEngine ?? activeEngine)) {
      toast.error(CHAT_OUT_OF_CREDITS_MESSAGE, {
        action: {
          label: "Add credits",
          onClick: () => router.push("/settings/workspace/billing"),
        },
      });
      return;
    }

    const pendingAttachments = composerAttachments.attachments;
    const readyAttachments = pendingAttachments.filter(
      (attachment) => attachment.status === "ready",
    );
    if (!prompt && readyAttachments.length === 0) return;
    if (composerAttachments.isUploading) {
      toast.error("Wait for attachments to finish uploading.");
      return;
    }
    if (composerAttachments.hasFailed) {
      toast.error("Remove failed attachments before sending.");
      return;
    }

    if (activeTaskConversation && !backgroundChat) {
      const taskSkillMentions = activeSelectedMentions
        .filter(isSkillMention)
        .filter((mention) => chatMentionIsVisible(prompt, mention));
      const messageId = activeTaskConversation.sessionBacked
        ? `goat_chat_msg_${crypto.randomUUID()}`
        : `goat_task_msg_${crypto.randomUUID()}`;
      const optimisticMessage = {
        id: messageId,
        role: "user",
        ...(taskSkillMentions.length > 0
          ? { metadata: { mentions: taskSkillMentions } satisfies ChatMessageMetadata }
          : {}),
        parts: [{ type: "text", text: prompt }],
      } as ChatUiMessage;

      clearComposerDraft(chatSessionId);
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      setTaskMessageSubmitting(true);
      beginActiveTurn();
      setMessages((current) => [...current, optimisticMessage]);
      const continueTask =
        taskSkillMentions.length > 0
          ? continueTaskAction(activeTaskConversation.taskId, prompt, messageId, taskSkillMentions)
          : continueTaskAction(activeTaskConversation.taskId, prompt, messageId);
      void continueTask
        .then((result) => {
          if (!mountedRef.current) return;
          if (!result.ok) {
            setMessages((current) => current.filter((message) => message.id !== messageId));
            setInput(prompt);
            setSelectedMentions(taskSkillMentions);
            clearLocalActiveTurnState(null);
            clearActiveTurn();
            toast.error(result.error ?? "Could not continue that task.");
            return;
          }
          router.refresh();
        })
        .catch(() => {
          if (!mountedRef.current) return;
          setMessages((current) => current.filter((message) => message.id !== messageId));
          setInput(prompt);
          setSelectedMentions(taskSkillMentions);
          clearLocalActiveTurnState(null);
          clearActiveTurn();
          toast.error("Could not continue that task.");
        })
        .finally(() => {
          if (mountedRef.current) setTaskMessageSubmitting(false);
        });
      return;
    }

    const messagePrompt = backgroundChat?.prompt ?? prompt;
    if (!messagePrompt && readyAttachments.length === 0) return;

    const mentions = activeSelectedMentions.filter((mention) =>
      chatMentionIsVisible(messagePrompt, mention),
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

    if (backgroundChat) {
      if (messagePrompt.length > BACKGROUND_CHAT_PROMPT_MAX_LENGTH) {
        toast.error(
          `Messages can be at most ${BACKGROUND_CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
        );
        return;
      }

      const backgroundMentions = mentions.filter((mention) => !isWorkflowMention(mention));
      const metadata: ChatMessageMetadata = {
        ...(backgroundMentions.length > 0 ? { mentions: backgroundMentions } : {}),
        ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
      };
      const restoreDraft = () => {
        setInput(prompt);
        setSelectedMentions(mentions);
        composerAttachments.setAttachments(pendingAttachments);
      };

      if (taskSpawningEnabled && hasAdHocTaskToken(messagePrompt)) {
        const description = descriptionFromAdHocTaskPrompt(messagePrompt);
        if (!description) {
          toast.error(`Describe the task after ${AD_HOC_TASK_TOKEN}.`);
          return;
        }
        if (pendingAttachments.length > 0) {
          toast.error("Attachments are not supported when starting a background task yet.");
          return;
        }

        clearError();
        setInput("");
        setMentionToken(null);
        setSelectedMentions([]);
        prepareMainComposerFocusRestoreAfterBackgroundTask();
        setBackgroundTaskSubmitting(true);
        void startAdHocTask({
          description: messagePrompt,
          model: String(chatModel),
          ...(backgroundEngine === "codex" ||
          mentions.some((mention) => mention.kind === "engine" && mention.id === "codex")
            ? { engine: "codex" }
            : {}),
        })
          .then(({ task }) => {
            if (!mountedRef.current) return;
            router.refresh();
            toast.success(`Started ${task.name} in the background.`);
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            restoreDraft();
            toast.error(
              error instanceof Error ? error.message : "Could not start that background task.",
            );
          })
          .finally(() => {
            if (!mountedRef.current) return;
            setBackgroundTaskSubmitting(false);
            refocusMainComposerAfterBackgroundTask();
          });
        return;
      }

      const workflowMention = mentions.find(isWorkflowMention);
      if (workflowMention) {
        const skillMentions = backgroundMentions.filter(isSkillMention);
        clearError();
        setInput("");
        setMentionToken(null);
        setSelectedMentions([]);
        prepareMainComposerFocusRestoreAfterBackgroundTask();
        setBackgroundTaskSubmitting(true);
        void startWorkflowTask({
          workflow: workflowMention,
          description: messagePrompt,
          ...(skillMentions.length > 0 ? { mentions: skillMentions } : {}),
          ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
        })
          .then(({ task }) => {
            if (!mountedRef.current) return;
            composerAttachments.clearAttachments();
            router.refresh();
            toast.success(`Started ${task.name} in the background.`);
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            restoreDraft();
            toast.error(
              error instanceof Error ? error.message : "Could not start that workflow task.",
            );
          })
          .finally(() => {
            if (!mountedRef.current) return;
            setBackgroundTaskSubmitting(false);
            refocusMainComposerAfterBackgroundTask();
          });
        return;
      }

      if (backgroundEngine) {
        const settings =
          backgroundEngine === "claude_code"
            ? ({
                ok: true,
                settings: { reasoningEffort: codexReasoningEffort },
              } as const)
            : buildCodexComposerSettings({
                prompt: messagePrompt,
                reasoningEffort: codexReasoningEffort,
                planModeEnabled: codexPlanModeEnabled,
                goalModeEnabled: codexGoalModeEnabled,
                goalObjective: codexGoalObjective,
                goalTokenBudget: codexGoalTokenBudget,
              });
        if (!settings.ok) {
          toast.error(settings.error);
          return;
        }

        clearComposerDraft(chatSessionId);
        clearError();
        setInput("");
        setMentionToken(null);
        setSelectedMentions([]);
        prepareMainComposerFocusRestoreAfterBackgroundTask();
        setBackgroundTaskSubmitting(true);
        composerAttachments.setAttachments([]);
        toast("Started a new chat in the background.");

        const engine = backgroundEngine;
        const config = ENGINE_CHAT_CONFIG[engine];
        const newSessionId = newOptimisticChatSessionId();
        setLocalChatState(newSessionId, "working");
        void sendEngineChatMessage({
          endpoint: config.messagesEndpoint,
          errorLabel: config.label,
          prompt: messagePrompt,
          sessionId: null,
          newSessionId,
          settings: settings.settings,
          userMessageId: `goat_chat_msg_${crypto.randomUUID()}`,
          attachments: attachmentsMetadata,
          mentions: backgroundMentions.filter(isSkillMention),
          ...(engine === "codex"
            ? { model: codexModel }
            : engine === "claude_code"
              ? { model: claudeModel }
              : {}),
        })
          .then(() => {
            revokeAttachmentPreviews(pendingAttachments);
            if (!mountedRef.current) return;
            router.refresh();
            toast.success(`${config.label} is ready.`);
          })
          .catch((error) => {
            clearLocalChatState(newSessionId, "working");
            if (!mountedRef.current) return;
            restoreDraft();
            toast.error(
              error instanceof Error ? error.message : `${config.label} could not start that turn.`,
            );
          })
          .finally(() => {
            if (!mountedRef.current) return;
            setBackgroundTaskSubmitting(false);
            refocusMainComposerAfterBackgroundTask();
          });
        return;
      }

      clearComposerDraft(chatSessionId);
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      prepareMainComposerFocusRestoreAfterBackgroundTask();
      setBackgroundTaskSubmitting(true);
      composerAttachments.setAttachments([]);
      toast("Started a new chat in the background.");

      const newSessionId = newOptimisticChatSessionId();
      setLocalChatState(newSessionId, "working");
      void runBackgroundChatTurn({
        prompt: messagePrompt,
        model: String(chatModel),
        newSessionId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      })
        .then(() => {
          revokeAttachmentPreviews(pendingAttachments);
          if (!mountedRef.current) return;
          router.refresh();
          toast.success("Background chat is ready.");
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          restoreDraft();
          toast.error(error instanceof Error ? error.message : "Could not start that chat.");
        })
        .finally(() => {
          clearLocalChatState(newSessionId, "working");
          if (!mountedRef.current) return;
          setBackgroundTaskSubmitting(false);
          refocusMainComposerAfterBackgroundTask();
        });
      return;
    }

    if (adHocTaskMentionEnabled && hasAdHocTaskToken(prompt)) {
      const description = descriptionFromAdHocTaskPrompt(prompt);
      if (!description) {
        toast.error(`Describe the task after ${AD_HOC_TASK_TOKEN}.`);
        return;
      }
      if (pendingAttachments.length > 0) {
        toast.error("Attachments are not supported when starting a background task yet.");
        return;
      }

      clearComposerDraft(chatSessionId);
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      prepareMainComposerFocusRestoreAfterBackgroundTask();
      setBackgroundTaskSubmitting(true);
      void startAdHocTask({
        description: prompt,
        model: String(chatModel),
        ...(mentions.some((mention) => mention.kind === "engine" && mention.id === "codex")
          ? { engine: "codex" }
          : {}),
      })
        .then(({ task }) => {
          if (!mountedRef.current) return;
          router.refresh();
          toast.success(`Started ${task.name} in the background.`);
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          setInput(prompt);
          setSelectedMentions(mentions);
          toast.error(
            error instanceof Error ? error.message : "Could not start that background task.",
          );
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setBackgroundTaskSubmitting(false);
          refocusMainComposerAfterBackgroundTask();
        });
      return;
    }

    const workflowMention = mentions.find(isWorkflowMention);
    if (workflowMention) {
      const skillMentions = mentions.filter(isSkillMention);
      clearComposerDraft(chatSessionId);
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      prepareMainComposerFocusRestoreAfterBackgroundTask();
      setBackgroundTaskSubmitting(true);
      void startWorkflowTask({
        workflow: workflowMention,
        description: prompt,
        ...(skillMentions.length > 0 ? { mentions: skillMentions } : {}),
        ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
      })
        .then(({ task }) => {
          if (!mountedRef.current) return;
          composerAttachments.clearAttachments();
          router.refresh();
          toast.success(`Started ${task.name} in the background.`);
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          setInput(prompt);
          setSelectedMentions(mentions);
          toast.error(
            error instanceof Error ? error.message : "Could not start that workflow task.",
          );
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setBackgroundTaskSubmitting(false);
          refocusMainComposerAfterBackgroundTask();
        });
      return;
    }

    clearError();
    setMode("chat");
    isPinnedAtBottomRef.current = true;
    setLocallyStoppedAssistantMessageIds(new Set());
    setInput("");
    setMentionToken(null);
    setSelectedMentions([]);
    if (activeEngine) {
      const settings =
        activeEngine === "claude_code"
          ? ({
              ok: true,
              settings: { reasoningEffort: codexReasoningEffort },
            } as const)
          : buildCodexComposerSettings({
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
      clearComposerDraft(chatSessionId);
      const engine = activeEngine;
      const config = ENGINE_CHAT_CONFIG[engine];
      const userMessageId = `goat_chat_msg_${crypto.randomUUID()}`;
      const existingEngineSessionId = activeEngineChat?.chatSessionId ?? null;
      const newSessionId = existingEngineSessionId
        ? null
        : (pendingNewSessionIdRef.current ?? newOptimisticChatSessionId());
      if (newSessionId && pendingNewSessionIdRef.current !== newSessionId) {
        pendingNewSessionIdRef.current = newSessionId;
        routedChatSessionIdRef.current = newSessionId;
        setChatModelOverride(chatModel);
        setChatSessionId(newSessionId);
        setPersistedChatSessionId(null);
        window.history.replaceState(null, "", chatHref(newSessionId));
      }
      beginActiveTurn();
      setEngineSubmitting(true);
      // Keep the object URLs alive for the optimistic user bubble.
      composerAttachments.setAttachments([]);
      void sendEngineChatMessage({
        endpoint: config.messagesEndpoint,
        errorLabel: config.label,
        prompt,
        sessionId: existingEngineSessionId,
        newSessionId,
        settings: settings.settings,
        userMessageId,
        attachments: attachmentsMetadata,
        mentions: mentions.filter(isSkillMention),
        ...(!existingEngineSessionId && engine === "codex"
          ? { model: codexModel }
          : !existingEngineSessionId && engine === "claude_code"
            ? { model: claudeModel }
            : {}),
      })
        .then((result) => {
          const pendingNewSessionId = pendingNewSessionIdRef.current;
          const ownsRoute = routedChatSessionIdRef.current === result.sessionId;
          if (ownsRoute) {
            trackOptimisticAttachmentPreviews(result.userMessageId, attachmentsMetadata);
            setChatSessionId(result.sessionId);
            setPersistedChatSessionId(result.sessionId);
            if (pendingNewSessionId === result.sessionId) pendingNewSessionIdRef.current = null;
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
          }
        })
        .catch((error) => {
          const requestChatSessionId = existingEngineSessionId ?? newSessionId;
          clearLocalActiveTurnState(requestChatSessionId);
          clearActiveTurn();
          if (requestChatSessionId && routedChatSessionIdRef.current === requestChatSessionId) {
            setInput(prompt);
            setSelectedMentions(mentions);
            composerAttachments.setAttachments(pendingAttachments);
          }
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

    clearComposerDraft(chatSessionId);
    const metadata: ChatMessageMetadata = {
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
    };
    const message =
      Object.keys(metadata).length > 0 ? { text: prompt, metadata } : { text: prompt };
    const model = chatModel;
    const newSessionId = chatSessionId
      ? pendingNewSessionIdRef.current === chatSessionId
        ? chatSessionId
        : null
      : newOptimisticChatSessionId();
    const requestSessionId = newSessionId ? null : chatSessionId;
    if (newSessionId && pendingNewSessionIdRef.current !== newSessionId) {
      pendingNewSessionIdRef.current = newSessionId;
      routedChatSessionIdRef.current = newSessionId;
      setChatModelOverride(model);
      setChatSessionId(newSessionId);
      setPersistedChatSessionId(null);
      window.history.replaceState(null, "", chatHref(newSessionId));
    }
    beginActiveTurn();
    // Clear without revoking previews: the optimistic bubble still shows them.
    composerAttachments.setAttachments([]);
    void sendMessage(message, {
      body: { sessionId: requestSessionId, newSessionId, model },
    }).catch((error) => {
      const requestChatSessionId = requestSessionId ?? newSessionId;
      clearLocalActiveTurnState(requestChatSessionId);
      clearActiveTurn();
      if (requestChatSessionId && routedChatSessionIdRef.current === requestChatSessionId) {
        setInput(prompt);
        setSelectedMentions(mentions);
        composerAttachments.setAttachments(pendingAttachments);
      }
      toast.error(
        error instanceof Error ? error.message : "opencompany could not answer that right now.",
      );
    });
  };

  useEffect(() => {
    if (!onboardingKickoffReadRef.current) {
      onboardingKickoffReadRef.current = true;
      onboardingKickoffPromptRef.current = consumeOnboardingKickoffPrompt();
    }
    const prompt = onboardingKickoffPromptRef.current;
    if (!prompt) return;

    // Synchronize one-time browser storage with the normal form submit path.
    // The prompt ref lets the submit handler read the kickoff immediately,
    // without waiting for a render or an animation frame that may be throttled.
    // Keep the consumed kickoff until this component is mounted so React Strict
    // Mode's development setup/cleanup replay cannot drop it.
    queueMicrotask(() => {
      if (!mountedRef.current) return;
      if (onboardingKickoffPromptRef.current !== prompt) return;
      onboardingKickoffPromptRef.current = null;
      setChatModelOverride(normalizeModel(defaultModel));
      pendingProgrammaticPromptRef.current = prompt;
      setInput(prompt);
      formRef.current?.requestSubmit();
    });
  }, [defaultModel]);

  const handleActionApproval = async ({
    approvalId,
    action,
    decision,
    reason,
  }: ActionApprovalRequest) => {
    // After a reload the useChat overlay is empty; seed it from the merged
    // thread so addToolApprovalResponse has the approval message to mutate.
    const lastChatMessage = chatMessages.at(-1);
    if (lastChatMessage && messages.at(-1)?.id !== lastChatMessage.id) {
      setMessages(chatMessages);
    }
    if (decision === "accept_always") {
      const saved = await alwaysAllowChatActionAction(action).catch(() => null);
      if (!saved?.ok) {
        // The one-off approval still goes through; only the standing
        // permission failed to save.
        toast.error("Could not save the permission. Running this action once.");
      }
    }
    await addToolApprovalResponse(
      decision === "decline"
        ? { id: approvalId, approved: false, reason: reason ?? "Declined by user." }
        : { id: approvalId, approved: true },
    );
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
        newSessionId: null,
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
    if (isGenerating) {
      clearLocalActiveTurnState(chatSessionId);
      void stop();
    }
    openChat(null);
    router.replace("/");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [chatSessionId, clearLocalActiveTurnState, isGenerating, openChat, router, stop]);

  const stopGeneration = useCallback(() => {
    if (activeTaskConversation) {
      if (isTaskConversationStopping) return;
      const taskId = activeTaskConversation.taskId;
      setTaskMessageSubmitting(false);
      setStoppingTaskId(taskId);
      void cancelTaskAction(taskId)
        .then((result) => {
          if (result.ok) {
            router.refresh();
            return;
          }
          setStoppingTaskId((current) => (current === taskId ? null : current));
          toast.error(result.error ?? "Could not stop that task.");
        })
        .catch(() => {
          setStoppingTaskId((current) => (current === taskId ? null : current));
          toast.error("Could not stop that task.");
        });
      return;
    }

    if (activeEngineChat) {
      const config = ENGINE_CHAT_CONFIG[activeEngineChat.engine];
      setEngineRunning(false);
      clearLocalActiveTurnState(activeEngineChat.chatSessionId);
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
    clearLocalActiveTurnState(chatSessionId ?? lastAssistantMessage?.metadata?.sessionId ?? null);
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
  }, [
    activeEngineChat,
    activeTaskConversation,
    chatResumeEnabled,
    chatSessionId,
    clearLocalActiveTurnState,
    isTaskConversationStopping,
    messages,
    router,
    stop,
  ]);

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
      if ((!isInteractionPending || isBackgroundSubmit) && !backgroundTaskSubmitting) {
        formRef.current?.requestSubmit();
      }
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
    pendingProgrammaticPromptRef.current = null;
    setInput(nextInput);
    setSelectedMentions((current) =>
      current.filter((mention) => chatMentionIsVisible(nextInput, mention)),
    );
    updateMentionToken(nextInput, event.target.selectionStart);
  };

  const onInputPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (composerAttachments.handlePasteFiles(event)) return;
    if (!userWorkosId) return;

    const pastedText = event.clipboardData.getData("text/plain");
    const pastedSkillIds = skillMentionIdsFromText(pastedText);
    const pastedWorkflowIds = workflowMentionsEnabled
      ? workflowMentionIdsFromText(pastedText)
      : new Set<string>();
    if (pastedSkillIds.size === 0 && pastedWorkflowIds.size === 0) return;

    // Native textarea paste cannot carry our structured mention metadata. Insert the same text
    // ourselves, then resolve only exact skill tokens from the pasted fragment against the active
    // Brain catalog. Manually typed lookalikes continue to stay plain text.
    event.preventDefault();
    const textareaValue = event.currentTarget.value;
    const selectionStart = event.currentTarget.selectionStart ?? textareaValue.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    const availableLength = Math.max(
      0,
      event.currentTarget.maxLength - (textareaValue.length - (selectionEnd - selectionStart)),
    );
    const insertedText = pastedText.slice(0, availableLength);
    const nextInput = `${textareaValue.slice(0, selectionStart)}${insertedText}${textareaValue.slice(selectionEnd)}`;
    const nextCaret = selectionStart + insertedText.length;
    const pastedMentions = [
      ...skillMentionsFromPastedText({
        pastedText: insertedText,
        fullInput: nextInput,
        skillIds: pastedSkillIds,
        skills: skillCatalog,
      }),
      ...workflowMentionsFromPastedText({
        pastedText: insertedText,
        fullInput: nextInput,
        workflowIds: pastedWorkflowIds,
        workflows: workflowCatalog,
      }),
    ];

    pendingInputCaretRef.current = nextCaret;
    setInput(nextInput);
    setMentionToken(null);
    setSelectedMentions((current) => mergeVisibleChatMentions(nextInput, current, pastedMentions));

    const knownSkillIds = new Set(
      skillCatalog.flatMap((skill) => (pastedSkillIds.has(skill.id) ? [skill.id] : [])),
    );
    const knownWorkflowIds = new Set(
      workflowCatalog.flatMap((workflow) =>
        pastedWorkflowIds.has(workflow.id) ? [workflow.id] : [],
      ),
    );
    if (
      knownSkillIds.size === pastedSkillIds.size &&
      knownWorkflowIds.size === pastedWorkflowIds.size
    ) {
      return;
    }

    void Promise.all([
      fetchBrainSkillCatalog(),
      workflowMentionsEnabled ? fetchBrainWorkflowCatalog() : Promise.resolve([]),
    ])
      .then(([skills, workflows]) => {
        if (!mountedRef.current) return;
        setSkillCatalog(skills);
        if (workflowMentionsEnabled) setWorkflowCatalog(workflows);
        const currentInput = inputRef.current?.value ?? nextInput;
        const resolvedMentions = [
          ...skillMentionsFromPastedText({
            pastedText: insertedText,
            fullInput: currentInput,
            skillIds: pastedSkillIds,
            skills,
          }),
          ...workflowMentionsFromPastedText({
            pastedText: insertedText,
            fullInput: currentInput,
            workflowIds: pastedWorkflowIds,
            workflows,
          }),
        ];
        setSelectedMentions((current) =>
          mergeVisibleChatMentions(currentInput, current, resolvedMentions),
        );
      })
      .catch(() => {});
  };

  const selectMention = (option: MentionOption) => {
    if (!mentionToken) return;
    const before = input.slice(0, mentionToken.start);
    const after = input.slice(mentionToken.end);
    const nextInput = `${before}${option.token} ${after}`;
    const nextCaret = before.length + option.token.length + 1;
    pendingInputCaretRef.current = nextCaret;
    setInput(nextInput);
    if (option.kind === "task") {
      setSelectedMentions((current) => current.filter((mention) => mention.kind !== "workflow"));
      setMentionToken(null);
      return;
    }
    setSelectedMentions((current) => {
      if (option.mention.kind === "engine") {
        const modelSelection = chatModelSelectionFromEngineMention(option.mention);
        if (modelSelection === CODEX_PICKER_VALUE && chatModel !== CODEX_PICKER_VALUE) {
          setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
        } else if (modelSelection === CLAUDE_PICKER_VALUE && chatModel !== CLAUDE_PICKER_VALUE) {
          setCodexReasoningEffort(DEFAULT_CLAUDE_CHAT_REASONING_EFFORT);
          setCodexPlanModeEnabled(false);
          setCodexGoalModeEnabled(false);
          setCodexGoalObjective("");
          setCodexGoalTokenBudget("");
        }
        return [...current.filter((mention) => mention.kind !== "engine"), option.mention];
      }
      if (option.mention.kind === "workflow") {
        // One workflow per message: send dispatches exactly one background task.
        return [...current.filter((mention) => mention.kind !== "workflow"), option.mention];
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
      <Dialog
        open={newChatCommandOpen}
        onOpenChange={(open, eventDetails) => {
          if (open) {
            setNewChatCommandOpen(true);
            return;
          }
          // Esc backs out of compose to search first, like drilling out of a command
          // one level at a time, instead of dropping straight out of the palette.
          if (eventDetails.reason === "escape-key" && commandPaletteView === "compose") {
            eventDetails.cancel();
            backToCommandPaletteSearch();
            return;
          }
          closeCommandPalette();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>
            {commandPaletteView === "compose" ? "New chat" : "Jump to a chat"}
          </DialogTitle>
          <DialogDescription>
            {commandPaletteView === "compose"
              ? "Start a new chat that runs in the background."
              : "Search chats to reopen, or start a new one."}
          </DialogDescription>
        </DialogHeader>
        <DialogContent
          showCloseButton={false}
          className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden bg-surface p-0 text-ink"
        >
          {commandPaletteView === "compose" ? (
            <>
              <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
                <button
                  type="button"
                  onClick={backToCommandPaletteSearch}
                  aria-label="Back to search"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <ArrowLeft size={14} strokeWidth={2} />
                </button>
                <span className="text-[12px] font-medium text-ink-subtle">New chat</span>
              </div>
              <QuickChatComposer
                open={newChatCommandOpen && commandPaletteView === "compose"}
                initialPrompt={chatSearchQuery.trim()}
                userWorkosId={userWorkosId}
                defaultModel={defaultModel}
                codexConnected={codexConnected}
                claudeCodeConnected={claudeCodeConnected}
                taskSpawningEnabled={taskSpawningEnabled}
                autoModelRoutingEnabled={autoModelRoutingEnabled}
                creditBalance={creditBalance}
                onSubmitted={closeCommandPalette}
              />
            </>
          ) : (
            <Command className="bg-surface text-ink">
              <CommandInput
                autoFocus
                value={chatSearchQuery}
                onValueChange={setChatSearchQuery}
                placeholder="Search chats or start something new..."
              />
              <CommandList>
                <CommandGroup heading="Actions" forceMount>
                  <CommandItem
                    value="start-new-chat"
                    forceMount
                    onSelect={openCommandPaletteCompose}
                    className="gap-3"
                  >
                    <SquarePen size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                      {chatSearchQuery.trim()
                        ? `Start new chat: "${chatSearchQuery.trim()}"`
                        : "Start new chat"}
                    </span>
                    <CommandShortcut>
                      <CornerDownLeft size={12} strokeWidth={2} />
                    </CommandShortcut>
                  </CommandItem>
                </CommandGroup>
                <CommandEmpty>No matching chats.</CommandEmpty>
                {paletteRecentChats.length > 0 ? (
                  <CommandGroup heading="Chats">
                    {paletteRecentChats.map((chat) => (
                      <CommandItem
                        key={chat.id}
                        value={`chat ${chat.title} ${chat.id}`}
                        onSelect={() => jumpToChat(chat)}
                        className="gap-3"
                      >
                        <MessageSquare
                          size={16}
                          strokeWidth={2}
                          className="shrink-0 text-ink-subtle"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink">{chat.title}</p>
                          <p className="truncate text-[12px] text-ink-subtle">{chat.preview}</p>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {archivedChats.length > 0 ? (
                  <CommandGroup heading="Archived">
                    {archivedChats.map((chat) => (
                      <CommandItem
                        key={chat.id}
                        value={`archived ${chat.title} ${chat.id}`}
                        onSelect={() => restoreAndOpenChat(chat)}
                        className="gap-3"
                      >
                        {restoringChatId === chat.id ? (
                          <LoaderCircle
                            size={16}
                            strokeWidth={2}
                            className="shrink-0 animate-spin text-ink-subtle"
                          />
                        ) : (
                          <Archive size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink">{chat.title}</p>
                          <p className="truncate text-[12px] text-ink-subtle">Archived chat</p>
                        </div>
                        <CommandShortcut className="flex items-center gap-1">
                          <RotateCcw size={12} strokeWidth={2} />
                          Restore
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          )}
        </DialogContent>
      </Dialog>

      <div className="relative flex min-h-0 w-full flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-hidden">
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
                        <HomeTaskRows items={homeTasks} onArchiveTask={archiveTask} />
                      </section>
                    ) : null}

                    {homeChats.length > 0 ? (
                      <section className="flex flex-col gap-1">
                        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                          Chats
                        </h2>
                        <ChatHistoryList
                          chats={homeChats}
                          localChatStates={localChatStates}
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
              <div className="w-full px-6 pb-2 pt-3">
                <div className="flex w-full items-center justify-between gap-3">
                  <ChatTitleHeader
                    title={activeChatTitle}
                    model={activeChatModel}
                    engine={activeChatEngine}
                    isTask={Boolean(activeTaskConversation)}
                  />
                  <div className="flex shrink-0 items-center gap-2">
                    {(!activeTaskConversation || activeTaskConversation.sessionBacked) &&
                    chatSessionId &&
                    persistedChatSessionId === chatSessionId &&
                    hasMessages ? (
                      <ChatShareButton
                        chatSessionId={chatSessionId}
                        disabled={isAgentWorking}
                        subject={shareSubjectForActiveChat({
                          isTask: Boolean(activeTaskConversation),
                          engine: activeChatEngine,
                        })}
                      />
                    ) : null}
                    {activeEngineChat?.engine === "codex" ||
                    activeEngineChat?.engine === "claude_code" ? (
                      <>
                        <CodexSessionStatusIndicator
                          engine={activeEngineChat.engine}
                          runtime={codexRuntime}
                          optimisticStatus={
                            engineSubmitting
                              ? "starting"
                              : engineRunning && !isCodexRuntimeActive(codexRuntime)
                                ? "running"
                                : null
                          }
                          sandboxStatus={codexSandboxStatus}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            ref={workspaceToggleButtonRef}
                            type="button"
                            aria-label={
                              workspacePanelExpanded ? "Collapse workspace" : "Open workspace"
                            }
                            aria-pressed={workspacePanelExpanded}
                            onClick={() => workspacePanelRef.current?.toggle()}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                          >
                            {workspacePanelExpanded ? (
                              <PanelRightClose size={14} strokeWidth={1.9} />
                            ) : (
                              <PanelRightOpen size={14} strokeWidth={1.9} />
                            )}
                          </TooltipTrigger>
                          <TooltipContent>
                            {workspacePanelExpanded ? "Collapse workspace" : "Open workspace"}
                          </TooltipContent>
                        </Tooltip>
                      </>
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
                <div
                  data-testid="chat-thread-content"
                  className="mx-auto flex w-full max-w-[720px] flex-col gap-3 pt-2"
                  style={{ paddingBottom: chatThreadBottomPaddingPx }}
                >
                  {chatMessages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      taskLookup={chatTaskLookup}
                      stopped={locallyStoppedAssistantMessageIds.has(message.id)}
                      durationMs={chatMessageDurationMs(message, optimisticTurnDurations)}
                      onCodexAction={handleCodexToolAction}
                      allowCodexPlanActions={message.id === latestAssistantMessageId}
                      onActionApproval={handleActionApproval}
                      allowActionApproval={message.id === latestAssistantMessageId}
                      isTaskSession={Boolean(activeTaskConversation)}
                    />
                  ))}
                  {isTaskConversationStopping ? (
                    <PendingActivityIndicator label="Stopping task…" />
                  ) : isAgentWorking && activeTurnTimerStartedAtMs !== null ? (
                    <ThinkingIndicator
                      startedAtMs={activeTurnTimerStartedAtMs}
                      label={
                        isEngineChat && activeEngine
                          ? codexRuntime?.status === "queued"
                            ? `${ENGINE_CHAT_CONFIG[activeEngine].label} is queued`
                            : `${ENGINE_CHAT_CONFIG[activeEngine].label} is working`
                          : "opencompany is working"
                      }
                    />
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {mode === "chat" &&
          (!activeTaskConversation || activeTaskConversation.sessionBacked) &&
          chatSessionId &&
          persistedChatSessionId === chatSessionId ? (
            <LiveChatMessages sessionId={chatSessionId} onChange={setLiveChat} />
          ) : null}
          {mode === "chat" &&
          (activeEngineChat?.engine === "codex" || activeEngineChat?.engine === "claude_code") ? (
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
              {chatSendBlocked ? (
                <p
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-4 text-ink shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                  role="alert"
                >
                  Your workspace is out of credits — chat is paused.{" "}
                  <button
                    type="button"
                    onClick={() => router.push("/settings/workspace/billing")}
                    className="font-medium underline"
                  >
                    Top up to continue
                  </button>
                </p>
              ) : lowCreditBalance && creditBalance ? (
                <p
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                  role="status"
                >
                  {formatCreditBalance(creditBalance.balanceUsdMicros)} in credits left.{" "}
                  <button
                    type="button"
                    onClick={() => router.push("/settings/workspace/billing")}
                    className="font-medium text-ink underline"
                  >
                    Add credits
                  </button>{" "}
                  to keep chat and ingestion running.
                </p>
              ) : null}
              {chatError ? (
                <p
                  className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                  role="alert"
                >
                  {chatError.message || "opencompany could not answer that right now."}
                </p>
              ) : null}
              {mentionToken && mentionOptions.length > 0 ? (
                <div
                  role="listbox"
                  aria-label="Mention menu"
                  className="absolute bottom-full left-3 z-20 mb-2 max-h-72 w-80 overflow-y-auto shadow-ring-md rounded-lg bg-surface p-1"
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
                        <Code2
                          size={14}
                          strokeWidth={2}
                          className="mt-0.5 shrink-0 text-ink-subtle"
                        />
                      ) : option.kind === "workflow" ? (
                        <WorkflowIcon
                          size={14}
                          strokeWidth={2}
                          className="mt-0.5 shrink-0 text-ink-subtle"
                        />
                      ) : option.kind === "task" ? (
                        <Play
                          size={14}
                          strokeWidth={2}
                          className="mt-0.5 shrink-0 text-ink-subtle"
                        />
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
                        {option.kind === "skill" ||
                        option.kind === "workflow" ||
                        option.kind === "task" ? (
                          <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
                            {option.label}
                            {option.description ? ` · ${option.description}` : ""}
                          </span>
                        ) : null}
                      </span>
                      {option.kind === "engine" ? (
                        <span className="text-[12px] leading-4 text-ink-subtle">Codex</span>
                      ) : null}
                      {option.kind === "workflow" || option.kind === "task" ? (
                        <span className="text-[12px] leading-4 text-ink-subtle">Task</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {selectedAdHocTask ? (
                <div
                  role="status"
                  data-testid="ad-hoc-task-hint"
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                >
                  <Play size={13} strokeWidth={2} className="shrink-0" />
                  <span>Sending starts this as an ad-hoc background task.</span>
                </div>
              ) : selectedWorkflowMention ? (
                <div
                  role="status"
                  data-testid="workflow-task-hint"
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                >
                  <WorkflowIcon size={13} strokeWidth={2} className="shrink-0" />
                  <span>
                    Sending runs workflow{" "}
                    <span className="font-medium text-ink">{selectedWorkflowName}</span> as a
                    background task.
                  </span>
                </div>
              ) : backgroundChatDirective ? (
                <BackgroundChatDirectiveHint engine={backgroundDirectiveTargetEngine} />
              ) : null}
              <div
                {...composerAttachments.dragHandlers}
                className="relative flex flex-col rounded-2xl border border-border bg-surface shadow-[0_8px_24px_rgba(15,15,15,0.08)] transition-colors duration-150 focus-within:border-border-strong"
              >
                {composerAttachments.isDragActive && attachmentsEnabled ? (
                  <ComposerDropOverlay />
                ) : null}
                {composerAttachments.attachments.length > 0 ? (
                  <div className="px-3.5 pt-3">
                    <ComposerAttachments
                      attachments={composerAttachments.attachments}
                      onRemove={composerAttachments.removeAttachment}
                    />
                  </div>
                ) : null}
                <div className="flex items-end gap-2.5 px-3.5 pt-3 pb-1.5">
                  <div className="relative min-w-0 flex-1 self-center">
                    {renderComposerInputOverlay({
                      value: input,
                      mentions: activeSelectedMentions,
                      overlayRef: inputOverlayRef,
                    })}
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
                            : "Ask opencompany anything..."
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
                      onPaste={onInputPaste}
                      onScroll={(event) => {
                        if (inputOverlayRef.current) {
                          inputOverlayRef.current.scrollTop = event.currentTarget.scrollTop;
                        }
                      }}
                      onSelect={(event) =>
                        updateMentionToken(
                          event.currentTarget.value,
                          event.currentTarget.selectionStart,
                        )
                      }
                      disabled={backgroundTaskSubmitting}
                      readOnly={voiceDictation.isActive}
                      className={cn(
                        "relative z-10 block max-h-32 w-full resize-none bg-transparent py-[3px] text-[13.5px] leading-5 text-ink outline-none placeholder:text-ink-subtle",
                        composerInputHasHighlights(input, activeSelectedMentions) &&
                          "text-transparent caret-ink",
                      )}
                      style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                      maxLength={10_000}
                    />
                  </div>
                  {isEngineChat &&
                  engineRunning &&
                  !activeTaskConversation &&
                  !backgroundChatDirective ? (
                    <EngineStopButton
                      label={activeEngine ? ENGINE_CHAT_CONFIG[activeEngine].label : "Codex"}
                      onStop={stopGeneration}
                    />
                  ) : null}
                  {voiceDictation.isActive ? (
                    <VoiceDictationPill
                      status={voiceDictation.status}
                      levels={voiceDictation.levels}
                      onStop={voiceDictation.stop}
                      onCancel={voiceDictation.cancel}
                    />
                  ) : null}
                  <SubmitButton
                    disabled={
                      (!input.trim() &&
                        !composerAttachments.attachments.some(
                          (attachment) => attachment.status === "ready",
                        )) ||
                      composerAttachments.isUploading ||
                      (!isBackgroundSubmit && engineSubmitting) ||
                      (!isBackgroundSubmit && engineRunning) ||
                      backgroundTaskSubmitting ||
                      voiceDictation.isActive ||
                      chatSendBlocked
                    }
                    isGenerating={
                      isBackgroundSubmit ? false : isGenerating || isTaskConversationWorking
                    }
                    isStopping={!isBackgroundSubmit && isTaskConversationStopping}
                    startsTask={selectedAdHocTask || Boolean(selectedWorkflowMention)}
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
                        accept={CHAT_ATTACHMENT_ACCEPT}
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
                        disabled={isGenerating || engineSubmitting || voiceDictation.isActive}
                        onClick={() => attachmentFileInputRef.current?.click()}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                      >
                        <Plus size={16} strokeWidth={1.9} />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Start voice dictation"
                    disabled={
                      isGenerating ||
                      engineSubmitting ||
                      engineRunning ||
                      backgroundTaskSubmitting ||
                      voiceDictation.isActive ||
                      newChatCommandOpen
                    }
                    onClick={voiceDictation.start}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                  >
                    <Mic size={15} strokeWidth={1.9} />
                  </button>
                  <ModelPicker
                    value={chatModel}
                    onChange={(model) => {
                      setSelectedMentions((current) =>
                        current.filter((mention) => mention.kind !== "engine"),
                      );
                      setChatModelOverride(model);
                      persistLastChatSelection(userWorkosId, model);
                      if (model === CODEX_PICKER_VALUE && model !== chatModel) {
                        setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
                      } else if (model === CLAUDE_PICKER_VALUE && model !== chatModel) {
                        setCodexReasoningEffort(DEFAULT_CLAUDE_CHAT_REASONING_EFFORT);
                        setCodexPlanModeEnabled(false);
                        setCodexGoalModeEnabled(false);
                        setCodexGoalObjective("");
                        setCodexGoalTokenBudget("");
                      } else if (model !== CODEX_PICKER_VALUE && model !== CLAUDE_PICKER_VALUE) {
                        setCodexPlanModeEnabled(false);
                        setCodexGoalModeEnabled(false);
                        setCodexGoalObjective("");
                        setCodexGoalTokenBudget("");
                      }
                    }}
                    disabled={isGenerating || Boolean(chatSessionId) || voiceDictation.isActive}
                    codexConnected={codexConnected}
                    claudeCodeConnected={claudeCodeConnected}
                    autoModelRoutingEnabled={autoModelRoutingEnabled}
                  />
                  {showEngineComposerControls ? (
                    <EngineComposerControls
                      model={
                        composerEngine === "codex"
                          ? { engine: "codex", value: codexModel, onChange: setCodexModel }
                          : composerEngine === "claude_code"
                            ? {
                                engine: "claude_code",
                                value: claudeModel,
                                onChange: setClaudeModel,
                              }
                            : null
                      }
                      engineLabel={composerEngine === "claude_code" ? "Claude" : "Codex"}
                      reasoningEffortAvailable={
                        composerEngine !== "claude_code" ||
                        claudeCodeModelSupportsReasoningEffort(claudeModel)
                      }
                      reasoningEffort={codexReasoningEffort}
                      planModeEnabled={codexPlanModeEnabled}
                      planModeAvailable={composerEngine === "codex"}
                      goalModeAvailable={composerEngine !== "claude_code"}
                      goalModeEnabled={codexGoalModeEnabled}
                      goalObjective={codexGoalObjective}
                      goalTokenBudget={codexGoalTokenBudget}
                      disabled={engineSubmitting || voiceDictation.isActive}
                      modelDisabled={
                        engineSubmitting || Boolean(activeEngineChat) || voiceDictation.isActive
                      }
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
        {mode === "chat" &&
        (activeEngineChat?.engine === "codex" || activeEngineChat?.engine === "claude_code") ? (
          <CodingWorkspacePanel
            key={activeEngineChat.chatSessionId}
            ref={workspacePanelRef}
            chatSessionId={activeEngineChat.chatSessionId}
            sandboxStatus={codexSandboxStatus}
            engineLabel={CLOUD_CODING_ENGINE_CONFIG[activeEngineChat.engine].label}
            onExpandedChange={setWorkspacePanelExpanded}
            onRequestFocusReturn={() => workspaceToggleButtonRef.current?.focus()}
          />
        ) : null}
      </div>
    </div>
  );
}

// The Cmd+K quick-compose surface. Same controls as the main composer (attachments,
// model/engine picker, mentions), but it always starts new background work — it
// never adopts the result into view or navigates to it.
function QuickChatComposer({
  open,
  initialPrompt,
  userWorkosId,
  defaultModel,
  codexConnected,
  claudeCodeConnected,
  taskSpawningEnabled,
  autoModelRoutingEnabled,
  creditBalance,
  onSubmitted,
}: {
  open: boolean;
  initialPrompt: string;
  userWorkosId: string;
  defaultModel: string;
  codexConnected: boolean;
  claudeCodeConnected: boolean;
  taskSpawningEnabled: boolean;
  autoModelRoutingEnabled: boolean;
  creditBalance: ReturnType<typeof useCreditBalance>["balance"];
  onSubmitted: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputOverlayRef = useRef<HTMLDivElement>(null);
  const attachmentFileInputRef = useRef<HTMLInputElement>(null);
  const pendingInputCaretRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [input, setInput] = useState("");
  const [mentionToken, setMentionToken] = useState<ActiveMentionToken | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<ChatMention[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);
  const [workflowCatalog, setWorkflowCatalog] = useState<WorkflowCatalogItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const rememberedChatModel = useSyncExternalStore(
    subscribeLastChatSelection,
    () =>
      readLastChatSelection(userWorkosId, {
        codexConnected,
        claudeCodeConnected,
        autoModelRoutingEnabled,
      }),
    () => normalizeModel(defaultModel),
  );
  const [chatModelOverride, setChatModelOverride] = useState<ChatModelSelection | null>(null);
  const baseChatModel = chatModelOverride ?? rememberedChatModel;
  const [codexModel, setCodexModel] = useState<CodexChatModelId>(() =>
    normalizeCodexChatModelId(undefined),
  );
  const [claudeModel, setClaudeModel] = useState<ClaudeChatModelId>(() =>
    normalizeClaudeChatModelId(undefined),
  );
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(
    DEFAULT_CODEX_CHAT_REASONING_EFFORT,
  );
  const [codexPlanModeEnabled, setCodexPlanModeEnabled] = useState(false);
  const [codexGoalModeEnabled, setCodexGoalModeEnabled] = useState(false);
  const [codexGoalObjective, setCodexGoalObjective] = useState("");
  const [codexGoalTokenBudget, setCodexGoalTokenBudget] = useState("");

  const workflowMentionsEnabled = taskSpawningEnabled;
  const activeSelectedMentions = selectedMentions.filter((mention) => {
    if (!chatMentionIsVisible(input, mention)) return false;
    if (mention.kind === "engine") {
      return mention.id === "claude" ? claudeCodeConnected : codexConnected;
    }
    if (mention.kind === "workflow") return workflowMentionsEnabled;
    return true;
  });
  const chatModel =
    chatModelSelectionFromEngineMention(
      activeSelectedMentions.find((mention) => mention.kind === "engine"),
    ) ?? baseChatModel;
  const isCodexMode = chatModel === CODEX_PICKER_VALUE;
  const isClaudeMode = chatModel === CLAUDE_PICKER_VALUE;
  const selectedEngine: EngineChatKind | null = isCodexMode
    ? "codex"
    : isClaudeMode
      ? "claude_code"
      : null;
  const backgroundChatDirective = hasBackgroundChatDirective(input);
  const parsedBackgroundChatDirective = parseBackgroundChatDirective(input);
  const composerEngine = parsedBackgroundChatDirective
    ? (parsedBackgroundChatDirective.engine ?? selectedEngine)
    : selectedEngine;
  const isEngineChat = composerEngine !== null;
  const adHocTaskMentionEnabled = taskSpawningEnabled && !selectedEngine;
  const backgroundAdHocTaskSelected = Boolean(
    parsedBackgroundChatDirective &&
      taskSpawningEnabled &&
      hasAdHocTaskToken(parsedBackgroundChatDirective.prompt),
  );
  const selectedAdHocTask =
    backgroundAdHocTaskSelected ||
    (!parsedBackgroundChatDirective && adHocTaskMentionEnabled && hasAdHocTaskToken(input));
  const outOfCredits = Boolean(
    creditBalance && creditBalance.enforcementEnabled && creditBalance.balanceUsdMicros <= 0,
  );
  const chatSendBlocked = outOfCredits && !composerEngine;

  const mentionOptions = buildMentionOptions({
    token: mentionToken,
    skills: skillCatalog,
    workflows: workflowCatalog,
    selectedMentions: activeSelectedMentions,
    codexConnected,
    claudeCodeConnected,
    skillsEnabled: true,
    workflowsEnabled: workflowMentionsEnabled,
    adHocTaskEnabled: adHocTaskMentionEnabled || Boolean(parsedBackgroundChatDirective),
  });
  const selectedWorkflowMention = selectedAdHocTask
    ? null
    : (activeSelectedMentions.find(isWorkflowMention) ?? null);
  const selectedWorkflowName = selectedWorkflowMention
    ? (workflowCatalog.find((workflow) => workflow.id === selectedWorkflowMention.id)?.name ??
      selectedWorkflowMention.id)
    : null;

  const attachmentsEnabled = Boolean(userWorkosId);
  const composerAttachments = useChatAttachments({
    userWorkosId,
    modelName: String(chatModel),
    enabled: attachmentsEnabled && !isSubmitting,
    ...(composerEngine === "codex" || composerEngine === "claude_code"
      ? { capabilities: CLOUD_CODEX_ATTACHMENT_CAPABILITIES }
      : chatModel === AUTO_MODEL_SELECTION
        ? { capabilities: AUTO_MODEL_ATTACHMENT_CAPABILITIES }
        : {}),
  });

  // The dialog stays mounted across opens; reset to a pristine draft each time it closes
  // so a stale prompt, attachment, or engine choice never leaks into the next invocation.
  const clearAttachments = composerAttachments.clearAttachments;
  useEffect(() => {
    if (open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset on close, not a render loop */
    setInput("");
    setMentionToken(null);
    setSelectedMentions([]);
    clearAttachments();
    setChatModelOverride(null);
    setCodexPlanModeEnabled(false);
    setCodexGoalModeEnabled(false);
    setCodexGoalObjective("");
    setCodexGoalTokenBudget("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, clearAttachments]);

  useLayoutEffect(() => {
    if (!open) return;
    // The palette hands off whatever the user was searching for as a starting draft,
    // so they don't have to retype it once they commit to composing a new chat.
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot seed on open, not a render loop */
    setInput(initialPrompt);
    if (initialPrompt) pendingInputCaretRef.current = initialPrompt.length;
    inputRef.current?.focus();
  }, [open, initialPrompt]);

  // Mirrors the main composer: refetch the skill/workflow catalog on every mention-menu
  // open so recently created skills/workflows show up.
  const skillMentionMenuOpen = Boolean(userWorkosId && mentionToken);
  useEffect(() => {
    if (!skillMentionMenuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchBrainSkillCatalog(controller.signal)
        .then(setSkillCatalog)
        .catch(() => {});
      if (workflowMentionsEnabled) {
        void fetchBrainWorkflowCatalog(controller.signal)
          .then(setWorkflowCatalog)
          .catch(() => {});
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skillMentionMenuOpen, workflowMentionsEnabled]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      if (inputOverlayRef.current) inputOverlayRef.current.scrollTop = 0;
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    if (inputOverlayRef.current) inputOverlayRef.current.scrollTop = el.scrollTop;
  }, [input]);

  useLayoutEffect(() => {
    const caret = pendingInputCaretRef.current;
    if (caret === null) return;
    pendingInputCaretRef.current = null;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(caret, caret);
  }, [input]);

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
      current.filter((mention) => chatMentionIsVisible(nextInput, mention)),
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
    if (option.kind === "task") {
      setSelectedMentions((current) => current.filter((mention) => mention.kind !== "workflow"));
      setMentionToken(null);
      return;
    }
    setSelectedMentions((current) => {
      if (option.mention.kind === "engine") {
        const modelSelection = chatModelSelectionFromEngineMention(option.mention);
        if (modelSelection === CODEX_PICKER_VALUE && chatModel !== CODEX_PICKER_VALUE) {
          setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
        } else if (modelSelection === CLAUDE_PICKER_VALUE && chatModel !== CLAUDE_PICKER_VALUE) {
          setCodexReasoningEffort(DEFAULT_CLAUDE_CHAT_REASONING_EFFORT);
          setCodexPlanModeEnabled(false);
          setCodexGoalModeEnabled(false);
          setCodexGoalObjective("");
          setCodexGoalTokenBudget("");
        }
        return [...current.filter((mention) => mention.kind !== "engine"), option.mention];
      }
      if (option.mention.kind === "workflow") {
        return [...current.filter((mention) => mention.kind !== "workflow"), option.mention];
      }
      return current.some((mention) => mention.kind === "skill" && mention.id === option.mention.id)
        ? current
        : [...current, option.mention];
    });
    setMentionToken(null);
  };

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
        event.stopPropagation();
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
        event.stopPropagation();
        const option = mentionOptions[mentionOptionIndex];
        if (option) selectMention(option);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!isSubmitting) formRef.current?.requestSubmit();
    }
  };

  const onInputPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (composerAttachments.handlePasteFiles(event)) return;
    if (!userWorkosId) return;

    const pastedText = event.clipboardData.getData("text/plain");
    const pastedSkillIds = skillMentionIdsFromText(pastedText);
    const pastedWorkflowIds = workflowMentionsEnabled
      ? workflowMentionIdsFromText(pastedText)
      : new Set<string>();
    if (pastedSkillIds.size === 0 && pastedWorkflowIds.size === 0) return;

    event.preventDefault();
    const textareaValue = event.currentTarget.value;
    const selectionStart = event.currentTarget.selectionStart ?? textareaValue.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    const availableLength = Math.max(
      0,
      event.currentTarget.maxLength - (textareaValue.length - (selectionEnd - selectionStart)),
    );
    const insertedText = pastedText.slice(0, availableLength);
    const nextInput = `${textareaValue.slice(0, selectionStart)}${insertedText}${textareaValue.slice(selectionEnd)}`;
    const nextCaret = selectionStart + insertedText.length;
    const pastedMentions = [
      ...skillMentionsFromPastedText({
        pastedText: insertedText,
        fullInput: nextInput,
        skillIds: pastedSkillIds,
        skills: skillCatalog,
      }),
      ...workflowMentionsFromPastedText({
        pastedText: insertedText,
        fullInput: nextInput,
        workflowIds: pastedWorkflowIds,
        workflows: workflowCatalog,
      }),
    ];

    pendingInputCaretRef.current = nextCaret;
    setInput(nextInput);
    setMentionToken(null);
    setSelectedMentions((current) => mergeVisibleChatMentions(nextInput, current, pastedMentions));

    const knownSkillIds = new Set(
      skillCatalog.flatMap((skill) => (pastedSkillIds.has(skill.id) ? [skill.id] : [])),
    );
    const knownWorkflowIds = new Set(
      workflowCatalog.flatMap((workflow) =>
        pastedWorkflowIds.has(workflow.id) ? [workflow.id] : [],
      ),
    );
    if (
      knownSkillIds.size === pastedSkillIds.size &&
      knownWorkflowIds.size === pastedWorkflowIds.size
    ) {
      return;
    }

    void Promise.all([
      fetchBrainSkillCatalog(),
      workflowMentionsEnabled ? fetchBrainWorkflowCatalog() : Promise.resolve([]),
    ])
      .then(([skills, workflows]) => {
        if (!mountedRef.current) return;
        setSkillCatalog(skills);
        if (workflowMentionsEnabled) setWorkflowCatalog(workflows);
        const currentInput = inputRef.current?.value ?? nextInput;
        const resolvedMentions = [
          ...skillMentionsFromPastedText({
            pastedText: insertedText,
            fullInput: currentInput,
            skillIds: pastedSkillIds,
            skills,
          }),
          ...workflowMentionsFromPastedText({
            pastedText: insertedText,
            fullInput: currentInput,
            workflowIds: pastedWorkflowIds,
            workflows,
          }),
        ];
        setSelectedMentions((current) =>
          mergeVisibleChatMentions(currentInput, current, resolvedMentions),
        );
      })
      .catch(() => {});
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (chatSendBlocked) {
      toast.error(CHAT_OUT_OF_CREDITS_MESSAGE, {
        action: {
          label: "Add credits",
          onClick: () => router.push("/settings/workspace/billing"),
        },
      });
      return;
    }

    const rawPrompt = input.trim();
    const backgroundChat = parseBackgroundChatDirective(rawPrompt);
    const prompt = backgroundChat?.prompt ?? rawPrompt;
    const isBackgroundChatDirective = backgroundChat !== null;
    const backgroundEngine = backgroundChat ? (backgroundChat.engine ?? selectedEngine) : null;
    const pendingAttachments = composerAttachments.attachments;
    const readyAttachments = pendingAttachments.filter(
      (attachment) => attachment.status === "ready",
    );
    if (!prompt && readyAttachments.length === 0) return;
    if (prompt.length > BACKGROUND_CHAT_PROMPT_MAX_LENGTH) {
      toast.error(
        `Messages can be at most ${BACKGROUND_CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
      );
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
      chatMentionIsVisible(prompt, mention),
    );
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

    if (
      taskSpawningEnabled &&
      (isBackgroundChatDirective || adHocTaskMentionEnabled) &&
      hasAdHocTaskToken(prompt)
    ) {
      const description = descriptionFromAdHocTaskPrompt(prompt);
      if (!description) {
        toast.error(`Describe the task after ${AD_HOC_TASK_TOKEN}.`);
        return;
      }
      if (pendingAttachments.length > 0) {
        toast.error("Attachments are not supported when starting a background task yet.");
        return;
      }

      setIsSubmitting(true);
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      onSubmitted();
      void startAdHocTask({
        description: prompt,
        model: String(chatModel),
        ...(backgroundEngine === "codex" ||
        mentions.some((mention) => mention.kind === "engine" && mention.id === "codex")
          ? { engine: "codex" }
          : {}),
      })
        .then(({ task }) => {
          // Not gated on mountedRef: the dialog has already closed.
          router.refresh();
          toast.success(`Started ${task.name} in the background.`);
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : "Could not start that background task.",
          );
        })
        .finally(() => {
          if (mountedRef.current) setIsSubmitting(false);
        });
      return;
    }

    const workflowMention = mentions.find(isWorkflowMention);
    if (workflowMention) {
      const skillMentions = mentions.filter(isSkillMention);
      setIsSubmitting(true);
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      composerAttachments.clearAttachments();
      onSubmitted();
      void startWorkflowTask({
        workflow: workflowMention,
        description: prompt,
        ...(skillMentions.length > 0 ? { mentions: skillMentions } : {}),
        ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
      })
        .then(({ task }) => {
          // Not gated on mountedRef: the dialog (and this component) has already
          // closed by the time this resolves — router.refresh()/toast are global.
          router.refresh();
          toast.success(`Started ${task.name} in the background.`);
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : "Could not start that workflow task.",
          );
        })
        .finally(() => {
          if (mountedRef.current) setIsSubmitting(false);
        });
      return;
    }

    setInput("");
    setMentionToken(null);
    setSelectedMentions([]);

    const targetEngine = backgroundEngine ?? selectedEngine;
    if (targetEngine) {
      // Validate before clearing attachments / closing the dialog: once onSubmitted()
      // unmounts this component, there's no visible composer left to restore a draft into.
      const settings =
        targetEngine === "claude_code"
          ? ({ ok: true, settings: { reasoningEffort: codexReasoningEffort } } as const)
          : buildCodexComposerSettings({
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

      setIsSubmitting(true);
      composerAttachments.clearAttachments();
      onSubmitted();
      toast("Started a new chat in the background.");

      const engine = targetEngine;
      const config = ENGINE_CHAT_CONFIG[engine];
      const userMessageId = `goat_chat_msg_${crypto.randomUUID()}`;
      const newSessionId = newOptimisticChatSessionId();
      setLocalChatState(newSessionId, "working");
      void sendEngineChatMessage({
        endpoint: config.messagesEndpoint,
        errorLabel: config.label,
        prompt,
        sessionId: null,
        newSessionId,
        settings: settings.settings,
        userMessageId,
        attachments: attachmentsMetadata,
        mentions: mentions.filter(isSkillMention),
        ...(engine === "codex"
          ? { model: codexModel }
          : engine === "claude_code"
            ? { model: claudeModel }
            : {}),
      })
        .then(() => {
          // Not gated on mountedRef: see the workflow branch above.
          router.refresh();
          toast.success(`${config.label} is ready.`);
        })
        .catch((error) => {
          clearLocalChatState(newSessionId, "working");
          toast.error(
            error instanceof Error ? error.message : `${config.label} could not start that turn.`,
          );
        })
        .finally(() => {
          if (mountedRef.current) setIsSubmitting(false);
        });
      return;
    }

    setIsSubmitting(true);
    composerAttachments.clearAttachments();
    onSubmitted();
    toast("Started a new chat in the background.");

    const newSessionId = newOptimisticChatSessionId();
    setLocalChatState(newSessionId, "working");
    const backgroundChatMentions = isBackgroundChatDirective
      ? mentions.filter((mention) => !isWorkflowMention(mention))
      : mentions;
    const metadata: ChatMessageMetadata = {
      ...(backgroundChatMentions.length > 0 ? { mentions: backgroundChatMentions } : {}),
      ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
    };
    void runBackgroundChatTurn({
      prompt,
      model: String(chatModel),
      newSessionId,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    })
      .then(() => {
        // Not gated on mountedRef: see the workflow branch above.
        router.refresh();
        toast.success("Background chat is ready.");
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Could not start that chat.");
      })
      .finally(() => {
        clearLocalChatState(newSessionId, "working");
        if (mountedRef.current) setIsSubmitting(false);
      });
  };

  const showEngineComposerControls = isEngineChat;

  return (
    <div className="flex flex-col gap-2 p-3">
      {mentionToken && mentionOptions.length > 0 ? (
        <div
          role="listbox"
          aria-label="Mention menu"
          className="max-h-72 w-full overflow-y-auto shadow-ring-md rounded-lg bg-surface p-1"
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
              ) : option.kind === "workflow" ? (
                <WorkflowIcon
                  size={14}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-ink-subtle"
                />
              ) : option.kind === "task" ? (
                <Play size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
              ) : (
                <Sparkles size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-4 text-ink">
                  {option.token}
                </span>
                {option.kind === "skill" || option.kind === "workflow" || option.kind === "task" ? (
                  <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
                    {option.label}
                    {option.description ? ` · ${option.description}` : ""}
                  </span>
                ) : null}
              </span>
              {option.kind === "engine" ? (
                <span className="text-[12px] leading-4 text-ink-subtle">Codex</span>
              ) : null}
              {option.kind === "workflow" || option.kind === "task" ? (
                <span className="text-[12px] leading-4 text-ink-subtle">Task</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {selectedAdHocTask ? (
        <div
          role="status"
          data-testid="ad-hoc-task-hint"
          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
        >
          <Play size={13} strokeWidth={2} className="shrink-0" />
          <span>Sending starts this as an ad-hoc background task.</span>
        </div>
      ) : selectedWorkflowMention ? (
        <div
          role="status"
          data-testid="workflow-task-hint"
          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
        >
          <WorkflowIcon size={13} strokeWidth={2} className="shrink-0" />
          <span>
            Sending runs workflow{" "}
            <span className="font-medium text-ink">{selectedWorkflowName}</span> as a background
            task.
          </span>
        </div>
      ) : backgroundChatDirective ? (
        <BackgroundChatDirectiveHint engine={composerEngine} />
      ) : null}
      <form ref={formRef} onSubmit={onSubmit}>
        <div
          {...composerAttachments.dragHandlers}
          className="relative flex flex-col rounded-2xl border border-border bg-surface transition-colors duration-150 focus-within:border-border-strong"
        >
          {composerAttachments.isDragActive && attachmentsEnabled ? <ComposerDropOverlay /> : null}
          {composerAttachments.attachments.length > 0 ? (
            <div className="px-3.5 pt-3">
              <ComposerAttachments
                attachments={composerAttachments.attachments}
                onRemove={composerAttachments.removeAttachment}
              />
            </div>
          ) : null}
          <div className="flex items-end gap-2.5 px-3.5 pt-3 pb-1.5">
            <div className="relative min-w-0 flex-1 self-center">
              {renderComposerInputOverlay({
                value: input,
                mentions: activeSelectedMentions,
                overlayRef: inputOverlayRef,
              })}
              <textarea
                ref={inputRef}
                rows={1}
                id="quick-chat-prompt"
                name="prompt"
                value={input}
                placeholder="Ask opencompany anything, or describe a task..."
                onChange={onInputChange}
                onBlur={() => setMentionToken(null)}
                onClick={(event) =>
                  updateMentionToken(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                onKeyDown={onKeyDown}
                onPaste={onInputPaste}
                onScroll={(event) => {
                  if (inputOverlayRef.current) {
                    inputOverlayRef.current.scrollTop = event.currentTarget.scrollTop;
                  }
                }}
                onSelect={(event) =>
                  updateMentionToken(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                disabled={isSubmitting}
                className={cn(
                  "relative z-10 block max-h-32 w-full resize-none bg-transparent py-[3px] text-[13.5px] leading-5 text-ink outline-none placeholder:text-ink-subtle",
                  composerInputHasHighlights(input, activeSelectedMentions) &&
                    "text-transparent caret-ink",
                )}
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                maxLength={10_000}
              />
            </div>
            <SubmitButton
              disabled={
                (!input.trim() &&
                  !composerAttachments.attachments.some(
                    (attachment) => attachment.status === "ready",
                  )) ||
                composerAttachments.isUploading ||
                isSubmitting ||
                chatSendBlocked
              }
              isGenerating={false}
              startsTask={selectedAdHocTask || Boolean(selectedWorkflowMention)}
              onStop={() => {}}
            />
          </div>
          <div className="flex items-center gap-1 border-t border-border px-2.5 py-1.5">
            {attachmentsEnabled ? (
              <>
                <input
                  ref={attachmentFileInputRef}
                  type="file"
                  multiple
                  accept={CHAT_ATTACHMENT_ACCEPT}
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
                  disabled={isSubmitting}
                  onClick={() => attachmentFileInputRef.current?.click()}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                >
                  <Plus size={16} strokeWidth={1.9} />
                </button>
              </>
            ) : null}
            <ModelPicker
              value={chatModel}
              onChange={(model) => {
                // Deliberately not persisted via persistLastChatSelection: this picker
                // only applies to this one quick-compose chat, not the app-wide "last used
                // model" default the main composer reads on its next fresh session.
                setSelectedMentions((current) =>
                  current.filter((mention) => mention.kind !== "engine"),
                );
                setChatModelOverride(model);
                if (model === CODEX_PICKER_VALUE && model !== chatModel) {
                  setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
                } else if (model === CLAUDE_PICKER_VALUE && model !== chatModel) {
                  setCodexReasoningEffort(DEFAULT_CLAUDE_CHAT_REASONING_EFFORT);
                  setCodexPlanModeEnabled(false);
                  setCodexGoalModeEnabled(false);
                  setCodexGoalObjective("");
                  setCodexGoalTokenBudget("");
                } else if (model !== CODEX_PICKER_VALUE && model !== CLAUDE_PICKER_VALUE) {
                  setCodexPlanModeEnabled(false);
                  setCodexGoalModeEnabled(false);
                  setCodexGoalObjective("");
                  setCodexGoalTokenBudget("");
                }
              }}
              disabled={isSubmitting}
              codexConnected={codexConnected}
              claudeCodeConnected={claudeCodeConnected}
              autoModelRoutingEnabled={autoModelRoutingEnabled}
            />
            {showEngineComposerControls ? (
              <EngineComposerControls
                model={
                  composerEngine === "codex"
                    ? { engine: "codex", value: codexModel, onChange: setCodexModel }
                    : composerEngine === "claude_code"
                      ? { engine: "claude_code", value: claudeModel, onChange: setClaudeModel }
                      : null
                }
                engineLabel={composerEngine === "claude_code" ? "Claude" : "Codex"}
                reasoningEffortAvailable={
                  composerEngine !== "claude_code" ||
                  claudeCodeModelSupportsReasoningEffort(claudeModel)
                }
                reasoningEffort={codexReasoningEffort}
                planModeEnabled={codexPlanModeEnabled}
                planModeAvailable={composerEngine === "codex"}
                goalModeAvailable={composerEngine !== "claude_code"}
                goalModeEnabled={codexGoalModeEnabled}
                goalObjective={codexGoalObjective}
                goalTokenBudget={codexGoalTokenBudget}
                disabled={isSubmitting}
                modelDisabled={isSubmitting}
                onReasoningEffortChange={setCodexReasoningEffort}
                onPlanModeEnabledChange={setCodexPlanModeEnabled}
                onGoalModeEnabledChange={setCodexGoalModeEnabled}
                onGoalObjectiveChange={setCodexGoalObjective}
                onGoalTokenBudgetChange={setCodexGoalTokenBudget}
              />
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}

type VoiceDictationStatus = "idle" | "connecting" | "recording" | "processing";
type VoiceDictationAccess = {
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
};
type VoiceDictationSocketMessage =
  | { type: "ready" }
  | { type: "processing" }
  | { type: "delta"; delta: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };

const DICTATION_PROTOCOL = "goat-dictation-v1";
const DICTATION_TICKET_PROTOCOL_PREFIX = "goat-dictation-ticket.";
const DICTATION_SAMPLE_RATE = 24_000;
const DICTATION_LEVEL_COUNT = 18;
const EMPTY_DICTATION_LEVELS = Array.from({ length: DICTATION_LEVEL_COUNT }, () => 0.08);

function useComposerVoiceDictation({
  input,
  inputRef,
  onInputChange,
}: {
  input: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (nextInput: string) => void;
}) {
  const [status, setStatus] = useState<VoiceDictationStatus>("idle");
  const statusRef = useRef<VoiceDictationStatus>("idle");
  const [levels, setLevels] = useState(EMPTY_DICTATION_LEVELS);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const priorDraftRef = useRef("");
  const dictatedTextRef = useRef("");
  const cancelledRef = useRef(false);

  const setDictationStatus = useCallback((nextStatus: VoiceDictationStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const cleanup = useCallback((closeSocket = true) => {
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (closeSocket) socketRef.current?.close();
    socketRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      cleanup();
    },
    [cleanup],
  );

  const applyTranscript = useCallback(
    (transcript: string) => {
      dictatedTextRef.current = transcript;
      onInputChange(draftWithDictation(priorDraftRef.current, transcript).slice(0, 10_000));
    },
    [onInputChange],
  );

  const finishWithError = useCallback(
    (message: string) => {
      cleanup();
      applyTranscript("");
      setLevels(EMPTY_DICTATION_LEVELS);
      setDictationStatus("idle");
      toast.error(message);
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    },
    [applyTranscript, cleanup, inputRef, setDictationStatus],
  );

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    const AudioContextCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
      toast.error("Voice dictation is not available in this browser.");
      return;
    }

    cancelledRef.current = false;
    priorDraftRef.current = inputRef.current?.value ?? input;
    dictatedTextRef.current = "";
    setLevels(EMPTY_DICTATION_LEVELS);
    setDictationStatus("connecting");

    try {
      const response = await fetch("/api/dictation/access", { method: "POST" });
      if (!response.ok)
        throw new Error((await response.text()) || "Voice dictation is unavailable.");
      const access = (await response.json()) as Partial<VoiceDictationAccess>;
      if (typeof access.websocketUrl !== "string" || typeof access.ticket !== "string") {
        throw new Error("The runner returned invalid dictation access.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const socket = new WebSocket(access.websocketUrl, [
        DICTATION_PROTOCOL,
        `${DICTATION_TICKET_PROTOCOL_PREFIX}${access.ticket}`,
      ]);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (cancelledRef.current || socketRef.current !== socket) return socket.close();
        try {
          stopCaptureRef.current = startPcmMicrophoneCapture({
            stream,
            AudioContextCtor,
            onAudio: (audio) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "audio", audio }));
              }
            },
            onLevel: (level) => {
              setLevels((current) => [...current.slice(1), Math.max(0.08, Math.min(1, level))]);
            },
          });
          setDictationStatus("recording");
        } catch (error) {
          finishWithError(
            error instanceof Error ? error.message : "Could not start voice dictation.",
          );
        }
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || cancelledRef.current) return;
        const message = parseDictationMessage(event.data);
        if (!message) return;
        if (message.type === "delta") {
          applyTranscript(`${dictatedTextRef.current}${message.delta}`);
        } else if (message.type === "partial") {
          applyTranscript(message.text);
        } else if (message.type === "processing") {
          setDictationStatus("processing");
        } else if (message.type === "final") {
          applyTranscript(message.text);
          cleanup(false);
          setLevels(EMPTY_DICTATION_LEVELS);
          setDictationStatus("idle");
          requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
        } else if (message.type === "error") {
          finishWithError(message.message);
        } else if (message.type === "warning") {
          toast.error(message.message);
        }
      });
      socket.addEventListener("close", (event) => {
        if (cancelledRef.current || statusRef.current === "idle") return;
        if (event.code >= 4000 && event.reason) {
          finishWithError(event.reason);
          return;
        }
        if (statusRef.current !== "processing") finishWithError("Voice dictation stopped.");
      });
      socket.addEventListener("error", () => {
        if (!cancelledRef.current && statusRef.current !== "idle") {
          finishWithError("Voice dictation connection failed.");
        }
      });
    } catch (error) {
      finishWithError(error instanceof Error ? error.message : "Could not start voice dictation.");
    }
  }, [applyTranscript, cleanup, finishWithError, input, inputRef, setDictationStatus]);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    if (
      statusRef.current !== "recording" ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      cancelledRef.current
    ) {
      return;
    }
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setDictationStatus("processing");
    socket.send(JSON.stringify({ type: "stop" }));
  }, [setDictationStatus]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "cancel" }));
    }
    cleanup();
    onInputChange(priorDraftRef.current);
    setLevels(EMPTY_DICTATION_LEVELS);
    setDictationStatus("idle");
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [cleanup, inputRef, onInputChange, setDictationStatus]);

  return {
    status,
    levels,
    isActive: status !== "idle",
    start,
    stop,
    cancel,
  };
}

function VoiceDictationPill({
  status,
  levels,
  onStop,
  onCancel,
}: {
  status: VoiceDictationStatus;
  levels: readonly number[];
  onStop: () => void;
  onCancel: () => void;
}) {
  const processing = status === "processing";
  const connecting = status === "connecting";
  const statusLabel = processing
    ? "Processing voice dictation"
    : connecting
      ? "Connecting voice dictation"
      : "Recording voice dictation";
  return (
    <div
      role="status"
      aria-label={statusLabel}
      className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-border-strong bg-surface px-2 text-[12px] leading-4 text-ink shadow-[0_1px_4px_rgba(15,15,15,0.08)]"
    >
      {processing || connecting ? (
        <LoaderCircle size={13} strokeWidth={2} className="animate-spin text-ink-subtle" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-red-500" />
      )}
      <span className="hidden font-medium sm:inline">
        {processing ? "Processing" : status === "connecting" ? "Connecting" : "Recording"}
      </span>
      <div aria-hidden className="flex h-4 items-center gap-0.5">
        {levels.map((level, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size live waveform bars.
            key={index}
            className="w-0.5 rounded-full bg-ink-subtle/70"
            style={{ height: `${Math.max(3, Math.round(level * 16))}px` }}
          />
        ))}
      </div>
      {status === "recording" ? (
        <button
          type="button"
          aria-label="Stop voice dictation"
          onClick={onStop}
          className="flex h-6 w-6 items-center justify-center rounded-full text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Square size={11} strokeWidth={2.2} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Cancel voice dictation"
        onClick={onCancel}
        className="flex h-6 w-6 items-center justify-center rounded-full text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <X size={13} strokeWidth={2.1} />
      </button>
    </div>
  );
}

function startPcmMicrophoneCapture(input: {
  stream: MediaStream;
  AudioContextCtor: typeof AudioContext;
  onAudio: (audio: string) => void;
  onLevel: (level: number) => void;
}) {
  const audioContext = new input.AudioContextCtor();
  const source = audioContext.createMediaStreamSource(input.stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    input.onLevel(rmsLevel(samples));
    const pcm = floatSamplesToPcm16(samples, audioContext.sampleRate, DICTATION_SAMPLE_RATE);
    if (pcm.byteLength > 0) input.onAudio(pcm16ToBase64(pcm));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    void audioContext.close().catch(() => {});
  };
}

function rmsLevel(samples: Float32Array) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index]! ** 2;
  }
  return Math.sqrt(sum / samples.length) * 3;
}

function floatSamplesToPcm16(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
) {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(0, Math.floor(samples.length / ratio));
  const output = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(outputIndex * ratio));
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex] ?? 0));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function pcm16ToBase64(pcm: Int16Array) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function draftWithDictation(draft: string, transcript: string) {
  const cleanTranscript = transcript.trimStart();
  if (!cleanTranscript) return draft;
  if (!draft.trim()) return cleanTranscript;
  return `${draft.trimEnd()} ${cleanTranscript}`;
}

function parseDictationMessage(data: string): VoiceDictationSocketMessage | null {
  try {
    const value = JSON.parse(data) as Partial<VoiceDictationSocketMessage>;
    if (value.type === "ready") return { type: "ready" };
    if (value.type === "processing") return { type: "processing" };
    if (value.type === "delta" && typeof value.delta === "string") {
      return { type: "delta", delta: value.delta };
    }
    if ((value.type === "partial" || value.type === "final") && typeof value.text === "string") {
      return { type: value.type, text: value.text };
    }
    if ((value.type === "warning" || value.type === "error") && typeof value.message === "string") {
      return { type: value.type, message: value.message };
    }
    return null;
  } catch {
    return null;
  }
}

function formatCreditBalance(usdMicros: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usdMicros / 1_000_000);
}

function mentionsFromMessageMetadata(metadata: ChatMessageMetadata | undefined) {
  const mentions = metadata?.mentions ?? [];
  return mentions.filter(isSupportedMention);
}

function chatHref(sessionId: string) {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

function visibleHomeChats(
  chats: readonly ChatSummaryView[],
  optimisticallyArchivedChatIds: ReadonlySet<string>,
  localChatStates: ReadonlyMap<string, ReturnType<typeof chatSummaryState>>,
) {
  return chats
    .filter((chat) => !optimisticallyArchivedChatIds.has(chat.id))
    .filter(
      (chat) =>
        Boolean(chat.pinnedAt) ||
        isHomeChatStateVisible(chat, localChatStates.get(chat.id) ?? null) ||
        isRecentHomeActivity(chat.updatedAt),
    )
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function isHomeChatStateVisible(
  chat: ChatSummaryView,
  localState: ReturnType<typeof chatSummaryState> | null,
) {
  const state = localState ?? chatSummaryState(chat);
  return state === "working" || state === "done_unseen";
}

function visibleHomeSchedules(schedules: readonly TaskScheduleView[]) {
  return schedules
    .filter((schedule) => schedule.id)
    .toSorted((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
}

function visibleHomeTasks(input: {
  tasks: readonly TaskView[];
  optimisticallyArchivedTaskIds: ReadonlySet<string>;
}): TaskView[] {
  return input.tasks
    .filter(
      (task) =>
        !input.optimisticallyArchivedTaskIds.has(task.id) &&
        !task.archivedAt &&
        (isBackgroundTaskActive(task) || isRecentHomeActivity(task.createdAt)),
    )
    .toSorted((left, right) => {
      const activeDifference =
        Number(isBackgroundTaskActive(right)) - Number(isBackgroundTaskActive(left));
      if (activeDifference !== 0) return activeDifference;
      return taskUpdatedAtMs(right) - taskUpdatedAtMs(left);
    });
}

function isBackgroundTaskActive(task: TaskView) {
  return task.status === "queued" || task.status === "running";
}

function taskUpdatedAtMs(task: TaskView) {
  const timestamp = new Date(task.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function titleFromChatMessages(messages: readonly ChatUiMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage ? textFromChatUiMessage(firstUserMessage) : "";
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}...`;
}

function chatMessageDurationMs(
  message: ChatUiMessage,
  optimisticTurnDurations: ReadonlyMap<string, number>,
) {
  if (message.role !== "assistant") return null;
  const persistedDurationMs = message.metadata?.timing?.durationMs;
  if (typeof persistedDurationMs === "number") return persistedDurationMs;
  return optimisticTurnDurations.get(message.id) ?? null;
}

function latestChatTurnStartedAtMs(messages: readonly ChatUiMessage[]) {
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
  newSessionId: string | null;
  settings: EngineComposerSettings;
  userMessageId: string;
  attachments: ChatUiAttachment[];
  mentions: ChatMention[];
  model?: CodexChatModelId | ClaudeChatModelId;
}): Promise<EngineChatMessageResponse> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.newSessionId ? { newSessionId: input.newSessionId } : {}),
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
  current: ChatUiMessage[],
  input: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string | null;
    prompt: string;
    attachments: ChatUiAttachment[];
  },
): ChatUiMessage[] {
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

function defaultCodexComposerUiState(
  reasoningEffort = DEFAULT_CODEX_CHAT_REASONING_EFFORT,
): CodexComposerUiState {
  return {
    reasoningEffort,
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
        engine?: ChatEngine;
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
  return codexComposerUiStateFromSettings(
    chat?.codexComposerSettings ?? null,
    chat?.engine === "claude_code" ? DEFAULT_CLAUDE_CHAT_REASONING_EFFORT : undefined,
  );
}

function codexComposerUiStateFromSettings(
  settings: EngineComposerSettings | null | undefined,
  defaultReasoningEffort = DEFAULT_CODEX_CHAT_REASONING_EFFORT,
): CodexComposerUiState {
  if (!settings) {
    return defaultCodexComposerUiState(defaultReasoningEffort);
  }
  const goalMode = settings.goalMode ?? null;
  return {
    reasoningEffort: settings.reasoningEffort,
    planModeEnabled: settings.planModeEnabled ?? false,
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

function isSupportedMention(mention: ChatMention): mention is ChatMention {
  return (
    (mention.kind === "engine" && (mention.id === "codex" || mention.id === "claude")) ||
    (mention.kind === "skill" && Boolean(mention.id)) ||
    (mention.kind === "workflow" && Boolean(mention.id))
  );
}

function isWorkflowMention(
  mention: ChatMention,
): mention is Extract<ChatMention, { kind: "workflow" }> {
  return mention.kind === "workflow";
}

function isSkillMention(mention: ChatMention): mention is Extract<ChatMention, { kind: "skill" }> {
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
  if (!token.startsWith("@") && !token.startsWith("#")) return null;

  return {
    start,
    end,
    query: token.slice(1).toLowerCase(),
    sigil: token.startsWith("#") ? ("#" as const) : ("@" as const),
  };
}

function chatMentionToken(mention: ChatMention) {
  if (mention.kind === "engine") return mention.id === "claude" ? "@claude" : "@codex";
  if (mention.kind === "workflow") return `#${mention.id}`;
  return `@skill/${mention.id}`;
}

function chatMentionIsVisible(value: string, mention: ChatMention) {
  const token = escapeRegExp(chatMentionToken(mention));
  return new RegExp(`(^|\\s)${token}(?=\\s|$)`, "i").test(value);
}

function hasBackgroundChatDirective(value: string) {
  return value.trimStart().startsWith("&");
}

function parseBackgroundChatDirective(value: string): {
  prompt: string;
  engine: EngineChatKind | null;
} | null {
  const trimmedStart = value.trimStart();
  if (!trimmedStart.startsWith("&")) return null;
  const directive = trimmedStart.slice(1).trimStart();
  const engineMatch = directive.match(/^@(codex|claude)(?=\s|$)/i);
  if (!engineMatch) return { prompt: directive, engine: null };
  const engine = engineMatch[1]?.toLowerCase() === "claude" ? "claude_code" : "codex";
  return { prompt: directive.slice(engineMatch[0].length).trimStart(), engine };
}

type ComposerMentionHighlight = Extract<ChatMention, { kind: "engine" | "skill" | "workflow" }>;

type ComposerInputHighlightRange =
  | {
      kind: "background-directive";
      start: number;
      end: number;
    }
  | {
      kind: "mention";
      start: number;
      end: number;
      mention: ComposerMentionHighlight;
    };

function composerInputHasHighlights(value: string, mentions: readonly ChatMention[]) {
  return composerInputHighlightRanges(value, mentions).length > 0;
}

function renderComposerInputOverlay({
  value,
  mentions,
  overlayRef,
}: {
  value: string;
  mentions: readonly ChatMention[];
  overlayRef: RefObject<HTMLDivElement | null>;
}) {
  const ranges = composerInputHighlightRanges(value, mentions);
  if (ranges.length === 0) return null;

  let offset = 0;
  const parts = ranges.flatMap((range, index) => {
    const plain = value.slice(offset, range.start);
    const chip = (
      <span
        key={`mention-${range.start}-${range.end}-${index}`}
        {...(range.kind === "mention"
          ? { "data-chat-mention": range.mention.kind }
          : { "data-goat-chat-directive": "background" })}
        className={COMPOSER_MENTION_CHIP_CLASS}
      >
        {value.slice(range.start, range.end)}
      </span>
    );
    offset = range.end;
    return plain ? [plain, chip] : [chip];
  });
  const tail = value.slice(offset);
  if (tail) parts.push(tail);

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      data-testid="composer-mention-overlay"
      className="pointer-events-none absolute inset-0 z-0 max-h-32 overflow-hidden whitespace-pre-wrap break-words py-[3px] text-[13.5px] leading-5 text-ink"
    >
      {parts}
    </div>
  );
}

function composerInputHighlightRanges(
  value: string,
  mentions: readonly ChatMention[],
): ComposerInputHighlightRange[] {
  if (!value) return [];
  const backgroundDirectiveStart = value.search(/\S/);
  const backgroundDirectiveRange: ComposerInputHighlightRange[] =
    backgroundDirectiveStart >= 0 && value[backgroundDirectiveStart] === "&"
      ? [
          {
            kind: "background-directive",
            start: backgroundDirectiveStart,
            end: backgroundDirectiveStart + 1,
          },
        ]
      : [];
  const mentionRanges = mentions
    .filter(
      (mention): mention is ComposerMentionHighlight =>
        mention.kind === "engine" || mention.kind === "skill" || mention.kind === "workflow",
    )
    .flatMap((mention) => {
      const token = escapeRegExp(chatMentionToken(mention));
      const pattern = new RegExp(`(^|\\s)${token}(?=\\s|$)`, "gi");
      return [...value.matchAll(pattern)].flatMap((match) => {
        if (typeof match.index !== "number") return [];
        const leading = match[1] ?? "";
        const start = match.index + leading.length;
        return [
          {
            kind: "mention" as const,
            start,
            end: start + match[0].length - leading.length,
            mention,
          },
        ];
      });
    })
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const candidates = [...backgroundDirectiveRange, ...mentionRanges].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  const ranges: ComposerInputHighlightRange[] = [];
  for (const candidate of candidates) {
    const previous = ranges.at(-1);
    if (previous && candidate.start < previous.end) continue;
    ranges.push(candidate);
  }
  return ranges;
}

function skillMentionIdsFromText(value: string) {
  const ids = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@skill\/([a-z0-9][a-z0-9-]{0,79})(?=\s|$)/gi)) {
    const id = match[2];
    if (id) ids.add(id.toLowerCase());
  }
  return ids;
}

function skillMentionsFromPastedText(input: {
  pastedText: string;
  fullInput: string;
  skillIds: ReadonlySet<string>;
  skills: SkillCatalogItem[];
}): ChatMention[] {
  return input.skills.flatMap((skill) => {
    if (!input.skillIds.has(skill.id)) return [];
    const mention: ChatMention = { kind: "skill", id: skill.id };
    return chatMentionIsVisible(input.pastedText, mention) &&
      chatMentionIsVisible(input.fullInput, mention)
      ? [mention]
      : [];
  });
}

// Apart from the reserved #task directive, "#" tokens are only treated as workflow
// mentions when they match a real catalog id. Markdown headings and "#123" stay plain text.
function workflowMentionIdsFromText(value: string) {
  const ids = new Set<string>();
  for (const match of value.matchAll(/(^|\s)#([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/gi)) {
    const id = match[2]?.toLowerCase();
    if (id && id !== AD_HOC_TASK_ID) ids.add(id);
  }
  return ids;
}

function workflowMentionsFromPastedText(input: {
  pastedText: string;
  fullInput: string;
  workflowIds: ReadonlySet<string>;
  workflows: WorkflowCatalogItem[];
}): ChatMention[] {
  const matches = input.workflows.flatMap((workflow) => {
    if (!input.workflowIds.has(workflow.id)) return [];
    const mention: ChatMention = {
      kind: "workflow",
      id: workflow.id,
    };
    return chatMentionIsVisible(input.pastedText, mention) &&
      chatMentionIsVisible(input.fullInput, mention)
      ? [mention]
      : [];
  });
  // One workflow per message.
  return matches.slice(0, 1);
}

function mergeVisibleChatMentions(value: string, current: ChatMention[], additions: ChatMention[]) {
  const next = current.filter((mention) => chatMentionIsVisible(value, mention));
  for (const mention of additions) {
    if (next.some((candidate) => candidate.kind === mention.kind && candidate.id === mention.id)) {
      continue;
    }
    next.push(mention);
  }
  return next;
}

function buildMentionOptions(input: {
  token: ActiveMentionToken | null;
  skills: SkillCatalogItem[];
  workflows: WorkflowCatalogItem[];
  selectedMentions: ChatMention[];
  codexConnected: boolean;
  claudeCodeConnected: boolean;
  skillsEnabled: boolean;
  workflowsEnabled: boolean;
  adHocTaskEnabled: boolean;
}): MentionOption[] {
  if (!input.token) return [];
  const query = input.token.query;

  // "#" is the task sigil: it starts either the reserved ad-hoc task or one
  // saved workflow as a background task instead of a foreground chat turn.
  if (input.token.sigil === "#") {
    if (!input.workflowsEnabled && !input.adHocTaskEnabled) return [];
    const hasSelectedWorkflow = input.selectedMentions.some(
      (mention) => mention.kind === "workflow",
    );
    if (hasSelectedWorkflow) return [];
    const options: MentionOption[] = [];
    if (input.adHocTaskEnabled && (!query || "task ad-hoc background".includes(query))) {
      options.push({
        kind: "task",
        token: AD_HOC_TASK_TOKEN,
        label: "Ad-hoc task",
        description: "Run this request in the background",
      });
    }
    if (input.workflowsEnabled) {
      for (const workflow of input.workflows) {
        if (workflow.id === AD_HOC_TASK_ID) continue;
        const haystack = `${workflow.id} ${workflow.name} ${workflow.description}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        options.push({
          kind: "workflow",
          token: `#${workflow.id}`,
          label: workflow.name,
          description: workflow.description,
          mention: { kind: "workflow", id: workflow.id },
        });
      }
    }
    return options;
  }

  const options: MentionOption[] = [];
  if (input.codexConnected && (!query || "codex".startsWith(query))) {
    options.push({ kind: "engine", token: "@codex", label: "Codex", mention: CODEX_MENTION });
  }
  if (input.claudeCodeConnected && (!query || "claude".startsWith(query))) {
    options.push({
      kind: "engine",
      token: "@claude",
      label: "Claude Code",
      mention: CLAUDE_MENTION,
    });
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
      mention: { kind: "skill", id: skill.id },
    });
  }
  return options;
}

function isSkillCatalogItem(value: unknown): value is SkillCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.description === "string"
  );
}

async function fetchBrainSkillCatalog(signal?: AbortSignal) {
  const response = await fetch("/api/skills", signal ? { signal } : {});
  if (!response.ok) throw new Error(`Skill catalog request failed (${response.status})`);
  const payload = (await response.json()) as { skills?: unknown };
  return Array.isArray(payload.skills) ? payload.skills.filter(isSkillCatalogItem) : [];
}

async function fetchBrainWorkflowCatalog(signal?: AbortSignal) {
  const response = await fetch("/api/workflows", signal ? { signal } : {});
  if (!response.ok) throw new Error(`Workflow catalog request failed (${response.status})`);
  const payload = (await response.json()) as { workflows?: unknown };
  // Same wire shape as the skill catalog item.
  return Array.isArray(payload.workflows)
    ? (payload.workflows.filter(isSkillCatalogItem) as WorkflowCatalogItem[])
    : [];
}

async function startAdHocTask(input: { description: string; model: string; engine?: "codex" }) {
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
    task?: { id?: unknown; displayId?: unknown; name?: unknown };
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Could not start that background task.",
    );
  }
  if (
    typeof payload?.task?.id !== "string" ||
    typeof payload.task.displayId !== "string" ||
    typeof payload.task.name !== "string"
  ) {
    throw new Error("The background task started, but its response was invalid.");
  }
  return {
    task: {
      id: payload.task.id,
      displayId: payload.task.displayId,
      name: payload.task.name,
    },
  };
}

async function startWorkflowTask(input: {
  workflow: Extract<ChatMention, { kind: "workflow" }>;
  description: string;
  mentions?: Extract<ChatMention, { kind: "skill" }>[];
  attachments?: ChatUiAttachment[];
}) {
  const response = await fetch("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
    task?: { id?: unknown; displayId?: unknown; name?: unknown };
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Could not start that workflow task.",
    );
  }
  if (
    typeof payload?.task?.id !== "string" ||
    typeof payload.task.displayId !== "string" ||
    typeof payload.task.name !== "string"
  ) {
    throw new Error("The workflow task started, but its response was invalid.");
  }
  return {
    task: {
      id: payload.task.id,
      displayId: payload.task.displayId,
      name: payload.task.name,
    },
  };
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
  return (
    <CodingEngineModelPicker
      engineLabel="Codex"
      provider="openai"
      value={value}
      defaultValue={CODEX_CHAT_DEFAULT_MODEL_ID}
      models={CODEX_MODELS}
      disabled={disabled}
      onChange={(model) => onChange(normalizeCodexChatModelId(model))}
    />
  );
}

function ClaudeModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: ClaudeChatModelId;
  disabled: boolean;
  onChange: (model: ClaudeChatModelId) => void;
}) {
  return (
    <CodingEngineModelPicker
      engineLabel="Claude"
      provider="anthropic"
      value={value}
      defaultValue={CLAUDE_CHAT_DEFAULT_MODEL_ID}
      models={CLAUDE_CODE_MODELS}
      disabled={disabled}
      onChange={(model) => onChange(normalizeClaudeChatModelId(model))}
    />
  );
}

function CodingEngineModelPicker({
  engineLabel,
  provider,
  value,
  defaultValue,
  models,
  disabled,
  onChange,
}: {
  engineLabel: "Claude" | "Codex";
  provider: "anthropic" | "openai";
  value: string;
  defaultValue: string;
  models: readonly { id: string; label: string; description: string }[];
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedModel =
    models.find((model) => model.id === value) ?? models.find((model) => model.id === defaultValue);
  const selectedLabel = selectedModel?.label ?? `${engineLabel} model`;
  const ModelIcon = provider === "anthropic" ? AnthropicIcon : OpenAIIcon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`${engineLabel} model: ${selectedLabel}`}
        title={`${engineLabel} model`}
        disabled={disabled}
        className="flex h-7 max-w-[138px] items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <ModelIcon size={12} strokeWidth={1.9} className="shrink-0" />
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={11} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[300px] max-w-[calc(100vw-1.5rem)] bg-surface p-0 text-ink"
      >
        <Command className="bg-surface text-ink">
          <CommandList>
            <CommandGroup heading={`${engineLabel} models`}>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label, engineLabel, provider]}
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
                    className={cn(
                      "shrink-0 text-ink",
                      model.id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <ModelIcon size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
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

function BackgroundChatDirectiveHint({ engine }: { engine: EngineChatKind | null }) {
  const label = engine ? ENGINE_CHAT_CONFIG[engine].label : null;
  return (
    <div
      role="status"
      data-testid="background-chat-hint"
      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
    >
      <MessageSquare size={13} strokeWidth={2} className="shrink-0" />
      <span>Sending starts this as a new {label ? `${label} ` : ""}chat in the background.</span>
    </div>
  );
}

function EngineComposerControls({
  model,
  engineLabel,
  reasoningEffortAvailable,
  reasoningEffort,
  planModeEnabled,
  planModeAvailable,
  goalModeAvailable,
  goalModeEnabled,
  goalObjective,
  goalTokenBudget,
  disabled,
  modelDisabled,
  onReasoningEffortChange,
  onPlanModeEnabledChange,
  onGoalModeEnabledChange,
  onGoalObjectiveChange,
  onGoalTokenBudgetChange,
}: {
  model:
    | { engine: "codex"; value: CodexChatModelId; onChange: (model: CodexChatModelId) => void }
    | {
        engine: "claude_code";
        value: ClaudeChatModelId;
        onChange: (model: ClaudeChatModelId) => void;
      }
    | null;
  engineLabel: "Claude" | "Codex";
  reasoningEffortAvailable: boolean;
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  planModeAvailable: boolean;
  goalModeAvailable: boolean;
  goalModeEnabled: boolean;
  goalObjective: string;
  goalTokenBudget: string;
  disabled: boolean;
  modelDisabled: boolean;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void;
  onPlanModeEnabledChange: (enabled: boolean) => void;
  onGoalModeEnabledChange: (enabled: boolean) => void;
  onGoalObjectiveChange: (objective: string) => void;
  onGoalTokenBudgetChange: (tokenBudget: string) => void;
}) {
  const reasoningLabel = codexReasoningLabel(reasoningEffort);
  return (
    <div className="mb-px flex shrink-0 items-center gap-1 border-l border-border pl-2">
      {model?.engine === "codex" ? (
        <CodexModelPicker value={model.value} disabled={modelDisabled} onChange={model.onChange} />
      ) : model?.engine === "claude_code" ? (
        <ClaudeModelPicker value={model.value} disabled={modelDisabled} onChange={model.onChange} />
      ) : null}
      {reasoningEffortAvailable ? (
        <button
          type="button"
          aria-label={`${engineLabel} reasoning effort: ${reasoningLabel} (click to cycle)`}
          title="Reasoning effort"
          disabled={disabled}
          onClick={() => onReasoningEffortChange(nextCodexReasoningEffort(reasoningEffort))}
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ReasoningBars effort={reasoningEffort} size={12} />
          <span className="hidden sm:inline">{reasoningLabel}</span>
        </button>
      ) : null}
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
      {goalModeAvailable ? (
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
            className="w-[320px] max-w-[calc(100vw-1.5rem)] bg-surface p-3 text-ink"
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
      ) : null}
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
  isTask = false,
}: {
  title: string;
  model: string;
  engine: ChatEngine;
  isTask?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ink">
      {engine === "codex" ? (
        <OpenAIIcon size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
      ) : engine === "claude_code" ? (
        <AnthropicIcon size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
      ) : (
        <ModelProviderIcon
          modelId={model}
          size={14}
          strokeWidth={1.9}
          className="shrink-0 text-ink-muted"
        />
      )}
      <span className="max-w-[min(420px,calc(100vw-7rem))] truncate text-[12.5px] font-medium leading-4">
        {title}
      </span>
      {isTask ? (
        <span className="inline-flex shrink-0 items-center rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
          Task
        </span>
      ) : null}
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

function codexRuntimeMeta(runtime: CodexRuntimeView | null): CodexRuntimeMeta {
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

function isCodexRuntimeActive(
  runtime: { status?: string | null; activeTurnId?: string | null } | null | undefined,
) {
  return isChatRuntimeActive(runtime);
}

function CodexSessionStatusIndicator({
  engine,
  runtime,
  optimisticStatus,
  sandboxStatus,
}: {
  engine: ChatEngine;
  runtime: CodexRuntimeView | null;
  optimisticStatus: "starting" | "running" | null;
  sandboxStatus: CodexSandboxStatus | null;
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
  const engineLabel = codexEngineLabel(engine);
  const title = `${engineLabel} is ${meta.label.toLowerCase()}.${sandboxDetail}`;

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-surface-subtle bg-surface px-2.5 py-1 text-[12px] font-medium leading-4 text-ink-muted shadow-[0_1px_3px_rgba(15,15,15,0.04)]"
      title={title}
      aria-label={`${engineLabel} status: ${meta.label}`}
    >
      <span className={cn("size-2 rounded-full", meta.dotClass)} aria-hidden="true" />
      <span>{meta.label}</span>
    </div>
  );
}

type LiveChatMessagesChange = Dispatch<
  SetStateAction<{ sessionId: string; messages: ChatUiMessage[] } | null>
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
  const collections = useMemo(() => createCollections(), []);
  const messagesCollection = useMemo(
    () => collections.chatMessages(sessionId),
    [collections, sessionId],
  );
  const { data: rows, isLoading } = useLiveQuery(
    (q) => q.from({ message: messagesCollection }),
    [messagesCollection],
  );
  const liveMessages = useMemo(() => {
    return ((rows ?? []) as ChatMessageRow[])
      .toSorted((a, b) =>
        compareChatMessageOrder(
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

function LiveCodexChatSessionStatus({
  chatSessionId,
  setRunning,
  setSandboxStatus,
  setRuntime,
}: {
  chatSessionId: string;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setSandboxStatus: Dispatch<SetStateAction<CodexSandboxStatus | null>>;
  setRuntime: Dispatch<SetStateAction<CodexRuntimeView | null>>;
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
  setSandboxStatus: Dispatch<SetStateAction<CodexSandboxStatus | null>>;
  setRuntime: Dispatch<SetStateAction<CodexRuntimeView | null>>;
}) {
  const collections = useMemo(() => createCollections(), []);
  const { data: rows, isLoading } = useLiveQuery((q) =>
    q.from({ codexChatSession: collections.codexChatSessions }),
  );
  const row =
    ((rows ?? []) as CodexChatSessionRow[]).find(
      (candidate) => candidate.chat_session_id === chatSessionId,
    ) ?? null;
  const status = row?.status ?? null;

  useEffect(() => {
    if (isLoading) return;
    setRuntime(
      row
        ? {
            status: row.status,
            activeTurnId: row.active_turn_id,
            error: row.error,
            updatedAt: row.updated_at,
          }
        : null,
    );
    setRunning(isCodexRuntimeActive(row));
  }, [isLoading, row, setRunning, setRuntime, status]);

  useEffect(() => {
    if (!status) {
      setSandboxStatus(null);
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
        } else if (body.status === null) {
          setSandboxStatus(null);
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
  }, [chatSessionId, setSandboxStatus, status]);

  return null;
}

function LiveChatTasks({
  setTasks,
}: {
  setTasks: Dispatch<SetStateAction<readonly TaskView[] | null>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <LiveChatTaskSubscriber setTasks={setTasks} />;
}

function LiveChatTaskSubscriber({
  setTasks,
}: {
  setTasks: Dispatch<SetStateAction<readonly TaskView[] | null>>;
}) {
  const collections = useMemo(() => createCollections(), []);
  const { data: rows } = useLiveQuery((q) => q.from({ task: collections.tasks }));
  const liveTasks = useMemo(() => (rows ?? []).map(taskRowToView), [rows]);

  useEffect(() => {
    setTasks(liveTasks);
  }, [liveTasks, setTasks]);

  return null;
}

function ChatHistoryList({
  chats,
  localChatStates,
  onSelect,
  onArchive,
}: {
  chats: readonly ChatSummaryView[];
  localChatStates: ReadonlyMap<string, ReturnType<typeof chatSummaryState>>;
  onSelect: (chat: ChatSummaryView) => void;
  onArchive: (chat: ChatSummaryView) => void;
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
              <HomeChatStateIndicator
                chat={chat}
                localState={localChatStates.get(chat.id) ?? null}
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

function HomeChatStateIndicator({
  chat,
  localState,
}: {
  chat: ChatSummaryView;
  localState: ReturnType<typeof chatSummaryState> | null;
}) {
  const state = localState ?? chatSummaryState(chat);
  return <ChatStateIndicator state={state} surface="home" showSeen />;
}

function ScheduleRows({ schedules }: { schedules: readonly TaskScheduleView[] }) {
  return schedules.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} />);
}

function ScheduleRow({ schedule }: { schedule: TaskScheduleView }) {
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
      const result = await updateTaskScheduleAction(schedule.id, {
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
                const result = await runTaskScheduleNowAction(schedule.id);
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
                const result = await setTaskScheduleEnabledAction(schedule.id, !schedule.enabled);
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
                const result = await deleteTaskScheduleAction(schedule.id);
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
}: {
  items: readonly TaskView[];
  onArchiveTask: (task: TaskView) => void;
}) {
  return items.map((task) => <ResultRow key={task.id} task={task} onArchive={onArchiveTask} />);
}

function taskRowToView(row: TaskRow): TaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    sessionId: row.session_id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    workflowId: row.workflow_id,
    reportedOutcome: row.reported_outcome,
    outcomeComment: row.outcome_comment,
    workflowSteps: deriveTaskWorkflowSteps({
      harnessSpec: row.harness_spec,
      taskStatus: row.status,
    }),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatMessageRowToUiMessage(row: ChatMessageRow): ChatUiMessage {
  return toChatUiMessage({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    taskId: row.task_id,
    debugTrace: row.debug_trace as StoredChatMessage["debugTrace"],
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

function ResultRow({ task, onArchive }: { task: TaskView; onArchive: (task: TaskView) => void }) {
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

function ModelPicker({
  value,
  onChange,
  disabled,
  codexConnected = false,
  claudeCodeConnected = false,
  autoModelRoutingEnabled = false,
}: {
  value: ChatModelSelection;
  onChange: (modelId: ChatModelSelection) => void;
  disabled: boolean;
  codexConnected?: boolean;
  claudeCodeConnected?: boolean;
  autoModelRoutingEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isAutoSelected = value === AUTO_MODEL_SELECTION;
  const isCodexSelected = value === CODEX_PICKER_VALUE;
  const isClaudeSelected = value === CLAUDE_PICKER_VALUE;
  const isEngineSelected = isCodexSelected || isClaudeSelected;
  const selectedModel =
    !isAutoSelected && !isEngineSelected ? (findModel(value) ?? findModel(DEFAULT_MODEL)) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Model"
        disabled={disabled}
        className="mb-px flex h-7 max-w-[170px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium leading-none text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        {isAutoSelected ? (
          <Sparkles size={13} strokeWidth={1.9} className="shrink-0" />
        ) : isCodexSelected ? (
          <OpenAIIcon size={13} strokeWidth={1.9} className="shrink-0" />
        ) : isClaudeSelected ? (
          <AnthropicIcon size={13} strokeWidth={1.9} className="shrink-0" />
        ) : (
          <ModelProviderIcon
            modelId={selectedModel?.id ?? DEFAULT_MODEL}
            size={13}
            strokeWidth={1.9}
            className="shrink-0"
          />
        )}
        <span className="truncate">
          {isAutoSelected
            ? "Auto"
            : isCodexSelected
              ? "Codex"
              : isClaudeSelected
                ? "Claude Code"
                : (selectedModel?.label ?? "Model")}
        </span>
        <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] bg-surface p-0 text-ink"
      >
        <Command className="bg-surface text-ink">
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[min(320px,calc(100vh-9rem))]">
            <CommandEmpty>No models found.</CommandEmpty>
            {autoModelRoutingEnabled ? (
              <CommandGroup heading="Routing">
                <CommandItem
                  value={AUTO_MODEL_SELECTION}
                  keywords={["Auto", "automatic", "routing", "recommended"]}
                  onSelect={() => {
                    onChange(AUTO_MODEL_SELECTION);
                    setOpen(false);
                  }}
                  title="Choose a model from the first message and keep it for the chat."
                  className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                >
                  <Check
                    size={13}
                    strokeWidth={2}
                    className={cn(
                      "shrink-0 text-ink",
                      isAutoSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <Sparkles size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium leading-4">Auto</div>
                    <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                      Picks once from your first message
                    </div>
                  </div>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {codexConnected || claudeCodeConnected ? (
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
                {claudeCodeConnected ? (
                  <CommandItem
                    value={CLAUDE_PICKER_VALUE}
                    keywords={["Claude", "Claude Code", "cloud", "sandbox", "engine"]}
                    onSelect={() => {
                      onChange(CLAUDE_PICKER_VALUE);
                      setOpen(false);
                    }}
                    title="Chat with Claude Code in a persistent cloud sandbox."
                    className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink data-[selected=true]:bg-surface-hover data-[selected=true]:text-ink"
                  >
                    <Check
                      size={13}
                      strokeWidth={2}
                      className={cn(
                        "shrink-0 text-ink",
                        isClaudeSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <AnthropicIcon
                      size={14}
                      strokeWidth={1.85}
                      className="shrink-0 text-ink-muted"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-4">Claude Code</div>
                      <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                        Cloud Claude Code sandbox
                      </div>
                    </div>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Models">
              {MODELS.map((model) => {
                const isSelected =
                  !isAutoSelected && !isEngineSelected && model.id === selectedModel?.id;
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
                    <ModelProviderIcon
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

function findModel(id: string) {
  return MODELS.find((model) => model.id === id);
}

function ModelProviderIcon({
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
  if (provider === "deepseek") {
    return <DeepSeekIcon size={size} strokeWidth={strokeWidth} className={className} />;
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
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "moonshotai") return "Moonshot";
  if (provider === "openai") return "OpenAI";
  return provider;
}

function SubmitButton({
  disabled,
  isGenerating,
  isStopping = false,
  startsTask = false,
  onStop,
}: {
  disabled: boolean;
  isGenerating: boolean;
  isStopping?: boolean;
  startsTask?: boolean;
  onStop: () => void;
}) {
  if (isStopping) {
    return (
      <button
        type="button"
        aria-label="Stopping task"
        title="Stopping task"
        disabled
        className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-canvas opacity-60"
      >
        <LoaderCircle size={13} strokeWidth={2.2} className="animate-spin" />
      </button>
    );
  }

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
      aria-label={startsTask ? "Start task" : "Send message"}
      title={startsTask ? "Start task" : undefined}
      disabled={disabled}
      className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-canvas transition-opacity duration-150 hover:opacity-90 focus:outline-none disabled:opacity-30"
    >
      {startsTask ? (
        <Play size={13} strokeWidth={2.2} fill="currentColor" />
      ) : (
        <ArrowUp size={15} strokeWidth={2.2} />
      )}
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

async function runBackgroundChatTurn(input: {
  prompt: string;
  model: string;
  newSessionId: string;
  metadata?: ChatMessageMetadata;
}) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: null,
      newSessionId: input.newSessionId,
      model: input.model,
      message: {
        id: newBackgroundChatMessageId(),
        role: "user",
        parts: [{ type: "text", text: input.prompt }],
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    }),
  });

  if (!response.ok) {
    const details = (await response.text().catch(() => "")).trim();
    throw new Error(details || "Could not start that chat.");
  }

  await consumeResponseBody(response);
}

function revokeAttachmentPreviews(attachments: readonly { previewUrl?: string }[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
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

function getTaskMeta(task: TaskView): {
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
      detail: `${recurringPrefix}${task.error ?? STATUS_COPY.failed}`,
      spin: false,
    };
  }
  if (task.status === "canceled") {
    return {
      icon: X,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${task.error ?? STATUS_COPY.canceled}`,
      spin: false,
    };
  }
  if (task.status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      detail: `${recurringPrefix}${firstLine(task.result) ?? STATUS_COPY.succeeded}`,
      spin: false,
    };
  }
  if (task.status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${STAGE_COPY[task.stage]}`,
      spin: false,
    };
  }
  return {
    icon: CircleDotDashed,
    className: "text-amber-500",
    detail: `${recurringPrefix}${STAGE_COPY[task.stage]}`,
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
