import { cookies } from "next/headers";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { currentIdentity, currentUser } from "@/lib/auth";
import { getOnboardingState } from "@/lib/onboarding-actions";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const identity = await currentIdentity();
  const name =
    [identity.user.firstName, identity.user.lastName].filter(Boolean).join(" ").trim() ||
    "Teammate";

  const [context, params, state, cookieStore] = await Promise.all([
    currentUser({ optional: true }),
    searchParams,
    getOnboardingState(),
    cookies(),
  ]);
  const onboarding = state.onboarding;

  // Real signal for "came from an invite": the active workspace was created by
  // someone else, so this user joined it rather than starting it.
  const joinedByInvite = state.workspace !== null && !state.workspace.createdByCaller;
  const override = params.variant;
  const variant: "owner" | "member" =
    context && override === "member"
      ? "member"
      : override === "owner"
        ? "owner"
        : joinedByInvite
          ? "member"
          : "owner";

  const legacyBrainEnabled = context?.workspace.legacyBrainEnabled === true;

  const savedSlug = context?.workspace.slug ?? "";
  const stepCookie = Number.parseInt(cookieStore.get(ONBOARDING_STEP_COOKIE)?.value ?? "", 10);
  const requestedStep = Number.isNaN(stepCookie) ? 0 : stepCookie;
  // A stale onboarding cookie must never skip past workspace creation.
  const initialStep = context ? requestedStep : Math.min(requestedStep, 1);

  return (
    <OnboardingWizard
      user={{
        workosUserId: identity.user.workosUserId,
        name,
        email: identity.user.email,
        avatarUrl: identity.user.avatarUrl,
      }}
      currentWorkspaceName={context?.workspace.name ?? ""}
      legacyBrainEnabled={legacyBrainEnabled}
      variant={variant}
      initialStep={initialStep}
      initialWorkspaceId={context?.workspace.id ?? null}
      initialWorkspaceName={savedSlug ? (context?.workspace.name ?? "") : ""}
      initialSlug={savedSlug}
      initialRole={onboarding?.role ?? null}
      initialCompanyUrl={onboarding?.contextUrls?.[0] ?? onboarding?.companyDomain ?? ""}
      initialReferral={onboarding?.referralSource ?? null}
    />
  );
}
