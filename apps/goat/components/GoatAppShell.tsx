import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import { listGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import type { ReactNode } from "react";
import { GoatAppDataProvider, type GoatAppInitialData } from "@/components/GoatAppDataProvider";
import { currentGoatUser } from "@/lib/auth";
import { listCurrentUserRecentGoatChats } from "@/lib/chat";
import { isGoatChatResumeEnabled } from "@/lib/chat-streams";
import { loadCurrentGoatCodexAuthSettings } from "@/lib/codex-auth";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";
import { type GoatCodexProviderState, type GoatIntegrationState } from "@/lib/integration-state";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";
import { getGoatSlackIntegrationState } from "@/lib/integrations/slack";
import { listCurrentUserGoatTaskSchedules } from "@/lib/task-schedules";
import { listCurrentUserGoatTasks } from "@/lib/tasks";

export async function GoatAppShell({ children }: { children: ReactNode }) {
  const { authUser, user, workspace, role, brains, activeBrain } = await currentGoatUser();
  const [
    tasks,
    schedules,
    recentChats,
    googleIntegrations,
    linear,
    github,
    jamie,
    slack,
    codex,
    workspaceMembers,
  ] = await Promise.all([
    listCurrentUserGoatTasks(),
    listCurrentUserGoatTaskSchedules(),
    listCurrentUserRecentGoatChats(),
    getGoatGoogleIntegrationState(user.workosUserId),
    getGoatLinearIntegrationState(user.workosUserId),
    getGoatGitHubIntegrationState(user.workosUserId),
    getGoatJamieIntegrationState(user.workosUserId),
    getGoatSlackIntegrationState(user.workosUserId),
    loadCurrentGoatCodexAuthSettings(),
    listGoatWorkspaceMembers(workspace.id),
  ]);

  const initialData: GoatAppInitialData = {
    user: {
      email: user.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: user.avatarUrl,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      role,
    },
    workspaceMembers: workspaceMembers.map(({ user: member }) => ({
      workosUserId: member.workosUserId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      avatarUrl: member.avatarUrl,
    })),
    brains: brains.map(brainSummaryView),
    activeBrain: activeBrain ? brainSummaryView(activeBrain) : null,
    tasks: tasks.map((task) => ({
      id: task.id,
      displayId: task.displayId,
      name: task.name,
      prompt: task.prompt,
      model: task.model,
      scheduleId: task.scheduleId,
      scheduledFor: task.scheduledFor?.toISOString() ?? null,
      status: task.status as GoatTaskStatus,
      stage: task.stage as GoatTaskStage,
      result: task.result,
      error: task.error,
      archivedAt: task.archivedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
    schedules,
    recentChats,
    integrations: buildIntegrationState({
      googleIntegrations,
      linear,
      github,
      jamie,
      slack,
      codex: {
        provider: "codex",
        connected: codex.status === "connected",
        status: codex.status ?? "not_connected",
        statusReason: codex.statusReason,
        lastValidatedAt: codex.lastValidatedAt,
      },
    }),
    featureFlags: goatFeatureFlagsFromUser(user),
    codexConnected: codex.status === "connected",
    chatResumeEnabled: isGoatChatResumeEnabled(),
  };

  return <GoatAppDataProvider initialData={initialData}>{children}</GoatAppDataProvider>;
}

function brainSummaryView(brain: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "workspace" | "restricted";
}) {
  return {
    id: brain.id,
    name: brain.name,
    slug: brain.slug,
    description: brain.description,
    visibility: brain.visibility,
  };
}

function buildIntegrationState(input: {
  googleIntegrations: Pick<GoatIntegrationState, "gmail" | "google_calendar">;
  linear: GoatIntegrationState["linear"];
  github: GoatIntegrationState["github"];
  jamie: GoatIntegrationState["jamie"];
  slack: GoatIntegrationState["slack"];
  codex: GoatCodexProviderState;
}): GoatIntegrationState {
  return {
    ...input.googleIntegrations,
    linear: input.linear,
    github: input.github,
    jamie: input.jamie,
    slack: input.slack,
    codex: input.codex,
  };
}
