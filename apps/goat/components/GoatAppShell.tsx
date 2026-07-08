import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import type { ReactNode } from "react";
import {
  GoatAppDataProvider,
  type GoatAppInitialData,
} from "@/components/GoatAppDataProvider";
import { currentGoatUser } from "@/lib/auth";
import { listCurrentUserGoatBrain } from "@/lib/brain";
import { listCurrentUserRecentGoatChats } from "@/lib/chat";
import { loadCurrentGoatCodexAuthSettings } from "@/lib/codex-auth";
import {
  type GoatCodexProviderState,
  type GoatIntegrationState,
} from "@/lib/integration-state";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";
import { listCurrentUserGoatTaskSchedules } from "@/lib/task-schedules";
import { listCurrentUserGoatTasks } from "@/lib/tasks";

export async function GoatAppShell({ children }: { children: ReactNode }) {
  const { authUser, user } = await currentGoatUser();
  const [
    tasks,
    schedules,
    recentChats,
    brain,
    googleIntegrations,
    linear,
    github,
    jamie,
    codex,
  ] = await Promise.all([
    listCurrentUserGoatTasks(),
    listCurrentUserGoatTaskSchedules(),
    listCurrentUserRecentGoatChats(),
    listCurrentUserGoatBrain(),
    getGoatGoogleIntegrationState(user.workosUserId),
    getGoatLinearIntegrationState(user.workosUserId),
    getGoatGitHubIntegrationState(user.workosUserId),
    getGoatJamieIntegrationState(user.workosUserId),
    loadCurrentGoatCodexAuthSettings(),
  ]);

  const initialData: GoatAppInitialData = {
    user: {
      email: user.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: user.avatarUrl,
    },
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
      codex: {
        provider: "codex",
        connected: codex.status === "connected",
        status: codex.status ?? "not_connected",
        statusReason: codex.statusReason,
        lastValidatedAt: codex.lastValidatedAt,
      },
    }),
    brain,
    codexConnected: codex.status === "connected",
  };

  return <GoatAppDataProvider initialData={initialData}>{children}</GoatAppDataProvider>;
}

function buildIntegrationState(input: {
  googleIntegrations: Pick<GoatIntegrationState, "gmail" | "google_calendar">;
  linear: GoatIntegrationState["linear"];
  github: GoatIntegrationState["github"];
  jamie: GoatIntegrationState["jamie"];
  codex: GoatCodexProviderState;
}): GoatIntegrationState {
  return {
    ...input.googleIntegrations,
    linear: input.linear,
    github: input.github,
    jamie: input.jamie,
    codex: input.codex,
  };
}
