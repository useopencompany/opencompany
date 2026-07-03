"use client";

import {
  AlertCircle,
  Brain,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  FileText,
  LoaderCircle,
  Mail,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import type {
  GoatHarnessRunToolCall,
  GoatHarnessRunTurn,
  GoatHarnessRunViewModel,
} from "@/lib/task-harness-run";

export function TaskHarnessRunView({ run }: { run: GoatHarnessRunViewModel }) {
  const turns = run.harness?.turns ?? [];
  const hasCapturedActivity = turns.some(
    (turn) =>
      Boolean(turn.responseMessage?.contentPreview) ||
      turn.toolCalls.length > 0 ||
      Boolean(finalResultTextFromTurn(turn)),
  );

  return (
    <div className="flex w-full max-w-[720px] flex-col gap-5">
      <TranscriptMessage role="user" content={run.task.prompt} />

      {hasCapturedActivity ? (
        <div className="flex flex-col gap-5">
          {turns.map((turn) => (
            <TranscriptTurn key={turn.step} turn={turn} />
          ))}
        </div>
      ) : (
        <div className="max-w-full text-[13px] leading-6 text-ink-muted md:max-w-[68%]">
          The harness has not captured an assistant message or tool call yet. This page refreshes
          while the task is active.
        </div>
      )}
    </div>
  );
}

function TranscriptTurn({ turn }: { turn: GoatHarnessRunTurn }) {
  const assistantText = turn.responseMessage?.contentPreview;
  const finalResultText = finalResultTextFromTurn(turn);
  const visibleToolCalls = turn.toolCalls.filter((toolCall) => toolCall.name !== "goat_result");
  if (!assistantText && visibleToolCalls.length === 0 && !finalResultText) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-full space-y-3 break-words text-[14px] leading-6 text-ink/90 md:max-w-[68%]">
        {assistantText ? <TranscriptMessage role="assistant" content={assistantText} /> : null}
        {visibleToolCalls.length > 0 ? (
          <div className="space-y-1.5">
            {visibleToolCalls.map((toolCall) => (
              <ToolCallRow key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
        {finalResultText ? <TranscriptMessage role="assistant" content={finalResultText} /> : null}
      </div>
    </div>
  );
}

function TranscriptMessage({ role, content }: { role: "user" | "assistant"; content: string }) {
  if (role === "assistant") {
    return <Markdown content={content} />;
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-full break-words rounded-2xl rounded-tl-md bg-surface-selected px-3.5 py-2.5 text-[14px] leading-6 text-ink md:max-w-[68%]">
        {content}
      </div>
    </div>
  );
}

function ToolCallRow({ toolCall }: { toolCall: GoatHarnessRunToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const status = toolCall.errorPreview ? "failed" : toolCall.status;
  const display = toolCallDisplay(toolCall);
  return (
    <div
      data-testid={`tool-call-${toolCall.id}`}
      className="-ml-1 text-[11.5px] leading-5 text-ink-muted"
    >
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
            <ToolIcon toolCall={toolCall} />
          </span>
          <span className="min-w-0 truncate font-medium text-ink/65" title={toolCall.name}>
            {display.label}
          </span>
          {display.detail ? (
            <span
              title={display.detail}
              className="inline-flex min-w-0 max-w-[min(420px,calc(100vw-180px))] items-center rounded bg-ink/5 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink/55"
            >
              <span className="min-w-0 truncate">{display.detail}</span>
            </span>
          ) : null}
          <StatusText status={status} />
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3">
          {toolCall.inputPreview ? (
            <PreviewBlock label="Input" value={toolCall.inputPreview} />
          ) : null}
          {toolCall.outputPreview ? (
            <PreviewBlock label="Output" value={toolCall.outputPreview} />
          ) : null}
          {toolCall.errorPreview ? (
            <PreviewBlock label="Error" value={toolCall.errorPreview} />
          ) : null}
          {!toolCall.inputPreview && !toolCall.outputPreview && !toolCall.errorPreview ? (
            <div className="py-1 text-[11px] text-ink-subtle">Waiting for result</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolIcon({ toolCall }: { toolCall: GoatHarnessRunToolCall }) {
  if (toolCall.kind === "search") return <Search size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "gmail") return <Mail size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "calendar") return <CalendarDays size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "result") return <CheckCircle2 size={11} strokeWidth={1.75} />;
  if (toolCall.name.includes("brain")) return <Brain size={11} strokeWidth={1.75} />;
  if (toolCall.name.includes("file")) return <FileText size={11} strokeWidth={1.75} />;
  if (toolCall.name.includes("shell") || toolCall.name.includes("bash")) {
    return <TerminalSquare size={11} strokeWidth={1.75} />;
  }
  return <Wrench size={11} strokeWidth={1.75} />;
}

function StatusText({ status }: { status: GoatHarnessRunToolCall["status"] }) {
  if (status === "completed") return null;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${
        status === "failed" ? "text-danger" : "text-ink-subtle"
      }`}
    >
      {status === "failed" ? (
        <AlertCircle size={9} strokeWidth={1.9} />
      ) : (
        <LoaderCircle size={9} strokeWidth={2} className="animate-spin text-warning" />
      )}
      {status}
    </span>
  );
}

function PreviewBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1 first:pt-0">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-ink-subtle">{label}</div>
      <pre className="max-h-36 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink/60">
        {value}
      </pre>
    </div>
  );
}

function toolCallDisplay(toolCall: GoatHarnessRunToolCall) {
  if (toolCall.name === "exa_search") {
    return {
      label: "Web search",
      detail: readJsonPreviewField(toolCall.inputPreview, "query"),
    };
  }
  if (toolCall.name.startsWith("gmail_")) {
    return {
      label: toolCall.label,
      detail:
        readJsonPreviewField(toolCall.inputPreview, "query") ||
        readJsonPreviewField(toolCall.inputPreview, "messageId") ||
        readJsonPreviewField(toolCall.inputPreview, "threadId"),
    };
  }
  if (toolCall.name.startsWith("calendar_")) {
    return {
      label: toolCall.label,
      detail:
        readJsonPreviewField(toolCall.inputPreview, "calendarId") ||
        readJsonPreviewField(toolCall.inputPreview, "eventId") ||
        readJsonPreviewField(toolCall.inputPreview, "query"),
    };
  }
  if (toolCall.name === "goat_result") return { label: "Final result", detail: "" };
  return { label: toolCall.label, detail: "" };
}

function finalResultTextFromTurn(turn: GoatHarnessRunTurn) {
  const toolCall = turn.toolCalls.find((item) => item.name === "goat_result");
  if (!toolCall) return "";
  return (
    readJsonPreviewField(toolCall.outputPreview, "text") ||
    readJsonPreviewField(toolCall.inputPreview, "text") ||
    toolCall.outputPreview.trim()
  );
}

function readJsonPreviewField(preview: string, field: string) {
  if (!preview) return "";
  try {
    const parsed = JSON.parse(preview) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === "string" ? truncateInline(value, 96) : "";
  } catch {
    return "";
  }
}

function truncateInline(value: string, maxLength: number) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}...`;
}
