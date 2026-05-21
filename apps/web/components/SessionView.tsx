"use client";

import { ArrowUp, Bot, CircleStop, TerminalSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { abortAgentSession, submitAgentSessionMessage } from "@/lib/agent-sessions/actions";

type Message = {
  id: string;
  role: string;
  content: string;
  status: string;
};

type RuntimeEvent = {
  id: number;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
};

type Props = {
  session: {
    id: string;
    title: string;
    status: string;
    modelName: string;
    lastError: string | null;
  };
  initialMessages: Message[];
  initialEvents: RuntimeEvent[];
  runnerUrl: string | null;
  streamToken: string | null;
};

export default function SessionView({
  session,
  initialMessages,
  initialEvents,
  runnerUrl,
  streamToken,
}: Props) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const lastEventId = useMemo(() => events.at(-1)?.id ?? 0, [events]);

  const applyRuntimeEvent = useCallback((event: RuntimeEvent) => {
    setEvents((current) => (current.some((item) => item.id === event.id) ? current : [...current, event]));

    if (event.type === "message.created") {
      const messageId = readString(event.payload.messageId);
      const role = readString(event.payload.role);
      setMessages((current) =>
        current.some((message) => message.id === messageId)
          ? current
          : [...current, { id: messageId, role, content: "", status: "running" }],
      );
    }

    if (event.type === "message.delta") {
      const messageId = readString(event.payload.messageId);
      const delta = readString(event.payload.delta);
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, content: `${message.content}${delta}` } : message,
        ),
      );
    }

    if (event.type === "message.completed") {
      const messageId = readString(event.payload.messageId);
      const content = optionalString(event.payload.content);
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, status: "completed", content: content ?? message.content }
            : message,
        ),
      );
    }
  }, []);

  useEffect(() => {
    if (!runnerUrl || !streamToken) return;

    const url = new URL(`${runnerUrl}/sessions/${session.id}/events`);
    url.searchParams.set("token", streamToken);
    if (lastEventId > 0) url.searchParams.set("after", String(lastEventId));
    const source = new EventSource(url);

    source.onmessage = (message) => {
      applyRuntimeEvent(JSON.parse(message.data) as RuntimeEvent);
    };

    return () => source.close();
    // Connect once per token. Replaying starts after the server-rendered last event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerUrl, streamToken, session.id, applyRuntimeEvent]);

  const submit = () => {
    const content = input.trim();
    if (!content) return;
    setInput("");
    startTransition(async () => {
      const result = await submitAgentSessionMessage(session.id, content);
      if (result.ok && result.messageId) {
        setMessages((current) => [
          ...current,
          { id: result.messageId, role: "user", content, status: "completed" },
        ]);
      }
      router.refresh();
    });
  };

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[#eaeae6] bg-canvas/85 px-8 py-3">
        <Bot size={14} strokeWidth={1.8} className="text-ink-muted" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink">{session.title}</div>
          <div className="text-[11px] text-ink-subtle">
            {session.status} · {session.modelName}
          </div>
        </div>
        <button
          onClick={() => {
            startTransition(async () => {
              await abortAgentSession(session.id);
              router.refresh();
            });
          }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-[#ececea]/70"
        >
          <CircleStop size={13} strokeWidth={1.8} />
          Abort
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[760px] space-y-5">
          {!runnerUrl || !streamToken ? (
            <div className="rounded-md border border-[#ececea] bg-white px-3 py-2 text-[12.5px] text-ink-muted">
              Runner streaming is not configured. Set <code>RUNNER_PUBLIC_URL</code> and{" "}
              <code>RUNNER_INTERNAL_TOKEN</code>.
            </div>
          ) : null}

          {messages.map((message) => (
            <div
              key={message.id}
              className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  message.role === "user"
                    ? "max-w-[78%] rounded-2xl rounded-tr-md bg-[#eef0ec] px-3.5 py-2.5 text-[13px] leading-6 text-ink"
                    : "max-w-[86%] whitespace-pre-wrap text-[13px] leading-6 text-ink/90"
                }
              >
                {message.content || (message.role === "assistant" ? "…" : "")}
              </div>
            </div>
          ))}

          <div className="space-y-1.5 border-t border-[#eeeeea] pt-4">
            {events
              .filter((event) => event.type.includes("tool") || event.type.includes("command") || event.type.includes("file"))
              .slice(-12)
              .map((event) => (
                <div key={event.id} className="flex items-center gap-2 text-[12px] text-ink-subtle">
                  <TerminalSquare size={12} strokeWidth={1.7} />
                  <span>{event.type}</span>
                  <span className="truncate">{summarizeEvent(event)}</span>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="border-t border-[#eaeae6] bg-canvas px-8 py-4">
        <div className="mx-auto flex max-w-[760px] items-end gap-2 rounded-xl border border-[#e4e4e0] bg-white px-3 py-2">
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
    </main>
  );
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function summarizeEvent(event: RuntimeEvent) {
  if (event.type === "tool.started") return `${readString(event.payload.name)} started`;
  if (event.type === "tool.completed") return `${readString(event.payload.name)} completed`;
  if (event.type === "file.changed") return readString(event.payload.path);
  if (event.type === "command.output") return readString(event.payload.delta).trim();
  return "";
}
