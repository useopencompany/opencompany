"use client";

import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  CircleUserRound,
  Code2,
  Download,
  Loader2,
  Mail,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { type GoatBrainSummaryView, useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainSettings } from "@/components/GoatBrainSettings";
import { GoatBrainView } from "@/components/GoatBrainView";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { GoatSpendOverview } from "@/components/GoatSpendOverview";
import { GoatSurface } from "@/components/GoatSurface";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { SettingsIntegrationsPanel } from "@/components/SettingsIntegrationsPanel";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { TaskRunPanel } from "@/components/TaskRunPanel";
import type { GoatBrainSnapshot } from "@/lib/brain";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import type { GoatIntegrationState } from "@/lib/integration-state";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { buildGoatHarnessRun, type GoatHarnessRunViewModel } from "@/lib/task-harness-run";
import { updateGoatLocalCodexBetaAction } from "@/lib/user-preferences";

export function GoatHomeRoute({
  chatId,
  initialChat: routeInitialChat = null,
}: {
  chatId: string | null;
  initialChat?: GoatChatSessionView | null;
}) {
  const data = useGoatAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
  const initialChat = useMemo(() => {
    if (!chatId) return null;
    if (routeInitialChat?.id === chatId) return routeInitialChat;
    const summary = data.recentChats.find((chat) => chat.id === chatId);
    return {
      id: chatId,
      title: summary?.title ?? "Goat",
      model: summary?.model ?? DEFAULT_GOAT_MODEL,
      engine: summary?.engine ?? "opencompany",
      codexComposerSettings: summary?.codexComposerSettings ?? null,
      messages: [],
    };
  }, [chatId, data.recentChats, routeInitialChat]);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <GoatSurface
        tasks={data.tasks}
        schedules={data.schedules}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={initialChat}
        recentChats={data.recentChats}
        codexConnected={data.codexConnected}
        localCodexBetaEnabled={data.featureFlags.localCodexBridge}
        chatResumeEnabled={data.chatResumeEnabled}
        userName={userName}
        userWorkosId={data.user.workosUserId}
      />
    </main>
  );
}

export function GoatSettingsRoute() {
  const { user } = useGoatAppData();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);

  return (
    <GoatSettingsContent title="Account" description="Your personal profile for this workspace.">
      <section className="flex items-center gap-3">
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            className="h-14 w-14 rounded-full bg-surface-muted object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-[17px] font-semibold text-ink">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-tight text-ink">
            {displayName}
          </div>
          <div className="truncate text-[12.5px] leading-5 text-ink-subtle">{user.email}</div>
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Profile
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
    </GoatSettingsContent>
  );
}

export function GoatIntegrationsSettingsRoute() {
  const { integrations, workspace } = useGoatAppData();

  return (
    <GoatSettingsContent
      title="Integrations"
      description="Connect the tools Goat can read from and act on."
    >
      <IntegrationRows integrations={integrations} isWorkspaceAdmin={workspace.role === "admin"} />
    </GoatSettingsContent>
  );
}

export function GoatUsageSettingsRoute() {
  return (
    <GoatSettingsContent
      title="Usage"
      description="Track spend across chat, tasks, and brain ingestion."
    >
      <GoatSpendOverview />
    </GoatSettingsContent>
  );
}

export function GoatPreferencesSettingsRoute() {
  const { featureFlags } = useGoatAppData();

  return (
    <GoatSettingsContent title="Preferences" description="Experimental features and app behavior.">
      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Beta features
        </h2>
        <BetaFeatureSwitch
          icon={Code2}
          label="Local Codex bridge"
          description="Local Codex engine mode"
          checked={featureFlags.localCodexBridge}
        />
      </section>
    </GoatSettingsContent>
  );
}

export function GoatJamieSettingsRoute() {
  const { activeBrain, integrations, workspace } = useGoatAppData();
  const brainSourcesHref = activeBrain
    ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
    : null;

  return (
    <GoatSettingsContent
      title="Jamie"
      description="Meeting notes for Goat Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <JamieIntegrationSetup
        initialState={integrations.jamie}
        brainSourcesHref={brainSourcesHref}
        canManage={workspace.role === "admin"}
      />
    </GoatSettingsContent>
  );
}

export function GoatBrainRoute({
  path,
  routeBrainId,
  selectedBrain,
  initialBrainSnapshot,
}: {
  path: string[];
  routeBrainId: string | null;
  selectedBrain: GoatBrainSummaryView | null;
  initialBrainSnapshot: GoatBrainSnapshot | null;
}) {
  // "settings" is a reserved segment directly after an explicit brain id.
  if (routeBrainId && selectedBrain && path[0] === "settings") {
    return <GoatBrainSettingsRoute brain={selectedBrain} />;
  }
  const brain = initialBrainSnapshot ?? { folders: [], documents: [] };
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
      brainRef={selectedBrain?.id ?? null}
      brain={selectedBrain}
      folders={brain.folders}
      documents={brain.documents}
      initialFolderPath={initialFolderPath || null}
      initialBrainId={initialBrainId}
      routeBrainId={routeBrainId}
    />
  );
}

function GoatBrainSettingsRoute({ brain }: { brain: GoatBrainSummaryView }) {
  const { workspace } = useGoatAppData();

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[960px] flex-col gap-6 pb-24 pt-16 sm:pt-24">
          <BackLink href={`/brain/${encodeURIComponent(brain.id)}`} label={brain.name} />
          {workspace.role === "admin" ? (
            <GoatBrainSettings brain={brain} workspace={workspace} />
          ) : (
            <p className="text-[13px] leading-5 text-ink-subtle">
              Only workspace admins can manage brain settings.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export function GoatTaskDetailRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
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
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
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

function BetaFeatureSwitch({
  icon: Icon,
  label,
  description,
  checked,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    const nextEnabled = !checked;
    setError(null);
    startTransition(async () => {
      const result = await updateGoatLocalCodexBetaAction(nextEnabled);
      if (result.ok) {
        router.refresh();
        return;
      }

      setError("Could not update this beta.");
    });
  };

  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2">
      <Icon size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <span className="block truncate text-[14px] font-medium leading-tight text-ink">
              {label}
            </span>
            <span className="block truncate text-[12px] leading-4 text-ink-subtle">
              {description}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={isPending}
            onClick={toggle}
            className={`ml-auto inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60 ${
              checked ? "border-ink bg-ink" : "border-border bg-surface-muted"
            }`}
          >
            <span
              className={`block h-4 w-4 rounded-full bg-canvas shadow-sm transition-transform duration-150 ${
                checked ? "translate-x-[18px]" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
        {checked ? <LocalCodexBridgePairButton /> : null}
      </div>
    </div>
  );
}

function LocalCodexBridgePairButton() {
  const [isPairing, setIsPairing] = useState(false);

  const downloadBridge = async () => {
    if (isPairing) return;
    setIsPairing(true);

    try {
      await downloadLocalBridgeLauncher();
      toast.success("Bridge launcher downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not pair Local Codex.");
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={downloadBridge}
      disabled={isPairing}
      className="mt-1 inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[12px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isPairing ? (
        <Loader2 size={13} strokeWidth={2} className="shrink-0 animate-spin" />
      ) : (
        <Download size={13} strokeWidth={2} className="shrink-0" />
      )}
      {isPairing ? "Preparing" : "Download Mac launcher"}
    </button>
  );
}

async function downloadLocalBridgeLauncher() {
  const response = await fetch("/api/local-codex/bridges/launcher", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: localBridgeName() }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Could not pair Local Codex.");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "opencompany-goat-codex-bridge.terminal";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function localBridgeName() {
  const platform = navigator.platform?.trim();
  return platform ? `Local Codex (${platform})` : "Local Codex bridge";
}

function IntegrationRows({
  integrations,
  isWorkspaceAdmin,
}: {
  integrations: GoatIntegrationState;
  isWorkspaceAdmin: boolean;
}) {
  return (
    <SettingsIntegrationsPanel
      initialIntegrations={integrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
    />
  );
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
