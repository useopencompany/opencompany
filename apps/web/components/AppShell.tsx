import { ProductAnalyticsProvider } from "@opencompany/analytics/product/client";
import type { ReactNode } from "react";
import { AppDataProvider, type AppInitialData } from "@/components/AppDataProvider";
import { currentUser } from "@/lib/auth";
import { listCurrentUserRecentChats } from "@/lib/chat";
import { loadCurrentClaudeCodeAuthSettings } from "@/lib/claude-code-auth";
import { loadCurrentCodexAuthSettings } from "@/lib/codex-auth";
import { featureFlagsFromUser } from "@/lib/feature-flags";
import { listHeadlessTaskSchedules } from "@/lib/headless-automation-server";
import { loadCurrentInfisicalAuthSettings } from "@/lib/infisical-auth";
import {
  type ClaudeCodeProviderState,
  type CodexProviderState,
  type InfisicalProviderState,
  type IntegrationState,
} from "@/lib/integration-state";
import { getAttioIntegrationState } from "@/lib/integrations/attio";
import { getFathomIntegrationState } from "@/lib/integrations/fathom";
import { getGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGranolaIntegrationState } from "@/lib/integrations/granola";
import { getImessageIntegrationState } from "@/lib/integrations/imessage";
import { getJamieIntegrationState } from "@/lib/integrations/jamie";
import { getLinearIntegrationState } from "@/lib/integrations/linear-mcp";
import { getPersonalAccounts } from "@/lib/integrations/personal-accounts";
import { getPostHogIntegrationState } from "@/lib/integrations/posthog-mcp";
import { getSlackIntegrationState } from "@/lib/integrations/slack";
import { getStripeIntegrationState } from "@/lib/integrations/stripe";
import { getXAccountIntegrationState } from "@/lib/integrations/x-account";
import { getWorkspaceSettingsAction } from "@/lib/workspace-actions";

export async function AppShell({ children }: { children: ReactNode }) {
  const { authUser, user, workspace, role, workspaces, brains, activeBrain } = await currentUser();
  const featureFlags = featureFlagsFromUser(user);
  const [
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
    workspaceSettings,
    personalAccounts,
  ] = await Promise.all([
    featureFlags.taskSpawning ? listHeadlessTaskSchedules() : Promise.resolve([]),
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
    getXAccountIntegrationState(user.workosUserId),
    getImessageIntegrationState(user.workosUserId),
    loadCurrentCodexAuthSettings(),
    loadCurrentClaudeCodeAuthSettings(),
    loadCurrentInfisicalAuthSettings(),
    getWorkspaceSettingsAction(),
    getPersonalAccounts(),
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
    plan: workspaceSettings.plan,
    workspaces: workspaces.map((entry) => ({
      id: entry.workspace.id,
      name: entry.workspace.name,
      role: entry.role,
    })),
    workspaceMembers: workspaceSettings.members.map((member) => ({
      workosUserId: member.userWorkosId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      avatarUrl: member.avatarUrl,
    })),
    brains: brains.map(brainSummaryView),
    activeBrain: activeBrain ? brainSummaryView(activeBrain) : null,
    // Task metadata hydrates from the API-owned Electric read model. Keeping the server snapshot
    // empty prevents the Next.js composition root from regaining a direct Task database reader.
    tasks: [],
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
        host: infisical.host,
        lastValidatedAt: infisical.lastValidatedAt,
      },
    }),
    featureFlags,
    codexConnected: codex.status === "connected",
    claudeCodeConnected: claudeCode.status === "connected",
    mcpSetup: {
      preferredClient: user.preferredMcpClient,
      completedAt: user.mcpSetupCompletedAt?.toISOString() ?? null,
    },
  };

  return (
    <ProductAnalyticsProvider
      identity={{
        userId: user.workosUserId,
        workspaceId: workspace.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }}
    >
      <AppDataProvider initialData={initialData}>{children}</AppDataProvider>
    </ProductAnalyticsProvider>
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
  xAccount: IntegrationState["x_account"];
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
    x_account: input.xAccount,
    imessage: input.imessage,
    codex: input.codex,
    claude_code: input.claudeCode,
    infisical: input.infisical,
    personalAccounts: input.personalAccounts,
  };
}
