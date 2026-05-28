"use client";

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
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { useToast } from "@/components/ToastProvider";
import { useSessionEventStream } from "@/components/useSessionEventStream";
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
  type RuntimeEvent,
  type RuntimeToolCall,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";

const TEXTAREA_MAX_HEIGHT_PX = 220;

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
      className="font-medium text-ink underline decoration-[#c7c7c2] underline-offset-2 transition-colors hover:decoration-ink/70"
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
          <div className="max-w-sm rounded-lg border border-[#f0d2d2] bg-[#fff6f6] px-5 py-6 text-center">
            <p className="text-[13.5px] font-medium text-[#9f1d1d]">Could not load session</p>
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
              className="mt-4 inline-flex h-7 items-center justify-center rounded-md border border-[#e4e4e0] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#fafaf8] disabled:cursor-not-allowed disabled:opacity-50"
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
          <div className="max-w-sm rounded-lg border border-dashed border-[#deded9] bg-white/45 px-5 py-6 text-center">
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

function SessionViewContent({ detail, workspaceId }: SessionViewContentProps) {
  const queryClient = useQueryClient();
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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [attachMenuOpen, setAttachMenuOpen] = useState<boolean>(false);
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  // Some browsers fire the Enter keydown that committed an IME composition
  // *after* compositionend, with `isComposing` already false. Track when the
  // composition ended so we can swallow that follow-up Enter.
  const compositionEndAtRef = useRef(0);
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
  const lastEventId = useMemo(() => runtime.events.at(-1)?.id ?? 0, [runtime.events]);
  const knownEventIds = useMemo(() => runtime.events.map((event) => event.id), [runtime.events]);
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
  const hasRunningAssistantMessage = visibleMessages.some(
    (message) => message.role === "assistant" && message.status === "running",
  );
  const showWaitingForAssistant =
    !runtime.lastError &&
    !hasRunningAssistantMessage &&
    lastVisibleMessage?.role === "user" &&
    ["created", "provisioning", "ready", "running"].includes(runtime.currentStatus);
  const canAbort = ["created", "provisioning", "ready", "running"].includes(runtime.currentStatus);
  const isBusy = isPending || hasRunningAssistantMessage || showWaitingForAssistant;

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
      const current = queryClient.getQueryData<AgentSessionDetailPayload>(detailKey);
      if (!current) return;
      const next = applyRuntimeEventToSessionDetail(current, event);
      seedSessionQueries(queryClient, workspaceId, next);
      invalidateRelatedCachesForSessionEvent(queryClient, workspaceId, session.agentId, event);
    },
    [detailKey, queryClient, workspaceId, session.agentId],
  );

  const stream = useSessionEventStream({
    runnerUrl,
    streamToken,
    sessionId: session.id,
    afterId: lastEventId,
    knownEventIds,
    onEvent: applyRuntimeEvent,
  });

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

  // Stale stream means the SSE connection is wedged, most often from a transient drop or an
  // expired runner token. Refresh just the stream credential so reconnects do not reload the
  // full session detail payload.
  const lastStaleRefetchAtRef = useRef(0);
  useEffect(() => {
    if (stream.status !== "stale") return;
    const now = Date.now();
    if (now - lastStaleRefetchAtRef.current < SESSIONS_QUERY_STALE_TIME_MS) return;
    lastStaleRefetchAtRef.current = now;
    void queryClient.invalidateQueries({ queryKey: streamCredentialKey });
  }, [stream.status, queryClient, streamCredentialKey]);

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

  const submit = () => {
    if (isBusy) return;
    const content = input.trim();
    if (!content) return;
    setFormError(null);
    startTransition(async () => {
      const result = await submitAgentSessionMessage(session.id, content);
      if (result.ok) {
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
        return;
      }
      setFormError(result.error);
    });
  };

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
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
            <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-[#9a9a96] bg-canvas/85 px-8 py-6 backdrop-blur-sm">
              <Upload size={22} strokeWidth={1.6} className="text-ink-muted" />
              <p className="text-[13px] font-medium text-ink">Drop files to attach</p>
              <p className="text-[11.5px] text-ink-subtle">PNG, JPG, PDF · or paste with ⌘V</p>
            </div>
          </div>
        ) : null}

        <div className="border-b border-[#eaeae6] bg-canvas/90 px-6 py-3">
          <div className="mx-auto flex w-full max-w-[960px] items-center gap-3">
            <Bot size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
            <div className="min-w-0 pr-10">
              <div className="truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
                {session.agentName}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 lg:px-12 py-6">
          <div className="mx-auto max-w-[960px] space-y-5">
            {runtime.lastError ? (
              <div className="flex items-start gap-2 rounded-md border border-[#f0d2d2] bg-[#fff6f6] px-3 py-2 text-[12.5px] leading-5 text-[#9f1d1d]">
                <AlertCircle size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                <span>{runtime.lastError}</span>
              </div>
            ) : null}

            {visibleMessages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#deded9] bg-white/40 px-6 py-12 text-center">
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
                      className="rounded-full border border-[#e6e6e3] bg-white px-3 py-1.5 text-[12px] text-ink/90 transition-colors hover:bg-[#fafaf7]"
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

              return (
                <div
                  key={message.id}
                  className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={`group/message relative after:absolute after:inset-x-0 after:top-full after:h-5 after:content-[''] ${
                      message.role === "user"
                        ? "max-w-[62%] break-words rounded-2xl rounded-tr-md bg-[#eef0ec] px-3.5 py-2.5 text-[14px] leading-6 text-ink"
                        : "max-w-[68%] break-words text-[14px] leading-6 text-ink/90"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <AssistantMessageContent message={message} parts={assistantParts} />
                    ) : (
                      message.content
                    )}
                    {canCopy && message.status !== "running" ? (
                      <CopyMessageButton
                        text={copyText}
                        align={message.role === "user" ? "right" : "left"}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}

            {showWaitingForAssistant ? (
              <div className="flex justify-start">
                <ThinkingShimmer />
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
          </div>
        </div>

        <div className="bg-canvas px-8 lg:px-12 py-4">
          <div className="group/composer mx-auto max-w-[960px]">
            {formError ? <p className="mb-2 text-[12px] text-[#b42318]">{formError}</p> : null}
            <div className="flex items-center gap-2 rounded-xl border border-[#e4e4e0] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-shadow focus-within:border-[#d4d4cf] focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.05)]">
              <div ref={attachMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAttachMenuOpen((prev) => !prev)}
                  aria-label="Attach file"
                  aria-expanded={attachMenuOpen}
                  aria-haspopup="menu"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b6b6b] hover:bg-[#f3f3f0] hover:text-[#111]"
                >
                  <Plus size={15} strokeWidth={1.75} />
                </button>
                {attachMenuOpen ? (
                  <div
                    role="menu"
                    className="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[200px] overflow-hidden rounded-lg border border-[#e4e4e0] bg-white shadow-[0_8px_24px_-8px_rgba(15,15,15,0.12),0_2px_4px_rgba(15,15,15,0.05)]"
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
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-ink/90 transition-colors hover:bg-[#fafaf7]"
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
                onChange={(event) => setInput(event.target.value)}
                onCompositionEnd={() => {
                  compositionEndAtRef.current = performance.now();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  // Enter inside an active IME composition: never submit.
                  if (event.nativeEvent.isComposing) return;
                  // Enter immediately after compositionend (the keystroke that
                  // committed the candidate): swallow once.
                  if (performance.now() - compositionEndAtRef.current < 50) return;
                  event.preventDefault();
                  if (isBusy) return;
                  submit();
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
                rows={1}
                className="min-h-9 flex-1 resize-none content-center bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              />
              {(canAbort && (hasRunningAssistantMessage || showWaitingForAssistant)) ||
              runtime.currentStatus === "aborting" ? (
                <button
                  type="button"
                  disabled={isPending || runtime.currentStatus === "aborting"}
                  onClick={requestAbort}
                  aria-label={
                    runtime.currentStatus === "aborting" ? "Aborting…" : "Stop generating"
                  }
                  title={runtime.currentStatus === "aborting" ? "Aborting…" : "Stop generating"}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-[#f0c0b8] bg-[#fff5f3] text-[#9f2f21] transition-colors hover:bg-[#ffebe7] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {runtime.currentStatus === "aborting" ? (
                    <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
                  ) : (
                    <CircleStop size={16} strokeWidth={1.9} />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isBusy || !input.trim()}
                  onClick={submit}
                  aria-label="Send message"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-[#111] text-white transition-opacity hover:bg-black disabled:opacity-40"
                >
                  <ArrowUp size={13} strokeWidth={2} />
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-end gap-3 px-1 text-[11px] text-ink-subtle opacity-0 transition-opacity duration-150 group-focus-within/composer:opacity-100">
              <span>
                <kbd className="rounded border border-[#e6e6e3] bg-[#fafaf7] px-1 font-mono text-[10px] text-ink-muted">
                  ↵
                </kbd>{" "}
                send
              </span>
              <span>
                <kbd className="rounded border border-[#e6e6e3] bg-[#fafaf7] px-1 font-mono text-[10px] text-ink-muted">
                  ⇧↵
                </kbd>{" "}
                new line
              </span>
            </div>
          </div>
        </div>
      </div>

      {!inspectorCollapsed && (
        <button
          type="button"
          aria-label="Collapse runtime details"
          className="fixed inset-0 z-30 bg-black/[0.06] lg:hidden"
          onClick={() => updateInspectorCollapsed(true)}
        />
      )}

      <aside
        className={`shrink-0 overflow-y-auto border-l border-[#e4e4e0] bg-[#fbfbf9]/95 px-5 py-4 shadow-[-16px_0_36px_rgba(0,0,0,0.08)] backdrop-blur-md transition-transform duration-200 ease-out lg:bg-[#fbfbf9]/80 lg:py-8 lg:shadow-none lg:backdrop-blur-0 ${
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
        className="fixed right-2 top-3 z-50 rounded-md border border-[#e6e6e3] bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </button>
    </main>
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="session-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Copy only the user-visible answer text — reasoning is hidden by default in
// the UI and ChatGPT/Claude both exclude it from clipboard copies. Tool calls
// are also intentionally excluded so what you paste matches what you read.
function extractAssistantText(parts: AssistantTurnPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
}

function CopyMessageButton({ text, align }: { text: string; align: "left" | "right" }) {
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

  const positionClasses = align === "right" ? "top-full right-0 mt-1" : "top-full left-0 mt-1";

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className={`absolute ${positionClasses} z-10 inline-flex h-5 w-5 items-center justify-center rounded text-ink-subtle opacity-0 pointer-events-none transition-opacity hover:bg-[#f0f0ec] hover:text-ink focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto`}
    >
      {copied ? (
        <Check size={10} strokeWidth={2} className="text-[#16a34a]" />
      ) : (
        <Copy size={10} strokeWidth={1.75} />
      )}
    </button>
  );
}

function AssistantMessageContent({
  message,
  parts,
}: {
  message: SessionMessage;
  parts: AssistantTurnPart[];
}) {
  const hasParts = parts.length > 0;

  return (
    <div className="space-y-3">
      {parts.map((part, index) =>
        part.type === "text" ? (
          <AssistantMarkdown key={`${index}:${part.text.length}`} content={part.text} />
        ) : part.type === "reasoning" ? (
          <ReasoningSummaryCard
            key={`${index}:reasoning`}
            text={part.text}
            durationSeconds={part.durationSeconds}
          />
        ) : (
          <ToolCallCard key={part.toolCall.id} toolCall={part.toolCall} />
        ),
      )}
      {!hasParts ? message.status === "running" ? <ThinkingShimmer /> : "..." : null}
    </div>
  );
}

function ReasoningSummaryCard({
  text,
  durationSeconds,
}: {
  text: string | undefined;
  durationSeconds: number;
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
        <div className="mt-1 border-l border-[#e3e3df] pl-3">
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
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-[#efefeb]/65 hover:text-ink/75"
      >
        <ChevronRight
          size={11}
          strokeWidth={1.9}
          className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-subtle">
          <Wrench size={11} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate font-medium text-ink/65">
          {formatToolName(toolCall.name)}
        </span>
        {toolCall.brainPath ? (
          <span
            title={`Updated brain/${toolCall.brainPath}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#d7e4cf] bg-[#f3f8ef] px-1.5 py-px text-[10.5px] font-medium text-[#4d6f35]"
          >
            <Brain size={9} strokeWidth={1.9} />
            Brain updated
          </span>
        ) : null}
        {isFailed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[#a33a2d]">
            <AlertCircle size={9} strokeWidth={1.9} />
            failed
          </span>
        ) : null}
        {!isCompleted && !isFailed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-subtle">
            <LoaderCircle size={9} strokeWidth={2} className="animate-spin text-[#9b8a64]" />
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
        <div className="ml-6 mt-1 border-l border-[#e3e3df] pl-3">
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

function ThinkingShimmer() {
  return (
    <div
      className="thinking-shimmer inline-flex items-center text-[13px] font-medium leading-6"
      role="status"
      aria-live="polite"
    >
      Thinking...
    </div>
  );
}

function SessionInspector({
  session,
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
          <div className="mt-4 rounded-md border border-[#f0d2d2] bg-[#fff6f6] px-3 py-2 text-[11.5px] leading-4 text-[#9f1d1d]">
            {lastError}
          </div>
        ) : streamErrorMessage || streamStatus === "stale" ? (
          <div className="mt-4 rounded-md border border-[#ead9b8] bg-[#fffaf0] px-3 py-2 text-[11.5px] leading-4 text-[#8a5a00]">
            {streamStatus === "stale"
              ? "The live session stream is not responding. Reloading will show persisted events."
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
          <div className="space-y-4 border-t border-[#e5e5e1] pt-4">
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
          className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[#f0c0b8] bg-[#fff5f3] px-3 text-[12px] font-medium text-[#9f2f21] transition-colors hover:bg-[#ffebe7] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <CircleStop size={13} strokeWidth={1.9} />
          Abort session
        </button>
      </div>

      <div>
        <InspectorHeader label="Recent events" countLabel={`${recentEvents.length} shown`} />
        {recentEvents.length > 0 ? (
          <div className="space-y-1.5">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="rounded-md border border-[#e5e5e1] bg-white/55 px-2.5 py-2 text-[11.5px] text-ink-muted"
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
          <div className="rounded-lg border border-dashed border-[#deded9] bg-white/45 px-3 py-3 text-[12px] text-ink-muted">
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
      <span className="rounded-full border border-[#e3e3df] bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
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

function InspectorLink({ label, href, value }: { label: string; href: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">{label}</div>
      <Link
        href={href}
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

function formatThinkingDuration(seconds: number) {
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
  if (event.type === "message.reasoning_summary") return "Thinking summary";
  if (event.type === "tool.started") return `${readString(event.payload.name)} started`;
  if (event.type === "tool.completed") return `${readString(event.payload.name)} completed`;
  if (event.type === "session.tool_usage") {
    return `${readString(event.payload.provider)} ${formatUsdMicros(
      Number(event.payload.costUsdMicros ?? 0),
    )}`;
  }
  if (event.type === "file.changed") return readString(event.payload.path);
  if (event.type === "brain.file_changed") return `brain/${readString(event.payload.path)}`;
  if (event.type === "brain.conflict") return `Brain conflict: ${readString(event.payload.path)}`;
  if (event.type === "command.output") return readString(event.payload.delta).trim();
  return "";
}
