"use client";

import { useChat } from "@ai-sdk/react";
import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import { toast } from "@opencompany/ui/components/sonner";
import { DefaultChatTransport } from "ai";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  CheckCircle2,
  CircleDotDashed,
  Clock,
  FileText,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Markdown } from "@/components/Markdown";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import {
  type GoatChatMessageMetadata,
  type GoatChatSessionView,
  type GoatChatUiMessage,
  type GoatStartTaskToolOutput,
  textFromGoatChatUiMessage,
} from "@/lib/chat-ui";
import { GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import { archiveGoatTaskAction } from "@/lib/tasks";

export type GoatTaskView = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
  model: string;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function GoatSurface({
  tasks,
  defaultModel,
  initialChat,
}: {
  tasks: readonly GoatTaskView[];
  defaultModel: string;
  initialChat: GoatChatSessionView | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"home" | "chat">(() => (initialChat ? "chat" : "home"));
  const [chatSessionId, setChatSessionId] = useState<string | null>(initialChat?.id ?? null);
  const [chatModel, setChatModel] = useState(initialChat?.model ?? defaultModel);
  const [optimisticallyArchivedIds, setOptimisticallyArchivedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [, startArchiveTransition] = useTransition();
  const [, startCloseTransition] = useTransition();
  const transport = useMemo(
    () =>
      new DefaultChatTransport<GoatChatUiMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            sessionId: chatSessionId,
            model: chatModel,
            message: messages.at(-1),
          },
        }),
      }),
    [chatModel, chatSessionId],
  );
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error: chatError,
    clearError,
  } = useChat<GoatChatUiMessage>({
    id: initialChat?.id ?? "goat-chat-main",
    messages: initialChat?.messages ?? [],
    transport,
    onFinish: ({ message }) => {
      const sessionId = message.metadata?.sessionId;
      if (sessionId) {
        setChatSessionId(sessionId);
      }
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message || "Goat could not answer that right now.");
    },
  });
  const isGenerating = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (isGenerating) return;
    const frame = requestAnimationFrame(() => {
      setChatSessionId(initialChat?.id ?? null);
      setChatModel(initialChat?.model ?? defaultModel);
      setMessages(initialChat?.messages ?? []);
      setMode(initialChat ? "chat" : "home");
    });
    return () => cancelAnimationFrame(frame);
  }, [defaultModel, initialChat, isGenerating, setMessages]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    if (typeof thread.scrollTo === "function") {
      thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }, [messages, status]);

  useEffect(() => {
    if (!chatError || chatError.message === lastError.current) return;
    lastError.current = chatError.message;
    setMode("chat");
  }, [chatError]);

  const sortedTasks = useMemo(
    () =>
      tasks
        .filter((task) => !optimisticallyArchivedIds.has(task.id))
        .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [optimisticallyArchivedIds, tasks],
  );

  const archiveTask = (task: GoatTaskView) => {
    setOptimisticallyArchivedIds((current) => new Set(current).add(task.id));
    startArchiveTransition(async () => {
      const result = await archiveGoatTaskAction(task.id);
      if (result.ok) {
        router.refresh();
        return;
      }

      setOptimisticallyArchivedIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
      toast.error(result.error ?? "Could not archive task.");
    });
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isGenerating) return;

    const prompt = input.trim();
    if (!prompt) return;

    clearError();
    setMode("chat");
    setInput("");
    void sendMessage({ text: prompt }).catch((error) => {
      setInput(prompt);
      toast.error(error instanceof Error ? error.message : "Goat could not answer that right now.");
    });
  };

  const closeChat = () => {
    const closingSessionId = chatSessionId;
    if (isGenerating) void stop();
    setMode("home");
    setMessages([]);
    setChatSessionId(null);
    clearError();
    requestAnimationFrame(() => inputRef.current?.focus());
    if (!closingSessionId) return;

    startCloseTransition(async () => {
      const result = await closeGoatChatSessionAction(closingSessionId);
      if (!result.ok) {
        toast.error(result.error ?? "Could not close chat.");
      }
      router.refresh();
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
    if (event.key === "Escape" && mode === "chat") {
      event.preventDefault();
      closeChat();
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-hidden">
      {mode === "home" ? (
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className="absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Settings size={16} strokeWidth={2} />
        </Link>
      ) : null}

      {mode === "home" ? (
        <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-[560px] flex-col gap-8 pb-40 pt-24">
            <header>
              <h1 className="text-[42px] font-semibold leading-none tracking-normal text-ink">
                Goat
              </h1>
            </header>

            <section className="flex flex-col gap-1">
              <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Results
              </h2>
              {sortedTasks.length > 0 ? (
                sortedTasks.map((task) => (
                  <ResultRow key={task.id} task={task} onArchive={archiveTask} />
                ))
              ) : (
                <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">No results yet.</p>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 w-full flex-1 flex-col items-center">
          <div className="flex w-full max-w-[560px] items-center gap-2 px-6 pb-2 pt-5">
            <Sparkles size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
            <span className="text-[13px] font-medium text-ink">Chat</span>
            <button
              type="button"
              aria-label="Close chat"
              onClick={closeChat}
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none"
            >
              Close
              <X size={14} strokeWidth={2} />
            </button>
          </div>

          <div
            ref={threadRef}
            className="min-h-0 w-full flex-1 justify-center overflow-y-auto px-6"
          >
            <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 pb-40 pt-2">
              {messages.map((message) => (
                <Bubble key={message.id} message={message} />
              ))}
              {status === "submitted" ? <ThinkingBubble /> : null}
            </div>
          </div>
        </div>
      )}

      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-canvas via-canvas to-transparent px-6 pb-6 pt-8"
      >
        <div className="pointer-events-auto flex w-full max-w-[560px] flex-col gap-2">
          {chatError ? (
            <p
              className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              role="alert"
            >
              {chatError.message || "Goat could not answer that right now."}
            </p>
          ) : null}
          <div className="flex items-end gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-2.5 shadow-[0_8px_24px_rgba(15,15,15,0.08)] transition-colors duration-150 focus-within:border-border-strong">
            <Sparkles size={15} strokeWidth={1.9} className="mb-[3px] shrink-0 text-ink-subtle" />
            <textarea
              ref={inputRef}
              rows={1}
              id="prompt"
              name="prompt"
              value={input}
              placeholder={mode === "chat" ? "Reply..." : "Ask a question or describe a task..."}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={isGenerating}
              className="max-h-32 flex-1 resize-none self-center bg-transparent py-[3px] text-[13.5px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
              maxLength={10_000}
              required
            />
            <SubmitButton
              disabled={!input.trim()}
              isGenerating={isGenerating}
              onStop={() => void stop()}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

function ResultRow({
  task,
  onArchive,
}: {
  task: GoatTaskView;
  onArchive: (task: GoatTaskView) => void;
}) {
  const meta = getTaskMeta(task);
  const Icon = meta.icon;
  const title = task.name;
  const canArchive = task.status === "succeeded" || task.status === "failed";
  return (
    <div className="group/result relative flex items-center rounded-lg px-2 py-1 transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <Link
        href={`/tasks/${encodeURIComponent(task.displayId)}`}
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

function Bubble({ message }: { message: GoatChatUiMessage }) {
  const isUser = message.role === "user";
  const text = textFromGoatChatUiMessage(message);
  const task = taskFromMessage(message);
  const error = message.metadata?.error;

  if (task) {
    return (
      <div className="flex flex-col gap-2">
        {text ? (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-surface-muted px-3 py-2 text-[13px] leading-5 text-ink">
              <Markdown content={text} />
            </div>
          </div>
        ) : null}
        <Link
          href={`/tasks/${encodeURIComponent(task.displayId)}`}
          className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <CircleDotDashed
            size={16}
            strokeWidth={2}
            className="shrink-0 animate-[spin_3s_linear_infinite] text-amber-500"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-medium leading-tight text-ink">
              {task.title}
            </span>
            <span className="text-[12px] leading-tight text-ink-subtle">
              {task.displayId} · Task running - added to Results
            </span>
          </div>
          <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            {task.displayId}
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 ${
          isUser
            ? "rounded-br-md bg-ink text-canvas"
            : error
              ? "rounded-bl-md bg-danger-bg text-danger"
              : "rounded-bl-md bg-surface-muted text-ink"
        }`}
      >
        {isUser ? text : <Markdown content={text} />}
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-bl-md bg-surface-muted px-3 py-2 text-[13px] leading-5 text-ink-subtle">
        Thinking...
      </div>
    </div>
  );
}

function SubmitButton({
  disabled,
  isGenerating,
  onStop,
}: {
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
}) {
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
      aria-label="Send message"
      disabled={disabled}
      className="mb-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-canvas transition-opacity duration-150 hover:opacity-90 focus:outline-none disabled:opacity-30"
    >
      <ArrowUp size={15} strokeWidth={2.2} />
    </button>
  );
}

function taskFromMessage(message: GoatChatUiMessage) {
  const metadataTask = message.metadata?.task;
  if (metadataTask) return metadataTask;

  for (const part of message.parts) {
    if (part.type !== "tool-start_goat_task" || part.state !== "output-available") continue;
    const output = part.output;
    if (!isStartTaskToolOutput(output)) continue;
    return {
      id: output.taskId,
      displayId: output.taskDisplayId,
      title: output.taskName,
    } satisfies NonNullable<GoatChatMessageMetadata["task"]>;
  }

  return null;
}

function isStartTaskToolOutput(value: unknown): value is GoatStartTaskToolOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.taskId === "string" &&
    typeof output.taskDisplayId === "string" &&
    typeof output.taskName === "string"
  );
}

function getTaskMeta(task: GoatTaskView): {
  icon: typeof FileText;
  className: string;
  detail: string;
  spin: boolean;
} {
  if (task.status === "failed") {
    return {
      icon: AlertCircle,
      className: "text-danger",
      detail: task.error ?? GOAT_STATUS_COPY.failed,
      spin: false,
    };
  }
  if (task.status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      detail: firstLine(task.result) ?? GOAT_STATUS_COPY.succeeded,
      spin: false,
    };
  }
  if (task.status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      detail: GOAT_STAGE_COPY[task.stage],
      spin: false,
    };
  }
  return {
    icon: CircleDotDashed,
    className: "text-amber-500",
    detail: GOAT_STAGE_COPY[task.stage],
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
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "now";

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
