"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { GoatTaskView } from "@/components/GoatSurface";
import type { GoatChatSummaryView } from "@/lib/chat-ui";
import type { GoatFeatureFlags } from "@/lib/feature-flags";
import { isRecentGoatHomeActivity } from "@/lib/home-activity";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import {
  createGoatCollections,
  type GoatChatSessionRow,
  type GoatIntegrationRow,
  type GoatTaskRow,
  type GoatTaskScheduleRow,
} from "@/lib/task-collections";
import type { GoatTaskScheduleView } from "@/lib/task-schedules";

type GoatUserView = {
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
};

type GoatAppData = GoatAppInitialData & {
  taskRows: GoatTaskRow[];
};

const GoatAppDataContext = createContext<GoatAppData | null>(null);

export function GoatAppDataProvider({
  initialData,
  children,
}: {
  initialData: GoatAppInitialData;
  children: ReactNode;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: taskRows, isLoading: tasksLoading } = useLiveQuery((q) =>
    q.from({ task: collections.tasks }),
  );
  const { data: scheduleRows, isLoading: schedulesLoading } = useLiveQuery((q) =>
    q.from({ schedule: collections.taskSchedules }),
  );
  const { data: chatSessionRows, isLoading: chatsLoading } = useLiveQuery((q) =>
    q.from({ session: collections.chatSessions }),
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );

  const tasks = useMemo(() => {
    if (tasksLoading && !taskRows?.length) return initialData.tasks;
    return ((taskRows ?? []) as GoatTaskRow[])
      .map(taskRowToView)
      .filter((task) => !task.archivedAt && isRecentGoatHomeActivity(task.createdAt))
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [initialData.tasks, taskRows, tasksLoading]);

  const schedules = useMemo(() => {
    if (schedulesLoading && !scheduleRows?.length) return initialData.schedules;
    return ((scheduleRows ?? []) as GoatTaskScheduleRow[])
      .filter((row) => !row.deleted_at)
      .map(taskScheduleRowToView)
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [initialData.schedules, scheduleRows, schedulesLoading]);

  const recentChats = useMemo(() => {
    if (chatsLoading && !chatSessionRows?.length) return initialData.recentChats;
    const initialById = new Map(initialData.recentChats.map((chat) => [chat.id, chat]));
    return ((chatSessionRows ?? []) as GoatChatSessionRow[])
      .filter((row) => !row.closed_at && isRecentGoatHomeActivity(row.updated_at))
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 8)
      .map((row) => {
        const initial = initialById.get(row.id);
        return {
          id: row.id,
          title: row.title,
          model: row.model as AgentModelId,
          engine: row.engine,
          preview: initial?.preview ?? "No messages yet.",
          updatedAt: row.updated_at,
        };
      });
  }, [chatSessionRows, chatsLoading, initialData.recentChats]);

  const integrations = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialData.integrations;
    return {
      ...goatIntegrationStateFromRows((integrationRows ?? []) as GoatIntegrationRow[]),
      codex: initialData.integrations.codex,
      jamie: {
        ...goatIntegrationStateFromRows((integrationRows ?? []) as GoatIntegrationRow[]).jamie,
        integrationId: initialData.integrations.jamie.integrationId,
        webhookUrl: initialData.integrations.jamie.webhookUrl,
      },
    };
  }, [initialData.integrations, integrationRows, integrationsLoading]);

  const value = useMemo<GoatAppData>(
    () => ({
      ...initialData,
      tasks,
      schedules,
      recentChats,
      integrations,
      taskRows: (taskRows ?? []) as GoatTaskRow[],
    }),
    [initialData, integrations, recentChats, schedules, taskRows, tasks],
  );

  return <GoatAppDataContext.Provider value={value}>{children}</GoatAppDataContext.Provider>;
}

export function useGoatAppData() {
  const value = useContext(GoatAppDataContext);
  if (!value) throw new Error("useGoatAppData must be used within GoatAppDataProvider.");
  return value;
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
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
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
