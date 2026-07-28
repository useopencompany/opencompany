"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatMcpClient } from "@opencompany/db/goat-schema";
import { useLiveQuery } from "@tanstack/react-db";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { GoatTaskView } from "@/components/GoatSurface";
import { GOAT_PINNED_CHAT_LIMIT, type GoatChatSummaryView } from "@/lib/chat-ui";
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
  chatResumeEnabled: boolean;
  mcpSetup: {
    preferredClient: GoatMcpClient | null;
    completedAt: string | null;
  };
};

type GoatAppData = GoatAppInitialData & {
  taskRows: GoatTaskRow[];
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
  const value = liveSnapshot?.initialData === initialData ? liveSnapshot.value : initialValue;

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
  // Tasks are not gated on the task-spawning flag: firing a workflow enables
  // the flag server-side, and its task must appear in the sidebar immediately.
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
      return {
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: initial?.codexComposerSettings ?? null,
        codexRuntime:
          row.engine === "codex" ? (liveCodexRuntime ?? initial?.codexRuntime ?? null) : null,
        preview: initial?.preview ?? "No messages yet.",
        updatedAt: row.updated_at,
        pinnedAt: row.pinned_at,
      };
    };
    const openRows = ((chatSessionRows ?? []) as GoatChatSessionRow[]).filter(
      (row) => !row.closed_at,
    );
    const activeCodexChatIds = new Set(
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
    const activeCodex = openRows
      .filter((row) => !row.pinned_at && activeCodexChatIds.has(row.id))
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map(toSummary);
    const recent = openRows
      .filter(
        (row) =>
          !row.pinned_at &&
          !activeCodexChatIds.has(row.id) &&
          isRecentGoatHomeActivity(row.updated_at),
      )
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 8)
      .map(toSummary);
    return [...pinned, ...activeCodex, ...recent];
  }, [chatSessionRows, chatsLoading, codexChatSessionRows, initialData.recentChats]);

  const archivedChats = useMemo<GoatChatSummaryView[]>(() => {
    const codexRuntimeByChatId = new Map(
      ((codexChatSessionRows ?? []) as GoatCodexChatSessionRow[]).map((row) => [
        row.chat_session_id,
        { status: row.status, error: row.error, updatedAt: row.updated_at },
      ]),
    );
    return ((chatSessionRows ?? []) as GoatChatSessionRow[])
      .filter((row) => row.closed_at)
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, GOAT_ARCHIVED_CHAT_LIMIT)
      .map((row) => ({
        id: row.id,
        title: row.title,
        model: row.model as AgentModelId,
        engine: row.engine,
        codexComposerSettings: null,
        codexRuntime: row.engine === "codex" ? (codexRuntimeByChatId.get(row.id) ?? null) : null,
        preview: "Archived",
        updatedAt: row.updated_at,
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
      taskRows: initialData.featureFlags.taskSpawning ? ((taskRows ?? []) as GoatTaskRow[]) : [],
    }),
    [archivedChats, initialData, integrations, recentChats, schedules, taskRows, tasks],
  );

  // TanStack DB currently has no server snapshot for useLiveQuery. Keep its
  // subscriptions in this post-hydration bridge while the outer provider
  // serves the server snapshot immediately, without remounting app children.
  useEffect(() => onData(value), [onData, value]);
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
    archivedChats: [],
  };
}

function taskRowToView(row: GoatTaskRow): GoatTaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
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
