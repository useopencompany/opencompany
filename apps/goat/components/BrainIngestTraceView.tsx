"use client";

import type {
  GoatBrainIngestTrace,
  GoatBrainIngestTraceToolCall,
} from "@opencompany/db/goat-brain-ingest-trace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import {
  AlertCircle,
  ChevronRight,
  CircleSlash,
  Code2,
  FileText,
  TerminalSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { finiteDurationMs, formatGoatChatDuration } from "@/lib/chat-timing";

export function BrainIngestTraceDialog({
  trace,
  traceId,
  sourceTitle,
  durationMs,
  open,
  onOpenChange,
}: {
  trace: GoatBrainIngestTrace | null;
  traceId: string;
  sourceTitle: string;
  durationMs: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!trace) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,calc(100vh-48px))] max-w-[760px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <DialogTitle className="text-[15px]">Agent run trace</DialogTitle>
          <DialogDescription className="text-[12px]">
            <TraceSummaryLine trace={trace} durationMs={durationMs} />
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="brain-ingest-trace-scroll"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          <BrainIngestTraceView trace={trace} traceId={traceId} sourceTitle={sourceTitle} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TraceSummaryLine({
  trace,
  durationMs,
}: {
  trace: GoatBrainIngestTrace;
  durationMs: number | null;
}) {
  const safeDurationMs = finiteDurationMs(durationMs);
  const parts = [
    trace.model,
    safeDurationMs !== null ? `Run ${formatGoatChatDuration(safeDurationMs)}` : null,
    `${trace.steps} ${trace.steps === 1 ? "step" : "steps"}`,
    `${trace.toolCallCount} ${trace.toolCallCount === 1 ? "tool call" : "tool calls"}`,
  ].filter((part): part is string => Boolean(part));

  return <>{parts.join(" - ")}</>;
}

export function BrainIngestTraceView({
  trace,
  traceId,
  sourceTitle,
}: {
  trace: GoatBrainIngestTrace;
  traceId: string;
  sourceTitle: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      <SourceContextBubble sourceTitle={sourceTitle} />
      <TraceIdBlock traceId={traceId} />

      {trace.toolCalls.length > 0 ? (
        <div className="space-y-1.5">
          {trace.toolCalls.map((toolCall) => (
            <TraceToolCallRow key={toolCall.id} toolCall={toolCall} />
          ))}
          {trace.truncatedToolCalls > 0 ? (
            <div className="ml-6 text-[11.5px] leading-5 text-ink-subtle">
              {trace.truncatedToolCalls} additional{" "}
              {trace.truncatedToolCalls === 1 ? "tool call was" : "tool calls were"} omitted from
              this compact trace.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-[13px] leading-6 text-ink-muted">No tool calls were recorded.</div>
      )}

      {trace.finalText.trim() ? (
        <div className="max-w-full break-words text-[14px] leading-6 text-ink/90 md:max-w-[72%]">
          <Markdown content={trace.finalText} mode="static" />
        </div>
      ) : null}

      <RawJsonDisclosure trace={trace} />
    </div>
  );
}

function TraceIdBlock({ traceId }: { traceId: string }) {
  if (!traceId) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] leading-4 text-ink-subtle">
      <span className="font-medium uppercase tracking-[0.06em]">Trace ID</span>
      <code className="max-w-full break-all rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
        {traceId}
      </code>
    </div>
  );
}

function SourceContextBubble({ sourceTitle }: { sourceTitle: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-full rounded-2xl rounded-tl-md bg-surface-selected px-3.5 py-2.5 text-[14px] leading-6 text-ink md:max-w-[72%]">
        <div className="flex min-w-0 items-center gap-2">
          <FileText size={14} strokeWidth={1.8} className="shrink-0 text-ink-subtle" />
          <span className="min-w-0 truncate" title={sourceTitle}>
            {sourceTitle || "Untitled source"}
          </span>
        </div>
      </div>
    </div>
  );
}

function TraceToolCallRow({ toolCall }: { toolCall: GoatBrainIngestTraceToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const detail = toolCallDetail(toolCall);
  return (
    <div
      data-testid={`brain-ingest-trace-tool-${toolCall.id}`}
      className="-ml-1 text-[11.5px] leading-5 text-ink-muted"
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
            <TerminalSquare size={11} strokeWidth={1.75} />
          </span>
          <span className="shrink-0 font-medium text-ink/65">Brain</span>
          <span
            title={detail}
            className="inline-flex min-w-0 max-w-[min(500px,calc(100vw-220px))] items-center rounded bg-ink/5 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink/55"
          >
            <span className="min-w-0 truncate">{detail}</span>
          </span>
          {toolCall.mutating ? (
            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700">
              write
            </span>
          ) : null}
          <TraceStatusText status={toolCall.status} />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          <TracePreviewBlock label="Command" value={formatCommand(toolCall)} />
          {toolCall.stdinPreview ? (
            <TracePreviewBlock label="Stdin" value={toolCall.stdinPreview} />
          ) : null}
          {toolCall.stdoutPreview ? (
            <TracePreviewBlock label="Stdout" value={toolCall.stdoutPreview} />
          ) : null}
          {toolCall.stderrPreview ? (
            <TracePreviewBlock label="Stderr" value={toolCall.stderrPreview} />
          ) : null}
          {toolCall.errorPreview ? (
            <TracePreviewBlock label="Error" value={toolCall.errorPreview} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TraceStatusText({ status }: { status: GoatBrainIngestTraceToolCall["status"] }) {
  if (status === "completed") return null;
  const Icon = status === "blocked" ? CircleSlash : AlertCircle;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-danger">
      <Icon size={9} strokeWidth={1.9} />
      {status}
    </span>
  );
}

function TracePreviewBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1 first:pt-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-ink-subtle">{label}</div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
        {value}
      </pre>
    </div>
  );
}

function RawJsonDisclosure({ trace }: { trace: GoatBrainIngestTrace }) {
  const [open, setOpen] = useState(false);
  const rawJson = useMemo(() => (open ? JSON.stringify(trace, null, 2) : ""), [open, trace]);

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-[12px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.9}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Code2 size={12} strokeWidth={1.8} />
        Raw JSON
      </button>
      {open ? (
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-[10.5px] leading-4 text-ink/65">
          {rawJson}
        </pre>
      ) : null}
    </div>
  );
}

function toolCallDetail(toolCall: GoatBrainIngestTraceToolCall) {
  const command = formatCommand(toolCall);
  if (command.length <= 120) return command;
  return `${command.slice(0, 117)}...`;
}

function formatCommand(toolCall: GoatBrainIngestTraceToolCall) {
  return ["goat_brain", toolCall.command, ...toolCall.args.map(formatArg)]
    .filter(Boolean)
    .join(" ");
}

function formatArg(value: string) {
  if (!value) return '""';
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
