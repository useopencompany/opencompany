"use client";

import { ArrowUp, Bot, CheckCircle2, Clock3, LoaderCircle, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Composer } from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { continueGoatTask } from "@/lib/goat-tasks/actions";
import type { GoatTaskDetailPayload } from "@/lib/goat-tasks/service";

const TEXTAREA_MAX_HEIGHT_PX = 180;
const ACTIVE_STATUSES = new Set(["queued", "running"]);

type OptimisticMessage = {
  id: string;
  content: string;
  createdAt: string;
};

export function GoatTaskDetail({ detail }: { detail: GoatTaskDetailPayload }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const active = ACTIVE_STATUSES.has(detail.task.status);
  const canContinue =
    (detail.task.status === "succeeded" || detail.task.status === "failed") &&
    !isPending &&
    optimisticMessages.length === 0;
  const showComposer = canContinue || optimisticMessages.length > 0 || Boolean(formError);
  const transcript = useMemo(
    () => [
      ...detail.messages,
      ...optimisticMessages.map((message) => ({
        id: message.id,
        role: "user" as const,
        status: "completed" as const,
        content: message.content,
        toolName: null,
        toolCallId: null,
        responseToMessageId: null,
        createdAt: message.createdAt,
        completedAt: message.createdAt,
      })),
    ],
    [detail.messages, optimisticMessages],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [active, router]);

  useEffect(() => {
    setOptimisticMessages((current) =>
      current.filter(
        (optimistic) =>
          !detail.messages.some(
            (message) => message.role === "user" && message.content === optimistic.content,
          ),
      ),
    );
  }, [detail.messages]);

  const submit = () => {
    const content = input.trim();
    if (!content || !canContinue) return;
    setFormError(null);
    setInput("");
    const optimistic: OptimisticMessage = {
      id: `optimistic_${Date.now()}`,
      content,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((current) => [...current, optimistic]);

    startTransition(async () => {
      const result = await continueGoatTask(detail.task.displayId, content);
      if (result.ok) {
        router.refresh();
        return;
      }
      setOptimisticMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setInput((current) => (current.trim() ? current : content));
      setFormError(result.error);
    });
  };

  return (
    <main className="min-h-dvh bg-canvas px-5 py-6 text-ink md:px-8">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6">
        <header className="flex flex-col gap-3 border-b border-border-subtle pb-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={detail.task.status} stage={detail.task.stage} />
            <span className="text-[12px] font-medium tabular-nums text-ink-subtle">
              {detail.task.displayId}
            </span>
            <span className="text-[12px] text-ink-muted">{formatDate(detail.task.updatedAt)}</span>
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
              {detail.task.name}
            </h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              Model {detail.task.model} - {detail.task.attempts} attempt
              {detail.task.attempts === 1 ? "" : "s"}
            </p>
          </div>
        </header>

        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            Original Task
          </h2>
          <div className="rounded-lg border border-border bg-surface px-3.5 py-3 text-[13px] leading-6 text-ink/90">
            {detail.task.prompt}
          </div>
        </section>

        {detail.task.result ? (
          <section className="space-y-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              Latest Result
            </h2>
            <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
              <Markdown
                content={detail.task.result}
                className="text-[13px] leading-6 text-ink/90"
              />
            </div>
          </section>
        ) : null}

        {detail.task.error ? (
          <section className="space-y-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-danger">
              Latest Error
            </h2>
            <pre className="whitespace-pre-wrap rounded-lg border border-danger/25 bg-danger/5 px-3.5 py-3 font-mono text-[12px] leading-5 text-danger">
              {detail.task.error}
            </pre>
          </section>
        ) : null}

        {detail.artifacts.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              Artifacts
            </h2>
            <div className="flex flex-col gap-2">
              {detail.artifacts.map((artifact, index) => (
                <ArtifactRow key={index} artifact={artifact} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            Transcript
          </h2>
          <div className="flex flex-col gap-3">
            {transcript.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        </section>

        {showComposer ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="sticky bottom-0 -mx-5 border-t border-border-subtle bg-canvas/95 px-5 py-4 backdrop-blur md:-mx-8 md:px-8"
          >
            <div className="mx-auto max-w-[860px]">
              <Composer
                variant="compact"
                error={formError}
                input={
                  <textarea
                    ref={textareaRef}
                    value={input}
                    disabled={!canContinue}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                    rows={1}
                    placeholder={canContinue ? "Steer this task worker" : "Task worker is running"}
                    className="min-h-9 w-full resize-none content-center bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none disabled:cursor-not-allowed disabled:text-ink-muted"
                    style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
                  />
                }
                leftControls={
                  <span className="inline-flex items-center gap-1.5 px-1 text-[12px] text-ink-muted">
                    <Bot size={14} strokeWidth={1.75} />
                    Continue task
                  </span>
                }
                action={
                  <button
                    type="submit"
                    disabled={!input.trim() || !canContinue}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Continue task"
                  >
                    {isPending ? (
                      <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
                    ) : (
                      <ArrowUp size={13} strokeWidth={2} />
                    )}
                  </button>
                }
              />
            </div>
          </form>
        ) : null}
      </div>
    </main>
  );
}

function StatusPill({ status, stage }: { status: string; stage: string }) {
  const icon =
    status === "succeeded" ? (
      <CheckCircle2 size={13} strokeWidth={1.75} />
    ) : status === "failed" ? (
      <XCircle size={13} strokeWidth={1.75} />
    ) : status === "queued" || status === "running" ? (
      <LoaderCircle size={13} strokeWidth={1.75} className="animate-spin" />
    ) : (
      <Clock3 size={13} strokeWidth={1.75} />
    );
  const tone =
    status === "succeeded"
      ? "border-success/25 bg-success/10 text-success"
      : status === "failed"
        ? "border-danger/25 bg-danger/10 text-danger"
        : "border-border bg-surface text-ink/80";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] font-medium ${tone}`}
    >
      {icon}
      {status}
      <span className="text-current/60">-</span>
      {stage}
    </span>
  );
}

function MessageBubble({ message }: { message: GoatTaskDetailPayload["messages"][number] }) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  return (
    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-[13px] leading-6 ${
          isUser
            ? "bg-surface-selected text-ink"
            : isTool
              ? "border border-border-subtle bg-surface-muted font-mono text-[12px] text-ink/75"
              : "bg-transparent text-ink/90"
        }`}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.05em] text-ink-subtle">
          <span>{message.toolName ?? message.role}</span>
          <span>{message.status}</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        {message.role === "assistant" ? (
          <Markdown content={message.content || " "} className="text-[13px] leading-6" />
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}
      </div>
    </article>
  );
}

function ArtifactRow({ artifact }: { artifact: unknown }) {
  if (!artifact || typeof artifact !== "object") {
    return null;
  }
  const record = artifact as Record<string, unknown>;
  const title =
    readString(record.title) ??
    readString(record.brainPath) ??
    readString(record.type) ??
    "Artifact";
  const url = readString(record.url);
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[13px]">
      {url ? (
        <a href={url} className="font-medium text-ink underline underline-offset-2">
          {title}
        </a>
      ) : (
        <span className="font-medium text-ink">{title}</span>
      )}
      {readString(record.brainPath) ? (
        <span className="ml-2 font-mono text-[12px] text-ink-muted">
          {readString(record.brainPath)}
        </span>
      ) : null}
    </div>
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
