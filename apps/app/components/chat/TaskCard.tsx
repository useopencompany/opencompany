"use client";

import type { TaskStatus } from "@opencompany/db/schema";
import { AlertCircle, CheckCircle2, CircleDotDashed, Clock, FileText, X } from "lucide-react";
import Link from "next/link";
import { STATUS_COPY } from "@/lib/task-display";
import type { ChatTaskCardView } from "./assistant-items";

export function TaskCard({
  task,
  readOnly = false,
}: {
  task: ChatTaskCardView;
  readOnly?: boolean;
}) {
  const meta = getChatTaskCardMeta(task.status);
  const Icon = meta.icon;
  const linkId = task.displayId ?? task.id;
  const displayLabel = task.displayId ?? "Task";
  const title = task.title ?? "Task";
  const content = (
    <>
      <Icon
        size={16}
        strokeWidth={2}
        className={`${meta.className} shrink-0 ${meta.spin ? "animate-[spin_3s_linear_infinite]" : ""}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium leading-tight text-ink">{title}</span>
        <span className="text-[12px] leading-tight text-ink-subtle">
          {displayLabel} · {meta.label}
        </span>
      </div>
      <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-ink-muted">
        {displayLabel}
      </span>
    </>
  );
  const className =
    "flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]";

  if (readOnly) return <div className={className}>{content}</div>;

  return (
    <Link
      href={`/tasks/${encodeURIComponent(linkId)}`}
      className={`${className} transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20`}
    >
      {content}
    </Link>
  );
}

export function getChatTaskCardMeta(status: TaskStatus | null): {
  icon: typeof FileText;
  className: string;
  label: string;
  spin: boolean;
} {
  if (status === "failed") {
    return {
      icon: AlertCircle,
      className: "text-danger",
      label: STATUS_COPY.failed,
      spin: false,
    };
  }
  if (status === "canceled") {
    return {
      icon: X,
      className: "text-ink-subtle",
      label: STATUS_COPY.canceled,
      spin: false,
    };
  }
  if (status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      label: STATUS_COPY.succeeded,
      spin: false,
    };
  }
  if (status === "running") {
    return {
      icon: CircleDotDashed,
      className: "text-amber-500",
      label: STATUS_COPY.running,
      spin: true,
    };
  }
  if (status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      label: STATUS_COPY.queued,
      spin: false,
    };
  }
  return {
    icon: Clock,
    className: "text-ink-subtle",
    label: "Status pending",
    spin: false,
  };
}
