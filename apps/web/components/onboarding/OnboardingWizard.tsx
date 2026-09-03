"use client";

import { captureProductEvent, identifyProductUser } from "@opencompany/analytics/product/client";
import type { ProductOnboardingStep } from "@opencompany/analytics/product/events";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Code2,
  LineChart,
  Megaphone,
  MessagesSquare,
  Microscope,
  Rocket,
  Settings2,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { brainSourceHasScope, resolveBrainSourceState } from "@/components/BrainSourceCards";
import { ConnectIntegrationModal } from "@/components/onboarding/ConnectIntegrationModal";
import { OnboardingSourceCard } from "@/components/onboarding/OnboardingSourceCard";
import { SourceConfigSheet } from "@/components/onboarding/SourceConfigSheet";
import {
  type BrainSourcesDetails,
  getBrainSourcesAction,
  setBrainSourceEnabledAction,
} from "@/lib/brain-source-actions";
import {
  BRAIN_SOURCE_PROVIDERS,
  type BrainSourceProviderDef,
  brainSourceNeedsConfig,
} from "@/lib/brain-sources/registry";
import {
  checkWorkspaceSlugAction,
  finishOnboardingAction,
  saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction,
} from "@/lib/onboarding-actions";
import {
  ONBOARDING_CONNECTION_MESSAGE,
  ONBOARDING_CONNECTION_STORAGE_KEY,
  type OnboardingConnectionMessage,
  type OnboardingConnectionResult,
  onboardingConnectHref,
  onboardingConnectionError,
} from "@/lib/onboarding-integrations";
import { queueOnboardingKickoff } from "@/lib/onboarding-kickoff";
import {
  isOnboardingRole,
  normalizeOnboardingCompanyUrl,
  ONBOARDING_COMPANY_URL_MAX_LENGTH,
  type OnboardingRole,
} from "@/lib/onboarding-profile";

type OnboardingUser = {
  workosUserId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
};

type StepKey = ProductOnboardingStep;

type StepDef = { key: StepKey; label: string };

// Activation-optimized order: know them → name it (and scaffold its Brain from
// their role) → feed it → done. Referral is folded into the finish so it never
// interrupts a value step.
const OWNER_STEPS: StepDef[] = [
  { key: "profile", label: "About you" },
  { key: "workspace", label: "Create workspace" },
  { key: "sources", label: "Connect sources" },
  { key: "finish", label: "You're all set" },
];

const OWNER_WIKI_STEPS: StepDef[] = OWNER_STEPS.filter((step) => step.key !== "sources");

// Invited members join a workspace an admin already shaped, so they only need a
// welcome before entering the product.
const MEMBER_STEPS: StepDef[] = [
  { key: "welcome", label: "Welcome" },
  { key: "finish", label: "You're all set" },
];

// Nudge toward a strong starting set of connected sources; purely a UI goal,
// connecting sources no longer changes the ingestion allowance.
const SOURCE_GOAL = 4;

// A source only counts as "feeding" once it is both enabled and has enough scope
// selected to actually ingest (see brainSourceHasScope). Everything in
// onboarding reasons about this — never bare "enabled", which for the
// scope-required providers can be true while nothing flows.
function isSourceFeeding(
  providerId: BrainSourceProviderDef["id"],
  details: BrainSourcesDetails | null,
): boolean {
  const state = resolveBrainSourceState(providerId, details);
  return state.enabled && brainSourceHasScope(providerId, state.source?.config);
}

function countSourcesFeeding(details: BrainSourcesDetails | null): number {
  return BRAIN_SOURCE_PROVIDERS.filter((provider) => isSourceFeeding(provider.id, details)).length;
}

// Sources the user authorized but that aren't feeding the brain yet — the exact
// "landed with no sources" gap we surface before leaving the step.
function countSourcesAuthorizedNotFeeding(details: BrainSourcesDetails | null): number {
  return BRAIN_SOURCE_PROVIDERS.filter((provider) => {
    const state = resolveBrainSourceState(provider.id, details);
    return state.connected && !isSourceFeeding(provider.id, details);
  }).length;
}

type RoleProfile = {
  id: OnboardingRole;
  label: string;
  hint: string;
  icon: LucideIcon;
};

const ROLE_PROFILES: RoleProfile[] = [
  {
    id: "founder",
    label: "Founder / CEO",
    hint: "Running the whole company",
    icon: Rocket,
  },
  {
    id: "product",
    label: "Product / Engineering",
    hint: "Building the product",
    icon: Code2,
  },
  {
    id: "sales",
    label: "Sales / GTM",
    hint: "Pipeline & closing deals",
    icon: Target,
  },
  {
    id: "marketing",
    label: "Marketing / Growth",
    hint: "Demand & brand",
    icon: Megaphone,
  },
  {
    id: "operations",
    label: "Operations / Finance",
    hint: "Keeping it all running",
    icon: Settings2,
  },
  {
    id: "investing",
    label: "Investing / VC",
    hint: "Sourcing & backing companies",
    icon: LineChart,
  },
  {
    id: "consulting",
    label: "Consulting / Agency",
    hint: "Serving clients",
    icon: Briefcase,
  },
  {
    id: "research",
    label: "Research / Analysis",
    hint: "Digging into topics",
    icon: Microscope,
  },
];

// ---------------------------------------------------------------------------

type SlugStatus = "idle" | "checking" | "available" | "taken";
type CompanyUrlStatus = "idle" | "valid" | "invalid";

export function OnboardingWizard({
  user,
  currentWorkspaceName,
  brainRef,
  legacyBrainEnabled,
  variant,
  initialStep,
  initialWorkspaceId,
  initialWorkspaceName,
  initialSlug,
  initialRole,
  initialCompanyUrl,
  initialReferral,
  initialSourceDetails,
  initialConnectionResult,
}: {
  user: OnboardingUser;
  currentWorkspaceName: string;
  brainRef: string | null;
  legacyBrainEnabled: boolean;
  variant: "owner" | "member";
  initialStep: number;
  initialWorkspaceId: string | null;
  initialWorkspaceName: string;
  initialSlug: string;
  initialRole: string | null;
  initialCompanyUrl: string;
  initialReferral: string | null;
  initialSourceDetails: BrainSourcesDetails | null;
  initialConnectionResult: OnboardingConnectionResult | null;
}) {
  const router = useRouter();
  const steps =
    variant === "member" ? MEMBER_STEPS : legacyBrainEnabled ? OWNER_STEPS : OWNER_WIKI_STEPS;
  const normalizedInitialRole = isOnboardingRole(initialRole) ? initialRole : null;
  const [stepIndex, setStepIndex] = useState(() =>
    Math.min(Math.max(initialStep, 0), steps.length - 1),
  );

  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [slugTouched, setSlugTouched] = useState(Boolean(initialSlug));
  const [slug, setSlug] = useState(initialSlug);
  const [referral, setReferral] = useState<string | null>(initialReferral);
  const [role, setRole] = useState<OnboardingRole | null>(normalizedInitialRole);
  const [companyUrl, setCompanyUrl] = useState(initialCompanyUrl);
  const [activeBrainRef, setActiveBrainRef] = useState(brainRef);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId);
  const [isPending, startTransition] = useTransition();
  const [slugCheck, setSlugCheck] = useState<{
    slug: string;
    available: boolean;
  } | null>(null);
  // Source details live here (not inside SourcesStep) so the leave-step gate can
  // read whether anything is actually feeding the brain.
  const [sourceDetails, setSourceDetails] = useState(initialSourceDetails);
  const [sourcesGateConfirmed, setSourcesGateConfirmed] = useState(false);
  const [showSourcesGate, setShowSourcesGate] = useState(false);
  const analyticsStartedRef = useRef(false);
  const analyticsStepsViewedRef = useRef(new Set<StepKey>());

  const reloadSourceDetails = useCallback(async () => {
    if (!activeBrainRef) return null;
    const next = await getBrainSourcesAction(activeBrainRef);
    setSourceDetails(next);
    return next;
  }, [activeBrainRef]);

  const authorizedNotFeeding = useMemo(
    () => countSourcesAuthorizedNotFeeding(sourceDetails),
    [sourceDetails],
  );

  const step = steps[stepIndex] ?? steps[0]!;
  const isLast = stepIndex === steps.length - 1;
  const effectiveSlug = slugTouched ? slug : slugify(workspaceName);
  const normalizedCompanyUrl = normalizeOnboardingCompanyUrl(companyUrl);
  const companyUrlStatus: CompanyUrlStatus = !companyUrl.trim()
    ? "idle"
    : normalizedCompanyUrl
      ? "valid"
      : "invalid";
  const shouldCheckSlug = step.key === "workspace" && effectiveSlug.length > 0;
  const slugStatus: SlugStatus = !shouldCheckSlug
    ? "idle"
    : slugCheck?.slug === effectiveSlug
      ? slugCheck.available
        ? "available"
        : "taken"
      : "checking";

  useEffect(() => {
    identifyProductUser({ userId: user.workosUserId, email: user.email });
    if (analyticsStartedRef.current) return;
    analyticsStartedRef.current = true;
    captureProductEvent("onboarding_started", {
      flow: variant,
      initial_step: step.key,
      initial_step_index: stepIndex,
      total_steps: steps.length,
      is_resume: stepIndex > 0,
      ...(activeWorkspaceId ? { workspace_id: activeWorkspaceId } : {}),
    });
  }, [
    activeWorkspaceId,
    step.key,
    stepIndex,
    steps.length,
    user.email,
    user.workosUserId,
    variant,
  ]);

  useEffect(() => {
    if (analyticsStepsViewedRef.current.has(step.key)) return;
    analyticsStepsViewedRef.current.add(step.key);
    captureProductEvent("onboarding_step_viewed", {
      flow: variant,
      step: step.key,
      step_index: stepIndex,
      total_steps: steps.length,
      ...(activeWorkspaceId ? { workspace_id: activeWorkspaceId } : {}),
    });
  }, [activeWorkspaceId, step.key, stepIndex, steps.length, variant]);

  // Persist the active step to a cookie so an OAuth round-trip (connecting a
  // source) resumes exactly here.
  useEffect(() => {
    document.cookie = `${ONBOARDING_STEP_COOKIE}=${stepIndex}; path=/; max-age=86400; samesite=lax`;
  }, [stepIndex]);

  // Live workspace-URL availability check (debounced).
  useEffect(() => {
    if (!shouldCheckSlug) return;
    const timer = window.setTimeout(() => {
      void checkWorkspaceSlugAction(effectiveSlug).then((result) => {
        setSlugCheck({ slug: effectiveSlug, available: result.available });
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [effectiveSlug, shouldCheckSlug]);

  // Saves the current step server-side; returns false (and toasts) on rejection.
  const persistCurrentStep = async (): Promise<boolean> => {
    if (step.key === "profile") {
      const r = await saveOnboardingProfileAction({ role, companyUrl });
      return r.ok || toastFail(r.error);
    }
    if (step.key === "workspace") {
      const r = await saveOnboardingWorkspaceAction({
        name: workspaceName,
        slug: effectiveSlug,
      });
      if (!r.ok) return toastFail(r.error);
      setActiveBrainRef(r.brainRef);
      setActiveWorkspaceId(r.workspaceId);
      return true;
    }
    if (step.key === "finish") {
      const r = await finishOnboardingAction({ referralSource: referral });
      return r.ok || toastFail(r.error);
    }
    return true;
  };

  const advance = () => {
    startTransition(async () => {
      if (!(await persistCurrentStep())) return;
      if (isLast) {
        if (activeWorkspaceId) {
          const sourcesFeeding = countSourcesFeeding(sourceDetails);
          captureProductEvent("onboarding_completed", {
            flow: variant,
            total_steps: steps.length,
            workspace_id: activeWorkspaceId,
            sources_feeding: sourcesFeeding,
            source_goal_met: sourcesFeeding >= SOURCE_GOAL,
          });
        }
        if (variant === "owner" && normalizedCompanyUrl) {
          if (!queueOnboardingKickoff(normalizedCompanyUrl)) {
            toast.error("Onboarding finished, but the first Wiki run could not be started.");
          }
        }
        router.push("/");
        return;
      }
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    });
  };

  const goNext = () => {
    // Before leaving the sources step, surface any account the user authorized
    // but never finished configuring — otherwise they land in a brain with
    // nothing flowing in. Soft gate: they can still continue anyway.
    if (step.key === "sources" && !isLast && authorizedNotFeeding > 0 && !sourcesGateConfirmed) {
      setShowSourcesGate(true);
      return;
    }
    advance();
  };
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  const canContinue =
    step.key === "profile"
      ? role !== null && companyUrlStatus === "valid"
      : step.key === "workspace"
        ? workspaceName.trim().length > 0 && effectiveSlug.length > 0 && slugStatus !== "taken"
        : true;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-canvas text-ink">
      {/* Progress bar — fills per step */}
      <div className="h-[3px] w-full shrink-0 bg-surface-subtle">
        <div
          className="h-full bg-ink transition-all duration-300"
          style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
        />
      </div>

      {/* Vertically centered content column with nav attached directly below */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center px-6 py-12">
          {step.key === "profile" && (
            <ProfileStep
              user={user}
              role={role}
              onRole={setRole}
              companyUrl={companyUrl}
              onCompanyUrl={setCompanyUrl}
              companyUrlStatus={companyUrlStatus}
            />
          )}
          {step.key === "workspace" && (
            <WorkspaceStep
              user={user}
              name={workspaceName}
              onName={(v) => {
                setWorkspaceName(v);
                if (!slugTouched) setSlug(slugify(v));
              }}
              slug={effectiveSlug}
              onSlug={(v) => {
                setSlugTouched(true);
                setSlug(slugify(v));
              }}
              slugStatus={slugStatus}
            />
          )}
          {step.key === "welcome" && (
            <WelcomeStep user={user} workspaceName={currentWorkspaceName} />
          )}
          {step.key === "sources" && (
            <SourcesStep
              brainRef={activeBrainRef}
              details={sourceDetails}
              reload={reloadSourceDetails}
              initialConnectionResult={initialConnectionResult}
            />
          )}
          {step.key === "finish" && (
            <FinishStep
              workspaceName={variant === "member" ? currentWorkspaceName : workspaceName}
              referral={referral}
              onSelect={setReferral}
              showReferral={variant === "owner"}
            />
          )}

          {/* Nav — sits right under the content */}
          <div className="mt-9 flex items-center justify-between">
            <button
              type="button"
              onClick={goBack}
              disabled={stepIndex === 0 || isPending}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink disabled:invisible"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Back
            </button>
            <div className="flex items-center gap-2">
              {isSkippable(step.key) && !isLast && (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={isPending}
                  className="rounded-lg px-3 py-2 text-[13px] font-medium text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
                >
                  Skip
                </button>
              )}
              <button
                type="button"
                onClick={goNext}
                disabled={!canContinue || isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {isPending ? "Saving…" : isLast ? "Finish onboarding" : "Continue"}
                {!isLast && !isPending && <ArrowRight size={15} strokeWidth={2} />}
              </button>
            </div>
          </div>
        </div>
      </main>

      {showSourcesGate ? (
        <SourcesGateDialog
          count={authorizedNotFeeding}
          onSetUp={() => setShowSourcesGate(false)}
          onContinueAnyway={() => {
            setShowSourcesGate(false);
            setSourcesGateConfirmed(true);
            advance();
          }}
        />
      ) : null}
    </div>
  );
}

function isSkippable(key: StepKey) {
  return key === "sources";
}

// Soft gate shown when the user tries to leave the sources step with accounts
// they authorized but never finished configuring. Not a hard block — the point
// is to make the gap visible and one click away from being fixed.
function SourcesGateDialog({
  count,
  onSetUp,
  onContinueAnyway,
}: {
  count: number;
  onSetUp: () => void;
  onContinueAnyway: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onSetUp();
      }}
    >
      <DialogContent className="max-w-[420px]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-[15px]">Finish connecting your sources?</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
            {count === 1
              ? "1 account is connected but isn't feeding your Brain yet — choose what it should ingest so your Brain starts learning right away."
              : `${count} accounts are connected but aren't feeding your Brain yet — choose what they should ingest so your Brain starts learning right away.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onContinueAnyway}
            className="rounded-lg px-3 py-2 text-[13px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Continue anyway
          </button>
          <button
            type="button"
            onClick={onSetUp}
            className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90"
          >
            Set them up
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function toastFail(message: string): false {
  toast.error(message);
  return false;
}

// ---------------------------------------------------------------------------
// Shared step chrome
// ---------------------------------------------------------------------------

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-7 flex flex-col gap-2">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
      <p className="text-[14px] leading-6 text-ink-muted">{subtitle}</p>
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-4 text-ink-subtle">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/40 focus:ring-2 focus:ring-ink/10";

function IdentityRow({ user }: { user: OnboardingUser }) {
  const initial = user.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
      ) : (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-[14px] font-medium text-canvas">
          {initial}
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-ink">{user.name}</div>
        <div className="truncate text-[12px] text-ink-subtle">{user.email}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Profile (role + company URL)
// ---------------------------------------------------------------------------

function ProfileStep({
  user,
  role,
  onRole,
  companyUrl,
  onCompanyUrl,
  companyUrlStatus,
}: {
  user: OnboardingUser;
  role: OnboardingRole | null;
  onRole: (id: OnboardingRole) => void;
  companyUrl: string;
  onCompanyUrl: (v: string) => void;
  companyUrlStatus: CompanyUrlStatus;
}) {
  const companyUrlHint =
    companyUrlStatus === "valid"
      ? "URL looks good. We'll use it to start your first Wiki research run."
      : companyUrlStatus === "invalid"
        ? "Enter a valid company URL."
        : "We'll use this to start your first Wiki research run.";

  return (
    <div>
      <StepHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        subtitle="Tell us a little about your role and company so we can shape your Wiki around how you work."
      />

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2.5">
          <span className="text-[12px] font-medium text-ink">What best describes your role?</span>
          <div className="grid grid-cols-2 gap-2.5">
            {ROLE_PROFILES.map((profile) => {
              const active = role === profile.id;
              const Icon = profile.icon;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => onRole(profile.id)}
                  aria-pressed={active}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                    active
                      ? "border-ink bg-surface-active/50"
                      : "border-border bg-surface hover:border-border-strong"
                  }`}
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                      active ? "bg-ink text-canvas" : "bg-surface-muted text-ink-muted"
                    }`}
                  >
                    <Icon size={17} strokeWidth={1.9} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[13px] font-medium ${active ? "text-ink" : "text-ink-muted"}`}
                    >
                      {profile.label}
                    </div>
                    <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                      {profile.hint}
                    </div>
                  </div>
                  {active && <Check size={15} strokeWidth={2.4} className="shrink-0 text-ink" />}
                </button>
              );
            })}
          </div>
        </div>

        <Field label="Company URL" hint={companyUrlHint}>
          <input
            className={inputClass}
            type="url"
            inputMode="url"
            autoComplete="url"
            value={companyUrl}
            onChange={(e) => onCompanyUrl(e.target.value)}
            maxLength={ONBOARDING_COMPANY_URL_MAX_LENGTH}
            placeholder="https://yourcompany.com"
            required
          />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Workspace
// ---------------------------------------------------------------------------

function WorkspaceStep({
  user,
  name,
  onName,
  slug,
  onSlug,
  slugStatus,
}: {
  user: OnboardingUser;
  name: string;
  onName: (v: string) => void;
  slug: string;
  onSlug: (v: string) => void;
  slugStatus: SlugStatus;
}) {
  const slugHint =
    slug.length === 0
      ? "You can change this later."
      : slugStatus === "checking"
        ? "Checking availability…"
        : slugStatus === "taken"
          ? "That URL is taken — try another."
          : slugStatus === "available"
            ? "Available."
            : "You can change this later.";

  return (
    <div>
      <StepHeader
        title="Create your workspace"
        subtitle="This is the home for your company's brain. You can invite teammates later."
      />

      <IdentityRow user={user} />

      <div className="mt-6 flex flex-col gap-5">
        <Field label="Company name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Acme Inc."
            autoFocus
          />
        </Field>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink">Workspace URL</span>
          <div
            className={`flex items-stretch overflow-hidden rounded-lg border bg-surface focus-within:ring-2 focus-within:ring-ink/10 ${
              slugStatus === "taken"
                ? "border-danger-border focus-within:border-danger"
                : "border-border focus-within:border-ink/40"
            }`}
          >
            <span className="flex items-center bg-surface-muted px-3 text-[13px] text-ink-subtle">
              opencompany.chat/
            </span>
            <input
              className="w-full bg-transparent px-2.5 py-2 text-[14px] text-ink outline-none placeholder:text-ink-subtle"
              value={slug}
              onChange={(e) => onSlug(e.target.value)}
              placeholder="acme"
            />
            {slugStatus === "available" && slug.length > 0 && (
              <span className="flex items-center pr-2.5 text-success">
                <Check size={15} strokeWidth={2.4} />
              </span>
            )}
          </div>
          <span
            className={`text-[11.5px] leading-4 ${
              slugStatus === "taken"
                ? "text-danger"
                : slugStatus === "available"
                  ? "text-success"
                  : "text-ink-subtle"
            }`}
          >
            {slugHint}
          </span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Welcome (invited members)
// ---------------------------------------------------------------------------

function WelcomeStep({ user, workspaceName }: { user: OnboardingUser; workspaceName: string }) {
  return (
    <div>
      <StepHeader
        title={`Welcome to ${workspaceName}`}
        subtitle="You've been added to this company's brain. It already knows a lot — here's how to start putting it to work."
      />

      <IdentityRow user={user} />

      <div className="mt-6 flex flex-col gap-2.5">
        <HighlightRow
          icon={MessagesSquare}
          title="Ask it anything"
          text="Chat with the brain to get up to speed on people, projects, and decisions."
        />
        <HighlightRow
          icon={ShieldCheck}
          title="Access follows your admin's rules"
          text="You only ever see what you've been given access to — nothing more."
        />
      </div>
    </div>
  );
}

function HighlightRow({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink">
        <Icon size={17} strokeWidth={1.9} />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <div className="text-[12px] leading-5 text-ink-subtle">{text}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Step — Sources
// ---------------------------------------------------------------------------

const POPUP_WIDTH = 560;
const POPUP_HEIGHT = 760;

function SourcesStep({
  brainRef,
  details,
  reload,
  initialConnectionResult,
}: {
  brainRef: string | null;
  details: BrainSourcesDetails | null;
  reload: () => Promise<BrainSourcesDetails | null>;
  initialConnectionResult: OnboardingConnectionResult | null;
}) {
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // The api_key/webhook providers connect inside a modal rather than navigating
  // out of the wizard.
  const [modalProvider, setModalProvider] = useState<BrainSourceProviderDef | null>(null);
  // The focused config surface that opens the moment a scope-required source
  // authorizes, so the user picks what to ingest in one continuous motion.
  const [configProvider, setConfigProvider] = useState<BrainSourceProviderDef | null>(null);
  // When the OAuth popup is blocked we surface an in-wizard notice with a plain
  // anchor instead of a same-tab redirect that would drop wizard state.
  const [popupBlocked, setPopupBlocked] = useState<{ name: string; href: string } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(() =>
    initialConnectionResult?.status === "error"
      ? onboardingConnectionError(initialConnectionResult.provider, initialConnectionResult.reason)
      : null,
  );
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const connectingRef = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const initialConnectionHandledRef = useRef(false);

  // Runs after any connect path finishes. Refreshes state, then either opens the
  // config surface (scope-required providers can't feed until something is
  // picked) or turns the source on so it feeds immediately (the meeting-note
  // providers, which have nothing to scope). This is the fix for landing in a
  // brain where connected accounts silently ingest nothing.
  const onSourceConnected = useCallback(
    async (providerId: string | null) => {
      const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === providerId) ?? null;
      const next = await reload();
      if (!provider) return;
      const state = resolveBrainSourceState(provider.id, next);
      if (!state.connected) {
        setConnectionNotice(null);
        setConnectionError(`${provider.name} authorization was not completed.`);
        return;
      }
      setConnectionError(null);
      if (brainSourceNeedsConfig(provider.id)) {
        setConnectionNotice(null);
        setConfigProvider(provider);
        return;
      }
      // Nothing to scope — enable it so meetings/notes flow into this brain now.
      if (brainRef && state.integrationId && !state.enabled) {
        const result = await setBrainSourceEnabledAction({
          brainRef,
          provider: provider.id,
          integrationId: state.integrationId,
          enabled: true,
        });
        if (!result.ok) {
          setConnectionError(result.error);
          return;
        }
        await reload();
      }
      setConnectionNotice(`${provider.name} is now feeding your Brain.`);
    },
    [brainRef, reload],
  );

  useEffect(() => {
    function handleConnection(message: OnboardingConnectionMessage | undefined) {
      if (!message || message.type !== ONBOARDING_CONNECTION_MESSAGE) return;
      if (connectingRef.current && message.provider !== connectingRef.current) return;

      popupRef.current?.close();
      popupRef.current = null;
      connectingRef.current = null;
      setConnectingId(null);
      setPopupBlocked(null);
      if (message.status === "connected") {
        void onSourceConnected(message.provider);
      } else {
        setConnectionNotice(null);
        setConnectionError(onboardingConnectionError(message.provider, message.reason));
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      handleConnection(event.data as OnboardingConnectionMessage | undefined);
    }

    function onStorage(event: StorageEvent) {
      if (event.key !== ONBOARDING_CONNECTION_STORAGE_KEY || !event.newValue) return;
      try {
        handleConnection(JSON.parse(event.newValue) as OnboardingConnectionMessage);
      } catch {
        // Ignore malformed local state; OAuth state remains server-verified.
      }
    }

    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [onSourceConnected]);

  useEffect(
    () => () => {
      if (popupPollRef.current !== null) window.clearInterval(popupPollRef.current);
    },
    [],
  );

  // Full-page OAuth (popup-blocked fallback) returns to /onboarding?setup=connected;
  // run the same post-connect handling so the config surface opens on arrival.
  useEffect(() => {
    if (initialConnectionHandledRef.current) return;
    initialConnectionHandledRef.current = true;
    if (initialConnectionResult?.status === "connected" && initialConnectionResult.provider) {
      // Not a synchronous cascading render: onSourceConnected awaits reload()
      // before any setState, so this only runs once on the OAuth-return mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void onSourceConnected(initialConnectionResult.provider);
    }
  }, [initialConnectionResult, onSourceConnected]);

  const openConnection = (provider: BrainSourceProviderDef) => {
    setConnectionError(null);
    setConnectionNotice(null);
    setPopupBlocked(null);

    if (provider.connectionKind !== "oauth") {
      if (!details) void reload();
      setModalProvider(provider);
      return;
    }

    const connectHref = onboardingConnectHref(provider.connectHref);
    const left = window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 2);
    const popup = window.open(
      connectHref,
      "goat-onboarding-connect",
      `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`,
    );

    if (!popup) {
      // Same-tab redirect would discard unsaved wizard state; offer a plain
      // anchor instead. The anchor-opened tab has no usable window.opener, so
      // /onboarding/connected completes via localStorage → the storage listener.
      setPopupBlocked({ name: provider.name, href: connectHref });
      return;
    }

    setConnectingId(provider.id);
    popupRef.current = popup;
    connectingRef.current = provider.id;
    if (popupPollRef.current !== null) window.clearInterval(popupPollRef.current);
    popupPollRef.current = window.setInterval(() => {
      if (!popup.closed) return;
      if (popupPollRef.current !== null) window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
      if (connectingRef.current !== provider.id) return;

      connectingRef.current = null;
      popupRef.current = null;
      setConnectingId(null);
      void onSourceConnected(provider.id);
    }, 500);
  };

  const feedingCount = countSourcesFeeding(details);
  const authorizedCount = BRAIN_SOURCE_PROVIDERS.filter(
    (provider) => resolveBrainSourceState(provider.id, details).connected,
  ).length;
  const pct = Math.min(100, (feedingCount / SOURCE_GOAL) * 100);

  return (
    <div>
      <StepHeader
        title="Connect your sources"
        subtitle="Authorize an account and we'll walk you straight into choosing what it feeds your Brain."
      />

      {connectionError ? (
        <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger">
          {connectionError}
        </div>
      ) : null}
      {connectionNotice ? (
        <div className="mb-4 rounded-md border border-success-border bg-success-bg px-3 py-2 text-[12px] leading-4 text-success">
          {connectionNotice}
        </div>
      ) : null}
      {popupBlocked ? (
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-[12px] leading-4 text-ink-muted">
          <span>Your browser blocked the {popupBlocked.name} connect window.</span>
          <a
            href={popupBlocked.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center rounded-md border border-ink/15 px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            Open connect window
          </a>
        </div>
      ) : null}

      <div className="mb-5 rounded-lg border border-border bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="font-medium text-ink">
            {feedingCount >= SOURCE_GOAL
              ? "Your Brain has a strong starting set of sources."
              : `Set up ${SOURCE_GOAL - feedingCount} more to get the most out of your Brain`}
          </span>
          <span className="font-medium text-success">{feedingCount} feeding</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-subtle">
          <div
            className="h-full rounded-full bg-success transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[11.5px] leading-4 text-ink-subtle">
          {authorizedCount} authorized · {feedingCount} feeding your Brain
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {BRAIN_SOURCE_PROVIDERS.map((provider) => (
          <OnboardingSourceCard
            key={provider.id}
            brainRef={brainRef ?? ""}
            provider={provider}
            details={details}
            onConnect={() => openConnection(provider)}
            onConfigure={() => setConfigProvider(provider)}
            onChanged={async () => {
              await reload();
            }}
            connectPending={connectingId === provider.id}
            connectDisabled={connectingId !== null}
          />
        ))}
      </div>

      {!brainRef ? (
        <p className="mt-3 text-[12px] leading-4 text-danger">
          A Brain is required before sources can be configured.
        </p>
      ) : null}

      {modalProvider ? (
        <ConnectIntegrationModal
          provider={modalProvider}
          details={details}
          onClose={() => {
            // Reload on close picks up partial progress (e.g. a Jamie endpoint
            // created without a key yet — reopening shows the persisted URL).
            setModalProvider(null);
            void reload();
          }}
          onConnected={() => {
            const providerId = modalProvider.id;
            setModalProvider(null);
            void onSourceConnected(providerId);
          }}
        />
      ) : null}

      {configProvider && brainRef ? (
        <SourceConfigSheet
          brainRef={brainRef}
          provider={configProvider}
          details={details}
          onClose={() => {
            setConfigProvider(null);
            void reload();
          }}
          onChanged={async () => {
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Finish (with referral folded in)
// ---------------------------------------------------------------------------

const REFERRAL_OPTIONS = [
  "X / Twitter",
  "LinkedIn",
  "Friend or colleague",
  "Search engine",
  "Slack or Discord community",
  "Podcast or newsletter",
  "YouTube",
  "Other",
];

function FinishStep({
  workspaceName,
  referral,
  onSelect,
  showReferral,
}: {
  workspaceName: string;
  referral: string | null;
  onSelect: (v: string) => void;
  showReferral: boolean;
}) {
  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-success/10 text-success">
          <Check size={22} strokeWidth={2.6} />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
            You&apos;re all set
          </h1>
          <p className="text-[14px] leading-6 text-ink-muted">
            {workspaceName ? `${workspaceName} is ready.` : "Your brain is ready."} It&apos;ll keep
            learning as content flows in — you can shape it anytime.
          </p>
        </div>
      </div>

      {!showReferral ? null : (
        <div className="mt-7 flex flex-col gap-3">
          <span className="text-[12px] font-medium text-ink">
            One last thing — how did you hear about opencompany?
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            {REFERRAL_OPTIONS.map((option) => {
              const active = referral === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSelect(option)}
                  className={`flex items-center justify-between rounded-xl border px-3.5 py-3 text-left text-[13px] font-medium transition-colors ${
                    active
                      ? "border-ink bg-surface-active/50 text-ink"
                      : "border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink"
                  }`}
                >
                  {option}
                  {active && <Check size={15} strokeWidth={2.4} className="text-ink" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/'s workspace$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
