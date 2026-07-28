"use client";

import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeft,
  Check,
  CircleUserRound,
  Code2,
  Download,
  ListTodo,
  Loader2,
  Mail,
  Monitor,
  Moon,
  Plus,
  Sparkles,
  Sun,
  UserRound,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { FathomIntegrationSetup } from "@/components/FathomIntegrationSetup";
import { type GoatBrainSummaryView, useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainSettings } from "@/components/GoatBrainSettings";
import { GoatBrainView } from "@/components/GoatBrainView";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { GoatSurface, type GoatTaskView } from "@/components/GoatSurface";
import { GranolaIntegrationSetup } from "@/components/GranolaIntegrationSetup";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { KleinanzeigenIntegrationSetup } from "@/components/KleinanzeigenIntegrationSetup";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import { McpSetupGuide } from "@/components/McpSetupGuide";
import { SettingsIntegrationsPanel } from "@/components/SettingsIntegrationsPanel";
import { StripeIntegrationSetup } from "@/components/StripeIntegrationSetup";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { TaskRunPanel } from "@/components/TaskRunPanel";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import type { GoatBrainSnapshot } from "@/lib/brain";
import type { GoatBrainOverviewStats } from "@/lib/brain-overview";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import type { GoatIntegrationState } from "@/lib/integration-state";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  archiveGoatSkillAction,
  createGoatSkillAction,
  updateGoatSkillAction,
} from "@/lib/skill-actions";
import type { GoatSkillCatalogItem, GoatSkillListItem, GoatWorkspaceSkill } from "@/lib/skills";
import {
  GOAT_WORKFLOW_TASK_STATUS_COPY,
  type GoatWorkflowTaskDisplayStatus,
  goatWorkflowTaskDisplayStatus,
  toGoatTaskTitle,
} from "@/lib/task-display";
import { buildGoatHarnessRun, type GoatHarnessRunViewModel } from "@/lib/task-harness-run";
import {
  updateGoatLocalCodexBetaAction,
  updateGoatTaskSpawningAction,
} from "@/lib/user-preferences";
import {
  archiveGoatWorkflowAction,
  createGoatWorkflowAction,
  updateGoatWorkflowAction,
} from "@/lib/workflow-actions";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  GOAT_WORKFLOW_MODEL_OPTIONS,
} from "@/lib/workflow-model-options";
import type { GoatWorkflowListItem, GoatWorkspaceWorkflow } from "@/lib/workflows";

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
      codexRuntime: summary?.codexRuntime ?? null,
      messages: [],
    };
  }, [chatId, data.recentChats, routeInitialChat]);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <GoatSurface
        key={data.activeBrain?.id ?? "no-brain"}
        tasks={data.tasks}
        schedules={data.schedules}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={initialChat}
        recentChats={data.recentChats}
        archivedChats={data.archivedChats}
        codexConnected={data.codexConnected}
        claudeCodeConnected={data.claudeCodeConnected}
        localCodexBetaEnabled={data.featureFlags.localCodexBridge}
        taskSpawningEnabled={data.featureFlags.taskSpawning}
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

export function GoatMcpSettingsRoute() {
  const { mcpSetup, user, workspace } = useGoatAppData();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Teammate";

  return (
    <GoatSettingsContent
      title="MCP"
      description="Connect Claude, ChatGPT, or Cursor to everything you can access in OpenCompany."
    >
      <McpSetupGuide
        displayName={displayName}
        workspaceName={workspace.name}
        initialClient={mcpSetup.preferredClient}
        initialCompletedAt={mcpSetup.completedAt}
        hideHeader
      />
    </GoatSettingsContent>
  );
}

export function GoatPreferencesSettingsRoute() {
  const { featureFlags } = useGoatAppData();

  return (
    <GoatSettingsContent title="Preferences" description="Experimental features and app behavior.">
      <section className="flex flex-col gap-2">
        <h2 className="mb-1 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Appearance
        </h2>
        <AppearanceSection />
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Beta features
        </h2>
        <BetaFeatureSwitch
          icon={ListTodo}
          label="Background tasks"
          description="Spawn tracked tasks and recurring routines from chat"
          checked={featureFlags.taskSpawning}
          update={updateGoatTaskSpawningAction}
        />
        <BetaFeatureSwitch
          icon={Code2}
          label="Local Codex bridge"
          description="Local Codex engine mode"
          checked={featureFlags.localCodexBridge}
          update={updateGoatLocalCodexBetaAction}
          showLocalBridgePairing
        />
      </section>
    </GoatSettingsContent>
  );
}

const themeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const selectedIndex = themeOptions.findIndex((option) => option.value === theme);

  function selectThemeOption(index: number, group: HTMLDivElement) {
    const option = themeOptions[index];
    if (!option) return;

    setTheme(option.value);
    requestAnimationFrame(() => {
      group.querySelector<HTMLButtonElement>(`[data-theme-option="${option.value}"]`)?.focus();
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectThemeOption((currentIndex + 1) % themeOptions.length, event.currentTarget);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectThemeOption(
        (currentIndex - 1 + themeOptions.length) % themeOptions.length,
        event.currentTarget,
      );
    }
  }

  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={handleKeyDown}
    >
      {themeOptions.map((option, index) => {
        const Icon = option.icon;
        const selected = theme === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            data-theme-option={option.value}
            onClick={() => setTheme(option.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
            {option.label}
          </button>
        );
      })}
    </div>
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

export function GoatGranolaSettingsRoute() {
  const { activeBrain, integrations } = useGoatAppData();
  const brainSourcesHref = activeBrain
    ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
    : null;

  return (
    <GoatSettingsContent
      title="Granola"
      description="Meeting notes for Goat Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <GranolaIntegrationSetup
        initialState={integrations.granola}
        brainSourcesHref={brainSourcesHref}
      />
    </GoatSettingsContent>
  );
}

export function GoatFathomSettingsRoute() {
  const { activeBrain, integrations } = useGoatAppData();
  const brainSourcesHref = activeBrain
    ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
    : null;

  return (
    <GoatSettingsContent
      title="Fathom"
      description="Meeting recordings for Goat Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <FathomIntegrationSetup
        initialState={integrations.fathom}
        brainSourcesHref={brainSourcesHref}
      />
    </GoatSettingsContent>
  );
}

export function GoatAttioSettingsRoute() {
  const { activeBrain, integrations } = useGoatAppData();
  const brainSourcesHref = activeBrain
    ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
    : null;

  return (
    <GoatSettingsContent
      title="Attio"
      description="CRM activity for Goat Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <AttioIntegrationSetup
        initialState={integrations.attio}
        brainSourcesHref={brainSourcesHref}
      />
    </GoatSettingsContent>
  );
}

export function GoatStripeSettingsRoute() {
  const { integrations, workspace } = useGoatAppData();

  return (
    <GoatSettingsContent
      title="Stripe"
      description="Read-only founder metrics from your Stripe account"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <StripeIntegrationSetup
        initialState={integrations.stripe}
        canManage={workspace.role === "admin"}
      />
    </GoatSettingsContent>
  );
}

export function GoatKleinanzeigenSettingsRoute() {
  const { integrations } = useGoatAppData();
  const account = integrations.personalAccounts.kleinanzeigen[0] ?? null;

  return (
    <GoatSettingsContent
      title="Kleinanzeigen"
      description="Publish approved listings from images in Chat"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <KleinanzeigenIntegrationSetup initialAccount={account} />
    </GoatSettingsContent>
  );
}

export function GoatBrainRoute({
  path,
  routeBrainId,
  selectedBrain,
  initialBrainSnapshot,
  initialOverviewStats,
}: {
  path: string[];
  routeBrainId: string | null;
  selectedBrain: GoatBrainSummaryView | null;
  initialBrainSnapshot: GoatBrainSnapshot | null;
  initialOverviewStats?: GoatBrainOverviewStats | null;
}) {
  // "settings" is a reserved segment directly after an explicit brain id.
  if (routeBrainId && selectedBrain && path[0] === "settings") {
    return <GoatBrainSettingsRoute brain={selectedBrain} />;
  }
  const brain = initialBrainSnapshot ?? { folders: [], documents: [] };
  const isOverviewRoute = path.length === 0 || (path.length === 1 && path[0] === "overview");
  const requestedPath = path.join("/");
  const requestedFolderExists = brain.folders.some((folder) => folder.path === requestedPath);
  const initialBrainId = path.length > 1 && !requestedFolderExists ? (path.at(-1) ?? null) : null;
  const initialFolderPath = isOverviewRoute
    ? null
    : path.length > 0
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
      initialOverview={isOverviewRoute}
      overviewStats={initialOverviewStats ?? null}
      initialDataLoaded={initialBrainSnapshot !== null || !selectedBrain}
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
  const { featureFlags } = useGoatAppData();

  if (!featureFlags.taskSpawning) return <TasksDisabledRoute />;

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Tasks" />
          {run ? <TaskDetailPanel initialRun={run} /> : <TaskRouteSkeleton label="Loading task" />}
        </div>
      </div>
    </main>
  );
}

export function GoatTaskRunRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);
  const { featureFlags } = useGoatAppData();
  const detailHref = run ? `/tasks/${encodeURIComponent(run.task.displayId)}` : "/";

  if (!featureFlags.taskSpawning) return <TasksDisabledRoute />;

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
              Tasks
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
  const { featureFlags, tasks, taskRows } = useGoatAppData();
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
    if (!featureFlags.taskSpawning) return;
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
  }, [featureFlags.taskSpawning, taskId]);

  const currentServerState = serverState?.taskId === taskId ? serverState : null;
  if (currentServerState?.run) return currentServerState.run;
  if (currentServerState?.notFound && !placeholderRun) return null;
  return placeholderRun;
}

function TasksDisabledRoute() {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-4 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Chat" />
          <h1 className="text-[24px] font-semibold leading-tight text-ink">
            Background tasks are disabled
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Enable Background tasks in Preferences to use background tasks and recurring routines.
          </p>
          <Link
            href="/settings/preferences"
            className="inline-flex w-fit rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-hover"
          >
            Open Preferences
          </Link>
        </div>
      </div>
    </main>
  );
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
  update,
  showLocalBridgePairing = false,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  update: (enabled: boolean) => Promise<{ ok: boolean }>;
  showLocalBridgePairing?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    const nextEnabled = !checked;
    setError(null);
    startTransition(async () => {
      let result: { ok: boolean };
      try {
        result = await update(nextEnabled);
      } catch {
        setError("Could not update this preference.");
        return;
      }
      if (result.ok) {
        router.refresh();
        return;
      }

      setError("Could not update this preference.");
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
        {checked && showLocalBridgePairing ? <LocalCodexBridgePairButton /> : null}
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

// --- Workflows ---------------------------------------------------------------

const WORKFLOW_DEFAULT_MODEL_LABEL =
  GOAT_WORKFLOW_MODEL_OPTIONS.find((option) => option.token === DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN)
    ?.label ?? "Default";

export function GoatWorkflowsRoute({
  workflows,
  canEdit,
}: {
  workflows: GoatWorkflowListItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[760px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <header className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
                Workflows
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">
                Automations you fire with <span className="font-medium text-ink">#</span> in chat;
                each run becomes a Task.
              </p>
            </div>
            {canEdit ? (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <Plus size={14} strokeWidth={2} />
                New workflow
              </button>
            ) : null}
          </header>

          {workflows.length === 0 ? (
            <GoatEmptyState
              icon={Workflow}
              title="No workflows yet"
              description={
                canEdit
                  ? "Create a workflow to automate a recurring job. Fire it with # in chat, and each run shows up as a Task."
                  : "Workflows are automations your workspace admins set up. Fire one with # in chat and each run becomes a Task."
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {workflows.map((workflow) => (
                <li key={workflow.slug}>
                  <WorkflowListRow workflow={workflow} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {creating ? (
        <NewItemDialog
          title="New workflow"
          namePlaceholder="Weekly investor update"
          descriptionPlaceholder="What this workflow does"
          submitLabel="Create workflow"
          create={createGoatWorkflowAction}
          onClose={() => setCreating(false)}
          onCreated={(slug) => router.push(`/workflows/${encodeURIComponent(slug)}`)}
        />
      ) : null}
    </main>
  );
}

function WorkflowListRow({ workflow }: { workflow: GoatWorkflowListItem }) {
  return (
    <Link
      href={`/workflows/${encodeURIComponent(workflow.slug)}`}
      prefetch
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-tight text-ink">
            {workflow.name}
          </span>
          <ItemStatusBadge status={workflow.status} />
        </span>
        {workflow.description.trim() ? (
          <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-ink-subtle">
            {workflow.description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px] leading-4 text-ink-subtle">
        {formatGoatRelativeTime(workflow.updatedAt)}
      </span>
    </Link>
  );
}

export function GoatWorkflowEditorRoute({
  workflow,
  initialStatus,
  canEdit,
  skillCatalog,
}: {
  workflow: GoatWorkspaceWorkflow;
  initialStatus: "draft" | "active";
  canEdit: boolean;
  skillCatalog: GoatSkillCatalogItem[];
}) {
  const router = useRouter();
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [instructions, setInstructions] = useState(workflow.instructions);
  const [model, setModel] = useState(workflow.model);
  const [status, setStatus] = useState<"draft" | "active">(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [isArchiving, startArchiving] = useTransition();

  const markDirty = () => {
    if (saved) setSaved(false);
    if (error) setError(null);
  };

  const save = () => {
    setError(null);
    startSaving(async () => {
      const result = await updateGoatWorkflowAction({
        slug: workflow.id,
        name,
        description,
        instructions,
        model,
        status,
      });
      if (result.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      setError(result.message);
    });
  };

  const archive = () => {
    setError(null);
    startArchiving(async () => {
      const result = await archiveGoatWorkflowAction({ slug: workflow.id });
      if (result.ok) {
        router.push("/workflows");
        return;
      }
      setError(result.message);
    });
  };

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[760px] flex-col gap-6 pb-24 pt-16 sm:pt-24">
          <BackLink href="/workflows" label="Workflows" />

          <header className="flex flex-col gap-1.5">
            <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-ink">
              {name.trim() || "Untitled workflow"}
            </h1>
            <p className="text-[12.5px] leading-5 text-ink-subtle">
              Fire this workflow with <span className="font-medium text-ink">#{workflow.id}</span>{" "}
              in chat.
            </p>
          </header>

          {canEdit ? null : (
            <p className="text-[13px] leading-5 text-ink-subtle">
              Only workspace admins can edit workflows.
            </p>
          )}

          <div className="flex flex-col gap-5">
            <EditorField label="Name">
              <input
                value={name}
                disabled={!canEdit}
                onChange={(event) => {
                  setName(event.target.value);
                  markDirty();
                }}
                className={EDITOR_INPUT_CLASS}
              />
            </EditorField>

            <EditorField label="Description">
              <input
                value={description}
                disabled={!canEdit}
                onChange={(event) => {
                  setDescription(event.target.value);
                  markDirty();
                }}
                placeholder="What this workflow does"
                className={EDITOR_INPUT_CLASS}
              />
            </EditorField>

            <EditorField label="Model">
              <select
                value={model}
                disabled={!canEdit}
                onChange={(event) => {
                  setModel(event.target.value);
                  markDirty();
                }}
                className={EDITOR_INPUT_CLASS}
              >
                <option value="">Default ({WORKFLOW_DEFAULT_MODEL_LABEL})</option>
                {GOAT_WORKFLOW_MODEL_OPTIONS.map((option) => (
                  <option key={option.token} value={option.token}>
                    {option.label}
                  </option>
                ))}
              </select>
            </EditorField>

            <EditorField label="Status">
              <WorkflowSkillStatusToggle
                value={status}
                disabled={!canEdit}
                onChange={(next) => {
                  setStatus(next);
                  markDirty();
                }}
              />
            </EditorField>

            <EditorField label="Instructions">
              <div
                className={`rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors focus-within:ring-1 focus-within:ring-ink/20 ${!canEdit ? "opacity-70" : ""}`}
              >
                <MarkdownGoatBrainEditor
                  content={instructions}
                  onChange={(value) => {
                    setInstructions(value);
                    markDirty();
                  }}
                  readOnly={!canEdit}
                  compact
                  placeholder="Describe step by step what this workflow should do when fired."
                  skillMentions={skillCatalog}
                />
              </div>
            </EditorField>
          </div>

          {error ? <div className="text-[12.5px] leading-5 text-warning">{error}</div> : null}

          {canEdit ? (
            <EditorActions
              onSave={save}
              onArchive={archive}
              isSaving={isSaving}
              isArchiving={isArchiving}
              saved={saved}
            />
          ) : null}

          {canEdit && skillCatalog.length > 0 ? (
            <p className="text-[12px] leading-5 text-ink-subtle">
              Type <span className="font-medium text-ink">@</span> in the instructions to mention a
              skill — it&apos;s resolved and included whenever this workflow runs.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}

// --- Tasks board -------------------------------------------------------------

const WORKFLOW_TASK_STATUS_DOT_CLASS: Record<GoatWorkflowTaskDisplayStatus, string> = {
  running: "bg-ink/40 animate-pulse",
  failed: "bg-danger",
  done: "bg-success",
  "needs-attention": "bg-warning",
};

export function GoatTasksBoardRoute() {
  const { tasks, featureFlags } = useGoatAppData();

  if (!featureFlags.taskSpawning) return <TasksDisabledRoute />;

  const activeTasks = tasks.filter((task) => !task.archivedAt);
  const inProgress = activeTasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  );
  const finished = activeTasks.filter(
    (task) => task.status !== "queued" && task.status !== "running",
  );

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[760px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <header className="flex flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Tasks
            </h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              Runs produced by firing workflows (<span className="font-medium text-ink">#</span> in
              chat) or scheduled routines.
            </p>
          </header>

          {activeTasks.length === 0 ? (
            <GoatEmptyState
              icon={ListTodo}
              title="No tasks yet"
              description="Fire a workflow with # in chat or set up a scheduled run — each run shows up here as a Task."
            />
          ) : (
            <div className="flex flex-col gap-8">
              {inProgress.length > 0 ? (
                <TaskBoardSection label="In progress" tasks={inProgress} />
              ) : null}
              {finished.length > 0 ? <TaskBoardSection label="Recent" tasks={finished} /> : null}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function TaskBoardSection({ label, tasks }: { label: string; tasks: GoatTaskView[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </h2>
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <GoatTaskBoardRow task={task} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoatTaskBoardRow({ task }: { task: GoatTaskView }) {
  const displayStatus = goatWorkflowTaskDisplayStatus(task);
  return (
    <Link
      href={`/tasks/${encodeURIComponent(task.displayId)}`}
      prefetch
      className="group flex items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span
        aria-hidden="true"
        className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${WORKFLOW_TASK_STATUS_DOT_CLASS[displayStatus]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium leading-tight text-ink">
          {toGoatTaskTitle(task.name)}
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-ink-subtle">
          {task.outcomeComment?.trim() || GOAT_WORKFLOW_TASK_STATUS_COPY[displayStatus]}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-[11.5px] leading-4 text-ink-subtle">
        {formatGoatRelativeTime(task.updatedAt)}
      </span>
    </Link>
  );
}

// --- Skills (settings) -------------------------------------------------------

export function GoatSkillsSettingsRoute({
  skills,
  canEdit,
}: {
  skills: GoatSkillListItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <GoatSettingsContent
      title="Skills"
      description="Reusable capabilities the agent applies when you attach them with @skill in chat."
    >
      {canEdit ? (
        <div className="-mt-2 flex">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={14} strokeWidth={2} />
            New skill
          </button>
        </div>
      ) : null}

      {skills.length === 0 ? (
        <GoatEmptyState
          icon={Sparkles}
          title="No skills yet"
          description={
            canEdit
              ? "Create a skill to give the agent a reusable capability. Attach it with @skill in chat."
              : "Skills are reusable capabilities your workspace admins set up. Attach one with @skill in chat."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.slug}>
              <SkillListRow skill={skill} />
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <NewItemDialog
          title="New skill"
          namePlaceholder="Draft a customer reply"
          descriptionPlaceholder="What this skill does"
          submitLabel="Create skill"
          create={createGoatSkillAction}
          onClose={() => setCreating(false)}
          onCreated={(slug) => router.push(`/settings/skills/${encodeURIComponent(slug)}`)}
        />
      ) : null}
    </GoatSettingsContent>
  );
}

function SkillListRow({ skill }: { skill: GoatSkillListItem }) {
  return (
    <Link
      href={`/settings/skills/${encodeURIComponent(skill.slug)}`}
      prefetch
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-tight text-ink">
            {skill.name}
          </span>
          <ItemStatusBadge status={skill.status} />
        </span>
        {skill.description.trim() ? (
          <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-ink-subtle">
            {skill.description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px] leading-4 text-ink-subtle">
        {formatGoatRelativeTime(skill.updatedAt)}
      </span>
    </Link>
  );
}

export function GoatSkillEditorRoute({
  skill,
  initialStatus,
  canEdit,
}: {
  skill: GoatWorkspaceSkill;
  initialStatus: "draft" | "active";
  canEdit: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const [status, setStatus] = useState<"draft" | "active">(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [isArchiving, startArchiving] = useTransition();

  const markDirty = () => {
    if (saved) setSaved(false);
    if (error) setError(null);
  };

  const save = () => {
    setError(null);
    startSaving(async () => {
      const result = await updateGoatSkillAction({
        slug: skill.id,
        name,
        description,
        instructions,
        status,
      });
      if (result.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      setError(result.message);
    });
  };

  const archive = () => {
    setError(null);
    startArchiving(async () => {
      const result = await archiveGoatSkillAction({ slug: skill.id });
      if (result.ok) {
        router.push("/settings/skills");
        return;
      }
      setError(result.message);
    });
  };

  return (
    <GoatSettingsContent
      title={name.trim() || "Untitled skill"}
      description={`Attach this skill with @skill/${skill.id} in chat.`}
      backLink={{ href: "/settings/skills", label: "Skills" }}
    >
      {canEdit ? null : (
        <p className="text-[13px] leading-5 text-ink-subtle">
          Only workspace admins can edit skills.
        </p>
      )}

      <div className="flex flex-col gap-5">
        <EditorField label="Name">
          <input
            value={name}
            disabled={!canEdit}
            onChange={(event) => {
              setName(event.target.value);
              markDirty();
            }}
            className={EDITOR_INPUT_CLASS}
          />
        </EditorField>

        <EditorField label="Description">
          <input
            value={description}
            disabled={!canEdit}
            onChange={(event) => {
              setDescription(event.target.value);
              markDirty();
            }}
            placeholder="What this skill does"
            className={EDITOR_INPUT_CLASS}
          />
        </EditorField>

        <EditorField label="Status">
          <WorkflowSkillStatusToggle
            value={status}
            disabled={!canEdit}
            onChange={(next) => {
              setStatus(next);
              markDirty();
            }}
          />
        </EditorField>

        <EditorField label="Instructions">
          <div
            className={`rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors focus-within:ring-1 focus-within:ring-ink/20 ${!canEdit ? "opacity-70" : ""}`}
          >
            <MarkdownGoatBrainEditor
              content={instructions}
              onChange={(value) => {
                setInstructions(value);
                markDirty();
              }}
              readOnly={!canEdit}
              compact
              placeholder="Describe the capability this skill gives the agent."
            />
          </div>
        </EditorField>
      </div>

      {error ? <div className="text-[12.5px] leading-5 text-warning">{error}</div> : null}

      {canEdit ? (
        <EditorActions
          onSave={save}
          onArchive={archive}
          isSaving={isSaving}
          isArchiving={isArchiving}
          saved={saved}
        />
      ) : null}
    </GoatSettingsContent>
  );
}

// --- Shared authoring UI -----------------------------------------------------

const EDITOR_INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70";

function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </span>
      {children}
    </div>
  );
}

function EditorActions({
  onSave,
  onArchive,
  isSaving,
  isArchiving,
  saved,
}: {
  onSave: () => void;
  onArchive: () => void;
  isSaving: boolean;
  isArchiving: boolean;
  saved: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onSave}
        disabled={isSaving}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-ink bg-ink px-4 text-[13px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSaving ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : null}
        Save
      </button>
      {saved && !isSaving ? (
        <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-success">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      ) : null}
      <button
        type="button"
        onClick={onArchive}
        disabled={isArchiving}
        className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isArchiving ? (
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
        ) : (
          <Archive size={14} strokeWidth={1.9} />
        )}
        Archive
      </button>
    </div>
  );
}

function WorkflowSkillStatusToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: "draft" | "active";
  onChange: (next: "draft" | "active") => void;
  disabled?: boolean;
}) {
  const options: Array<{ value: "draft" | "active"; label: string }> = [
    { value: "draft", label: "Draft" },
    { value: "active", label: "Active" },
  ];
  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1"
      role="radiogroup"
      aria-label="Status"
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-7 items-center rounded-md px-3 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-70 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ItemStatusBadge({ status }: { status: "draft" | "active" }) {
  if (status === "active") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-px text-[10.5px] font-medium leading-4 text-success">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      Draft
    </span>
  );
}

function GoatEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
        <p className="mx-auto max-w-[380px] text-[12.5px] leading-5 text-ink-subtle">
          {description}
        </p>
      </div>
    </div>
  );
}

function NewItemDialog({
  title,
  namePlaceholder,
  descriptionPlaceholder,
  submitLabel,
  create,
  onClose,
  onCreated,
}: {
  title: string;
  namePlaceholder: string;
  descriptionPlaceholder: string;
  submitLabel: string;
  create: (input: {
    name: string;
    description?: string;
  }) => Promise<{ ok: true; slug: string } | { ok: false; message: string }>;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name cannot be empty.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await create({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (result.ok) {
        onCreated(result.slug);
        return;
      }
      setError(result.message);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[420px] rounded-xl border border-border bg-surface p-5 shadow-[0_12px_32px_rgba(15,15,15,0.18)]"
      >
        <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Name</span>
            {/* biome-ignore lint/a11y/noAutofocus: focus the first field when the dialog opens */}
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={namePlaceholder}
              className="h-9 rounded-md border border-border bg-canvas px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">
              Description <span className="text-ink-faint">(optional)</span>
            </span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={descriptionPlaceholder}
              className="h-9 rounded-md border border-border bg-canvas px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>
          {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink bg-ink px-3 text-[13px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatGoatRelativeTime(value: Date | string) {
  const timestamp = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 30_000) return "just now";
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}
