import { AnalyticsProvider } from "@opencompany/analytics/client";
import {
  type ClaudeCodeProviderState,
  type CodexProviderState,
  type InfisicalProviderState,
  type IntegrationState,
} from "@opencompany/core/integration-state";
import { getAttioIntegrationState } from "@opencompany/core/integrations/attio";
import { getGitHubIntegrationState } from "@opencompany/core/integrations/github";
import { getLinearIntegrationState } from "@opencompany/core/integrations/linear-mcp";
import { getPostHogIntegrationState } from "@opencompany/core/integrations/posthog-mcp";
import { getSlackIntegrationState } from "@opencompany/core/integrations/slack";
import { getStripeIntegrationState } from "@opencompany/core/integrations/stripe";
import type { TaskStage, TaskStatus } from "@opencompany/db/schema";
import { listWorkspaceMembers } from "@opencompany/db/workspaces";
import type { ReactNode } from "react";
import { AppDataProvider, type AppInitialData } from "@/components/AppDataProvider";
import { currentUser } from "@/lib/auth";
import { listCurrentUserRecentChats } from "@/lib/chat";
import { isChatResumeEnabled } from "@/lib/chat-streams";
import { loadCurrentClaudeCodeAuthSettings } from "@/lib/claude-code-auth";
import { loadCurrentCodexAuthSettings } from "@/lib/codex-auth";
import { featureFlagsFromUser } from "@/lib/feature-flags";
import { loadCurrentInfisicalAuthSettings } from "@/lib/infisical-auth";
import { getFathomIntegrationState } from "@/lib/integrations/fathom";
import { getGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGranolaIntegrationState } from "@/lib/integrations/granola";
import { getImessageIntegrationState } from "@/lib/integrations/imessage";
import { getJamieIntegrationState } from "@/lib/integrations/jamie";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { listCurrentUserTaskSchedules } from "@/lib/task-schedules";
import { listCurrentUserTasks } from "@/lib/tasks";

export async function AppShell({ children }: { children: ReactNode }) {
  const { authUser, user, workspace, role, workspaces, brains, activeBrain } = await currentUser();
  const featureFlags = featureFlagsFromUser(user);
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
    imessage,
    codex,
    claudeCode,
    infisical,
    workspaceMembers,
    personalAccounts,
  ] = await Promise.all([
    listCurrentUserTasks(),
    featureFlags.taskSpawning ? listCurrentUserTaskSchedules() : Promise.resolve([]),
    listCurrentUserRecentChats(),
    getGoogleIntegrationState(user.workosUserId),
    getLinearIntegrationState(user.workosUserId),
    getPostHogIntegrationState(user.workosUserId),
    getGitHubIntegrationState(workspace.id),
    getJamieIntegrationState(workspace.id),
    getSlackIntegrationState(user.workosUserId),
    getGranolaIntegrationState(user.workosUserId),
    getFathomIntegrationState(user.workosUserId),
    getAttioIntegrationState(user.workosUserId),
    getStripeIntegrationState(workspace.id),
    getImessageIntegrationState(user.workosUserId),
    loadCurrentCodexAuthSettings(),
    loadCurrentClaudeCodeAuthSettings(),
    loadCurrentInfisicalAuthSettings(),
    listWorkspaceMembers(workspace.id),
    getPersonalAccounts(user.workosUserId),
  ]);

  const initialData: AppInitialData = {
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
      status: task.status as TaskStatus,
      stage: task.stage as TaskStage,
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
    chatResumeEnabled: isChatResumeEnabled(),
    mcpSetup: {
      preferredClient: user.preferredMcpClient,
      completedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
    },
  };

  return (
    <AnalyticsProvider
      identity={{
        userId: user.workosUserId,
        workspaceId: workspace.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }}
    >
      <AppDataProvider initialData={initialData}>{children}</AppDataProvider>
    </AnalyticsProvider>
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
  googleIntegrations: Pick<IntegrationState, "gmail" | "google_calendar" | "google_drive">;
  linear: IntegrationState["linear"];
  posthog: IntegrationState["posthog"];
  github: IntegrationState["github"];
  jamie: IntegrationState["jamie"];
  slack: IntegrationState["slack"];
  granola: IntegrationState["granola"];
  fathom: IntegrationState["fathom"];
  attio: IntegrationState["attio"];
  stripe: IntegrationState["stripe"];
  imessage: IntegrationState["imessage"];
  personalAccounts: IntegrationState["personalAccounts"];
  codex: CodexProviderState;
  claudeCode: ClaudeCodeProviderState;
  infisical: InfisicalProviderState;
}): IntegrationState {
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
    imessage: input.imessage,
    codex: input.codex,
    claude_code: input.claudeCode,
    infisical: input.infisical,
    personalAccounts: input.personalAccounts,
  };
}
