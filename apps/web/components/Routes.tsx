"use client";

import type {
  LegacyTaskHistoryDto,
  LegacyTaskHistoryEventDto,
  LegacyTaskHistoryMessageDto,
  SkillBundleFileMetadataDto,
  SkillImportCandidateDto,
  SkillImportFileMetadataDto,
  SkillImportWarningDto,
  SkillInstallationDto,
  SkillListItemDto,
  SkillSourceDto,
} from "@opencompany/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeft,
  CalendarClock,
  CircleUserRound,
  ExternalLink,
  Link2,
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
import { type BrainSummaryView, useAppData } from "@/components/AppDataProvider";
import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { BrainSettings } from "@/components/BrainSettings";
import { BrainView } from "@/components/BrainView";
import { FathomIntegrationSetup } from "@/components/FathomIntegrationSetup";
import { GranolaIntegrationSetup } from "@/components/GranolaIntegrationSetup";
import { InferenceSettingsPanel } from "@/components/InferenceSettingsPanel";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { McpSetupGuide } from "@/components/McpSetupGuide";
import { RepositorySettings } from "@/components/RepositorySettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { SettingsIntegrationsPanel } from "@/components/SettingsIntegrationsPanel";
import { Surface } from "@/components/Surface";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { useHydrated } from "@/components/useHydrated";
import type { ChatSessionView } from "@/lib/chat-ui";
import { getHeadlessWorkflows } from "@/lib/headless-automation-collections";
import { createHeadlessWorkflow } from "@/lib/headless-automation-commands";
import type { WorkflowListItem } from "@/lib/headless-automation-types";
import {
  archiveHeadlessSkill,
  createHeadlessWorkspaceSkill,
  disableHeadlessSkill,
  enableHeadlessSkill,
  importHeadlessSkill,
  previewHeadlessSkillImport,
  replaceHeadlessSkill,
  updateHeadlessWorkspaceSkill,
} from "@/lib/headless-knowledge-commands";
import type { BrainOverviewStats, BrainSnapshot } from "@/lib/headless-knowledge-types";
import { legacyTaskDtoToRow, taskReadModelToRow } from "@/lib/headless-task-collections";
import { getHeadlessTask, getLegacyTaskCompatibilityHistory } from "@/lib/headless-task-commands";
import type { IntegrationState } from "@/lib/integration-state";
import { DEFAULT_MODEL } from "@/lib/model-options";
import type { RepoConfigView, WorkspaceRepository } from "@/lib/repo-config-actions";
import { buildHarnessRun, type HarnessRunViewModel } from "@/lib/task-harness-run";
import { updateAutoModelRoutingAction, updateTaskSpawningAction } from "@/lib/user-preferences";

export function HomeRoute({
  chatId,
  initialChat: routeInitialChat = null,
}: {
  chatId: string | null;
  initialChat?: ChatSessionView | null;
}) {
  const data = useAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
  const initialChat = useMemo(() => {
    if (!chatId) return null;
    if (routeInitialChat?.id === chatId) return routeInitialChat;
    const summary = data.recentChats.find((chat) => chat.id === chatId);
    if (!summary?.engine) return null;
    return {
      id: chatId,
      title: summary.title,
      model: summary.model,
      engine: summary.engine,
      codexComposerSettings: summary.codexComposerSettings ?? null,
      // Sidebar summaries can bridge navigation metadata, but detail controls wait for the
      // conversation-scoped REST/Electric record instead of trusting a list row.
      runtime: null,
      ...(summary.activityState ? { activityState: summary.activityState } : {}),
      ...(summary.hasUnseen !== undefined ? { hasUnseen: summary.hasUnseen } : {}),
      updatedAt: summary.updatedAt,
      messages: [],
    };
  }, [chatId, data.recentChats, routeInitialChat]);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <Surface
        key={data.activeBrain?.id ?? "no-brain"}
        tasks={data.tasks}
        allTasks={data.allTasks}
        schedules={data.schedules}
        defaultModel={DEFAULT_MODEL}
        initialChat={initialChat}
        recentChats={data.recentChats}
        archivedChats={data.archivedChats}
        codexConnected={data.codexConnected}
        claudeCodeConnected={data.claudeCodeConnected}
        taskSpawningEnabled={data.featureFlags.taskSpawning}
        autoModelRoutingEnabled={data.featureFlags.autoModelRouting}
        workspaceId={data.workspace.id}
        userName={userName}
        userWorkosId={data.user.workosUserId}
      />
    </main>
  );
}

export function SettingsRoute() {
  const { user } = useAppData();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);

  return (
    <SettingsContent title="Account" description="Your personal profile for this workspace.">
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
    </SettingsContent>
  );
}

export function IntegrationsSettingsRoute({
  browserProfilesEnabled = false,
}: {
  browserProfilesEnabled?: boolean;
}) {
  const { integrations, workspace } = useAppData();

  return (
    <SettingsContent
      title="Integrations"
      description="Connect the tools opencompany can read from and act on."
    >
      <IntegrationRows
        integrations={integrations}
        isWorkspaceAdmin={workspace.role === "admin"}
        workspaceId={workspace.id}
        browserProfilesEnabled={browserProfilesEnabled}
      />
    </SettingsContent>
  );
}

export function InferenceSettingsRoute() {
  const { integrations, workspace } = useAppData();

  return (
    <SettingsContent
      title="Inference"
      description="Connect model subscriptions and choose how your workspace runs AI."
    >
      <InferenceSettingsPanel
        codex={integrations.codex}
        claudeCode={integrations.claude_code}
        canManage={workspace.role === "admin"}
      />
    </SettingsContent>
  );
}

export function McpSettingsRoute() {
  const { mcpSetup, user, workspace } = useAppData();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Teammate";

  return (
    <SettingsContent
      title="MCP"
      description="Connect Claude, ChatGPT, or Cursor to everything you can access in opencompany."
    >
      <McpSetupGuide
        displayName={displayName}
        workspaceName={workspace.name}
        initialClient={mcpSetup.preferredClient}
        initialCompletedAt={mcpSetup.completedAt}
        hideHeader
      />
    </SettingsContent>
  );
}

export function PreferencesSettingsRoute() {
  const { featureFlags } = useAppData();

  return (
    <SettingsContent title="Preferences" description="Experimental features and app behavior.">
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
          label="Tasks & Workflows"
          description="Fire workflows, run tracked background tasks, and schedule recurring routines."
          checked={featureFlags.taskSpawning}
          update={updateTaskSpawningAction}
        />
        <BetaFeatureSwitch
          icon={Sparkles}
          label="Automatic model routing"
          description="Let opencompany choose a model from your first message and keep it for the chat."
          checked={featureFlags.autoModelRouting}
          update={updateAutoModelRoutingAction}
        />
      </section>
    </SettingsContent>
  );
}

export function RepositoriesSettingsRoute({
  repositories,
  configs,
  canEdit,
}: {
  repositories: WorkspaceRepository[];
  configs: RepoConfigView[];
  canEdit: boolean;
}) {
  return (
    <SettingsContent
      title="Repositories"
      description="Give coding agents the environment and setup steps they need for each repository."
    >
      <RepositorySettings
        initialRepositories={repositories}
        initialConfigs={configs}
        canEdit={canEdit}
      />
    </SettingsContent>
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

export function JamieSettingsRoute() {
  const { activeBrain, featureFlags, integrations, workspace } = useAppData();
  const brainSourcesHref =
    featureFlags.legacyBrain && activeBrain
      ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
      : null;

  return (
    <SettingsContent
      title="Jamie"
      description="Meeting notes for opencompany Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <JamieIntegrationSetup
        initialState={integrations.jamie}
        brainSourcesHref={brainSourcesHref}
        canManage={workspace.role === "admin"}
      />
    </SettingsContent>
  );
}

export function GranolaSettingsRoute() {
  const { activeBrain, featureFlags, integrations } = useAppData();
  const brainSourcesHref =
    featureFlags.legacyBrain && activeBrain
      ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
      : null;

  return (
    <SettingsContent
      title="Granola"
      description="Meeting notes for opencompany Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <GranolaIntegrationSetup
        initialState={integrations.granola}
        brainSourcesHref={brainSourcesHref}
      />
    </SettingsContent>
  );
}

export function FathomSettingsRoute() {
  const { activeBrain, featureFlags, integrations } = useAppData();
  const brainSourcesHref =
    featureFlags.legacyBrain && activeBrain
      ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
      : null;

  return (
    <SettingsContent
      title="Fathom"
      description="Meeting recordings for opencompany Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <FathomIntegrationSetup
        initialState={integrations.fathom}
        brainSourcesHref={brainSourcesHref}
      />
    </SettingsContent>
  );
}

export function AttioSettingsRoute() {
  const { activeBrain, featureFlags, integrations } = useAppData();
  const brainSourcesHref =
    featureFlags.legacyBrain && activeBrain
      ? `/brain/${encodeURIComponent(activeBrain.id)}/settings`
      : null;

  return (
    <SettingsContent
      title="Attio"
      description="CRM activity for opencompany Brain"
      backLink={{ href: "/settings/integrations", label: "Integrations" }}
    >
      <AttioIntegrationSetup
        initialState={integrations.attio}
        brainSourcesHref={brainSourcesHref}
      />
    </SettingsContent>
  );
}

export function BrainRoute({
  path,
  routeBrainId,
  selectedBrain,
  initialBrainSnapshot,
  initialOverviewStats,
}: {
  path: string[];
  routeBrainId: string | null;
  selectedBrain: BrainSummaryView | null;
  initialBrainSnapshot: BrainSnapshot | null;
  initialOverviewStats?: BrainOverviewStats | null;
}) {
  // "settings" is a reserved segment directly after an explicit brain id.
  if (routeBrainId && selectedBrain && path[0] === "settings") {
    return <BrainSettingsRoute brain={selectedBrain} />;
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
    <BrainView
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

function BrainSettingsRoute({ brain }: { brain: BrainSummaryView }) {
  const { workspace } = useAppData();

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[960px] flex-col gap-6 pb-24 pt-16 sm:pt-24">
          <BackLink href={`/brain/${encodeURIComponent(brain.id)}`} label={brain.name} />
          {workspace.role === "admin" ? (
            <BrainSettings brain={brain} workspace={workspace} />
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

export function TaskDetailRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);
  const { featureFlags } = useAppData();

  if (!featureFlags.taskSpawning) return <TasksWorkflowsDisabledRoute />;

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      {run ? <TaskDetailPanel initialRun={run} /> : <TaskRouteSkeleton label="Loading task" />}
    </main>
  );
}

function useTaskRun(taskId: string) {
  const { featureFlags, tasks, taskRows } = useAppData();
  const [serverState, setServerState] = useState<{
    taskId: string;
    run: HarnessRunViewModel | null;
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
    () => (liveTask ? buildHarnessRun({ task: liveTask, messages: [], events: [] }) : null),
    [liveTask],
  );

  useEffect(() => {
    if (!featureFlags.taskSpawning) return;
    const controller = new AbortController();
    void getHeadlessTask(taskId, {
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    })
      .then((task) => {
        if (task) {
          return buildHarnessRun({
            task: taskReadModelToRow(task),
            messages: [],
            events: [],
          });
        }
        return getLegacyTaskCompatibilityHistory(taskId, {
          fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
        }).then((history: LegacyTaskHistoryDto | null) => {
          if (!history) {
            setServerState({ taskId, run: null, notFound: true });
            return null;
          }
          return buildHarnessRun({
            task: legacyTaskDtoToRow(history.task),
            messages: history.messages.map((message: LegacyTaskHistoryMessageDto) => ({
              id: message.id,
              task_id: history.task.id,
              user_workos_id: "",
              role: message.role,
              status: message.status,
              content: message.content,
              model_message: null,
              tool_name: message.toolName,
              tool_call_id: message.toolCallId,
              response_to_message_id: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
              completed_at: message.completedAt,
            })),
            events: history.events.map((event: LegacyTaskHistoryEventDto) => ({
              id: event.id,
              task_id: history.task.id,
              user_workos_id: "",
              message_id: event.messageId,
              type: event.type,
              payload: event.payload,
              created_at: event.createdAt,
            })),
          });
        });
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

export function TasksWorkflowsDisabledRoute() {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-4 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Chat" />
          <h1 className="text-[24px] font-semibold leading-tight text-ink">
            Tasks &amp; Workflows is a beta feature
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Enable Tasks &amp; Workflows in Preferences to fire workflows, run background tasks, and
            set up recurring routines.
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
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  update: (enabled: boolean) => Promise<{ ok: boolean }>;
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
      </div>
    </div>
  );
}

function IntegrationRows({
  integrations,
  isWorkspaceAdmin,
  workspaceId,
  browserProfilesEnabled,
}: {
  integrations: IntegrationState;
  isWorkspaceAdmin: boolean;
  workspaceId: string;
  browserProfilesEnabled: boolean;
}) {
  return (
    <SettingsIntegrationsPanel
      initialIntegrations={integrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
      scopeKey={workspaceId}
      browserProfilesEnabled={browserProfilesEnabled}
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

export function WorkflowsRoute({
  workflows,
  workspaceId,
  canEdit,
}: {
  workflows: WorkflowListItem[];
  workspaceId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const hydrated = useHydrated();
  const workflowCollection = useMemo(
    () => (hydrated ? getHeadlessWorkflows(workspaceId) : null),
    [hydrated, workspaceId],
  );
  const { data: workflowRows, isLoading: workflowsLoading } = useLiveQuery(
    (q) => (workflowCollection ? q.from({ workflow: workflowCollection }) : undefined),
    [workflowCollection],
  );
  const visibleWorkflows = useMemo(
    () =>
      ((!hydrated || workflowsLoading ? workflows : (workflowRows ?? [])) as WorkflowListItem[])
        .filter((workflow) => !workflow.archivedAt)
        .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [hydrated, workflowRows, workflows, workflowsLoading],
  );

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

          {visibleWorkflows.length === 0 ? (
            <EmptyState
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
              {visibleWorkflows.map((workflow) => (
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
          create={async (input) => {
            const workflow = await createHeadlessWorkflow(input);
            return { ok: true, slug: workflow.slug };
          }}
          onClose={() => setCreating(false)}
          onCreated={(slug) => router.push(`/workflows/${encodeURIComponent(slug)}`)}
        />
      ) : null}
    </main>
  );
}

function WorkflowListRow({ workflow }: { workflow: WorkflowListItem }) {
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
        {workflow.trigger.type === "schedule" ? (
          <span className="mt-1 inline-flex max-w-full items-center gap-1.5 truncate text-[11.5px] leading-4 text-ink-subtle">
            <CalendarClock size={12} strokeWidth={1.8} className="shrink-0" />
            <span className="truncate">
              {workflow.trigger.cron} · {workflow.trigger.timezone}
            </span>
          </span>
        ) : null}
        {workflow.trigger.type === "event" ? (
          <span className="mt-1 inline-flex max-w-full items-center gap-1.5 truncate text-[11.5px] leading-4 text-ink-subtle">
            <span className="truncate">
              Linear · {workflow.trigger.team.key ?? workflow.trigger.team.name} enters triage
            </span>
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px] leading-4 text-ink-subtle">
        {formatRelativeTime(workflow.updatedAt)}
      </span>
    </Link>
  );
}

// --- Skills (settings) -------------------------------------------------------

export function SkillsSettingsRoute({
  skills,
  canEdit,
}: {
  skills: SkillListItemDto[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <SettingsContent
      title="Skills"
      description="Portable Agent Skills created in this workspace or installed from a public source."
    >
      {canEdit ? (
        <div className="-mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink bg-ink px-3 text-[13px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={14} strokeWidth={2} />
            New skill
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Link2 size={14} strokeWidth={2} />
            Import skill
          </button>
        </div>
      ) : null}

      {skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No skills yet"
          description={
            canEdit
              ? "Create a workspace Skill or import one from GitHub or skills.sh."
              : "Workspace admins can create and install Agent Skills."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.id}>
              <SkillListRow skill={skill} />
            </li>
          ))}
        </ul>
      )}

      {importing ? (
        <ImportSkillDialog
          onClose={() => setImporting(false)}
          onInstalled={(name) => router.push(`/settings/skills/${encodeURIComponent(name)}`)}
        />
      ) : null}
      {creating ? (
        <WorkspaceSkillDialog
          onClose={() => setCreating(false)}
          onSaved={(name) => router.push(`/settings/skills/${encodeURIComponent(name)}`)}
        />
      ) : null}
    </SettingsContent>
  );
}

function SkillListRow({ skill }: { skill: SkillListItemDto }) {
  return (
    <Link
      href={`/settings/skills/${encodeURIComponent(skill.name)}`}
      prefetch
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-tight text-ink">
            {skill.bundle.name}
          </span>
          <InstallationStatusBadge enabled={skill.enabled} />
          {skill.bundle.source.type === "workspace" ? <WorkspaceBadge /> : <ImportedBadge />}
        </span>
        {skill.bundle.description.trim() ? (
          <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-ink-subtle">
            {skill.bundle.description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px] leading-4 text-ink-subtle">
        {formatRelativeTime(skill.updatedAt)}
      </span>
    </Link>
  );
}

export function SkillBundleRoute({
  installation,
  canEdit,
}: {
  installation: SkillInstallationDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [isMutating, startMutation] = useTransition();
  const bundle = installation.bundle;

  const setEnabled = (enabled: boolean) => {
    setError(null);
    startMutation(async () => {
      try {
        if (enabled) await enableHeadlessSkill(installation.name);
        else await disableHeadlessSkill(installation.name);
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  const archive = () => {
    setError(null);
    startMutation(async () => {
      try {
        await archiveHeadlessSkill(installation.name);
        router.push("/settings/skills");
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  return (
    <SettingsContent
      title={bundle.name}
      description={`Invoke this immutable bundle with /${installation.name} in chat.`}
      backLink={{ href: "/settings/skills", label: "Skills" }}
    >
      <SkillSourceNotice source={bundle.source} />
      {!canEdit ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          Only workspace admins can manage skill installations.
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        <EditorField label="Status">
          <div className="flex items-center gap-2">
            <InstallationStatusBadge enabled={installation.enabled} />
            <span className="font-mono text-[11.5px] text-ink-subtle">{bundle.integrity}</span>
          </div>
        </EditorField>

        <EditorField label="Description">
          <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px] leading-5 text-ink">
            {bundle.description}
          </div>
        </EditorField>

        <EditorField label="Instructions">
          <div className="max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink">
            {bundle.body || <span className="text-ink-subtle">No Markdown body.</span>}
          </div>
        </EditorField>

        <EditorField label={`Bundle files (${bundle.files.length})`}>
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {bundle.files.map((file: SkillBundleFileMetadataDto) => (
              <li
                key={file.path}
                className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                  {file.path}
                </span>
                {file.executable ? (
                  <span className="text-[11px] text-ink-subtle">executable</span>
                ) : null}
                <span className="shrink-0 text-[11.5px] text-ink-subtle">
                  {formatBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </EditorField>
      </div>

      {error ? <div className="text-[12.5px] leading-5 text-warning">{error}</div> : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={isMutating}
            onClick={() => setEnabled(!installation.enabled)}
            className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60"
          >
            {installation.enabled ? "Disable" : "Enable"}
          </button>
          {bundle.source.type === "workspace" ? (
            <button
              type="button"
              disabled={isMutating}
              onClick={() => setEditing(true)}
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              Edit skill
            </button>
          ) : (
            <button
              type="button"
              disabled={isMutating}
              onClick={() => setReplacing(true)}
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              Replace bundle
            </button>
          )}
          <button
            type="button"
            disabled={isMutating}
            onClick={archive}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            {isMutating ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
            Archive
          </button>
        </div>
      ) : null}

      {replacing ? (
        <ImportSkillDialog
          replaceName={installation.name}
          initialUrl={skillSourceInput(bundle.source, bundle.name)}
          initialSelectedPath={bundle.source.path}
          onClose={() => setReplacing(false)}
          onInstalled={() => {
            setReplacing(false);
            router.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <WorkspaceSkillDialog
          skillName={installation.name}
          initialDescription={bundle.description}
          initialInstructions={bundle.body}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      ) : null}
    </SettingsContent>
  );
}

function SkillSourceNotice({ source }: { source: SkillSourceDto }) {
  if (source.type === "workspace") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-5 text-ink-subtle">
        <Sparkles size={14} strokeWidth={2} className="shrink-0" />
        Created in this workspace. Each save creates a new immutable standard Skill bundle.
      </div>
    );
  }
  const shortCommit = source.resolvedCommit ? source.resolvedCommit.slice(0, 7) : null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-5 text-ink-subtle">
      <Link2 size={14} strokeWidth={2} className="shrink-0" />
      <span className="min-w-0 flex-1">
        Imported from{" "}
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 font-medium text-ink underline decoration-border underline-offset-2 hover:decoration-ink"
        >
          {source.url.replace(/^https:\/\//, "")}
          <ExternalLink size={11} strokeWidth={2} />
        </a>
        {shortCommit ? ` · ${shortCommit}` : ""}. Bundles are immutable; replace the installation to
        pick up source changes.
      </span>
    </div>
  );
}

function InstallationStatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-px text-[10.5px] font-medium leading-4 text-success">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
      Enabled
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      Disabled
    </span>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
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

function ImportedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      <Link2 size={10} strokeWidth={2} />
      Imported
    </span>
  );
}

function WorkspaceBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      <Sparkles size={10} strokeWidth={2} />
      Workspace
    </span>
  );
}

export function EmptyState({
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
      try {
        const result = await create({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        if (result.ok) {
          onCreated(result.slug);
          return;
        }
        setError(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not create this item.");
      }
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
        className="shadow-ring-xl relative w-full max-w-[420px] rounded-xl bg-surface p-5"
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

type ImportPreviewState = {
  name: string;
  description: string;
  files: SkillImportFileMetadataDto[];
  totalBytes: number;
  resolvedCommit: string;
  integrity: string;
  warnings: SkillImportWarningDto[];
};

function WorkspaceSkillDialog({
  onClose,
  onSaved,
  skillName,
  initialDescription = "",
  initialInstructions = "",
}: {
  onClose: () => void;
  onSaved: (name: string) => void;
  skillName?: string;
  initialDescription?: string;
  initialInstructions?: string;
}) {
  const [name, setName] = useState(skillName ?? "");
  const [description, setDescription] = useState(initialDescription);
  const [instructions, setInstructions] = useState(initialInstructions.trim());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const editing = skillName !== undefined;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const normalizedName = name.trim();
    const normalizedDescription = description.trim();
    const normalizedInstructions = instructions.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalizedName)) {
      setError("Use lowercase letters, numbers, and single hyphens for the skill name.");
      return;
    }
    if (!normalizedDescription) {
      setError("Describe what the skill does and when to use it.");
      return;
    }
    if (!normalizedInstructions) {
      setError("Add instructions for the agent.");
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        if (editing) {
          await updateHeadlessWorkspaceSkill(skillName, {
            description: normalizedDescription,
            instructions: normalizedInstructions,
          });
        } else {
          await createHeadlessWorkspaceSkill({
            name: normalizedName,
            description: normalizedDescription,
            instructions: normalizedInstructions,
          });
        }
        onSaved(normalizedName);
      } catch (cause) {
        setError(errorMessage(cause));
      }
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
        aria-label={editing ? "Edit skill" : "New skill"}
        className="shadow-ring-xl relative flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl bg-surface p-5"
      >
        <h2 className="text-[15px] font-semibold leading-tight text-ink">
          {editing ? "Edit skill" : "New skill"}
        </h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
          Creates a portable Agent Skills SKILL.md. Saving an edit publishes a new immutable bundle.
        </p>
        <div className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Name</span>
            <input
              autoFocus={!editing}
              value={name}
              disabled={editing || isSaving}
              onChange={(event) => {
                setName(event.target.value.toLowerCase().replace(/\s+/gu, "-"));
                if (error) setError(null);
              }}
              placeholder="investigate-bug"
              className={EDITOR_INPUT_CLASS}
            />
            <span className="text-[11.5px] text-ink-subtle">
              Command: <span className="font-mono text-ink">/{name || "skill-name"}</span>
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Description</span>
            <textarea
              value={description}
              disabled={isSaving}
              onChange={(event) => {
                setDescription(event.target.value);
                if (error) setError(null);
              }}
              placeholder="What this skill does and when the agent should use it"
              rows={3}
              className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
            />
          </label>
          <label className="flex min-h-0 flex-1 flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Instructions</span>
            <textarea
              value={instructions}
              disabled={isSaving}
              onChange={(event) => {
                setInstructions(event.target.value);
                if (error) setError(null);
              }}
              placeholder="Write the operating instructions the agent should follow..."
              rows={12}
              className="min-h-52 w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
            />
          </label>
          {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isSaving}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink bg-ink px-3 text-[13px] font-medium text-canvas transition-colors hover:bg-ink/90 disabled:opacity-60"
          >
            {isSaving ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
            {editing ? "Save new version" : "Create skill"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportSkillDialog({
  onClose,
  onInstalled,
  replaceName,
  initialUrl = "",
  initialSelectedPath,
}: {
  onClose: () => void;
  onInstalled: (name: string) => void;
  replaceName?: string;
  initialUrl?: string;
  initialSelectedPath?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialSelectedPath);
  const [candidates, setCandidates] = useState<SkillImportCandidateDto[] | null>(null);
  const [preview, setPreview] = useState<ImportPreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isResolving, startResolving] = useTransition();
  const [isImporting, startImporting] = useTransition();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolve = (path?: string) => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Provide a GitHub or skills.sh URL.");
      return;
    }
    setError(null);
    startResolving(async () => {
      try {
        const result = await previewHeadlessSkillImport({
          url: trimmed,
          ...(path !== undefined ? { selectedPath: path } : {}),
        });
        if (result.status === "ambiguous") {
          setCandidates(result.candidates);
          setPreview(null);
          return;
        }
        if (replaceName && result.name !== replaceName) {
          setError(
            `Replacement skill name must remain ${replaceName}. Artifacts are never renamed.`,
          );
          setCandidates(null);
          setPreview(null);
          return;
        }
        setCandidates(null);
        setPreview({
          name: result.name,
          description: result.description,
          files: result.files,
          totalBytes: result.totalBytes,
          resolvedCommit: result.source.resolvedCommit,
          integrity: result.integrity,
          warnings: result.warnings,
        });
      } catch (cause) {
        setError(errorMessage(cause));
        setCandidates(null);
        setPreview(null);
      }
    });
  };

  const confirmInstall = () => {
    const trimmed = url.trim();
    if (!trimmed || !preview) return;
    const confirmedPreview = preview;
    setError(null);
    startImporting(async () => {
      try {
        const command = {
          url: trimmed,
          ...(selectedPath !== undefined ? { selectedPath } : {}),
          expectedResolvedCommit: confirmedPreview.resolvedCommit,
          expectedIntegrity: confirmedPreview.integrity,
        };
        if (replaceName) {
          const result = await replaceHeadlessSkill(replaceName, command);
          onInstalled(result.name);
        } else {
          const result = await importHeadlessSkill(command);
          onInstalled(result.installation.name);
        }
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  const pending = isResolving || isImporting;

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
        aria-label={replaceName ? "Replace a skill" : "Import a skill"}
        className="shadow-ring-xl relative flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl bg-surface p-5"
      >
        <h2 className="text-[15px] font-semibold leading-tight text-ink">
          {replaceName ? "Replace skill bundle" : "Import a skill"}
        </h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
          Preview a public GitHub or skills.sh source, then install the exact resolved commit and
          integrity. Preview never returns file contents.
        </p>

        <div className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">URL</span>
            <div className="flex gap-2">
              {/* biome-ignore lint/a11y/noAutofocus: focus the URL field when the dialog opens */}
              <input
                autoFocus
                value={url}
                disabled={pending}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setSelectedPath(undefined);
                  setCandidates(null);
                  setPreview(null);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    resolve(selectedPath);
                  }
                }}
                placeholder="github.com/owner/repo"
                className="h-9 flex-1 rounded-md border border-border bg-canvas px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20"
              />
              <button
                type="button"
                onClick={() => resolve(selectedPath)}
                disabled={pending}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isResolving ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : null}
                Preview
              </button>
            </div>
          </label>

          {error ? <div className="text-[12.5px] leading-5 text-warning">{error}</div> : null}

          {candidates ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-subtle">
                This repository has multiple skills — pick one
              </span>
              <ul className="flex flex-col gap-1.5">
                {candidates.map((candidate) => (
                  <li key={candidate.path}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPath(candidate.path);
                        resolve(candidate.path);
                      }}
                      disabled={pending}
                      className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-left transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="block text-[13px] font-medium leading-tight text-ink">
                        {candidate.name}
                      </span>
                      {candidate.description.trim() ? (
                        <span className="mt-0.5 block text-[12px] leading-4 text-ink-subtle">
                          {candidate.description}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview ? (
            <div className="flex flex-col gap-3">
              {preview.warnings.map((warning) => (
                <div
                  key={warning.code}
                  className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] leading-5 text-warning"
                >
                  {warning.message}
                </div>
              ))}
              <EditorField label="Name">
                <div className={`${EDITOR_INPUT_CLASS} flex items-center opacity-70`}>
                  {preview.name}
                </div>
              </EditorField>
              {preview.description.trim() ? (
                <EditorField label="Description">
                  <div className={`${EDITOR_INPUT_CLASS} flex items-center opacity-70`}>
                    {preview.description}
                  </div>
                </EditorField>
              ) : null}
              <EditorField label={`Bundle files (${preview.files.length})`}>
                <ul className="max-h-[220px] overflow-y-auto rounded-lg border border-border bg-canvas">
                  {preview.files.map((file) => (
                    <li
                      key={file.path}
                      className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                        {file.path}
                      </span>
                      <span className="text-[11.5px] text-ink-subtle">
                        {formatBytes(file.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </EditorField>
              <p className="text-[11.5px] text-ink-subtle">
                {formatBytes(preview.totalBytes)} total · {preview.integrity}
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Cancel
          </button>
          {preview ? (
            <button
              type="button"
              onClick={confirmInstall}
              disabled={pending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink bg-ink px-3 text-[13px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isImporting ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
              {replaceName ? "Replace bundle" : "Install skill"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function skillSourceInput(source: SkillSourceDto, name: string) {
  if (source.type === "workspace") return "";
  const refSuffix = source.ref ? `#${source.ref}` : "";
  if (source.type === "skills.sh") {
    const repository = source.url.replace(/^https:\/\/github\.com\//u, "");
    return `https://skills.sh/${repository}/${name}${refSuffix}`;
  }
  return `${source.url}${refSuffix}`;
}

export function formatRelativeTime(value: Date | string) {
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
