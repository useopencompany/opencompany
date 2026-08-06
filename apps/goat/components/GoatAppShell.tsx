import { GoatAnalyticsProvider } from "@opencompany/analytics/goat/client";
import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import { listGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import type { ReactNode } from "react";
import { GoatAppDataProvider, type GoatAppInitialData } from "@/components/GoatAppDataProvider";
import { currentGoatUser } from "@/lib/auth";
import { listCurrentUserRecentGoatChats } from "@/lib/chat";
import { isGoatChatResumeEnabled } from "@/lib/chat-streams";
import { loadCurrentGoatClaudeCodeAuthSettings } from "@/lib/claude-code-auth";
import { loadCurrentGoatCodexAuthSettings } from "@/lib/codex-auth";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";
import { loadCurrentGoatInfisicalAuthSettings } from "@/lib/infisical-auth";
import {
  type GoatClaudeCodeProviderState,
  type GoatCodexProviderState,
  type GoatInfisicalProviderState,
  type GoatIntegrationState,
} from "@/lib/integration-state";
import { getGoatAttioIntegrationState } from "@/lib/integrations/attio";
import { getGoatFathomIntegrationState } from "@/lib/integrations/fathom";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGoatGranolaIntegrationState } from "@/lib/integrations/granola";
import { getGoatImessageIntegrationState } from "@/lib/integrations/imessage";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";
import { getGoatPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { getGoatPostHogIntegrationState } from "@/lib/integrations/posthog-mcp";
import { getGoatSlackIntegrationState } from "@/lib/integrations/slack";
import { getGoatStripeIntegrationState } from "@/lib/integrations/stripe";
import { getGoatXAccountIntegrationState } from "@/lib/integrations/x-account";
import { listCurrentUserGoatTaskSchedules } from "@/lib/task-schedules";
import { listCurrentUserGoatTasks } from "@/lib/tasks";

export async function GoatAppShell({ children }: { children: ReactNode }) {
  const { authUser, user, workspace, role, workspaces, brains, activeBrain } =
    await currentGoatUser();
  const featureFlags = goatFeatureFlagsFromUser(user);
  const [
    tasks,
    schedules,
    recentChats,
    googleIntegrations,
    linear,
    posthog,
    github,
    jamie,
    slack,
    granola,
    fathom,
    attio,
    stripe,
    xAccount,
    imessage,
    codex,
    claudeCode,
    infisical,
    workspaceMembers,
    personalAccounts,
  ] = await Promise.all([
    listCurrentUserGoatTasks(),
    featureFlags.taskSpawning ? listCurrentUserGoatTaskSchedules() : Promise.resolve([]),
    listCurrentUserRecentGoatChats(),
    getGoatGoogleIntegrationState(user.workosUserId),
    getGoatLinearIntegrationState(user.workosUserId),
    getGoatPostHogIntegrationState(user.workosUserId),
    getGoatGitHubIntegrationState(workspace.id),
    getGoatJamieIntegrationState(workspace.id),
    getGoatSlackIntegrationState(user.workosUserId),
    getGoatGranolaIntegrationState(user.workosUserId),
    getGoatFathomIntegrationState(user.workosUserId),
    getGoatAttioIntegrationState(user.workosUserId),
    getGoatStripeIntegrationState(workspace.id),
    getGoatXAccountIntegrationState(user.workosUserId),
    getGoatImessageIntegrationState(user.workosUserId),
    loadCurrentGoatCodexAuthSettings(),
    loadCurrentGoatClaudeCodeAuthSettings(),
    loadCurrentGoatInfisicalAuthSettings(),
    listGoatWorkspaceMembers(workspace.id),
    getGoatPersonalAccounts(user.workosUserId),
  ]);

  const initialData: GoatAppInitialData = {
    user: {
      workosUserId: user.workosUserId,
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
    workspaces: workspaces.map((entry) => ({
      id: entry.workspace.id,
      name: entry.workspace.name,
      role: entry.role,
    })),
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
      sessionId: task.sessionId,
      scheduleId: task.scheduleId,
      scheduledFor: task.scheduledFor?.toISOString() ?? null,
      workflowId: task.workflowId,
      status: task.status as GoatTaskStatus,
      stage: task.stage as GoatTaskStage,
      result: task.result,
      error: task.error,
      reportedOutcome: task.reportedOutcome,
      outcomeComment: task.outcomeComment,
      archivedAt: task.archivedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
    schedules,
    recentChats,
    integrations: buildIntegrationState({
      googleIntegrations,
      linear,
      posthog,
      github,
      jamie,
      slack,
      granola,
      fathom,
      attio,
      stripe,
      xAccount,
      imessage,
      personalAccounts,
      codex: {
        provider: "codex",
        connected: codex.status === "connected",
        status: codex.status ?? "not_connected",
        statusReason: codex.statusReason,
        lastValidatedAt: codex.lastValidatedAt,
      },
      claudeCode: {
        provider: "claude_code",
        connected: claudeCode.status === "connected",
        status: claudeCode.status ?? "not_connected",
        statusReason: claudeCode.statusReason,
        lastValidatedAt: claudeCode.lastValidatedAt,
      },
      infisical: {
        provider: "infisical",
        connected: infisical.status === "connected",
        status: infisical.status ?? "not_connected",
        statusReason: infisical.statusReason,
        accountEmail: infisical.accountEmail,
        lastValidatedAt: infisical.lastValidatedAt,
      },
    }),
    featureFlags,
    codexConnected: codex.status === "connected",
    claudeCodeConnected: claudeCode.status === "connected",
    chatResumeEnabled: isGoatChatResumeEnabled(),
    mcpSetup: {
      preferredClient: user.preferredMcpClient,
      completedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
    },
  };

  return (
    <GoatAnalyticsProvider
      identity={{
        userId: user.workosUserId,
        workspaceId: workspace.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }}
    >
      <GoatAppDataProvider initialData={initialData}>{children}</GoatAppDataProvider>
    </GoatAnalyticsProvider>
  );
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
  googleIntegrations: Pick<GoatIntegrationState, "gmail" | "google_calendar" | "google_drive">;
  linear: GoatIntegrationState["linear"];
  posthog: GoatIntegrationState["posthog"];
  github: GoatIntegrationState["github"];
  jamie: GoatIntegrationState["jamie"];
  slack: GoatIntegrationState["slack"];
  granola: GoatIntegrationState["granola"];
  fathom: GoatIntegrationState["fathom"];
  attio: GoatIntegrationState["attio"];
  stripe: GoatIntegrationState["stripe"];
  xAccount: GoatIntegrationState["x_account"];
  imessage: GoatIntegrationState["imessage"];
  personalAccounts: GoatIntegrationState["personalAccounts"];
  codex: GoatCodexProviderState;
  claudeCode: GoatClaudeCodeProviderState;
  infisical: GoatInfisicalProviderState;
}): GoatIntegrationState {
  return {
    gmail: input.googleIntegrations.gmail,
    google_calendar: input.googleIntegrations.google_calendar,
    google_drive: input.googleIntegrations.google_drive,
    linear: input.linear,
    posthog: input.posthog,
    github: input.github,
    jamie: input.jamie,
    slack: input.slack,
    granola: input.granola,
    fathom: input.fathom,
    attio: input.attio,
    stripe: input.stripe,
    x_account: input.xAccount,
    imessage: input.imessage,
    codex: input.codex,
    claude_code: input.claudeCode,
    infisical: input.infisical,
    personalAccounts: input.personalAccounts,
  };
}
