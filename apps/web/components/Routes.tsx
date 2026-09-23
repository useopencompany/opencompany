"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import type {
  SkillBundleFileMetadataDto,
  SkillImportCandidateDto,
  SkillImportFileMetadataDto,
  SkillImportWarningDto,
  SkillInstallationDto,
  SkillListItemDto,
  SkillSourceDto,
} from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { FilterPills } from "@opencompany/ui/components/filter-pills";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeft,
  Bot,
  CalendarClock,
  CircleUserRound,
  ExternalLink,
  FolderOpen,
  Inbox,
  Link2,
  Loader2,
  Mail,
  Monitor,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useOptimistic,
  useState,
  useTransition,
} from "react";
import { useAppData } from "@/components/AppDataProvider";
import { BrowserProfilesSettings } from "@/components/BrowserProfilesSettings";
import { ChatPaneCanvas } from "@/components/chat-panes/ChatPaneCanvas";
import { FathomIntegrationSetup } from "@/components/FathomIntegrationSetup";
import { InferenceSettingsPanel } from "@/components/InferenceSettingsPanel";
import { IntentPrefetchLink } from "@/components/IntentPrefetchLink";
import { McpSetupGuide } from "@/components/McpSetupGuide";
import { ModelProviderIcon } from "@/components/ModelProviderIcon";
import { PageContent } from "@/components/PageContent";
import { RepositorySettings } from "@/components/RepositorySettings";
import {
  SandboxSettingsPanel,
  type SandboxSizeOptionView,
} from "@/components/SandboxSettingsPanel";
import {
  SCOPE_FILTERS,
  ScopeBadge,
  ScopeField,
  type ScopeFilter,
  ScopeFilterTabs,
  type Scope as SkillScope,
} from "@/components/ScopeControls";
import { StatusDot } from "@/components/StatusDot";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { useHydrated } from "@/components/useHydrated";
import { useTaskRun } from "@/components/useTaskRun";
import { useTaskSeenAcknowledgement } from "@/components/useTaskSeenAcknowledgement";
import { WorkflowTemplatesButton } from "@/components/WorkflowTemplatesButton";
import type { ChatSessionView } from "@/lib/chat-ui";
import { getHeadlessWorkflows } from "@/lib/headless-automation-collections";
import {
  archiveHeadlessWorkflow,
  createHeadlessWorkflow,
} from "@/lib/headless-automation-commands";
import type { WorkflowListItem } from "@/lib/headless-automation-types";
import {
  archiveHeadlessSkill,
  createHeadlessWorkspaceSkill,
  disableHeadlessSkill,
  enableHeadlessSkill,
  importHeadlessSkill,
  previewHeadlessSkillImport,
  replaceHeadlessSkill,
  setHeadlessSkillScope,
  updateHeadlessWorkspaceSkill,
} from "@/lib/headless-knowledge-commands";
import type { RepoConfigView, WorkspaceRepository } from "@/lib/repo-config-actions";
import type { WorkspaceSandboxSizeResult } from "@/lib/sandbox-size";
import {
  updateApproveForMeAction,
  updateAutoModelRoutingAction,
  updateBotsAction,
  updateCompanyAgentsAction,
  updateImessageAction,
  updatePastSessionAccessAction,
  updateReviewInboxAction,
  updateSidebarProjectsAction,
  updateSubagentsAction,
  updateWhatsappAction,
} from "@/lib/user-preferences";
import { DEFAULT_WORKFLOW_MODEL_TOKEN, WORKFLOW_MODEL_OPTIONS } from "@/lib/workflow-model-options";
import type { WorkflowTemplateMissingPlugin } from "@/lib/workflow-templates";

export function HomeRoute({
  chatId,
  projectId = null,
  projectName = null,
  initialChat: routeInitialChat = null,
}: {
  chatId: string | null;
  // Set when the reader started this chat from a sidebar Project row, so the Conversation the
  // first message creates is filed there.
  projectId?: string | null;
  // Resolved server-side for the project's new-chat screen; always paired with `projectId`.
  projectName?: string | null;
  initialChat?: ChatSessionView | null;
}) {
  const data = useAppData();
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
      {/* One pane renders exactly the chat surface this route always showed; the
          canvas only adds chrome once the reader opens a second chat beside it. */}
      <ChatPaneCanvas
        routeInitialChat={initialChat}
        newChatProjectId={projectId}
        newChatProjectName={projectName}
      />
    </main>
  );
}

export function SettingsRoute({
  browserProfilesEnabled = false,
}: {
  browserProfilesEnabled?: boolean;
}) {
  const { user } = useAppData();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);

  return (
    <PageContent title="Account" description="Your personal profile for this workspace.">
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

      {browserProfilesEnabled ? <BrowserProfilesSettings /> : null}
    </PageContent>
  );
}

export function InferenceSettingsRoute() {
  const { integrations, workspace } = useAppData();

  return (
    <PageContent
      title="Inference"
      description="Connect model subscriptions and choose how your workspace runs AI."
    >
      <InferenceSettingsPanel
        codex={integrations.codex}
        claudeCode={integrations.claude_code}
        canManage={workspace.role === "admin"}
      />
    </PageContent>
  );
}

export function SandboxSettingsRoute({
  sandboxSize,
  sandboxSizeOptions,
}: {
  sandboxSize: WorkspaceSandboxSizeResult;
  sandboxSizeOptions: SandboxSizeOptionView[];
}) {
  const { workspace } = useAppData();

  return (
    <PageContent
      title="Sandboxes"
      description="Control the machines your cloud coding sessions run on."
    >
      <SandboxSettingsPanel
        canManage={workspace.role === "admin"}
        sandboxSize={sandboxSize}
        sandboxSizeOptions={sandboxSizeOptions}
      />
    </PageContent>
  );
}

export function McpSettingsRoute() {
  const { mcpSetup, user, workspace } = useAppData();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Teammate";

  return (
    <PageContent
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
    </PageContent>
  );
}

export function PreferencesSettingsRoute() {
  const { featureFlags } = useAppData();

  return (
    <PageContent title="Preferences" description="Experimental features and app behavior.">
      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Permissions
        </h2>
        <BetaFeatureSwitch
          icon={ShieldCheck}
          label="Approve for me"
          description="Let AI approve low-risk plugin actions that help complete your chats and tasks. High-risk actions still ask you."
          checked={featureFlags.approveForMe === true}
          update={updateApproveForMeAction}
        />
      </section>

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
          icon={CalendarClock}
          label="Past session access"
          description="Let agents in private chats find and read your past chats in this workspace. Tasks and shared chats are excluded."
          checked={featureFlags.pastSessionAccess === true}
          update={updatePastSessionAccessAction}
        />
        <BetaFeatureSwitch
          icon={Bot}
          label="Bots"
          description="Create named bots for ongoing work and return to their conversations from the sidebar."
          checked={featureFlags.bots === true}
          update={updateBotsAction}
        />
        <BetaFeatureSwitch
          icon={Sparkles}
          label="Automatic model routing"
          description="Let opencompany choose a model from your first message and keep it for the chat."
          checked={featureFlags.autoModelRouting}
          update={updateAutoModelRoutingAction}
        />
        <BetaFeatureSwitch
          icon={Inbox}
          label="For review"
          description="Collect finished chats and tasks in one place, read them side by side, and archive them when you're done."
          checked={featureFlags.reviewInbox}
          update={updateReviewInboxAction}
        />
        <BetaFeatureSwitch
          icon={FolderOpen}
          label="Projects"
          description="Group chats and tasks into named folders in the sidebar, and start new chats inside one."
          checked={featureFlags.sidebarProjects}
          update={updateSidebarProjectsAction}
        />
        <BetaFeatureSwitch
          icon={Users}
          label="Subagents"
          description="Let opencompany hand wide research to helpers that work in their own context and report back, so one answer can cover several sources at once. Uses more credits per message."
          checked={featureFlags.subagents}
          update={updateSubagentsAction}
        />
        <BetaFeatureSwitch
          icon={Bot}
          label="Company agents"
          description="Give a recurring job to a named agent instead of a workflow. It has its own name and photo, an owner whose connected accounts it works with, and a run history the whole workspace can read."
          checked={featureFlags.companyAgents}
          update={updateCompanyAgentsAction}
        />
        <BetaFeatureSwitch
          icon={Smartphone}
          label="iMessage assistant"
          description="Text a personal assistant from your phone. Link your number under Channels → iMessage. It answers with web search, the Wiki, Skills and your connected plugins."
          checked={featureFlags.imessage}
          update={updateImessageAction}
        />
        <BetaFeatureSwitch
          icon={Smartphone}
          label="WhatsApp assistant"
          description="Text a personal assistant from a German or other EEA number. Link your number under Channels → WhatsApp. It answers with web search, the Wiki, Skills and your connected plugins."
          checked={featureFlags.whatsapp}
          update={updateWhatsappAction}
        />
      </section>
    </PageContent>
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
    <PageContent
      title="Repositories"
      description="Give coding agents the environment and setup steps they need for each repository."
    >
      <RepositorySettings
        initialRepositories={repositories}
        initialConfigs={configs}
        canEdit={canEdit}
      />
    </PageContent>
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

export function FathomIngestionRoute() {
  const { integrations } = useAppData();

  return (
    <PageContent
      title="Fathom"
      description="API-key connection for the Fathom plugin"
      backLink={{ href: "/plugins/fathom", label: "Fathom plugin" }}
    >
      <FathomIntegrationSetup initialState={integrations.fathom} />
    </PageContent>
  );
}

export function TaskDetailRoute({ taskId }: { taskId: string }) {
  const run = useTaskRun(taskId);
  // The route resolves a display id as well as a canonical id, so the acknowledgment keys off the
  // run's own identifier rather than the one in the URL.
  useTaskSeenAcknowledgement(run?.task.id ?? null);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      {run ? <TaskDetailPanel initialRun={run} /> : <TaskRouteSkeleton label="Loading task" />}
    </main>
  );
}

export function ReviewInboxDisabledRoute() {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-4 pb-24 pt-16 sm:pt-24">
          <BackLink href="/" label="Chat" />
          <h1 className="text-[24px] font-semibold leading-tight text-ink">
            For review is a beta feature
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Enable For review in Preferences to collect finished chats and tasks you haven&apos;t
            read yet in one place.
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
  const [optimisticChecked, setOptimisticChecked] = useOptimistic(checked);

  const toggle = () => {
    const nextEnabled = !optimisticChecked;
    setError(null);
    startTransition(async () => {
      setOptimisticChecked(nextEnabled);
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
            <span className="block text-[12px] leading-4 text-ink-subtle">{description}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={optimisticChecked}
            aria-label={label}
            disabled={isPending}
            onClick={toggle}
            className={`ml-auto inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60 ${
              optimisticChecked ? "border-ink bg-ink" : "border-border bg-surface-muted"
            }`}
          >
            <span
              className={`block h-4 w-4 rounded-full bg-canvas shadow-sm transition-transform duration-150 ${
                optimisticChecked ? "translate-x-[18px]" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
      </div>
    </div>
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

const WORKFLOW_RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export function WorkflowsRoute({
  workflows,
  workspaceId,
  canEdit,
  ownerNames,
  templateMissingPlugins,
}: {
  workflows: WorkflowListItem[];
  workspaceId: string;
  canEdit: boolean;
  /**
   * Creator WorkOS id to display name, so each row can name its owner without a client fetch.
   * `null` when the member list could not be loaded, which blanks the column instead of guessing.
   */
  ownerNames: Record<string, string> | null;
  /** Required plugins each template is still missing, keyed by template id; `null` hides the hints. */
  templateMissingPlugins: Record<string, WorkflowTemplateMissingPlugin[]> | null;
}) {
  const router = useRouter();
  const data = useAppData();
  const [creating, setCreating] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [workflowToDelete, setWorkflowToDelete] = useState<WorkflowListItem | null>(null);
  const [deletedWorkflowIds, setDeletedWorkflowIds] = useState<ReadonlySet<string>>(new Set());
  const [isDeleting, startDeleting] = useTransition();
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
        .filter((workflow) => !workflow.archivedAt && !deletedWorkflowIds.has(workflow.id))
        .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [deletedWorkflowIds, hydrated, workflowRows, workflows, workflowsLoading],
  );
  const runStats = useMemo(
    () => workflowRunStats(data.allTasks ?? data.tasks),
    [data.allTasks, data.tasks],
  );
  const scopedWorkflows = visibleWorkflows.filter(
    (workflow) => scopeFilter === "all" || workflow.scope === scopeFilter,
  );

  const deleteWorkflow = () => {
    if (!workflowToDelete || isDeleting) return;
    const workflow = workflowToDelete;
    startDeleting(async () => {
      try {
        await archiveHeadlessWorkflow(workflow.id, { expectedVersion: workflow.version });
        setDeletedWorkflowIds((current) => new Set(current).add(workflow.id));
        setWorkflowToDelete(null);
        toast.success(`Deleted “${workflow.name}”.`);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The workflow could not be deleted.");
      }
    });
  };

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[1040px] flex-col gap-8 pb-24 pt-10 sm:pt-12">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
                Workflows
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">
                Automations you fire with <span className="font-medium text-ink">#</span> in chat;
                each run becomes a Task. Keep one to yourself or share it with the company.
              </p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-2">
                <WorkflowTemplatesButton
                  missingPlugins={templateMissingPlugins}
                  scope={scopeFilter === "all" ? "company" : scopeFilter}
                />
                <Button size="sm" onClick={() => setCreating(true)} className="shadow-sm">
                  <Plus size={14} strokeWidth={2} />
                  New workflow
                </Button>
              </div>
            ) : null}
          </header>

          <section aria-labelledby="workflow-list-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="workflow-list-heading" className="sr-only">
              Workflow list
            </h2>
            <FilterPills
              label="Workflow scope"
              value={scopeFilter}
              onChange={setScopeFilter}
              options={SCOPE_FILTERS.map((filter) => ({
                value: filter.value,
                label: filter.label,
                count:
                  filter.value === "all"
                    ? visibleWorkflows.length
                    : visibleWorkflows.filter((workflow) => workflow.scope === filter.value).length,
              }))}
            />

            {scopedWorkflows.length === 0 ? (
              <EmptyState
                icon={Workflow}
                title={
                  scopeFilter === "all" ? "No workflows yet" : `No ${scopeFilter} workflows yet`
                }
                description={
                  canEdit
                    ? "Create a workflow to automate a recurring job. Fire it with # in chat, and each run shows up as a Task."
                    : "Workflows are automations your workspace admins set up. Fire one with # in chat and each run becomes a Task."
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-surface">
                <table className="w-full min-w-[820px] table-fixed text-left">
                  <caption className="sr-only">Workflows and recent run activity</caption>
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[15%]" />
                    <col className="w-[15%]" />
                    <col className="w-[19%]" />
                    <col className="w-[11%]" />
                    <col className="w-[14%]" />
                    <col className="w-12" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border-subtle text-[11.5px] font-medium text-ink-subtle">
                      <th scope="col" className="px-4 py-3 font-medium">
                        Name
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Owner
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Model
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Trigger
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Runs (30d)
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Last executed
                      </th>
                      <th scope="col" className="py-3 pr-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scopedWorkflows.map((workflow) => (
                      <WorkflowTableRow
                        key={workflow.id}
                        workflow={workflow}
                        stats={runStats.get(workflow.slug)}
                        ownerName={workflowOwnerName(workflow, ownerNames)}
                        canEdit={canEdit}
                        onDelete={() => setWorkflowToDelete(workflow)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      {creating ? (
        <NewItemDialog
          title="New workflow"
          namePlaceholder="Weekly investor update"
          descriptionPlaceholder="What this workflow does"
          submitLabel="Create workflow"
          initialScope={scopeFilter === "all" ? "company" : scopeFilter}
          scopeHint={(scope) =>
            scope === "personal"
              ? "Only you can see and run it"
              : "Everyone in the workspace can run and edit it"
          }
          create={async (input) => {
            const workflow = await createHeadlessWorkflow(input);
            return { ok: true, slug: workflow.slug };
          }}
          onClose={() => setCreating(false)}
          onCreated={(slug) => router.push(`/workflows/${encodeURIComponent(slug)}`)}
        />
      ) : null}

      <Dialog
        open={workflowToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setWorkflowToDelete(null);
        }}
      >
        <DialogContent className="max-w-[420px] gap-5">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Delete workflow?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              “{workflowToDelete?.name}” will be removed from the workflow list. Existing Task runs
              will stay in your history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={isDeleting}
              onClick={() => setWorkflowToDelete(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={isDeleting} onClick={deleteWorkflow}>
              {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function WorkflowTableRow({
  workflow,
  stats,
  ownerName,
  canEdit,
  onDelete,
}: {
  workflow: WorkflowListItem;
  stats: { runCount: number; lastExecutedAt: string } | undefined;
  ownerName: string;
  canEdit: boolean;
  onDelete: () => void;
}) {
  const model = workflowModelPresentation(workflow);
  const triggerLabel = workflowTriggerLabel(workflow);
  const statusLabel = workflow.status === "active" ? "Active" : "Draft";

  return (
    <tr className="group border-b border-border-subtle text-[13px] text-ink last:border-b-0 hover:bg-surface-hover/60">
      <td className="px-4 py-3.5">
        <IntentPrefetchLink
          href={`/workflows/${encodeURIComponent(workflow.slug)}`}
          className="flex min-w-0 items-center gap-2 rounded-sm font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <span
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
            className="inline-flex shrink-0 items-center"
          >
            <StatusDot status={workflow.status} />
          </span>
          <span className="truncate" title={workflow.name}>
            {workflow.name}
          </span>
        </IntentPrefetchLink>
      </td>
      <td className="truncate px-3 py-3.5 text-ink-muted" title={ownerName}>
        {ownerName}
      </td>
      <td className="px-3 py-3.5 text-ink-muted" title={model.label}>
        <span className="flex min-w-0 items-center gap-1.5">
          <ModelProviderIcon
            modelId={model.modelId}
            size={13}
            strokeWidth={1.9}
            className="shrink-0 text-ink-subtle"
          />
          <span className="truncate">{model.label}</span>
        </span>
      </td>
      <td className="truncate px-3 py-3.5 text-ink-muted" title={triggerLabel}>
        {triggerLabel}
      </td>
      <td className="px-3 py-3.5 tabular-nums text-ink-muted">{stats?.runCount ?? 0}</td>
      <td className="px-3 py-3.5 text-ink-muted">
        {stats ? formatRelativeTime(stats.lastExecutedAt) : "Never"}
      </td>
      <td className="py-2 pr-2 text-right">
        <WorkflowRowMenu workflow={workflow} canEdit={canEdit} onDelete={onDelete} />
      </td>
    </tr>
  );
}

function WorkflowRowMenu({
  workflow,
  canEdit,
  onDelete,
}: {
  workflow: WorkflowListItem;
  canEdit: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const href = `/workflows/${encodeURIComponent(workflow.slug)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Actions for ${workflow.name}`}
        className="inline-flex size-7 items-center justify-center rounded-md text-ink-subtle opacity-70 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink data-[popup-open]:opacity-100"
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[180px] bg-surface p-1 text-ink">
        <IntentPrefetchLink
          href={href}
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
        >
          <Pencil size={13} strokeWidth={1.9} />
          {canEdit ? "Edit details" : "View details"}
        </IntentPrefetchLink>
        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-danger transition-colors duration-150 hover:bg-danger/10 focus:outline-none focus-visible:bg-danger/10"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Delete
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// Workflows created before scopes carry no creator, and a creator who left the workspace is no
// longer in the member list. Both still need a readable owner cell.
function workflowOwnerName(workflow: WorkflowListItem, ownerNames: Record<string, string> | null) {
  if (!workflow.createdByUserId) return "Workspace";
  if (!ownerNames) return "—";
  return ownerNames[workflow.createdByUserId] ?? "Former member";
}

// The Model cell shows one model per workflow: its label plus the provider mark. Steps can each
// pick their own model, so a workflow that mixes them collapses to a count with no provider, and
// an empty `modelId` falls back to the generic sparkle so the column stays aligned.
function workflowModelPresentation(workflow: WorkflowListItem): {
  label: string;
  modelId: string;
} {
  const defaultOption = WORKFLOW_MODEL_OPTIONS.find(
    (option) => option.token === DEFAULT_WORKFLOW_MODEL_TOKEN,
  );
  const fallback = { label: defaultOption?.label ?? "Default", modelId: defaultOption?.id ?? "" };
  const models = new Map<string, string>();
  for (const step of workflow.steps) {
    const option = WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === step.model);
    if (option) models.set(option.label, option.id);
    else if (step.model.trim()) models.set(step.model.trim(), "");
    else models.set(fallback.label, fallback.modelId);
  }
  if (models.size === 0) return fallback;
  if (models.size === 1) {
    const [label, modelId] = Array.from(models)[0]!;
    return { label, modelId };
  }
  return { label: `${models.size} models`, modelId: "" };
}

function workflowTriggerLabel(workflow: WorkflowListItem) {
  const triggers = workflow.triggers?.length ? workflow.triggers : [workflow.trigger];
  const trigger = triggers[0];
  if (!trigger || trigger.type === "manual") return "Manual";
  const label =
    trigger.type === "schedule"
      ? scheduleSummary(trigger)
      : `${titleCaseToken(trigger.provider)} · ${titleCaseToken(trigger.event)}`;
  return triggers.length > 1 ? `${label} +${triggers.length - 1}` : label;
}

function titleCaseToken(value: string) {
  const words = value.trim().replace(/[._-]+/gu, " ");
  return words ? words.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) : "Event";
}

function workflowRunStats(
  tasks: readonly { workflowId?: string | null; createdAt: string }[],
  now = Date.now(),
) {
  const stats = new Map<string, { runCount: number; lastExecutedAt: string }>();
  const windowStart = now - WORKFLOW_RUN_WINDOW_MS;
  for (const task of tasks) {
    if (!task.workflowId) continue;
    const executedAt = new Date(task.createdAt).getTime();
    if (!Number.isFinite(executedAt)) continue;
    const current = stats.get(task.workflowId);
    const lastExecutedAt =
      !current || executedAt > new Date(current.lastExecutedAt).getTime()
        ? task.createdAt
        : current.lastExecutedAt;
    stats.set(task.workflowId, {
      runCount: (current?.runCount ?? 0) + (executedAt >= windowStart ? 1 : 0),
      lastExecutedAt,
    });
  }
  return stats;
}

// --- Skills (settings) -------------------------------------------------------

export function SkillsRoute({ skills, canEdit }: { skills: SkillListItemDto[]; canEdit: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const creationScope = scopeFilter === "company" ? "company" : "personal";
  const visibleSkills = skills.filter(
    (skill) => scopeFilter === "all" || skill.scope === scopeFilter,
  );

  return (
    <PageContent title="Skills">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeFilterTabs label="Skill scope" value={scopeFilter} onChange={setScopeFilter} />
        {canEdit ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImporting(true)}
              className="font-normal text-ink-muted hover:text-ink"
            >
              Import skill
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} />
              New {creationScope} skill
            </Button>
          </div>
        ) : null}
      </div>

      {visibleSkills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={scopeFilter === "all" ? "No skills yet" : `No ${scopeFilter} skills yet`}
          description={
            canEdit
              ? "Create a skill or import one to get started."
              : "Skills shared with you appear here."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleSkills.map((skill) => (
            <li key={skill.id}>
              <SkillListRow skill={skill} />
            </li>
          ))}
        </ul>
      )}

      {importing ? (
        <ImportSkillDialog
          initialScope={creationScope}
          onClose={() => setImporting(false)}
          onInstalled={(name) => router.push(`/skills/${encodeURIComponent(name)}`)}
        />
      ) : null}
      {creating ? (
        <WorkspaceSkillDialog
          initialScope={creationScope}
          onClose={() => setCreating(false)}
          onSaved={(name) => router.push(`/skills/${encodeURIComponent(name)}`)}
        />
      ) : null}
    </PageContent>
  );
}

function SkillListRow({ skill }: { skill: SkillListItemDto }) {
  return (
    <IntentPrefetchLink
      href={`/skills/${encodeURIComponent(skill.id)}`}
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-tight text-ink">
            {skill.bundle.name}
          </span>
          <SkillScopeBadge scope={skill.scope} />
          <InstallationStatusBadge enabled={skill.enabled} />
          {skill.bundle.source.type !== "workspace" ? <ImportedBadge /> : null}
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
    </IntentPrefetchLink>
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
  const [replacing, setReplacing] = useState(false);
  const [isMutating, startMutation] = useTransition();
  const bundle = installation.bundle;

  const setEnabled = (enabled: boolean) => {
    setError(null);
    startMutation(async () => {
      try {
        if (enabled) await enableHeadlessSkill(installation.id);
        else await disableHeadlessSkill(installation.id);
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
        await archiveHeadlessSkill(installation.id);
        router.push("/skills");
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  return (
    <PageContent
      title={bundle.name}
      description={`Use /${installation.name} in chat.`}
      backLink={{ href: "/skills", label: "Skills" }}
    >
      {bundle.source.type !== "workspace" ? <SkillSourceNotice source={bundle.source} /> : null}
      {installation.scope ? (
        <SkillScopeField
          scope={installation.scope}
          canManage={installation.canManage && canEdit}
          disabled={isMutating}
          onChange={(scope) => {
            setError(null);
            startMutation(async () => {
              try {
                const updated = await setHeadlessSkillScope(installation.id, {
                  scope,
                  expectedScope: installation.scope!,
                });
                if (!updated.canEdit) router.push("/skills");
                else router.refresh();
              } catch (cause) {
                setError(errorMessage(cause));
              }
            });
          }}
        />
      ) : (
        <p className="text-[13px] text-ink-subtle">Managed by its plugin.</p>
      )}

      {bundle.source.type === "workspace" ? (
        <WorkspaceSkillEditor key={installation.id} installation={installation} canEdit={canEdit} />
      ) : (
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
      )}

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
          {bundle.source.type !== "workspace" ? (
            <button
              type="button"
              disabled={isMutating}
              onClick={() => setReplacing(true)}
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              Replace bundle
            </button>
          ) : null}
          {installation.canManage ? (
            <button
              type="button"
              disabled={isMutating}
              onClick={archive}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              {isMutating ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
              Archive
            </button>
          ) : null}
        </div>
      ) : null}

      {replacing ? (
        <ImportSkillDialog
          replaceName={installation.name}
          replaceId={installation.id}
          initialUrl={skillSourceInput(bundle.source, bundle.name)}
          initialSelectedPath={bundle.source.path}
          onClose={() => setReplacing(false)}
          onInstalled={() => {
            setReplacing(false);
            router.refresh();
          }}
        />
      ) : null}
    </PageContent>
  );
}

function WorkspaceSkillEditor({
  installation,
  canEdit,
}: {
  installation: SkillInstallationDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const initial = {
    description: installation.bundle.description,
    instructions: installation.bundle.body.trim(),
  };
  const [saved, setSaved] = useState(initial);
  const [savedBundleId, setSavedBundleId] = useState(installation.bundle.id);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const isDirty =
    draft.description !== saved.description || draft.instructions !== saved.instructions;

  useEffect(() => {
    if (!isDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [isDirty]);

  const save = () => {
    if (!isDirty || isSaving || !canEdit) return;
    const next = { description: draft.description.trim(), instructions: draft.instructions.trim() };
    if (!next.description || !next.instructions) {
      setError("Add a description and instructions before saving.");
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        const updated = await updateHeadlessWorkspaceSkill(installation.id, {
          ...next,
          expectedBundleId: savedBundleId,
        });
        setSavedBundleId(updated.bundle.id);
        setDraft(next);
        setSaved(next);
        setSavedNotice(true);
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <InstallationStatusBadge enabled={installation.enabled} />
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-subtle">When to use this skill</span>
        <input
          value={draft.description}
          readOnly={!canEdit}
          disabled={isSaving}
          maxLength={1024}
          onChange={(event) => {
            setDraft({ ...draft, description: event.target.value });
            setSavedNotice(false);
          }}
          className={EDITOR_INPUT_CLASS}
        />
      </label>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <label
          htmlFor="workspace-skill-instructions"
          className="flex items-center justify-between border-b border-border bg-surface-muted px-3 py-2"
        >
          <span className="font-mono text-[12px] text-ink">SKILL.md</span>
          <span className="text-[11.5px] text-ink-subtle">Markdown</span>
        </label>
        <textarea
          id="workspace-skill-instructions"
          aria-label="Skill instructions"
          value={draft.instructions}
          readOnly={!canEdit}
          disabled={isSaving}
          spellCheck={false}
          maxLength={512 * 1024}
          onChange={(event) => {
            setDraft({ ...draft, instructions: event.target.value });
            setSavedNotice(false);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              save();
            }
          }}
          placeholder="Write the instructions the agent should follow…"
          className="block min-h-[420px] w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-6 text-ink outline-none focus:ring-1 focus:ring-inset focus:ring-ink/20 disabled:opacity-60"
        />
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-warning">
          {error}
        </p>
      ) : null}
      {canEdit ? (
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!isDirty || isSaving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-ink bg-ink px-3 text-[13px] font-medium text-canvas hover:bg-ink/90 disabled:opacity-50"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isSaving ? "Saving…" : "Save changes"}
          </button>
          {isDirty ? (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                setDraft(saved);
                setError(null);
              }}
              className="inline-flex h-9 items-center rounded-md px-3 text-[13px] text-ink-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Discard changes
            </button>
          ) : null}
          <span role="status" className="ml-auto text-[12px] text-ink-subtle">
            {isSaving ? "Saving…" : isDirty ? "Unsaved changes" : savedNotice ? "Saved" : ""}
          </span>
        </div>
      ) : null}
    </form>
  );
}

function SkillSourceNotice({ source }: { source: Exclude<SkillSourceDto, { type: "workspace" }> }) {
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

function ImportedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      <Link2 size={10} strokeWidth={2} />
      Imported
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
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
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

function NewItemDialog({
  title,
  namePlaceholder,
  descriptionPlaceholder,
  submitLabel,
  initialScope,
  scopeHint,
  create,
  onClose,
  onCreated,
}: {
  title: string;
  namePlaceholder: string;
  descriptionPlaceholder: string;
  submitLabel: string;
  initialScope: SkillScope;
  scopeHint: (scope: SkillScope) => string;
  create: (input: {
    name: string;
    description?: string;
    scope: SkillScope;
  }) => Promise<{ ok: true; slug: string } | { ok: false; message: string }>;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<SkillScope>(initialScope);
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
          scope,
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
          <ScopeField
            scope={scope}
            onChange={setScope}
            disabled={isPending}
            hint={scopeHint}
            managedTooltip="Only the creator or an admin can change visibility."
          />
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
  initialScope,
  onClose,
  onSaved,
}: {
  initialScope: SkillScope;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SkillScope>(initialScope);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

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
        const result = await createHeadlessWorkspaceSkill({
          scope,
          name: normalizedName,
          description: normalizedDescription,
          instructions: normalizedInstructions,
        });
        onSaved(result.installation.id);
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
        aria-label="New skill"
        className="shadow-ring-xl relative flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl bg-surface p-5"
      >
        <h2 className="text-[15px] font-semibold leading-tight text-ink">New skill</h2>
        <div className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <SkillScopeField scope={scope} onChange={setScope} disabled={isSaving} />
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Name</span>
            <input
              autoFocus
              value={name}
              disabled={isSaving}
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
            Create skill
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportSkillDialog({
  initialScope = "personal",
  onClose,
  onInstalled,
  replaceName,
  replaceId,
  initialUrl = "",
  initialSelectedPath,
}: {
  initialScope?: SkillScope;
  onClose: () => void;
  onInstalled: (name: string) => void;
  replaceName?: string;
  replaceId?: string;
  initialUrl?: string;
  initialSelectedPath?: string;
}) {
  const [scope, setScope] = useState<SkillScope>(initialScope);
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
          const result = await replaceHeadlessSkill(replaceId ?? replaceName, command);
          onInstalled(result.id);
        } else {
          const result = await importHeadlessSkill({ ...command, scope });
          onInstalled(result.installation.id);
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
          Paste a GitHub or skills.sh link to preview the skill.
        </p>

        <div className="mt-4 flex flex-col gap-3 overflow-y-auto">
          {!replaceName ? (
            <SkillScopeField scope={scope} onChange={setScope} disabled={pending} />
          ) : null}
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

function SkillScopeBadge({ scope }: { scope: SkillScope | null }) {
  return (
    <ScopeBadge>
      {scope === "personal" ? "Personal" : scope === "company" ? "Company" : "Plugin"}
    </ScopeBadge>
  );
}

function SkillScopeField(props: {
  scope: SkillScope;
  onChange: (scope: SkillScope) => void;
  disabled?: boolean;
  canManage?: boolean;
}) {
  return (
    <ScopeField
      {...props}
      hint={(scope) => (scope === "personal" ? "Only you" : "Everyone can use and edit")}
      managedTooltip="Only the creator or an admin can change visibility."
    />
  );
}
