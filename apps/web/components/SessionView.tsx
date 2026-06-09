"use client";

import {
  ATTACHMENT_MAX_PER_MESSAGE,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  modelSupportsAttachments,
  PERMISSION_GROUP_LABELS,
  PROVIDER_PERMISSION_REGISTRY,
  permissionDescriptionFor,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
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
  PanelRight,
  Play,
  Plus,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
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
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { findModel } from "@/components/agent-editor/tools";
import { useCollections } from "@/components/CollectionsProvider";
import { Composer } from "@/components/Composer";
import {
  AttachmentCard,
  ComposerAttachments,
  type PendingAttachment,
  uploadAttachment,
} from "@/components/composer-attachments";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SlashCommandMenu } from "@/components/session/SlashCommandMenu";
import { shouldAnimateStreamingAppend } from "@/components/sessionStreamingAnimation";
import { useToast } from "@/components/ToastProvider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHydrated } from "@/components/useHydrated";
import { useSessionStream } from "@/components/useSessionStream";
import { formatElapsed, WorkingIndicator } from "@/components/WorkingIndicator";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { SessionPageSkeleton } from "@/components/WorkspaceRouteSkeletons";
import {
  abortAgentSession,
  cancelAgentSessionQuestion,
  continueInterruptedSession,
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
  type AssistantTurnPart,
  buildAssistantTurnParts,
  buildBackgroundActivityParts,
  buildSessionDebugTurns,
  isInspectableRuntimeEvent,
  isReasoningInProgress,
  mergeEvents,
  mergeMessages,
  type RuntimeEvent,
  type RuntimeQuestionItem,
  type RuntimeToolCall,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";
import { agentRowToListItem, deriveSessionDetailPlaceholder } from "@/lib/collections/selectors";
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
};

type OptimisticUserMessage = SessionMessage & {
  optimisticId: string;
  submittedAtMs: number;
  confirmedMessageId: string | null;
  existingMessageIds: string[];
};

const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70"
    >
      {children}
    </a>
  ),
};

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

  return <SessionViewContent key={detail.session.id} detail={detail} workspaceId={workspaceId} />;
}

export function SessionViewContent(props: SessionViewContentProps) {
  return (
    <ToolApprovalContext.Provider value={{ sessionId: props.detail.session.id }}>
      <SessionViewContentBody {...props} />
    </ToolApprovalContext.Provider>
  );
}

function SessionViewContentBody({ detail, workspaceId }: SessionViewContentProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const detailKey = sessionQueryKeys.detail(workspaceId, detail.session.id);
  const { showError, showToast } = useToast();
  const session = detail.session;
  const relatedSessionCount = relatedCount(detail.related);
  const previousRelatedSessionCountRef = useRef(relatedSessionCount);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(relatedSessionCount === 0);
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
  const [attachMenuOpen, setAttachMenuOpen] = useState<boolean>(false);
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Latest-attachments ref so the unmount cleanup can revoke all outstanding object URLs
  // with an empty-dep effect (fires on unmount only) instead of re-running on every change.
  const attachmentsRef = useRef(attachments);
  // Sync the ref in an effect (not during render — that trips the react-compiler lint
  // rule) so the empty-dep unmount cleanup below can revoke outstanding object URLs.
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentCapability = modelSupportsAttachments(session.modelName);
  // Attaching is always available: text/code files need no model capability (they are
  // inlined as text). The per-file image/pdf capability gate happens in acceptFiles.
  const attachmentsEnabled = true;

  const acceptFiles = useCallback(
    (files: File[]) => {
      setAttachments((prev) => {
        const next = [...prev];
        for (const file of files) {
          if (next.length >= ATTACHMENT_MAX_PER_MESSAGE) {
            showToast({
              title: "Limit reached",
              description: `Max ${ATTACHMENT_MAX_PER_MESSAGE} files.`,
              tone: "default",
            });
            break;
          }
          const validation = validateAttachmentCandidate({
            mediaType: file.type,
            sizeBytes: file.size,
            filename: file.name,
          });
          if (!validation.ok) {
            showToast({
              title: validation.reason === "size" ? "File too large" : "Unsupported file",
              description:
                validation.reason === "size"
                  ? "Max 25 MB (images/PDFs) or 2 MB (text files)."
                  : "Images, PDFs, and common text/code files.",
              tone: "default",
            });
            continue;
          }
          // Image/PDF need the model to support them; text is always allowed.
          if (validation.kind === "pdf" && !attachmentCapability.pdf) {
            showToast({
              title: "Unsupported file",
              description: "This session's model can't read PDFs.",
              tone: "default",
            });
            continue;
          }
          if (validation.kind === "image" && !attachmentCapability.images) {
            showToast({
              title: "Unsupported file",
              description: "This session's model can't read images.",
              tone: "default",
            });
            continue;
          }
          const id = crypto.randomUUID();
          next.push({
            id,
            filename: file.name,
            mediaType: file.type,
            kind: validation.kind,
            sizeBytes: file.size,
            status: "uploading",
            ...(validation.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
          });
          void uploadAttachment({ id, file, workspaceId, sessionId: session.id })
            .then((res) =>
              setAttachments((cur) =>
                cur.map((a) => (a.id === id ? { ...a, status: "ready", ...res } : a)),
              ),
            )
            .catch((err) =>
              setAttachments((cur) =>
                cur.map((a) => (a.id === id ? { ...a, status: "error", error: String(err) } : a)),
              ),
            );
        }
        return next;
      });
    },
    [attachmentCapability, session.id, workspaceId, showToast],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);
  // Revoke any still-live preview object URLs when the composer unmounts (e.g. navigating
  // away with unsent attachments) so they don't leak.
  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []);
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
  const dragCounterRef = useRef(0);
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
    // Aggregates (usage/cost/toolUsage) stay server-sourced — the recursive
    // session-tree rollup isn't reproduced client-side (D2); refreshed on
    // completion via the effect below.
    const aggregates = {
      usage: detail.usage,
      toolUsage: detail.toolUsage,
      cost: detail.cost,
      // Server-sourced like the other aggregates (refreshed on turn completion); the context
      // gauge in the top bar reads this rather than the cumulative `usage` total.
      currentContextTokens: detail.currentContextTokens,
    };
    // The Postgres snapshot (`detail`) is the system-of-record floor; the Durable
    // Stream (`streamState`) is the live overlay. Union-merge the two so the
    // transcript paints instantly from the snapshot AND never drops a durable
    // message/event the stream happens to be missing (e.g. a user message that only
    // the best-effort web append publishes, or pre-stream history) — while live
    // deltas still flow.
    //
    // Status/error are scalars, not a union, so they need an explicit authority
    // rule. The stream's scalar status/lastError become authoritative only once it
    // has actually reduced a status-bearing event (`statusObserved`) — NOT merely
    // once it has emitted any event. The distinction matters because, with
    // `seedFromEnd`, the stream tails from the current end without replaying history,
    // so its scalars start at the empty seed (`"created"` / `null`); a lone token or
    // usage delta would otherwise flip authority to that seed and momentarily blank
    // out (or wrongly clear) the snapshot's real status/error — the start-of-session
    // flicker. Until the stream genuinely knows the status, the snapshot stays the
    // source of truth; once it does, the live stream wins (e.g. a brand-new turn, or
    // an error and its recovery).
    return {
      events: mergeEvents(detail.events, streamState.events),
      messages: mergeMessages(detail.messages, streamState.messages),
      ...aggregates,
      currentStatus: streamState.statusObserved ? streamState.currentStatus : detail.session.status,
      lastError: streamState.statusObserved ? streamState.lastError : detail.session.lastError,
    };
  }, [detail, streamState]);
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
  const backgroundParts = useMemo(
    () => buildBackgroundActivityParts(runtime.events, runtime.messages).slice(-8),
    [runtime.events, runtime.messages],
  );
  const visibleMessages = useMemo(
    () =>
      runtime.messages.filter(
        (message) => !message.internal && (message.role === "user" || message.role === "assistant"),
      ),
    [runtime.messages],
  );
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
    const background = findPending(backgroundParts);
    return background?.type === "tool-call" ? background.toolCall : null;
  }, [assistantPartsByMessageId, backgroundParts]);
  const lastVisibleMessage = visibleMessages.at(-1);
  // Index of the last user message. Everything from here down (that message, its reply,
  // the working indicator, background tool cards) is the "active turn" and gets wrapped
  // in a min-height:var(--chat-vh) box so the just-sent message can sit at the top with
  // a viewport of room below it — reserved by CSS, so it survives resize and never
  // needs a JS re-pin. -1 (no user message yet) means no turn to reserve.
  const lastUserTurnStart = visibleMessages.findLastIndex((message) => message.role === "user");
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
  const isBusy = isPending || hasRunningAssistantMessage || showWaitingForAssistant;

  const renderMessage = (message: SessionMessage) => {
    const assistantParts = assistantPartsByMessageId.get(message.id) ?? [];
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
              {message.attachments && message.attachments.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {message.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={`/api/attachments/${att.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      <AttachmentCard
                        kind={att.kind}
                        filename={att.filename}
                        src={att.kind === "image" ? `/api/attachments/${att.id}` : undefined}
                      />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          {canCopy && message.status !== "running" && !awaitingInput ? (
            <div
              className={`absolute ${message.role === "user" ? "top-full right-0 mt-1" : "top-full left-0 mt-1"} z-10 flex items-center gap-1.5 transition-opacity ${
                message.role === "assistant"
                  ? "opacity-100"
                  : "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
              }`}
            >
              <CopyMessageButton text={copyText} />
              {duration > 0 ? (
                <span className="text-[10px] tabular-nums text-ink-subtle/60 select-none">
                  {formatElapsed(Math.round(duration))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
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

  // Browsers don't always fire a final `dragleave` when the user drags out of
  // the window — without this, the drop overlay can stay stuck visible. Reset
  // on window blur so the overlay never outlives the gesture.
  useEffect(() => {
    if (!isDragActive) return;
    const reset = () => {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    };
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, [isDragActive]);

  // A file dropped anywhere in the window — not just on the composer drop zone — must NOT make
  // the browser navigate to / open the file (its default). Prevent that window-wide, and route
  // any in-window file drop into the composer as an attachment.
  useEffect(() => {
    const onWindowDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onWindowDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) acceptFiles(files);
    };
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, [acceptFiles]);

  // The Durable Stream self-recovers (the client reconnects + resumes from its
  // offset) and refresh/visibility recovery is no longer needed — a refresh
  // replays the whole transcript from the stream.

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

  useEffect(() => {
    const previousCount = previousRelatedSessionCountRef.current;
    previousRelatedSessionCountRef.current = relatedSessionCount;
    if (previousCount === 0 && relatedSessionCount > 0) setInspectorCollapsed(false);
  }, [relatedSessionCount]);

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
  // The attached set comes from the synced agent config; the command + metadata come from the
  // workspace skill catalog.
  const { agents } = useCollections();
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  const { data: skillCatalog } = useQuery({
    queryKey: ["workspace-skills", workspaceId],
    queryFn: fetchWorkspaceSkills,
    staleTime: 60_000,
  });
  const allSlashCommands = useMemo(() => {
    const attached = agentRows?.find((agent) => agent.id === session.agentId);
    const attachedIds = new Set(
      (attached ? (agentRowToListItem(attached).config.skills ?? []) : []).map((skill) => skill.id),
    );
    const sources: SkillCommandSource[] = (skillCatalog ?? [])
      .filter((skill) => attachedIds.has(skill.id))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        ...(skill.command ? { command: skill.command } : {}),
      }));
    if (sources.length === 0) return SLASH_COMMANDS;
    return [
      ...SLASH_COMMANDS,
      ...buildSkillSlashCommands(sources, new Set(SLASH_COMMANDS.map((c) => c.id))),
    ];
  }, [agentRows, session.agentId, skillCatalog]);

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

  const runSlashCommand = (command: SlashCommand, args = "") => {
    const commandKey = command.id;
    if (slashCommandInFlightRef.current.has(commandKey)) return;
    slashCommandInFlightRef.current.add(commandKey);
    startTransition(async () => {
      try {
        await command.run({
          session,
          workspaceId,
          router,
          queryClient,
          setInput,
          insertMention,
          showToast,
          args,
        });
      } finally {
        slashCommandInFlightRef.current.delete(commandKey);
      }
    });
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
      runSlashCommand(command);
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
    if (isBusy) return;
    submit();
  };

  const submit = () => {
    if (isBusy) return;
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
      createdAt: new Date(submittedAtMs).toISOString(),
      completedAt: new Date(submittedAtMs).toISOString(),
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
        ready.map((a) => ({
          // biome-ignore lint/style/noNonNullAssertion: filtered above on blobPathname/blobUrl
          blobPathname: a.blobPathname!,
          // biome-ignore lint/style/noNonNullAssertion: filtered above on blobPathname/blobUrl
          blobUrl: a.blobUrl!,
          mediaType: a.mediaType,
          filename: a.filename,
          sizeBytes: a.sizeBytes,
        })),
      );
      if (result.ok) {
        if (pendingTtftRef.current) pendingTtftRef.current.messageId = result.messageId;
        // Sent successfully — drop the previews and clear the tray. Revoke the object
        // URLs so the not-yet-uploaded local-file previews don't leak.
        attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
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
          inspectorCollapsed={inspectorCollapsed}
          onToggleInspector={() => updateInspectorCollapsed(!inspectorCollapsed)}
        />

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
          onDragEnter={(event) => {
            if (!attachmentsEnabled) return;
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            dragCounterRef.current += 1;
            setIsDragActive(true);
          }}
          onDragOver={(event) => {
            if (!attachmentsEnabled) return;
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (!attachmentsEnabled) return;
            event.preventDefault();
            dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
            if (dragCounterRef.current === 0) {
              setIsDragActive(false);
            }
          }}
          onDrop={() => {
            // The window-level drop handler (see effect above) preventDefaults + accepts, so a
            // drop anywhere in the app attaches and the browser never opens the file. Here we
            // only clear the hover overlay (avoids double-accepting the same drop).
            dragCounterRef.current = 0;
            setIsDragActive(false);
          }}
        >
          {isDragActive ? (
            <div
              className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
              aria-hidden="true"
            >
              <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-ink-subtle bg-canvas/85 px-8 py-6 backdrop-blur-sm">
                <Upload size={22} strokeWidth={1.6} className="text-ink-muted" />
                <p className="text-[13px] font-medium text-ink">Drop files to attach</p>
                <p className="text-[11.5px] text-ink-subtle">
                  Images, PDF, text &amp; code · or paste with ⌘V
                </p>
              </div>
            </div>
          ) : null}
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

            {visibleMessages.slice(0, Math.max(lastUserTurnStart, 0)).map(renderMessage)}

            {/* Active turn: the last user message + its reply + indicators, wrapped in a
                min-height box so the just-sent message can sit at the top with a viewport
                of room below it. The reserve is pure CSS (sized from --chat-vh by the
                ResizeObserver), so it adapts to any viewport size and needs no per-frame
                re-pin — the source of the old jitter and resize drift. */}
            <div
              className="space-y-5"
              style={
                lastUserTurnStart >= 0
                  ? { minHeight: `calc(var(--chat-vh, 100dvh) * ${LAST_TURN_MIN_HEIGHT_FACTOR})` }
                  : undefined
              }
            >
              {(lastUserTurnStart >= 0
                ? visibleMessages.slice(lastUserTurnStart)
                : visibleMessages
              ).map(renderMessage)}

              {showWaitingForAssistant ? (
                <div className="flex justify-start">
                  <WorkingIndicator startedAt={lastVisibleMessage?.createdAt} thinking={false} />
                </div>
              ) : showStoppedAfterUser ? (
                <div className="flex justify-start">
                  <AssistantStoppedNotice elapsedSeconds={stoppedElapsedSeconds} />
                </div>
              ) : null}

              {backgroundParts.length > 0 ? (
                <div className="space-y-1.5">
                  {backgroundParts.map((part) =>
                    part.type === "tool-call" ? (
                      <div key={part.toolCall.id} className="flex justify-start">
                        <div className="max-w-[68%] break-words text-[14px] leading-6 text-ink/90">
                          <ToolCallCard
                            toolCall={part.toolCall}
                            sessionIsInterrupted={sessionIsInterrupted}
                          />
                        </div>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : null}
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
                      if (!attachmentsEnabled) return;
                      const items = event.clipboardData?.items;
                      if (!items) return;
                      const files: File[] = [];
                      for (const item of Array.from(items)) {
                        if (item.kind !== "file") continue;
                        const file = item.getAsFile();
                        if (file) files.push(file);
                      }
                      if (files.length === 0) return;
                      // Files in the clipboard: take them as attachments and stop the browser
                      // from also pasting them (e.g. an image) into the textarea. Any text
                      // portion of a mixed paste still falls through normally.
                      event.preventDefault();
                      acceptFiles(files);
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
                        // Text/code files often have no registered MIME, so listing extensions
                        // keeps them pickable; the broad set plus `*` lets any file through and
                        // validation rejects unsupported ones with a toast.
                        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/html,text/csv,application/json,application/xml,text/css,text/yaml,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonc,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cc,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.scss,.sass,.less"
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
                  </>
                }
                action={
                  canAbort && (hasRunningAssistantMessage || showWaitingForAssistant) ? (
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
                  ) : (
                    <button
                      type="button"
                      disabled={
                        isPending ||
                        attachments.some((a) => a.status !== "ready") ||
                        (!parseSlashCommand(input, allSlashCommands) &&
                          (isBusy || (!input.trim() && attachments.length === 0)))
                      }
                      onClick={handleSend}
                      aria-label="Send message"
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:bg-ink/85 disabled:opacity-40"
                    >
                      <ArrowUp size={13} strokeWidth={2} />
                    </button>
                  )
                }
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
function SessionTopBar({
  session,
  currentContextTokens,
  inspectorCollapsed,
  onToggleInspector,
}: {
  session: AgentSessionDetailPayload["session"];
  currentContextTokens: number;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
}) {
  const { agents } = useCollections();
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  const capabilityCount = useMemo(() => {
    const row = agentRows?.find((agent) => agent.id === session.agentId);
    if (!row) return null;
    const config = agentRowToListItem(row).config;
    // `config.tools` already folds MCP servers in (entries with type "mcp"), so tools + MCP is
    // its length; skills are tracked separately.
    return config.tools.length + (config.skills?.length ?? 0);
  }, [agentRows, session.agentId]);

  const model = findModel(session.modelName);
  const ModelIcon = model?.icon ?? Sparkles;
  const modelLabel = model?.label ?? session.modelName.split("/").at(-1) ?? session.modelName;
  const contextMax = model?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

  return (
    <header className="flex items-center justify-between gap-3 px-6 py-2">
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-muted">
        <span className="truncate font-medium text-ink">{session.agentName}</span>
        <span className="shrink-0 text-ink-subtle/60" aria-hidden>
          ·
        </span>
        <span className="flex min-w-0 shrink items-center gap-1.5">
          <ModelIcon size={12} className="shrink-0 text-ink-muted" />
          <span className="truncate">{modelLabel}</span>
        </span>
        {capabilityCount && capabilityCount > 0 ? (
          <>
            <span className="shrink-0 text-ink-subtle/60" aria-hidden>
              ·
            </span>
            <span className="shrink-0">
              {capabilityCount} {capabilityCount === 1 ? "capability" : "capabilities"}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {currentContextTokens > 0 ? (
          <ContextWindowMeter used={currentContextTokens} max={contextMax} />
        ) : null}
        <button
          type="button"
          aria-label={inspectorCollapsed ? "Expand runtime details" : "Collapse runtime details"}
          aria-expanded={!inspectorCollapsed}
          onClick={onToggleInspector}
          className="shrink-0 rounded-md p-1.5 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelRight size={15} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

// Compact token formatter for the context gauge tooltip: 980 → "980", 14_200 → "14k", 1_000_000 → "1M".
function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

// A small ring that fills to the share of the model's context window in use. The exact
// "used / max" figure stays out of the chrome and is surfaced only on hover (native title),
// keeping the top bar quiet.
function ContextWindowMeter({ used, max }: { used: number; max: number }) {
  const fraction = max > 0 ? Math.min(1, used / max) : 0;
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const detail = `${formatCompactTokens(used)} / ${formatCompactTokens(max)} context · ${Math.round(
    fraction * 100,
  )}%`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          aria-label={`Context window usage: ${detail}`}
          className="flex shrink-0 items-center rounded-full text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
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
    </TooltipProvider>
  );
}

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
            <Wrench size={11} strokeWidth={1.75} />
          </span>
          <span className="min-w-0 truncate font-medium text-ink/65" title={toolCall.name}>
            {toolCall.label || formatToolName(toolCall.name)}
          </span>
          {toolCall.brainPath ? (
            <span
              title={`Updated brain/${toolCall.brainPath}`}
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
              running
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
      {activityLine && !expanded && !toolCall.outputPreview ? (
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
      ? PERMISSION_GROUP_LABELS[approval.permissionGroup]
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
  const agentHref = `/agents/${session.agentPath ?? session.agentId}`;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
          <Bot size={14} strokeWidth={1.9} className="text-ink-muted" />
          Session
        </div>
        <div className="mt-4 space-y-4">
          <InspectorLink label="Session page" href={`/session/${session.id}`} value={session.id} />
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

function RelatedSessionLink({
  session,
}: {
  session: AgentSessionDetailPayload["related"]["children"][number];
}) {
  return (
    <Link
      href={`/session/${session.id}`}
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

function formatUsdMicros(value: number) {
  return `$${(value / 1_000_000).toFixed(4)}`;
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
  if (event.type === "after_session.started") return "After-session started";
  if (event.type === "after_session.completed") return "After-session completed";
  if (event.type === "after_session.skipped") {
    return `After-session skipped: ${readString(event.payload.reason)}`;
  }
  if (event.type === "after_session.failed") {
    return `After-session failed: ${readString(event.payload.message)}`;
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
