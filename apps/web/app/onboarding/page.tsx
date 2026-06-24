import { AnalyticsProvider } from "@opencompany/analytics/client";
import { redirect } from "next/navigation";
import OnboardingForm from "@/components/OnboardingForm";
import { ToastProvider } from "@/components/ToastProvider";
import { currentWorkspace, hasCompletedOnboarding } from "@/lib/auth";
import { loadWorkspaceIntegrationStateForWorkspace } from "@/lib/integrations/actions";
import { loadGoogleIntegrationStateForWorkspace } from "@/lib/integrations/google-data";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { buildPersonalIntegrationDetails } from "@/lib/personal/integration-details-server";
import type { PersonalIntegrationConnections } from "@/lib/personal/integrations-catalog";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

type OnboardingPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function hasOnboardingFlag(searchParams: OnboardingPageProps["searchParams"]) {
  const params = await searchParams;
  return Object.hasOwn(params, "onboarding");
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const { authUser, user, workspace } = await currentWorkspace({ skipOnboarding: true });
  const forceOnboarding = await hasOnboardingFlag(searchParams);

  if (!forceOnboarding && (await hasCompletedOnboarding(user))) {
    redirect("/");
  }

  const [workspaceIntegrations, googleState, mcpSettings, toolPolicies] = await Promise.all([
    loadWorkspaceIntegrationStateForWorkspace(workspace.id),
    loadGoogleIntegrationStateForWorkspace(workspace.id),
    loadWorkspaceMcpSettingsForWorkspace(workspace.id),
    loadWorkspaceToolPolicyOverrides(workspace.id),
  ]);

  const integrationConnections: PersonalIntegrationConnections = {
    github: workspaceIntegrations.github.status === "connected",
    gmail: googleState.gmail.status === "connected",
    google_calendar: googleState.google_calendar.status === "connected",
    google_drive: googleState.google_drive.status === "connected",
    linear: mcpSettings.linear.configured,
    slack: mcpSettings.slack.configured,
    posthog: mcpSettings.posthog.configured,
    betterstack: mcpSettings.betterstack.configured,
    braintrust: mcpSettings.braintrust.configured,
    notion: mcpSettings.notion.configured,
  };

  const integrationDetails = buildPersonalIntegrationDetails({
    github: workspaceIntegrations.github,
    google: googleState,
    mcp: mcpSettings,
  });

  return (
    <AnalyticsProvider
      identity={{
        userId: user.id,
        workspaceId: workspace.id,
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
      }}
    >
      <ToastProvider>
        <OnboardingForm
          userEmail={authUser.email}
          userId={user.id}
          workspaceId={workspace.id}
          forceOnboarding={forceOnboarding}
          integrationConnections={integrationConnections}
          integrationDetails={integrationDetails}
          toolPolicies={toolPolicies}
        />
      </ToastProvider>
    </AnalyticsProvider>
  );
}
