"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatMcpClient } from "@opencompany/db/goat-schema";
import { useLiveQuery } from "@tanstack/react-db";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { GoatTaskView } from "@/components/GoatSurface";
import {
  deriveGoatChatState,
  GOAT_PINNED_CHAT_LIMIT,
  type GoatChatSummaryView,
} from "@/lib/chat-ui";
import type { GoatFeatureFlags } from "@/lib/feature-flags";
import { isRecentGoatHomeActivity } from "@/lib/home-activity";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import {
  createGoatCollections,
  type GoatChatSessionRow,
  type GoatCodexChatSessionRow,
  type GoatIntegrationRow,
  type GoatTaskRow,
  type GoatTaskScheduleRow,
} from "@/lib/task-collections";
import type { GoatTaskScheduleView } from "@/lib/task-schedules";

// Durable background chats for every engine persist runtime in goat.codex_chat_sessions.
// The name is historical: OpenCompany, Codex, and Claude Code all use it now.
function hasDurableChatRuntime(engine: GoatChatSessionRow["engine"]): boolean {
  return engine === "opencompany" || engine === "codex" || engine === "claude_code";
}

type GoatUserView = {
  // Scopes client-side chat attachment uploads (blob prefix goat-chat/{id}/).
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

// Directory of workspace members used to render attribution (brain document
// "created by", etc.) from a workos user id.
export type GoatWorkspaceMemberView = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export type GoatWorkspaceView = {
  id: string;
  name: string;
  role: "admin" | "member";
};

export type GoatBrainSummaryView = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "workspace" | "restricted";
};

export type GoatAppInitialData = {
  user: GoatUserView;
  workspace: GoatWorkspaceView;
  workspaces: GoatWorkspaceView[];
  workspaceMembers: GoatWorkspaceMemberView[];
  brains: GoatBrainSummaryView[];
  activeBrain: GoatBrainSummaryView | null;
  tasks: GoatTaskView[];
  schedules: GoatTaskScheduleView[];
  recentChats: GoatChatSummaryView[];
  integrations: GoatIntegrationState;
  featureFlags: GoatFeatureFlags;
  codexConnected: boolean;
  claudeCodeConnected: boolean;
  chatResumeEnabled: boolean;
  mcpSetup: {
    preferredClient: GoatMcpClient | null;
    completedAt: string | null;
  };
};

type GoatAppData = GoatAppInitialData & {
  taskRows: GoatTaskRow[];
  tasksReady: boolean;
  // Closed (archived) chats, surfaced in the command palette so the user can
  // search and restore them. Derived from the same live query as recentChats —
  // closed rows already stream to the client, they're just hidden elsewhere.
  archivedChats: GoatChatSummaryView[];
};

// Keeps the command palette responsive; older archived chats are still
// reachable by narrowing the search (which re-filters this bounded list).
const GOAT_ARCHIVED_CHAT_LIMIT = 50;

const GoatAppDataContext = createContext<GoatAppData | null>(null);
const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

export function GoatAppDataProvider({
  initialData,
  children,
}: {
  initialData: GoatAppInitialData;
  children: ReactNode;
}) {
  const initialValue = useMemo(() => initialGoatAppData(initialData), [initialData]);
  const [liveSnapshot, setLiveSnapshot] = useState<{
    initialData: GoatAppInitialData;
    value: GoatAppData;
  } | null>(null);
  const updateLiveData = useCallback(
    (value: GoatAppData) => setLiveSnapshot({ initialData, value }),
    [initialData],
  );
  const liveSnapshotMatchesScope =
    liveSnapshot?.value.user.workosUserId === initialData.user.workosUserId &&
    liveSnapshot.value.workspace.id === initialData.workspace.id;
  const value =
    liveSnapshot?.initialData === initialData || liveSnapshotMatchesScope
      ? liveSnapshot.value
      : initialValue;

  return (
    <GoatAppDataContext.Provider value={value}>
      {children}
      <GoatAppLiveDataSync initialData={initialData} onData={updateLiveData} />
    </GoatAppDataContext.Provider>
  );
}

function GoatAppLiveDataSync({
  initialData,
  onData,
}: {
  initialData: GoatAppInitialData;
  onData: (value: GoatAppData) => void;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  return hydrated ? (
    <GoatAppLiveDataSubscriptions initialData={initialData} onData={onData} />
  ) : null;
}

function GoatAppLiveDataSubscriptions({
  initialData,
  onData,
}: {
  initialData: GoatAppInitialData;
  onData: (value: GoatAppData) => void;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  // Keep task rows live even while the feature is disabled so every surface has
  // current data as soon as the user enables it. The UI gates on the feature flag.
  const { data: taskRows, isLoading: tasksLoading } = useLiveQuery(
    (q) => q.from({ task: collections.tasks }),
    [collections],
  );
  const { data: scheduleRows, isLoading: schedulesLoading } = useLiveQuery(
    (q) =>
      initialData.featureFlags.taskSpawning
        ? q.from({ schedule: collections.taskSchedules })
        : undefined,
    [initialData.featureFlags.taskSpawning, collections],
  );
  const { data: chatSessionRows, isLoading: chatsLoading } = useLiveQuery((q) =>
    q.from({ session: collections.chatSessions }),
  );
  const { data: codexChatSessionRows } = useLiveQuery((q) =>
    q.from({ codexSession: collections.codexChatSessions }),
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );

  const tasks = useMemo(() => {
    if (tasksLoading && !taskRows?.length) return initialData.tasks;
    return ((taskRows ?? []) as GoatTaskRow[])
      .map(taskRowToView)
      .filter(
        (task) =>
          !task.archivedAt &&
          (task.status === "queued" ||
            task.status === "running" ||
            isRecentGoatHomeActivity(task.createdAt)),
      )
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [initialData.tasks, taskRows, tasksLoading]);

  const schedules = useMemo(() => {
    if (!initialData.featureFlags.taskSpawning) return [];
    if (schedulesLoading && !scheduleRows?.length) return initialData.schedules;
    return ((scheduleRows ?? []) as GoatTaskScheduleRow[])
      .filter((row) => !row.deleted_at)
      .map(taskScheduleRowToView)
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [
    initialData.featureFlags.taskSpawning,
    initialData.schedules,
    scheduleRows,
    schedulesLoading,
  ]);

  const recentChats = useMemo(() => {
    if (chatsLoading && !chatSessionRows?.length) return initialData.recentChats;
    const initialById = new Map(initialData.recentChats.map((chat) => [chat.id, chat]));
    const codexRuntimeByChatId = new Map(
      ((codexChatSessionRows ?? []) as GoatCodexChatSessionRow[]).map((row) => [
        row.chat_session_id,
        {
          status: row.status,
          error: row.error,
          updatedAt: row.updated_at,
        },
      ]),
    );
    const toSummary = (row: GoatChatSessionRow) => {
      const initial = initialById.get(row.id);
      const liveCodexRuntime = codexRuntimeByChatId.get(row.id);
      const codexRuntime = hasDurableChatRuntime(row.engine)
        ? (liveCodexRuntime ?? initial?.codexRuntime ?? null)
        : null;
      return {
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: initial?.codexComposerSettings ?? null,
        codexRuntime,
        state: deriveGoatChatState({
          updatedAt: row.updated_at,
          lastSeenAt: row.last_seen_at,
          codexRuntime,
        }),
        preview: initial?.preview ?? "No messages yet.",
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
        pinnedAt: row.pinned_at,
      };
    };
    const openRows = ((chatSessionRows ?? []) as GoatChatSessionRow[]).filter(
      (row) => !row.closed_at && row.kind !== "task",
    );
    const activeRuntimeChatIds = new Set(
      ((codexChatSessionRows ?? []) as GoatCodexChatSessionRow[])
        .filter(
          (row) => row.status === "queued" || row.status === "starting" || row.status === "running",
        )
        .map((row) => row.chat_session_id),
    );
    // Pinned chats stay visible regardless of the recency window, with separate
    // caps for pinned and unpinned hydration (mirrors listOpenSessions on the server).
    const pinned = openRows
      .filter((row) => row.pinned_at)
      .toSorted(
        (a, b) => new Date(b.pinned_at ?? 0).getTime() - new Date(a.pinned_at ?? 0).getTime(),
      )
      .slice(0, GOAT_PINNED_CHAT_LIMIT)
      .map(toSummary);
    const activeRuntime = openRows
      .filter((row) => !row.pinned_at && activeRuntimeChatIds.has(row.id))
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map(toSummary);
    const recent = openRows
      .filter(
        (row) =>
          !row.pinned_at &&
          !activeRuntimeChatIds.has(row.id) &&
          isRecentGoatHomeActivity(row.updated_at),
      )
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 8)
      .map(toSummary);
    return [...pinned, ...activeRuntime, ...recent];
  }, [chatSessionRows, chatsLoading, codexChatSessionRows, initialData.recentChats]);

  const archivedChats = useMemo<GoatChatSummaryView[]>(() => {
    const codexRuntimeByChatId = new Map(
      ((codexChatSessionRows ?? []) as GoatCodexChatSessionRow[]).map((row) => [
        row.chat_session_id,
        { status: row.status, error: row.error, updatedAt: row.updated_at },
      ]),
    );
    return ((chatSessionRows ?? []) as GoatChatSessionRow[])
      .filter((row) => row.closed_at && row.kind !== "task")
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, GOAT_ARCHIVED_CHAT_LIMIT)
      .map((row) => ({
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: null,
        codexRuntime: hasDurableChatRuntime(row.engine)
          ? (codexRuntimeByChatId.get(row.id) ?? null)
          : null,
        state: "done_seen",
        preview: "Archived",
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
        pinnedAt: null,
        archived: true,
      }));
  }, [chatSessionRows, codexChatSessionRows]);

  const integrations = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialData.integrations;
    const liveIntegrations = goatIntegrationStateFromRows(
      (integrationRows ?? []) as GoatIntegrationRow[],
    );
    return {
      ...liveIntegrations,
      codex: initialData.integrations.codex,
      claude_code: initialData.integrations.claude_code,
      jamie: {
        ...liveIntegrations.jamie,
        integrationId: initialData.integrations.jamie.integrationId,
        webhookUrl: initialData.integrations.jamie.webhookUrl,
        apiKeyConfigured: initialData.integrations.jamie.apiKeyConfigured,
      },
    };
  }, [initialData.integrations, integrationRows, integrationsLoading]);

  const value = useMemo<GoatAppData>(
    () => ({
      ...initialData,
      tasks,
      schedules,
      recentChats,
      archivedChats,
      integrations,
      taskRows: (taskRows ?? []) as GoatTaskRow[],
      tasksReady: !tasksLoading || (taskRows?.length ?? 0) > 0,
    }),
    [
      archivedChats,
      initialData,
      integrations,
      recentChats,
      schedules,
      taskRows,
      tasks,
      tasksLoading,
    ],
  );

  // TanStack DB currently has no server snapshot for useLiveQuery. Keep its
  // subscriptions in this post-hydration bridge while the outer provider
  // serves the server snapshot immediately, without remounting app children.
  // Push refreshed live data before paint so same-scope router refreshes do not
  // briefly repaint the sidebar from the server snapshot.
  useLayoutEffect(() => onData(value), [onData, value]);
  return null;
}

export function useGoatAppData() {
  const value = useContext(GoatAppDataContext);
  if (!value) throw new Error("useGoatAppData must be used within GoatAppDataProvider.");
  return value;
}

// For chrome that renders both inside and outside the provider (for example
// the settings sidebar in isolated component tests).
export function useGoatAppDataOptional() {
  return useContext(GoatAppDataContext);
}

function initialGoatAppData(initialData: GoatAppInitialData): GoatAppData {
  return {
    ...initialData,
    taskRows: [],
    tasksReady: false,
    archivedChats: [],
  };
}

export function taskRowToView(row: GoatTaskRow): GoatTaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    sessionId: row.session_id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    workflowId: row.workflow_id,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    reportedOutcome: row.reported_outcome,
    outcomeComment: row.outcome_comment,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskScheduleRowToView(row: GoatTaskScheduleRow): GoatTaskScheduleView {
  return {
    id: row.id,
    name: row.name,
    sourceDescription: row.source_description,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
