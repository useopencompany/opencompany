"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Brain,
  ChevronRight,
  CircleStop,
  ExternalLink,
  LoaderCircle,
  PanelRight,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState, useTransition } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessionEventStream } from "@/components/useSessionEventStream";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { SessionPageSkeleton } from "@/components/WorkspaceRouteSkeletons";
import { abortAgentSession, submitAgentSessionMessage } from "@/lib/agent-sessions/actions";
import {
  type AgentSessionDetailPayload,
  addUserMessageToSessionDetail,
  applyRuntimeEventToSessionDetail,
  fetchAgentSession,
  mergeAgentSessionDetail,
  SESSIONS_QUERY_STALE_TIME_MS,
  seedSessionQueries,
  sessionQueryKeys,
  updateSessionStatusInDetail,
} from "@/lib/agent-sessions/payload";
import {
  type AssistantTurnPart,
  buildAssistantTurnParts,
  isInspectableRuntimeEvent,
  type RuntimeEvent,
  type RuntimeToolCall,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";

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
  } = useQuery({
    queryKey: detailKey,
    queryFn: async () =>
      mergeAgentSessionDetail(
        queryClient.getQueryData<AgentSessionDetailPayload>(detailKey),
        await fetchAgentSession(sessionId),
      ),
    staleTime: SESSIONS_QUERY_STALE_TIME_MS,
  });

  if (!detail && isPending) return <SessionPageSkeleton />;

  if (!detail || error) {
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
  const session = detail.session;
  const runnerUrl = detail.runnerUrl;
  const streamToken = detail.streamToken;
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const runtime = useMemo(
    () => ({
      events: detail.events,
      messages: detail.messages,
      usage: detail.usage,
      toolUsage: detail.toolUsage,
      cost: detail.cost,
      currentStatus: session.status,
      lastError: session.lastError,
    }),
    [detail, session.lastError, session.status],
  );
  const lastEventId = useMemo(() => runtime.events.at(-1)?.id ?? 0, [runtime.events]);
  const knownEventIds = useMemo(() => runtime.events.map((event) => event.id), [runtime.events]);
  const inspectorEvents = useMemo(
    () => runtime.events.filter(isInspectableRuntimeEvent),
    [runtime.events],
  );
  const visibleMessages = useMemo(
    () =>
      runtime.messages.filter((message) => message.role === "user" || message.role === "assistant"),
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

  function updateInspectorCollapsed(nextCollapsed: boolean) {
    setInspectorCollapsed(nextCollapsed);
  }

  const requestAbort = () => {
    startTransition(async () => {
      const result = await abortAgentSession(session.id);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      queryClient.setQueryData<AgentSessionDetailPayload>(detailKey, (current) =>
        current ? updateSessionStatusInDetail(current, "aborting") : current,
      );
      void queryClient.invalidateQueries({ queryKey: detailKey });
    });
  };

  const applyRuntimeEvent = useCallback(
    (event: RuntimeEvent) => {
      const current = queryClient.getQueryData<AgentSessionDetailPayload>(detailKey);
      if (!current) return;
      const next = applyRuntimeEventToSessionDetail(current, event);
      seedSessionQueries(queryClient, workspaceId, next);
    },
    [detailKey, queryClient, workspaceId],
  );

  const stream = useSessionEventStream({
    runnerUrl,
    streamToken,
    sessionId: session.id,
    afterId: lastEventId,
    knownEventIds,
    onEvent: applyRuntimeEvent,
  });

  const submit = () => {
    const content = input.trim();
    if (!content) return;
    setInput("");
    setFormError(null);
    startTransition(async () => {
      const result = await submitAgentSessionMessage(session.id, content);
      if (result.ok) {
        queryClient.setQueryData<AgentSessionDetailPayload>(detailKey, (current) =>
          current
            ? addUserMessageToSessionDetail(current, { messageId: result.messageId, content })
            : current,
        );
        void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      setFormError(result.error);
    });
  };

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-[#eaeae6] bg-canvas/90 px-6 py-3">
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-3">
            <Bot size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
            <div className="min-w-0 pr-10">
              <div className="truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
                {session.agentName}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-[760px] space-y-5">
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
                  Send the first instruction to start working with this agent.
                </p>
              </div>
            ) : null}

            {visibleMessages.map((message) => {
              const assistantParts = assistantPartsByMessageId.get(message.id) ?? [];

              return (
                <div
                  key={message.id}
                  className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={
                      message.role === "user"
                        ? "max-w-[78%] rounded-2xl rounded-tr-md bg-[#eef0ec] px-3.5 py-2.5 text-[13px] leading-6 text-ink"
                        : "max-w-[86%] break-words text-[13px] leading-6 text-ink/90"
                    }
                  >
                    {message.role === "assistant" ? (
                      <AssistantMessageContent message={message} parts={assistantParts} />
                    ) : (
                      message.content
                    )}
                  </div>
                </div>
              );
            })}

            {showWaitingForAssistant ? (
              <div className="flex justify-start">
                <ThinkingShimmer />
              </div>
            ) : null}
          </div>
        </div>

        <div className="bg-canvas px-8 py-4">
          <div className="mx-auto max-w-[760px]">
            {formError ? <p className="mb-2 text-[12px] text-[#b42318]">{formError}</p> : null}
            <div className="flex items-end gap-2 rounded-xl border border-[#e4e4e0] bg-white px-3 py-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask this agent to do something"
                rows={2}
                className="min-h-10 flex-1 resize-none bg-transparent text-[13px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
              />
              <button
                disabled={isPending || !input.trim()}
                onClick={submit}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#111] text-white disabled:opacity-40"
              >
                <ArrowUp size={14} strokeWidth={2.2} />
              </button>
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
        {!isCompleted ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-subtle">
            <LoaderCircle size={9} strokeWidth={2} className="animate-spin text-[#9b8a64]" />
            running
          </span>
        ) : null}
      </button>
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
          {!toolCall.activityPreview && !toolCall.outputPreview && !isCompleted ? (
            <div className="py-1 text-[11px] text-ink-subtle">Waiting for result</div>
          ) : null}
        </div>
      ) : null}
    </div>
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

function SessionStatusDot({ status }: { status: string }) {
  const tone =
    status === "failed"
      ? "bg-[#dc2626] shadow-[0_0_0_2px_rgba(220,38,38,0.1)]"
      : status === "running" || status === "provisioning"
        ? "bg-[#16a34a] shadow-[0_0_0_2px_rgba(22,163,74,0.12)]"
        : status === "aborting" || status === "archiving"
          ? "bg-[#d97706] shadow-[0_0_0_2px_rgba(217,119,6,0.11)]"
          : "bg-ink-subtle/45";

  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
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
  if (event.type === "message.reasoning_summary") return "Thinking summary";
  if (event.type === "tool.started") return `${readString(event.payload.name)} started`;
  if (event.type === "tool.completed") return `${readString(event.payload.name)} completed`;
  if (event.type === "session.tool_usage") {
    return `${readString(event.payload.provider)} ${formatUsdMicros(
      Number(event.payload.costUsdMicros ?? 0),
    )}`;
  }
  if (event.type === "file.changed") return readString(event.payload.path);
  if (event.type === "command.output") return readString(event.payload.delta).trim();
  return "";
}
