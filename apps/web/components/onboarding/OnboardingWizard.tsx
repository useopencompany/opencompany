"use client";

import { captureProductEvent, identifyProductUser } from "@opencompany/analytics/product/client";
import type { ProductOnboardingStep } from "@opencompany/analytics/product/events";
import { Button } from "@opencompany/ui/components/button";
import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Code2,
  GitPullRequest,
  Hammer,
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
import { useEffect, useRef, useState, useTransition } from "react";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { OnboardingCodeStep } from "@/components/onboarding/OnboardingCodeStep";
import { OnboardingPluginsStep } from "@/components/onboarding/OnboardingPluginsStep";
import { OnboardingSubscriptionsStep } from "@/components/onboarding/OnboardingSubscriptionsStep";
import {
  connectsAfterOnboarding,
  type PluginConnections,
  usePluginConnections,
} from "@/components/onboarding/plugin-connections";
import { OFFICIAL_MCP_PLUGINS, type OfficialMcpPluginConfig } from "@/lib/official-plugin-catalog";
import {
  finishOnboardingAction,
  saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction,
  scanOnboardingRepositoryAction,
} from "@/lib/onboarding-actions";
import {
  isOnboardingRole,
  normalizeOnboardingCompanyUrl,
  ONBOARDING_COMPANY_URL_MAX_LENGTH,
  type OnboardingRole,
} from "@/lib/onboarding-profile";
import { createStarterWorkflows, STARTER_WORKFLOWS } from "@/lib/starter-workflows";

type OnboardingUser = {
  workosUserId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
};

type StepKey = ProductOnboardingStep;

// Owners shape the workspace, then set up the two things that make it useful on
// day one: the subscription that powers their coding sandboxes, and the plugins
// their agent can reach. Both are skippable — neither blocks entering the app.
const OWNER_STEPS: StepKey[] = ["profile", "workspace", "subscriptions", "plugins", "finish"];

// Invited members join a workspace an admin already shaped, so they only need a
// welcome and their own subscription. Plugins are workspace-level and stay with
// the admin.
const MEMBER_STEPS: StepKey[] = ["welcome", "subscriptions", "finish"];

// Technical founders get a code-first plugins step (connect GitHub, read the repo, suggest the
// plugins it uses) and start with #build and #review-pr. Every other role keeps the catalog step.
const TECHNICAL_ROLES = new Set<OnboardingRole>(["founder", "product"]);

// Steps that are complete by definition: the user may continue without doing
// anything, and the primary button says so.
const OPTIONAL_STEPS = new Set<StepKey>(["subscriptions", "plugins"]);

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

type CompanyUrlStatus = "idle" | "valid" | "invalid";

export function OnboardingWizard({
  user,
  currentWorkspaceName,
  variant,
  initialStep,
  initialWorkspaceId,
  initialWorkspaceName,
  initialRole,
  initialCompanyUrl,
  initialReferral,
  starterSetup = false,
}: {
  user: OnboardingUser;
  currentWorkspaceName: string;
  variant: "owner" | "member";
  initialStep: number;
  initialWorkspaceId: string | null;
  initialWorkspaceName: string;
  initialRole: string | null;
  initialCompanyUrl: string;
  initialReferral: string | null;
  // Opt-in (?version=2) technical founder setup; everyone else keeps the catalog step.
  starterSetup?: boolean;
}) {
  const router = useRouter();
  const steps = variant === "member" ? MEMBER_STEPS : OWNER_STEPS;
  const normalizedInitialRole = isOnboardingRole(initialRole) ? initialRole : null;
  const [stepIndex, setStepIndex] = useState(() =>
    Math.min(Math.max(initialStep, 0), steps.length - 1),
  );

  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [referral, setReferral] = useState<string | null>(initialReferral);
  const [role, setRole] = useState<OnboardingRole | null>(normalizedInitialRole);
  const [companyUrl, setCompanyUrl] = useState(initialCompanyUrl);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId);
  // Drives the optional steps' primary button: "Skip for now" until something is
  // actually set up, "Continue" once it is.
  const [connectedSubscriptions, setConnectedSubscriptions] = useState(0);
  // The repository the code step read; the starter workflows are written for it.
  const [repository, setRepository] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const analyticsStartedRef = useRef(false);
  const analyticsStepsViewedRef = useRef(new Set<StepKey>());

  const step = steps[stepIndex] ?? steps[0]!;
  const isLast = stepIndex === steps.length - 1;
  const technical =
    starterSetup && variant === "owner" && role !== null && TECHNICAL_ROLES.has(role);
  const plugins = usePluginConnections({
    loadInstalled: activeWorkspaceId !== null && (step === "plugins" || step === "finish"),
  });
  // A refresh on the finish step loses the repository the code step read; read it again so the
  // starter workflows are still created for it.
  useEffect(() => {
    if (step !== "finish" || !technical || repository) return;
    let active = true;
    void scanOnboardingRepositoryAction({}).then((result) => {
      if (active && result.ok && result.scan.status === "scanned") {
        setRepository(result.scan.repository.fullName);
      }
    });
    return () => {
      active = false;
    };
  }, [repository, step, technical]);
  const normalizedCompanyUrl = normalizeOnboardingCompanyUrl(companyUrl);
  const companyUrlStatus: CompanyUrlStatus = !companyUrl.trim()
    ? "idle"
    : normalizedCompanyUrl
      ? "valid"
      : "invalid";

  useEffect(() => {
    identifyProductUser({ userId: user.workosUserId, email: user.email });
    if (analyticsStartedRef.current) return;
    analyticsStartedRef.current = true;
    captureProductEvent("onboarding_started", {
      flow: variant,
      initial_step: step,
      initial_step_index: stepIndex,
      total_steps: steps.length,
      is_resume: stepIndex > 0,
      ...(activeWorkspaceId ? { workspace_id: activeWorkspaceId } : {}),
    });
  }, [activeWorkspaceId, step, stepIndex, steps.length, user.email, user.workosUserId, variant]);

  useEffect(() => {
    if (analyticsStepsViewedRef.current.has(step)) return;
    analyticsStepsViewedRef.current.add(step);
    captureProductEvent("onboarding_step_viewed", {
      flow: variant,
      step,
      step_index: stepIndex,
      total_steps: steps.length,
      ...(activeWorkspaceId ? { workspace_id: activeWorkspaceId } : {}),
    });
  }, [activeWorkspaceId, step, stepIndex, steps.length, variant]);

  // Persist the active step so a refresh resumes exactly where the user left off.
  useEffect(() => {
    document.cookie = `${ONBOARDING_STEP_COOKIE}=${stepIndex}; path=/; max-age=86400; samesite=lax`;
  }, [stepIndex]);

  // Saves the current step server-side; returns false (and toasts) on rejection.
  const persistCurrentStep = async (): Promise<boolean> => {
    if (step === "profile") {
      const r = await saveOnboardingProfileAction({ role, companyUrl });
      return r.ok || toastFail(r.error);
    }
    if (step === "workspace") {
      const r = await saveOnboardingWorkspaceAction({ name: workspaceName });
      if (!r.ok) return toastFail(r.error);
      setActiveWorkspaceId(r.workspaceId);
      return true;
    }
    if (step === "finish") {
      const r = await finishOnboardingAction({ referralSource: referral });
      if (!r.ok) return toastFail(r.error);
      if (technical && repository) {
        // Onboarding is already complete here, so a failure must not keep the founder out of
        // their workspace; say what is missing instead.
        await createStarterWorkflows(repository).catch((cause: unknown) => {
          toast.error(
            `Couldn't add #build and #review-pr. ${cause instanceof Error ? cause.message : "Please try again from Workflows."}`,
          );
        });
      }
      return true;
    }
    return true;
  };

  const advance = () => {
    startTransition(async () => {
      if (!(await persistCurrentStep())) return;
      if (isLast) {
        if (activeWorkspaceId) {
          captureProductEvent("onboarding_completed", {
            flow: variant,
            total_steps: steps.length,
            workspace_id: activeWorkspaceId,
          });
        }
        router.push("/");
        return;
      }
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    });
  };

  const goNext = () => advance();
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  const canContinue =
    step === "profile"
      ? role !== null && companyUrlStatus === "valid"
      : step === "workspace"
        ? workspaceName.trim().length > 0
        : true;

  const optionalStepIsEmpty =
    (step === "subscriptions" && connectedSubscriptions === 0) ||
    (step === "plugins" && plugins.installed.size === 0 && plugins.connected.size === 0);
  const primaryLabel = isPending
    ? "Saving…"
    : isLast
      ? "Finish onboarding"
      : OPTIONAL_STEPS.has(step) && optionalStepIsEmpty
        ? "Skip for now"
        : "Continue";

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
          <p className="mb-5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Step {stepIndex + 1} of {steps.length}
          </p>

          {step === "profile" && (
            <ProfileStep
              user={user}
              role={role}
              onRole={setRole}
              companyUrl={companyUrl}
              onCompanyUrl={setCompanyUrl}
              companyUrlStatus={companyUrlStatus}
            />
          )}
          {step === "workspace" && (
            <WorkspaceStep user={user} name={workspaceName} onName={setWorkspaceName} />
          )}
          {step === "welcome" && <WelcomeStep user={user} workspaceName={currentWorkspaceName} />}
          {step === "subscriptions" && (
            <OnboardingSubscriptionsStep onConnectedCountChange={setConnectedSubscriptions} />
          )}
          {step === "plugins" &&
            (technical ? (
              <OnboardingCodeStep
                workspaceName={workspaceName}
                plugins={plugins}
                onRepositoryChange={setRepository}
              />
            ) : (
              <OnboardingPluginsStep plugins={plugins} />
            ))}
          {step === "finish" && (
            <FinishStep
              workspaceName={variant === "member" ? currentWorkspaceName : workspaceName}
              referral={referral}
              onSelect={setReferral}
              showReferral={variant === "owner"}
              setup={technical ? { repository, plugins } : null}
            />
          )}

          {plugins.dialog}

          {/* Nav — sits right under the content */}
          <div className="mt-9 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={stepIndex === 0 || isPending}
              className="gap-1.5 rounded-full px-3 text-[13px] text-ink-muted hover:text-ink disabled:invisible"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Back
            </Button>
            <Button
              onClick={goNext}
              disabled={!canContinue || isPending}
              aria-busy={isPending}
              className="gap-1.5 rounded-full px-5 text-[13px] font-semibold"
            >
              {primaryLabel}
              {!isLast && !isPending && <ArrowRight size={15} strokeWidth={2} />}
            </Button>
          </div>
        </div>
      </main>
    </div>
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
    companyUrlStatus === "invalid"
      ? "Enter a valid company URL."
      : "This helps identify the company behind your workspace.";

  return (
    <div>
      <StepHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        subtitle="Tell us a little about your role and company before we set up your workspace."
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
}: {
  user: OnboardingUser;
  name: string;
  onName: (v: string) => void;
}) {
  return (
    <div>
      <StepHeader
        title="Create your workspace"
        subtitle="This is the home for your company's Wiki. Hobby includes one member; upgrade to Pro to invite teammates."
      />

      <IdentityRow user={user} />

      <div className="mt-6">
        <Field label="Company name" hint="You can change this later in workspace settings.">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Acme Inc."
            autoFocus
          />
        </Field>
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
        subtitle="You've joined this company's workspace. Its Wiki brings shared context together — here's how to start using it."
      />

      <IdentityRow user={user} />

      <div className="mt-6 flex flex-col gap-2.5">
        <HighlightRow
          icon={MessagesSquare}
          title="Ask it anything"
          text="Chat with opencompany to get up to speed on people, projects, and decisions from the company Wiki."
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
  setup,
}: {
  workspaceName: string;
  referral: string | null;
  onSelect: (v: string) => void;
  showReferral: boolean;
  // A technical founder's starter setup: the workflows for the repository they connected and the
  // plugins they added along the way.
  setup: { repository: string | null; plugins: PluginConnections } | null;
}) {
  const added = setup
    ? Object.values(OFFICIAL_MCP_PLUGINS as Record<string, OfficialMcpPluginConfig>).filter(
        (config) => setup.plugins.installed.has(config.name),
      )
    : [];
  const repository = setup?.repository ?? null;
  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-success/10 text-success">
          <Check size={22} strokeWidth={2.6} />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
            {repository ? `${workspaceName || "Your workspace"} is ready` : "You're all set"}
          </h1>
          <p className="text-[14px] leading-6 text-ink-muted">
            {repository ? (
              <>
                Two workflows for <span className="font-mono text-ink">{repository}</span>. Type{" "}
                <span className="font-mono">#</span> in any chat to run one.
              </>
            ) : (
              <>
                {workspaceName ? `${workspaceName} is ready.` : "Your Wiki is ready."}{" "}
                {showReferral
                  ? "You can connect more plugins or import company context anytime from Settings."
                  : "You can start exploring the company Wiki now."}
              </>
            )}
          </p>
        </div>
      </div>

      {repository ? (
        <div className="mt-7 flex flex-col gap-2.5">
          <span className="text-[12px] font-medium text-ink">Workflows</span>
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            {STARTER_WORKFLOWS.map((workflow) => {
              const Icon = workflow.handle === "build" ? Hammer : GitPullRequest;
              return (
                <div
                  key={workflow.handle}
                  className="flex items-center gap-3 px-3.5 py-3 [&+&]:border-t [&+&]:border-border"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
                    <Icon size={17} strokeWidth={1.9} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] font-semibold text-ink">
                      #{workflow.handle}
                    </div>
                    <div className="text-[12px] leading-5 text-ink-subtle">
                      {workflow.description}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {added.length > 0 ? (
        <div className="mt-6 flex flex-col gap-2.5">
          <span className="text-[12px] font-medium text-ink">Plugins</span>
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            {added.map((config) => {
              const connected = setup?.plugins.connected.has(config.connectionProvider) ?? false;
              return (
                <div
                  key={config.name}
                  className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:border-t [&+&]:border-border"
                >
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 ${config.iconClassName}`}
                  >
                    <config.Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                    {config.label}
                  </span>
                  <span
                    className={`shrink-0 text-[12px] ${connected ? "font-medium text-success" : "text-ink-subtle"}`}
                  >
                    {connected
                      ? "Connected"
                      : connectsAfterOnboarding(config)
                        ? "Add the key in Plugins"
                        : "Finish connecting in Plugins"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

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
