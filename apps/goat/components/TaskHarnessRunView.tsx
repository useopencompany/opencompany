"use client";

import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe,
  ListTodo,
  LoaderCircle,
  Mail,
  Search,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import type {
  GoatHarnessRunToolCall,
  GoatHarnessRunViewModel,
  GoatRunArtifact,
  GoatRunMessage,
} from "@/lib/task-harness-run";

export function TaskHarnessRunView({ run }: { run: GoatHarnessRunViewModel }) {
  const assistantMessages = run.assistantMessages.filter(
    (message) => message.content.trim() || message.status === "running",
  );
  const finalResult = run.task.result || lastCompletedAssistantContent(run.assistantMessages);

  if (!run.hasDurableRun) {
    return (
      <div className="flex w-full flex-col gap-3">
        <TranscriptMessage role="user" content={run.task.prompt} />
        {finalResult ? <TranscriptMessage role="assistant" content={finalResult} /> : null}
        {run.task.error ? <ErrorBubble message={run.task.error} /> : null}
        <div className="max-w-[80%] text-[13px] leading-5 text-ink-muted">
          {run.legacyDetailText}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <TranscriptMessage role="user" content={run.userMessage?.content || run.task.prompt} />

      {run.toolCalls.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {run.toolCalls.map((toolCall) => (
            <ToolCallRow key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      ) : null}

      {assistantMessages.length > 0 ? (
        assistantMessages.map((message) => <AssistantMessage key={message.id} message={message} />)
      ) : run.task.status === "queued" || run.task.status === "running" ? (
        <div className="max-w-[80%] text-[13px] leading-5 text-ink-muted">
          The runner is preparing the task transcript.
        </div>
      ) : null}

      {run.task.error ? <ErrorBubble message={run.task.error} /> : null}

      {run.resultArtifact ? <ArtifactCard artifact={run.resultArtifact} /> : null}
    </div>
  );
}

function ErrorBubble({ message }: { message: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-danger-bg px-3 py-2 text-[13px] leading-5 text-danger">
        {message}
      </div>
    </div>
  );
}

export function ArtifactCard({ artifact }: { artifact: GoatRunArtifact }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-3 text-[13px] leading-5 shadow-sm">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink/70">
          <FileText size={16} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-muted">
            {artifact.brainPath}
          </div>
        </div>
        <Link
          href={artifact.url}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-muted px-2 py-1 text-[11.5px] font-medium text-ink/80 transition-colors hover:border-border-strong hover:text-ink"
        >
          Open
          <ExternalLink size={12} strokeWidth={1.8} />
        </Link>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: GoatRunMessage }) {
  if (!message.content.trim() && message.status === "running") {
    return (
      <div className="flex items-center gap-1.5 text-[13px] leading-5 text-ink-muted">
        <LoaderCircle size={12} strokeWidth={2} className="animate-spin text-warning" />
        Assistant is working
      </div>
    );
  }

  return <TranscriptMessage role="assistant" content={message.content} />;
}

// Mirrors the main chat bubbles: assistant replies are plain left-aligned text,
// user messages are the dark right-aligned bubble.
function TranscriptMessage({ role, content }: { role: "user" | "assistant"; content: string }) {
  if (role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] break-words text-[13px] leading-5 text-ink">
          <Markdown content={content} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[80%] break-words rounded-2xl rounded-br-md bg-ink px-3 py-2 text-[13px] leading-5 text-canvas">
        {content}
      </div>
    </div>
  );
}

function ToolCallRow({ toolCall }: { toolCall: GoatHarnessRunToolCall }) {
  const [expanded, setExpanded] = useState(false);
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
          <StatusText status={toolCall.status} />
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
  if (toolCall.kind === "browser") return <Globe size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "gmail") return <Mail size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "calendar") return <CalendarDays size={11} strokeWidth={1.75} />;
  if (toolCall.kind === "linear") return <ListTodo size={11} strokeWidth={1.75} />;
  if (toolCall.status === "completed") return <CheckCircle2 size={11} strokeWidth={1.75} />;
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
  if (toolCall.name.startsWith("browser_")) {
    return {
      label: toolCall.label,
      detail:
        readJsonPreviewField(toolCall.inputPreview, "url") ||
        readJsonPreviewField(toolCall.inputPreview, "ref") ||
        readJsonPreviewField(toolCall.inputPreview, "text") ||
        readJsonPreviewField(toolCall.inputPreview, "urlPattern") ||
        readJsonPreviewField(toolCall.inputPreview, "loadState"),
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
  if (toolCall.name.startsWith("linear_")) {
    return {
      label: toolCall.label,
      detail:
        readJsonPreviewField(toolCall.inputPreview, "query") ||
        readJsonPreviewField(toolCall.inputPreview, "tool"),
    };
  }
  return { label: toolCall.label, detail: "" };
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
  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function lastCompletedAssistantContent(messages: GoatRunMessage[]) {
  const message = messages
    .filter((item) => item.role === "assistant" && item.status === "completed" && item.content)
    .at(-1);
  return message?.content.trim() ?? "";
}
