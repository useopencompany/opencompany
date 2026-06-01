"use client";

import {
  agentBundleDir,
  agentDefinitionFileNameForPath,
  cronForSchedulePreset,
  normalizeScheduleTimezone,
  schedulePresetFromCron,
  scheduleSummary,
  serializeAgentFrontmatter,
} from "@opencompany/agent-runtime";
import type {
  AgentConfig,
  AgentModelId,
  AgentReference,
  AgentScheduleTriggerConfig,
  AgentToolId,
  AgentTriggerConfig,
  TiptapDoc,
} from "@opencompany/agent-runtime/types";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Clock3,
  Cloud,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  Loader2,
  type LucideIcon,
  MessagesSquare,
  PanelRight,
  Play,
  Trash2,
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
import { DeleteAgentDialog } from "@/components/agents/DeleteAgentDialog";
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
import { deleteAgent, updateAgent } from "@/lib/agents/actions";
import type { AgentBundleFilePayload as AgentFolderFilePayload } from "@/lib/agents/bundle-files";
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
const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

// Duplicated from AgentsView.tsx — extracting to a shared module is tracked
// as a follow-up cleanup. Without this re-throw, Next.js never gets to
// navigate when a server action calls redirect().
function isNextRedirectError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
  );
}

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
      const agentSyncing =
        data?.githubSyncStatus === "pending" || data?.githubSyncStatus === "syncing";
      const folderSyncing = data?.bundleFiles.some(
        (file) => file.githubSyncStatus === "pending" || file.githubSyncStatus === "syncing",
      );
      return agentSyncing || folderSyncing ? 2500 : false;
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
  const [triggers, setTriggers] = useState<AgentConfig["triggers"]>(agent.config.triggers);
  const [selectedModelId, setSelectedModelId] = useState<AgentModelId>(
    findModel(agent.config.model.name)?.id ?? DEFAULT_MODEL_ID,
  );
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isDeleting, startDeleteTransition] = useTransition();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(getStoredInspectorCollapsed);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<AgentScheduleTriggerConfig | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [optimisticGitHubSync, setOptimisticGitHubSync] = useState<OptimisticGitHubSync | null>(
    null,
  );
  const pendingRef = useRef<{
    name?: string;
    body?: string;
    content?: TiptapDoc;
    model?: AgentModelId;
    config?: { triggers: AgentConfig["triggers"] };
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
        agents: agent.workspaceAgents,
        triggers,
        useDerivedConfig: hasEditorDraft || hasUsableMentionNodes(content),
      }),
    [
      agent.config,
      agent.githubIntegrationRepositories,
      agent.workspaceAgents,
      content,
      hasEditorDraft,
      name,
      selectedModelId,
      triggers,
    ],
  );
  const selectedModel = findModel(selectedModelId) ?? findModel(DEFAULT_MODEL_ID)!;
  const SelectedModelIcon = selectedModel.icon;
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
  const mentionItems: AgentMentionItem[] = useMemo(() => {
    const enabledMcpToolIds: AgentToolId[] = [];
    if (agent.mcp.mcpEnabled && agent.mcp.linearConfigured) enabledMcpToolIds.push("linear");
    if (agent.mcp.mcpEnabled && agent.mcp.slackConfigured) enabledMcpToolIds.push("slack");
    return buildAgentMentionItems(agent.usableGitHubIntegrationRepositories, agent.brainPaths, {
      enabledMcpToolIds,
      agents: agent.workspaceAgents,
    });
  }, [
    agent.brainPaths,
    agent.mcp.linearConfigured,
    agent.mcp.mcpEnabled,
    agent.mcp.slackConfigured,
    agent.usableGitHubIntegrationRepositories,
    agent.workspaceAgents,
  ]);

  useEffect(() => {
    if (
      pendingRef.current.name !== undefined ||
      pendingRef.current.body !== undefined ||
      pendingRef.current.content !== undefined ||
      pendingRef.current.model !== undefined ||
      pendingRef.current.config !== undefined ||
      submittedPatchRef.current
    ) {
      return;
    }
    setName(agent.name);
    setContent(agent.content);
    setHasEditorDraft(false);
    setTriggers(agent.config.triggers);
    setSelectedModelId(findModel(agent.config.model.name)?.id ?? DEFAULT_MODEL_ID);
  }, [
    agent.id,
    agent.name,
    agent.body,
    agent.content,
    agent.config.instructions,
    agent.config.model.name,
    agent.config.triggers,
  ]);

  function updateInspectorCollapsed(nextCollapsed: boolean) {
    setInspectorCollapsed(nextCollapsed);
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, String(nextCollapsed));
  }

  const flush = () => {
    const patch = { ...pendingRef.current };
    // Drop an empty/whitespace-only name from the server patch so a blank
    // input never overwrites the stored name with "Untitled agent". We still
    // clear it from pendingRef below so the useEffect doesn't clobber the
    // in-progress typed value.
    const serverPatch = { ...patch };
    if (typeof serverPatch.name === "string" && !serverPatch.name.trim()) {
      delete serverPatch.name;
    }
    if (
      serverPatch.name === undefined &&
      serverPatch.body === undefined &&
      serverPatch.content === undefined &&
      serverPatch.model === undefined &&
      serverPatch.config === undefined
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

        const result = await updateAgent(agent.id, serverPatch);
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

  const updateTriggers = (next: AgentConfig["triggers"]) => {
    setTriggers(next);
    pendingRef.current.config = { triggers: next };
    schedule();
  };

  const saveScheduleTrigger = (trigger: AgentScheduleTriggerConfig) => {
    updateTriggers(upsertScheduleTrigger(triggers, trigger));
    setShowScheduleDialog(false);
    setEditingSchedule(null);
  };

  const removeScheduleTrigger = (triggerId: string) => {
    updateTriggers(
      triggers.filter(
        (trigger) => !(trigger.type === "agent.schedule" && trigger.id === triggerId),
      ),
    );
    setShowScheduleDialog(false);
    setEditingSchedule(null);
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
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-subtle/70"
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
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink/85 hover:bg-surface-muted"
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
              <SelectTrigger className="h-6 w-auto border-0 bg-transparent px-1.5 text-[11.5px] font-medium text-ink-muted shadow-none hover:bg-surface-subtle/70 focus:ring-0 focus-visible:ring-0 [&>svg]:ml-0.5 [&>svg]:h-3 [&>svg]:w-3">
                <span className="flex min-w-0 items-center gap-1.5">
                  <SelectedModelIcon size={12} strokeWidth={1.9} className="shrink-0" />
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
                      {models.map((model) => {
                        const ModelIcon = model.icon;
                        return (
                          <SelectItem key={model.id} value={model.id}>
                            <span className="flex min-w-0 items-center gap-1.5">
                              <ModelIcon
                                size={12.5}
                                strokeWidth={1.85}
                                className="shrink-0 text-ink-muted"
                              />
                              <span className="truncate">{model.displayLabel}</span>
                            </span>
                          </SelectItem>
                        );
                      })}
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
              onMentionSelect={(item) => {
                if (item.kind !== "schedule") return;
                setEditingSchedule(null);
                setShowScheduleDialog(true);
              }}
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
          className="fixed inset-0 z-30 bg-ink/[0.06] lg:hidden"
          onClick={() => updateInspectorCollapsed(true)}
        />
      )}

      <aside
        className={`shrink-0 overflow-y-auto border-l border-border bg-surface-raised/95 px-5 py-4 shadow-[-16px_0_36px_rgba(0,0,0,0.08)] backdrop-blur-md transition-transform duration-200 ease-out lg:bg-surface-raised/80 lg:py-8 lg:shadow-none lg:backdrop-blur-0 ${
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
          agents={configPreview.agents}
          afterSession={configPreview.config.afterSession}
          schedules={configPreview.config.triggers.filter(
            (trigger): trigger is AgentScheduleTriggerConfig => trigger.type === "agent.schedule",
          )}
          saveState={saveState}
          githubStatus={githubSyncStatus}
          githubError={githubSyncError}
          githubCommitSha={githubCommitSha}
          githubSyncedAt={githubSyncedAt}
          fullConfig={configPreview.fullConfig}
          folderFiles={agent.bundleFiles}
          onAddSchedule={() => {
            setEditingSchedule(null);
            setShowScheduleDialog(true);
          }}
          onEditSchedule={(trigger) => {
            setEditingSchedule(trigger);
            setShowScheduleDialog(true);
          }}
          onRemoveSchedule={removeScheduleTrigger}
          onDeleteClick={() => setShowDeleteDialog(true)}
        />
      </aside>

      {showScheduleDialog ? (
        <ScheduleDialog
          schedule={editingSchedule}
          existingIds={triggers.map((trigger) => trigger.id)}
          onClose={() => {
            setShowScheduleDialog(false);
            setEditingSchedule(null);
          }}
          onSave={saveScheduleTrigger}
          {...(editingSchedule
            ? { onRemove: () => removeScheduleTrigger(editingSchedule.id) }
            : {})}
        />
      ) : null}

      <DeleteAgentDialog
        agentName={agent.name}
        isOpen={showDeleteDialog}
        isPending={isDeleting}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={() => {
          startDeleteTransition(async () => {
            try {
              const result = await deleteAgent(agent.id);
              if (!result.ok) {
                setShowDeleteDialog(false);
                showError(result.error, "Could not delete agent");
                return;
              }
              // Close the dialog before navigating so it doesn't stay open on
              // the success path (mirrors the error branch above).
              setShowDeleteDialog(false);
              queryClient.setQueryData<AgentListItemPayload[]>(
                agentQueryKeys.list(workspaceId),
                (current) => (current ?? []).filter((item) => item.id !== agent.id),
              );
              router.push("/agents");
            } catch (err) {
              // Let Next.js redirect digests bubble — currentWorkspace() throws
              // NEXT_REDIRECT for unauthenticated / incomplete-onboarding users
              // and the framework needs to see it to navigate.
              if (isNextRedirectError(err)) throw err;
              // Server actions can throw (e.g. non-admin requireAdmin guard);
              // surface as a toast instead of bubbling to the error boundary.
              setShowDeleteDialog(false);
              showError(
                err instanceof Error ? err.message : "Could not delete agent",
                "Could not delete agent",
              );
            }
          });
        }}
      />

      <button
        type="button"
        aria-label={inspectorCollapsed ? "Expand agent details" : "Collapse agent details"}
        aria-expanded={!inspectorCollapsed}
        onClick={() => updateInspectorCollapsed(!inspectorCollapsed)}
        className="fixed right-6 top-10 z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
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

function AgentFolderIcon({ path }: { path: string }) {
  const Icon = isCodePath(path) ? FileCode2 : FileText;
  return <Icon size={13} strokeWidth={1.85} className="shrink-0 text-ink-muted" />;
}

function isCodePath(path: string) {
  return /\.(ts|tsx|js|jsx|json|css|html|yaml|yml)$/i.test(path);
}

type AgentFolderRow =
  | { kind: "folder"; path: string; name: string; depth: number }
  | { kind: "file"; file: AgentFolderFilePayload; depth: number };

function AgentFolderPanel({
  bundleDir,
  definitionFileName,
  files,
}: {
  bundleDir: string;
  definitionFileName: string;
  files: AgentFolderFilePayload[];
}) {
  const rows = useMemo(() => buildAgentFolderRows(files), [files]);
  const fileCount = files.length + 1;

  return (
    <div>
      <InspectorHeader
        label="Agent folder"
        countLabel={`${fileCount} ${fileCount === 1 ? "file" : "files"}`}
      />
      <div className="overflow-hidden rounded-lg border border-border bg-surface/60 py-1">
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-[12px] font-medium text-ink">
          <Folder size={13} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
          <span className="truncate font-mono text-[11.5px]">{bundleDir}/</span>
        </div>
        <div className="py-1">
          <div className="flex min-w-0 items-center gap-2 px-3 py-1 text-[12px] text-ink">
            <AgentFolderIcon path={definitionFileName} />
            <span className="min-w-0 flex-1 truncate" title={`${bundleDir}/${definitionFileName}`}>
              {definitionFileName}
            </span>
          </div>
          {rows.map((row) =>
            row.kind === "folder" ? (
              <div
                key={row.path}
                className="flex min-w-0 items-center gap-2 px-3 py-1 text-[12px] text-ink-muted"
                style={{ paddingLeft: `${12 + row.depth * 16}px` }}
              >
                <Folder size={13} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
                <span className="truncate font-medium" title={row.path}>
                  {row.name}
                </span>
              </div>
            ) : (
              <div
                key={row.file.path}
                className="flex min-w-0 items-center gap-2 px-3 py-1 text-[12px] text-ink"
                style={{ paddingLeft: `${12 + row.depth * 16}px` }}
              >
                <AgentFolderIcon path={row.file.relativePath} />
                <span
                  className="min-w-0 flex-1 truncate"
                  title={`${bundleDir}/${row.file.relativePath}`}
                >
                  {fileName(row.file.relativePath)}
                </span>
                {row.file.githubSyncStatus === "pending" ||
                row.file.githubSyncStatus === "syncing" ? (
                  <Loader2 size={12} strokeWidth={1.9} className="shrink-0 animate-spin" />
                ) : null}
                {row.file.githubSyncStatus === "failed" ? (
                  <CircleAlert size={12} strokeWidth={1.9} className="shrink-0 text-danger" />
                ) : null}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function buildAgentFolderRows(files: AgentFolderFilePayload[]): AgentFolderRow[] {
  const rows: AgentFolderRow[] = [];
  const seenFolders = new Set<string>();

  for (const file of files.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const parts = file.relativePath.split("/").filter(Boolean);
    let currentPath = "";

    for (const [index, part] of parts.slice(0, -1).entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (seenFolders.has(currentPath)) continue;
      seenFolders.add(currentPath);
      rows.push({ kind: "folder", path: currentPath, name: part, depth: index });
    }

    rows.push({ kind: "file", file, depth: Math.max(parts.length - 1, 0) });
  }

  return rows;
}

function fileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function AgentInspector({
  name,
  path,
  model,
  modelIsExplicit,
  tools,
  brain,
  agents,
  afterSession,
  schedules,
  saveState,
  githubStatus,
  githubError,
  githubCommitSha,
  githubSyncedAt,
  fullConfig,
  folderFiles,
  onAddSchedule,
  onEditSchedule,
  onRemoveSchedule,
  onDeleteClick,
}: {
  name: string;
  path: string | null;
  model: AgentModel;
  modelIsExplicit: boolean;
  tools: AgentTool[];
  brain: Array<{ path: string; type: "file" | "folder" }>;
  agents: AgentReference[];
  afterSession: AgentConfig["afterSession"];
  schedules: AgentScheduleTriggerConfig[];
  saveState: SaveState;
  githubStatus: string;
  githubError: string | null;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  fullConfig: string;
  folderFiles: AgentFolderFilePayload[];
  onAddSchedule: () => void;
  onEditSchedule: (trigger: AgentScheduleTriggerConfig) => void;
  onRemoveSchedule: (triggerId: string) => void;
  onDeleteClick: () => void;
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
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
            No brain paths mounted
          </div>
        )}
      </div>

      <div>
        <InspectorHeader
          label="Agents"
          countLabel={`${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
        />
        {agents.length > 0 ? (
          <div className="space-y-2">
            {agents.map((agent) => (
              <ConfigItem
                key={agent.path}
                icon={MessagesSquare}
                label={agent.name}
                description={agent.path}
                tone="tool"
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
            No agents selected
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
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
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
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
            Add #after-session to enable an idle memory update
          </div>
        )}
      </div>

      <ScheduleConfigPanel
        schedules={schedules}
        onAdd={onAddSchedule}
        onEdit={onEditSchedule}
        onRemove={onRemoveSchedule}
      />

      <GitHubSyncPanel
        saveState={saveState}
        status={githubStatus}
        error={githubError}
        commitSha={githubCommitSha}
        syncedAt={githubSyncedAt}
      />

      <FullConfigPanel value={fullConfig} />

      <AgentFolderPanel
        bundleDir={path ? agentBundleDir(path) : "agents/agent"}
        definitionFileName={path ? agentDefinitionFileNameForPath(path) : "agent.agent"}
        files={folderFiles}
      />

      <div className="border-t border-border pt-6">
        <button
          type="button"
          onClick={onDeleteClick}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger-bg"
        >
          <Trash2 size={13} strokeWidth={1.9} />
          Delete agent
        </button>
      </div>
    </div>
  );
}

function AfterSessionConfigItem({ prompt }: { prompt: string }) {
  return (
    <div className="rounded-lg border border-success-border bg-success-bg px-3 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface/70 bg-surface/70 text-ink-muted">
          <Clock3 size={14} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink">
          {prompt}
        </div>
      </div>
    </div>
  );
}

function ScheduleConfigPanel({
  schedules,
  onAdd,
  onEdit,
  onRemove,
}: {
  schedules: AgentScheduleTriggerConfig[];
  onAdd: () => void;
  onEdit: (trigger: AgentScheduleTriggerConfig) => void;
  onRemove: (triggerId: string) => void;
}) {
  return (
    <div>
      <InspectorHeader
        label="Schedules"
        countLabel={`${schedules.length} ${schedules.length === 1 ? "schedule" : "schedules"}`}
      />
      <div className="space-y-2">
        {schedules.map((trigger) => (
          <div key={trigger.id} className="rounded-lg border border-border bg-surface/55 px-3 py-3">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface/70 bg-surface/70 text-ink-muted">
                <Clock3 size={14} strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-ink">
                    {scheduleSummary(trigger)}
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${
                      trigger.enabled
                        ? "border-success-border bg-success-bg text-success"
                        : "border-border bg-surface text-ink-subtle"
                    }`}
                  >
                    {trigger.enabled ? "on" : "off"}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                  {trigger.timezone}
                </div>
                <div className="mt-2 whitespace-pre-wrap break-words text-[11.5px] leading-4 text-ink-muted">
                  {trigger.prompt}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(trigger)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-muted hover:bg-surface-muted"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(trigger.id)}
                    className="rounded-md px-2 py-1 text-[11.5px] font-medium text-danger hover:bg-danger-bg"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
        {schedules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-3 py-3 text-[12px] text-ink-muted">
            No scheduled runs
          </div>
        ) : null}
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] font-medium text-ink/85 hover:bg-surface-muted"
        >
          <Clock3 size={12} strokeWidth={1.9} />
          Run every...
        </button>
      </div>
    </div>
  );
}

type ScheduleFormKind = "minutes" | "hours" | "daily" | "weekdays" | "weekly";

function ScheduleDialog({
  schedule,
  existingIds,
  onClose,
  onSave,
  onRemove,
}: {
  schedule: AgentScheduleTriggerConfig | null;
  existingIds: string[];
  onClose: () => void;
  onSave: (trigger: AgentScheduleTriggerConfig) => void;
  onRemove?: () => void;
}) {
  const initial = scheduleFormFromTrigger(schedule);
  const [kind, setKind] = useState<ScheduleFormKind>(initial.kind);
  const [interval, setInterval] = useState(initial.interval);
  const [time, setTime] = useState(initial.time);
  const [dayOfWeek, setDayOfWeek] = useState(initial.dayOfWeek);
  const [timezone, setTimezone] = useState(initial.timezone || browserTimezone() || "UTC");
  const [prompt, setPrompt] = useState(initial.prompt);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("Prompt is required.");
      return;
    }

    const [hour, minute] = parseTimeInput(time);
    const cron =
      kind === "minutes"
        ? cronForSchedulePreset({ kind, interval })
        : kind === "hours"
          ? cronForSchedulePreset({ kind, interval })
          : kind === "daily"
            ? cronForSchedulePreset({ kind, hour, minute })
            : kind === "weekdays"
              ? cronForSchedulePreset({ kind, hour, minute })
              : cronForSchedulePreset({ kind, dayOfWeek, hour, minute });

    onSave({
      id: schedule?.id ?? uniqueScheduleId(trimmedPrompt, existingIds),
      type: "agent.schedule",
      cron,
      timezone: normalizeScheduleTimezone(timezone),
      prompt: trimmedPrompt,
      enabled,
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/25 px-4">
      <div className="w-full max-w-[420px] rounded-lg border border-border bg-surface-raised p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-ink">
            {schedule ? "Edit schedule" : "Run every..."}
          </div>
          <label className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase text-ink-subtle">Frequency</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ScheduleFormKind)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
            >
              <option value="minutes">Every few minutes</option>
              <option value="hours">Every few hours</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          {kind === "minutes" || kind === "hours" ? (
            <label className="block">
              <span className="text-[11px] font-medium uppercase text-ink-subtle">Every</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={kind === "minutes" ? 59 : 23}
                  value={interval}
                  onChange={(event) => setInterval(Number.parseInt(event.target.value, 10) || 1)}
                  className="h-9 w-20 rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                />
                <span className="text-[12.5px] text-ink-muted">
                  {kind === "minutes" ? "minutes" : "hours"}
                </span>
              </div>
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {kind === "weekly" ? (
                <label className="block">
                  <span className="text-[11px] font-medium uppercase text-ink-subtle">Day</span>
                  <select
                    value={dayOfWeek}
                    onChange={(event) => setDayOfWeek(Number.parseInt(event.target.value, 10))}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                  >
                    {WEEKDAYS.map((day) => (
                      <option key={day.value} value={day.value}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="block">
                <span className="text-[11px] font-medium uppercase text-ink-subtle">Time</span>
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                />
              </label>
            </div>
          )}

          <label className="block">
            <span className="text-[11px] font-medium uppercase text-ink-subtle">Timezone</span>
            <input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-medium uppercase text-ink-subtle">Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setError(null);
              }}
              rows={4}
              className="mt-1 w-full resize-none rounded-md border border-border bg-surface px-2 py-2 text-[13px] leading-5 text-ink outline-none focus:ring-1 focus:ring-ink/20"
              placeholder="Tell the agent exactly what to do on each run."
            />
          </label>
        </div>

        {error ? <div className="mt-3 text-[12px] font-medium text-danger">{error}</div> : null}

        <div className="mt-5 flex items-center justify-between">
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md px-2 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger-bg"
            >
              Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-surface-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas hover:bg-ink/90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function scheduleFormFromTrigger(schedule: AgentScheduleTriggerConfig | null): {
  kind: ScheduleFormKind;
  interval: number;
  time: string;
  dayOfWeek: number;
  timezone: string;
  prompt: string;
  enabled: boolean;
} {
  const preset = schedule ? schedulePresetFromCron(schedule.cron) : null;
  const timezone = schedule?.timezone ?? browserTimezone() ?? "UTC";
  const prompt = schedule?.prompt ?? "";
  const enabled = schedule?.enabled ?? true;

  if (preset?.kind === "minutes") {
    return {
      kind: "minutes",
      interval: preset.interval,
      time: "09:00",
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "hours") {
    return {
      kind: "hours",
      interval: preset.interval,
      time: "09:00",
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "daily" || preset?.kind === "weekdays") {
    return {
      kind: preset.kind,
      interval: 1,
      time: `${String(preset.hour).padStart(2, "0")}:${String(preset.minute).padStart(2, "0")}`,
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "weekly") {
    return {
      kind: "weekly",
      interval: 1,
      time: `${String(preset.hour).padStart(2, "0")}:${String(preset.minute).padStart(2, "0")}`,
      dayOfWeek: preset.dayOfWeek,
      timezone,
      prompt,
      enabled,
    };
  }

  return {
    kind: "weekdays",
    interval: 1,
    time: "09:00",
    dayOfWeek: 1,
    timezone,
    prompt,
    enabled,
  };
}

function browserTimezone() {
  if (typeof window === "undefined") return null;
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

function parseTimeInput(value: string) {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(hour) ? hour! : 9, Number.isFinite(minute) ? minute! : 0] as const;
}

function uniqueScheduleId(prompt: string, existingIds: string[]) {
  const base =
    prompt
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "schedule";
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function InspectorHeader({ label, countLabel }: { label: string; countLabel: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
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
      ? "border-info-border bg-info-bg"
      : tone === "tool"
        ? "border-success-border bg-success-bg"
        : "border-border bg-surface/55";

  return (
    <div className={`rounded-lg border px-3 py-3 ${toneClass}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface/70 bg-surface/70 text-ink-muted">
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

      <div className="rounded-lg border border-border bg-surface/60 p-3">
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
          <div className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[11.5px] leading-4 text-danger">
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
      <pre className="max-h-[360px] overflow-auto rounded-lg border border-border bg-surface/60 p-3 text-[11px] leading-5 text-ink-muted">
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
                ? "bg-success"
                : step.state === "active"
                  ? "bg-warning"
                  : step.state === "danger"
                    ? "bg-danger"
                    : "bg-border"
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
  agents,
  triggers,
  useDerivedConfig,
}: {
  title: string;
  content: TiptapDoc;
  fallback: AgentConfig;
  selectedModelId: AgentModelId;
  repositories: AgentDetailPayload["githubIntegrationRepositories"];
  agents: AgentReference[];
  triggers: AgentConfig["triggers"];
  useDerivedConfig: boolean;
}) {
  const config = useDerivedConfig
    ? derivePreviewConfigFromTiptapDoc({
        title,
        content,
        model: selectedModelId,
        repositories,
        agents,
        preferredRepositories: fallback.integrations.github.repositories.filter(
          (repository) => repository.binding,
        ),
        triggers,
      }).config
    : {
        ...fallback,
        title: normalizePreviewTitle(title),
        model: {
          ...fallback.model,
          name: selectedModelId,
        },
        triggers,
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
    agents: config.agents ?? [],
    config,
    fullConfig: serializeAgentFrontmatter({
      title: config.title,
      model: config.model.name,
      tools: config.tools,
      brain: config.brain,
      agents: config.agents ?? [],
      integrations: config.integrations,
      triggers: config.triggers,
    }),
  };
}

function normalizePreviewTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function upsertScheduleTrigger(
  triggers: AgentTriggerConfig[],
  next: AgentScheduleTriggerConfig,
): AgentTriggerConfig[] {
  const index = triggers.findIndex(
    (trigger) => trigger.type === "agent.schedule" && trigger.id === next.id,
  );
  if (index === -1) return [...triggers, next];
  return triggers.map((trigger, triggerIndex) => (triggerIndex === index ? next : trigger));
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
  if (tone === "success") return "border-success-border bg-success-bg text-success";
  if (tone === "danger") return "border-danger-border bg-danger-bg text-danger";
  if (tone === "progress") return "border-warning-border bg-warning-bg text-warning";
  return "border-border bg-surface text-ink-muted";
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
