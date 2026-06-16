"use client";

import {
  ATTACHMENT_TEXT_MAX_BYTES,
  COMPOSER_PASTE_ATTACHMENT_MIN_CHARS,
  listAddableBuiltinSkills,
  PERMISSION_GROUP_LABELS,
  PROVIDER_PERMISSION_REGISTRY,
  permissionDescriptionFor,
  permissionLabelFor,
  type ResolvedSkillMetadata,
} from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId } from "@opencompany/agent-runtime/types";
import { captureEvent } from "@opencompany/analytics/client";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageCircleQuestion,
  Play,
  Plus,
  ShieldAlert,
  TerminalSquare,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { useCollections } from "@/components/CollectionsProvider";
import { Composer } from "@/components/Composer";
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  AttachmentCard,
  ComposerAttachments,
  ComposerDropOverlay,
  type PendingAttachment,
  toSubmitAttachments,
} from "@/components/composer-attachments";
import { MARKDOWN_COMPONENTS } from "@/components/Markdown";
import { useOptionalPersonalAgent } from "@/components/personal/PersonalAgentContext";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { formatUsdMicros, SessionTopBar } from "@/components/session/SessionTopBar";
import { SlashCommandMenu } from "@/components/session/SlashCommandMenu";
import { shouldAnimateStreamingAppend } from "@/components/sessionStreamingAnimation";
import { useToast } from "@/components/ToastProvider";
import { useComposerAttachments } from "@/components/useComposerAttachments";
import { useHydrated } from "@/components/useHydrated";
import { useSessionStream } from "@/components/useSessionStream";
import { formatElapsed, useElapsedSeconds, WorkingIndicator } from "@/components/WorkingIndicator";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { SessionPageSkeleton } from "@/components/WorkspaceRouteSkeletons";
import {
  abortAgentSession,
  cancelAgentSessionQuestion,
  continueInterruptedSession,
  markSessionSeen,
  resolveToolApproval,
  setAgentSessionModel,
  submitAgentSessionMessage,
  submitAgentSessionQuestionResponse,
} from "@/lib/agent-sessions/actions";
import {
  type AgentSessionDetailPayload,
  fetchAgentSession,
  SESSIONS_QUERY_STALE_TIME_MS,
  sessionQueryKeys,
} from "@/lib/agent-sessions/payload";
import { isToolStepLimitResumable } from "@/lib/agent-sessions/resumable";
import {
  AFTER_SESSION_TOOL_NAME,
  type AssistantTurnPart,
  buildAssistantTurnParts,
  buildBackgroundActivityParts,
  buildSessionDebugTurns,
  isInspectableRuntimeEvent,
  isReasoningInProgress,
  mergeEvents,
  mergeLiveSessionAggregates,
  mergeMessages,
  type RuntimeBrainFileReference,
  type RuntimeEvent,
  type RuntimeQuestionItem,
  type RuntimeToolCall,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";
import {
  DEFAULT_SEND_MODE,
  isSendMode,
  SEND_MODE_STORAGE_KEY,
  SEND_MODES,
  type SendMode,
  sendModeMeta,
} from "@/lib/agent-sessions/send-mode";
import { BRAIN_BASE_PATH, brainHref } from "@/lib/brain/paths";
import { agentRowToListItem, deriveSessionDetailPlaceholder } from "@/lib/collections/selectors";
import { personalPaths } from "@/lib/personal/paths";
import { fetchWorkspaceSkills } from "@/lib/skills/client";
import {
  getSlashContext,
  matchSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "@/lib/slash-commands/registry";
import {
  buildSkillSlashCommands,
  type SkillCommandSource,
} from "@/lib/slash-commands/skill-commands";

// A turn has settled (no more streaming) — trigger an aggregates refresh.
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "aborted", "archived"]);

function buildAttachedSkillCommandSources({
  configSkills,
  workspaceSkills,
  personalSkills = [],
}: {
  configSkills: AgentConfig["skills"];
  workspaceSkills: SkillCommandSource[];
  personalSkills?: ResolvedSkillMetadata[];
}): SkillCommandSource[] {
  const workspaceById = new Map(workspaceSkills.map((skill) => [skill.id, skill]));
  const addableBuiltinById = new Map(listAddableBuiltinSkills().map((skill) => [skill.id, skill]));
  const seen = new Set<string>();
  const sources: SkillCommandSource[] = [];

  const add = (skill: SkillCommandSource) => {
    if (seen.has(skill.id)) return;
    seen.add(skill.id);
    sources.push(skill);
  };

  for (const skill of configSkills ?? []) {
    const workspaceSkill = workspaceById.get(skill.id);
    if (workspaceSkill) {
      add({
        id: workspaceSkill.id,
        name: workspaceSkill.name,
        ...(workspaceSkill.description !== undefined
          ? { description: workspaceSkill.description }
          : {}),
        ...(workspaceSkill.command ? { command: workspaceSkill.command } : {}),
      });
      continue;
    }

    const builtin = addableBuiltinById.get(skill.id);
    if (builtin) {
      add({
        id: builtin.id,
        name: builtin.name,
        description: builtin.description,
        ...(builtin.command ? { command: builtin.command } : {}),
      });
    }
  }

  for (const skill of personalSkills) {
    add({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      ...(skill.command ? { command: skill.command } : {}),
    });
  }

  return sources;
}

// Snapshot statuses where the server snapshot is the authoritative transcript AND no
// turn can still be racing into the Durable Stream — the lease has been released
// (terminal) or the run is durably parked (paused). Safe to tail from the stream's
// current end. Every other status (active OR startup) must replay from "-1": during
// `created`/`provisioning`/`ready` the runner can claim the lease and emit
// `message.created` between when the snapshot was read and when we resolve HEAD, and
// the reducer's `message.completed` is a silent no-op without the matching
// `message.created` in the overlay — the assistant turn would never reach `completed`
// and we'd misrender "Stopped before finishing" once status flips to `awaiting_approval`.
const SETTLED_SNAPSHOT_STATUSES = new Set([
  "completed",
  "failed",
  "aborted",
  "archived",
  "awaiting_approval",
  "awaiting_input",
]);

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

// Wraps an oversized composer paste in a File so it rides the normal attachment pipeline.
// Numbered against the pending attachments so two pastes in one message don't show as
// identically-named chips (uniqueness is guaranteed by the attachment id either way).
export function pastedTextFile(text: string, pending: PendingAttachment[]): File {
  const count = pending.filter((att) => att.filename.startsWith("pasted-text")).length;
  const name = count === 0 ? "pasted-text.txt" : `pasted-text-${count + 1}.txt`;
  return new File([text], name, { type: "text/plain" });
}
const STREAM_APPEND_ANIMATION_MIN_INTERVAL_MS = 120;

// How far from the bottom (in px) before we consider the user "pinned".
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
// Padding above the snapped user message (matches py-6 = 24px of the scroll container).
const SCROLL_TO_TOP_PADDING_PX = 24;
// Space reserved below the active turn, as a fraction of the viewport, so a just-sent
// message can sit near the top with room for the reply to grow into. 1 = a full viewport
// (message pins to the very top, but a short reply leaves a big void below); lower values
// trade top-alignment for less trailing whitespace. 0.5 ≈ the common ChatGPT-style 50dvh.
const LAST_TURN_MIN_HEIGHT_FACTOR = 0.5;

type SessionViewContentProps = {
  detail: AgentSessionDetailPayload;
  workspaceId: string;
  // When the snapshot was last fetched (react-query `dataUpdatedAt`, epoch ms). The
  // stream/snapshot authority rule reads it: an overlay that has delivered nothing
  // since this time AND is behind on durable events is a dead stream's leftovers and
  // must not override the snapshot. Defaults to 0 ("snapshot age unknown"), which
  // keeps the stream authoritative — the pre-existing behavior.
  detailUpdatedAt?: number;
};

type OptimisticUserMessage = SessionMessage & {
  optimisticId: string;
  submittedAtMs: number;
  confirmedMessageId: string | null;
  existingMessageIds: string[];
};

// Tailwind tint for the send button per send-mode, applied only while a run is active. Green =
// Steer (live nudge), amber = Queue, red = Interrupt. Idle sends use the neutral ink button.
const SEND_MODE_BUTTON_CLASS: Record<SendMode, string> = {
  steer: "bg-success text-white hover:bg-success/90",
  queue: "bg-warning text-white hover:bg-warning/90",
  interrupt: "bg-danger text-white hover:bg-danger/90",
};

// Past-tense labels for the quiet caption a mid-run send leaves on the turn it affected. Lowercase
// to sit unobtrusively alongside the muted process rows (Thinking, "2 steps", …).
const SEND_MODE_ROW_LABEL: Record<SendMode, string> = {
  steer: "steered",
  queue: "queued",
  interrupt: "interrupted",
};

// The only color the dezent caption carries is a faint tint on the steering-wheel icon, so the
// mode stays distinguishable at a glance without a loud badge.
const SEND_MODE_ICON_CLASS: Record<SendMode, string> = {
  steer: "text-success",
  queue: "text-warning",
  interrupt: "text-danger",
};

// Steering-wheel glyph for the steer caption (lucide has no wheel) — mirrors the metaphor Hermes
// uses for steering. A ring, a hub, and three spokes; inherits color + size from className.
function SteerWheelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.4" />
      <line x1="12" y1="2.6" x2="12" y2="9.6" />
      <line x1="4" y1="16.5" x2="10" y2="13.2" />
      <line x1="20" y1="16.5" x2="14" y2="13.2" />
    </svg>
  );
}

// Composer control (shown only while a run is active) for choosing how the next message is
// dispatched into the live run. A colored pill + popover; the choice is lifted to SessionView
// state so it can be persisted to localStorage. See lib/agent-sessions/send-mode.ts.
function SendModePicker({
  value,
  onChange,
  open,
  setOpen,
}: {
  value: SendMode;
  onChange: (mode: SendMode) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open, setOpen]);
  const meta = sendModeMeta(value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Send mode: ${meta.label}`}
        className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium transition-colors ${meta.activeClassName}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClassName}`} />
        {meta.label}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
        >
          {SEND_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode.value === value}
              onClick={() => {
                onChange(mode.value);
                setOpen(false);
              }}
              className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-muted ${
                mode.value === value ? "bg-surface-muted" : ""
              }`}
            >
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                <span className={`h-1.5 w-1.5 rounded-full ${mode.dotClassName}`} />
                {mode.label}
              </span>
              <span className="text-[11px] text-ink-muted">{mode.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Lets the deeply-nested ToolCallCard reach the session id (for tool-approval actions)
// without threading a prop through every intermediate render layer.
const ToolApprovalContext = createContext<{ sessionId: string } | null>(null);

export default function SessionView({ sessionId }: { sessionId: string }) {
  // useLiveQuery is client-only and must not run during SSR / the first hydration
  // pass, so until hydrated we render the query view with no collection
  // placeholder — the server markup is the loading skeleton, matching SSR. Once
  // hydrated, SessionViewLive derives an instant placeholder from the synced
  // agent_sessions + agents collections so the session chrome paints with no
  // network round-trip.
  const hydrated = useHydrated();
  if (!hydrated) return <SessionViewQuery sessionId={sessionId} placeholder={null} />;
  return <SessionViewLive sessionId={sessionId} />;
}

// Client-only: derives the instant session-detail placeholder (meta + related
// tree) from the synced collections and hands it to the query view.
function SessionViewLive({ sessionId }: { sessionId: string }) {
  const { agentSessions, agents } = useCollections();
  const { data: sessionRows } = useLiveQuery((q) => q.from({ session: agentSessions }));
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  const placeholder = useMemo(
    () => deriveSessionDetailPlaceholder(sessionId, sessionRows ?? [], agentRows ?? []),
    [sessionId, sessionRows, agentRows],
  );
  return <SessionViewQuery sessionId={sessionId} placeholder={placeholder} />;
}

function SessionViewQuery({
  sessionId,
  placeholder,
}: {
  sessionId: string;
  placeholder: AgentSessionDetailPayload | null;
}) {
  const { workspaceId } = useWorkspaceContext();
  const detailKey = sessionQueryKeys.detail(workspaceId, sessionId);
  const {
    data: detail,
    dataUpdatedAt,
    isPending,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: detailKey,
    // The transcript (messages/events/status) is live from the Durable Stream; this
    // query supplies session meta, related sessions, and the usage/cost aggregates,
    // and is refetched on turn completion to refresh those aggregates.
    queryFn: () => fetchAgentSession(sessionId),
    staleTime: SESSIONS_QUERY_STALE_TIME_MS,
    // Overrides the app-wide `refetchOnWindowFocus: false`: the open session is the
    // one place a stale snapshot actively misleads. If the Durable Stream died while
    // the tab was hidden (see useSessionStream), this focus refetch is what brings
    // back the turn's true outcome — the authority rule in SessionViewContentBody
    // then lets the fresher snapshot beat the dead stream's frozen "running" state.
    refetchOnWindowFocus: true,
    // Instant paint from TanStack DB: while the server detail (transcript history
    // floor + usage/cost aggregates) is in flight, render the session chrome from
    // the synced collections. placeholderData (not initialData) keeps the query
    // un-fresh, so it always fetches the server-only fields and still refetches on
    // the post-turn invalidation.
    placeholderData: placeholder,
  });

  if (!detail && isPending) return <SessionPageSkeleton />;

  if (!detail && error) {
    return (
      <main className="relative flex h-full flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center justify-center px-6">
          <div className="max-w-sm rounded-lg border border-danger-border bg-danger-bg px-5 py-6 text-center">
            <p className="text-[13.5px] font-medium text-danger">Could not load session</p>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
              {error instanceof Error
                ? error.message
                : "Something went wrong loading this session."}
            </p>
            <button
              type="button"
              disabled={isRefetching}
              onClick={() => {
                void refetch();
              }}
              className="mt-4 inline-flex h-7 items-center justify-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRefetching ? "Retrying..." : "Try again"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="relative flex h-full flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center justify-center px-6">
          <div className="max-w-sm rounded-lg border border-dashed border-border bg-surface/45 px-5 py-6 text-center">
            <p className="text-[13.5px] font-medium text-ink">Session not found</p>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
              This session may have been archived or is no longer available.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <SessionViewContent
      key={detail.session.id}
      detail={detail}
      workspaceId={workspaceId}
      detailUpdatedAt={dataUpdatedAt}
    />
  );
}

export function SessionViewContent(props: SessionViewContentProps) {
  return (
    <ToolApprovalContext.Provider value={{ sessionId: props.detail.session.id }}>
      <SessionViewContentBody key={props.detail.session.id} {...props} />
    </ToolApprovalContext.Provider>
  );
}

function SessionViewContentBody({
  detail,
  workspaceId,
  detailUpdatedAt = 0,
}: SessionViewContentProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const surface = useSessionSurface();
  const detailKey = sessionQueryKeys.detail(workspaceId, detail.session.id);
  const { showError, showToast } = useToast();
  const session = detail.session;
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<OptimisticUserMessage[]>([]);
  const [isPending, startTransition] = useTransition();
  // Optimistic per-session model override. The displayed model is this when set, else the
  // persisted session model. Switching is sticky for the session and applies to the next
  // turn — it never interrupts an in-flight run — so this uses its own transition rather
  // than the send path's `isPending`.
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [, startModelTransition] = useTransition();
  // Composer send-mode: how a message is dispatched while a run is already in flight (Steer /
  // Queue / Interrupt). Sticky per device — restored from and persisted to localStorage. Only
  // affects sends made mid-run; idle sends ignore it. See lib/agent-sessions/send-mode.ts.
  // Read once in a lazy initializer (not an effect) so there's no synchronous setState-in-effect;
  // the picker that surfaces this only renders once a run is active, well after hydration, so the
  // SSR-default vs restored-value difference can't cause a hydration mismatch.
  const [sendMode, setSendModeState] = useState<SendMode>(() => {
    if (typeof window === "undefined") return DEFAULT_SEND_MODE;
    const stored = window.localStorage.getItem(SEND_MODE_STORAGE_KEY);
    return isSendMode(stored) ? stored : DEFAULT_SEND_MODE;
  });
  const [sendModeMenuOpen, setSendModeMenuOpen] = useState(false);
  const setSendMode = useCallback((mode: SendMode) => {
    setSendModeState(mode);
    try {
      window.localStorage.setItem(SEND_MODE_STORAGE_KEY, mode);
    } catch {
      // Private mode / storage disabled — keep the in-memory choice for this session.
    }
  }, []);
  const [attachMenuOpen, setAttachMenuOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drag/drop, paste and file-pick attachment handling lives in a shared hook (also used by the
  // home composers). The drop overlay, validation/capability gate and upload lifecycle all come
  // from here. Attaching is always available: text/code files need no model capability (they are
  // inlined as text); the per-file image/PDF gate happens inside the hook.
  const {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    isDragActive,
    handlePasteFiles,
    dragHandlers,
  } = useComposerAttachments({
    workspaceId,
    modelName: session.modelName,
    uploadScope: { kind: "session", sessionId: session.id },
  });
  // Slash-command menu: highlighted item + a per-query dismiss flag (Escape).
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // Caret position, tracked so the slash menu can open on a `/token` mid-message.
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuId = useId();
  const slashCommandInFlightRef = useRef<Set<string>>(new Set());
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // ID of the user message to scroll to the top of the viewport ONCE, right after a
  // send. The reserved space below it is held by CSS (min-height on the last turn),
  // not a JS maintain loop — so there is no per-frame re-pin (no jitter) and the
  // position survives viewport resize. Cleared as soon as the one-shot scroll runs.
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null);
  // Whether the user is "pinned" at the bottom of the scroll container. Drives the
  // streaming bottom-follow.
  const isPinnedAtBottomRef = useRef(true);
  // True only briefly after a genuine USER scroll input (wheel / trackpad / touch).
  // onScroll only updates isPinnedAtBottom while this is set, so it ignores BOTH our own
  // programmatic scrolls (snap + follow) AND layout-driven scroll events (reflow,
  // overflow-anchor) AND non-scroll pointer interactions (clicks/selection). Crucial
  // because with the reserved min-height the snapped position reads as "near the bottom" —
  // a stray non-user scroll there would otherwise flip isPinnedAtBottom on and the follow
  // would yank the message up and out of
  // view. (Keyboard scrolling of this non-focusable container stays a known minor edge.)
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Felt time-to-first-token: stamped at the Send click, resolved when the first
  // streamed delta paints. `isBusy` blocks concurrent turns, so a single timer is safe.
  const pendingTtftRef = useRef<{ startedAt: number; messageId: string | null } | null>(null);
  // Plane B: the live transcript is materialized from the session's Durable Stream
  // (durable rows + transient token deltas) through the shared reducer. `onEvent`
  // resolves the felt-TTFT timer on the first streamed assistant activity.
  const { state: streamState, status: streamStatus } = useSessionStream(session.id, {
    // Seed from the stream's current end only when the snapshot is settled or paused
    // (no in-flight turn AND no startup race window). For active or startup statuses
    // we replay from "-1" — see SETTLED_SNAPSHOT_STATUSES above. Captured at subscribe
    // time inside the hook, so the later terminal-status flip doesn't re-open the stream.
    seedFromEnd: SETTLED_SNAPSHOT_STATUSES.has(detail.session.status),
    onEvent: (event) => {
      const pending = pendingTtftRef.current;
      if (
        pending &&
        (event.type === "message.delta" ||
          event.type === "message.reasoning_delta" ||
          event.type === "message.reasoning_started")
      ) {
        if (pending.messageId) {
          captureEvent("session_first_token", {
            workspace_id: workspaceId,
            agent_id: session.agentId,
            session_id: session.id,
            message_id: pending.messageId,
            model_provider: session.modelProvider,
            model_name: session.modelName,
            ttft_ms: Math.round(performance.now() - pending.startedAt),
            first_token_kind: event.type === "message.delta" ? "text" : "reasoning",
          });
        }
        pendingTtftRef.current = null;
      } else if (pending && event.type === "message.completed") {
        // Turn ended without ever streaming a delta — drop the stuck timer.
        pendingTtftRef.current = null;
      }
    },
  });
  const baseRuntime = useMemo(() => {
    // Server aggregates are the floor. The stream may replay historical events, so only usage/cost
    // events above the loader's high-water mark are layered on top. This gives immediate per-step
    // model/tool/sandbox/delegated usage without double-counting replayed history.
    const aggregates = mergeLiveSessionAggregates(
      {
        usage: detail.usage,
        toolUsage: detail.toolUsage,
        cost: detail.cost,
        currentContextTokens: detail.currentContextTokens,
      },
      streamState.events,
      detail.latestEventId,
    );
    // The Postgres snapshot (`detail`) is the system-of-record floor; the Durable
    // Stream (`streamState`) is the live overlay. Union-merge the two so the
    // transcript paints instantly from the snapshot AND never drops a durable
    // message/event the stream happens to be missing (e.g. a user message that only
    // the best-effort web append publishes, or pre-stream history) — while live
    // deltas still flow.
    //
    // Status/error are scalars, not a union, so they need an explicit authority
    // rule, in two parts:
    //
    // 1. The stream's scalars become authoritative only once it has actually reduced
    //    a status-bearing event (`statusObserved`) — NOT merely once it has emitted
    //    any event. With `seedFromEnd` the stream tails from the current end without
    //    replaying history, so its scalars start at the empty seed (`"created"` /
    //    `null`); a lone token or usage delta would otherwise flip authority to that
    //    seed and momentarily blank out (or wrongly clear) the snapshot's real
    //    status/error — the start-of-session flicker.
    //
    // 2. The stream keeps that authority only while it is NOT provably stale. A
    //    subscription can die (hidden-tab pause/resume race, exhausted retry budget,
    //    zombie connection after sleep) and freeze on its last observed state —
    //    typically "running" mid-turn. Without a staleness check, the focus refetch
    //    bringing the finished turn would be ignored forever (the frozen "thinking"
    //    spinner). The stream is stale exactly when the snapshot has seen a NEWER
    //    durable event (latestEventId beyond the overlay's durable high-water) AND
    //    the stream has delivered nothing since that snapshot was fetched. The
    //    delivery-time clause protects the live path: web/reaper appends ride with
    //    id null, so a healthy stream can be "behind" on durable ids while clearly
    //    ahead in time (e.g. the just-sent user message before the runner's first
    //    durable event) — it stays authoritative. A stale overlay also loses the
    //    per-message merge preference, so a frozen partial assistant message yields
    //    to the snapshot's final content.
    let overlayLatestEventId = 0;
    for (const event of streamState.events) {
      if (typeof event.id === "number" && event.id > overlayLatestEventId) {
        overlayLatestEventId = event.id;
      }
    }
    const streamIsStale =
      detail.latestEventId > overlayLatestEventId &&
      (streamState.lastEventReceivedAt ?? 0) < detailUpdatedAt;
    const streamIsAuthoritative = streamState.statusObserved && !streamIsStale;
    return {
      events: mergeEvents(detail.events, streamState.events),
      messages: streamIsStale
        ? mergeMessages(streamState.messages, detail.messages)
        : mergeMessages(detail.messages, streamState.messages),
      ...aggregates,
      currentStatus: streamIsAuthoritative ? streamState.currentStatus : detail.session.status,
      lastError: streamIsAuthoritative ? streamState.lastError : detail.session.lastError,
    };
  }, [detail, streamState, detailUpdatedAt]);
  const runtime = useMemo(() => {
    const pendingOptimisticMessages = optimisticUserMessages.filter(
      (message) => !hasDurableUserMessage(baseRuntime.messages, message),
    );
    if (pendingOptimisticMessages.length === 0) return baseRuntime;
    return {
      ...baseRuntime,
      messages: mergeMessages(baseRuntime.messages, pendingOptimisticMessages),
      currentStatus: "running",
      lastError: null,
    };
  }, [baseRuntime, optimisticUserMessages]);

  // Once a just-sent optimistic message is backed by its durable server message (which serves the
  // image via /api/attachments), its local object-URL previews are no longer needed: revoke them.
  // Tracked by a ref (not state) so this stays a pure side-effect — the optimistic copy is already
  // hidden from the merged transcript by the `runtime` memo above, so no re-render is needed.
  const revokedOptimisticIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const message of optimisticUserMessages) {
      if (revokedOptimisticIdsRef.current.has(message.optimisticId)) continue;
      if (!hasDurableUserMessage(baseRuntime.messages, message)) continue;
      message.attachments?.forEach((att) => {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      });
      revokedOptimisticIdsRef.current.add(message.optimisticId);
    }
  }, [baseRuntime.messages, optimisticUserMessages]);

  // Revoke any optimistic-message previews still outstanding when the view unmounts (e.g.
  // navigating away right after a send, before the durable message arrives) so they don't leak.
  const optimisticMessagesRef = useRef(optimisticUserMessages);
  useEffect(() => {
    optimisticMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  useEffect(() => {
    return () => {
      for (const message of optimisticMessagesRef.current) {
        message.attachments?.forEach((att) => {
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
        });
      }
    };
  }, []);
  // Full-detail debug snapshot for the "Copy session JSON" affordance. Assembled lazily
  // (only when the button is clicked) so we never stringify the whole transcript on
  // every render. Pulls from the merged `runtime` so it includes live stream state, and
  // carries the raw `modelMessage` per turn plus every runtime event payload verbatim —
  // the highest-fidelity view the client has. The assembled system prompt and tool catalog
  // are built in the runner at request time and are otherwise ephemeral; the runner persists
  // them per turn as a `debug.model_request` event, and the loader surfaces the latest one as
  // the top-level `detail.latestModelRequest` field (those events are kept out of the windowed
  // `events` list — see loadAgentSessionDetailForWorkspace), so we hoist it to top-level fields
  // here for convenience. The transcript is exported as one consolidated entry per user / assistant /
  // tool turn (`buildSessionDebugTurns`) rather than the raw token/tool delta stream, which
  // is far easier to read; each turn still carries its verbatim `modelMessage`.
  const buildSessionDebugSnapshot = () => {
    // Prefer a snapshot from the live event stream (freshest during an active turn); fall back to
    // the dedicated `detail.latestModelRequest` field, which carries the most-recent snapshot even
    // on long sessions whose latest turn falls outside the windowed `events` list (the loader
    // excludes these large snapshots from that window — see loadAgentSessionDetailForWorkspace).
    const latestModelRequest = ([...runtime.events]
      .reverse()
      .find((event) => event.type === "debug.model_request")?.payload ??
      detail.latestModelRequest ??
      undefined) as
      | {
          systemPrompt?: string;
          toolsSentToModel?: unknown;
          deferredToolsNotSent?: unknown;
          // Legacy field names from events persisted before the rename — fall back so older
          // sessions still export their tool snapshot.
          tools?: unknown;
          deferredTools?: unknown;
        }
      | undefined;
    return {
      exportedAt: new Date().toISOString(),
      session: detail.session,
      related: detail.related,
      status: runtime.currentStatus,
      lastError: runtime.lastError,
      systemPrompt: latestModelRequest?.systemPrompt ?? null,
      // `toolsSentToModel` mirrors the tools actually registered in the latest model call;
      // `deferredToolsNotSent` are reachable only via `find_tools` + `use_tool` and are NOT sent to
      // the model. Named explicitly so the withheld set is never misread as injected.
      toolsSentToModel: latestModelRequest?.toolsSentToModel ?? latestModelRequest?.tools ?? null,
      deferredToolsNotSent:
        latestModelRequest?.deferredToolsNotSent ?? latestModelRequest?.deferredTools ?? null,
      usage: runtime.usage,
      toolUsage: runtime.toolUsage,
      cost: runtime.cost,
      turns: buildSessionDebugTurns(runtime.messages),
    };
  };
  // Refresh the server aggregates once a turn reaches a terminal state (the stream
  // drives the transcript, but usage/cost come from the detail query).
  const lastSettledStatusRef = useRef(runtime.currentStatus);
  useEffect(() => {
    const previous = lastSettledStatusRef.current;
    const current = runtime.currentStatus;
    lastSettledStatusRef.current = current;
    if (previous !== current && TERMINAL_SESSION_STATUSES.has(current)) {
      void queryClient.invalidateQueries({ queryKey: detailKey });
    }
  }, [runtime.currentStatus, detailKey, queryClient]);
  // Clear this session's sidebar "unseen" dot while the user is actually looking at it:
  // on open, on each status change (so watching a turn finish never leaves a stale dot),
  // and when the tab regains focus. Visibility-gated so a session left open in a
  // BACKGROUND tab still earns its dot when its turn finishes. Fire-and-forget — the
  // cleared state streams back via Electric, and the sidebar already suppresses the dot
  // for the active session, so there is no flash.
  useEffect(() => {
    const markSeen = () => {
      if (document.visibilityState === "visible") void markSessionSeen(session.id);
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [session.id, runtime.currentStatus]);
  // Reflect the open session's title in the browser tab so it's easy to tell tabs
  // apart. Restored to the default on unmount / navigation away.
  useEffect(() => {
    const previousTitle = document.title;
    const name = session.title.trim();
    document.title = name ? `${name} · opencompany` : "opencompany";
    return () => {
      document.title = previousTitle;
    };
  }, [session.title]);
  const inspectorEvents = useMemo(
    () => runtime.events.filter(isInspectableRuntimeEvent),
    [runtime.events],
  );
  const backgroundActivity = useMemo(
    () => buildBackgroundActivityParts(runtime.events, runtime.messages),
    [runtime.events, runtime.messages],
  );
  const visibleMessages = useMemo(
    () =>
      runtime.messages.filter(
        (message) => !message.internal && (message.role === "user" || message.role === "assistant"),
      ),
    [runtime.messages],
  );
  // Interleave background passes (memory updates) at their true chronological position: each
  // entry is anchored to the user message whose turn it followed, so it renders after that
  // turn's last message — not pinned to the transcript bottom once the user keeps typing.
  // Entries from the latest turn, or with no resolvable anchor, keep the old bottom placement.
  const { backgroundPartsAfterMessageId, trailingBackgroundParts } = useMemo(() => {
    const afterMessageId = new Map<string, AssistantTurnPart[]>();
    const trailing: AssistantTurnPart[] = [];
    for (const entry of backgroundActivity) {
      const anchorIndex = entry.anchorMessageId
        ? visibleMessages.findIndex((message) => message.id === entry.anchorMessageId)
        : -1;
      let nextUserIndex = -1;
      for (let i = anchorIndex + 1; anchorIndex >= 0 && i < visibleMessages.length; i++) {
        if (visibleMessages[i]?.role === "user") {
          nextUserIndex = i;
          break;
        }
      }
      if (anchorIndex < 0 || nextUserIndex <= 0) {
        trailing.push(entry.part);
        continue;
      }
      const afterId = visibleMessages[nextUserIndex - 1]?.id;
      if (!afterId) {
        trailing.push(entry.part);
        continue;
      }
      const list = afterMessageId.get(afterId) ?? [];
      list.push(entry.part);
      afterMessageId.set(afterId, list);
    }
    return {
      backgroundPartsAfterMessageId: afterMessageId,
      trailingBackgroundParts: trailing.slice(-8),
    };
  }, [backgroundActivity, visibleMessages]);
  const assistantPartsByMessageId = useMemo(() => {
    const partsByMessageId = new Map<string, AssistantTurnPart[]>();
    for (const message of runtime.messages) {
      if (message.role !== "assistant") continue;
      partsByMessageId.set(
        message.id,
        buildAssistantTurnParts(message, runtime.events, runtime.messages),
      );
    }
    return partsByMessageId;
  }, [runtime.events, runtime.messages]);
  // The single ask_user_question awaiting an answer (the run suspends, so at most one exists). It
  // drives the stepped QuestionComposer that takes over the composer slot. Derived from the same
  // parts that render the transcript, so it stays reactive to the session stream.
  const pendingQuestion = useMemo(() => {
    const findPending = (parts: AssistantTurnPart[]) =>
      parts.find(
        (part) => part.type === "tool-call" && part.toolCall.question?.status === "pending",
      );
    for (const parts of assistantPartsByMessageId.values()) {
      const match = findPending(parts);
      if (match?.type === "tool-call") return match.toolCall;
    }
    const background = findPending(backgroundActivity.map((entry) => entry.part));
    return background?.type === "tool-call" ? background.toolCall : null;
  }, [assistantPartsByMessageId, backgroundActivity]);
  const lastVisibleMessage = visibleMessages.at(-1);
  // Index of the last user message. Everything from here down (that message, its reply,
  // the working indicator, background tool cards) is the "active turn" and gets wrapped
  // in a min-height:var(--chat-vh) box so the just-sent message can sit at the top with
  // a viewport of room below it — reserved by CSS, so it survives resize and never
  // needs a JS re-pin. -1 (no user message yet) means no turn to reserve.
  const lastUserTurnStart = visibleMessages.findLastIndex((message) => message.role === "user");
  // A mid-run steer is a small annotation, not a fresh turn, so it shouldn't claim the
  // viewport-height reserve that pins a just-sent message to the top — that left the steer row
  // floating high with a big empty gap below it. When the latest user message is a steer, skip
  // the reserve so it drops to the bottom and flows with the response, like Conductor.
  const latestUserIsSteer =
    lastUserTurnStart >= 0 && Boolean(visibleMessages[lastUserTurnStart]?.sendMode);
  const sessionCanGenerate =
    !runtime.lastError &&
    ["created", "provisioning", "ready", "running"].includes(runtime.currentStatus);
  // The run has durably parked at a tool gate or a user question: the session status is
  // `awaiting_approval` / `awaiting_input` (not `running`) and the assistant message is already
  // persisted as `completed`. The approval/question card + paused tail render off this signal.
  const sessionIsPaused =
    runtime.currentStatus === "awaiting_approval" || runtime.currentStatus === "awaiting_input";
  // Paused specifically for an ask_user_question: the composer is hidden and the question card is
  // the only input surface (the card's X cancels back to the composer).
  const sessionIsAwaitingInput = runtime.currentStatus === "awaiting_input";
  const sessionIsInterrupted = runtime.currentStatus === "interrupted";
  const sessionHasResumableStepLimitFailure = isToolStepLimitResumable({
    status: runtime.currentStatus,
    lastError: runtime.lastError,
  });
  const sessionCanContinue = sessionIsInterrupted || sessionHasResumableStepLimitFailure;
  const hasRunningAssistantMessage = visibleMessages.some(
    (message) => message.role === "assistant" && message.status === "running" && sessionCanGenerate,
  );
  const showWaitingForAssistant =
    !hasRunningAssistantMessage && lastVisibleMessage?.role === "user" && sessionCanGenerate;
  const showStoppedAfterUser =
    !hasRunningAssistantMessage && lastVisibleMessage?.role === "user" && !sessionCanGenerate;
  // Abort stays available while paused so the user can cancel a parked run without
  // having to approve or deny the pending tool call first.
  const canAbort = sessionCanGenerate || sessionIsPaused;

  const renderMessage = (message: SessionMessage) => {
    const assistantParts = assistantPartsByMessageId.get(message.id) ?? [];
    // Brain files this turn created or edited (write_file/edit_file set brainFile), deduped
    // and kept in tool-call order so the footer can link straight to each one.
    const brainFiles: RuntimeBrainFileReference[] = [];
    if (message.role === "assistant") {
      const seenBrainFiles = new Set<string>();
      for (const part of assistantParts) {
        if (part.type !== "tool-call") continue;
        const brainFile =
          part.toolCall.brainFile ??
          (part.toolCall.brainPath
            ? ({
                scope: "company",
                path: part.toolCall.brainPath,
              } satisfies RuntimeBrainFileReference)
            : null);
        if (!brainFile) continue;
        const key = `${brainFile.scope}:${brainFile.path}`;
        if (seenBrainFiles.has(key)) continue;
        seenBrainFiles.add(key);
        brainFiles.push(brainFile);
      }
    }
    const copyText =
      message.role === "assistant"
        ? extractAssistantText(assistantParts) || message.content
        : message.content;
    const canCopy = copyText.trim().length > 0;
    const duration = message.role === "assistant" ? runDurationForMessage(message) : 0;
    // Paused turns and resumed-but-running tools persist the assistant message as `completed`,
    // but the turn has not actually finished. Suppress the copy + duration footer so it does not
    // read as a delivered answer.
    const awaitingInput =
      message.role === "assistant" &&
      (partsAwaitApproval(assistantParts) ||
        partsAwaitQuestion(assistantParts) ||
        partsHaveRunningTool(assistantParts));

    // Attachments preview, shared by the normal user bubble and the mid-run steer row below.
    const attachmentsBlock =
      message.attachments && message.attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {message.attachments.map((att) => {
            // Optimistic just-sent messages carry a local object-URL preview so the image
            // shows instantly; the served `/api/attachments/{id}` row doesn't exist yet.
            // Server-loaded messages have no previewUrl and use the served URL.
            const servedUrl = `/api/attachments/${att.id}`;
            const imageSrc = att.previewUrl ?? servedUrl;
            return (
              <a
                key={att.id}
                href={att.previewUrl ?? servedUrl}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <AttachmentCard
                  kind={att.kind}
                  filename={att.filename}
                  src={att.kind === "image" ? imageSrc : undefined}
                />
              </a>
            );
          })}
        </div>
      ) : null;

    // A message sent while a run was already in flight (Steer / Queue / Interrupt) renders as a
    // compact, left-aligned annotation attached just above the agent turn it affected — not as a
    // normal right-side bubble — so it stays obvious the run was redirected. Past-tense wording
    // (Steered/Queued/Interrupted) since by render time the mode has already been applied.
    if (message.role === "user" && message.sendMode) {
      // A mid-run send renders as a quiet, left-aligned caption attached to the turn it affected —
      // styled like OC's muted process rows (Thinking, "N steps"), not a loud right-side bubble.
      // The steering-wheel icon carries the only color (a faint mode tint); text stays muted.
      return (
        <div key={message.id} data-message-id={message.id} className="flex justify-start">
          <div className="flex max-w-[80%] flex-col gap-1.5">
            <div className="inline-flex max-w-full items-center gap-1.5 pl-1 text-[11px] leading-4 text-ink-subtle">
              <SteerWheelIcon
                className={`h-3 w-3 shrink-0 ${SEND_MODE_ICON_CLASS[message.sendMode]}`}
              />
              <span className="shrink-0 font-medium">{SEND_MODE_ROW_LABEL[message.sendMode]}</span>
              {message.content ? (
                <span className="break-words text-ink-muted">· {message.content}</span>
              ) : null}
            </div>
            {attachmentsBlock}
          </div>
        </div>
      );
    }

    return (
      <div
        key={message.id}
        data-message-id={message.id}
        className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
      >
        <div
          className={`group/message relative after:absolute after:inset-x-0 after:top-full after:h-5 after:content-[''] ${
            message.role === "user"
              ? "max-w-[62%] break-words rounded-2xl rounded-tr-md bg-surface-selected px-3.5 py-2.5 text-[14px] leading-6 text-ink"
              : "max-w-[68%] break-words text-[14px] leading-6 text-ink/90"
          }`}
        >
          {message.role === "assistant" ? (
            <AssistantMessageContent
              message={message}
              parts={assistantParts}
              sessionCanGenerate={sessionCanGenerate}
              sessionIsPaused={sessionIsPaused}
              sessionIsInterrupted={sessionIsInterrupted}
              stoppedError={
                runtime.currentStatus === "failed" && !sessionHasResumableStepLimitFailure
                  ? runtime.lastError
                  : null
              }
              reasoningActive={isReasoningInProgress(message, runtime.events)}
              activeStartedAt={activeStartForAssistantMessage(message, visibleMessages)}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {message.content ? <div>{message.content}</div> : null}
              {attachmentsBlock}
            </div>
          )}
          {(canCopy || brainFiles.length > 0) && message.status !== "running" && !awaitingInput ? (
            <div
              className={`absolute ${message.role === "user" ? "top-full right-0 mt-1" : "top-full left-0 mt-1"} z-10 flex max-w-[26rem] flex-wrap items-center gap-1.5 transition-opacity ${
                message.role === "assistant"
                  ? "opacity-100"
                  : "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
              }`}
            >
              {canCopy ? <CopyMessageButton text={copyText} /> : null}
              {duration > 0 ? (
                <span className="text-[10px] tabular-nums text-ink-subtle/60 select-none">
                  {formatElapsed(Math.round(duration))}
                </span>
              ) : null}
              {brainFiles.length > 0 ? <BrainAttachments files={brainFiles} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  // A block of background-pass tool cards (memory updates). Shared between the interleaved
  // per-turn placement and the trailing block at the bottom of the active turn.
  const renderBackgroundParts = (parts: AssistantTurnPart[]) => (
    <div className="space-y-1.5">
      {parts.map((part) =>
        part.type === "tool-call" ? (
          <div key={part.toolCall.id} className="flex justify-start">
            <div className="max-w-[68%] break-words text-[14px] leading-6 text-ink/90">
              <ToolCallCard toolCall={part.toolCall} sessionIsInterrupted={sessionIsInterrupted} />
            </div>
          </div>
        ) : null,
      )}
    </div>
  );

  // A transcript row: the message plus any background passes anchored after it (a memory
  // update that followed this turn renders here, at its true position in the conversation).
  const renderMessageRow = (message: SessionMessage) => {
    const anchoredParts = backgroundPartsAfterMessageId.get(message.id);
    if (!anchoredParts?.length) return renderMessage(message);
    return (
      <Fragment key={`${message.id}-row`}>
        {renderMessage(message)}
        {renderBackgroundParts(anchoredParts)}
      </Fragment>
    );
  };

  const waitStartedAtRef = useRef<number | null>(null);
  const [stoppedElapsedSeconds, setStoppedElapsedSeconds] = useState<number | null>(null);
  useEffect(() => {
    const waiting = showWaitingForAssistant || hasRunningAssistantMessage;
    if (waiting && waitStartedAtRef.current === null) {
      waitStartedAtRef.current = Date.now();
    }
    if (showStoppedAfterUser && waitStartedAtRef.current !== null) {
      setStoppedElapsedSeconds(
        Math.max(Math.floor((Date.now() - waitStartedAtRef.current) / 1000), 0),
      );
    } else if (!waiting && !showStoppedAfterUser) {
      waitStartedAtRef.current = null;
      setStoppedElapsedSeconds(null);
    }
  }, [showWaitingForAssistant, hasRunningAssistantMessage, showStoppedAfterUser]);

  function updateInspectorCollapsed(nextCollapsed: boolean) {
    setInspectorCollapsed(nextCollapsed);
  }

  const requestAbort = () => {
    startTransition(async () => {
      const result = await abortAgentSession(session.id);
      if (!result.ok) {
        showError(result.error, "Could not abort session");
      }
      // The "aborting" status arrives via the stream (the action appends it), so
      // there is no optimistic cache write here.
    });
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  // Window-wide drop interception + the blur-reset for the drop overlay now live in the
  // useComposerAttachments hook (shared with the home composers).

  // Durable Stream recovery lives in useSessionStream: the client reconnects +
  // resumes from its offset on transient failures, and a DEAD subscription (the
  // hidden-tab pause/resume race, an exhausted retry budget) is re-opened when the
  // tab regains visibility/focus. The detail query's refetchOnWindowFocus plus the
  // staleness-gated authority rule in baseRuntime cover the gap until that
  // re-subscription catches up.

  useEffect(() => {
    if (!attachMenuOpen) return;
    const isOutside = (target: EventTarget | null) =>
      !attachMenuRef.current || !attachMenuRef.current.contains(target as Node);
    const handlePointerDown = (event: PointerEvent) => {
      if (isOutside(event.target)) setAttachMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAttachMenuOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (isOutside(event.target)) setAttachMenuOpen(false);
    };
    // pointerdown covers mouse + touch + pen; focusin closes on keyboard Tab-out.
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [attachMenuOpen]);

  // One-shot snap: place the just-sent user message at the TOP of the viewport, exactly
  // once. Done in useLayoutEffect (before the browser paints) and INSTANTLY, so the very
  // first frame the user sees already has the message at the top — it never flashes at
  // the bottom and then animates up (that visible travel was the "springt hoch"). The
  // space below it is reserved in CSS (min-height on the last turn, sized from --chat-vh),
  // so the browser's native scroll anchoring holds it in place while the reply streams in
  // below — no per-frame re-pin, no jitter, resize-safe.
  useLayoutEffect(() => {
    if (!pendingScrollMessageId) return;
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    const msgEl = container.querySelector<HTMLElement>(
      `[data-message-id="${pendingScrollMessageId}"]`,
    );
    if (!msgEl) return;
    const drift =
      msgEl.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      SCROLL_TO_TOP_PADDING_PX;
    container.scrollTo({ top: container.scrollTop + drift, behavior: "auto" });
    // The user is now reading from the top, not pinned at the bottom — the streaming
    // follow stays off until they scroll back down themselves.
    isPinnedAtBottomRef.current = false;
    setPendingScrollMessageId(null);
  }, [pendingScrollMessageId, visibleMessages]);

  // Streaming bottom-follow: while the assistant is producing output AND the user is
  // pinned at the bottom, keep the latest content in view. Instant ("auto") to avoid
  // smooth-scroll churn on every delta. Skipped while a one-shot snap is pending so the
  // two never fight.
  useEffect(() => {
    if (pendingScrollMessageId) return;
    if (!hasRunningAssistantMessage && !showWaitingForAssistant) return;
    if (!isPinnedAtBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= 1) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  }, [
    pendingScrollMessageId,
    visibleMessages,
    hasRunningAssistantMessage,
    showWaitingForAssistant,
  ]);

  // Open at bottom: when a chat is first opened (or switched to), land on the newest
  // message — once per session. Runs in useLayoutEffect (before paint) so there is no
  // visible top→bottom jump. Keyed on session.id and guarded by a ref so it never
  // re-fires on later renders (the streaming follow owns those) and never fights the
  // send-snap (which positions the view itself on send).
  // Deps use `hasMessages` (a boolean) not the visibleMessages array, so it fires on the
  // first-content flip and on session change — not on every streamed delta.
  const hasMessages = visibleMessages.length > 0;
  const initialScrollSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingScrollMessageId) return; // a send-snap owns this frame
    if (initialScrollSessionRef.current === session.id) return; // already snapped this chat
    if (!hasMessages) return; // wait until content exists
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    isPinnedAtBottomRef.current = true;
    initialScrollSessionRef.current = session.id;
  }, [session.id, hasMessages, pendingScrollMessageId]);

  // Keep the reserved-space height (--chat-vh) in sync with the scroll container's own
  // height. A single ResizeObserver means the CSS min-height on the last turn recomputes
  // on every viewport/container resize (window resize, sidebar toggle, devtools), so the
  // snapped message keeps its top position instead of drifting — in BOTH the grow and
  // shrink directions. No scroll is issued here; CSS does the layout.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      container.style.setProperty("--chat-vh", `${container.clientHeight}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Flag the next scroll events as user-driven for a short, self-renewing window. A real
  // wheel/touch/scrollbar gesture keeps it set through its momentum burst; programmatic
  // and layout scrolls never set it, so onScroll ignores them.
  const markUserScrollIntent = () => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = setTimeout(() => {
      userScrollIntentRef.current = false;
    }, 250);
  };
  useEffect(
    () => () => {
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    },
    [],
  );

  // Skills attached to this session's agent contribute `/<command>` entries alongside the
  // built-ins — using each skill's declared `command:` when present, else a slug of its name.
  // Company sessions derive attached skills from the synced agent row; personal sessions use the
  // live personal context so unsaved soft-navigation state and personal skills stay visible.
  const { agents } = useCollections();
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  const personalAgent = useOptionalPersonalAgent();
  const { data: skillCatalog } = useQuery({
    queryKey: ["workspace-skills", workspaceId],
    queryFn: fetchWorkspaceSkills,
    staleTime: 60_000,
  });
  const allSlashCommands = useMemo(() => {
    const workspaceSkills: SkillCommandSource[] = (skillCatalog ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      ...(skill.command ? { command: skill.command } : {}),
    }));
    const attached = agentRows?.find((agent) => agent.id === session.agentId);
    const configSkills =
      personalAgent?.agent.id === session.agentId
        ? personalAgent.config.skills
        : attached
          ? agentRowToListItem(attached).config.skills
          : [];
    const sources = buildAttachedSkillCommandSources({
      configSkills,
      workspaceSkills,
      personalSkills:
        personalAgent?.agent.id === session.agentId ? personalAgent.personalSkills : [],
    });
    if (sources.length === 0) return SLASH_COMMANDS;
    return [
      ...SLASH_COMMANDS,
      ...buildSkillSlashCommands(sources, new Set(SLASH_COMMANDS.map((c) => c.id))),
    ];
  }, [agentRows, personalAgent, session.agentId, skillCatalog]);

  // Command mode is active while the caret sits on a `/token` (at the start of the
  // input or after whitespace). The token after the slash is the live filter query.
  const slashContext = useMemo(() => getSlashContext(input, caret), [input, caret]);
  const slashQuery = slashContext?.query ?? null;
  const slashCommands = useMemo(
    () => (slashQuery !== null ? matchSlashCommands(slashQuery, allSlashCommands) : []),
    [slashQuery, allSlashCommands],
  );
  const slashMenuOpen = slashQuery !== null && !slashDismissed && slashCommands.length > 0;
  const slashActiveId = slashCommands[slashActiveIndex]?.id ?? null;
  const slashActiveOptionId =
    slashMenuOpen && slashActiveId ? `${slashMenuId}-option-${slashActiveId}` : undefined;
  // Reset highlight + un-dismiss whenever the query changes, so typing after
  // Escape reopens the menu and a changed list always starts at the top. Done as
  // a render-time adjustment (not an effect) per the "you might not need an
  // effect" pattern — avoids a cascading-render lint error and an extra paint.
  const [prevSlashQuery, setPrevSlashQuery] = useState(slashQuery);
  if (slashQuery !== prevSlashQuery) {
    setPrevSlashQuery(slashQuery);
    setSlashActiveIndex(0);
    setSlashDismissed(false);
  }

  const runSlashCommand = (
    command: SlashCommand,
    args = "",
    options: { transition?: boolean } = {},
  ) => {
    const commandKey = command.id;
    if (slashCommandInFlightRef.current.has(commandKey)) return;
    slashCommandInFlightRef.current.add(commandKey);

    const run = async () => {
      try {
        await command.run({
          session,
          surface,
          workspaceId,
          router,
          sessionHref: (sessionId) => sessionHrefForSurface(surface, sessionId),
          queryClient,
          setInput,
          insertMention,
          showToast,
          args,
        });
      } finally {
        slashCommandInFlightRef.current.delete(commandKey);
      }
    };

    if (options.transition === false) {
      void run();
      return;
    }

    startTransition(run);
  };

  // Selecting a command from the menu inserts its trigger into the input (it does not
  // run yet) — the trailing space ends the `/token` so the menu closes on its own, and
  // the user runs it by pressing Enter to send. Keeps the textarea focused.
  const insertSlashCommand = (command: SlashCommand) => {
    const ctx = slashContext;
    if (!ctx) return;
    const before = input.slice(0, ctx.start);
    const after = input.slice(ctx.end);
    const next = `${before}${command.trigger} ${after}`;
    const nextCaret = before.length + command.trigger.length + 1;
    setInput(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  // Drop a literal token (e.g. `@skill/<id> `) into the composer and leave the caret after it.
  // Used by skill-derived commands so invoking `/<command>` swaps in the skill's mention for the
  // user to keep typing around. Targets the active slash token when the menu is open; otherwise
  // (the run-on-send path, where the `/command ` token may carry a trailing space) it replaces
  // the leading `/command` token, preserving any args the user typed after it.
  const insertMention = (token: string) => {
    let start: number;
    let end: number;
    if (slashContext) {
      start = slashContext.start;
      end = slashContext.end;
    } else {
      const leading = input.match(/^\s*\/\w+\s?/);
      if (leading) {
        start = 0;
        end = leading[0].length;
      } else {
        start = caret;
        end = caret;
      }
    }
    const before = input.slice(0, start);
    const after = input.slice(end);
    const next = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    setInput(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  // Choosing a command from the menu: an `applyOnSelect` command (skill commands) runs straight
  // away so the slash token becomes its mention in one step; everything else inserts its trigger
  // and waits for the user to send (so `/clear <prompt>` etc. can take args).
  const selectSlashCommand = (command: SlashCommand) => {
    if (command.applyOnSelect) {
      runSlashCommand(command, "", { transition: false });
    } else {
      insertSlashCommand(command);
    }
  };

  // Land the cursor in the composer when arriving at a fresh, empty session (e.g.
  // right after `/clear` navigates here), so the user can start typing immediately.
  const didAutofocusRef = useRef(false);
  useEffect(() => {
    if (didAutofocusRef.current) return;
    didAutofocusRef.current = true;
    if (visibleMessages.length === 0) textareaRef.current?.focus();
  }, [visibleMessages.length]);

  // Enter/send entrypoint: if the message carries a command token, run it (passing the
  // text after the token as its args); otherwise send a normal chat message. Commands
  // may run even while busy (they navigate away).
  const handleSend = () => {
    if (isPending) return;
    const parsed = parseSlashCommand(input, allSlashCommands);
    if (parsed) {
      runSlashCommand(parsed.command, parsed.args);
      return;
    }
    // Note: we intentionally do NOT bail when the agent is running. Sending mid-run is the whole
    // point of send-modes — the server + runner route the message per `sendMode`.
    submit();
  };

  const submit = () => {
    // Guard only against a double-submit of our own in-flight transition; sending while the agent
    // runs is allowed and resolves to steer/queue/interrupt on the server.
    if (isPending) return;
    // Whether a run is active right now decides if `sendMode` matters and whether to show a chip.
    const sentMidRun = hasRunningAssistantMessage || showWaitingForAssistant;
    const content = input.trim();
    const ready = attachments.filter((a) => a.status === "ready" && a.blobPathname && a.blobUrl);
    if (!content && ready.length === 0) return;
    setFormError(null);
    const optimisticId = newOptimisticMessageId();
    const submittedAtMs = Date.now();
    const optimisticMessage: OptimisticUserMessage = {
      optimisticId,
      submittedAtMs,
      confirmedMessageId: null,
      existingMessageIds: baseRuntime.messages.map((message) => message.id),
      id: optimisticId,
      role: "user",
      content,
      status: "completed",
      // Only tag the bubble with a send-mode when it was actually dispatched into a live run, so
      // the chip ("Steering"/"Queued"/"Interrupt") shows for those and not for idle first sends.
      ...(sentMidRun ? { sendMode } : {}),
      createdAt: new Date(submittedAtMs).toISOString(),
      completedAt: new Date(submittedAtMs).toISOString(),
      // Carry the sent attachments so the bubble shows them immediately. Images use their local
      // object-URL preview (the served /api/attachments row doesn't exist yet); the revoke is
      // deferred until the durable server message replaces this optimistic one (see effect below).
      ...(ready.length > 0
        ? {
            attachments: ready.map((a) => ({
              id: a.id,
              kind: a.kind,
              mediaType: a.mediaType,
              filename: a.filename,
              ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
            })),
          }
        : {}),
    };
    setOptimisticUserMessages((current) => [...current, optimisticMessage]);
    setInput("");
    setPendingScrollMessageId(optimisticId);
    // Start the felt-TTFT clock at the click, before the server round-trip, so
    // dispatch latency is counted as part of what the user feels.
    pendingTtftRef.current = { startedAt: performance.now(), messageId: null };
    startTransition(async () => {
      const result = await submitAgentSessionMessage(
        session.id,
        content,
        toSubmitAttachments(ready),
        sendMode,
      );
      if (result.ok) {
        if (pendingTtftRef.current) pendingTtftRef.current.messageId = result.messageId;
        // Sent successfully — clear the tray. The sent attachments' object-URL previews are now
        // owned by the optimistic message (revoked when its durable server message arrives), so
        // only revoke previews that were NOT carried over (defensive — the send gate means all
        // tray attachments are `ready`, so this set is normally empty).
        const carried = new Set(ready.map((a) => a.id));
        attachments.forEach((a) => {
          if (a.previewUrl && !carried.has(a.id)) URL.revokeObjectURL(a.previewUrl);
        });
        setAttachments([]);
        setOptimisticUserMessages((current) =>
          current.map((message) =>
            message.optimisticId === optimisticId
              ? { ...message, confirmedMessageId: result.messageId }
              : message,
          ),
        );
        return;
      }
      pendingTtftRef.current = null; // failed send — drop the timer
      setOptimisticUserMessages((current) =>
        current.filter((message) => message.optimisticId !== optimisticId),
      );
      setInput((current) => (current.trim() ? current : content));
      setFormError(result.error);
    });
  };

  // Switch the model for this session on the fly. Optimistic: reflect the pick immediately,
  // persist it (sticky for the session, used on the next turn), and revert on failure.
  const handleModelChange = (modelId: string) => {
    const previous = modelOverride;
    setModelOverride(modelId);
    setFormError(null);
    startModelTransition(async () => {
      const result = await setAgentSessionModel(session.id, modelId);
      if (!result.ok) {
        setModelOverride(previous);
        setFormError(result.error);
      }
    });
  };

  const handleContinueInterrupted = () => {
    if (!sessionCanContinue || isPending) return;
    const content = "Continue";
    setFormError(null);
    const optimisticId = newOptimisticMessageId();
    const submittedAtMs = Date.now();
    const optimisticMessage: OptimisticUserMessage = {
      optimisticId,
      submittedAtMs,
      confirmedMessageId: null,
      existingMessageIds: baseRuntime.messages.map((message) => message.id),
      id: optimisticId,
      role: "user",
      content,
      status: "completed",
      createdAt: new Date(submittedAtMs).toISOString(),
      completedAt: new Date(submittedAtMs).toISOString(),
    };
    setOptimisticUserMessages((current) => [...current, optimisticMessage]);
    setPendingScrollMessageId(optimisticId);
    pendingTtftRef.current = { startedAt: performance.now(), messageId: null };
    startTransition(async () => {
      const result = await continueInterruptedSession(session.id);
      if (result.ok) {
        if (pendingTtftRef.current) pendingTtftRef.current.messageId = result.messageId;
        setOptimisticUserMessages((current) =>
          current.map((message) =>
            message.optimisticId === optimisticId
              ? { ...message, confirmedMessageId: result.messageId }
              : message,
          ),
        );
        return;
      }
      pendingTtftRef.current = null;
      setOptimisticUserMessages((current) =>
        current.filter((message) => message.optimisticId !== optimisticId),
      );
      setFormError(result.error);
    });
  };

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SessionTopBar
          session={session}
          currentContextTokens={runtime.currentContextTokens}
          totalCostUsdMicros={runtime.cost.totalCostUsdMicros}
          inspectorCollapsed={inspectorCollapsed}
          onToggleInspector={() => updateInspectorCollapsed(!inspectorCollapsed)}
        />

        {/* Drop-overlay hover handlers (`dragHandlers`) come from the shared attachment hook. The
            window-level drop handler inside that hook does the actual preventDefault + accept, so a
            drop anywhere in the app attaches and the browser never opens the file; the spread
            handlers here only drive the "Drop files to attach" overlay. */}
        <div
          ref={scrollContainerRef}
          className="relative flex-1 overflow-y-auto overscroll-contain [overflow-anchor:auto] px-6 py-6"
          onWheel={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          onScroll={(event) => {
            // Only a genuine user scroll (flagged by the wheel/touch handlers above)
            // updates the pinned-at-bottom state. Programmatic scrolls (snap + follow),
            // layout-driven scrolls (reflow, overflow-anchor) and non-scroll pointer
            // interactions fire onScroll too, but without user intent — ignoring them is
            // what keeps the snapped message at the top instead of being yanked by the
            // follow. (Scrollbar-drag / keyboard scroll without wheel is an accepted edge.)
            if (!userScrollIntentRef.current) return;
            const el = event.currentTarget;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            isPinnedAtBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
          }}
          // Drop-overlay hover handlers come from the shared hook. The window-level drop handler
          // (inside the hook) does the actual preventDefault + accept, so a drop anywhere in the
          // app attaches and the browser never opens the file; these only drive the overlay.
          {...dragHandlers}
        >
          {isDragActive ? <ComposerDropOverlay /> : null}
          <div className="mx-auto max-w-[960px] space-y-5">
            {runtime.lastError && !sessionHasResumableStepLimitFailure ? (
              <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12.5px] leading-5 text-danger">
                <AlertCircle size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                <span>{runtime.lastError}</span>
              </div>
            ) : null}

            {visibleMessages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface/40 px-6 py-12 text-center">
                <Bot size={18} strokeWidth={1.7} className="mx-auto text-ink-subtle" />
                <p className="mt-3 text-[13.5px] font-medium text-ink">Session is ready</p>
                <p className="mt-1 text-[12.5px] text-ink-muted">Write a message to get started.</p>
              </div>
            ) : null}

            {visibleMessages.slice(0, Math.max(lastUserTurnStart, 0)).map(renderMessageRow)}

            {/* Active turn: the last user message + its reply + indicators, wrapped in a
                min-height box so the just-sent message can sit at the top with a viewport
                of room below it. The reserve is pure CSS (sized from --chat-vh by the
                ResizeObserver), so it adapts to any viewport size and needs no per-frame
                re-pin — the source of the old jitter and resize drift. */}
            <div
              className="space-y-5"
              style={
                lastUserTurnStart >= 0 && !latestUserIsSteer
                  ? { minHeight: `calc(var(--chat-vh, 100dvh) * ${LAST_TURN_MIN_HEIGHT_FACTOR})` }
                  : undefined
              }
            >
              {(lastUserTurnStart >= 0
                ? visibleMessages.slice(lastUserTurnStart)
                : visibleMessages
              ).map(renderMessageRow)}

              {showWaitingForAssistant ? (
                <div className="flex justify-start">
                  <WorkingIndicator startedAt={lastVisibleMessage?.createdAt} thinking={false} />
                </div>
              ) : showStoppedAfterUser ? (
                <div className="flex justify-start">
                  <AssistantStoppedNotice elapsedSeconds={stoppedElapsedSeconds} />
                </div>
              ) : null}

              {trailingBackgroundParts.length > 0
                ? renderBackgroundParts(trailingBackgroundParts)
                : null}
            </div>
          </div>
        </div>

        {/* While the agent awaits a structured answer, the stepped QuestionComposer takes over the
            composer slot (its Skip/X quietly returns here). It replaces the text composer entirely so
            there's a single input surface. Falls back to the text composer if the pending question
            can't be located (status race), so the user is never stuck. */}
        {sessionIsAwaitingInput && pendingQuestion ? (
          <div className="bg-canvas px-6 py-4">
            <div className="mx-auto max-w-[960px]">
              <QuestionComposer
                key={pendingQuestion.id}
                sessionId={session.id}
                toolCall={pendingQuestion}
              />
            </div>
          </div>
        ) : (
          <div className="bg-canvas px-6 py-4">
            <div className="mx-auto max-w-[960px]">
              <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
              <Composer
                variant="compact"
                error={formError}
                banner={
                  sessionCanContinue ? (
                    <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-warning">
                        <SessionStatusDot status="interrupted" />
                        <span className="truncate">
                          {sessionIsInterrupted ? "Interrupted" : "Step limit reached"}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={handleContinueInterrupted}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warning-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Play size={12} strokeWidth={1.9} />
                        Continue
                      </button>
                    </div>
                  ) : null
                }
                overlay={
                  slashMenuOpen ? (
                    <SlashCommandMenu
                      id={slashMenuId}
                      commands={slashCommands}
                      activeId={slashActiveId}
                      onSelect={(command) => selectSlashCommand(command)}
                      onHover={(id) => {
                        const idx = slashCommands.findIndex((command) => command.id === id);
                        if (idx >= 0) setSlashActiveIndex(idx);
                      }}
                    />
                  ) : null
                }
                input={
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value);
                      setCaret(event.target.selectionStart ?? event.target.value.length);
                    }}
                    onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                    onKeyDown={(event) => {
                      // While the slash menu is open it owns navigation keys; focus
                      // stays in the textarea so typing keeps filtering the list.
                      if (slashMenuOpen && !event.nativeEvent.isComposing) {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setSlashActiveIndex((i) => (i + 1) % slashCommands.length);
                          return;
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setSlashActiveIndex(
                            (i) => (i - 1 + slashCommands.length) % slashCommands.length,
                          );
                          return;
                        }
                        // Enter and Tab pick the highlighted command: built-ins insert their
                        // trigger (the user then sends to run it), while skill commands
                        // (`applyOnSelect`) apply immediately, swapping in the skill mention.
                        if (event.key === "Enter" || event.key === "Tab") {
                          if (event.key === "Enter" && event.shiftKey) {
                            // shift+Enter falls through to a normal newline.
                          } else {
                            event.preventDefault();
                            const command = slashCommands[slashActiveIndex];
                            if (command) selectSlashCommand(command);
                            return;
                          }
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setSlashDismissed(true);
                          return;
                        }
                      }
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    onPaste={(event) => {
                      // Files in the clipboard (e.g. a screenshot) are taken as attachments by the
                      // shared hook, which also stops the browser pasting them into the textarea.
                      if (handlePasteFiles(event)) return;
                      // Oversized plain-text pastes become a .txt attachment instead of dumping
                      // a wall of text into the composer. Beyond the attachment size cap the
                      // paste falls through untouched — losing the user's text to a rejection
                      // toast would be worse than a huge textarea.
                      const text = event.clipboardData?.getData("text/plain") ?? "";
                      if (
                        text.length < COMPOSER_PASTE_ATTACHMENT_MIN_CHARS ||
                        new Blob([text]).size > ATTACHMENT_TEXT_MAX_BYTES
                      ) {
                        return;
                      }
                      event.preventDefault();
                      acceptFiles([pastedTextFile(text, attachments)]);
                    }}
                    placeholder="Ask this agent to do something"
                    role="combobox"
                    aria-expanded={slashMenuOpen}
                    aria-controls={slashMenuOpen ? slashMenuId : undefined}
                    aria-activedescendant={slashActiveOptionId}
                    aria-haspopup="listbox"
                    rows={1}
                    className="min-h-9 w-full resize-none content-center bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
                    style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                  />
                }
                leftControls={
                  <>
                    <div ref={attachMenuRef} className="relative">
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept={ATTACHMENT_FILE_INPUT_ACCEPT}
                        className="hidden"
                        onChange={(event) => {
                          acceptFiles(Array.from(event.target.files ?? []));
                          event.target.value = "";
                          setAttachMenuOpen(false);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setAttachMenuOpen((prev) => !prev)}
                        aria-label="Attach file"
                        aria-expanded={attachMenuOpen}
                        aria-haspopup="menu"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                      >
                        <Plus size={15} strokeWidth={1.75} />
                      </button>
                      {attachMenuOpen ? (
                        <div
                          role="menu"
                          className="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[200px] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_8px_24px_-8px_rgba(15,15,15,0.12),0_2px_4px_rgba(15,15,15,0.05)]"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => fileInputRef.current?.click()}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-ink/90 transition-colors hover:bg-surface-muted"
                          >
                            <Upload size={13} strokeWidth={1.75} />
                            Upload file
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <ModelPicker
                      value={modelOverride ?? session.modelName}
                      fallbackModelId={DEFAULT_MODEL_ID}
                      onChange={handleModelChange}
                    />
                    {canAbort && (hasRunningAssistantMessage || showWaitingForAssistant) ? (
                      <SendModePicker
                        value={sendMode}
                        onChange={setSendMode}
                        open={sendModeMenuOpen}
                        setOpen={setSendModeMenuOpen}
                      />
                    ) : null}
                  </>
                }
                action={(() => {
                  // While a run is active the composer offers BOTH send (which dispatches per
                  // the chosen send-mode) and stop. The send button is tinted by the mode —
                  // green for Steer, amber for Queue, red for Interrupt — so the "this button
                  // is green" cue maps to live-steering. Idle: a single neutral send button.
                  const runActive =
                    canAbort && (hasRunningAssistantMessage || showWaitingForAssistant);
                  const sendDisabled =
                    isPending ||
                    attachments.some((a) => a.status !== "ready") ||
                    (!parseSlashCommand(input, allSlashCommands) &&
                      !input.trim() &&
                      attachments.length === 0);
                  return (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={sendDisabled}
                        onClick={handleSend}
                        aria-label={
                          runActive ? `Send (${sendModeMeta(sendMode).label})` : "Send message"
                        }
                        title={
                          runActive ? `Send · ${sendModeMeta(sendMode).label}` : "Send message"
                        }
                        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                          runActive
                            ? SEND_MODE_BUTTON_CLASS[sendMode]
                            : "bg-ink text-canvas hover:bg-ink/85"
                        }`}
                      >
                        <ArrowUp size={13} strokeWidth={2} />
                      </button>
                      {runActive ? (
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={requestAbort}
                          aria-label="Stop generating"
                          title="Stop generating"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-danger-border bg-danger-bg text-danger transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <CircleStop size={16} strokeWidth={1.9} />
                        </button>
                      ) : null}
                    </div>
                  );
                })()}
                rightControls={
                  <div
                    className={`flex items-center gap-3 px-1 text-[11px] text-ink-subtle transition-opacity duration-150 ${
                      slashMenuOpen
                        ? "opacity-100"
                        : "hidden opacity-0 group-focus-within/composer:opacity-100 sm:flex"
                    }`}
                  >
                    {slashMenuOpen ? (
                      <>
                        <span>
                          <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                            ↑↓
                          </kbd>{" "}
                          navigate
                        </span>
                        <span>
                          <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                            ↵
                          </kbd>{" "}
                          insert
                        </span>
                        <span>
                          <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                            esc
                          </kbd>{" "}
                          dismiss
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                            ↵
                          </kbd>{" "}
                          send
                        </span>
                        <span>
                          <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                            ⇧↵
                          </kbd>{" "}
                          new line
                        </span>
                      </>
                    )}
                  </div>
                }
              />
            </div>
          </div>
        )}
      </div>

      {!inspectorCollapsed && (
        <button
          type="button"
          aria-label="Collapse runtime details"
          className="fixed inset-0 z-30 bg-ink/[0.06] lg:hidden"
          onClick={() => updateInspectorCollapsed(true)}
        />
      )}

      <aside
        className={`shrink-0 overflow-y-auto border-l border-border bg-surface-raised/95 px-5 py-4 shadow-[-16px_0_36px_rgba(0,0,0,0.08)] backdrop-blur-md transition-transform duration-200 ease-out lg:bg-surface-raised/80 lg:py-8 lg:shadow-none lg:backdrop-blur-0 ${
          inspectorCollapsed
            ? "hidden"
            : "fixed inset-y-0 right-0 z-40 block w-[min(328px,calc(100vw-24px))] lg:static lg:z-auto lg:w-[328px]"
        }`}
        aria-hidden={inspectorCollapsed}
      >
        <div className="mb-5 flex items-center justify-between pr-9 lg:mb-7">
          <div className="text-[12px] font-medium text-ink">Runtime</div>
          <CopySessionJsonButton build={buildSessionDebugSnapshot} />
        </div>
        <SessionInspector
          session={session}
          related={detail.related}
          currentStatus={runtime.currentStatus}
          lastError={sessionHasResumableStepLimitFailure ? null : runtime.lastError}
          streamStatus={streamStatus}
          streamErrorMessage={streamStatus === "error" ? "Stream connection error" : null}
          connectionStale={false}
          runnerConfigured={true}
          eventCount={inspectorEvents.length}
          usage={runtime.usage}
          toolUsage={runtime.toolUsage}
          cost={runtime.cost}
          recentEvents={inspectorEvents.slice(-16)}
          canAbort={canAbort}
          isPending={isPending}
          onAbort={requestAbort}
        />
      </aside>
    </main>
  );
}

// Slim session header: agent name, the model (with its provider icon), the count of enabled
// capabilities (tools + MCP + skills), and the runtime-sidebar toggle. The agent config — and
// thus the capability count — is read live from the synced `agents` collection so it stays
// reactive without threading extra fields through the session payload.
function AssistantMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const ref = useStreamingMarkdownAppendAnimation(content, streaming);

  return (
    <div ref={ref} className="session-markdown" data-streaming={streaming ? "true" : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function useStreamingMarkdownAppendAnimation(content: string, streaming: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const previousContentRef = useRef("");
  const lastAnimationAtRef = useRef(Number.NEGATIVE_INFINITY);
  const animationRef = useRef<Animation | null>(null);

  useEffect(() => {
    const previousContent = previousContentRef.current;
    previousContentRef.current = content;

    if (!streaming || !shouldAnimateStreamingAppend(previousContent, content)) return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const now = performance.now();
    if (now - lastAnimationAtRef.current < STREAM_APPEND_ANIMATION_MIN_INTERVAL_MS) return;

    const element = ref.current;
    if (!element || typeof element.animate !== "function") return;
    const animatedElement =
      element.lastElementChild instanceof HTMLElement ? element.lastElementChild : element;

    lastAnimationAtRef.current = now;
    animationRef.current?.cancel();
    const animation = animatedElement.animate(
      [
        { opacity: 0.9, filter: "blur(0.2px)" },
        { opacity: 1, filter: "blur(0)" },
      ],
      {
        duration: 160,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    );
    animationRef.current = animation;
    animation.onfinish = () => {
      if (animationRef.current === animation) animationRef.current = null;
    };
  }, [content, streaming]);

  useEffect(
    () => () => {
      animationRef.current?.cancel();
    },
    [],
  );

  return ref;
}

// Copy only the user-visible answer text. Reasoning and tool calls are
// intentionally excluded so what you paste matches the final assistant answer.
function extractAssistantText(parts: AssistantTurnPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
}

// A turn parked at a tool gate: a tool-call part still needs the user to decide. A run that
// durably pauses for approval is persisted as a `completed` message, so this is what tells
// the difference between such a pause and a genuinely finished turn.
function partsAwaitApproval(parts: AssistantTurnPart[]): boolean {
  return parts.some(
    (part) => part.type === "tool-call" && part.toolCall.approval?.status === "required",
  );
}

function partsAwaitQuestion(parts: AssistantTurnPart[]): boolean {
  return parts.some(
    (part) => part.type === "tool-call" && part.toolCall.question?.status === "pending",
  );
}

function partsHaveRunningTool(parts: AssistantTurnPart[]): boolean {
  return parts.some((part) => part.type === "tool-call" && part.toolCall.status === "running");
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be blocked in insecure contexts
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {copied ? (
        <Check size={10} strokeWidth={2} className="text-success" />
      ) : (
        <Copy size={10} strokeWidth={1.75} />
      )}
    </button>
  );
}

const BRAIN_ATTACHMENT_VISIBLE_LIMIT = 3;

// Mini attachments shown beneath an assistant turn that created/edited Brain files. Links straight
// to each file in the URL-addressable Brain editor (company or personal); collapses the tail past 3.
function BrainAttachments({ files }: { files: RuntimeBrainFileReference[] }) {
  const visible = files.slice(0, BRAIN_ATTACHMENT_VISIBLE_LIMIT);
  const overflow = files.length - visible.length;
  return (
    <>
      {visible.map((file) => (
        <Link
          key={`${file.scope}:${file.path}`}
          href={brainFileHref(file)}
          title={brainFileTitle(file)}
          className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-1.5 py-px text-[10.5px] font-medium text-ink-muted transition-colors hover:bg-surface-hover/65 hover:text-ink"
        >
          <Brain size={9} strokeWidth={1.9} className="shrink-0" />
          <span className="truncate">{file.path}</span>
        </Link>
      ))}
      {overflow > 0 ? (
        <Link
          href={brainFileListHref(files)}
          title={`${overflow} more Brain ${overflow === 1 ? "file" : "files"}`}
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-1.5 py-px text-[10.5px] font-medium text-ink-muted transition-colors hover:bg-surface-hover/65 hover:text-ink"
        >
          +{overflow} others
        </Link>
      ) : null}
    </>
  );
}

function brainFileHref(file: RuntimeBrainFileReference) {
  return file.scope === "personal" ? personalPaths.brainFile(file.path) : brainHref(file.path);
}

function brainFileTitle(file: RuntimeBrainFileReference) {
  return file.scope === "personal" ? `personal-brain/${file.path}` : `brain/${file.path}`;
}

function brainFileListHref(files: RuntimeBrainFileReference[]) {
  return files.some((file) => file.scope === "personal") ? personalPaths.brain : BRAIN_BASE_PATH;
}

// One-click "copy the whole session as JSON" for debugging. Builds the snapshot lazily on
// click (large transcripts shouldn't be stringified on every render) and shows a brief
// "Copied" confirmation, mirroring CopyMessageButton.
function CopySessionJsonButton({ build }: { build: () => unknown }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showError } = useToast();

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    try {
      await navigator.clipboard.writeText(JSON.stringify(build(), null, 2));
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      showError("Couldn't copy the session JSON to the clipboard.");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied debug JSON" : "Copy debug JSON"}
      title={
        copied
          ? "Copied"
          : "Copy the full session debug JSON (system prompt + latest model-call tools)"
      }
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {copied ? (
        <Check size={11} strokeWidth={2} className="text-success" />
      ) : (
        <Copy size={11} strokeWidth={1.75} />
      )}
      <span>{copied ? "Copied" : "Copy Debug JSON"}</span>
    </button>
  );
}

export function AssistantMessageContent({
  message,
  parts,
  sessionCanGenerate,
  sessionIsPaused = false,
  sessionIsInterrupted = false,
  stoppedError = null,
  reasoningActive = false,
  activeStartedAt,
}: {
  message: SessionMessage;
  parts: AssistantTurnPart[];
  sessionCanGenerate: boolean;
  sessionIsPaused?: boolean;
  sessionIsInterrupted?: boolean;
  stoppedError?: string | null;
  reasoningActive?: boolean;
  activeStartedAt?: string | undefined;
}) {
  const hasParts = parts.length > 0;
  const isRunning = message.status === "running" && sessionCanGenerate;
  const isStopped =
    message.status === "failed" || (message.status === "running" && !sessionCanGenerate);
  const isCompleted = message.status === "completed";
  const runDurationSeconds = runDurationForMessage(message);
  const hasPendingApproval = partsAwaitApproval(parts);
  const hasRunningTool = partsHaveRunningTool(parts);
  // The run is parked at the tool gate waiting on a human decision — it isn't doing
  // work, so the tail should read as "paused" rather than a ticking spinner. This holds
  // while the message is still streaming (legacy in-flight gate) AND once the run has
  // durably paused: the session status is `awaiting_approval` and the assistant message
  // is persisted as `completed`, but a tool-call part still needs approval.
  const awaitingApproval = (isRunning || sessionIsPaused) && hasPendingApproval;
  // An ask_user_question lives in the turn as a tool-call carrying `question` state. Whether
  // pending or already answered, it is a meaningful interaction we always keep visible (never
  // folded into the collapsed "N steps" summary).
  const hasQuestionPart = parts.some(
    (part) => part.type === "tool-call" && part.toolCall.question !== undefined,
  );

  // A still-running tool call on a stopped session reads as failed — it never returned.
  // A tool call awaiting an approval decision is the exception: the run paused on purpose
  // (session is `awaiting_approval`, not generating), so it must keep rendering its
  // approval prompt rather than flipping to "Stopped before finishing".
  const normalizedParts: AssistantTurnPart[] = parts.map((part) =>
    part.type === "tool-call" &&
    part.toolCall.status === "running" &&
    !sessionCanGenerate &&
    part.toolCall.approval?.status !== "required" &&
    part.toolCall.question === undefined
      ? {
          type: "tool-call",
          toolCall: {
            ...part.toolCall,
            status: "failed" as const,
            outputPreview:
              part.toolCall.outputPreview ||
              (sessionIsInterrupted
                ? "Interrupted before this tool returned a result."
                : "Stopped before finishing."),
          },
        }
      : part,
  );

  // A completed turn reads as a deliverable: the trailing text is the headline, and the work
  // that produced it — the intermediate narration plus the tool steps — collapses into one
  // "N steps" summary. Reasoning keeps its own card. While the turn is still running nothing
  // collapses, so the live narration and steps stay visible (tool calls grouped while
  // consecutive, text inline).
  type RenderGroup =
    | { kind: "part"; part: AssistantTurnPart; key: string }
    | { kind: "tools"; toolCalls: RuntimeToolCall[]; key: string }
    | { kind: "process"; parts: AssistantTurnPart[]; key: string };

  const deliverableStart = isCompleted
    ? deliverableStartIndex(normalizedParts)
    : normalizedParts.length;
  // While paused at a tool gate or running a resumed tool, keep the steps expanded inline
  // rather than folding the completed message into a "N steps" summary that would hide it.
  const collapseWork =
    isCompleted &&
    !awaitingApproval &&
    !hasRunningTool &&
    !hasQuestionPart &&
    normalizedParts.slice(0, deliverableStart).some((part) => part.type === "tool-call");

  const groups: RenderGroup[] = [];
  normalizedParts.forEach((part, index) => {
    // Completed turn: fold the intermediate narration + tool steps into one collapsed group.
    if (collapseWork && index < deliverableStart && part.type !== "reasoning") {
      const last = groups.at(-1);
      if (last?.kind === "process") last.parts.push(part);
      else groups.push({ kind: "process", parts: [part], key: `process:${index}` });
      return;
    }

    if (part.type === "tool-call") {
      const last = groups.at(-1);
      if (last?.kind === "tools") last.toolCalls.push(part.toolCall);
      else groups.push({ kind: "tools", toolCalls: [part.toolCall], key: `tools:${index}` });
      return;
    }

    groups.push({ kind: "part", part, key: `${index}` });
  });
  const streamingTextGroupKey = isRunning ? findLatestTextGroupKey(groups) : null;

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        if (group.kind === "part") {
          const part = group.part;
          if (part.type === "text") {
            return (
              <AssistantMarkdown
                key={group.key}
                content={part.text}
                streaming={group.key === streamingTextGroupKey}
              />
            );
          }
          if (part.type === "reasoning") {
            return (
              <ReasoningCard
                key={group.key}
                text={part.text}
                durationSeconds={part.durationSeconds}
              />
            );
          }
          return null;
        }

        if (group.kind === "process") {
          return (
            <CompletedStepGroup
              key={group.key}
              parts={group.parts}
              durationSeconds={runDurationSeconds}
            />
          );
        }

        return (
          <div key={group.key} className="space-y-1.5">
            {group.toolCalls.map((toolCall) => (
              <ToolCallCard
                key={toolCall.id}
                toolCall={toolCall}
                sessionIsInterrupted={sessionIsInterrupted}
              />
            ))}
          </div>
        );
      })}
      {awaitingApproval ? (
        // Parked at the tool gate: the run is waiting on the user, not working. Show a
        // static "paused" tail so the spinner and elapsed timer stop implying progress.
        <PausedForApprovalNotice />
      ) : !hasParts ? (
        isRunning ? (
          <WorkingIndicator
            startedAt={activeStartedAt ?? message.createdAt}
            thinking={reasoningActive}
          />
        ) : isStopped ? (
          <AssistantStoppedNotice errorMessage={stoppedError} />
        ) : (
          "..."
        )
      ) : isRunning ? (
        // Keep a live indicator at the tail so the UI never goes silent between a tool
        // result and the model's next output (thinking phases included).
        <WorkingIndicator
          startedAt={activeStartedAt ?? message.createdAt}
          thinking={reasoningActive}
        />
      ) : null}
      {hasParts && isStopped ? <AssistantStoppedNotice errorMessage={stoppedError} /> : null}
    </div>
  );
}

function activeStartForAssistantMessage(
  message: SessionMessage,
  visibleMessages: SessionMessage[],
) {
  if (message.role !== "assistant" || message.status !== "running") return undefined;
  if (message.responseToMessageId) {
    const responseToMessage = visibleMessages.find(
      (item) => item.id === message.responseToMessageId,
    );
    if (responseToMessage?.createdAt) return responseToMessage.createdAt;
  }

  const messageIndex = visibleMessages.findIndex((item) => item.id === message.id);
  if (messageIndex > 0) {
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const previous = visibleMessages[index];
      if (previous?.role === "user" && previous.createdAt) return previous.createdAt;
    }
  }

  return message.createdAt;
}

function findLatestTextGroupKey(
  groups: Array<
    | { kind: "part"; part: AssistantTurnPart; key: string }
    | { kind: "tools"; toolCalls: RuntimeToolCall[]; key: string }
    | { kind: "process"; parts: AssistantTurnPart[]; key: string }
  >,
) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.kind === "part" && group.part.type === "text") return group.key;
  }
  return null;
}

// The trailing run of text parts is the deliverable headline; everything before it is the
// work that produced it. Returns the index where that trailing text run begins (the length
// when the turn does not end in text, e.g. it ended on a tool call).
function deliverableStartIndex(parts: AssistantTurnPart[]) {
  let start = parts.length;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== "text") break;
    start = index;
  }
  return start;
}

function CompletedStepGroup({
  parts,
  durationSeconds,
}: {
  parts: AssistantTurnPart[];
  durationSeconds: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = parts.reduce((total, part) => (part.type === "tool-call" ? total + 1 : total), 0);
  const durationLabel = durationSeconds > 0 ? ` · ${formatStepDuration(durationSeconds)}` : "";
  const summary = `${count} ${count === 1 ? "step" : "steps"}${durationLabel}`;

  return (
    <div className="-ml-1 text-[11.5px] leading-5 text-ink-muted">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75"
      >
        <ChevronRight
          size={11}
          strokeWidth={1.9}
          className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
          <Wrench size={11} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate font-medium text-ink/65">{summary}</span>
      </button>
      {expanded ? (
        <div className="ml-2 mt-1 space-y-1.5 border-l border-border pl-3">
          {parts.map((part, index) =>
            part.type === "tool-call" ? (
              <ToolCallCard key={part.toolCall.id} toolCall={part.toolCall} />
            ) : part.type === "text" ? (
              <AssistantMarkdown key={`text:${index}`} content={part.text} />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function runDurationForMessage(message: SessionMessage) {
  if (!message.completedAt || !message.createdAt) return 0;
  const start = new Date(message.createdAt).getTime();
  const end = new Date(message.completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return (end - start) / 1000;
}

function formatStepDuration(seconds: number) {
  const total = Math.max(Math.round(seconds), 1);
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  return `${minutes} min`;
}

function AssistantStoppedNotice({
  elapsedSeconds,
  errorMessage,
}: {
  elapsedSeconds?: number | null;
  errorMessage?: string | null;
}) {
  const detail = errorMessage?.trim();
  return (
    <div className="inline-flex max-w-full items-center gap-1.5 text-[12.5px] font-medium leading-6 text-danger">
      <AlertCircle size={13} strokeWidth={1.8} className="shrink-0" />
      <span>Stopped before finishing</span>
      {detail ? (
        <span className="min-w-0 break-words text-[12px] font-normal leading-5 text-danger/80">
          : {detail}
        </span>
      ) : null}
      {typeof elapsedSeconds === "number" ? (
        <span className="text-[12px] font-normal tabular-nums text-danger/70">
          {formatElapsed(elapsedSeconds)}
        </span>
      ) : null}
    </div>
  );
}

function PausedForApprovalNotice() {
  return (
    <div className="inline-flex items-center gap-1.5 text-[12.5px] font-medium leading-6 text-warning">
      <ShieldAlert size={13} strokeWidth={1.8} className="shrink-0" />
      <span>Paused: waiting for your approval</span>
    </div>
  );
}

function ReasoningCard({
  text,
  durationSeconds,
}: {
  text: string | undefined;
  durationSeconds: number | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = Boolean(text);

  return (
    <div className="text-[11.5px] leading-5 text-ink-muted">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (hasSummary) setExpanded((current) => !current);
        }}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-px text-left transition-colors hover:text-ink/75"
      >
        {hasSummary ? (
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        ) : null}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
          <Brain size={11} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate font-medium text-ink/65">
          {formatThinkingDuration(durationSeconds)}
        </span>
      </button>
      {expanded && text ? (
        <div className="mt-1 border-l border-border pl-3">
          <div className="py-1 text-[11.5px] leading-5 text-ink/65">
            <AssistantMarkdown content={text} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolCallCard({
  toolCall,
  sessionIsInterrupted = false,
}: {
  toolCall: RuntimeToolCall;
  sessionIsInterrupted?: boolean;
}) {
  // ask_user_question renders a dedicated question card (interactive while pending, a read-only
  // summary once answered/cancelled) instead of the generic tool-call chrome.
  if (toolCall.question) {
    return <QuestionCard toolCall={toolCall} />;
  }
  const interrupted =
    sessionIsInterrupted &&
    (toolCall.status === "running" ||
      toolCall.outputPreview === "Interrupted before this tool returned a result.");
  return (
    <ToolCallCardDefault
      toolCall={
        interrupted && toolCall.status === "running"
          ? {
              ...toolCall,
              status: "failed" as const,
              outputPreview:
                toolCall.outputPreview || "Interrupted before this tool returned a result.",
            }
          : toolCall
      }
      interrupted={interrupted}
    />
  );
}

function ToolCallCardDefault({
  toolCall,
  interrupted = false,
}: {
  toolCall: RuntimeToolCall;
  interrupted?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const approvalContext = useContext(ToolApprovalContext);
  const { showError } = useToast();
  const [isResolving, startResolve] = useTransition();
  // Optimistic overlay: reflect the click immediately, before the runner's durable
  // tool.approval_resolved event arrives over the stream and converges the derived state.
  const [optimisticDecision, setOptimisticDecision] = useState<"approved" | "denied" | null>(null);

  const isCompleted = toolCall.status === "completed";
  const activityLine = latestActivityLine(toolCall.activityPreview);
  const isFailed = toolCall.status === "failed";
  // Only count elapsed time for running tool calls — completed/failed/interrupted never need it.
  const isRunning = toolCall.status === "running";
  const elapsedSeconds = useElapsedSeconds(isRunning ? toolCall.startedAt : undefined);
  // Show the live counter only after 20s so it stays quiet for normal-length tool calls.
  const showElapsedCounter = isRunning && elapsedSeconds >= 20;
  const awaitingApproval = toolCall.approval?.status === "required" && optimisticDecision === null;
  const resolvingApproval = toolCall.approval?.status === "required" && optimisticDecision !== null;
  const approvalStatusLabel = toolApprovalStatusLabel(toolCall, optimisticDecision);

  const submitDecision = (decision: "approved" | "denied") => {
    if (!approvalContext) return;
    setOptimisticDecision(decision);
    startResolve(async () => {
      const result = await resolveToolApproval({
        sessionId: approvalContext.sessionId,
        toolCallId: toolCall.id,
        decision,
      });
      if (!result.ok) {
        setOptimisticDecision(null);
        showError(result.error);
      }
    });
  };

  return (
    <div className="-ml-1 text-[11.5px] leading-5 text-ink-muted">
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
            {toolCall.name === AFTER_SESSION_TOOL_NAME ? (
              <Brain size={11} strokeWidth={1.75} />
            ) : (
              <Wrench size={11} strokeWidth={1.75} />
            )}
          </span>
          <span className="min-w-0 truncate font-medium text-ink/65" title={toolCall.name}>
            {toolCall.label || formatToolName(toolCall.name)}
          </span>
          {toolCall.brainFile || toolCall.brainPath ? (
            <span
              title={`Updated ${brainFileTitle(
                toolCall.brainFile ??
                  ({
                    scope: "company",
                    path: toolCall.brainPath ?? "",
                  } satisfies RuntimeBrainFileReference),
              )}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success-border bg-success-bg px-1.5 py-px text-[10.5px] font-medium text-success"
            >
              <Brain size={9} strokeWidth={1.9} />
              Brain updated
            </span>
          ) : null}
          {approvalStatusLabel ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
                approvalStatusLabel.tone === "danger"
                  ? "text-danger"
                  : approvalStatusLabel.tone === "success"
                    ? "text-success"
                    : "text-warning"
              }`}
            >
              <ShieldAlert size={9} strokeWidth={1.9} />
              {approvalStatusLabel.label}
            </span>
          ) : isFailed ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
                interrupted ? "text-warning" : "text-danger"
              }`}
            >
              <AlertCircle size={9} strokeWidth={1.9} />
              {interrupted ? "interrupted" : "failed"}
            </span>
          ) : !isCompleted ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-subtle">
              <LoaderCircle size={9} strokeWidth={2} className="animate-spin text-warning" />
              {showElapsedCounter ? (
                <>
                  running · <span className="tabular-nums">{formatElapsed(elapsedSeconds)}</span>
                </>
              ) : (
                "running"
              )}
            </span>
          ) : null}
        </button>
        {toolCall.issueUrl ? (
          <a
            href={toolCall.issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="In Linear öffnen"
            className="inline-flex shrink-0 items-center rounded-md p-0.5 text-ink-subtle transition-colors hover:bg-surface-hover/65 hover:text-ink/75"
          >
            <ExternalLink size={11} strokeWidth={1.9} />
          </a>
        ) : null}
      </div>
      {awaitingApproval || resolvingApproval ? (
        <ToolApprovalPrompt
          approval={toolCall.approval}
          inputPreview={toolCall.inputPreview}
          disabled={isResolving || resolvingApproval || !approvalContext}
          optimisticDecision={optimisticDecision}
          onApprove={() => submitDecision("approved")}
          onDeny={() => submitDecision("denied")}
        />
      ) : null}
      {/* Memory passes keep their one-line summary visible when collapsed (it IS the result);
          other tools hide stale activity once the output preview exists. */}
      {activityLine &&
      !expanded &&
      (!toolCall.outputPreview || toolCall.name === AFTER_SESSION_TOOL_NAME) ? (
        <div
          title={activityLine}
          className="ml-6 mt-0.5 max-w-[min(520px,calc(100vw-112px))] truncate text-[11px] leading-4 text-ink-subtle"
        >
          {activityLine}
        </div>
      ) : null}
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          {toolCall.inputPreview ? (
            <ToolCallPreview label="Input" value={toolCall.inputPreview} />
          ) : null}
          {toolCall.activityPreview && !toolCall.outputPreview ? (
            <ToolCallPreview label="Activity" value={toolCall.activityPreview} />
          ) : null}
          {toolCall.subagent ? <SubagentProgressView subagent={toolCall.subagent} /> : null}
          {toolCall.outputPreview ? (
            <ToolCallPreview label="Output" value={toolCall.outputPreview} />
          ) : null}
          {!toolCall.activityPreview && !toolCall.outputPreview && !isCompleted && !isFailed ? (
            <div className="py-1 text-[11px] text-ink-subtle">Waiting for result</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type QuestionSelection = {
  labels: string[];
  otherSelected: boolean;
  otherText: string;
};

function questionSelectionComplete(question: RuntimeQuestionItem, selection: QuestionSelection) {
  if (selection.otherSelected) {
    return question.allowOther && selection.otherText.trim().length > 0;
  }
  return selection.labels.length > 0;
}

// Renders an ask_user_question tool call IN THE TRANSCRIPT. The interactive form now lives in the
// composer slot (QuestionComposer), so here we only show a compact read-only reference while the
// question is pending, and the answer/skip summary once it resolves.
function QuestionCard({ toolCall }: { toolCall: RuntimeToolCall }) {
  const question = toolCall.question;
  if (!question) return null;
  if (question.status === "pending") {
    return <QuestionPendingHint question={question} />;
  }
  return <QuestionSummary question={question} />;
}

// Transcript placeholder while the agent waits on an answer: lists what was asked and points the
// user at the composer, where the stepped QuestionComposer is the actual input surface.
function QuestionPendingHint({ question }: { question: NonNullable<RuntimeToolCall["question"]> }) {
  const questions = question.questions;
  return (
    <div className="mt-1 rounded-lg border border-border bg-surface-raised/70 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        <MessageCircleQuestion size={11} strokeWidth={1.9} />
        {questions.length > 1 ? `${questions.length} questions` : "A quick question"}
      </div>
      <div className="space-y-1">
        {questions.map((item, index) => (
          <div key={`${item.header}:${index}`} className="text-[12px] leading-5 text-ink/80">
            {item.question}
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-muted">Answer below to continue.</div>
    </div>
  );
}

// The stepped input surface for a pending ask_user_question. It takes over the composer slot and
// walks the user through one question per step (select → Continue → … → Submit), so answering feels
// like the message composer. Skip/X resolves quietly (see cancelAgentSessionQuestion): no assistant
// turn fires; the composer simply returns to its text form.
function QuestionComposer({
  sessionId,
  toolCall,
}: {
  sessionId: string;
  toolCall: RuntimeToolCall;
}) {
  const { showError } = useToast();
  const [isResolving, startResolve] = useTransition();
  // Optimistic overlay so the surface stays put until the runner's durable question.answered event
  // arrives over the stream and the composer swaps back to its text form.
  const [optimistic, setOptimistic] = useState<"submitting" | "cancelling" | null>(null);
  const [step, setStep] = useState(0);
  const stepRef = useRef<HTMLDivElement | null>(null);
  const questions = toolCall.question?.questions ?? [];
  const [selections, setSelections] = useState<QuestionSelection[]>(() =>
    questions.map(() => ({ labels: [], otherSelected: false, otherText: "" })),
  );

  const total = questions.length;
  const safeStep = Math.min(step, Math.max(total - 1, 0));
  const current = questions[safeStep];
  const selection = selections[safeStep] ?? { labels: [], otherSelected: false, otherText: "" };
  const isLast = safeStep >= total - 1;
  const controlsDisabled = isResolving || optimistic !== null;
  const canAdvance = current ? questionSelectionComplete(current, selection) : false;

  const updateSelection = (index: number, next: Partial<QuestionSelection>) => {
    setSelections((value) =>
      value.map((entry, i) => (i === index ? { ...entry, ...next } : entry)),
    );
  };

  const chooseOption = (index: number, label: string) => {
    const item = questions[index];
    if (!item) return;
    if (item.allowMultiple) {
      const labels = selection.labels.includes(label)
        ? selection.labels.filter((value) => value !== label)
        : [...selection.labels, label];
      updateSelection(index, { labels });
    } else {
      updateSelection(index, { labels: [label], otherSelected: false });
    }
  };

  const chooseOther = (index: number) => {
    const item = questions[index];
    if (!item) return;
    if (item.allowMultiple) {
      updateSelection(index, { otherSelected: !selection.otherSelected });
    } else {
      updateSelection(index, { labels: [], otherSelected: true });
    }
  };

  const submit = () => {
    const answers = questions.map((_, index) => {
      const entry = selections[index] ?? { labels: [], otherSelected: false, otherText: "" };
      const otherText = entry.otherSelected ? entry.otherText.trim() : "";
      return otherText
        ? { selectedLabels: entry.labels, otherText }
        : { selectedLabels: entry.labels };
    });
    setOptimistic("submitting");
    startResolve(async () => {
      const result = await submitAgentSessionQuestionResponse({
        sessionId,
        toolCallId: toolCall.id,
        answers,
      });
      if (!result.ok) {
        setOptimistic(null);
        showError(result.error);
      }
    });
  };

  const cancel = () => {
    setOptimistic("cancelling");
    startResolve(async () => {
      const result = await cancelAgentSessionQuestion({ sessionId, toolCallId: toolCall.id });
      if (!result.ok) {
        setOptimistic(null);
        showError(result.error);
      }
    });
  };

  const advance = () => {
    if (controlsDisabled || !canAdvance) return;
    if (isLast) submit();
    else setStep(safeStep + 1);
  };

  // Move focus to the step's first option whenever the step changes, so keyboard users land on the
  // active question rather than the surface chrome.
  useEffect(() => {
    if (controlsDisabled) return;
    const target = stepRef.current?.querySelector<HTMLElement>("[role='radio'],[role='checkbox']");
    target?.focus();
  }, [safeStep, controlsDisabled]);

  if (!current) return null;

  const statusLine =
    optimistic === "submitting"
      ? "Sending answer…"
      : optimistic === "cancelling"
        ? "Skipping…"
        : total > 1
          ? `Question ${safeStep + 1} of ${total}`
          : "A quick question";

  return (
    <div className="group/composer">
      <div
        // Escape skips the whole question (quiet decline). Enter advances/submits unless the focused
        // element is itself a button (option toggle or the primary action) that handles its own key.
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            if ((event.target as HTMLElement)?.tagName === "BUTTON") return;
            event.preventDefault();
            advance();
          }
        }}
        className="rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-shadow focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.05)]"
      >
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink/70">
            <MessageCircleQuestion size={13} strokeWidth={1.9} />
            <span role="status" aria-live="polite">
              {statusLine}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {total > 1 ? (
              <div className="flex items-center gap-1" aria-hidden>
                {questions.map((item, index) => (
                  <span
                    key={`${item.header}:${index}`}
                    className={`h-1.5 rounded-full transition-all ${
                      index === safeStep
                        ? "w-4 bg-ink"
                        : index < safeStep
                          ? "w-1.5 bg-ink/50"
                          : "w-1.5 bg-border-strong"
                    }`}
                  />
                ))}
              </div>
            ) : null}
            <button
              type="button"
              aria-label="Skip question"
              disabled={controlsDisabled}
              onClick={cancel}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {optimistic === "cancelling" ? (
                <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <X size={13} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>

        <div ref={stepRef} aria-current="step">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            {current.header}
          </div>
          <div className="mb-2 text-[13.5px] leading-5 text-ink/90">
            {current.question}
            {current.allowMultiple ? (
              <span className="ml-1 text-[11px] text-ink-subtle">(select all that apply)</span>
            ) : null}
          </div>
          <div className="space-y-1" role={current.allowMultiple ? "group" : "radiogroup"}>
            {current.options.map((option) => (
              <QuestionOptionRow
                key={option.label}
                label={option.label}
                description={option.description}
                selected={selection.labels.includes(option.label)}
                multiple={current.allowMultiple}
                disabled={controlsDisabled}
                onClick={() => chooseOption(safeStep, option.label)}
              />
            ))}
            {current.allowOther ? (
              <QuestionOtherOptionRow
                selected={selection.otherSelected}
                value={selection.otherText}
                multiple={current.allowMultiple}
                disabled={controlsDisabled}
                onSelect={() => chooseOther(safeStep)}
                onChange={(otherText) => updateSelection(safeStep, { otherText })}
              />
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={controlsDisabled || safeStep === 0}
            onClick={() => setStep(Math.max(safeStep - 1, 0))}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-0"
          >
            <ChevronLeft size={13} strokeWidth={2} />
            Back
          </button>
          <button
            type="button"
            disabled={controlsDisabled || !canAdvance}
            onClick={advance}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-ink px-3 text-[12px] font-medium text-surface transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {optimistic === "submitting" ? (
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
            ) : isLast ? (
              <Check size={12} strokeWidth={2.2} />
            ) : null}
            {isLast ? "Submit" : "Continue"}
            {!isLast ? <ChevronRight size={13} strokeWidth={2} /> : null}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionSelectionMark({ selected, multiple }: { selected: boolean; multiple: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-surface ${
        multiple ? "rounded-[4px]" : "rounded-full"
      } ${selected ? "border-ink bg-ink" : "border-border-strong bg-surface"}`}
    >
      {selected ? <Check size={9} strokeWidth={3} /> : null}
    </span>
  );
}

function QuestionOptionRow({
  label,
  description,
  selected,
  multiple,
  disabled,
  onClick,
}: {
  label: string;
  description?: string | undefined;
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? "border-ink/40 bg-ink/[0.04]"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover"
      }`}
    >
      <QuestionSelectionMark selected={selected} multiple={multiple} />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium leading-5 text-ink/90">{label}</span>
        {description ? (
          <span className="block text-[11px] leading-4 text-ink-muted">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

function QuestionOtherOptionRow({
  selected,
  value,
  multiple,
  disabled,
  onSelect,
  onChange,
}: {
  selected: boolean;
  value: string;
  multiple: boolean;
  disabled: boolean;
  onSelect: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-label="Other answer"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled || event.target instanceof HTMLInputElement) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-60"
          : selected
            ? "cursor-default"
            : "cursor-pointer hover:border-border-strong hover:bg-surface-hover"
      } ${selected ? "border-ink/40 bg-ink/[0.04]" : "border-border bg-surface"}`}
    >
      <QuestionSelectionMark selected={selected} multiple={multiple} />
      {selected ? (
        <input
          type="text"
          value={value}
          disabled={disabled}
          autoFocus
          aria-label="Other answer text"
          placeholder="Type your answer"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium leading-5 text-ink/90 outline-none placeholder:text-ink-muted disabled:opacity-50"
        />
      ) : (
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium leading-5 text-ink/90">Other…</span>
        </span>
      )}
    </div>
  );
}

function QuestionSummary({ question }: { question: NonNullable<RuntimeToolCall["question"]> }) {
  const answered = question.status === "answered";
  const heading = answered
    ? "Your answer"
    : question.resolutionSource === "timeout"
      ? "No answer provided"
      : question.resolutionSource === "abort"
        ? "Cancelled"
        : "Question skipped";

  return (
    <div className="mt-1 rounded-lg border border-border bg-surface-muted/40 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        <MessageCircleQuestion size={11} strokeWidth={1.9} />
        {heading}
      </div>
      {answered ? (
        <div className="space-y-1.5">
          {question.questions.map((item, index) => {
            const answer = question.answers?.[index];
            const chips = [
              ...(answer?.selectedLabels ?? []),
              ...(answer?.otherText ? [answer.otherText] : []),
            ];
            return (
              <div key={`${item.header}:${index}`} className="text-[12px] leading-5">
                <span className="text-ink-muted">{item.question} </span>
                <span className="font-medium text-ink/90">
                  {chips.length > 0 ? chips.join(", ") : "—"}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-[12px] leading-5 text-ink-muted">
          The agent continued without an answer.
        </div>
      )}
    </div>
  );
}

function toolApprovalStatusLabel(
  toolCall: RuntimeToolCall,
  optimisticDecision: "approved" | "denied" | null,
): { label: string; tone: "warning" | "success" | "danger" } | null {
  if (toolCall.approval?.status === "required") {
    if (optimisticDecision === "approved") {
      return { label: "approved, starting...", tone: "success" };
    }
    if (optimisticDecision === "denied") {
      return { label: "denying...", tone: "warning" };
    }
    return { label: "needs approval", tone: "warning" };
  }

  if (toolCall.approval?.status === "denied") {
    return {
      label: toolCall.approval.decisionSource === "timeout" ? "timed out" : "denied",
      tone: "danger",
    };
  }

  if (toolCall.approval?.status === "approved" && toolCall.status !== "completed") {
    return { label: "approved", tone: "success" };
  }

  return null;
}

function ToolApprovalPrompt({
  approval,
  inputPreview,
  disabled,
  optimisticDecision,
  onApprove,
  onDeny,
}: {
  approval: RuntimeToolCall["approval"];
  inputPreview: string | undefined;
  disabled: boolean;
  optimisticDecision: "approved" | "denied" | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const providerName = approval
    ? (PROVIDER_PERMISSION_REGISTRY[approval.providerKey]?.displayName ?? approval.providerKey)
    : "";
  const groupLabel = approval
    ? approval.permissionGroup
      ? permissionLabelFor(approval.providerKey, approval.permissionGroup)
      : "Unknown permission"
    : "";
  const permissionDescription = approval?.permissionGroup
    ? permissionDescriptionFor(approval.providerKey, approval.permissionGroup)
    : "";
  const pendingMessage =
    optimisticDecision === "approved"
      ? "Approved, starting..."
      : optimisticDecision === "denied"
        ? "Denying..."
        : "Waiting for your approval.";

  return (
    <div className="ml-6 mt-1 rounded-md border border-warning-border bg-warning-bg/40 px-2.5 py-2">
      <div className="text-[11px] leading-4 text-ink/75">
        This agent wants to use{" "}
        <span className="font-medium text-ink">
          {providerName}
          {groupLabel ? ` · ${groupLabel}` : ""}
        </span>
        . Approve this action?
      </div>
      {permissionDescription ? (
        <div className="mt-0.5 text-[11px] leading-4 text-ink/60">{permissionDescription}.</div>
      ) : null}
      <div role="status" aria-live="polite" className="mt-1 text-[11px] text-warning">
        {pendingMessage}
      </div>
      {inputPreview ? (
        <pre className="mt-1 max-h-20 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/55">
          {inputPreview}
        </pre>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={onApprove}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-ink px-2.5 text-[11px] font-medium text-surface transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={10} strokeWidth={2.2} />
          Approve
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onDeny}
          className="inline-flex h-6 items-center rounded-md border border-border bg-surface px-2.5 text-[11px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function latestActivityLine(value: string) {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function ToolCallPreview({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1 first:pt-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-ink-subtle">{label}</div>
      <pre className="max-h-36 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
        {value}
      </pre>
    </div>
  );
}

function SubagentProgressView({
  subagent,
}: {
  subagent: NonNullable<RuntimeToolCall["subagent"]>;
}) {
  return (
    <div className="py-1">
      <div className="mb-1 text-[10px] font-medium uppercase text-ink-subtle">{subagent.label}</div>
      <div className="space-y-1 rounded-md border border-border/70 bg-surface-muted/40 px-2 py-1.5">
        {subagent.toolLines.length > 0 ? (
          <div className="space-y-1">
            {subagent.toolLines.map((line) => (
              <div key={line.id} className="flex min-w-0 items-start gap-1.5 text-[10.5px]">
                <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center text-ink-subtle">
                  {line.status === "running" ? (
                    <LoaderCircle size={10} strokeWidth={2} className="animate-spin text-warning" />
                  ) : line.status === "failed" || line.status === "denied" ? (
                    <AlertCircle size={10} strokeWidth={1.9} className="text-danger" />
                  ) : (
                    <Check size={10} strokeWidth={1.9} className="text-success" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink/65" title={line.name}>
                    {line.label}
                  </div>
                  {line.outputPreview ? (
                    <div className="truncate text-ink-subtle" title={line.outputPreview}>
                      {line.outputPreview}
                    </div>
                  ) : line.inputPreview ? (
                    <div className="truncate text-ink-subtle" title={line.inputPreview}>
                      {line.inputPreview}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {subagent.textPreview ? (
          <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
            {subagent.textPreview}
          </pre>
        ) : subagent.toolLines.length === 0 ? (
          <div className="text-[10.5px] text-ink-subtle">Waiting for subagent activity</div>
        ) : null}
      </div>
    </div>
  );
}

function formatToolName(name: string) {
  const normalized = name.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Tool call";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function SessionInspector({
  session,
  related,
  currentStatus,
  lastError,
  streamStatus,
  streamErrorMessage,
  connectionStale,
  runnerConfigured,
  eventCount,
  usage,
  toolUsage,
  cost,
  recentEvents,
  canAbort,
  isPending,
  onAbort,
}: {
  session: AgentSessionDetailPayload["session"];
  related: AgentSessionDetailPayload["related"];
  currentStatus: string;
  lastError: string | null;
  streamStatus: string;
  streamErrorMessage: string | null;
  connectionStale: boolean;
  runnerConfigured: boolean;
  eventCount: number;
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  recentEvents: RuntimeEvent[];
  canAbort: boolean;
  isPending: boolean;
  onAbort: () => void;
}) {
  const surface = useSessionSurface();
  // The personal surface has a single agent page (no per-agent route), so the agent link
  // collapses to /personal/agent there.
  const agentHref =
    surface === "personal"
      ? personalPaths.agent
      : `/company/agents/${session.agentPath ?? session.agentId}`;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
          <Bot size={14} strokeWidth={1.9} className="text-ink-muted" />
          Session
        </div>
        <div className="mt-4 space-y-4">
          <InspectorLink
            label="Session page"
            href={sessionHrefForSurface(surface, session.id)}
            value={session.id}
          />
          <InspectorLink label="Agent" href={agentHref} value={session.agentName} />
          <InspectorField label="Title" value={session.title} />
          <InspectorStatusField status={currentStatus} lastError={lastError} />
          <InspectorField label="Created" value={formatRuntimeDate(session.createdAt)} />
          <InspectorField label="Updated" value={formatRuntimeDate(session.updatedAt)} />
        </div>
      </div>

      {(related.parent || related.children.length > 0) && (
        <div>
          <InspectorHeader label="Related sessions" countLabel={relatedCountLabel(related)} />
          <div className="space-y-4">
            {related.parent ? (
              <InspectorRelatedSession label="Generated by" session={related.parent} />
            ) : null}
            {related.children.length > 0 ? (
              <div>
                <div className="text-[10.5px] font-medium uppercase text-ink-subtle">
                  Generated sessions
                </div>
                <div className="mt-2 space-y-2">
                  {related.children.map((child) => (
                    <RelatedSessionLink key={child.id} session={child} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div>
        <InspectorHeader label="Runtime" countLabel={streamStatusLabel(streamStatus)} />
        <div className="space-y-4">
          <InspectorField label="Model provider" value={session.modelProvider} mono />
          <InspectorField label="Model" value={session.modelName} mono />
          <InspectorField
            label="Live stream"
            value={runnerConfigured ? "Configured" : "Not configured"}
          />
          <InspectorField label="Workdir" value={session.workdir} mono />
          {session.e2bSandboxId ? (
            <InspectorField label="Sandbox" value={session.e2bSandboxId} mono />
          ) : null}
          {session.runLeaseId ? (
            <InspectorField label="Run lease" value={session.runLeaseId} mono />
          ) : null}
          {session.abortRequestedAt ? (
            <InspectorField
              label="Abort requested"
              value={formatRuntimeDate(session.abortRequestedAt)}
            />
          ) : null}
          <InspectorField label="Activity events" value={String(eventCount)} />
        </div>
        {lastError ? (
          <div className="mt-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[11.5px] leading-4 text-danger">
            {lastError}
          </div>
        ) : streamErrorMessage || streamStatus === "stale" || connectionStale ? (
          <div className="mt-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[11.5px] leading-4 text-warning">
            {streamStatus === "stale" || connectionStale
              ? "The live session stream is not responding. Reconnecting and refreshing persisted progress."
              : streamErrorMessage}
          </div>
        ) : null}
      </div>

      <div>
        <InspectorHeader label="Token usage" countLabel={formatTokenCount(usage.totalTokens)} />
        <div className="space-y-5">
          <div className="space-y-4">
            <InspectorField label="Input total" value={formatTokenCount(usage.inputTokens)} />
            <InspectorField
              label="Input uncached"
              value={formatTokenCount(usage.inputNoCacheTokens)}
            />
            <InspectorField
              label="Input cache read"
              value={formatTokenCount(usage.inputCacheReadTokens)}
            />
            <InspectorField
              label="Input cache write"
              value={formatTokenCount(usage.inputCacheWriteTokens)}
            />
          </div>
          <div className="space-y-4 border-t border-border pt-4">
            <InspectorField label="Output total" value={formatTokenCount(usage.outputTokens)} />
            <InspectorField label="Output text" value={formatTokenCount(usage.outputTextTokens)} />
            <InspectorField
              label="Output reasoning"
              value={formatTokenCount(usage.outputReasoningTokens)}
            />
          </div>
          <InspectorField label="Total tokens" value={formatTokenCount(usage.totalTokens)} />
        </div>
      </div>

      <div>
        <InspectorHeader label="Cost" countLabel={formatUsdMicros(cost.totalCostUsdMicros)} />
        <div className="space-y-4">
          <InspectorField label="Model charges" value={formatUsdMicros(cost.modelCostUsdMicros)} />
          <InspectorField label="Tool charges" value={formatUsdMicros(cost.toolCostUsdMicros)} />
          <InspectorField
            label="Sandbox compute"
            value={formatUsdMicros(cost.sandboxCostUsdMicros)}
          />
          <InspectorField
            label="Provider cost"
            value={formatUsdMicros(cost.providerCostUsdMicros)}
          />
          <InspectorField label="Platform fee" value={formatUsdMicros(cost.platformFeeUsdMicros)} />
        </div>
      </div>

      <div>
        <InspectorHeader
          label="Tool cost"
          countLabel={formatUsdMicros(toolUsage.totalCostUsdMicros)}
        />
        <div className="space-y-4">
          {toolUsage.byProviderOperation.length > 0 ? (
            toolUsage.byProviderOperation.map((item) => (
              <InspectorField
                key={`${item.provider}:${item.operation}`}
                label={`${formatProviderName(item.provider)} ${item.operation}`}
                value={`${formatUsdMicros(item.costUsdMicros)} · ${item.calls} call${
                  item.calls === 1 ? "" : "s"
                }`}
              />
            ))
          ) : (
            <InspectorField label="Hosted tools" value="$0.0000" />
          )}
        </div>
      </div>

      <div>
        <InspectorHeader label="Controls" countLabel={canAbort ? "available" : "idle"} />
        <button
          type="button"
          disabled={isPending || !canAbort}
          onClick={onAbort}
          className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12px] font-medium text-danger transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-45"
        >
          <CircleStop size={13} strokeWidth={1.9} />
          Abort session
        </button>
      </div>

      <div>
        <InspectorHeader label="Recent events" countLabel={`${recentEvents.length} shown`} />
        {recentEvents.length > 0 ? (
          <div className="space-y-1.5">
            {recentEvents.map((event, index) => (
              <div
                key={event.id ?? `transient-${index}`}
                className="rounded-md border border-border bg-surface/55 px-2.5 py-2 text-[11.5px] text-ink-muted"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <TerminalSquare
                    size={12}
                    strokeWidth={1.7}
                    className="shrink-0 text-ink-subtle"
                  />
                  <span className="shrink-0 font-medium text-ink/75">{event.type}</span>
                </div>
                {summarizeEvent(event) ? (
                  <div className="mt-1 truncate text-[11px] text-ink-subtle">
                    {summarizeEvent(event)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
            No runtime events yet
          </div>
        )}
      </div>
    </div>
  );
}

function InspectorHeader({ label, countLabel }: { label: string; countLabel: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
        {countLabel}
      </span>
    </div>
  );
}

function InspectorField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">{label}</div>
      <div
        className={`mt-1 break-words text-[13px] text-ink ${mono ? "font-mono text-[11.5px]" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function InspectorStatusField({ status, lastError }: { status: string; lastError: string | null }) {
  const displayStatus = lastError || status === "failed" ? "failed" : status;

  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">Status</div>
      <div className="mt-1 flex items-center gap-2 text-[13px] text-ink">
        <SessionStatusDot status={displayStatus} />
        <span>{statusLabel(displayStatus)}</span>
      </div>
    </div>
  );
}

function InspectorRelatedSession({
  label,
  session,
}: {
  label: string;
  session: AgentSessionDetailPayload["related"]["children"][number];
}) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">{label}</div>
      <RelatedSessionLink session={session} />
    </div>
  );
}

// Session pages render under both surfaces (/company/session/<id> and /personal/session/<id>);
// inspector links must stay within whichever surface the user is on.
function useSessionSurface(): "personal" | "company" {
  const pathname = usePathname();
  return pathname?.split("/").filter(Boolean)[0] === "personal" ? "personal" : "company";
}

function sessionHrefForSurface(surface: "personal" | "company", sessionId: string) {
  return surface === "personal"
    ? personalPaths.session(sessionId)
    : `/company/session/${sessionId}`;
}

function RelatedSessionLink({
  session,
}: {
  session: AgentSessionDetailPayload["related"]["children"][number];
}) {
  const surface = useSessionSurface();
  return (
    <Link
      href={sessionHrefForSurface(surface, session.id)}
      target="_blank"
      rel="noreferrer"
      title={session.title}
      className="group flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface/45 px-2.5 py-2 text-[12.5px] text-ink transition-colors hover:bg-surface"
    >
      <SessionStatusDot status={session.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{session.title}</span>
        <span className="block truncate text-[11px] text-ink-subtle">{session.agentName}</span>
      </span>
      {session.source === "memory" ? (
        <span className="shrink-0 rounded-sm bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
          Memory
        </span>
      ) : null}
      <ExternalLink size={11} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
    </Link>
  );
}

function relatedCountLabel(related: AgentSessionDetailPayload["related"]) {
  const count = relatedCount(related);
  return `${count} linked`;
}

function relatedCount(related: AgentSessionDetailPayload["related"]) {
  const count = (related.parent ? 1 : 0) + related.children.length;
  return count;
}

function hasDurableUserMessage(messages: SessionMessage[], optimistic: OptimisticUserMessage) {
  return messages.some((message) => {
    if (message.role !== "user" || message.internal) return false;
    if (optimistic.existingMessageIds.includes(message.id)) return false;
    if (optimistic.confirmedMessageId && message.id === optimistic.confirmedMessageId) return true;
    if (message.content !== optimistic.content) return false;
    if (!message.createdAt) return false;
    const createdAtMs = new Date(message.createdAt).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= optimistic.submittedAtMs - 5000;
  });
}

function newOptimisticMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `optimistic_${crypto.randomUUID()}`;
  }
  return `optimistic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function InspectorLink({
  label,
  href,
  value,
  newTab = false,
}: {
  label: string;
  href: string;
  value: string;
  newTab?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">{label}</div>
      <Link
        href={href}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noreferrer" : undefined}
        className="mt-1 inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium text-ink hover:text-ink/75"
      >
        <span className="truncate">{value}</span>
        <ExternalLink size={11} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
      </Link>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "provisioning") return "Starting";
  if (status === "ready") return "Ready";
  if (status === "running") return "Running";
  if (status === "awaiting_approval" || status === "awaiting_input") return "Paused";
  if (status === "interrupted") return "Interrupted";
  if (status === "completed") return "Done";
  if (status === "aborting") return "Aborting";
  if (status === "archiving") return "Archiving";
  if (status === "archived") return "Archived";
  if (status === "failed") return "Failed";
  if (status === "created") return "Created";
  return status;
}

function streamStatusLabel(status: string) {
  if (status === "live" || status === "open") return "live";
  if (status === "connecting") return "connecting";
  if (status === "error") return "error";
  return "idle";
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatThinkingDuration(seconds: number | undefined) {
  if (seconds === undefined) return "Thought";
  const duration = Math.max(Math.round(seconds), 1);
  return `Thought for ${duration} ${duration === 1 ? "second" : "seconds"}`;
}

function formatProviderName(value: string) {
  if (!value) return "Provider";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatRuntimeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function summarizeEvent(event: RuntimeEvent) {
  if (event.type === "after_session.started") return "Updating memory started";
  if (event.type === "after_session.spawned") return "Updating memory started";
  if (event.type === "after_session.completed") return "Updating memory completed";
  if (event.type === "after_session.skipped") {
    return `Updating memory skipped: ${readString(event.payload.reason)}`;
  }
  if (event.type === "after_session.failed") {
    return `Updating memory failed: ${readString(event.payload.message)}`;
  }
  if (event.type === "message.reasoning_started") return "Thinking started";
  if (event.type === "message.reasoning_completed") return "Thinking completed";
  if (event.type === "message.reasoning_summary") return "Thinking summary";
  if (event.type === "message.reasoning_content") return "Reasoning content";
  if (event.type === "session.incomplete") {
    const reason = readString(event.payload.reason);
    if (reason === "announced_unexecuted_next_action") {
      return "Model stopped after announcing a next action";
    }
    return reason ? `Incomplete: ${reason}` : "Incomplete turn";
  }
  if (event.type === "tool.started") return `${readString(event.payload.name)} started`;
  if (event.type === "tool.completed") return `${readString(event.payload.name)} completed`;
  if (event.type === "session.tool_usage") {
    return `${readString(event.payload.provider)} ${formatUsdMicros(
      Number(event.payload.costUsdMicros ?? 0),
    )}`;
  }
  if (event.type === "session.sandbox_usage") {
    const activeSeconds = Math.round(Number(event.payload.activeMs ?? 0) / 1000);
    return `Sandbox compute ${formatUsdMicros(
      Number(event.payload.chargedCostUsdMicros ?? 0),
    )} (${activeSeconds}s active)`;
  }
  if (event.type === "session.delegated_usage") {
    const cost =
      event.payload.cost && typeof event.payload.cost === "object"
        ? (event.payload.cost as Record<string, unknown>)
        : {};
    return `Delegated agent ${formatUsdMicros(Number(cost.totalCostUsdMicros ?? 0))}`;
  }
  if (event.type === "file.changed") return readString(event.payload.path);
  if (event.type === "brain.file_changed") return `brain/${readString(event.payload.path)}`;
  if (event.type === "brain.conflict") return `Brain conflict: ${readString(event.payload.path)}`;
  if (event.type === "command.output") return readString(event.payload.delta).trim();
  return "";
}
