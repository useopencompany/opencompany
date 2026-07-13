import { getGoatOnboarding } from "@opencompany/db/goat-workspaces";
import { cookies } from "next/headers";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { currentGoatUser } from "@/lib/auth";
import { getGoatBrainSourcesAction } from "@/lib/brain-source-actions";
import type { GoatOnboardingConnectionResult } from "@/lib/onboarding-integrations";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    variant?: string;
    integration?: string;
    setup?: string;
    reason?: string;
  }>;
}) {
  const context = await currentGoatUser();
  const userWorkosId = context.user.workosUserId;
  const name =
    [context.user.firstName, context.user.lastName].filter(Boolean).join(" ").trim() ||
    context.user.email;

  // Real signal for "came from an invite": the active workspace was created by
  // someone else, so this user joined it rather than starting it.
  const joinedByInvite = context.workspace.createdByWorkosId !== userWorkosId;
  const params = await searchParams;
  const override = params.variant;
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
  const [onboarding, sourceDetails, cookieStore] = await Promise.all([
    getGoatOnboarding(userWorkosId),
    context.activeBrain ? getGoatBrainSourcesAction(context.activeBrain.id) : null,
    cookies(),
  ]);
  const connectionResult: GoatOnboardingConnectionResult | null =
    params.setup === "connected" || params.setup === "error"
      ? {
          provider: params.integration ?? null,
          status: params.setup,
          reason: params.reason ?? null,
        }
      : null;

  const savedSlug = context.workspace.slug ?? "";
  const stepCookie = Number.parseInt(cookieStore.get(ONBOARDING_STEP_COOKIE)?.value ?? "", 10);

  return (
    <OnboardingWizard
      user={{
        name,
        email: context.user.email,
        avatarUrl: context.user.avatarUrl,
      }}
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
      initialSourceDetails={sourceDetails}
      initialConnectionResult={connectionResult}
    />
  );
}
