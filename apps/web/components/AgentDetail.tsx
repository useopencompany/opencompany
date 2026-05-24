"use client";

import {
  Brain,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Clock3,
  Cloud,
  Code2,
  ExternalLink,
  FileCode2,
  GitBranch,
  Loader2,
  type LucideIcon,
  PanelRight,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { AgentEditor, type AgentEditorHandle } from "@/components/agent-editor/AgentEditor";
import {
  AGENT_MODELS,
  type AgentMentionItem,
  type AgentModel,
  type AgentTool,
  buildAgentMentionItems,
  findModel,
  findTool,
} from "@/components/agent-editor/tools";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { createAgentSession } from "@/lib/agent-sessions/actions";
import { updateAgent } from "@/lib/agents/actions";
import { deriveAgentConfigFromContent } from "@/lib/agents/config";
import type {
  AgentConfig,
  AgentConfigTool,
  AgentGitHubRepositoryConfig,
  AgentModelId,
  AgentTriggerConfig,
  TiptapDoc,
} from "@/lib/agents/types";
import { markGitHubRepositorySelected, refreshGitHubRepositories } from "@/lib/integrations/actions";

type Props = {
  id: string;
  initialName: string;
  initialBody: string;
  initialContent: TiptapDoc;
  initialConfig: AgentConfig;
  initialPath: string | null;
  initialGitHubCommitSha: string | null;
  initialGitHubSyncedAt: string | null;
  initialGitHubSyncStatus: string;
  initialGitHubSyncError: string | null;
  initialIntegrations: WorkspaceIntegrationState;
};

type SaveState = "idle" | "saving" | "saved";
type SyncTone = "neutral" | "progress" | "success" | "danger";
type OptimisticGitHubSync = {
  status: string;
  error: string | null;
  baseStatus: string;
  baseError: string | null;
  baseCommitSha: string | null;
  baseSyncedAt: string | null;
};
type WorkspaceIntegrationState = {
  github: {
    status: "not_connected" | "connected" | "needs_repository_access" | "error";
    installation: {
      installationId: string;
      accountLogin: string | null;
      accountType: string | null;
      updatedAt: string;
    } | null;
    repositories: Array<{
      fullName: string;
      defaultBranch: string;
      selectedAt: string | null;
    }>;
  };
};
type AgentConfigSelection = {
  tools: AgentConfigTool[];
  repositories: AgentGitHubRepositoryConfig[];
  triggers: AgentTriggerConfig[];
};

const INSPECTOR_STORAGE_KEY = "opencompany-agent-inspector-collapsed";
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

function getStoredInspectorCollapsed() {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(INSPECTOR_STORAGE_KEY);
  return stored === null ? true : stored === "true";
}

function githubConnectHref(returnTo: string) {
  return `/api/integrations/github/start?intent=agent&returnTo=${encodeURIComponent(returnTo)}`;
}

export default function AgentDetail({
  id,
  initialName,
  initialBody,
  initialContent,
  initialConfig,
  initialPath,
  initialGitHubCommitSha,
  initialGitHubSyncedAt,
  initialGitHubSyncStatus,
  initialGitHubSyncError,
  initialIntegrations,
}: Props) {
  const mentionItems = useMemo(
    () => buildAgentMentionItems(initialIntegrations.github.repositories),
    [initialIntegrations.github.repositories],
  );
  const [name, setName] = useState(initialName);
  const [selectedModelId, setSelectedModelId] = useState<AgentModelId>(
    findModel(initialConfig.model.name)?.id ?? DEFAULT_MODEL_ID,
  );
  const [configTools, setConfigTools] = useState<AgentConfigTool[]>(initialConfig.tools);
  const [configRepositories, setConfigRepositories] = useState<AgentGitHubRepositoryConfig[]>(
    initialConfig.integrations.github.repositories,
  );
  const [configTriggers, setConfigTriggers] = useState<AgentTriggerConfig[]>(
    initialConfig.triggers,
  );
  const [githubSelected, setGithubSelected] = useState(
    initialConfig.integrations.github.repositories.length > 0,
  );
  const configRef = useRef({
    tools: initialConfig.tools,
    repositories: initialConfig.integrations.github.repositories,
    triggers: initialConfig.triggers,
  });
  const editorRef = useRef<AgentEditorHandle | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const openRepoPickerAfterGitHubSetup =
    searchParams.get("integration") === "github" &&
    searchParams.get("setup") === "connected" &&
    initialIntegrations.github.repositories.length > 0;
  const [, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(getStoredInspectorCollapsed);
  const [githubSetupIntent, setGithubSetupIntent] = useState<"github" | "amp" | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(openRepoPickerAfterGitHubSetup);
  const [optimisticGitHubSync, setOptimisticGitHubSync] = useState<OptimisticGitHubSync | null>(
    null,
  );
  const pendingRef = useRef<{
    name?: string;
    body?: string;
    content?: TiptapDoc;
    model?: AgentModelId;
    config?: {
      tools?: AgentConfigTool[];
      integrations?: AgentConfig["integrations"];
      triggers?: AgentTriggerConfig[];
    };
  }>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configPreview = buildConfigPreview({
    fallback: initialConfig,
    selectedModelId,
    tools: configTools,
  });
  const selectedModel = findModel(selectedModelId) ?? findModel(DEFAULT_MODEL_ID)!;
  const showOptimisticGitHubSync =
    optimisticGitHubSync &&
    initialGitHubSyncStatus === optimisticGitHubSync.baseStatus &&
    initialGitHubSyncError === optimisticGitHubSync.baseError &&
    initialGitHubCommitSha === optimisticGitHubSync.baseCommitSha &&
    initialGitHubSyncedAt === optimisticGitHubSync.baseSyncedAt;
  const githubSyncStatus = showOptimisticGitHubSync
    ? optimisticGitHubSync.status
    : initialGitHubSyncStatus;
  const githubSyncError = showOptimisticGitHubSync
    ? optimisticGitHubSync.error
    : initialGitHubSyncError;
  const githubCommitSha = initialGitHubCommitSha;
  const githubSyncedAt = initialGitHubSyncedAt;

  useEffect(() => {
    if (pendingRef.current.model) return;
    setSelectedModelId(findModel(initialConfig.model.name)?.id ?? DEFAULT_MODEL_ID);
  }, [initialConfig.model.name]);

  function updateInspectorCollapsed(nextCollapsed: boolean) {
    setInspectorCollapsed(nextCollapsed);
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, String(nextCollapsed));
  }

  const flush = () => {
    const patch = { ...pendingRef.current };
    if (typeof patch.name !== "string" && patch.body === undefined && !patch.model && !patch.config)
      return;
    pendingRef.current = {};
    setSaveState("saving");
    setOptimisticGitHubSync({
      status: "pending",
      error: null,
      baseStatus: initialGitHubSyncStatus,
      baseError: initialGitHubSyncError,
      baseCommitSha: initialGitHubCommitSha,
      baseSyncedAt: initialGitHubSyncedAt,
    });
    startTransition(async () => {
      const result = await updateAgent(id, patch);
      setSaveState("saved");
      if (result?.pathChanged) {
        router.replace(`/agents/${result.path}`);
      }
      router.refresh();
    });
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  };

  function applyDerivedConfig(next: AgentConfigSelection) {
    const changed = !sameConfigSelection(next, configRef.current);
    configRef.current = next;
    setConfigTools(next.tools);
    setConfigRepositories(next.repositories);
    setConfigTriggers(next.triggers);

    if (changed) {
      pendingRef.current.config = configPatchFromSelection(next);
    }
  }

  function handleMentionSelect(item: AgentMentionItem) {
    if (item.kind === "model") {
      setSelectedModelId(item.id);
      pendingRef.current.model = item.id;
      schedule();
      return;
    }

    if (item.kind === "tool" && item.id === "amp") {
      if (!initialIntegrations.github.installation) {
        setGithubSetupIntent("amp");
        return;
      }
      if (configRef.current.repositories.length === 0) {
        setRepoPickerOpen(true);
      }
      return;
    }

    if (item.kind === "integration" && item.provider === "github") {
      if (!initialIntegrations.github.installation) {
        setGithubSetupIntent("github");
        return;
      }
      if (item.fullName) {
        startTransition(async () => {
          await markGitHubRepositorySelected(item.fullName!);
        });
        return;
      }
      setRepoPickerOpen(true);
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (githubSyncStatus !== "pending" && githubSyncStatus !== "syncing") return;
    const interval = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(interval);
  }, [githubSyncStatus, router]);

  function selectRepository(repository: { fullName: string; defaultBranch: string }) {
    editorRef.current?.selectRepositoryMention(repository);
    setGithubSelected(true);
    setRepoPickerOpen(false);
    startTransition(async () => {
      await markGitHubRepositorySelected(repository.fullName);
    });
  }

  const agentReturnPath = initialPath ? `/agents/${initialPath}` : `/agents/${id}`;

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-24 pt-10">
          <div className="flex items-center justify-between text-[12px] text-ink-muted">
            <Link
              href="/agents"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-[#ececea]/70"
            >
              <ChevronLeft size={12} strokeWidth={1.9} />
              Agents
            </Link>
            <div className="flex items-center gap-2 tabular-nums text-ink-subtle">
              <button
                onClick={() => {
                  if (timerRef.current) clearTimeout(timerRef.current);
                  flush();
                  startTransition(async () => {
                    await createAgentSession(id);
                  });
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#e4e4e0] bg-white px-2 py-1 text-[12px] text-ink/85 hover:bg-[#fafaf8]"
              >
                <Play size={11} strokeWidth={2} />
                Start session
              </button>
            </div>
          </div>

          <input
            value={name}
            onChange={(e) => {
              const next = e.target.value;
              setName(next);
              pendingRef.current.name = next;
              schedule();
            }}
            onBlur={() => {
              if (timerRef.current) clearTimeout(timerRef.current);
              flush();
            }}
            placeholder="Untitled agent"
            className="mt-6 w-full bg-transparent text-[24px] font-semibold tracking-[-0.01em] text-ink outline-none placeholder:text-ink-subtle/60"
          />

          <div className="mt-2 flex items-center">
            <Select
              value={selectedModelId}
              onValueChange={(value) => {
                const next = findModel(value)?.id;
                if (!next) return;
                setSelectedModelId(next);
                pendingRef.current.model = next;
                schedule();
              }}
            >
              <SelectTrigger className="h-6 w-auto border-0 bg-transparent px-1.5 text-[11.5px] font-medium text-ink-muted shadow-none hover:bg-[#ececea]/70 focus:ring-0 focus-visible:ring-0 [&>svg]:ml-0.5 [&>svg]:h-3 [&>svg]:w-3">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Brain size={12} strokeWidth={1.9} className="shrink-0" />
                  <span className="truncate">{selectedModel.displayLabel}</span>
                </span>
              </SelectTrigger>
              <SelectContent className="min-w-[232px]">
                {(["Thinking", "Non-thinking"] as const).map((group, index) => {
                  const models = AGENT_MODELS.filter((model) =>
                    group === "Thinking" ? model.supportsReasoning : !model.supportsReasoning,
                  );
                  if (models.length === 0) return null;

                  return (
                    <SelectGroup key={group}>
                      <SelectLabel>{group}</SelectLabel>
                      {models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.displayLabel}
                        </SelectItem>
                      ))}
                      {index === 0 ? <SelectSeparator /> : null}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-6">
            <AgentEditor
              ref={editorRef}
              initialBody={initialBody}
              initialContent={initialContent}
              mentionItems={mentionItems}
              onMentionSelect={handleMentionSelect}
              onChange={(body, content) => {
                const nextConfig = deriveConfigFromEditorContent({
                  title: name,
                  content: content as TiptapDoc,
                  model: selectedModelId,
                  current: configRef.current,
                  repositories: initialIntegrations.github.repositories,
                });
                pendingRef.current.body = body;
                pendingRef.current.content = content as TiptapDoc;
                setGithubSelected(nextConfig.repositories.length > 0);
                applyDerivedConfig(nextConfig);
                schedule();
              }}
            />
          </div>
        </div>
      </div>

      {!inspectorCollapsed && (
        <button
          type="button"
          aria-label="Collapse agent details"
          className="fixed inset-0 z-30 bg-black/[0.06] lg:hidden"
          onClick={() => updateInspectorCollapsed(true)}
        />
      )}

      <aside
        className={`shrink-0 overflow-y-auto border-l border-[#e4e4e0] bg-[#fbfbf9]/95 px-5 py-4 shadow-[-16px_0_36px_rgba(0,0,0,0.08)] backdrop-blur-md transition-transform duration-200 ease-out lg:bg-[#fbfbf9]/80 lg:py-8 lg:shadow-none lg:backdrop-blur-0 ${
          inspectorCollapsed
            ? "hidden"
            : "fixed inset-y-0 right-0 z-40 block w-[min(328px,calc(100vw-24px))] lg:static lg:z-auto lg:w-[328px]"
        }`}
        aria-hidden={inspectorCollapsed}
      >
        <div className="mb-5 flex items-center justify-between pr-9 lg:mb-7">
          <div className="text-[12px] font-medium text-ink">Configuration</div>
        </div>
        <AgentInspector
          name={name}
          path={initialPath}
          model={configPreview.model}
          modelIsExplicit={configPreview.modelIsExplicit}
          tools={configPreview.tools}
          configTools={configTools}
          configRepositories={configRepositories}
          configTriggers={configTriggers}
          githubSelected={githubSelected}
          workspaceIntegrations={initialIntegrations}
          onChooseRepository={() => setRepoPickerOpen(true)}
          connectHref={githubConnectHref(agentReturnPath)}
          saveState={saveState}
          githubStatus={githubSyncStatus}
          githubError={githubSyncError}
          githubCommitSha={githubCommitSha}
          githubSyncedAt={githubSyncedAt}
        />
      </aside>

      <button
        type="button"
        aria-label={inspectorCollapsed ? "Expand agent details" : "Collapse agent details"}
        aria-expanded={!inspectorCollapsed}
        onClick={() => updateInspectorCollapsed(!inspectorCollapsed)}
        className="fixed right-6 top-10 z-50 rounded-md border border-[#e6e6e3] bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </button>

      {githubSetupIntent ? (
        <GitHubSetupModal
          intent={githubSetupIntent}
          href={githubConnectHref(agentReturnPath)}
          onClose={() => setGithubSetupIntent(null)}
        />
      ) : null}

      {repoPickerOpen ? (
        <RepositoryPickerModal
          repositories={initialIntegrations.github.repositories}
          selectedRepository={configRepositories[0] ?? null}
          connectHref={githubConnectHref(agentReturnPath)}
          onSelect={selectRepository}
          onClose={() => setRepoPickerOpen(false)}
        />
      ) : null}
    </main>
  );
}

function AgentInspector({
  name,
  path,
  model,
  modelIsExplicit,
  tools,
  configTools,
  configRepositories,
  configTriggers,
  githubSelected,
  workspaceIntegrations,
  onChooseRepository,
  connectHref,
  saveState,
  githubStatus,
  githubError,
  githubCommitSha,
  githubSyncedAt,
}: {
  name: string;
  path: string | null;
  model: AgentModel;
  modelIsExplicit: boolean;
  tools: AgentTool[];
  configTools: AgentConfigTool[];
  configRepositories: AgentGitHubRepositoryConfig[];
  configTriggers: AgentTriggerConfig[];
  githubSelected: boolean;
  workspaceIntegrations: WorkspaceIntegrationState;
  onChooseRepository: () => void;
  connectHref: string;
  saveState: SaveState;
  githubStatus: string;
  githubError: string | null;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
}) {
  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
          <FileCode2 size={14} strokeWidth={1.9} className="text-ink-muted" />
          Agent file
        </div>
        <div className="mt-4 space-y-4">
          <InspectorField label="Name" value={name.trim() || "Untitled agent"} />
          {path ? <InspectorField label="Path" value={path} mono /> : null}
        </div>
      </div>

      <div>
        <InspectorHeader label="Model" countLabel={modelIsExplicit ? "selected" : "default"} />
        <ConfigItem
          icon={model.icon}
          label={model.label}
          description={model.description}
          tone={modelIsExplicit ? "model" : "muted"}
        />
      </div>

      <div>
        <InspectorHeader
          label="Tools"
          countLabel={`${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}
        />
        {tools.length > 0 ? (
          <div className="space-y-2">
            {tools.map((tool) => (
              <ConfigItem
                key={tool.id}
                icon={tool.icon}
                label={tool.label}
                description={tool.description}
                tone="tool"
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[#deded9] bg-white/45 px-3 py-3 text-[12px] text-ink-muted">
            No tools selected
          </div>
        )}
      </div>

      <IntegrationPanel
        configTools={configTools}
        repositories={configRepositories}
        triggers={configTriggers}
        githubSelected={githubSelected}
        workspaceIntegrations={workspaceIntegrations}
        onChooseRepository={onChooseRepository}
        connectHref={connectHref}
      />

      <GitHubSyncPanel
        saveState={saveState}
        status={githubStatus}
        error={githubError}
        commitSha={githubCommitSha}
        syncedAt={githubSyncedAt}
      />
    </div>
  );
}

function IntegrationPanel({
  configTools,
  repositories,
  triggers,
  githubSelected,
  workspaceIntegrations,
  onChooseRepository,
  connectHref,
}: {
  configTools: AgentConfigTool[];
  repositories: AgentGitHubRepositoryConfig[];
  triggers: AgentTriggerConfig[];
  githubSelected: boolean;
  workspaceIntegrations: WorkspaceIntegrationState;
  onChooseRepository: () => void;
  connectHref: string;
}) {
  const ampTool = configTools.find((tool) => tool.id === "amp");
  const selectedRepositoryId =
    ampTool?.id === "amp" ? ampTool.repository : (repositories[0]?.id ?? null);
  const selectedRepository =
    repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0];
  const triggerEnabled = triggers.some((trigger) => trigger.type === "github.pull_request");
  const availableRepositories = workspaceIntegrations.github.repositories;
  const selectedRepositoryUnavailable = Boolean(
    selectedRepository &&
      !availableRepositories.some(
        (repository) => repository.fullName === selectedRepository.fullName,
      ),
  );

  if (!ampTool && !githubSelected && repositories.length === 0 && !triggerEnabled) return null;

  return (
    <div>
      <InspectorHeader
        label="Work integrations"
        countLabel={repositories.length ? "configured" : "needs config"}
      />
      <div className="space-y-3">
        {(githubSelected || repositories.length > 0 || ampTool) && (
          <div className="rounded-lg border border-[#e2e2de] bg-white/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch size={14} strokeWidth={1.9} className="text-ink-muted" />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink">GitHub work repo</div>
                  <div className="truncate text-[11.5px] text-ink-muted">
                    {workspaceIntegrations.github.installation?.accountLogin
                      ? `Installed on ${workspaceIntegrations.github.installation.accountLogin}`
                      : "Connect GitHub to choose a repository"}
                  </div>
                </div>
              </div>
              {workspaceIntegrations.github.installation ? (
                <form action={refreshGitHubRepositories}>
                  <button
                    type="submit"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e4e4e0] bg-white px-2 text-[11.5px] text-ink/85 hover:bg-[#fafaf8]"
                  >
                    <RefreshCw size={11} strokeWidth={2} />
                    Refresh
                  </button>
                </form>
              ) : (
                <a
                  href={connectHref}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e4e4e0] bg-white px-2 text-[11.5px] text-ink/85 hover:bg-[#fafaf8]"
                >
                  <ExternalLink size={11} strokeWidth={2} />
                  Connect
                </a>
              )}
            </div>
            <div className="mt-3 rounded-md border border-[#e2e2de] bg-white px-2.5 py-2">
              <div className="text-[10.5px] font-medium uppercase text-ink-subtle">Repository</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="min-w-0 truncate text-[12.5px] font-medium text-ink">
                  {selectedRepository?.fullName ?? "No repository selected"}
                </div>
                <button
                  type="button"
                  onClick={onChooseRepository}
                  disabled={
                    !workspaceIntegrations.github.installation || availableRepositories.length === 0
                  }
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[#e4e4e0] bg-white px-2 text-[11.5px] text-ink/85 hover:bg-[#fafaf8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {selectedRepository ? "Change" : "Choose"}
                </button>
              </div>
            </div>
            {selectedRepositoryUnavailable ? (
              <div className="mt-2 text-[11.5px] leading-4 text-[#9f2f21]">
                This repository is no longer available from the GitHub work integration.
              </div>
            ) : null}
            {ampTool && !selectedRepository ? (
              <div className="mt-2 text-[11.5px] leading-4 text-ink-subtle">
                Mention a GitHub work repository in the agent body before runtime can expose AMP.
              </div>
            ) : null}
          </div>
        )}

        {ampTool ? (
          <div className="rounded-lg border border-[#e2e2de] bg-white/60 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Code2 size={14} strokeWidth={1.9} className="text-ink-muted" />
              <div>
                <div className="text-[12.5px] font-medium text-ink">AMP</div>
                <div className="text-[11.5px] text-ink-muted">
                  Runs with OpenCompany platform support
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {triggerEnabled ? (
          <div className="rounded-lg border border-[#e2e2de] bg-white/60 p-3">
            <InspectorHeader label="Trigger" countLabel={triggerEnabled ? "draft" : "off"} />
            <div className="text-[12px] text-ink-muted">Draft GitHub pull request trigger</div>
            <div className="mt-2 text-[11.5px] leading-4 text-ink-subtle">
              Saved to YAML but disabled until webhook execution ships.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GitHubSetupModal({
  intent,
  href,
  onClose,
}: {
  intent: "github" | "amp";
  href: string;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#e2e2de] bg-[#f7f7f4] text-ink-muted">
          <GitBranch size={17} strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">Connect GitHub</h2>
          <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
            {intent === "amp"
              ? "AMP needs access to a GitHub repository before it can work on code."
              : "Connect GitHub to choose a repository for this agent."}
          </p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-md border border-[#e3e3df] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f7f7f5]"
        >
          Not now
        </button>
        <a
          href={href}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-black"
        >
          <ExternalLink size={13} strokeWidth={1.9} />
          Connect GitHub
        </a>
      </div>
    </ModalShell>
  );
}

function RepositoryPickerModal({
  repositories,
  selectedRepository,
  connectHref,
  onSelect,
  onClose,
}: {
  repositories: WorkspaceIntegrationState["github"]["repositories"];
  selectedRepository: AgentGitHubRepositoryConfig | null;
  connectHref: string;
  onSelect: (repository: { fullName: string; defaultBranch: string }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = repositories.filter((repository) =>
    repository.fullName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Choose repository</h2>
          <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
            The selected repository will be written into the agent body as a mention.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close repository picker"
          onClick={onClose}
          className="rounded-md p-1 text-ink-muted hover:bg-[#eeeeeb] hover:text-ink"
        >
          <X size={15} strokeWidth={1.9} />
        </button>
      </div>

      {repositories.length > 0 ? (
        <>
          <div className="mt-4 flex h-8 items-center gap-2 rounded-md border border-[#e3e3df] bg-white px-2.5">
            <Search size={13} strokeWidth={1.9} className="text-ink-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search repositories"
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          <div className="mt-3 max-h-[280px] overflow-y-auto rounded-md border border-[#e3e3df] bg-white/65">
            {filtered.map((repository) => {
              const selected = selectedRepository?.fullName === repository.fullName;
              return (
                <button
                  key={repository.fullName}
                  type="button"
                  onClick={() => onSelect(repository)}
                  className={`flex w-full items-center justify-between gap-4 border-t border-[#ecece8] px-3 py-2.5 text-left first:border-t-0 hover:bg-[#f7f7f5] ${
                    selected ? "bg-[#f1f6f2]" : ""
                  }`}
                >
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">
                    {repository.fullName}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-ink-subtle">
                    {repository.defaultBranch}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-md border border-dashed border-[#deded9] bg-white/45 px-3 py-3 text-[12.5px] leading-5 text-ink-muted">
          No repositories are available yet.
        </div>
      )}

      <div className="mt-4 flex justify-between gap-2">
        <form action={refreshGitHubRepositories}>
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e3e3df] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f7f7f5]"
          >
            <RefreshCw size={13} strokeWidth={1.9} />
            Refresh
          </button>
        </form>
        <a
          href={connectHref}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e3e3df] bg-white px-3 text-[12.5px] font-medium text-ink hover:bg-[#f7f7f5]"
        >
          <ExternalLink size={13} strokeWidth={1.9} />
          Reconnect
        </a>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Close modal"
        className="absolute inset-0 bg-black/[0.12]"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[480px] rounded-lg border border-[#deded9] bg-[#fbfbfa] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.16)]">
        {children}
      </div>
    </div>
  );
}

function InspectorHeader({ label, countLabel }: { label: string; countLabel: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      <span className="rounded-full border border-[#e3e3df] bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
        {countLabel}
      </span>
    </div>
  );
}

function InspectorField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase text-ink-subtle">{label}</div>
      <div
        className={`mt-1 break-words text-[13px] text-ink ${mono ? "font-mono text-[11.5px]" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function ConfigItem({
  icon: Icon,
  label,
  description,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  tone: "model" | "tool" | "muted";
}) {
  const toneClass =
    tone === "model"
      ? "border-[#d6dde9] bg-[#f4f7fb]"
      : tone === "tool"
        ? "border-[#d8e1d7] bg-[#f5faf6]"
        : "border-[#e2e2de] bg-white/55";

  return (
    <div className={`rounded-lg border px-3 py-3 ${toneClass}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/70 bg-white/70 text-ink-muted">
          <Icon size={14} strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium text-ink">{label}</div>
          <div className="mt-0.5 text-[11.5px] leading-4 text-ink-muted">{description}</div>
        </div>
      </div>
    </div>
  );
}

function GitHubSyncPanel({
  saveState,
  status,
  error,
  commitSha,
  syncedAt,
}: {
  saveState: SaveState;
  status: string;
  error: string | null;
  commitSha: string | null;
  syncedAt: string | null;
}) {
  const meta = syncMeta(status);
  const Icon = meta.icon;
  const shortSha = commitSha ? commitSha.slice(0, 7) : null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-medium text-ink">GitHub sync</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${syncToneClass(meta.tone)}`}
        >
          <Icon
            size={11}
            strokeWidth={2}
            className={status === "pending" || status === "syncing" ? "animate-spin" : ""}
          />
          {meta.label}
        </span>
      </div>

      <div className="rounded-lg border border-[#e2e2de] bg-white/60 p-3">
        <SyncTrack saveState={saveState} status={status} />
        <div className="mt-4 space-y-2 text-[12px] text-ink-muted">
          <div className="flex items-center gap-2">
            <Clock3 size={12} strokeWidth={1.9} className="text-ink-subtle" />
            <span>{syncedAt ? `Synced ${formatSyncDate(syncedAt)}` : meta.description}</span>
          </div>
          {shortSha ? (
            <div className="flex items-center gap-2">
              <GitBranch size={12} strokeWidth={1.9} className="text-ink-subtle" />
              <span className="font-mono text-[11.5px] text-ink-muted">{shortSha}</span>
            </div>
          ) : null}
        </div>
        {error ? (
          <div className="mt-3 rounded-md border border-[#f1b8ae] bg-[#fff7f5] px-3 py-2 text-[11.5px] leading-4 text-[#9f2f21]">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SyncTrack({ saveState, status }: { saveState: SaveState; status: string }) {
  const steps = [
    { id: "local", label: "Saved locally", state: saveState === "saving" ? "active" : "done" },
    {
      id: "queued",
      label: "Queued",
      state:
        status === "pending"
          ? "active"
          : status === "syncing" || status === "synced"
            ? "done"
            : status === "failed"
              ? "danger"
              : "idle",
    },
    {
      id: "commit",
      label: "Commit",
      state:
        status === "syncing"
          ? "active"
          : status === "synced"
            ? "done"
            : status === "failed"
              ? "danger"
              : "idle",
    },
    {
      id: "synced",
      label: "Synced",
      state: status === "synced" ? "done" : status === "failed" ? "danger" : "idle",
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-1">
      {steps.map((step) => (
        <div key={step.id} className="min-w-0">
          <div
            className={`h-1 rounded-full ${
              step.state === "done"
                ? "bg-[#2f7d46]"
                : step.state === "active"
                  ? "bg-[#9b7a2d]"
                  : step.state === "danger"
                    ? "bg-[#c2412d]"
                    : "bg-[#deded9]"
            }`}
          />
          <div className="mt-1 truncate text-[9.5px] font-medium text-ink-subtle">{step.label}</div>
        </div>
      ))}
    </div>
  );
}

function deriveConfigFromEditorContent(input: {
  title: string;
  content: TiptapDoc;
  model: AgentModelId;
  current: AgentConfigSelection;
  repositories: Array<{ fullName: string; defaultBranch: string }>;
}): AgentConfigSelection {
  const { config } = deriveAgentConfigFromContent({
    title: input.title,
    content: input.content,
    model: input.model,
    repositories: input.repositories,
    triggers: input.current.triggers,
  });

  return {
    tools: config.tools,
    repositories: config.integrations.github.repositories,
    triggers: config.triggers,
  };
}

function sameConfigSelection(left: AgentConfigSelection, right: AgentConfigSelection) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configPatchFromSelection(selection: AgentConfigSelection) {
  return {
    tools: selection.tools,
    integrations: { github: { repositories: selection.repositories } },
    triggers: selection.triggers,
  };
}

function buildConfigPreview({
  fallback,
  selectedModelId,
  tools: configTools,
}: {
  fallback: AgentConfig;
  selectedModelId: AgentModelId;
  tools: AgentConfigTool[];
}) {
  const model =
    findModel(selectedModelId) ?? findModel(fallback.model.name) ?? findModel(DEFAULT_MODEL_ID);
  const tools = configTools.flatMap((toolConfig) => {
    const tool = findTool(toolConfig.id);
    return tool ? [tool] : [];
  });

  return {
    model: model!,
    modelIsExplicit: selectedModelId !== DEFAULT_MODEL_ID,
    tools,
  };
}

function syncMeta(status: string): {
  label: string;
  description: string;
  tone: SyncTone;
  icon: LucideIcon;
} {
  if (status === "failed") {
    return {
      label: "Needs attention",
      description: "GitHub has not received the latest saved version.",
      tone: "danger",
      icon: CircleAlert,
    };
  }
  if (status === "pending") {
    return {
      label: "Queued",
      description: "Waiting for the GitHub sync worker.",
      tone: "progress",
      icon: Loader2,
    };
  }
  if (status === "syncing") {
    return {
      label: "Committing",
      description: "Writing the latest agent file to GitHub.",
      tone: "progress",
      icon: Loader2,
    };
  }
  if (status === "synced") {
    return {
      label: "Synced",
      description: "GitHub has the latest saved version.",
      tone: "success",
      icon: CheckCircle2,
    };
  }

  return {
    label: "Not synced",
    description: "GitHub sync has not started.",
    tone: "neutral",
    icon: Cloud,
  };
}

function syncToneClass(tone: SyncTone) {
  if (tone === "success") return "border-[#cfe5d5] bg-[#f0f8f2] text-[#216b35]";
  if (tone === "danger") return "border-[#f0c0b8] bg-[#fff5f3] text-[#a33929]";
  if (tone === "progress") return "border-[#eadcb6] bg-[#fff8e7] text-[#795b19]";
  return "border-[#e3e3df] bg-white text-ink-muted";
}

function formatSyncDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
