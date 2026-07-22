"use client";

import {
  ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
  HARD_DEFAULT_GOAT_BRAIN_FOLDERS,
  normalizeGoatBrainFolder,
} from "@opencompany/goat-brain/schema";
import { toast } from "@opencompany/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  Briefcase,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  Code2,
  FlaskConical,
  Folder,
  GripVertical,
  History,
  Inbox,
  Lightbulb,
  LineChart,
  Lock,
  Megaphone,
  MessagesSquare,
  Microscope,
  Plus,
  Rocket,
  Settings2,
  ShieldCheck,
  Target,
  Users,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ONBOARDING_STEP_COOKIE } from "@/app/onboarding/step-cookie";
import { GoatBrainImport } from "@/components/GoatBrainImport";
import { resolveGoatBrainSourceState, SourceProviderCard } from "@/components/GoatBrainSourceCards";
import { McpSetupGuide } from "@/components/McpSetupGuide";
import { ConnectIntegrationModal } from "@/components/onboarding/ConnectIntegrationModal";
import {
  type GoatBrainSourcesDetails,
  getGoatBrainSourcesAction,
} from "@/lib/brain-source-actions";
import {
  GOAT_BRAIN_SOURCE_PROVIDERS,
  type GoatBrainSourceProviderDef,
} from "@/lib/brain-sources/registry";
import {
  checkGoatWorkspaceSlugAction,
  finishGoatOnboardingAction,
  saveGoatOnboardingBrainFoldersAction,
  saveGoatOnboardingProfileAction,
  saveGoatOnboardingWorkspaceAction,
} from "@/lib/onboarding-actions";
import {
  GOAT_ONBOARDING_CONNECTION_MESSAGE,
  GOAT_ONBOARDING_CONNECTION_STORAGE_KEY,
  type GoatOnboardingConnectionMessage,
  type GoatOnboardingConnectionResult,
  goatOnboardingConnectHref,
  goatOnboardingConnectionError,
} from "@/lib/onboarding-integrations";
import {
  GOAT_ONBOARDING_BUILDING_MAX_LENGTH,
  type GoatOnboardingRole,
  goatOnboardingFoldersForRole,
  isGoatOnboardingRole,
} from "@/lib/onboarding-profile";

type OnboardingUser = {
  name: string;
  email: string;
  avatarUrl: string | null;
};

type StepKey =
  | "profile"
  | "workspace"
  | "brain"
  | "sources"
  | "context"
  | "connect"
  | "finish"
  | "welcome";

type StepDef = { key: StepKey; label: string };

// Activation-optimized order: know them → name it → shape it (pre-tailored from
// their role) → feed it (peak) → teach it → use it → done. Referral is folded
// into the finish so it never interrupts a value step.
const OWNER_STEPS: StepDef[] = [
  { key: "profile", label: "About you" },
  { key: "workspace", label: "Create workspace" },
  { key: "brain", label: "Set up your brain" },
  { key: "sources", label: "Connect sources" },
  { key: "context", label: "Import context" },
  { key: "connect", label: "Connect over MCP" },
  { key: "finish", label: "You're all set" },
];

// Invited members join a workspace an admin already shaped, so we skip creation,
// folders, sources, and context — and get them straight to what's theirs: their
// own client connection.
const MEMBER_STEPS: StepDef[] = [
  { key: "welcome", label: "Welcome" },
  { key: "connect", label: "Connect over MCP" },
  { key: "finish", label: "You're all set" },
];

// Nudge toward a strong starting set of connected sources; purely a UI goal,
// connecting sources no longer changes the ingestion allowance.
const SOURCE_GOAL = 4;

// Role presets — the first onboarding step. Picking one seeds the adjustable
// brain folders with a set that matches how that person actually works (the
// hard defaults inbox/people/companies/evidence are always added on top). Every
// folder here must satisfy GOAT_BRAIN_FOLDER_PATTERN (lowercase, single word).
type RoleProfile = {
  id: GoatOnboardingRole;
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

// Folders to seed the brain step with for a given role — falls back to the
// generic adjustable defaults when no role is chosen or recognized.
function foldersForRole(role: GoatOnboardingRole | null): string[] {
  return goatOnboardingFoldersForRole(role);
}

// ---------------------------------------------------------------------------

type SlugStatus = "idle" | "checking" | "available" | "taken";

export function OnboardingWizard({
  user,
  currentWorkspaceName,
  brainRef,
  variant,
  initialStep,
  initialWorkspaceName,
  initialSlug,
  initialRole,
  initialBuilding,
  initialReferral,
  initialSourceDetails,
  initialConnectionResult,
  initialMcpClient,
  initialMcpCompletedAt,
}: {
  user: OnboardingUser;
  currentWorkspaceName: string;
  brainRef: string | null;
  variant: "owner" | "member";
  initialStep: number;
  initialWorkspaceName: string;
  initialSlug: string;
  initialRole: string | null;
  initialBuilding: string;
  initialReferral: string | null;
  initialSourceDetails: GoatBrainSourcesDetails | null;
  initialConnectionResult: GoatOnboardingConnectionResult | null;
  initialMcpClient: "claude" | "chatgpt" | "cursor" | null;
  initialMcpCompletedAt: string | null;
}) {
  const router = useRouter();
  const STEPS = variant === "member" ? MEMBER_STEPS : OWNER_STEPS;
  const normalizedInitialRole = isGoatOnboardingRole(initialRole) ? initialRole : null;
  const [stepIndex, setStepIndex] = useState(() =>
    Math.min(Math.max(initialStep, 0), STEPS.length - 1),
  );

  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [slugTouched, setSlugTouched] = useState(Boolean(initialSlug));
  const [slug, setSlug] = useState(initialSlug);
  const [referral, setReferral] = useState<string | null>(initialReferral);
  const [role, setRole] = useState<GoatOnboardingRole | null>(normalizedInitialRole);
  const [building, setBuilding] = useState(initialBuilding);
  const [workingFolders, setWorkingFolders] = useState<string[]>(() =>
    foldersForRole(normalizedInitialRole),
  );
  const [isPending, startTransition] = useTransition();
  const [slugCheck, setSlugCheck] = useState<{
    slug: string;
    available: boolean;
  } | null>(null);

  const step = STEPS[stepIndex] ?? STEPS[0]!;
  const isLast = stepIndex === STEPS.length - 1;
  const effectiveSlug = slugTouched ? slug : slugify(workspaceName);
  const shouldCheckSlug = step.key === "workspace" && effectiveSlug.length > 0;
  const slugStatus: SlugStatus = !shouldCheckSlug
    ? "idle"
    : slugCheck?.slug === effectiveSlug
      ? slugCheck.available
        ? "available"
        : "taken"
      : "checking";

  // Persist the active step to a cookie so an OAuth round-trip (connecting a
  // source) resumes exactly here.
  useEffect(() => {
    document.cookie = `${ONBOARDING_STEP_COOKIE}=${stepIndex}; path=/; max-age=86400; samesite=lax`;
  }, [stepIndex]);

  // Live workspace-URL availability check (debounced).
  useEffect(() => {
    if (!shouldCheckSlug) return;
    const timer = window.setTimeout(() => {
      void checkGoatWorkspaceSlugAction(effectiveSlug).then((result) => {
        setSlugCheck({ slug: effectiveSlug, available: result.available });
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [effectiveSlug, shouldCheckSlug]);

  // Saves the current step server-side; returns false (and toasts) on rejection.
  const persistCurrentStep = async (): Promise<boolean> => {
    if (step.key === "profile") {
      const r = await saveGoatOnboardingProfileAction({ role, building });
      return r.ok || toastFail(r.error);
    }
    if (step.key === "workspace") {
      const r = await saveGoatOnboardingWorkspaceAction({
        name: workspaceName,
        slug: effectiveSlug,
      });
      return r.ok || toastFail(r.error);
    }
    if (step.key === "brain") {
      const r = await saveGoatOnboardingBrainFoldersAction({
        folders: workingFolders,
      });
      return r.ok || toastFail(r.error);
    }
    if (step.key === "finish") {
      const r = await finishGoatOnboardingAction({ referralSource: referral });
      return r.ok || toastFail(r.error);
    }
    return true;
  };

  const goNext = () => {
    startTransition(async () => {
      if (!(await persistCurrentStep())) return;
      if (isLast) {
        router.push("/");
        return;
      }
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
    });
  };
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  // Picking a role re-seeds the brain folders with that role's preset. We only
  // reseed on an actual change so a user who tweaked folders and stepped back
  // doesn't lose their edits by re-clicking the role they already had.
  const selectRole = (next: GoatOnboardingRole) => {
    if (next === role) return;
    setRole(next);
    setWorkingFolders(foldersForRole(next));
  };

  const canContinue =
    step.key === "profile"
      ? role !== null
      : step.key === "workspace"
        ? workspaceName.trim().length > 0 && effectiveSlug.length > 0 && slugStatus !== "taken"
        : true;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-canvas text-ink">
      {/* Progress bar — fills per step */}
      <div className="h-[3px] w-full shrink-0 bg-surface-subtle">
        <div
          className="h-full bg-ink transition-all duration-300"
          style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      {/* Vertically centered content column with nav attached directly below */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center px-6 py-12">
          {step.key === "profile" && (
            <ProfileStep
              user={user}
              role={role}
              onRole={selectRole}
              building={building}
              onBuilding={setBuilding}
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
          {step.key === "brain" && (
            <BrainStep workingFolders={workingFolders} onChange={setWorkingFolders} />
          )}
          {step.key === "sources" && (
            <SourcesStep
              brainRef={brainRef}
              initialDetails={initialSourceDetails}
              initialConnectionResult={initialConnectionResult}
            />
          )}
          {step.key === "context" && <ImportStep brainRef={brainRef} />}
          {step.key === "connect" && (
            <McpSetupGuide
              displayName={user.name}
              workspaceName={
                variant === "member"
                  ? currentWorkspaceName
                  : workspaceName.trim() || currentWorkspaceName
              }
              initialClient={initialMcpClient}
              initialCompletedAt={initialMcpCompletedAt}
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
                {isPending ? "Saving…" : isLast ? "Enter OpenCompany" : "Continue"}
                {!isLast && !isPending && <ArrowRight size={15} strokeWidth={2} />}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function isSkippable(key: StepKey) {
  return key === "sources" || key === "context" || key === "connect";
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
// Step — Profile (role + what they're building)
// ---------------------------------------------------------------------------

function ProfileStep({
  user,
  role,
  onRole,
  building,
  onBuilding,
}: {
  user: OnboardingUser;
  role: GoatOnboardingRole | null;
  onRole: (id: GoatOnboardingRole) => void;
  building: string;
  onBuilding: (v: string) => void;
}) {
  return (
    <div>
      <StepHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        subtitle="Two quick questions so we can shape your brain around how you actually work."
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

        <Field label="What are you building?" hint="Optional — one line is plenty.">
          <input
            className={inputClass}
            value={building}
            onChange={(e) => onBuilding(e.target.value)}
            maxLength={GOAT_ONBOARDING_BUILDING_MAX_LENGTH}
            placeholder="A B2B analytics platform for logistics teams"
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
// Step — Brain folders (mini file tree)
// ---------------------------------------------------------------------------

// Icon mapping mirrors the real brain tree in GoatBrainView so the step feels
// like the app's own file tree.
function FolderIcon({ path }: { path: string }) {
  const [root] = path.split("/");
  const cn = "shrink-0 text-ink-muted";
  switch (root) {
    case "inbox":
      return <Inbox size={14} strokeWidth={1.8} className={cn} />;
    case "thoughts":
      return <Brain size={14} strokeWidth={1.8} className={cn} />;
    case "projects":
      return <BriefcaseBusiness size={14} strokeWidth={1.8} className={cn} />;
    case "meetings":
      return <CalendarDays size={14} strokeWidth={1.8} className={cn} />;
    case "research":
      return <FlaskConical size={14} strokeWidth={1.8} className={cn} />;
    case "decisions":
      return <BookOpen size={14} strokeWidth={1.8} className={cn} />;
    case "concepts":
      return <Lightbulb size={14} strokeWidth={1.8} className={cn} />;
    case "people":
      return <Users size={14} strokeWidth={1.8} className={cn} />;
    case "companies":
      return <Building2 size={14} strokeWidth={1.8} className={cn} />;
    case "evidence":
      return <History size={14} strokeWidth={1.8} className={cn} />;
    default:
      return <Folder size={14} strokeWidth={1.8} className={cn} />;
  }
}

// Folders we ship as defaults — kept ones render grayed to set them apart from
// folders the user adds themselves.
const ADJUSTABLE_DEFAULT_SET = new Set<string>(ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS);

function BrainStep({
  workingFolders,
  onChange,
}: {
  workingFolders: string[];
  onChange: (next: string[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const tryAdd = (value: string) => {
    const normalized = normalizeGoatBrainFolder(value);
    const reserved = new Set<string>([...HARD_DEFAULT_GOAT_BRAIN_FOLDERS, ...workingFolders]);
    if (!normalized || reserved.has(normalized)) return false;
    onChange([...workingFolders, normalized]);
    return true;
  };

  const remove = (folder: string) => onChange(workingFolders.filter((f) => f !== folder));

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= workingFolders.length) return;
    const next = [...workingFolders];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next);
  };

  const resetDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div>
      <StepHeader
        title="Set up your brain"
        subtitle="Everything your brain learns gets filed into folders. A few are always here — add, remove, or reorder the rest to fit how you work."
      />

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex h-9 items-center gap-1.5 border-b border-border-subtle px-3">
          <Brain size={13} strokeWidth={2} className="text-ink-subtle" />
          <span className="text-[12px] font-medium text-ink-subtle">Brain folders</span>
        </div>

        <div className="flex flex-col py-1.5">
          <LockedTreeRow path="inbox" />
          {workingFolders.map((folder, i) => (
            <WorkingFolderRow
              key={folder}
              path={folder}
              isDefault={ADJUSTABLE_DEFAULT_SET.has(folder)}
              dragging={dragIndex === i}
              dragOver={overIndex === i && dragIndex !== null && dragIndex !== i}
              onRemove={() => remove(folder)}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) reorder(dragIndex, i);
                resetDrag();
              }}
              onDragEnd={resetDrag}
            />
          ))}
          {/* Add sits directly below the folders you can drag & drop */}
          <NewFolderControl onAdd={tryAdd} />
          <LockedTreeRow path="people" />
          <LockedTreeRow path="companies" />
          <LockedTreeRow path="evidence" />
        </div>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
        <Lock size={11} strokeWidth={2} />
        Drag to reorder. Grayed folders are our defaults; locked ones can&apos;t be removed.
      </p>
    </div>
  );
}

function WorkingFolderRow({
  path,
  isDefault,
  dragging,
  dragOver,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  path: string;
  isDefault: boolean;
  dragging: boolean;
  dragOver: boolean;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group relative mx-1.5 flex h-8 items-center gap-1.5 rounded-[6px] px-1.5 transition-colors hover:bg-surface-hover ${
        dragging ? "opacity-40" : ""
      } ${
        dragOver
          ? "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-ink"
          : ""
      }`}
    >
      <GripVertical
        size={13}
        strokeWidth={2}
        className="shrink-0 cursor-grab text-ink-subtle opacity-0 transition-opacity group-hover:opacity-50"
      />
      <FolderIcon path={path} />
      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${isDefault ? "text-ink-muted" : "text-ink"}`}
      >
        {path}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${path}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function LockedTreeRow({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="group mx-1.5 flex h-8 items-center gap-1.5 rounded-[6px] px-1.5 text-left transition-colors hover:bg-surface-hover">
        <FolderIcon path={path} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{path}</span>
        <Lock
          size={12}
          strokeWidth={2}
          className="shrink-0 text-ink-subtle opacity-0 transition-opacity group-hover:opacity-60"
        />
      </TooltipTrigger>
      <TooltipContent>
        Default folder — part of every brain and can&apos;t be removed.
      </TooltipContent>
    </Tooltip>
  );
}

function NewFolderControl({ onAdd }: { onAdd: (value: string) => boolean }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="group mx-1.5 flex h-8 items-center gap-1.5 rounded-[6px] px-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <Plus size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
        <span className="text-[13px] text-ink-muted transition-colors group-hover:text-ink">
          New folder
        </span>
      </button>
    );
  }

  const commit = () => {
    if (draft.trim() && onAdd(draft)) {
      setDraft(""); // keep open for rapid entry
      return;
    }
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="mx-1.5 flex h-8 items-center gap-1.5 rounded-[6px] px-1.5">
      <Plus size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
      {/* biome-ignore lint/a11y/noAutofocus: expected when the add row is opened */}
      <input
        autoFocus
        className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft("");
            setAdding(false);
          }
        }}
        onBlur={commit}
        placeholder="Folder name…"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Sources
// ---------------------------------------------------------------------------

const POPUP_WIDTH = 560;
const POPUP_HEIGHT = 760;

function SourcesStep({
  brainRef,
  initialDetails,
  initialConnectionResult,
}: {
  brainRef: string | null;
  initialDetails: GoatBrainSourcesDetails | null;
  initialConnectionResult: GoatOnboardingConnectionResult | null;
}) {
  const [details, setDetails] = useState(initialDetails);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // The api_key/webhook providers connect inside a modal rather than navigating
  // out of the wizard.
  const [modalProvider, setModalProvider] = useState<GoatBrainSourceProviderDef | null>(null);
  // When the OAuth popup is blocked we surface an in-wizard notice with a plain
  // anchor instead of a same-tab redirect that would drop wizard state.
  const [popupBlocked, setPopupBlocked] = useState<{ name: string; href: string } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(() =>
    initialConnectionResult?.status === "error"
      ? goatOnboardingConnectionError(
          initialConnectionResult.provider,
          initialConnectionResult.reason,
        )
      : null,
  );
  const [connectionNotice, setConnectionNotice] = useState<string | null>(() =>
    initialConnectionResult?.status === "connected"
      ? "Account authorized. Now choose what should feed this Brain."
      : null,
  );
  const connectingRef = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!brainRef) return null;
    const next = await getGoatBrainSourcesAction(brainRef);
    setDetails(next);
    return next;
  }, [brainRef]);

  useEffect(() => {
    function handleConnection(message: GoatOnboardingConnectionMessage | undefined) {
      if (!message || message.type !== GOAT_ONBOARDING_CONNECTION_MESSAGE) return;
      if (connectingRef.current && message.provider !== connectingRef.current) return;

      popupRef.current?.close();
      popupRef.current = null;
      connectingRef.current = null;
      setConnectingId(null);
      setPopupBlocked(null);
      if (message.status === "connected") {
        setConnectionError(null);
        setConnectionNotice("Account authorized. Now choose what should feed this Brain.");
        void reload();
      } else {
        setConnectionNotice(null);
        setConnectionError(goatOnboardingConnectionError(message.provider, message.reason));
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      handleConnection(event.data as GoatOnboardingConnectionMessage | undefined);
    }

    function onStorage(event: StorageEvent) {
      if (event.key !== GOAT_ONBOARDING_CONNECTION_STORAGE_KEY || !event.newValue) return;
      try {
        handleConnection(JSON.parse(event.newValue) as GoatOnboardingConnectionMessage);
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
  }, [reload]);

  useEffect(
    () => () => {
      if (popupPollRef.current !== null) window.clearInterval(popupPollRef.current);
    },
    [],
  );

  const openConnection = (provider: GoatBrainSourceProviderDef) => {
    setConnectionError(null);
    setConnectionNotice(null);
    setPopupBlocked(null);

    if (provider.connectionKind !== "oauth") {
      if (!details) void reload();
      setModalProvider(provider);
      return;
    }

    const connectHref = goatOnboardingConnectHref(provider.connectHref);
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
      void reload().then((next) => {
        const connected = resolveGoatBrainSourceState(provider.id, next).connected;
        if (!connected) {
          setConnectionError(`${provider.name} authorization was not completed.`);
        }
      });
    }, 500);
  };

  const count = GOAT_BRAIN_SOURCE_PROVIDERS.filter(
    (provider) => resolveGoatBrainSourceState(provider.id, details).enabled,
  ).length;
  const authorizedCount = GOAT_BRAIN_SOURCE_PROVIDERS.filter(
    (provider) => resolveGoatBrainSourceState(provider.id, details).connected,
  ).length;
  const pct = Math.min(100, (count / SOURCE_GOAL) * 100);

  return (
    <div>
      <StepHeader
        title="Connect your sources"
        subtitle="Authorize an account, then choose exactly what should flow into this Brain."
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
            {count >= SOURCE_GOAL
              ? "Your Brain has a strong starting set of sources."
              : `Configure ${SOURCE_GOAL - count} more to get the most out of your Brain`}
          </span>
          <span className="font-medium text-success">
            {count} source{count === 1 ? "" : "s"} connected
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-subtle">
          <div
            className="h-full rounded-full bg-success transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[11.5px] leading-4 text-ink-subtle">
          {authorizedCount} authorized · {count} feeding this Brain
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {GOAT_BRAIN_SOURCE_PROVIDERS.map((provider) => (
          <SourceProviderCard
            key={provider.id}
            brainRef={brainRef ?? ""}
            provider={provider}
            details={details}
            onChanged={async () => {
              await reload();
            }}
            onConnect={() => openConnection(provider)}
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
            setModalProvider(null);
            setConnectionError(null);
            setConnectionNotice("Account authorized. Now choose what should feed this Brain.");
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — Import context (real company-context import)
// ---------------------------------------------------------------------------

// Wraps the shared GoatBrainImport flow (scan → review workload → build) in the
// onboarding chrome. The import runs on background workers, so the user can kick
// it off and keep moving — or Skip and run it later from Brain settings.
function ImportStep({ brainRef }: { brainRef: string | null }) {
  return (
    <div>
      <StepHeader
        title="Help us set up your brain"
        subtitle="Point Goat at your company website and pick what to pull in. It scans first and shows you the exact workload before any ingestion runs — so nothing happens you didn't ask for."
      />

      {brainRef ? (
        <GoatBrainImport brainRef={brainRef} compact />
      ) : (
        <p className="text-[12px] leading-4 text-danger">
          A Brain is required before context can be imported.
        </p>
      )}
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
            One last thing — how did you hear about OpenCompany?
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
