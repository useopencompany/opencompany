"use client";

import { goatTaskRunSessionId } from "@opencompany/agent-runtime";
import { useLiveQuery } from "@tanstack/react-db";
import {
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  MessagesSquare,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { Markdown } from "@/components/Markdown";
import { useHydrated } from "@/components/useHydrated";
import { formatRelativeTime } from "@/lib/task-board";
import { createGoatCollections, type GoatTaskCommentRow } from "@/lib/task-collections";

// Renders the Linear-style activity feed for session-backed tasks. Legacy
// harness tasks have no comments, so the provided legacy content stays visible
// for them (and while the comments shape is still loading).
export function TaskActivitySection({
  taskId,
  isActive,
  legacy,
}: {
  taskId: string;
  isActive: boolean;
  legacy: ReactNode;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return legacy;
  return <LiveTaskActivitySection taskId={taskId} isActive={isActive} legacy={legacy} />;
}

function LiveTaskActivitySection({
  taskId,
  isActive,
  legacy,
}: {
  taskId: string;
  isActive: boolean;
  legacy: ReactNode;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const comments = useMemo(
    () => collections.taskRunCollections(taskId).comments,
    [collections, taskId],
  );
  const { data: commentRows } = useLiveQuery((q) => q.from({ comment: comments }));
  const sorted = useMemo(
    () =>
      ((commentRows ?? []) as GoatTaskCommentRow[]).toSorted(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [commentRows],
  );

  if (sorted.length === 0) return legacy;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Activity
        </h2>
        <Link
          href={`/chat/${encodeURIComponent(goatTaskRunSessionId(taskId))}`}
          prefetch
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <MessagesSquare size={12} strokeWidth={1.8} />
          {isActive ? "Open session · steer the run" : "Open session"}
        </Link>
      </div>
      <ol className="flex flex-col gap-1">
        {sorted.map((comment) => (
          <ActivityEntry key={comment.id} comment={comment} />
        ))}
      </ol>
    </section>
  );
}

function ActivityEntry({ comment }: { comment: GoatTaskCommentRow }) {
  const meta = entryMeta(comment);
  const Icon = meta.icon;

  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2">
      <Icon size={15} strokeWidth={2} className={`mt-0.5 shrink-0 ${meta.className}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] font-medium leading-5 text-ink">{meta.label}</span>
          <span className="text-[11.5px] leading-5 text-ink-subtle">
            {formatRelativeTime(comment.created_at)}
          </span>
        </div>
        {comment.kind === "result" ? (
          <div className="mt-1 rounded-lg border border-border bg-surface px-3 py-2">
            <Markdown content={comment.content} />
          </div>
        ) : comment.content ? (
          <p className="whitespace-pre-wrap text-[13px] leading-5 text-ink-muted">
            {comment.content}
          </p>
        ) : null}
        {comment.metadata.error ? (
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-danger">
            {comment.metadata.error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function entryMeta(comment: GoatTaskCommentRow): {
  icon: typeof MessageSquare;
  className: string;
  label: string;
} {
  if (comment.kind === "result") {
    return { icon: CheckCircle2, className: "text-emerald-600", label: "Agent posted the result" };
  }
  if (comment.kind === "status") {
    switch (comment.metadata.status) {
      case "started":
        return { icon: Play, className: "text-amber-500", label: "Run started" };
      case "failed":
        return { icon: AlertCircle, className: "text-danger", label: "Run failed" };
      case "retrying":
        return { icon: RotateCcw, className: "text-amber-500", label: "Retry requested" };
      case "canceled":
        return { icon: X, className: "text-ink-subtle", label: "Stopped" };
      default:
        return { icon: MessageSquare, className: "text-ink-subtle", label: "Status update" };
    }
  }
  return {
    icon: MessageSquare,
    className: "text-ink-subtle",
    label: comment.author === "agent" ? "Agent" : "Comment",
  };
}
