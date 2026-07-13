import { getGoatOnboarding } from "@opencompany/db/goat-workspaces";
import { cookies } from "next/headers";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { currentGoatUser } from "@/lib/auth";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatGmailSourceIntegrationState } from "@/lib/integrations/google-data";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import { getGoatLinearSourceIntegrationState } from "@/lib/integrations/linear-ingest";
import { getGoatSlackIntegrationState } from "@/lib/integrations/slack";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const context = await currentGoatUser();
  const userWorkosId = context.user.workosUserId;
  const name =
    [context.user.firstName, context.user.lastName].filter(Boolean).join(" ").trim() ||
    context.user.email;

  // Real signal for "came from an invite": the active workspace was created by
  // someone else, so this user joined it rather than starting it.
  const joinedByInvite = context.workspace.createdByWorkosId !== userWorkosId;
  const override = (await searchParams).variant;
  const variant: "owner" | "member" =
    override === "member"
      ? "member"
      : override === "owner"
        ? "owner"
        : joinedByInvite
          ? "member"
          : "owner";

  // Hydrate anything already persisted so the flow resumes cleanly (e.g. after an
  // OAuth round-trip when connecting a source).
  const [onboarding, jamie, slack, github, linear, gmail, cookieStore] = await Promise.all([
    getGoatOnboarding(userWorkosId),
    getGoatJamieIntegrationState(userWorkosId),
    getGoatSlackIntegrationState(userWorkosId),
    getGoatGitHubIntegrationState(userWorkosId),
    getGoatLinearSourceIntegrationState(userWorkosId),
    getGoatGmailSourceIntegrationState(userWorkosId),
    cookies(),
  ]);

  const connectedProviders = [
    jamie.connected ? "jamie" : null,
    slack.connected ? "slack" : null,
    gmail.connected ? "gmail" : null,
    linear.connected ? "linear" : null,
    github.connected ? "github" : null,
  ].filter((p): p is string => p !== null);

  const savedSlug = context.workspace.slug ?? "";
  const stepCookie = Number.parseInt(cookieStore.get(ONBOARDING_STEP_COOKIE)?.value ?? "", 10);

  return (
    <OnboardingWizard
      user={{ name, email: context.user.email, avatarUrl: context.user.avatarUrl }}
      currentWorkspaceName={context.workspace.name}
      brainRef={context.activeBrain?.id ?? null}
      variant={variant}
      initialStep={Number.isNaN(stepCookie) ? 0 : stepCookie}
      // Manual entry: only prefill once the user has saved a slug (i.e. resuming),
      // never the auto-generated "…'s Workspace" default.
      initialWorkspaceName={savedSlug ? context.workspace.name : ""}
      initialSlug={savedSlug}
      initialCompanyDomain={onboarding?.companyDomain ?? ""}
      initialContextUrls={onboarding?.contextUrls ?? []}
      initialReferral={onboarding?.referralSource ?? null}
      connectedProviders={connectedProviders}
    />
  );
}
