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
import type { TaskView } from "@/components/Surface";
import type { ChatSummaryView } from "@/lib/chat-ui";
import type { FeatureFlags } from "@/lib/feature-flags";
import {
  getHeadlessTaskSchedules,
  type HeadlessTaskScheduleReadModel,
} from "@/lib/headless-automation-collections";
import type { TaskScheduleView } from "@/lib/headless-automation-types";
import {
  getHeadlessChatConversations,
  type HeadlessChatConversationReadModel,
  preloadHeadlessChatMessages,
} from "@/lib/headless-chat-collections";
import {
  getHeadlessIntegrationAccounts,
  type HeadlessIntegrationAccountReadModel,
} from "@/lib/headless-integration-collections";
import {
  getHeadlessTasks,
  type HeadlessTaskReadModel,
  legacyTaskDtoToRow,
  taskReadModelToRow,
} from "@/lib/headless-task-collections";
import { listLegacyTaskCompatibility } from "@/lib/headless-task-commands";
import { isRecentHomeActivity } from "@/lib/home-activity";
import { type IntegrationState, integrationStateFromRows } from "@/lib/integration-state";
import type { McpClient } from "@/lib/mcp-setup";
import {
  mergeOptimisticChatSummaries,
  reconcileOptimisticChatSummaries,
  useOptimisticChatSummaries,
} from "@/lib/optimistic-chat-summaries";
import { selectSidebarChats } from "@/lib/sidebar-chats";
import type { TaskRow } from "@/lib/task-collections";
import { deriveTaskWorkflowSteps } from "@/lib/task-workflow-activity";

type UserView = {
  // Scopes client-side chat attachment uploads (blob prefix goat-chat/{id}/).
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

// Directory of workspace members used to render attribution (brain document
// "created by", etc.) from a workos user id.
export type WorkspaceMemberView = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export type WorkspaceView = {
  id: string;
  name: string;
  role: "admin" | "member";
};

export type BrainSummaryView = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "workspace" | "restricted";
};

export type AppInitialData = {
  user: UserView;
  workspace: WorkspaceView;
  // Billing plan of the current workspace, surfaced in the account menu.
  plan: "hobby" | "pro";
  workspaces: WorkspaceView[];
  workspaceMembers: WorkspaceMemberView[];
  brains: BrainSummaryView[];
  activeBrain: BrainSummaryView | null;
  tasks: TaskView[];
  schedules: TaskScheduleView[];
  recentChats: ChatSummaryView[];
  integrations: IntegrationState;
  featureFlags: FeatureFlags;
  codexConnected: boolean;
  claudeCodeConnected: boolean;
  mcpSetup: {
    preferredClient: McpClient | null;
    completedAt: string | null;
  };
};

type AppData = AppInitialData & {
  taskRows: TaskRow[];
  tasksReady: boolean;
  // Closed (archived) chats, surfaced in the command palette so the user can
  // search and restore them. Derived from the same live query as recentChats —
  // closed rows already stream to the client, they're just hidden elsewhere.
  archivedChats: ChatSummaryView[];
};

// Keeps the command palette responsive; older archived chats are still
// reachable by narrowing the search (which re-filters this bounded list).
const ARCHIVED_CHAT_LIMIT = 50;

const AppDataContext = createContext<AppData | null>(null);
const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

export function AppDataProvider({
  initialData,
  children,
}: {
  initialData: AppInitialData;
  children: ReactNode;
}) {
  const initialValue = useMemo(() => initialAppData(initialData), [initialData]);
  const [liveSnapshot, setLiveSnapshot] = useState<{
    initialData: AppInitialData;
    value: AppData;
  } | null>(null);
  const updateLiveData = useCallback(
    (value: AppData) => setLiveSnapshot({ initialData, value }),
    [initialData],
  );
  const liveSnapshotMatchesScope =
    liveSnapshot?.value.user.workosUserId === initialData.user.workosUserId &&
    liveSnapshot.value.workspace.id === initialData.workspace.id;
  const value =
    liveSnapshot?.initialData === initialData || liveSnapshotMatchesScope
      ? liveSnapshot.value
      : initialValue;
  const optimisticChats = useOptimisticChatSummaries();
  const recentChats = useMemo(
    () =>
      mergeOptimisticChatSummaries({
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
    reconcileOptimisticChatSummaries(value.recentChats);
  }, [value.recentChats]);

  return (
    <AppDataContext.Provider value={contextValue}>
      {children}
      <AppLiveDataSync initialData={initialData} onData={updateLiveData} />
    </AppDataContext.Provider>
  );
}

function AppLiveDataSync({
  initialData,
  onData,
}: {
  initialData: AppInitialData;
  onData: (value: AppData) => void;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  return hydrated ? <AppLiveDataSubscriptions initialData={initialData} onData={onData} /> : null;
}

function AppLiveDataSubscriptions({
  initialData,
  onData,
}: {
  initialData: AppInitialData;
  onData: (value: AppData) => void;
}) {
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
    rows: TaskRow[];
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
  const integrationAccountsCollection = useMemo(
    () => getHeadlessIntegrationAccounts(initialData.workspace.id),
    [initialData.workspace.id],
  );
  const { data: chatRows, isLoading: chatsLoading } = useLiveQuery(
    (q) => q.from({ conversation: conversationsCollection }),
    [conversationsCollection],
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery(
    (q) => q.from({ integration: integrationAccountsCollection }),
    [integrationAccountsCollection],
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
            isRecentHomeActivity(task.createdAt)),
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
    if (chatsLoading && !chatRows?.length) return selectSidebarChats(initialData.recentChats);
    const initialById = new Map(initialData.recentChats.map((chat) => [chat.id, chat]));
    const toSummary = (row: HeadlessChatConversationReadModel): ChatSummaryView => {
      const initial = initialById.get(row.id);
      return {
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: initial?.codexComposerSettings ?? null,
        runtime: row.runtime,
        activityState: row.activityState,
        hasUnseen: row.hasUnseen,
        preview: initial?.preview ?? "No messages yet.",
        updatedAt: row.updatedAt,
        lastSeenAt: row.lastSeenAt,
        pinnedAt: row.pinnedAt,
      };
    };
    return selectSidebarChats((chatRows ?? []) as HeadlessChatConversationReadModel[]).map(
      toSummary,
    );
  }, [chatRows, chatsLoading, initialData.recentChats]);

  useEffect(() => {
    // Wait for the authoritative conversation shape so the larger server
    // fallback cannot accidentally fan out into one Electric shape per chat.
    if (chatsLoading && !chatRows?.length) return;
    // Only warm chats with a live runtime turn: they have an active SSE stream the user is likely
    // watching, and there are rarely more than a couple. Idle transcripts preload on demand via
    // sidebar hover/focus (Sidebar.tsx), so boot no longer fans out one shape per recent chat —
    // heavy transcripts could otherwise cost hundreds of MB of Electric replay at startup.
    for (const chat of recentChats) {
      if (chat.activityState !== "working") continue;
      void preloadHeadlessChatMessages(chat.id).catch((error: unknown) => {
        console.warn("Could not preload a sidebar chat transcript.", {
          conversationId: chat.id,
          error,
        });
      });
    }
  }, [chatRows?.length, chatsLoading, recentChats]);

  const archivedChats = useMemo<ChatSummaryView[]>(() => {
    return ((chatRows ?? []) as HeadlessChatConversationReadModel[])
      .filter((row) => row.archivedAt)
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, ARCHIVED_CHAT_LIMIT)
      .map((row) => ({
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: null,
        runtime: row.runtime,
        activityState: row.activityState,
        hasUnseen: row.hasUnseen,
        preview: "Archived",
        updatedAt: row.updatedAt,
        lastSeenAt: row.lastSeenAt,
        pinnedAt: null,
        archived: true,
      }));
  }, [chatRows]);

  const integrations = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialData.integrations;
    const liveIntegrations = integrationStateFromRows(
      (integrationRows ?? []) as HeadlessIntegrationAccountReadModel[],
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

  const value = useMemo<AppData>(
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

export function useAppData() {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used within AppDataProvider.");
  return value;
}

// For chrome that renders both inside and outside the provider (for example
// the settings sidebar in isolated component tests).
export function useAppDataOptional() {
  return useContext(AppDataContext);
}

function initialAppData(initialData: AppInitialData): AppData {
  return {
    ...initialData,
    recentChats: selectSidebarChats(initialData.recentChats),
    taskRows: [],
    tasksReady: false,
    archivedChats: [],
  };
}

export function taskRowToView(row: TaskRow): TaskView {
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
    workflowSteps: deriveTaskWorkflowSteps({
      harnessSpec: row.harness_spec,
      taskStatus: row.status,
    }),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskScheduleReadModelToView(schedule: HeadlessTaskScheduleReadModel): TaskScheduleView {
  return schedule;
}
