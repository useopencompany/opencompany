import { ProductAnalyticsProvider } from "@opencompany/analytics/product/client";
import type { ReactNode } from "react";
import { AppDataProvider, type AppInitialData } from "@/components/AppDataProvider";
import { loadOptionalAppShellData } from "@/lib/app-shell-loader";
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
  integrationStateFromRows,
} from "@/lib/integration-state";
import { getAttioIntegrationState } from "@/lib/integrations/attio";
import { getFathomIntegrationState } from "@/lib/integrations/fathom";
import { getGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGranolaIntegrationState } from "@/lib/integrations/granola";
import { getGranolaMcpIntegrationState } from "@/lib/integrations/granola-mcp";
import { getHubSpotMcpIntegrationState } from "@/lib/integrations/hubspot-mcp";
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
  const featureFlags = featureFlagsFromUser({
    ...user,
    legacyBrainEnabled: workspace.legacyBrainEnabled,
  });
  const emptyIntegrations = integrationStateFromRows([]);
  const [
    schedules,
    recentChats,
    googleIntegrations,
    linear,
    hubspot,
    posthog,
    github,
    jamie,
    slack,
    granola,
    granolaMcp,
    fathom,
    attio,
    stripe,
    xAccount,
    codex,
    claudeCode,
    infisical,
    workspaceSettings,
    personalAccounts,
  ] = await Promise.all([
    featureFlags.taskSpawning
      ? loadOptionalAppShellData("schedules", listHeadlessTaskSchedules, [])
      : Promise.resolve([]),
    loadOptionalAppShellData("recent_chats", listCurrentUserRecentChats, []),
    loadOptionalAppShellData(
      "google_integrations",
      () => getGoogleIntegrationState(user.workosUserId),
      emptyIntegrations,
    ),
    loadOptionalAppShellData(
      "linear_integration",
      () => getLinearIntegrationState(user.workosUserId),
      emptyIntegrations.linear,
    ),
    loadOptionalAppShellData(
      "hubspot_mcp_integration",
      () => getHubSpotMcpIntegrationState(user.workosUserId),
      emptyIntegrations.hubspot,
    ),
    loadOptionalAppShellData(
      "posthog_integration",
      () => getPostHogIntegrationState(user.workosUserId),
      emptyIntegrations.posthog,
    ),
    loadOptionalAppShellData(
      "github_integration",
      () => getGitHubIntegrationState(workspace.id),
      emptyIntegrations.github,
    ),
    loadOptionalAppShellData(
      "jamie_integration",
      () => getJamieIntegrationState(workspace.id),
      emptyIntegrations.jamie,
    ),
    loadOptionalAppShellData(
      "slack_integration",
      () => getSlackIntegrationState(user.workosUserId),
      emptyIntegrations.slack,
    ),
    loadOptionalAppShellData(
      "granola_integration",
      () => getGranolaIntegrationState(user.workosUserId),
      emptyIntegrations.granola,
    ),
    loadOptionalAppShellData(
      "granola_mcp_integration",
      () => getGranolaMcpIntegrationState(user.workosUserId),
      emptyIntegrations.granola_mcp,
    ),
    loadOptionalAppShellData(
      "fathom_integration",
      () => getFathomIntegrationState(user.workosUserId),
      emptyIntegrations.fathom,
    ),
    loadOptionalAppShellData(
      "attio_integration",
      () => getAttioIntegrationState(user.workosUserId),
      emptyIntegrations.attio,
    ),
    loadOptionalAppShellData(
      "stripe_integration",
      () => getStripeIntegrationState(workspace.id),
      emptyIntegrations.stripe,
    ),
    loadOptionalAppShellData(
      "x_account_integration",
      () => getXAccountIntegrationState(user.workosUserId),
      emptyIntegrations.x_account,
    ),
    loadOptionalAppShellData("codex_auth", loadCurrentCodexAuthSettings, {
      status: null,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      workspaceEngine: null,
    }),
    loadOptionalAppShellData("claude_code_auth", loadCurrentClaudeCodeAuthSettings, {
      status: null,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
    }),
    loadOptionalAppShellData("infisical_auth", loadCurrentInfisicalAuthSettings, {
      status: null,
      statusReason: null,
      accountEmail: null,
      host: null,
      lastValidatedAt: null,
    }),
    getWorkspaceSettingsAction(),
    loadOptionalAppShellData(
      "personal_accounts",
      getPersonalAccounts,
      emptyIntegrations.personalAccounts,
    ),
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
    brains: featureFlags.legacyBrain ? brains.map(brainSummaryView) : [],
    activeBrain: featureFlags.legacyBrain && activeBrain ? brainSummaryView(activeBrain) : null,
    // Task metadata hydrates from the API-owned Electric read model. Keeping the server snapshot
    // empty prevents the Next.js composition root from regaining a direct Task database reader.
    tasks: [],
    schedules,
    recentChats,
    integrations: buildIntegrationState({
      googleIntegrations,
      linear,
      hubspot,
      posthog,
      github,
      jamie,
      slack,
      granola,
      granolaMcp,
      fathom,
      attio,
      stripe,
      xAccount,
      personalAccounts,
      codex: {
        provider: "codex",
        connected: codex.status === "connected",
        status: codex.status ?? "not_connected",
        statusReason: codex.statusReason,
        lastValidatedAt: codex.lastValidatedAt,
        workspaceEngine: codex.workspaceEngine,
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
  hubspot: IntegrationState["hubspot"];
  posthog: IntegrationState["posthog"];
  github: IntegrationState["github"];
  jamie: IntegrationState["jamie"];
  slack: IntegrationState["slack"];
  granola: IntegrationState["granola"];
  granolaMcp: IntegrationState["granola_mcp"];
  fathom: IntegrationState["fathom"];
  attio: IntegrationState["attio"];
  stripe: IntegrationState["stripe"];
  xAccount: IntegrationState["x_account"];
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
    hubspot: input.hubspot,
    posthog: input.posthog,
    github: input.github,
    jamie: input.jamie,
    slack: input.slack,
    granola: input.granola,
    granola_mcp: input.granolaMcp,
    fathom: input.fathom,
    attio: input.attio,
    stripe: input.stripe,
    x_account: input.xAccount,
    codex: input.codex,
    claude_code: input.claudeCode,
    infisical: input.infisical,
    personalAccounts: input.personalAccounts,
  };
}
