"use client";

import { serializeAgentFrontmatter } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Clock3,
  Cloud,
  FileCode2,
  GitBranch,
  Loader2,
  type LucideIcon,
  PanelRight,
  Play,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AgentEditor } from "@/components/agent-editor/AgentEditor";
import {
  AGENT_MODELS,
  type AgentMentionItem,
  type AgentModel,
  type AgentTool,
  buildAgentMentionItems,
  findModel,
  findTool,
} from "@/components/agent-editor/tools";
import { useToast } from "@/components/ToastProvider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { AgentDetailSkeleton } from "@/components/WorkspaceRouteSkeletons";
import { createAgentSession } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { updateAgent } from "@/lib/agents/actions";
import { derivePreviewConfigFromTiptapDoc } from "@/lib/agents/config";
import {
  AGENTS_QUERY_STALE_TIME_MS,
  type AgentDetailPayload,
  type AgentListItemPayload,
  agentDetailToListItem,
  agentQueryKeys,
  fetchAgent,
  fetchAgents,
} from "@/lib/agents/payload";

type Props = {
  idOrPath: string;
  initialAgent?: AgentDetailPayload;
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

const INSPECTOR_STORAGE_KEY = "opencompany-agent-inspector-collapsed";
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

function getStoredInspectorCollapsed() {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(INSPECTOR_STORAGE_KEY);
  return stored === null ? true : stored === "true";
}

function updateAgentQueries(
  queryClient: QueryClient,
  workspaceId: string,
  agent: AgentDetailPayload,
  previousIdOrPath: string,
) {
  queryClient.setQueryData(agentQueryKeys.detail(workspaceId, previousIdOrPath), agent);
  queryClient.setQueryData(agentQueryKeys.detail(workspaceId, agent.id), agent);
  if (agent.path) {
    queryClient.setQueryData(agentQueryKeys.detail(workspaceId, agent.path), agent);
  }
  const listItem = agentDetailToListItem(agent);
  queryClient.setQueryData<AgentListItemPayload[]>(agentQueryKeys.list(workspaceId), (agents) => {
    if (!agents) return [listItem];

    const next = agents.map((item) => (item.id === agent.id ? listItem : item));
    if (!next.some((item) => item.id === agent.id)) next.unshift(listItem);
    return next.toSorted(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  });
}

export default function AgentDetail({ initialAgent, idOrPath }: Props) {
  const { workspaceId } = useWorkspaceContext();
  const { data: agent } = useQuery({
    queryKey: agentQueryKeys.detail(workspaceId, idOrPath),
    queryFn: () => fetchAgent(idOrPath),
    initialData: initialAgent,
    staleTime: AGENTS_QUERY_STALE_TIME_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.githubSyncStatus === "pending" || data?.githubSyncStatus === "syncing"
        ? 2500
        : false;
    },
  });

  if (!agent) {
    return <AgentDetailSkeleton />;
  }

  return <AgentDetailContent agent={agent} idOrPath={idOrPath} workspaceId={workspaceId} />;
}

function AgentDetailContent({
  agent,
  idOrPath,
  workspaceId,
}: {
  agent: AgentDetailPayload;
  idOrPath: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const initialBody = agent.body || agent.config.instructions;
  const [name, setName] = useState(agent.name);
  const [content, setContent] = useState<TiptapDoc>(agent.content);
  const [hasEditorDraft, setHasEditorDraft] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<AgentModelId>(
    findModel(agent.config.model.name)?.id ?? DEFAULT_MODEL_ID,
  );
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(getStoredInspectorCollapsed);
  const [optimisticGitHubSync, setOptimisticGitHubSync] = useState<OptimisticGitHubSync | null>(
    null,
  );
  const pendingRef = useRef<{
    name?: string;
    body?: string;
    content?: TiptapDoc;
    model?: AgentModelId;
  }>({});
  const submittedPatchRef = useRef<typeof pendingRef.current | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configPreview = useMemo(
    () =>
      buildConfigPreview({
        title: name,
        content,
        fallback: agent.config,
        selectedModelId,
        repositories: agent.githubIntegrationRepositories,
        triggers: agent.config.triggers,
        useDerivedConfig: hasEditorDraft || hasUsableMentionNodes(content),
      }),
    [
      agent.config,
      agent.githubIntegrationRepositories,
      content,
      hasEditorDraft,
      name,
      selectedModelId,
    ],
  );
  const selectedModel = findModel(selectedModelId) ?? findModel(DEFAULT_MODEL_ID)!;
  const showOptimisticGitHubSync =
    optimisticGitHubSync &&
    agent.githubSyncStatus === optimisticGitHubSync.baseStatus &&
    agent.githubSyncError === optimisticGitHubSync.baseError &&
    agent.githubCommitSha === optimisticGitHubSync.baseCommitSha &&
    agent.githubSyncedAt === optimisticGitHubSync.baseSyncedAt;
  const githubSyncStatus = showOptimisticGitHubSync
    ? optimisticGitHubSync.status
    : agent.githubSyncStatus;
  const githubSyncError = showOptimisticGitHubSync
    ? optimisticGitHubSync.error
    : agent.githubSyncError;
  const githubCommitSha = agent.githubCommitSha;
  const githubSyncedAt = agent.githubSyncedAt;
  const mentionItems: AgentMentionItem[] = useMemo(
    () => buildAgentMentionItems(agent.githubIntegrationRepositories, agent.brainPaths),
    [agent.brainPaths, agent.githubIntegrationRepositories],
  );

  useEffect(() => {
    if (
      pendingRef.current.name !== undefined ||
      pendingRef.current.body !== undefined ||
      pendingRef.current.content !== undefined ||
      pendingRef.current.model !== undefined ||
      submittedPatchRef.current
    ) {
      return;
    }
    setName(agent.name);
    setContent(agent.content);
    setHasEditorDraft(false);
    setSelectedModelId(findModel(agent.config.model.name)?.id ?? DEFAULT_MODEL_ID);
  }, [
    agent.id,
    agent.name,
    agent.body,
    agent.content,
    agent.config.instructions,
    agent.config.model.name,
  ]);

  function updateInspectorCollapsed(nextCollapsed: boolean) {
    setInspectorCollapsed(nextCollapsed);
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, String(nextCollapsed));
  }

  const flush = () => {
    const patch = { ...pendingRef.current };
    if (
      typeof patch.name !== "string" &&
      patch.body === undefined &&
      patch.content === undefined &&
      !patch.model
    ) {
      return;
    }
    pendingRef.current = {};
    submittedPatchRef.current = patch;
    setSaveState("saving");
    setOptimisticGitHubSync({
      status: "pending",
      error: null,
      baseStatus: agent.githubSyncStatus,
      baseError: agent.githubSyncError,
      baseCommitSha: agent.githubCommitSha,
      baseSyncedAt: agent.githubSyncedAt,
    });
    startTransition(async () => {
      try {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: agentQueryKeys.list(workspaceId) }),
          queryClient.cancelQueries({ queryKey: agentQueryKeys.detail(workspaceId, idOrPath) }),
          queryClient.cancelQueries({ queryKey: agentQueryKeys.detail(workspaceId, agent.id) }),
          agent.path
            ? queryClient.cancelQueries({
                queryKey: agentQueryKeys.detail(workspaceId, agent.path),
              })
            : Promise.resolve(),
        ]);

        const result = await updateAgent(agent.id, patch);
        if (!result?.agent) {
          throw new Error("Agent save did not return an updated agent.");
        }

        setSaveState("saved");
        updateAgentQueries(queryClient, workspaceId, result.agent, idOrPath);
        submittedPatchRef.current = null;
        if (result.pathChanged) {
          router.replace(`/agents/${result.path}`);
        }
      } catch (error) {
        submittedPatchRef.current = null;
        setSaveState("idle");
        setOptimisticGitHubSync(null);
        showError(error instanceof Error ? error.message : "Could not save agent.");
      }
    });
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-24 pt-10">
          <div className="flex items-center justify-between text-[12px] text-ink-muted">
            <Link
              href="/agents"
              prefetch
              onMouseEnter={() => {
                router.prefetch("/agents");
                void queryClient.prefetchQuery({
                  queryKey: agentQueryKeys.list(workspaceId),
                  queryFn: fetchAgents,
                  staleTime: AGENTS_QUERY_STALE_TIME_MS,
                });
              }}
              onFocus={() => {
                router.prefetch("/agents");
                void queryClient.prefetchQuery({
                  queryKey: agentQueryKeys.list(workspaceId),
                  queryFn: fetchAgents,
                  staleTime: AGENTS_QUERY_STALE_TIME_MS,
                });
              }}
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
                    const result = await createAgentSession(agent.id);
                    if (!result.ok) {
                      if ("redirectTo" in result) {
                        router.push(result.redirectTo);
                        return;
                      }
                      showError(result.error, "Could not start session");
                      return;
                    }
                    seedSessionQueries(queryClient, workspaceId, result.detail);
                    router.push(`/session/${result.session.id}`);
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
              key={agent.id}
              initialBody={initialBody}
              initialContent={agent.content}
              mentionItems={mentionItems}
              onChange={(body, content) => {
                const nextContent = content as TiptapDoc;
                setContent(nextContent);
                setHasEditorDraft(true);
                pendingRef.current.body = body;
                pendingRef.current.content = nextContent;
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
          path={agent.path}
          model={configPreview.model}
          modelIsExplicit={configPreview.modelIsExplicit}
          tools={configPreview.tools}
          brain={configPreview.brain}
          afterSession={configPreview.config.afterSession}
          saveState={saveState}
          githubStatus={githubSyncStatus}
          githubError={githubSyncError}
          githubCommitSha={githubCommitSha}
          githubSyncedAt={githubSyncedAt}
          fullConfig={configPreview.fullConfig}
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
    </main>
  );
}

type TiptapPreviewNode = {
  type?: string;
  text?: string;
  attrs?: unknown;
  content?: TiptapPreviewNode[];
};

function hasUsableMentionNodes(doc: TiptapDoc) {
  let hasMention = false;
  walkPreviewDocument(doc as TiptapPreviewNode, (node) => {
    if (node.type !== "mention") return;
    const attrs = node.attrs;
    if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return;
    const id = "id" in attrs && typeof attrs.id === "string" ? attrs.id.trim() : "";
    const label = "label" in attrs && typeof attrs.label === "string" ? attrs.label.trim() : "";
    if (id.length > 0 || label.length > 0) hasMention = true;
  });
  return hasMention;
}

function walkPreviewDocument(node: TiptapPreviewNode, visit: (node: TiptapPreviewNode) => void) {
  visit(node);
  node.content?.forEach((child) => walkPreviewDocument(child, visit));
}

function AgentInspector({
  name,
  path,
  model,
  modelIsExplicit,
  tools,
  brain,
  afterSession,
  saveState,
  githubStatus,
  githubError,
  githubCommitSha,
  githubSyncedAt,
  fullConfig,
}: {
  name: string;
  path: string | null;
  model: AgentModel;
  modelIsExplicit: boolean;
  tools: AgentTool[];
  brain: Array<{ path: string; type: "file" | "folder" }>;
  afterSession: AgentConfig["afterSession"];
  saveState: SaveState;
  githubStatus: string;
  githubError: string | null;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  fullConfig: string;
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
          label="Brain"
          countLabel={`${brain.length} ${brain.length === 1 ? "path" : "paths"}`}
        />
        {brain.length > 0 ? (
          <div className="space-y-2">
            {brain.map((reference) => (
              <ConfigItem
                key={reference.path}
                icon={Brain}
                label={brainReferenceLabel(reference.path)}
                description={reference.type === "folder" ? "Mounted folder" : "Mounted file"}
                tone="tool"
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[#deded9] bg-white/45 px-3 py-3 text-[12px] text-ink-muted">
            No brain paths mounted
          </div>
        )}
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

      <div>
        <InspectorHeader
          label="After-session"
          countLabel={afterSession?.enabled ? "enabled" : "off"}
        />
        {afterSession?.enabled ? (
          <AfterSessionConfigItem prompt={afterSession.prompt} />
        ) : (
          <div className="rounded-lg border border-dashed border-[#deded9] bg-white/45 px-3 py-3 text-[12px] text-ink-muted">
            Add #after-session to enable an idle memory update
          </div>
        )}
      </div>

      <GitHubSyncPanel
        saveState={saveState}
        status={githubStatus}
        error={githubError}
        commitSha={githubCommitSha}
        syncedAt={githubSyncedAt}
      />

      <FullConfigPanel value={fullConfig} />
    </div>
  );
}

function AfterSessionConfigItem({ prompt }: { prompt: string }) {
  return (
    <div className="rounded-lg border border-[#d8e1d7] bg-[#f5faf6] px-3 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/70 bg-white/70 text-ink-muted">
          <Clock3 size={14} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink">
          {prompt}
        </div>
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

function FullConfigPanel({ value }: { value: string }) {
  return (
    <div>
      <div className="mb-3 text-[12px] font-medium text-ink">Full config</div>
      <pre className="max-h-[360px] overflow-auto rounded-lg border border-[#e2e2de] bg-white/60 p-3 text-[11px] leading-5 text-ink-muted">
        <code>{value}</code>
      </pre>
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

function buildConfigPreview({
  title,
  content,
  fallback,
  selectedModelId,
  repositories,
  triggers,
  useDerivedConfig,
}: {
  title: string;
  content: TiptapDoc;
  fallback: AgentConfig;
  selectedModelId: AgentModelId;
  repositories: AgentDetailPayload["githubIntegrationRepositories"];
  triggers: AgentConfig["triggers"];
  useDerivedConfig: boolean;
}) {
  const config = useDerivedConfig
    ? derivePreviewConfigFromTiptapDoc({
        title,
        content,
        model: selectedModelId,
        repositories,
        triggers,
      }).config
    : {
        ...fallback,
        title: normalizePreviewTitle(title),
        model: {
          ...fallback.model,
          name: selectedModelId,
        },
      };
  const model =
    findModel(config.model.name) ?? findModel(fallback.model.name) ?? findModel(DEFAULT_MODEL_ID);
  const tools = config.tools.flatMap((toolConfig) => {
    const tool = findTool(toolConfig.id);
    return tool ? [tool] : [];
  });

  return {
    model: model!,
    modelIsExplicit: config.model.name !== DEFAULT_MODEL_ID,
    tools,
    brain: config.brain,
    config,
    fullConfig: serializeAgentFrontmatter({
      title: config.title,
      model: config.model.name,
      tools: config.tools,
      brain: config.brain,
      integrations: config.integrations,
      triggers: config.triggers,
    }),
  };
}

function normalizePreviewTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function brainReferenceLabel(path: string) {
  return path === "/" ? "brain/" : `brain/${path}`;
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
