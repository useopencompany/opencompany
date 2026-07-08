"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowLeft, CircleUserRound, FileText, Mail, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainView } from "@/components/GoatBrainView";
import { GoatSurface } from "@/components/GoatSurface";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { SettingsIntegrationsPanel } from "@/components/SettingsIntegrationsPanel";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { TaskRunPanel } from "@/components/TaskRunPanel";
import type { GoatIntegrationState } from "@/lib/integration-state";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { buildGoatHarnessRun, type GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function GoatHomeRoute({ chatId }: { chatId: string | null }) {
  const data = useGoatAppData();
  const initialChat = useMemo(() => {
    if (!chatId) return null;
    const summary = data.recentChats.find((chat) => chat.id === chatId);
    return {
      id: chatId,
      title: summary?.title ?? "Goat",
      model: summary?.model ?? DEFAULT_GOAT_MODEL,
      messages: [],
    };
  }, [chatId, data.recentChats]);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <GoatSurface
        tasks={data.tasks}
        schedules={data.schedules}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={initialChat}
        recentChats={data.recentChats}
        codexConnected={data.codexConnected}
      />
    </main>
  );
}

export function GoatSettingsRoute() {
  const { integrations, user } = useGoatAppData();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Goat" />

          <header className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="h-12 w-12 rounded-full bg-surface-muted object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-[15px] font-semibold text-ink">
                  {initials}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
                  Settings
                </h1>
                <p className="truncate text-[13px] leading-5 text-ink-subtle">{displayName}</p>
              </div>
            </div>
          </header>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Account
            </h2>
            <AccountRow icon={Mail} label="Email" value={user.email} />
            <AccountRow icon={UserRound} label="Name" value={name || "Not set"} />
            <AccountRow
              icon={CircleUserRound}
              label="First name"
              value={user.firstName?.trim() || "Not set"}
            />
            <AccountRow
              icon={CircleUserRound}
              label="Last name"
              value={user.lastName?.trim() || "Not set"}
            />
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Personal integrations
            </h2>
            <IntegrationRows integrations={integrations} />
          </section>
        </div>
      </div>
    </main>
  );
}

export function GoatJamieSettingsRoute() {
  const { integrations } = useGoatAppData();

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <BackLink href="/settings" label="Settings" />

          <header className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink">
              <FileText size={21} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
                Jamie
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">Meeting notes for Goat Brain</p>
            </div>
          </header>

          <JamieIntegrationSetup initialState={integrations.jamie} />
        </div>
      </div>
    </main>
  );
}

export function GoatBrainRoute({ path }: { path: string[] }) {
  const { brain } = useGoatAppData();
  const requestedPath = path.join("/");
  const requestedFolderExists = brain.folders.some((folder) => folder.path === requestedPath);
  const initialBrainId = path.length > 1 && !requestedFolderExists ? (path.at(-1) ?? null) : null;
  const initialFolderPath =
    path.length > 0
      ? initialBrainId
        ? path.slice(0, -1).join("/")
        : requestedPath
      : (brain.folders[0]?.path ?? null);

  return (
    <GoatBrainView
      folders={brain.folders}
      documents={brain.documents}
      initialFolderPath={initialFolderPath || null}
      initialBrainId={initialBrainId}
    />
  );
}

export function GoatTaskDetailRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Results" />
          {run ? <TaskDetailPanel initialRun={run} /> : <TaskRouteSkeleton label="Loading task" />}
        </div>
      </div>
    </main>
  );
}

export function GoatTaskRunRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);
  const detailHref = run ? `/tasks/${encodeURIComponent(run.task.displayId)}` : "/";

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-5">
        <div className="flex w-full max-w-[880px] flex-col gap-8 pb-24 pt-14 sm:pt-20">
          <nav className="flex flex-wrap items-center gap-2">
            <BackLink href={detailHref} label="Task detail" />
            <Link
              href="/"
              prefetch
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              Results
            </Link>
          </nav>

          {run ? (
            <>
              <header className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <h1 className="text-[34px] font-semibold leading-tight tracking-normal text-ink">
                    {run.task.name}
                  </h1>
                  <div className="text-[12.5px] leading-5 text-ink-muted">Task run</div>
                </div>
              </header>

              <TaskRunPanel initialRun={run} />
            </>
          ) : (
            <TaskRouteSkeleton label="Loading run" />
          )}
        </div>
      </div>
    </main>
  );
}

function useTaskRun(taskId: string) {
  const { tasks, taskRows } = useGoatAppData();
  const [serverState, setServerState] = useState<{
    taskId: string;
    run: GoatHarnessRunViewModel | null;
    notFound: boolean;
  } | null>(null);
  const normalizedTaskId = taskId.trim().toUpperCase();
  const liveTask = useMemo(
    () =>
      taskRows.find((task) => task.id === taskId || task.display_id === normalizedTaskId) ??
      tasks.find((task) => task.id === taskId || task.displayId === normalizedTaskId) ??
      null,
    [normalizedTaskId, taskId, taskRows, tasks],
  );
  const placeholderRun = useMemo(
    () => (liveTask ? buildGoatHarnessRun({ task: liveTask, messages: [], events: [] }) : null),
    [liveTask],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) {
          setServerState({ taskId, run: null, notFound: true });
          return null;
        }
        if (!response.ok) throw new Error("Could not load task run.");
        return (await response.json()) as GoatHarnessRunViewModel;
      })
      .then((run) => {
        if (run) setServerState({ taskId, run, notFound: false });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [taskId]);

  const currentServerState = serverState?.taskId === taskId ? serverState : null;
  if (currentServerState?.run) return currentServerState.run;
  if (currentServerState?.notFound && !placeholderRun) return null;
  return placeholderRun;
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      prefetch
      className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <ArrowLeft size={14} strokeWidth={2} />
      {label}
    </Link>
  );
}

function AccountRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Icon size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="w-20 shrink-0 text-[12.5px] leading-tight text-ink-subtle">{label}</span>
        <span className="truncate text-[14px] font-medium leading-tight text-ink">{value}</span>
      </div>
    </div>
  );
}

function IntegrationRows({ integrations }: { integrations: GoatIntegrationState }) {
  return <SettingsIntegrationsPanel initialIntegrations={integrations} />;
}

function TaskRouteSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} className="flex flex-col gap-3">
      <div className="h-8 w-2/3 rounded-md bg-surface-muted" />
      <div className="h-4 w-24 rounded bg-surface-muted" />
      <div className="h-10 rounded-lg bg-surface-muted" />
      <div className="h-10 rounded-lg bg-surface-muted" />
      <div className="h-32 rounded-lg bg-surface-muted" />
    </div>
  );
}

function getInitials(firstName: string | null, lastName: string | null, email: string) {
  const initials = [firstName, lastName]
    .map((part) => part?.trim().at(0))
    .filter(Boolean)
    .join("")
    .toUpperCase();

  return initials || email.trim().at(0)?.toUpperCase() || "?";
}
