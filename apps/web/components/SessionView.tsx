"use client";

import { captureEvent } from "@opencompany/analytics/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleStop,
  Copy,
  ExternalLink,
  LoaderCircle,
  PanelRight,
  Plus,
  TerminalSquare,
  Upload,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SlashCommandMenu } from "@/components/session/SlashCommandMenu";
import { shouldAnimateStreamingAppend } from "@/components/sessionStreamingAnimation";
import { useToast } from "@/components/ToastProvider";
import { useSessionEventStream } from "@/components/useSessionEventStream";
import { formatElapsed, WorkingIndicator } from "@/components/WorkingIndicator";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { SessionPageSkeleton } from "@/components/WorkspaceRouteSkeletons";
import { abortAgentSession, submitAgentSessionMessage } from "@/lib/agent-sessions/actions";
import {
  type AgentSessionDetailPayload,
  addUserMessageToSessionDetail,
  applyRuntimeEventToSessionDetail,
  fetchAgentSession,
  fetchSessionStreamCredential,
  invalidateRelatedCachesForSessionEvent,
  mergeAgentSessionDetail,
  SESSIONS_QUERY_STALE_TIME_MS,
  seedSessionQueries,
  sessionQueryKeys,
  updateSessionStatusInDetail,
} from "@/lib/agent-sessions/payload";
import {
  type AssistantTurnPart,
  buildAssistantTurnParts,
  buildBackgroundActivityParts,
  isInspectableRuntimeEvent,
  isReasoningInProgress,
  type RuntimeEvent,
  type RuntimeToolCall,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";
import {
  getSlashContext,
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommand,
} from "@/lib/slash-commands/registry";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const STREAM_APPEND_ANIMATION_MIN_INTERVAL_MS = 120;

// How far from the bottom (in px) before we consider the user "pinned".
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
// Padding above the snapped user message (matches py-6 = 24px of the scroll container).
const SCROLL_TO_TOP_PADDING_PX = 24;

type SessionViewContentProps = {
  detail: AgentSessionDetailPayload;
  workspaceId: string;
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

export default function SessionView({ sessionId }: { sessionId: string }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const detailKey = sessionQueryKeys.detail(workspaceId, sessionId);
  const {
    data: detail,
    isPending,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: detailKey,
    queryFn: async () => {
      const incoming = await fetchAgentSession(sessionId);
      if (incoming === null) return null;
      return mergeAgentSessionDetail(
        queryClient.getQueryData<AgentSessionDetailPayload>(detailKey) ?? undefined,
        incoming,
      );
    },
    staleTime: SESSIONS_QUERY_STALE_TIME_MS,
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

export function SessionViewContent({ detail, workspaceId }: SessionViewContentProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const detailKey = sessionQueryKeys.detail(workspaceId, detail.session.id);
  const streamCredentialKey = sessionQueryKeys.streamCredential(workspaceId, detail.session.id);
  const { showError, showToast } = useToast();
  const session = detail.session;
  const { data: streamCredential } = useQuery({
    queryKey: streamCredentialKey,
    queryFn: () => fetchSessionStreamCredential(session.id),
    enabled: Boolean(detail.runnerUrl),
    staleTime: 55 * 60 * 1000,
  });
  const runnerUrl = streamCredential?.runnerUrl ?? detail.runnerUrl;
  const streamToken = streamCredential?.streamToken ?? null;
  const relatedSessionCount = relatedCount(detail.related);
  const previousRelatedSessionCountRef = useRef(relatedSessionCount);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(relatedSessionCount === 0);
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [attachMenuOpen, setAttachMenuOpen] = useState<boolean>(false);
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
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
  // ID of the user message we should snap to the top of the viewport after render.
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null);
  // The user message currently snapped to the top — used to size the bottom spacer
  // so it shrinks gradually as the response fills the area below it, instead of
  // collapsing a full viewport in one frame when generation ends.
  const [snappedMessageId, setSnappedMessageId] = useState<string | null>(null);
  // Measured height (px) of the spacer below the response. Sized so the snapped
  // message can sit at the top with room below; shrinks toward 0 as the real
  // response grows taller than the viewport.
  const [spacerHeight, setSpacerHeight] = useState(0);
  // Whether the user is "pinned" at the bottom of the scroll container.
  const isPinnedAtBottomRef = useRef(true);
  // Set right after a snap-to-top so the bottom-auto-scroll effect does not
  // immediately yank the message back down. Cleared once the user genuinely
  // scrolls back to the bottom (onScroll) or generation ends.
  const snapInProgressRef = useRef(false);
  // The message id phase 2 has already scrolled to top, so it does not re-snap on
  // every spacer/height change (only on a fresh send).
  const justSnappedRef = useRef<string | null>(null);
  // True only while the user is actively scrolling (wheel / touch). Lets a genuine
  // user scroll be told apart from the programmatic snap/follow scrolls AND from
  // layout-driven scroll events (the spacer shrinking, the viewport height changing).
  // Without it those non-user scrolls hit the bottom threshold and wrongly clear the
  // snap, so the streaming follow drags the just-snapped message back off the top.
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp until which the initial smooth snap is still animating. The maintain
  // pass below holds off correcting drift until this passes, so it never cuts the
  // smooth scroll short.
  const snapSettleUntilRef = useRef(0);
  const runtime = useMemo(
    () => ({
      events: detail.events,
      messages: detail.messages,
      usage: detail.usage,
      toolUsage: detail.toolUsage,
      cost: detail.cost,
      currentStatus: detail.session.status,
      lastError: detail.session.lastError,
    }),
    [detail],
  );
  const knownEventIds = useMemo(
    () => runtime.events.flatMap((event) => (typeof event.id === "number" ? [event.id] : [])),
    [runtime.events],
  );
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
  const lastVisibleMessage = visibleMessages.at(-1);
  const sessionCanGenerate =
    !runtime.lastError &&
    ["created", "provisioning", "ready", "running"].includes(runtime.currentStatus);
  const hasRunningAssistantMessage = visibleMessages.some(
    (message) => message.role === "assistant" && message.status === "running" && sessionCanGenerate,
  );
  const showWaitingForAssistant =
    !hasRunningAssistantMessage && lastVisibleMessage?.role === "user" && sessionCanGenerate;
  const showStoppedAfterUser =
    !hasRunningAssistantMessage && lastVisibleMessage?.role === "user" && !sessionCanGenerate;
  const canAbort = sessionCanGenerate;
  const isBusy = isPending || hasRunningAssistantMessage || showWaitingForAssistant;

  const waitStartedAtRef = useRef<number | null>(null);
  // Felt time-to-first-token: stamped at the Send click, resolved when the first
  // streamed delta paints. `isBusy` blocks concurrent turns, so a single timer is safe.
  const pendingTtftRef = useRef<{ startedAt: number; messageId: string | null } | null>(null);
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
        return;
      }
      queryClient.setQueryData<AgentSessionDetailPayload>(detailKey, (current) =>
        current ? updateSessionStatusInDetail(current, "aborting") : current,
      );
    });
  };

  const applyRuntimeEvent = useCallback(
    (event: RuntimeEvent) => {
      // Felt TTFT: the first visible assistant activity (text or reasoning) ends the timer.
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
      } else if (pendingTtftRef.current && event.type === "message.completed") {
        // Turn ended without ever streaming a delta — drop the stuck timer.
        pendingTtftRef.current = null;
      }

      const current = queryClient.getQueryData<AgentSessionDetailPayload>(detailKey);
      if (!current) return;
      const next = applyRuntimeEventToSessionDetail(current, event);
      seedSessionQueries(queryClient, workspaceId, next);
      invalidateRelatedCachesForSessionEvent(queryClient, workspaceId, session.agentId, event, {
        sessionId: session.id,
      });
      if (
        event.type === "message.completed" ||
        event.type === "tool.completed" ||
        event.type === "tool.failed"
      ) {
        void queryClient.invalidateQueries({ queryKey: detailKey });
      }
    },
    [
      detailKey,
      queryClient,
      workspaceId,
      session.agentId,
      session.id,
      session.modelProvider,
      session.modelName,
    ],
  );

  const refetchSessionDetail = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }, [detailKey, queryClient]);

  const stream = useSessionEventStream({
    runnerUrl,
    streamToken,
    sessionId: session.id,
    knownEventIds,
    onEvent: applyRuntimeEvent,
    onOpen: refetchSessionDetail,
  });

  // Data-freshness staleness detection: derive the timestamp of the last runtime event
  // from runtime.events and compare against a ticked `now` so the stale banner triggers
  // even when SSE reconnects keep flipping stream.status away from "stale".
  const STALE_THRESHOLD_MS = 45_000;
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const lastRuntimeActivityMs = useMemo(() => {
    const last = runtime.events.at(-1);
    if (last?.createdAt) return Date.parse(last.createdAt);
    return Date.parse(detail.session.updatedAt);
  }, [runtime.events, detail.session.updatedAt]);
  const awaitingAssistantWork = hasRunningAssistantMessage || showWaitingForAssistant;
  const sessionFeedsLooksStale =
    awaitingAssistantWork && now - lastRuntimeActivityMs > STALE_THRESHOLD_MS;
  const showStaleBanner =
    awaitingAssistantWork && (stream.status === "stale" || sessionFeedsLooksStale);

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

  // Stale stream/data means the browser may have missed durable events while the tab was
  // backgrounded or connected to a runner that did not own the active job. Refresh the canonical
  // detail so persisted completions appear without a manual page reload.
  const lastRecoveryRefetchAtRef = useRef(0);
  const refetchSessionProgress = useCallback(
    ({ refreshStreamCredential = false }: { refreshStreamCredential?: boolean } = {}) => {
      if (!awaitingAssistantWork) return;
      const currentTime = Date.now();
      if (currentTime - lastRecoveryRefetchAtRef.current < SESSIONS_QUERY_STALE_TIME_MS) return;
      lastRecoveryRefetchAtRef.current = currentTime;
      if (refreshStreamCredential) {
        void queryClient.invalidateQueries({ queryKey: streamCredentialKey });
      }
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
    [awaitingAssistantWork, detailKey, queryClient, streamCredentialKey],
  );

  useEffect(() => {
    if (!showStaleBanner) return;
    refetchSessionProgress({ refreshStreamCredential: stream.status === "stale" });
  }, [refetchSessionProgress, showStaleBanner, stream.status]);

  useEffect(() => {
    if (!awaitingAssistantWork) return;

    const refetchOnVisible = () => {
      if (document.visibilityState !== "hidden") {
        refetchSessionProgress();
      }
    };
    const refetchOnOnline = () => {
      refetchSessionProgress();
    };

    document.addEventListener("visibilitychange", refetchOnVisible);
    window.addEventListener("online", refetchOnOnline);
    return () => {
      document.removeEventListener("visibilitychange", refetchOnVisible);
      window.removeEventListener("online", refetchOnOnline);
    };
  }, [awaitingAssistantWork, refetchSessionProgress]);

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

  // Phase 1 of snap: when a send schedules a scroll, mark the message as snapped,
  // seed a full-viewport spacer so there is always enough scroll range to bring it
  // to the top, and suppress the bottom-auto-scroll until the user genuinely
  // returns to the bottom. The actual scroll happens in the effect below, after
  // the spacer has rendered. Runs on visibleMessages so we catch the render that
  // adds the new message.
  useEffect(() => {
    if (!pendingScrollMessageId) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const msgEl = container.querySelector<HTMLElement>(
      `[data-message-id="${pendingScrollMessageId}"]`,
    );
    if (!msgEl) return;
    setSpacerHeight(container.clientHeight);
    setSnappedMessageId(pendingScrollMessageId);
    setPendingScrollMessageId(null);
    // Allow phase 2 to (re-)snap this message id.
    justSnappedRef.current = null;
    // The user is no longer at the bottom — do NOT re-arm the bottom-auto-scroll.
    // Mark the snap so the streaming follow effect stays suppressed until the
    // user genuinely reaches the bottom again (handled in onScroll).
    isPinnedAtBottomRef.current = false;
    snapInProgressRef.current = true;
  }, [pendingScrollMessageId, visibleMessages]);

  // Phase 2 of snap + maintain: bring the snapped message to the top, then HOLD it
  // there through streaming layout shifts until the user scrolls. Uses rect math so
  // it stays correct even if the wrapper becomes positioned (offsetTop would resolve
  // against the wrong offsetParent then): current scroll + element-top-relative-to-
  // container - padding.
  //
  // Why maintain (not a one-shot snap): after the snap the message sits near the
  // bottom of the scroll range (the spacer fills ~one viewport below it). Any shrink
  // of that range — the viewport growing, or the spacer collapsing as the response
  // fills in — clamps scrollTop down and drags the message down with it. So we re-pin
  // it to the top on each layout change, as long as the snap is still in progress
  // (the user has not returned to the bottom) and the user is not actively scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on every streaming/layout change
  useEffect(() => {
    if (!snappedMessageId) return;
    if (!snapInProgressRef.current) return; // user reached the bottom → release the pin
    if (userScrollIntentRef.current) return; // user is actively scrolling
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    const msgEl = container.querySelector<HTMLElement>(`[data-message-id="${snappedMessageId}"]`);
    if (!msgEl) return;
    const containerRect = container.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    const drift = msgRect.top - containerRect.top - SCROLL_TO_TOP_PADDING_PX;

    if (justSnappedRef.current !== snappedMessageId) {
      // Initial snap — animate, and open a settle window so the maintain pass does
      // not interrupt the in-flight smooth scroll.
      container.scrollTo({ top: container.scrollTop + drift, behavior: "smooth" });
      justSnappedRef.current = snappedMessageId;
      snapSettleUntilRef.current = performance.now() + 450;
      return;
    }
    // Maintain — only after the smooth snap has settled, and only when the message
    // has actually drifted, so we do not churn out no-op scrolls every render.
    if (performance.now() < snapSettleUntilRef.current) return;
    if (Math.abs(drift) <= 2) return;
    container.scrollTo({ top: container.scrollTop + drift, behavior: "auto" });
  }, [
    snappedMessageId,
    spacerHeight,
    visibleMessages,
    hasRunningAssistantMessage,
    showWaitingForAssistant,
  ]);

  // Auto-scroll to bottom during streaming — only if the user is pinned at the bottom.
  // Skip while a snap-to-top scroll is still pending/in-progress so it never fights
  // the snap. Uses behavior "auto" (instant) for streaming follow to avoid jitter
  // from re-issuing smooth scrolls on every delta, and only scrolls when the user
  // has actually drifted away from the bottom by more than the threshold.
  useEffect(() => {
    if (pendingScrollMessageId) return;
    if (snapInProgressRef.current) return;
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

  // Size the bottom spacer so the snapped message can stay at the top with a full
  // viewport of room below it, then shrink the spacer as the real response grows
  // (the spacer only fills the gap the response itself does not yet cover, and
  // reaches 0 once the response is at least a viewport tall).
  //
  // The spacer is sized whenever there IS a snapped message — NOT gated on the
  // generation flags — so it stays put across the generation-end boundary. If it
  // collapsed the instant generation ended, a user who had scrolled down would get a
  // jarring jump as the scroll range shrank under them. It is reset on the next send
  // (phase 1) and falls back to 0 once the snapped message leaves the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on each render of the list
  useEffect(() => {
    const container = scrollContainerRef.current;
    // Defer measurement + state update to a frame after paint so it is not a
    // synchronous cascading setState in the effect body, and so the DOM (including
    // freshly streamed content) reflects the latest render before we measure.
    const raf = requestAnimationFrame(() => {
      if (!snappedMessageId || !container) {
        setSpacerHeight((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const snappedEl = container.querySelector<HTMLElement>(
        `[data-message-id="${snappedMessageId}"]`,
      );
      if (!snappedEl) {
        setSpacerHeight((prev) => (prev === 0 ? prev : 0));
        return;
      }
      setSpacerHeight((prev) => {
        // Height from the top of the snapped message to the bottom of the rendered
        // content, excluding the spacer itself. Once this exceeds the viewport, no
        // spacer is needed, so the spacer shrinks toward 0 as the response grows.
        const contentBelow = container.scrollHeight - snappedEl.offsetTop - prev;
        const next = Math.max(0, container.clientHeight - contentBelow - SCROLL_TO_TOP_PADDING_PX);
        // Only update when it changes meaningfully to avoid render churn / jitter.
        return Math.abs(next - prev) > 1 ? next : prev;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [snappedMessageId, visibleMessages, hasRunningAssistantMessage, showWaitingForAssistant]);

  // Note: snappedMessageId is intentionally NOT cleared when generation ends — the
  // next send overwrites it (phase 1) and resets justSnappedRef so phase 2 re-snaps.
  // Clearing it in an effect would trip the React Compiler's setState-in-effect lint.
  // Trade-off: because the spacer is no longer gated on the generation flags (it
  // stays put across generation-end to avoid a collapse jump), a sub-viewport reply
  // keeps a reserved-whitespace spacer below it until the next send (ChatGPT-style),
  // and the spacer/maintain effects keep re-measuring the stale id until then.

  // Mark the next scroll events as user-driven. Debounced so a single wheel/touch
  // gesture (incl. its momentum scroll burst) stays flagged, then clears shortly
  // after the user stops — programmatic snap/follow scrolls never set this.
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

  // Command mode is active while the caret sits on a `/token` (at the start of the
  // input or after whitespace). The token after the slash is the live filter query.
  const slashContext = useMemo(() => getSlashContext(input, caret), [input, caret]);
  const slashQuery = slashContext?.query ?? null;
  const slashCommands = useMemo(
    () => (slashQuery !== null ? matchSlashCommands(slashQuery) : []),
    [slashQuery],
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
        await command.run({ session, workspaceId, router, queryClient, setInput, showToast, args });
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
    const parsed = parseSlashCommand(input);
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
    if (!content) return;
    setFormError(null);
    // Start the felt-TTFT clock at the click, before the server round-trip, so
    // dispatch latency is counted as part of what the user feels.
    pendingTtftRef.current = { startedAt: performance.now(), messageId: null };
    startTransition(async () => {
      const result = await submitAgentSessionMessage(session.id, content);
      if (result.ok) {
        if (pendingTtftRef.current) pendingTtftRef.current.messageId = result.messageId;
        // Only clear the textarea once the server acknowledged the message —
        // a failed submit should keep the user's draft so they don't lose it.
        setInput("");
        const current = queryClient.getQueryData<AgentSessionDetailPayload>(detailKey);
        if (current) {
          const next = updateSessionStatusInDetail(
            addUserMessageToSessionDetail(current, { messageId: result.messageId, content }),
            "running",
          );
          seedSessionQueries(queryClient, workspaceId, next);
        }
        // Schedule a scroll so the just-sent message snaps to the top of the viewport.
        setPendingScrollMessageId(result.messageId);
        return;
      }
      pendingTtftRef.current = null; // failed send — drop the timer
      setFormError(result.error);
    });
  };

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border-subtle bg-canvas/90 px-6 py-3">
          <div className="mx-auto flex w-full max-w-[960px] items-center gap-3">
            <Bot size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
            <div className="min-w-0 pr-10">
              <div className="truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
                {session.agentName}
              </div>
            </div>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="relative flex-1 overflow-y-auto overscroll-contain px-8 lg:px-12 py-6"
          onWheel={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          onScroll={(event) => {
            // Only a real user scroll may clear the snap / re-pin to the bottom.
            // Ignore the programmatic snap & follow scrolls and layout-driven scroll
            // events (spacer shrink, viewport-height changes) — otherwise they reach
            // the bottom threshold and yank the just-snapped message back down.
            //
            // "User scroll" is detected via wheel/touch (covers mouse, trackpad and
            // touch). Keyboard (PageUp/Down, Space) and scrollbar-thumb drag are not
            // detected here — they cannot be told apart from a layout-driven scroll
            // without making the container focusable, and on macOS overlay scrollbars
            // make thumb-drag rare; treated as a known edge.
            if (!userScrollIntentRef.current) return;
            const el = event.currentTarget;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            const atBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
            isPinnedAtBottomRef.current = atBottom;
            // ANY genuine user scroll hands control back to the user, so stop pinning
            // the message to the top. The streaming bottom-follow then only resumes if
            // the user is actually at the bottom (gated on isPinnedAtBottomRef). This
            // is what makes "scroll up mid-generation is respected" hold: scrolling up
            // releases the snap instead of getting re-pinned a frame later.
            snapInProgressRef.current = false;
          }}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            dragCounterRef.current += 1;
            setIsDragActive(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
            if (dragCounterRef.current === 0) {
              setIsDragActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragCounterRef.current = 0;
            setIsDragActive(false);
            if (event.dataTransfer.files.length > 0) {
              showToast({
                title: "Coming soon",
                description: "File attachments will be available soon.",
                tone: "default",
              });
            }
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
                <p className="text-[11.5px] text-ink-subtle">PNG, JPG, PDF · or paste with ⌘V</p>
              </div>
            </div>
          ) : null}
          <div className="mx-auto max-w-[960px] space-y-5">
            {runtime.lastError ? (
              <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12.5px] leading-5 text-danger">
                <AlertCircle size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                <span>{runtime.lastError}</span>
              </div>
            ) : null}

            {visibleMessages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface/40 px-6 py-12 text-center">
                <Bot size={18} strokeWidth={1.7} className="mx-auto text-ink-subtle" />
                <p className="mt-3 text-[13.5px] font-medium text-ink">Session is ready</p>
                <p className="mt-1 text-[12.5px] text-ink-muted">
                  Start with one of these, or write your own.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {[
                    "Set up the dev environment",
                    "Run the test suite",
                    "Open a PR for current changes",
                    "Explain the codebase",
                  ].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => {
                        setInput(chip);
                        textareaRef.current?.focus();
                      }}
                      className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] text-ink/90 transition-colors hover:bg-surface-muted"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {visibleMessages.map((message) => {
              const assistantParts = assistantPartsByMessageId.get(message.id) ?? [];
              const copyText =
                message.role === "assistant"
                  ? extractAssistantText(assistantParts) || message.content
                  : message.content;
              const canCopy = copyText.trim().length > 0;
              const duration = message.role === "assistant" ? runDurationForMessage(message) : 0;

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
                        reasoningActive={isReasoningInProgress(message, runtime.events)}
                        activeStartedAt={activeStartForAssistantMessage(message, visibleMessages)}
                      />
                    ) : (
                      message.content
                    )}
                    {canCopy && message.status !== "running" ? (
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
            })}

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
                        <ToolCallCard toolCall={part.toolCall} />
                      </div>
                    </div>
                  ) : null,
                )}
              </div>
            ) : null}

            {/* Whitespace reserved below the snapped user message so the streaming
                response renders into a clean, visible area without the user needing
                to scroll. The height is measured (see spacer effect) and stays put
                across the generation-end boundary — it is NOT gated on the generation
                flags, so it never collapses in one frame and jolts a user who has
                scrolled down. It is reset on the next send. */}
            {snappedMessageId && spacerHeight > 0 ? (
              <div
                aria-hidden="true"
                className="shrink-0 transition-[height] duration-300 ease-out"
                style={{ height: `${spacerHeight}px` }}
              />
            ) : null}
          </div>
        </div>

        <div className="bg-canvas px-8 lg:px-12 py-4">
          <div className="group/composer mx-auto max-w-[960px]">
            {showStaleBanner ? (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[12.5px] text-warning"
              >
                <span>Connection idle — reconnecting and refreshing progress…</span>
                <button
                  type="button"
                  onClick={() => {
                    void queryClient.invalidateQueries({ queryKey: streamCredentialKey });
                    void queryClient.invalidateQueries({ queryKey: detailKey });
                  }}
                  className="shrink-0 rounded border border-warning-border bg-surface px-2.5 py-1 text-[11.5px] font-medium text-warning hover:bg-warning-bg"
                >
                  Retry
                </button>
              </div>
            ) : null}
            {formError ? <p className="mb-2 text-[12px] text-danger">{formError}</p> : null}
            <div className="relative flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-shadow focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.05)]">
              {slashMenuOpen ? (
                <SlashCommandMenu
                  id={slashMenuId}
                  commands={slashCommands}
                  activeId={slashActiveId}
                  onSelect={(command) => insertSlashCommand(command)}
                  onHover={(id) => {
                    const idx = slashCommands.findIndex((command) => command.id === id);
                    if (idx >= 0) setSlashActiveIndex(idx);
                  }}
                />
              ) : null}
              <div ref={attachMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAttachMenuOpen((prev) => !prev)}
                  aria-label="Attach file"
                  aria-expanded={attachMenuOpen}
                  aria-haspopup="menu"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
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
                      onClick={() => {
                        showToast({
                          title: "Coming soon",
                          description: "File attachments will be available soon.",
                          tone: "default",
                        });
                        setAttachMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-ink/90 transition-colors hover:bg-surface-muted"
                    >
                      <Upload size={13} strokeWidth={1.75} />
                      Upload file
                    </button>
                  </div>
                ) : null}
              </div>
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
                    // Enter and Tab both insert the highlighted command into the input
                    // (they do not run it) — the user runs it by then pressing Enter to send.
                    if (event.key === "Enter" || event.key === "Tab") {
                      if (event.key === "Enter" && event.shiftKey) {
                        // shift+Enter falls through to a normal newline.
                      } else {
                        event.preventDefault();
                        const command = slashCommands[slashActiveIndex];
                        if (command) insertSlashCommand(command);
                        return;
                      }
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSlashDismissed(true);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                onPaste={(event) => {
                  const items = event.clipboardData?.items;
                  if (!items) return;
                  const itemArray = Array.from(items);
                  const hasImage = itemArray.some(
                    (item) => item.kind === "file" && item.type.startsWith("image/"),
                  );
                  if (!hasImage) return;
                  const hasText = itemArray.some((item) => item.kind === "string");
                  // Pure-image paste: stop the browser default so nothing visible
                  // changes in the textarea and the toast is the only signal.
                  // Mixed text+image: let the browser paste the text portion
                  // alongside the toast so the user keeps what they expected.
                  if (!hasText) event.preventDefault();
                  showToast({
                    title: "Image upload coming soon",
                    description: hasText
                      ? "The text was pasted; the image was ignored."
                      : "Image attachments aren't supported yet.",
                    tone: "default",
                  });
                }}
                placeholder="Ask this agent to do something"
                role="combobox"
                aria-expanded={slashMenuOpen}
                aria-controls={slashMenuOpen ? slashMenuId : undefined}
                aria-activedescendant={slashActiveOptionId}
                aria-haspopup="listbox"
                rows={1}
                className="min-h-9 flex-1 resize-none content-center bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              />
              {canAbort && (hasRunningAssistantMessage || showWaitingForAssistant) ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={requestAbort}
                  aria-label="Stop generating"
                  title="Stop generating"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-danger-border bg-danger-bg text-danger transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <CircleStop size={16} strokeWidth={1.9} />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isPending || (!parseSlashCommand(input) && (isBusy || !input.trim()))}
                  onClick={handleSend}
                  aria-label="Send message"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:bg-ink/85 disabled:opacity-40"
                >
                  <ArrowUp size={13} strokeWidth={2} />
                </button>
              )}
            </div>
            <div
              className={`mt-1.5 flex items-center justify-end gap-3 px-1 text-[11px] text-ink-subtle transition-opacity duration-150 ${
                slashMenuOpen ? "opacity-100" : "opacity-0 group-focus-within/composer:opacity-100"
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
          </div>
        </div>
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
        </div>
        <SessionInspector
          session={session}
          related={detail.related}
          currentStatus={runtime.currentStatus}
          lastError={runtime.lastError}
          streamStatus={stream.status}
          streamErrorMessage={stream.errorMessage}
          runnerConfigured={Boolean(runnerUrl && streamToken)}
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

      <button
        type="button"
        aria-label={inspectorCollapsed ? "Expand runtime details" : "Collapse runtime details"}
        aria-expanded={!inspectorCollapsed}
        onClick={() => updateInspectorCollapsed(!inspectorCollapsed)}
        className="fixed right-2 top-3 z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </button>
    </main>
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

export function AssistantMessageContent({
  message,
  parts,
  sessionCanGenerate,
  reasoningActive = false,
  activeStartedAt,
}: {
  message: SessionMessage;
  parts: AssistantTurnPart[];
  sessionCanGenerate: boolean;
  reasoningActive?: boolean;
  activeStartedAt?: string | undefined;
}) {
  const hasParts = parts.length > 0;
  const isRunning = message.status === "running" && sessionCanGenerate;
  const isStopped =
    message.status === "failed" || (message.status === "running" && !sessionCanGenerate);
  const isCompleted = message.status === "completed";
  const runDurationSeconds = runDurationForMessage(message);

  // A still-running tool call on a stopped session reads as failed — it never returned.
  const normalizedParts: AssistantTurnPart[] = parts.map((part) =>
    part.type === "tool-call" && part.toolCall.status === "running" && !sessionCanGenerate
      ? {
          type: "tool-call",
          toolCall: {
            ...part.toolCall,
            status: "failed" as const,
            outputPreview: part.toolCall.outputPreview || "Stopped before finishing.",
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
  const collapseWork =
    isCompleted &&
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
              <ToolCallCard key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        );
      })}
      {!hasParts ? (
        isRunning ? (
          <WorkingIndicator
            startedAt={activeStartedAt ?? message.createdAt}
            thinking={reasoningActive}
          />
        ) : isStopped ? (
          <AssistantStoppedNotice />
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
      {hasParts && isStopped ? <AssistantStoppedNotice /> : null}
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

function AssistantStoppedNotice({ elapsedSeconds }: { elapsedSeconds?: number | null }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-[12.5px] font-medium leading-6 text-danger">
      <AlertCircle size={13} strokeWidth={1.8} className="shrink-0" />
      <span>Stopped before finishing</span>
      {typeof elapsedSeconds === "number" ? (
        <span className="text-[12px] font-normal tabular-nums text-danger/70">
          {formatElapsed(elapsedSeconds)}
        </span>
      ) : null}
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

function ToolCallCard({ toolCall }: { toolCall: RuntimeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isCompleted = toolCall.status === "completed";
  const activityLine = latestActivityLine(toolCall.activityPreview);
  const isFailed = toolCall.status === "failed";

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
        {isFailed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-danger">
            <AlertCircle size={9} strokeWidth={1.9} />
            failed
          </span>
        ) : null}
        {!isCompleted && !isFailed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-subtle">
            <LoaderCircle size={9} strokeWidth={2} className="animate-spin text-warning" />
            running
          </span>
        ) : null}
      </button>
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
        ) : streamErrorMessage || streamStatus === "stale" ? (
          <div className="mt-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[11.5px] leading-4 text-warning">
            {streamStatus === "stale"
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
  if (status === "completed") return "Done";
  if (status === "aborting") return "Aborting";
  if (status === "archiving") return "Archiving";
  if (status === "archived") return "Archived";
  if (status === "failed") return "Failed";
  if (status === "created") return "Created";
  return status;
}

function streamStatusLabel(status: string) {
  if (status === "open") return "live";
  if (status === "connecting") return "connecting";
  if (status === "stale") return "stale";
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
