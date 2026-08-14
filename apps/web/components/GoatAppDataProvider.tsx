"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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
  isGoatChatRuntimeActive,
} from "@/lib/chat-ui";
import type { GoatFeatureFlags } from "@/lib/feature-flags";
import {
  getHeadlessTaskSchedules,
  type HeadlessTaskScheduleReadModel,
} from "@/lib/headless-automation-collections";
import type { GoatTaskScheduleView } from "@/lib/headless-automation-types";
import {
  getHeadlessChatConversations,
  getHeadlessEngineSessions,
  type HeadlessChatConversationReadModel,
  type HeadlessEngineSessionReadModel,
} from "@/lib/headless-chat-collections";
import {
  getHeadlessTasks,
  type HeadlessTaskReadModel,
  legacyTaskDtoToRow,
  taskReadModelToRow,
} from "@/lib/headless-task-collections";
import { listLegacyTaskCompatibility } from "@/lib/headless-task-commands";
import { isRecentGoatHomeActivity } from "@/lib/home-activity";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import type { GoatMcpClient } from "@/lib/mcp-setup";
import {
  mergeOptimisticGoatChatSummaries,
  reconcileOptimisticGoatChatSummaries,
  useOptimisticGoatChatSummaries,
} from "@/lib/optimistic-chat-summaries";
import {
  createGoatCollections,
  type GoatIntegrationRow,
  type GoatTaskRow,
} from "@/lib/task-collections";
import { deriveGoatTaskWorkflowSteps } from "@/lib/task-workflow-activity";

// Every engine exposes the same durable engine-session read model.
function hasDurableChatRuntime(engine: HeadlessChatConversationReadModel["engine"]): boolean {
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
  // Billing plan of the current workspace, surfaced in the account menu.
  plan: "hobby" | "pro";
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
  const optimisticChats = useOptimisticGoatChatSummaries();
  const recentChats = useMemo(
    () =>
      mergeOptimisticGoatChatSummaries({
        persistedChats: value.recentChats,
        optimisticChats,
        workspaceId: value.workspace.id,
      }),
    [optimisticChats, value.recentChats, value.workspace.id],
  );
  const contextValue = useMemo(
    () => (recentChats.length === value.recentChats.length ? value : { ...value, recentChats }),
    [recentChats, value],
  );

  useLayoutEffect(() => {
    reconcileOptimisticGoatChatSummaries(value.recentChats);
  }, [value.recentChats]);

  return (
    <GoatAppDataContext.Provider value={contextValue}>
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
  const tasksCollection = useMemo(
    () => getHeadlessTasks(initialData.workspace.id),
    [initialData.workspace.id],
  );
  const taskSchedulesCollection = useMemo(
    () =>
      initialData.featureFlags.taskSpawning
        ? getHeadlessTaskSchedules(initialData.workspace.id)
        : null,
    [initialData.featureFlags.taskSpawning, initialData.workspace.id],
  );
  // Keep Task metadata live even while the feature is disabled so every surface has current data
  // as soon as the user enables it. Authorization and shape identity stay in the API.
  const { data: taskRows, isLoading: tasksLoading } = useLiveQuery(
    (q) => q.from({ task: tasksCollection }),
    [tasksCollection],
  );
  const [legacyTaskSnapshot, setLegacyTaskSnapshot] = useState<{
    workspaceId: string;
    rows: GoatTaskRow[];
  } | null>(null);
  const legacyTaskRows =
    legacyTaskSnapshot?.workspaceId === initialData.workspace.id ? legacyTaskSnapshot.rows : null;
  useEffect(() => {
    const controller = new AbortController();
    const workspaceId = initialData.workspace.id;
    void listLegacyTaskCompatibility({
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    })
      .then((tasks) => setLegacyTaskSnapshot({ workspaceId, rows: tasks.map(legacyTaskDtoToRow) }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Legacy Task compatibility history could not be loaded.", error);
        setLegacyTaskSnapshot({ workspaceId, rows: [] });
      });
    return () => controller.abort();
  }, [initialData.workspace.id]);
  const currentTaskRows = useMemo(
    () => [
      ...((taskRows ?? []) as HeadlessTaskReadModel[]).map(taskReadModelToRow),
      ...(legacyTaskRows ?? []),
    ],
    [legacyTaskRows, taskRows],
  );
  const { data: scheduleRows, isLoading: schedulesLoading } = useLiveQuery(
    (q) => (taskSchedulesCollection ? q.from({ schedule: taskSchedulesCollection }) : undefined),
    [initialData.featureFlags.taskSpawning, taskSchedulesCollection],
  );
  const conversationsCollection = useMemo(() => getHeadlessChatConversations(), []);
  const engineSessionsCollection = useMemo(() => getHeadlessEngineSessions(), []);
  const { data: chatRows, isLoading: chatsLoading } = useLiveQuery(
    (q) => q.from({ conversation: conversationsCollection }),
    [conversationsCollection],
  );
  const { data: engineSessionRows } = useLiveQuery(
    (q) => q.from({ engineSession: engineSessionsCollection }),
    [engineSessionsCollection],
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );

  const tasks = useMemo(() => {
    if (tasksLoading && !taskRows?.length) return initialData.tasks;
    return currentTaskRows
      .map(taskRowToView)
      .filter(
        (task) =>
          !task.archivedAt &&
          (task.status === "queued" ||
            task.status === "running" ||
            isRecentGoatHomeActivity(task.createdAt)),
      )
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [currentTaskRows, initialData.tasks, taskRows?.length, tasksLoading]);

  const schedules = useMemo(() => {
    if (!initialData.featureFlags.taskSpawning) return [];
    if (schedulesLoading && !scheduleRows?.length) return initialData.schedules;
    return ((scheduleRows ?? []) as HeadlessTaskScheduleReadModel[])
      .map(taskScheduleReadModelToView)
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [
    initialData.featureFlags.taskSpawning,
    initialData.schedules,
    scheduleRows,
    schedulesLoading,
  ]);

  const recentChats = useMemo(() => {
    if (chatsLoading && !chatRows?.length) return initialData.recentChats;
    const initialById = new Map(initialData.recentChats.map((chat) => [chat.id, chat]));
    const codexRuntimeByChatId = new Map(
      ((engineSessionRows ?? []) as HeadlessEngineSessionReadModel[]).map((row) => [
        row.conversationId,
        {
          status: row.status,
          activeTurnId: row.activeRunId,
          error: row.error,
          updatedAt: row.updatedAt,
        },
      ]),
    );
    const toSummary = (row: HeadlessChatConversationReadModel): GoatChatSummaryView => {
      const initial = initialById.get(row.id);
      const durableRuntime = codexRuntimeByChatId.get(row.id);
      const codexRuntime = hasDurableChatRuntime(row.engine)
        ? (durableRuntime ?? initial?.codexRuntime ?? null)
        : null;
      return {
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: initial?.codexComposerSettings ?? null,
        codexRuntime,
        state: deriveGoatChatState({
          updatedAt: row.updatedAt,
          lastSeenAt: row.lastSeenAt,
          codexRuntime,
        }),
        preview: initial?.preview ?? "No messages yet.",
        updatedAt: row.updatedAt,
        lastSeenAt: row.lastSeenAt,
        pinnedAt: row.pinnedAt,
      };
    };
    const openRows = ((chatRows ?? []) as HeadlessChatConversationReadModel[]).filter(
      (row) => !row.archivedAt,
    );
    const activeRuntimeChatIds = new Set(
      ((engineSessionRows ?? []) as HeadlessEngineSessionReadModel[])
        .filter((row) =>
          isGoatChatRuntimeActive({ status: row.status, activeTurnId: row.activeRunId }),
        )
        .map((row) => row.conversationId),
    );
    const pinned = openRows
      .filter((row) => row.pinnedAt)
      .toSorted((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime())
      .slice(0, GOAT_PINNED_CHAT_LIMIT)
      .map(toSummary);
    const activeRuntime = openRows
      .filter((row) => !row.pinnedAt && activeRuntimeChatIds.has(row.id))
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(toSummary);
    const recent = openRows
      .filter(
        (row) =>
          !row.pinnedAt &&
          !activeRuntimeChatIds.has(row.id) &&
          isRecentGoatHomeActivity(row.updatedAt),
      )
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8)
      .map(toSummary);
    return [...pinned, ...activeRuntime, ...recent];
  }, [chatRows, chatsLoading, engineSessionRows, initialData.recentChats]);

  const archivedChats = useMemo<GoatChatSummaryView[]>(() => {
    const codexRuntimeByChatId = new Map(
      ((engineSessionRows ?? []) as HeadlessEngineSessionReadModel[]).map((row) => [
        row.conversationId,
        {
          status: row.status,
          activeTurnId: row.activeRunId,
          error: row.error,
          updatedAt: row.updatedAt,
        },
      ]),
    );
    return ((chatRows ?? []) as HeadlessChatConversationReadModel[])
      .filter((row) => row.archivedAt)
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
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
        updatedAt: row.updatedAt,
        lastSeenAt: row.lastSeenAt,
        pinnedAt: null,
        archived: true,
      }));
  }, [chatRows, engineSessionRows]);

  const integrations = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialData.integrations;
    const liveIntegrations = goatIntegrationStateFromRows(
      (integrationRows ?? []) as GoatIntegrationRow[],
    );
    return {
      ...liveIntegrations,
      codex: initialData.integrations.codex,
      claude_code: initialData.integrations.claude_code,
      infisical: initialData.integrations.infisical,
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
      taskRows: currentTaskRows,
      tasksReady: legacyTaskRows !== null && (!tasksLoading || (taskRows?.length ?? 0) > 0),
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
      currentTaskRows,
      legacyTaskRows,
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
    ...(row.engine ? { engine: row.engine } : {}),
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
    workflowSteps: deriveGoatTaskWorkflowSteps({
      harnessSpec: row.harness_spec,
      taskStatus: row.status,
    }),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskScheduleReadModelToView(
  schedule: HeadlessTaskScheduleReadModel,
): GoatTaskScheduleView {
  return schedule;
}
