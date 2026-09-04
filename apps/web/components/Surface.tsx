"use client";

import { useChat } from "@ai-sdk/react";
import type {
  HarnessEngine,
  TaskReportedOutcome,
  TaskStage,
  TaskStatus,
} from "@opencompany/agent/task-runtime-types";
import {
  CODEX_REASONING_EFFORTS,
  claudeCodeModelSupportsReasoningEffort,
} from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { captureProductEvent } from "@opencompany/analytics/product/client";
import type { ChatEngine as ChatEngine } from "@opencompany/core";
import type { EngineRuntimeStatus, MessageEngine } from "@opencompany/protocol";
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
import {
  AnthropicIcon,
  DeepSeekIcon,
  MoonshotIcon,
  OpenAIIcon,
  XaiIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
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
import { ConversationRuntimeSync } from "@/components/ConversationRuntimeSync";
import {
  buildChatTaskLookup,
  firstVisibleAssistantOutputKind,
} from "@/components/chat/assistant-items";
import {
  ComposerAttachments,
  ComposerDropOverlay,
} from "@/components/chat/ChatComposerAttachments";
import { ChatShareButton } from "@/components/chat/ChatShareButton";
import { ChatTranscriptSyncError } from "@/components/chat/ChatTranscriptSyncError";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PendingActivityIndicator, ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import type { ActionApprovalRequest, CodexToolAction } from "@/components/chat/ToolCallItem";
import { useChatAttachments } from "@/components/chat/useChatAttachments";
import { useCreditBalance } from "@/components/chat/useCreditBalance";
import { useHeadlessChatTranscript } from "@/components/useHeadlessChatTranscript";
import { useHydrated } from "@/components/useHydrated";
import {
  AD_HOC_TASK_ID,
  AD_HOC_TASK_TOKEN,
  descriptionFromAdHocTaskPrompt,
  hasAdHocTaskToken,
} from "@/lib/ad-hoc-task";
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
import { composeChatTranscript } from "@/lib/chat-transcript";
import {
  type ActiveChatTurn,
  deriveChatTurnPhase,
  isChatTurnTerminal,
  isChatTurnWorking,
} from "@/lib/chat-turn-lifecycle";
import {
  type ChatMention,
  type ChatMessageMetadata,
  type ChatSessionView,
  type ChatSummaryView,
  type ChatUiAttachment,
  type ChatUiMessage,
  type ConversationRuntimeView,
  chatSummaryState,
  isChatRuntimeActive,
  textFromChatUiMessage,
} from "@/lib/chat-ui";
import { CHAT_OUT_OF_CREDITS_MESSAGE } from "@/lib/chat-validation";
import {
  type CodexComposerSettingsView,
  DEFAULT_CLAUDE_CHAT_REASONING_EFFORT,
  DEFAULT_CODEX_CHAT_REASONING_EFFORT,
} from "@/lib/codex-chat-settings";
import {
  CLAUDE_CHAT_DEFAULT_MODEL_ID,
  CLAUDE_PICKER_VALUE,
  type ClaudeChatModelId,
  CODEX_CHAT_DEFAULT_MODEL_ID,
  CODEX_PICKER_VALUE,
  type CodexChatModelId,
  ENGINE_REGISTRY,
  type EngineChatKind,
  isCloudCodingEngine,
  normalizeClaudeChatModelId,
  normalizeCodexChatModelId,
  statusPresenter,
} from "@/lib/engine-registry";
import {
  archiveHeadlessTaskSchedule,
  invokeHeadlessWorkflow,
  listHeadlessWorkflowCatalog,
  runHeadlessTaskScheduleNow,
  updateHeadlessTaskSchedule,
} from "@/lib/headless-automation-commands";
import type { TaskScheduleView, WorkflowCatalogItem } from "@/lib/headless-automation-types";
import { uploadHeadlessChatAttachment } from "@/lib/headless-chat-attachment-upload";
import { retryHeadlessChatMessages } from "@/lib/headless-chat-collections";
import {
  cancelHeadlessChatRun,
  resolveEngineQuestions,
  updateHeadlessChatConversation,
} from "@/lib/headless-chat-commands";
import {
  HeadlessChatTransport,
  type HeadlessMessageAccepted,
  startHeadlessBackgroundChat,
} from "@/lib/headless-chat-transport";
import { listHeadlessSkillCatalog } from "@/lib/headless-knowledge-commands";
import { getHeadlessTasks, taskReadModelToRow } from "@/lib/headless-task-collections";
import {
  archiveHeadlessTask,
  cancelHeadlessTaskRun,
  createHeadlessTask,
  createHeadlessTaskComment,
  newHeadlessTaskCommentId,
} from "@/lib/headless-task-commands";
import { isRecentChatActivity, isRecentHomeActivity } from "@/lib/home-activity";
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
import {
  addOptimisticChatSummary,
  removeOptimisticChatSummary,
} from "@/lib/optimistic-chat-summaries";
import type { SkillCatalogItem } from "@/lib/skills";
import type { TaskRow } from "@/lib/task-collections";
import { STAGE_COPY, STATUS_COPY } from "@/lib/task-display";
import { deriveTaskWorkflowSteps, type TaskWorkflowStepView } from "@/lib/task-workflow-activity";
import { updateTimezoneAction } from "@/lib/user-preferences";

const TEXTAREA_MAX_HEIGHT_PX = 128;
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
const CHAT_THREAD_MIN_BOTTOM_PADDING_PX = 160;
const CHAT_THREAD_COMPOSER_GAP_PX = 20;
const BACKGROUND_CHAT_PROMPT_MAX_LENGTH = 10_000;
const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
const CODEX_GOAL_TOKEN_BUDGET_MAX = 2_000_000;
const CODEX_MENTION: ChatMention = { kind: "engine", id: "codex" };
const CLAUDE_MENTION: ChatMention = { kind: "engine", id: "claude" };
const CLOUD_CODEX_ATTACHMENT_CAPABILITIES = { images: true, pdf: true } as const;
const COMPOSER_MENTION_CHIP_CLASS =
  "rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]";

type ActiveMentionToken = {
  start: number;
  end: number;
  query: string;
  // "@" opens engine mentions, "/" opens Skills, and "#" opens tasks/workflows.
  sigil: "@" | "/" | "#";
};

type PendingChatFirstOutputMeasurement = {
  startedAt: number;
  workspaceId: string;
  conversationId: string;
  runId: string | null;
  assistantMessageId: string | null;
  engine: ChatEngine;
  selectedModel: string;
  isNewSession: boolean;
  sandboxStatusAtSend: EngineRuntimeStatus | "not_applicable" | "not_created" | "unknown";
  sendSource: "composer" | "plan_implementation";
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

function engineChatKindFromChat(
  chat: { engine?: ChatEngine } | null | undefined,
): EngineChatKind | null {
  return isCloudCodingEngine(chat?.engine) ? chat.engine : null;
}

function chatModelSelectionFromEngineMention(
  mention: ChatMention | null | undefined,
): ChatModelSelection | null {
  if (!mention || mention.kind !== "engine") return null;
  if (mention.id === "codex") return CODEX_PICKER_VALUE;
  if (mention.id === "claude") return CLAUDE_PICKER_VALUE;
  return null;
}

function shareSubjectForActiveChat(input: { isTask: boolean; engine?: ChatEngine | null }): string {
  if (input.isTask) return "task run";
  if (isCloudCodingEngine(input.engine)) return `${ENGINE_REGISTRY[input.engine].label} chat`;
  return "chat";
}

export type TaskView = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
  model: string;
  engine?: HarnessEngine;
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
  activeRunId?: string | null;
};

// The chat identity Surface hands to a host when its selection changes locally
// (route adoption, sidebar/command-palette switches, going home). Mirrors the
// shape openChat() accepts.
export type SurfaceChatSelection = {
  id: string;
  model: string;
  engine?: ChatEngine;
  codexComposerSettings?: CodexComposerSettings | null;
  runtime?: ConversationRuntimeView | null;
} | null;

export function Surface({
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
  workspaceId = "",
  userName = "there",
  userWorkosId = "",
  taskConversation = null,
  readOnlyNotice = null,
  isActivePane = true,
  onActivate,
  onOpenChat,
  onClosePane,
  onConversationResolved,
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
  workspaceId?: string;
  userName?: string;
  // Scopes chat attachment uploads; attachments are disabled when absent.
  userWorkosId?: string;
  // Task details reuse the canonical Conversation surface with additional Task metadata.
  taskConversation?: TaskConversation | null;
  // Bounded compatibility views may reuse transcript rendering without enabling mutations.
  readOnlyNotice?: string | null;
  // Pane contract: lets a multi-instance host (e.g. a split-pane workspace) mount
  // several Surfaces safely. Defaults reproduce today's single-instance behavior
  // exactly, so existing call sites are unaffected.
  //
  // Only the active pane reacts to global keyboard shortcuts (Cmd/Ctrl+K, Escape),
  // the Home-navigation event, window-level attachment drops, and route-driven
  // chat changes. Inactive panes ignore all of these so several mounted Surfaces
  // never fight over global input or the browser URL.
  isActivePane?: boolean;
  // Called when the user interacts with this pane in a way that should make it
  // the active one (e.g. focusing or clicking inside it).
  onActivate?: () => void;
  // Called whenever this Surface's chat selection changes locally, so a host can
  // keep a pane -> chat mapping in sync.
  onOpenChat?: (chat: SurfaceChatSelection) => void;
  // Called instead of Surface's own "go home" navigation when the user closes
  // this pane's chat. Detaches the view without cancelling an active durable
  // Run; stopping work remains an explicit Stop action. When omitted, Surface
  // falls back to its current single-instance close behavior.
  onClosePane?: () => void;
  // Called when an optimistic chat id resolves to its durable id, so a host can
  // update its pane -> chat mapping and, if this pane is focused, the URL.
  onConversationResolved?: (resolution: { optimisticId: string; durableId: string }) => void;
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
  const pendingTaskCommentRef = useRef<{ id: string; body: string } | null>(null);
  const backgroundTaskFocusOriginRef = useRef<Element | null>(null);
  const onboardingKickoffReadRef = useRef(false);
  const onboardingKickoffPromptRef = useRef<string | null>(null);
  const activeTurnRef = useRef<ActiveChatTurn | null>(null);
  const pendingChatFirstOutputRef = useRef<PendingChatFirstOutputMeasurement | null>(null);
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
    if (engine) return ENGINE_REGISTRY[engine].pickerValue;
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
  // The selected model for each engine, keyed so a send reads the active engine's model
  // without a per-engine branch (a third engine reads its own model, not Claude's).
  const engineChatModel: Record<EngineChatKind, CodexChatModelId | ClaudeChatModelId> = {
    codex: codexModel,
    claude_code: claudeModel,
  };
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
  const [codingSandboxStatus, setCodingSandboxStatus] = useState<EngineRuntimeStatus | null>(null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntimeView | null>(
    initialChat?.runtime ?? null,
  );
  const conversationRunning = isChatRuntimeActive(conversationRuntime);
  const [engineSubmitting, setEngineSubmitting] = useState(false);
  const [backgroundTaskSubmitting, setBackgroundTaskSubmitting] = useState(false);
  const [taskCommentSubmitting, setTaskCommentSubmitting] = useState(false);
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
  const [activeTurn, setActiveTurn] = useState<ActiveChatTurn | null>(null);
  const [surfaceMountedAtMs] = useState(() => Date.now());
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
  const workflowMentionsEnabled = taskSpawningEnabled && !activeTaskConversation;
  const readOnly = readOnlyNotice !== null;
  const skillMentionsEnabled = !readOnly && !activeTaskConversation;
  const activeSelectedMentions = selectedMentions.filter((mention) => {
    if (activeTaskConversation) return false;
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
  const isCodexMode = chatModel === CODEX_PICKER_VALUE;
  const isClaudeMode = chatModel === CLAUDE_PICKER_VALUE;
  const selectedEngine: EngineChatKind | null = isCodexMode
    ? "codex"
    : isClaudeMode
      ? "claude_code"
      : null;
  // `&` is a shortcut from the global composer, even when it is typed inside an
  // existing Conversation. Base it on Home's remembered selection and let only
  // an explicit engine mention override that clean starting point.
  const backgroundHomeModel = chatSessionId ? rememberedChatModel : baseChatModel;
  const backgroundLaunchSelection = backgroundInputDirective
    ? resolveBackgroundChatLaunchSelection({
        directive: backgroundInputDirective,
        mentions: activeSelectedMentions,
        homeModel: backgroundHomeModel,
      })
    : null;
  const composerChatModel = backgroundLaunchSelection?.model ?? chatModel;
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

  const replaceActiveTurn = useCallback((turn: ActiveChatTurn | null) => {
    activeTurnRef.current = turn;
    setActiveTurn(turn);
  }, []);

  const beginActiveTurn = useCallback(
    (measurement: {
      engine: ChatEngine;
      selectedModel: string;
      isNewSession: boolean;
      sandboxStatusAtSend: PendingChatFirstOutputMeasurement["sandboxStatusAtSend"];
      sendSource: PendingChatFirstOutputMeasurement["sendSource"];
    }) => {
      const conversationId = routedChatSessionIdRef.current;
      if (!conversationId) return;
      const turn: ActiveChatTurn = {
        conversationId,
        runId: null,
        assistantMessageId: null,
        startedAtMs: Date.now(),
      };
      pendingChatFirstOutputRef.current = {
        startedAt: performance.now(),
        workspaceId,
        conversationId,
        runId: null,
        assistantMessageId: null,
        ...measurement,
      };
      replaceActiveTurn(turn);
      setLocalChatState(conversationId, "working");
    },
    [replaceActiveTurn, workspaceId],
  );

  const cancelChatFirstOutputMeasurement = useCallback(() => {
    pendingChatFirstOutputRef.current = null;
  }, []);

  const clearLocalActiveTurnState = useCallback((sessionId: string | null | undefined) => {
    clearLocalChatState(sessionId ?? activeTurnRef.current?.conversationId ?? null, "working");
  }, []);

  const clearActiveTurn = useCallback(() => replaceActiveTurn(null), [replaceActiveTurn]);

  const recordOptimisticTurnDuration = useCallback(
    (assistantMessageId: string | null | undefined) => {
      const startedAtMs = activeTurnRef.current?.startedAtMs ?? null;
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

  const handleHeadlessAccepted = useCallback(
    ({ conversationId, runId, assistantMessageId }: HeadlessMessageAccepted) => {
      if (routedChatSessionIdRef.current === conversationId) {
        const pendingMeasurement = pendingChatFirstOutputRef.current;
        if (pendingMeasurement?.conversationId === conversationId) {
          pendingChatFirstOutputRef.current = {
            ...pendingMeasurement,
            runId,
            assistantMessageId,
          };
        }
        const currentTurn = activeTurnRef.current;
        replaceActiveTurn({
          conversationId,
          runId,
          assistantMessageId,
          startedAtMs:
            currentTurn?.conversationId === conversationId ? currentTurn.startedAtMs : Date.now(),
        });
        const optimisticId = pendingNewSessionIdRef.current;
        setPersistedChatSessionId(conversationId);
        if (optimisticId && optimisticId === conversationId) {
          pendingNewSessionIdRef.current = null;
          // Only the active pane owns the browser URL; a host is told about the
          // resolution regardless so it can update its own pane -> chat mapping.
          if (isActivePane) router.replace(chatHref(conversationId), { scroll: false });
          onConversationResolved?.({ optimisticId, durableId: conversationId });
        }
      }
      setEngineSubmitting(false);
    },
    [isActivePane, onConversationResolved, replaceActiveTurn, router],
  );
  const handleHeadlessReconciled = useCallback(
    ({ conversationId }: Pick<HeadlessMessageAccepted, "conversationId">) =>
      removeOptimisticChatSummary(conversationId),
    [],
  );
  const headlessTransport = useMemo(() => new HeadlessChatTransport<ChatUiMessage>(), []);
  useEffect(
    () =>
      headlessTransport.setEventHandlers({
        onAccepted: handleHeadlessAccepted,
        onReconciled: handleHeadlessReconciled,
      }),
    [headlessTransport, handleHeadlessAccepted, handleHeadlessReconciled],
  );
  const { balance: creditBalance, refetch: refetchCreditBalance } = useCreditBalance();
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    resumeStream,
    error: chatError,
    clearError,
  } = useChat<ChatUiMessage>({
    id: chatInstanceKey,
    // useChat holds only this surface's in-flight overlay; persisted history
    // comes from the Electric-synced liveChat state and is merged below.
    resume: Boolean(initialChat && !readOnly),
    // Batch stream chunks into ~20fps UI updates instead of rendering the
    // whole thread on every token.
    experimental_throttle: 50,
    transport: headlessTransport,
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
      recordOptimisticTurnDuration(activeTurnRef.current?.assistantMessageId);
      cancelChatFirstOutputMeasurement();
      clearActiveTurn();
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
    initialChat && !activeTaskConversation && mode === "chat" && chatSessionId === initialChat.id
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
  const activeEngine = activeEngineChat?.engine ?? selectedEngine;
  const isEngineChat = activeEngine !== null;
  // Hard stop: with enforcement on and an empty balance, block new sends
  // before they 402. Codex-engine chats stay exempt, matching the server gate.
  const outOfCredits = Boolean(
    creditBalance && creditBalance.enforcementEnabled && creditBalance.balanceUsdMicros <= 0,
  );
  const backgroundChatDirective = backgroundInputDirective;
  const backgroundDirectiveTargetEngine = backgroundLaunchSelection?.engine ?? null;
  const composerEngine = backgroundChatDirective ? backgroundDirectiveTargetEngine : activeEngine;
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
    modelName: String(composerChatModel),
    // The Cmd+K compose view mounts a second composer with its own window-level drop
    // listener. Keep the main composer visible behind the modal, but let only the quick
    // composer consume dropped files while that view is showing. Inactive panes never
    // claim window-level drops, so several mounted Surfaces don't fight over a drop.
    enabled:
      isActivePane &&
      attachmentsEnabled &&
      !engineSubmitting &&
      !(newChatCommandOpen && commandPaletteView === "compose"),
    ...(composerEngine === "codex" || composerEngine === "claude_code"
      ? { capabilities: CLOUD_CODEX_ATTACHMENT_CAPABILITIES }
      : composerChatModel === AUTO_MODEL_SELECTION
        ? { capabilities: AUTO_MODEL_ATTACHMENT_CAPABILITIES }
        : {}),
    upload: uploadCanonicalAttachment,
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

  // Refetch each catalog when its command menu opens (not once per mount): entries
  // created or edited since the last open must appear, and a transient fetch failure
  // must not blank the menu for the rest of the session — keep the previous catalog
  // and let the next open retry.
  const skillCommandMenuOpen = Boolean(
    userWorkosId && mentionToken?.sigil === "/" && skillMentionsEnabled,
  );
  const workflowMentionMenuOpen = Boolean(
    userWorkosId && mentionToken?.sigil === "#" && workflowMentionsEnabled,
  );
  useEffect(() => {
    if (!skillCommandMenuOpen && !workflowMentionMenuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (skillCommandMenuOpen) {
        void fetchBrainSkillCatalog(controller.signal)
          .then(setSkillCatalog)
          .catch(() => {});
      }
      if (workflowMentionMenuOpen) {
        void fetchBrainWorkflowCatalog(controller.signal)
          .then(setWorkflowCatalog)
          .catch(() => {});
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skillCommandMenuOpen, workflowMentionMenuOpen]);

  const attachmentFileInputRef = useRef<HTMLInputElement>(null);
  const liveTranscriptSessionId =
    mode === "chat" && !readOnly && chatSessionId && persistedChatSessionId === chatSessionId
      ? chatSessionId
      : null;
  const liveChat = useHeadlessChatTranscript(liveTranscriptSessionId);
  // Render list: Electric-synced rows are the source of truth for persisted
  // messages; the useChat overlay contributes only entries Electric has not
  // delivered yet (the in-flight turn and optimistic sends).
  const persistedMessages = useMemo(() => {
    if (!chatSessionId) return [];
    if (liveChat.sessionId === chatSessionId && !liveChat.isLoading) return liveChat.messages;
    if (initialChat && initialChat.id === chatSessionId) return initialChat.messages;
    return [];
  }, [chatSessionId, initialChat, liveChat]);
  const persistedTranscriptLoading = Boolean(
    chatSessionId &&
      persistedChatSessionId === chatSessionId &&
      liveChat.sessionId === chatSessionId &&
      liveChat.isLoading &&
      !(initialChat?.id === chatSessionId && initialChat.messages.length > 0),
  );
  useEffect(() => {
    persistedMessageIdsRef.current = new Set(persistedMessages.map((message) => message.id));
    for (const message of persistedMessages) {
      releaseOptimisticAttachmentPreviews(message.id);
    }
  }, [persistedMessages, releaseOptimisticAttachmentPreviews]);
  const chatMessages = useMemo(() => {
    return composeChatTranscript({
      persistedMessages,
      transientMessages: messages,
      streaming: status === "submitted" || status === "streaming",
    });
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
  const latestActiveTurnStartedAtMs = useMemo(
    () => latestChatTurnStartedAtMs(chatMessages),
    [chatMessages],
  );
  const transportTurn = useMemo<ActiveChatTurn | null>(() => {
    if (activeTurn || !isGenerating || !chatSessionId) return null;
    const assistantMessage = chatMessages.findLast(
      (message) => message.role === "assistant" && Boolean(message.metadata?.runId),
    );
    const runId = assistantMessage?.metadata?.runId;
    if (!assistantMessage || !runId) return null;
    const startedAtMs = chatMessageStartedAtMs(assistantMessage) ?? latestActiveTurnStartedAtMs;
    if (startedAtMs === null) return null;
    return {
      conversationId: assistantMessage.metadata?.sessionId ?? chatSessionId,
      runId,
      assistantMessageId: assistantMessage.id,
      startedAtMs,
    };
  }, [activeTurn, chatMessages, chatSessionId, isGenerating, latestActiveTurnStartedAtMs]);
  const runtimeTurn = useMemo<ActiveChatTurn | null>(() => {
    const activeRunId = conversationRuntime?.activeRunId;
    if (
      activeTurn ||
      transportTurn ||
      !chatSessionId ||
      !activeRunId ||
      !isChatRuntimeActive(conversationRuntime)
    ) {
      return null;
    }
    const run = liveChat.runsById.get(activeRunId);
    const assistantMessage = chatMessages.findLast(
      (message) => message.role === "assistant" && message.metadata?.runId === activeRunId,
    );
    const runtimeUpdatedAtMs = Date.parse(conversationRuntime.updatedAt);
    const startedAtMs =
      (assistantMessage ? chatMessageStartedAtMs(assistantMessage) : null) ??
      latestActiveTurnStartedAtMs ??
      (Number.isFinite(runtimeUpdatedAtMs) ? runtimeUpdatedAtMs : null);
    if (startedAtMs === null) return null;
    return {
      conversationId: chatSessionId,
      runId: activeRunId,
      assistantMessageId: run?.assistantMessageId ?? assistantMessage?.id ?? null,
      startedAtMs,
    };
  }, [
    activeTurn,
    chatMessages,
    chatSessionId,
    conversationRuntime,
    latestActiveTurnStartedAtMs,
    liveChat.runsById,
    transportTurn,
  ]);
  const foregroundTurn = activeTurn ?? transportTurn ?? runtimeTurn;
  const foregroundRun = foregroundTurn?.runId
    ? (liveChat.runsById.get(foregroundTurn.runId) ?? null)
    : null;
  const foregroundAssistantMessageId =
    foregroundTurn?.assistantMessageId ?? foregroundRun?.assistantMessageId ?? null;
  const finalizedAssistantMessage = foregroundAssistantMessageId
    ? (persistedMessages.find((message) => message.id === foregroundAssistantMessageId) ?? null)
    : null;
  const chatTurnPhase = deriveChatTurnPhase({
    runStatus: foregroundRun?.status ?? null,
    finalizedAssistantOutcome: finalizedChatAssistantOutcome(finalizedAssistantMessage),
    runtimeStatus: conversationRuntime?.status ?? null,
    runtimeMatchesTurn: Boolean(
      foregroundTurn?.runId && conversationRuntime?.activeRunId === foregroundTurn.runId,
    ),
    transportStatus: status,
    submitting: engineSubmitting,
  });
  const isForegroundTurnWorking = isChatTurnWorking(chatTurnPhase);
  const isTaskConversationWorking = Boolean(
    !readOnly &&
      activeTaskConversation &&
      !isTaskConversationStopping &&
      (activeTaskConversation.status === "queued" || activeTaskConversation.status === "running"),
  );
  const isAgentWorking = isForegroundTurnWorking || isTaskConversationWorking;
  const isInteractionPending = isAgentWorking || isTaskConversationStopping;
  const activeAssistantMessageId =
    foregroundAssistantMessageId && !isChatTurnTerminal(chatTurnPhase)
      ? foregroundAssistantMessageId
      : isTaskConversationWorking && chatMessages.at(-1)?.role === "assistant"
        ? latestAssistantMessageId
        : null;
  const isBackgroundSubmit = backgroundDirectiveActive || Boolean(selectedWorkflowMention);
  const activeTurnTimerStartedAtMs =
    foregroundTurn?.startedAtMs ??
    latestActiveTurnStartedAtMs ??
    activeTaskConversation?.startedAtMs ??
    (isForegroundTurnWorking ? surfaceMountedAtMs : null);
  const paletteRecentChats = useMemo(
    () => recentChats.filter((chat) => !optimisticallyArchivedChatIds.has(chat.id)),
    [optimisticallyArchivedChatIds, recentChats],
  );
  const paletteChats = useMemo(
    () =>
      [
        ...paletteRecentChats.map((chat) => ({ chat, archived: false })),
        ...archivedChats.map((chat) => ({ chat, archived: true })),
      ].toSorted(
        (a, b) => new Date(b.chat.updatedAt).getTime() - new Date(a.chat.updatedAt).getTime(),
      ),
    [archivedChats, paletteRecentChats],
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
      return;
    }

    const turnFinished = isChatTurnTerminal(chatTurnPhase);
    if (wasAgentWorkingRef.current && turnFinished) {
      recordOptimisticTurnDuration(foregroundAssistantMessageId);
    }
    wasAgentWorkingRef.current = false;
    if (turnFinished && activeTurnRef.current === foregroundTurn) {
      clearActiveTurn();
    }
  }, [
    chatTurnPhase,
    clearActiveTurn,
    foregroundAssistantMessageId,
    foregroundTurn,
    isAgentWorking,
    recordOptimisticTurnDuration,
  ]);

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
  useEffect(() => {
    const pending = pendingChatFirstOutputRef.current;
    if (!pending?.runId || !pending.assistantMessageId) return;

    const assistantMessage = chatMessages.find(
      (message) =>
        message.id === pending.assistantMessageId &&
        message.role === "assistant" &&
        message.metadata?.runId === pending.runId,
    );
    if (!assistantMessage) return;

    const outputKind = firstVisibleAssistantOutputKind(assistantMessage, chatTaskLookup, {
      includeMetadataTaskCard: !Boolean(activeTaskConversation),
    });
    if (!outputKind) return;

    // Passive effects run after React commits the assistant output to the DOM. Clear first so
    // Strict Mode replays and subsequent stream chunks cannot emit a duplicate measurement.
    pendingChatFirstOutputRef.current = null;
    if (!pending.workspaceId) return;
    captureProductEvent("chat_first_output_rendered", {
      workspace_id: pending.workspaceId,
      session_id: pending.conversationId,
      run_id: pending.runId,
      message_id: pending.assistantMessageId,
      engine: pending.engine,
      model: assistantMessage.metadata?.model ?? pending.selectedModel,
      selected_model: pending.selectedModel,
      is_new_session: pending.isNewSession,
      sandbox_status_at_send: pending.sandboxStatusAtSend,
      send_source: pending.sendSource,
      output_kind: outputKind,
      time_to_first_output_ms: Math.max(0, Math.round(performance.now() - pending.startedAt)),
    });
  }, [activeTaskConversation, chatMessages, chatTaskLookup]);
  const activeChatSummary = chatSessionId
    ? (recentChats.find((chat) => chat.id === chatSessionId) ?? null)
    : null;
  const activeChatVisibility =
    activeChatSummary ?? (initialChat?.id === chatSessionId ? initialChat : null);
  useEffect(() => {
    if (!chatSessionId || persistedChatSessionId !== chatSessionId) return;
    const state = isAgentWorking ? "working" : null;
    setLocalChatState(chatSessionId, state);
    return () => {
      if (state !== "working") setLocalChatState(chatSessionId, null);
    };
  }, [chatSessionId, isAgentWorking, persistedChatSessionId]);

  useEffect(() => {
    if (mode !== "chat" || !chatSessionId || persistedChatSessionId !== chatSessionId) {
      return;
    }
    if (activeChatVisibility?.activityState !== "idle" || activeChatVisibility.hasUnseen !== true) {
      lastSeenMarkRef.current = null;
      return;
    }

    const markKey = `${chatSessionId}:${activeChatVisibility.updatedAt ?? "initial"}`;
    const markSeenIfVisible = () => {
      if (document.visibilityState === "hidden" || lastSeenMarkRef.current === markKey) return;
      lastSeenMarkRef.current = markKey;
      void updateHeadlessChatConversation(chatSessionId, { markSeen: true }).catch((error) => {
        if (lastSeenMarkRef.current === markKey) lastSeenMarkRef.current = null;
        console.warn("Could not mark the active chat as seen.", error);
      });
    };
    markSeenIfVisible();
    document.addEventListener("visibilitychange", markSeenIfVisible);
    return () => document.removeEventListener("visibilitychange", markSeenIfVisible);
  }, [
    activeChatVisibility?.activityState,
    activeChatVisibility?.hasUnseen,
    activeChatVisibility?.updatedAt,
    chatSessionId,
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
    (chat: SurfaceChatSelection) => {
      cancelChatFirstOutputMeasurement();
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
      setCodingSandboxStatus(null);
      setConversationRuntime(chat?.runtime ?? null);
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
      onOpenChat?.(chat);
    },
    [
      applyCodexComposerUiState,
      cancelChatFirstOutputMeasurement,
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
      onOpenChat,
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
    // Inactive panes don't own the URL, so a route change caused by focusing a
    // different pane must not silently swap this pane's chat out from under it.
    if (!isActivePane) return;
    const frame = requestAnimationFrame(() => {
      lastInitialChatIdRef.current = initialChatId;
      if (initialChatId === chatSessionId) return;
      openChat(initialChat ?? null);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatSessionId, initialChat, initialChatId, isActivePane, openChat]);

  useEffect(() => {
    if (!isActivePane) return;
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
  }, [clearComposerAttachments, isActivePane, openChat]);

  useEffect(() => {
    if (!isActivePane) return;
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
  }, [isActivePane]);

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
    if (!isActivePane) return;
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
  }, [isActivePane]);

  const archiveTask = (task: TaskView) => {
    setOptimisticallyArchivedIds((current) => new Set(current).add(task.id));
    startArchiveTransition(async () => {
      try {
        await archiveHeadlessTask(task.id, { scopeKey: workspaceId });
        return;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not archive task.");
      }

      setOptimisticallyArchivedIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    });
  };

  const archiveChat = (chat: ChatSummaryView) => {
    setOptimisticallyArchivedChatIds((current) => new Set(current).add(chat.id));
    startArchiveTransition(async () => {
      try {
        const result = await updateHeadlessChatConversation(chat.id, { archived: true }).then(
          () => ({ ok: true, error: null }),
        );
        if (result.ok) {
          router.refresh();
          return;
        }
        toast.error(result.error ?? "Could not archive chat.");
      } catch {
        toast.error("Could not archive chat.");
      }

      setOptimisticallyArchivedChatIds((current) => {
        const next = new Set(current);
        next.delete(chat.id);
        return next;
      });
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
        // The canonical conversation reader only serves open sessions, so the archived chat must
        // be reopened before navigation or the page would render empty.
        const result = await updateHeadlessChatConversation(chat.id, { archived: false }).then(
          () => ({ ok: true, error: null }),
        );
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
    if (readOnly) return;
    const rawPrompt = pendingProgrammaticPromptRef.current ?? input;
    const prompt = rawPrompt.trim();
    pendingProgrammaticPromptRef.current = null;
    if (activeTaskConversation) {
      if (isTaskConversationWorking || taskCommentSubmitting || !prompt) return;
      const command =
        pendingTaskCommentRef.current?.body === rawPrompt
          ? pendingTaskCommentRef.current
          : { id: newHeadlessTaskCommentId(), body: rawPrompt };
      pendingTaskCommentRef.current = command;
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      setTaskCommentSubmitting(true);
      void createHeadlessTaskComment(activeTaskConversation.taskId, command, {
        scopeKey: workspaceId,
      })
        .then(() => {
          if (!mountedRef.current) return;
          pendingTaskCommentRef.current = null;
          router.refresh();
          toast.success("Comment posted. The task is running again.");
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          if (!inputRef.current?.value) setInput(rawPrompt);
          toast.error(error instanceof Error ? error.message : "Could not post the comment.");
        })
        .finally(() => {
          if (mountedRef.current) setTaskCommentSubmitting(false);
        });
      return;
    }
    const backgroundChat = parseBackgroundChatDirective(prompt);
    const backgroundLaunch = backgroundChat
      ? resolveBackgroundChatLaunchSelection({
          directive: backgroundChat,
          mentions: activeSelectedMentions,
          homeModel: backgroundHomeModel,
        })
      : null;
    const backgroundEngine = backgroundLaunch?.engine ?? null;
    const backgroundModel = backgroundLaunch?.model ?? chatModel;
    if ((isInteractionPending && !isBackgroundSubmit) || backgroundTaskSubmitting) return;
    if (outOfCredits && !(backgroundChat ? backgroundEngine : activeEngine)) {
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

    const messagePrompt = backgroundChat?.prompt ?? prompt;
    if (!messagePrompt && readyAttachments.length === 0) return;

    const mentions = activeSelectedMentions.filter((mention) =>
      chatMentionIsVisible(messagePrompt, mention),
    );
    // previewUrl stays in the optimistic bubble; the canonical transport sends only opaque
    // attachment ids to the API.
    const attachmentsMetadata = readyAttachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.blobUrl ? { blobUrl: attachment.blobUrl } : {}),
      ...(attachment.blobPathname ? { blobPathname: attachment.blobPathname } : {}),
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
      const restoreDraftIfComposerIsEmpty = () => {
        if (inputRef.current?.value.trim()) return;
        restoreDraft();
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
          model: String(backgroundModel),
          workspaceId,
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
          workspaceId,
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
        composerAttachments.setAttachments([]);
        refocusMainComposerAfterBackgroundTask();
        toast("Started a new chat in the background.");

        const engine = backgroundEngine;
        const config = ENGINE_REGISTRY[engine];
        const newSessionId = newOptimisticChatSessionId();
        addOptimisticChatSummary({
          workspaceId,
          sessionId: newSessionId,
          prompt: messagePrompt,
          model: String(backgroundModel),
          engine,
        });
        setLocalChatState(newSessionId, "working");
        void runBackgroundChatTurn({
          prompt: messagePrompt,
          newSessionId,
          model: chatSessionId ? ENGINE_REGISTRY[engine].defaultModelId : engineChatModel[engine],
          engine: canonicalMessageEngine(engine, settings.settings),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        })
          .then(({ completion }) => {
            revokeAttachmentPreviews(pendingAttachments);
            void completion
              .then(() => {
                if (!mountedRef.current) return;
                router.refresh();
                toast.success(`${config.label} is ready.`);
              })
              .catch(() => {
                if (!mountedRef.current) return;
                router.refresh();
                toast.error(`${config.label} started, but live status updates were interrupted.`);
              })
              .finally(() => clearLocalChatState(newSessionId, "working"));
          })
          .catch((error) => {
            removeOptimisticChatSummary(newSessionId);
            clearLocalChatState(newSessionId, "working");
            if (!mountedRef.current) return;
            restoreDraftIfComposerIsEmpty();
            toast.error(
              error instanceof Error ? error.message : `${config.label} could not start that turn.`,
            );
          });
        return;
      }

      clearComposerDraft(chatSessionId);
      clearError();
      setInput("");
      setMentionToken(null);
      setSelectedMentions([]);
      prepareMainComposerFocusRestoreAfterBackgroundTask();
      composerAttachments.setAttachments([]);
      refocusMainComposerAfterBackgroundTask();
      toast("Started a new chat in the background.");

      const newSessionId = newOptimisticChatSessionId();
      addOptimisticChatSummary({
        workspaceId,
        sessionId: newSessionId,
        prompt: messagePrompt,
        model: String(backgroundModel),
        engine: "opencompany",
      });
      setLocalChatState(newSessionId, "working");
      void runBackgroundChatTurn({
        prompt: messagePrompt,
        model: String(backgroundModel),
        newSessionId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      })
        .then(({ completion }) => {
          revokeAttachmentPreviews(pendingAttachments);
          void completion
            .then(() => {
              if (!mountedRef.current) return;
              router.refresh();
              toast.success("Background chat is ready.");
            })
            .catch(() => {
              if (!mountedRef.current) return;
              router.refresh();
              toast.error("Background chat started, but live status updates were interrupted.");
            })
            .finally(() => clearLocalChatState(newSessionId, "working"));
        })
        .catch((error) => {
          removeOptimisticChatSummary(newSessionId);
          clearLocalChatState(newSessionId, "working");
          if (!mountedRef.current) return;
          restoreDraftIfComposerIsEmpty();
          toast.error(error instanceof Error ? error.message : "Could not start that chat.");
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
        workspaceId,
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
        workspaceId,
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
    let messageEngine: MessageEngine = { type: "opencompany", schemaVersion: 1 };
    let model: ChatModelSelection | CodexChatModelId | ClaudeChatModelId = chatModel;
    let engineSettings: EngineComposerSettings | null = null;
    if (activeEngine) {
      const settings =
        activeEngine === "claude_code"
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
      engineSettings = settings.settings;
      messageEngine = canonicalMessageEngine(activeEngine, settings.settings);
      model = engineChatModel[activeEngine];
    }
    const metadata: ChatMessageMetadata = {
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(attachmentsMetadata.length > 0 ? { attachments: attachmentsMetadata } : {}),
    };
    const message =
      Object.keys(metadata).length > 0 ? { text: prompt, metadata } : { text: prompt };
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
      onOpenChat?.({
        id: newSessionId,
        model: String(model),
        engine: activeEngine ?? "opencompany",
      });
    }
    if (newSessionId) {
      addOptimisticChatSummary({
        workspaceId,
        sessionId: newSessionId,
        prompt,
        model: String(model),
        engine: activeEngine ?? "opencompany",
      });
    }
    if (activeEngine) {
      const activeSessionId = requestSessionId ?? newSessionId;
      if (activeSessionId) {
        setEngineChatSession({ engine: activeEngine, chatSessionId: activeSessionId });
        if (engineSettings) {
          setCodexComposerStateByChatId((current) => {
            const next = new Map(current);
            next.set(activeSessionId, codexComposerUiStateFromSettings(engineSettings));
            return next;
          });
        }
      }
      setEngineSubmitting(true);
      setCodexPlanModeEnabled(false);
      setCodexGoalModeEnabled(false);
      setCodexGoalObjective("");
      setCodexGoalTokenBudget("");
    }
    clearComposerDraft(chatSessionId);
    beginActiveTurn({
      engine: messageEngine.type,
      selectedModel: String(model),
      isNewSession: Boolean(newSessionId),
      sandboxStatusAtSend:
        messageEngine.type === "opencompany"
          ? "not_applicable"
          : newSessionId
            ? "not_created"
            : (codingSandboxStatus ?? "unknown"),
      sendSource: "composer",
    });
    // Clear without revoking previews: the optimistic bubble still shows them.
    composerAttachments.setAttachments([]);
    void sendMessage(message, {
      body: {
        sessionId: requestSessionId,
        newSessionId,
        model,
        engine: messageEngine,
      },
    }).catch((error) => {
      setEngineSubmitting(false);
      if (newSessionId) removeOptimisticChatSummary(newSessionId);
      const requestChatSessionId = requestSessionId ?? newSessionId;
      clearLocalActiveTurnState(requestChatSessionId);
      cancelChatFirstOutputMeasurement();
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

  const handleActionApproval = async ({ approvalId, action, decision }: ActionApprovalRequest) => {
    if (decision === "accept_always") {
      const saved = await alwaysAllowChatActionAction(action).catch(() => null);
      if (!saved?.ok) {
        // The one-off approval still goes through; only the standing
        // permission failed to save.
        toast.error("Could not save the permission. Running this action once.");
      }
    }
    const approvalMessage = chatMessages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) =>
            "approval" in part &&
            part.approval &&
            typeof part.approval === "object" &&
            "id" in part.approval &&
            part.approval.id === approvalId,
        ),
    );
    const runId = approvalMessage?.metadata?.runId;
    if (!approvalMessage || !runId) {
      throw new Error("The durable Run for this approval is no longer available.");
    }
    await headlessTransport.resolveApproval({
      chatId: chatInstanceKey,
      approvalId,
      approved: decision !== "decline",
      runId,
      assistantMessageId: approvalMessage.id,
      ...(approvalMessage.metadata?.model ? { model: approvalMessage.metadata.model } : {}),
    });
    await resumeStream();
  };

  const handleCodexToolAction = async (action: CodexToolAction) => {
    if (action.type === "answer-question") {
      const runId = foregroundTurn?.runId ?? conversationRuntime?.activeRunId;
      if (!runId) throw new Error("The active coding Run is no longer available.");
      await resolveEngineQuestions(runId, action.interactionId, action.answers);
      return;
    }

    if (action.type === "continue-plan") {
      setCodexPlanModeEnabled(true);
      inputRef.current?.focus();
      return;
    }

    if (isForegroundTurnWorking) {
      throw new Error("Wait for the current Codex turn to finish.");
    }
    const engine = activeEngineChat?.engine;
    const sessionId = activeEngineChat?.chatSessionId;
    if (!engine || !sessionId) throw new Error("This Codex session is no longer available.");
    const prompt = "Implement the plan.";
    const settings: CodexComposerSettings = {
      reasoningEffort: codexReasoningEffort,
      planModeEnabled: false,
      goalMode: null,
    };

    clearError();
    beginActiveTurn({
      engine,
      selectedModel: engineChatModel[engine],
      isNewSession: false,
      sandboxStatusAtSend: codingSandboxStatus ?? "unknown",
      sendSource: "plan_implementation",
    });
    setEngineSubmitting(true);
    try {
      setCodexPlanModeEnabled(false);
      setCodexComposerStateByChatId((current) => {
        const next = new Map(current);
        next.set(sessionId, codexComposerUiStateFromSettings(settings));
        return next;
      });
      await sendMessage(
        { text: prompt },
        {
          body: {
            engine: canonicalMessageEngine(engine, settings),
            model: engineChatModel[engine],
            sessionId,
          },
        },
      );
      setChatSessionId(sessionId);
      router.refresh();
    } catch (error) {
      cancelChatFirstOutputMeasurement();
      clearActiveTurn();
      throw error;
    } finally {
      if (mountedRef.current) setEngineSubmitting(false);
    }
  };

  const closeChat = useCallback(() => {
    // A pane-aware host owns detaching this pane and must not have an active
    // Run cancelled just because the pane closed; stopping stays an explicit
    // Stop action. Without a host, this is the single-instance "go home" path,
    // which does cancel a foreground turn since there's no other view of it.
    if (onClosePane) {
      onClosePane();
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (isForegroundTurnWorking) {
      clearLocalActiveTurnState(chatSessionId);
      void headlessTransport.cancel(chatInstanceKey).catch(() => {});
      void stop();
    }
    openChat(null);
    router.replace("/");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [
    chatInstanceKey,
    chatSessionId,
    clearLocalActiveTurnState,
    headlessTransport,
    isForegroundTurnWorking,
    onClosePane,
    openChat,
    router,
    stop,
  ]);

  const stopGeneration = useCallback(() => {
    cancelChatFirstOutputMeasurement();
    if (activeTaskConversation) {
      if (isTaskConversationStopping) return;
      const taskId = activeTaskConversation.taskId;
      const runId = activeTaskConversation.activeRunId;
      if (!runId) {
        toast.error("The active Task Run is not available yet.");
        return;
      }
      setStoppingTaskId(taskId);
      void cancelHeadlessTaskRun(runId)
        .then(() => {
          void stop();
        })
        .catch((error) => {
          setStoppingTaskId((current) => (current === taskId ? null : current));
          toast.error(error instanceof Error ? error.message : "Could not stop that task.");
        });
      return;
    }

    if (chatSessionId) {
      const activeRunId = foregroundTurn?.runId ?? conversationRuntime?.activeRunId ?? null;
      clearLocalActiveTurnState(chatSessionId);
      const cancel = activeRunId
        ? cancelHeadlessChatRun(activeRunId)
        : headlessTransport.cancel(chatInstanceKey);
      void cancel.catch(() => {
        const label = activeEngineChat
          ? `interrupt ${ENGINE_REGISTRY[activeEngineChat.engine].label}`
          : "stop that response";
        toast.error(`Could not ${label}.`);
      });
      void stop();
      return;
    }

    const lastAssistantMessage = messages.findLast((message) => message.role === "assistant");
    if (lastAssistantMessage) {
      setLocallyStoppedAssistantMessageIds((current) =>
        new Set(current).add(lastAssistantMessage.id),
      );
    }
    clearLocalActiveTurnState(chatSessionId ?? lastAssistantMessage?.metadata?.sessionId ?? null);
    // Aborting the browser stream is only a disconnect; cancel the durable Run explicitly.
    void headlessTransport.cancel(chatInstanceKey).catch(() => undefined);
    void stop();
  }, [
    activeEngineChat,
    activeTaskConversation,
    chatInstanceKey,
    chatSessionId,
    cancelChatFirstOutputMeasurement,
    clearLocalActiveTurnState,
    conversationRuntime?.activeRunId,
    foregroundTurn?.runId,
    isTaskConversationStopping,
    headlessTransport,
    messages,
    stop,
  ]);

  useEffect(() => {
    if (mode !== "chat" || !isActivePane) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeChat();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeChat, isActivePane, mode]);

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
    if (pendingTaskCommentRef.current?.body !== nextInput) pendingTaskCommentRef.current = null;
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
    <div
      className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden"
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
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
                workspaceId={workspaceId}
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
                {paletteChats.length > 0 ? (
                  <CommandGroup heading="Chats">
                    {paletteChats.map(({ chat, archived }) => (
                      <CommandItem
                        key={chat.id}
                        value={`chat ${archived ? "archived " : ""}${chat.title} ${chat.id}`}
                        onSelect={() => (archived ? restoreAndOpenChat(chat) : jumpToChat(chat))}
                        className="gap-3"
                      >
                        {archived && restoringChatId === chat.id ? (
                          <LoaderCircle
                            size={16}
                            strokeWidth={2}
                            className="shrink-0 animate-spin text-ink-subtle"
                          />
                        ) : archived ? (
                          <Archive size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                        ) : (
                          <MessageSquare
                            size={16}
                            strokeWidth={2}
                            className="shrink-0 text-ink-subtle"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <p className="truncate text-[13px] font-medium text-ink">
                              {chat.title}
                            </p>
                            {archived ? (
                              <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium leading-4 text-ink-subtle">
                                Archived
                              </span>
                            ) : null}
                          </div>
                          {archived ? null : (
                            <p className="truncate text-[12px] text-ink-subtle">{chat.preview}</p>
                          )}
                        </div>
                        {archived ? (
                          <CommandShortcut className="flex items-center gap-1">
                            <RotateCcw size={12} strokeWidth={2} />
                            Restore
                          </CommandShortcut>
                        ) : null}
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
              <div className="flex w-full max-w-[720px] flex-col gap-8 pb-40 pt-16 sm:pt-24">
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
                        <ScheduleRows schedules={homeSchedules} workspaceId={workspaceId} />
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
              <div className="w-full pb-2 pl-2 pr-6 pt-1">
                <div className="flex w-full items-center justify-between gap-3">
                  <ChatTitleHeader
                    title={activeChatTitle}
                    model={activeChatModel}
                    engine={activeChatEngine}
                    isTask={Boolean(activeTaskConversation)}
                  />
                  <div className="flex shrink-0 items-center gap-2">
                    {!readOnly &&
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
                    {activeEngineChat ? (
                      <>
                        <CodingSessionStatusIndicator
                          engine={activeEngineChat.engine}
                          runtime={conversationRuntime}
                          optimisticStatus={
                            engineSubmitting
                              ? "starting"
                              : conversationRunning && !isChatRuntimeActive(conversationRuntime)
                                ? "running"
                                : null
                          }
                          sandboxStatus={codingSandboxStatus}
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
                      compactTrace={isCloudCodingEngine(activeChatEngine)}
                      turnActive={message.id === activeAssistantMessageId}
                    />
                  ))}
                  {isTaskConversationStopping ? (
                    <PendingActivityIndicator label="Stopping task…" />
                  ) : isAgentWorking && activeTurnTimerStartedAtMs !== null ? (
                    <ThinkingIndicator
                      startedAtMs={activeTurnTimerStartedAtMs}
                      label={
                        isEngineChat && activeEngine
                          ? conversationRuntime?.status === "queued"
                            ? `${ENGINE_REGISTRY[activeEngine].label} is queued`
                            : `${ENGINE_REGISTRY[activeEngine].label} is working`
                          : "opencompany is working"
                      }
                    />
                  ) : chatMessages.length === 0 && liveChat.syncFailed ? (
                    <ChatTranscriptSyncError
                      onRetry={() => {
                        if (chatSessionId) void retryHeadlessChatMessages(chatSessionId);
                      }}
                    />
                  ) : chatMessages.length === 0 && persistedTranscriptLoading ? (
                    <PendingActivityIndicator label="Loading conversation…" />
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {mode === "chat" && chatSessionId ? (
            <ConversationRuntimeSync
              conversationId={chatSessionId}
              setSandboxStatus={setCodingSandboxStatus}
              setRuntime={setConversationRuntime}
              pollSandbox={Boolean(activeEngineChat)}
            />
          ) : null}
          {mode === "chat" && taskSpawningEnabled ? (
            <LiveChatTasks workspaceId={workspaceId} setTasks={setLiveChatTasks} />
          ) : null}

          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-canvas via-canvas to-transparent px-6 pb-6 pt-8"
          >
            <div className="pointer-events-auto relative flex w-full max-w-[720px] flex-col gap-2">
              {readOnlyNotice ? (
                <p
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                  role="status"
                >
                  {readOnlyNotice}
                </p>
              ) : !activeTaskConversation && chatSendBlocked ? (
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
              ) : !activeTaskConversation && lowCreditBalance && creditBalance ? (
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
              {activeTaskConversation ? (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-4 text-ink-subtle shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                >
                  <MessageSquare size={13} strokeWidth={2} className="shrink-0" />
                  <span>
                    {isTaskConversationWorking
                      ? "You can comment when the current run finishes."
                      : taskCommentSubmitting
                        ? "Posting your comment…"
                        : "Posting a comment resumes this task."}
                  </span>
                </div>
              ) : selectedAdHocTask ? (
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
                        activeTaskConversation
                          ? "Add a comment…"
                          : mode === "chat"
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
                      disabled={
                        backgroundTaskSubmitting ||
                        taskCommentSubmitting ||
                        isTaskConversationWorking ||
                        readOnly
                      }
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
                  {activeEngine &&
                  isForegroundTurnWorking &&
                  !activeTaskConversation &&
                  !backgroundChatDirective ? (
                    <EngineStopButton
                      label={ENGINE_REGISTRY[activeEngine].label}
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
                      (!isBackgroundSubmit && isForegroundTurnWorking) ||
                      isTaskConversationWorking ||
                      taskCommentSubmitting ||
                      backgroundTaskSubmitting ||
                      voiceDictation.isActive ||
                      readOnly ||
                      (!activeTaskConversation && chatSendBlocked)
                    }
                    isGenerating={
                      isBackgroundSubmit
                        ? false
                        : (!isEngineChat && isForegroundTurnWorking) || isTaskConversationWorking
                    }
                    isStopping={!isBackgroundSubmit && isTaskConversationStopping}
                    startsTask={selectedAdHocTask || Boolean(selectedWorkflowMention)}
                    submitsComment={Boolean(activeTaskConversation)}
                    onStop={stopGeneration}
                  />
                </div>
                <div className="flex items-center gap-1 border-t border-border px-2.5 py-1.5">
                  {activeTaskConversation ? (
                    <span className="min-h-7 px-1 text-[11.5px] leading-7 text-ink-subtle">
                      Comments are sent verbatim to this task.
                    </span>
                  ) : (
                    <>
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
                            disabled={
                              isForegroundTurnWorking || readOnly || voiceDictation.isActive
                            }
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
                          isForegroundTurnWorking ||
                          backgroundTaskSubmitting ||
                          readOnly ||
                          voiceDictation.isActive ||
                          newChatCommandOpen
                        }
                        onClick={voiceDictation.start}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                      >
                        <Mic size={15} strokeWidth={1.9} />
                      </button>
                      <ModelPicker
                        value={composerChatModel}
                        onChange={(model) => {
                          setSelectedMentions((current) =>
                            current.filter((mention) => mention.kind !== "engine"),
                          );
                          setChatModelOverride(model);
                          persistLastChatSelection(userWorkosId, model);
                          if (model === CODEX_PICKER_VALUE && model !== composerChatModel) {
                            setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
                          } else if (model === CLAUDE_PICKER_VALUE && model !== composerChatModel) {
                            setCodexReasoningEffort(DEFAULT_CLAUDE_CHAT_REASONING_EFFORT);
                            setCodexPlanModeEnabled(false);
                            setCodexGoalModeEnabled(false);
                            setCodexGoalObjective("");
                            setCodexGoalTokenBudget("");
                          } else if (
                            model !== CODEX_PICKER_VALUE &&
                            model !== CLAUDE_PICKER_VALUE
                          ) {
                            setCodexPlanModeEnabled(false);
                            setCodexGoalModeEnabled(false);
                            setCodexGoalObjective("");
                            setCodexGoalTokenBudget("");
                          }
                        }}
                        disabled={
                          isForegroundTurnWorking ||
                          Boolean(chatSessionId) ||
                          voiceDictation.isActive ||
                          readOnly
                        }
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
                          disabled={isForegroundTurnWorking || readOnly || voiceDictation.isActive}
                          modelDisabled={
                            isForegroundTurnWorking ||
                            Boolean(activeEngineChat) ||
                            readOnly ||
                            voiceDictation.isActive
                          }
                          onReasoningEffortChange={setCodexReasoningEffort}
                          onPlanModeEnabledChange={setCodexPlanModeEnabled}
                          onGoalModeEnabledChange={setCodexGoalModeEnabled}
                          onGoalObjectiveChange={setCodexGoalObjective}
                          onGoalTokenBudgetChange={setCodexGoalTokenBudget}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
        {mode === "chat" && activeEngineChat ? (
          <CodingWorkspacePanel
            key={activeEngineChat.chatSessionId}
            ref={workspacePanelRef}
            chatSessionId={activeEngineChat.chatSessionId}
            sandboxStatus={codingSandboxStatus}
            engineLabel={ENGINE_REGISTRY[activeEngineChat.engine].label}
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
  workspaceId,
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
  workspaceId: string;
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
  const engineChatModel: Record<EngineChatKind, CodexChatModelId | ClaudeChatModelId> = {
    codex: codexModel,
    claude_code: claudeModel,
  };
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
  const backgroundLaunchSelection = parsedBackgroundChatDirective
    ? resolveBackgroundChatLaunchSelection({
        directive: parsedBackgroundChatDirective,
        mentions: activeSelectedMentions,
        homeModel: baseChatModel,
      })
    : null;
  const composerChatModel = backgroundLaunchSelection?.model ?? chatModel;
  const composerEngine = parsedBackgroundChatDirective
    ? (backgroundLaunchSelection?.engine ?? null)
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
    modelName: String(composerChatModel),
    enabled: attachmentsEnabled && !isSubmitting,
    ...(composerEngine === "codex" || composerEngine === "claude_code"
      ? { capabilities: CLOUD_CODEX_ATTACHMENT_CAPABILITIES }
      : composerChatModel === AUTO_MODEL_SELECTION
        ? { capabilities: AUTO_MODEL_ATTACHMENT_CAPABILITIES }
        : {}),
    upload: uploadCanonicalAttachment,
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

  // Mirrors the main composer: refetch each catalog whenever its menu opens so
  // recently created Skills and workflows show up.
  const skillCommandMenuOpen = Boolean(userWorkosId && mentionToken?.sigil === "/");
  const workflowMentionMenuOpen = Boolean(
    userWorkosId && mentionToken?.sigil === "#" && workflowMentionsEnabled,
  );
  useEffect(() => {
    if (!skillCommandMenuOpen && !workflowMentionMenuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (skillCommandMenuOpen) {
        void fetchBrainSkillCatalog(controller.signal)
          .then(setSkillCatalog)
          .catch(() => {});
      }
      if (workflowMentionMenuOpen) {
        void fetchBrainWorkflowCatalog(controller.signal)
          .then(setWorkflowCatalog)
          .catch(() => {});
      }
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [skillCommandMenuOpen, workflowMentionMenuOpen]);

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
    const backgroundLaunch = backgroundChat
      ? resolveBackgroundChatLaunchSelection({
          directive: backgroundChat,
          mentions: activeSelectedMentions,
          homeModel: baseChatModel,
        })
      : null;
    const backgroundEngine = backgroundLaunch?.engine ?? null;
    const backgroundModel = backgroundLaunch?.model ?? chatModel;
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
      ...(attachment.blobUrl ? { blobUrl: attachment.blobUrl } : {}),
      ...(attachment.blobPathname ? { blobPathname: attachment.blobPathname } : {}),
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
        model: String(backgroundModel),
        workspaceId,
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
        workspaceId,
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

    const targetEngine = isBackgroundChatDirective ? backgroundEngine : selectedEngine;
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
      const config = ENGINE_REGISTRY[engine];
      const newSessionId = newOptimisticChatSessionId();
      addOptimisticChatSummary({
        workspaceId,
        sessionId: newSessionId,
        prompt,
        model: String(backgroundModel),
        engine,
      });
      setLocalChatState(newSessionId, "working");
      void runBackgroundChatTurn({
        prompt,
        newSessionId,
        model: engineChatModel[engine],
        engine: canonicalMessageEngine(engine, settings.settings),
        metadata: {
          ...(attachmentsMetadata.length ? { attachments: attachmentsMetadata } : {}),
          ...(mentions.some(isSkillMention) ? { mentions: mentions.filter(isSkillMention) } : {}),
        },
      })
        .then(({ completion }) => {
          if (mountedRef.current) setIsSubmitting(false);
          void completion
            .then(() => {
              // Not gated on mountedRef: see the workflow branch above.
              router.refresh();
              toast.success(`${config.label} is ready.`);
            })
            .catch(() => {
              router.refresh();
              toast.error(`${config.label} started, but live status updates were interrupted.`);
            })
            .finally(() => clearLocalChatState(newSessionId, "working"));
        })
        .catch((error) => {
          removeOptimisticChatSummary(newSessionId);
          clearLocalChatState(newSessionId, "working");
          toast.error(
            error instanceof Error ? error.message : `${config.label} could not start that turn.`,
          );
          if (mountedRef.current) setIsSubmitting(false);
        });
      return;
    }

    setIsSubmitting(true);
    composerAttachments.clearAttachments();
    onSubmitted();
    toast("Started a new chat in the background.");

    const newSessionId = newOptimisticChatSessionId();
    addOptimisticChatSummary({
      workspaceId,
      sessionId: newSessionId,
      prompt,
      model: String(backgroundModel),
      engine: "opencompany",
    });
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
      model: String(backgroundModel),
      newSessionId,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    })
      .then(({ completion }) => {
        if (mountedRef.current) setIsSubmitting(false);
        void completion
          .then(() => {
            // Not gated on mountedRef: see the workflow branch above.
            router.refresh();
            toast.success("Background chat is ready.");
          })
          .catch(() => {
            router.refresh();
            toast.error("Background chat started, but live status updates were interrupted.");
          })
          .finally(() => clearLocalChatState(newSessionId, "working"));
      })
      .catch((error) => {
        removeOptimisticChatSummary(newSessionId);
        clearLocalChatState(newSessionId, "working");
        toast.error(error instanceof Error ? error.message : "Could not start that chat.");
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
              value={composerChatModel}
              onChange={(model) => {
                // Deliberately not persisted via persistLastChatSelection: this picker
                // only applies to this one quick-compose chat, not the app-wide "last used
                // model" default the main composer reads on its next fresh session.
                setSelectedMentions((current) =>
                  current.filter((mention) => mention.kind !== "engine"),
                );
                setChatModelOverride(model);
                if (model === CODEX_PICKER_VALUE && model !== composerChatModel) {
                  setCodexReasoningEffort(DEFAULT_CODEX_CHAT_REASONING_EFFORT);
                } else if (model === CLAUDE_PICKER_VALUE && model !== composerChatModel) {
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
        isRecentChatActivity(chat.updatedAt),
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

function chatMessageStartedAtMs(message: ChatUiMessage) {
  const createdAt = message.metadata?.timing?.createdAt;
  if (!createdAt) return null;
  const startedAtMs = Date.parse(createdAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function finalizedChatAssistantOutcome(message: ChatUiMessage | null) {
  if (!message || typeof message.metadata?.timing?.durationMs !== "number") return null;
  if (message.metadata.aborted) return "canceled" as const;
  if (message.metadata.error) return "failed" as const;
  return "completed" as const;
}

function latestChatTurnStartedAtMs(messages: readonly ChatUiMessage[]) {
  for (const message of messages.toReversed()) {
    const startedAtMs = chatMessageStartedAtMs(message);
    if (startedAtMs !== null) return startedAtMs;
  }
  return null;
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
    isCloudCodingEngine(chat?.engine)
      ? ENGINE_REGISTRY[chat.engine].defaultReasoningEffort
      : undefined,
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

// Each engine carries a distinct on-the-wire settings shape (Codex has plan/goal mode; Claude
// Code does not), so this stays a per-engine constructor rather than a registry lookup. The
// switch is exhaustive over EngineChatKind, so a new engine surfaces here as a type error.
function canonicalMessageEngine(
  engine: EngineChatKind,
  settings: EngineComposerSettings,
): MessageEngine {
  switch (engine) {
    case "claude_code":
      return {
        type: "claude_code",
        schemaVersion: 1,
        settings: { reasoningEffort: settings.reasoningEffort },
      };
    case "codex":
      return {
        type: "codex",
        schemaVersion: 1,
        settings: {
          reasoningEffort: settings.reasoningEffort,
          ...(settings.planModeEnabled ? { planModeEnabled: true } : {}),
          ...(settings.goalMode ? { goalMode: settings.goalMode } : {}),
        },
      };
  }
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
  if (!token.startsWith("@") && !token.startsWith("/") && !token.startsWith("#")) return null;

  return {
    start,
    end,
    query: token.slice(1).toLowerCase(),
    sigil: token[0] as ActiveMentionToken["sigil"],
  };
}

function chatMentionToken(mention: ChatMention) {
  if (mention.kind === "engine") return mention.id === "claude" ? "@claude" : "@codex";
  if (mention.kind === "workflow") return `#${mention.id}`;
  return `/${mention.id}`;
}

function chatMentionIsVisible(value: string, mention: ChatMention) {
  const token = escapeRegExp(chatMentionToken(mention));
  return new RegExp(`(^|\\s)${token}(?=\\s|$)`, "i").test(value);
}

function hasBackgroundChatDirective(value: string) {
  return value.trimStart().startsWith("&");
}

type BackgroundChatDirective = {
  prompt: string;
  engine: EngineChatKind | null;
};

function parseBackgroundChatDirective(value: string): BackgroundChatDirective | null {
  const trimmedStart = value.trimStart();
  if (!trimmedStart.startsWith("&")) return null;
  const directive = trimmedStart.slice(1).trimStart();
  const engineMatch = directive.match(/^@(codex|claude)(?=\s|$)/i);
  if (!engineMatch) return { prompt: directive, engine: null };
  const engine = engineMatch[1]?.toLowerCase() === "claude" ? "claude_code" : "codex";
  return { prompt: directive.slice(engineMatch[0].length).trimStart(), engine };
}

function resolveBackgroundChatLaunchSelection(input: {
  directive: BackgroundChatDirective;
  mentions: readonly ChatMention[];
  homeModel: ChatModelSelection;
}): { model: ChatModelSelection; engine: EngineChatKind | null } {
  const mentionedModel = chatModelSelectionFromEngineMention(
    input.mentions.find((mention) => mention.kind === "engine"),
  );
  const model = input.directive.engine
    ? ENGINE_REGISTRY[input.directive.engine].pickerValue
    : (mentionedModel ?? input.homeModel);
  const engine =
    model === CODEX_PICKER_VALUE ? "codex" : model === CLAUDE_PICKER_VALUE ? "claude_code" : null;
  return { model, engine };
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
          ? { "data-opencompany-chat-mention": range.mention.kind }
          : { "data-opencompany-chat-directive": "background" })}
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
  for (const match of value.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]{0,79})(?=\s|$)/gi)) {
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

  if (input.token.sigil === "/") {
    if (!input.skillsEnabled) return [];
    const selectedSkillIds = new Set(
      input.selectedMentions.flatMap((mention) => (mention.kind === "skill" ? [mention.id] : [])),
    );
    const options: MentionOption[] = [];
    for (const skill of input.skills) {
      if (selectedSkillIds.has(skill.id)) continue;
      const haystack = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      options.push({
        kind: "skill",
        token: `/${skill.id}`,
        label: skill.name,
        description: skill.description,
        mention: { kind: "skill", id: skill.id },
      });
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
  const skills = await listHeadlessSkillCatalog({
    ...(signal ? { fetch: (input, init) => fetch(input, { ...init, signal }) } : {}),
  });
  return skills.filter(isSkillCatalogItem);
}

async function fetchBrainWorkflowCatalog(signal?: AbortSignal) {
  return listHeadlessWorkflowCatalog({
    ...(signal ? { fetch: (input, init) => fetch(input, { ...init, signal }) } : {}),
  });
}

async function startAdHocTask(input: {
  description: string;
  model: string;
  engine?: "codex";
  workspaceId: string;
}) {
  const data = await createHeadlessTask(
    {
      goal: descriptionFromAdHocTaskPrompt(input.description),
      engine: input.engine ?? "opencompany",
      model: input.model,
    },
    { scopeKey: input.workspaceId },
  );
  return {
    task: {
      id: data.task.id,
      displayId: data.task.displayId,
      name: data.task.name,
    },
  };
}

async function startWorkflowTask(input: {
  workspaceId: string;
  workflow: Extract<ChatMention, { kind: "workflow" }>;
  description: string;
  mentions?: Extract<ChatMention, { kind: "skill" }>[];
  attachments?: ChatUiAttachment[];
}) {
  const payload = await invokeHeadlessWorkflow(
    input.workflow.id,
    {
      description: input.description,
      ...(input.mentions?.length ? { skillIds: input.mentions.map((mention) => mention.id) } : {}),
      ...(input.attachments?.length
        ? { attachmentIds: input.attachments.map((attachment) => attachment.id) }
        : {}),
    },
    { scopeKey: input.workspaceId },
  );
  return {
    task: {
      id: payload.task.id,
      displayId: payload.task.displayId,
      name: payload.task.name,
    },
  };
}

function automationCommandError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function uploadCanonicalAttachment({ file, pendingId }: { file: File; pendingId: string }) {
  return { ...(await uploadHeadlessChatAttachment({ file, pendingId })), canonical: true };
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
  const label = engine ? ENGINE_REGISTRY[engine].label : null;
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

// The composer's per-engine model picker. Each engine's picker takes a distinct model-id type,
// so this is a discriminated union narrowed by a switch rather than a registry lookup.
type EngineModelPickerModel =
  | { engine: "codex"; value: CodexChatModelId; onChange: (model: CodexChatModelId) => void }
  | {
      engine: "claude_code";
      value: ClaudeChatModelId;
      onChange: (model: ClaudeChatModelId) => void;
    };

function renderEngineModelPicker(model: EngineModelPickerModel | null, disabled: boolean) {
  if (!model) return null;
  switch (model.engine) {
    case "codex":
      return <CodexModelPicker value={model.value} disabled={disabled} onChange={model.onChange} />;
    case "claude_code":
      return (
        <ClaudeModelPicker value={model.value} disabled={disabled} onChange={model.onChange} />
      );
  }
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
  model: EngineModelPickerModel | null;
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
      {renderEngineModelPicker(model, modelDisabled)}
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
  const EngineIcon = isCloudCodingEngine(engine) ? ENGINE_REGISTRY[engine].Icon : null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-ink">
      {EngineIcon ? (
        <EngineIcon size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
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

function CodingSessionStatusIndicator({
  engine,
  runtime,
  optimisticStatus,
  sandboxStatus,
}: {
  engine: EngineChatKind;
  runtime: ConversationRuntimeView | null;
  optimisticStatus: "starting" | "running" | null;
  sandboxStatus: EngineRuntimeStatus | null;
}) {
  let meta = statusPresenter(
    engine,
    optimisticStatus
      ? {
          status: optimisticStatus,
          activeRunId: runtime?.activeRunId ?? null,
          hasError: false,
          updatedAt: runtime?.updatedAt ?? "",
        }
      : runtime,
  );
  // A ready session whose sandbox has paused shows as asleep so the green dot never reads as
  // "still running" hours after the last turn. A deleted sandbox stays "Ready": nothing exists
  // anymore and a fresh one starts on the next message.
  if (meta.kind === "ready" && sandboxStatus === "sleeping") {
    meta = {
      ...meta,
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
  const title = `${meta.engineLabel} is ${meta.label.toLowerCase()}.${sandboxDetail}`;

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-surface-subtle bg-surface px-2.5 py-1 text-[12px] font-medium leading-4 text-ink-muted shadow-[0_1px_3px_rgba(15,15,15,0.04)]"
      title={title}
      aria-label={`${meta.engineLabel} status: ${meta.label}`}
    >
      <span className={cn("size-2 rounded-full", meta.dotClass)} aria-hidden="true" />
      <span>{meta.label}</span>
    </div>
  );
}

function LiveChatTasks({
  workspaceId,
  setTasks,
}: {
  workspaceId: string;
  setTasks: Dispatch<SetStateAction<readonly TaskView[] | null>>;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <LiveChatTaskSubscriber workspaceId={workspaceId} setTasks={setTasks} />;
}

function LiveChatTaskSubscriber({
  workspaceId,
  setTasks,
}: {
  workspaceId: string;
  setTasks: Dispatch<SetStateAction<readonly TaskView[] | null>>;
}) {
  const tasks = useMemo(() => getHeadlessTasks(workspaceId), [workspaceId]);
  const { data: rows } = useLiveQuery((q) => q.from({ task: tasks }));
  const liveTasks = useMemo(() => (rows ?? []).map(taskReadModelToRow).map(taskRowToView), [rows]);

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

function ScheduleRows({
  schedules,
  workspaceId,
}: {
  schedules: readonly TaskScheduleView[];
  workspaceId: string;
}) {
  return schedules.map((schedule) => (
    <ScheduleRow key={schedule.id} schedule={schedule} workspaceId={workspaceId} />
  ));
}

function ScheduleRow({
  schedule,
  workspaceId,
}: {
  schedule: TaskScheduleView;
  workspaceId: string;
}) {
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
      try {
        await updateHeadlessTaskSchedule(
          schedule.id,
          {
            expectedVersion: schedule.version,
            name: editName,
            sourceDescription: `${editCron.trim()} - ${editTimezone.trim()}`,
            cron: editCron,
            timezone: editTimezone,
            prompt: editPrompt,
          },
          { scopeKey: workspaceId },
        );
        setIsEditing(false);
      } catch (error) {
        toast.error(automationCommandError(error, "Recurring Task update failed."));
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
                try {
                  const result = await runHeadlessTaskScheduleNow(schedule.id, {
                    scopeKey: workspaceId,
                  });
                  router.push(`/tasks/${encodeURIComponent(result.task.displayId)}`);
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task run failed."));
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
                try {
                  await updateHeadlessTaskSchedule(
                    schedule.id,
                    { expectedVersion: schedule.version, enabled: !schedule.enabled },
                    { scopeKey: workspaceId },
                  );
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task update failed."));
                }
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
                try {
                  await archiveHeadlessTaskSchedule(
                    schedule.id,
                    { expectedVersion: schedule.version },
                    { scopeKey: workspaceId },
                  );
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task archive failed."));
                }
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
    ...(row.engine ? { engine: row.engine } : {}),
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

function ResultRow({ task, onArchive }: { task: TaskView; onArchive: (task: TaskView) => void }) {
  const router = useRouter();
  const meta = getTaskMeta(task);
  const Icon = meta.icon;
  const title = task.name;
  const href = `/tasks/${encodeURIComponent(task.displayId)}`;
  const prefetchTask = () => router.prefetch(href);
  const canArchive =
    Boolean(task.sessionId) &&
    (task.status === "succeeded" || task.status === "failed" || task.status === "canceled");
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
  if (provider === "xai") {
    return <XaiIcon size={size} strokeWidth={strokeWidth} className={className} />;
  }
  return <Sparkles size={size} strokeWidth={strokeWidth} className={className} />;
}

function modelProviderLabel(id: string) {
  const provider = id.split("/")[0] ?? "";
  if (provider === "alibaba") return "Alibaba";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "moonshotai") return "Moonshot";
  if (provider === "openai") return "OpenAI";
  if (provider === "xai") return "SpaceXAI";
  return provider;
}

function SubmitButton({
  disabled,
  isGenerating,
  isStopping = false,
  startsTask = false,
  submitsComment = false,
  onStop,
}: {
  disabled: boolean;
  isGenerating: boolean;
  isStopping?: boolean;
  startsTask?: boolean;
  submitsComment?: boolean;
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
      aria-label={startsTask ? "Start task" : submitsComment ? "Post comment" : "Send message"}
      title={startsTask ? "Start task" : submitsComment ? "Post comment" : undefined}
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
  engine?: MessageEngine;
  metadata?: ChatMessageMetadata;
}) {
  const clientMessageId = newBackgroundChatMessageId();
  return startHeadlessBackgroundChat({
    content: input.prompt,
    clientConversationId: input.newSessionId,
    clientMessageId,
    model: input.model,
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.metadata?.attachments?.length
      ? { attachmentIds: input.metadata.attachments.map((attachment) => attachment.id) }
      : {}),
    ...(input.metadata?.mentions?.length
      ? {
          mentions: input.metadata.mentions.flatMap((mention) =>
            mention.kind === "skill" ? [{ kind: "skill" as const, id: mention.id }] : [],
          ),
        }
      : {}),
  });
}

function revokeAttachmentPreviews(attachments: readonly { previewUrl?: string }[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
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
  if (task.status === "waiting") {
    return {
      icon: AlertCircle,
      className: "text-warning",
      detail: `${recurringPrefix}${task.outcomeComment ?? STATUS_COPY.waiting}`,
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
