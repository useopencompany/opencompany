import type { GoatTaskStage, GoatTaskStatus, goatTasks } from "@opencompany/db/goat-schema";
import { Badge } from "@opencompany/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@opencompany/ui/components/card";
import { cn } from "@opencompany/ui/lib/utils";
import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";

type GoatTask = typeof goatTasks.$inferSelect;

const STATUS_COPY: Record<GoatTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

const STAGE_COPY: Record<GoatTaskStage, string> = {
  queued: "Waiting for runner",
  planning: "Planning harness",
  sandboxing: "Preparing sandbox",
  running: "Running harness",
  completed: "Completed",
  failed: "Failed",
};

export function TaskList({ tasks }: { tasks: readonly GoatTask[] }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/70 p-8 text-center">
        <p className="text-sm font-medium text-foreground">No tasks yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create one above to start the first Goat run.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskItem({ task }: { task: GoatTask }) {
  const createdAt = formatDate(task.createdAt);
  return (
    <Card className="gap-4 rounded-md py-4 shadow-none">
      <CardHeader className="grid gap-3 px-4 sm:grid-cols-[1fr_auto] sm:items-start">
        <div className="min-w-0">
          <CardTitle className="text-sm leading-5">
            <span className="line-clamp-2 break-words">{task.name}</span>
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{task.displayId}</span>
            <span className="text-border">/</span>
            <span>{createdAt}</span>
            <span className="text-border">/</span>
            <span>{task.model}</span>
          </div>
        </div>
        <StatusBadge status={task.status} stage={task.stage} />
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {task.result ? (
          <div className="rounded-md border border-success-border bg-success-bg/60 p-3">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
              {task.result}
            </pre>
          </div>
        ) : null}
        {task.error ? (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
            {task.error}
          </div>
        ) : null}
        {!task.result && !task.error ? (
          <p className="text-sm text-muted-foreground">{STAGE_COPY[task.stage]}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, stage }: { status: GoatTaskStatus; stage: GoatTaskStage }) {
  const iconClassName = cn("size-3", status === "running" ? "animate-spin" : null);
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed"
        ? AlertCircle
        : status === "running"
          ? Loader2
          : Clock;
  const variant =
    status === "succeeded"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "running"
          ? "info"
          : "secondary";

  return (
    <Badge
      variant={variant}
      title={STAGE_COPY[stage]}
      className="justify-self-start sm:justify-self-end"
    >
      <Icon className={iconClassName} />
      {STATUS_COPY[status]}
    </Badge>
  );
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
