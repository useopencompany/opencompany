"use client";

import { captureEvent } from "@opencompany/analytics/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Brain,
  Check,
  Cpu,
  Database,
  LoaderCircle,
  MessageCircle,
  Plug,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { LeoMark } from "@/components/leo/LeoMark";
import { ToolPolicyEditor } from "@/components/ToolPolicyEditor";
import { Toggle } from "@/components/ui/toggle";
import { INTRO_CALL_CAL_LINK, INTRO_CALL_URL } from "@/lib/booking";
import { completeOnboarding, type OnboardingActionState } from "@/lib/onboarding/actions";
import { ONBOARDING_FIRST_SESSION_PROMPT } from "@/lib/onboarding/first-session";
import {
  agentExperienceOptions,
  heardFromOptions,
  teamSizeOptions,
} from "@/lib/onboarding/options";
import {
  ONBOARDING_CONNECTED_MESSAGE,
  type OnboardingConnectedMessage,
} from "@/lib/onboarding/setups";
import { GOAL_MAX_LENGTH } from "@/lib/onboarding/validation";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import {
  personalBrainFolderOptions,
  personalBrainFolderValues,
} from "@/lib/personal/brain-folders";
import type { PersonalIntegrationDetails } from "@/lib/personal/integration-details";
import {
  PERSONAL_INTEGRATIONS_CATALOG,
  type PersonalIntegrationConnections,
  personalIntegrationConnectUrl,
} from "@/lib/personal/integrations-catalog";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

const initialState: OnboardingActionState = {
  errors: {},
  values: {
    heardFrom: "",
    heardFromDetail: "",
    role: "",
    teamSize: "",
    companyUrl: "",
    agentExperience: "",
    goal: "",
    personalBrainFolders: [...personalBrainFolderValues],
    // The agent's integrations are derived from what the user actually connects during onboarding
    // (see `connectedIntegrations`), not a default selection — so this stays empty.
    personalIntegrations: [],
  },
};

const onboardingCallCalLink = INTRO_CALL_CAL_LINK;
const onboardingCallUrl = INTRO_CALL_URL;
// embed.js is served from app.cal.com; the booking pages it frames live on cal.com.
const calEmbedOrigin = "https://cal.com";
const calEmbedScriptSrc = "https://app.cal.com/embed/embed.js";

// Guard so the booking embed is preloaded once per page load, even across
// React StrictMode double-effects or onboarding remounts.
let hasPreloadedCalEmbed = false;

type CalCommand = [string, ...unknown[]];
type CalApi = ((...args: CalCommand) => void) & {
  loaded?: boolean;
  ns?: Record<string, CalApi>;
  q?: CalCommand[];
};

declare global {
  interface Window {
    Cal?: CalApi;
  }
}

// The onboarding call is temporarily hidden. Flip back to `true` to restore the
// booking step — all of its cal.com wiring below is kept intact for that.
const SHOW_BOOKING_STEP = false;

type StepKey =
  | "heardFrom"
  | "team"
  | "agentExperience"
  | "goal"
  | "booking"
  | "meetLeo"
  | "personalBrain"
  | "memory"
  | "capabilities"
  | "firstSession";

type StepDefinition = { key: StepKey; title: string; subtitle: string };

const allSteps: StepDefinition[] = [
  {
    key: "heardFrom",
    title: "Where did you hear about opencompany?",
    subtitle: "This helps us understand where useful teams are finding us.",
  },
  {
    key: "agentExperience",
    title: "How familiar are you with agents?",
    subtitle: "Use the answer that sounds closest to you.",
  },
  {
    key: "team",
    title: "Tell us about your team",
    subtitle: "Just enough context to make the workspace feel right.",
  },
  {
    key: "goal",
    title: "What do you want to accomplish with opencompany?",
    subtitle: "Optional — share what success looks like, or leave it blank and skip ahead.",
  },
  {
    key: "booking",
    title: "Book your onboarding call",
    subtitle: "Pick a time with the opencompany team — or skip for now and keep going.",
  },
  {
    key: "meetLeo",
    title: "Meet Leo",
    subtitle: "Your co-founder, analyst, and operator — in one.",
  },
  {
    key: "personalBrain",
    title: "Personal Brain",
    subtitle: "This is where your work and your agents' work live.",
  },
  {
    key: "memory",
    title: "Memory",
    subtitle: "Leo remembers the details so you do not have to repeat yourself.",
  },
  {
    key: "capabilities",
    title: "Capabilities",
    subtitle: "Connect the tools where your work already lives.",
  },
  {
    key: "firstSession",
    title: "First session",
    subtitle: "Let's get your brain filled right now.",
  },
];

const steps = allSteps.filter((step) => SHOW_BOOKING_STEP || step.key !== "booking");

const educationKeys = new Set<StepKey>([
  "meetLeo",
  "personalBrain",
  "memory",
  "capabilities",
  "firstSession",
]);

const companyUrlContextHint =
  "Your website helps make opencompany better for your product and customers. We recommend adding it, but you can continue without it.";
const onboardingIntegrationOptions = PERSONAL_INTEGRATIONS_CATALOG.filter((entry) =>
  ["github", "gmail", "google_calendar", "linear", "slack"].includes(entry.id),
);

function firstErrorMessage(errors: OnboardingActionState["errors"]) {
  return (
    errors.heardFrom ??
    errors.heardFromDetail ??
    errors.role ??
    errors.teamSize ??
    errors.companyUrl ??
    errors.agentExperience ??
    errors.goal ??
    errors.personalBrainFolders ??
    errors.personalIntegrations
  );
}

function isValidCompanyUrl(value: string) {
  if (!value) return true;

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withProtocol);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// Faithful port of cal.com's official embed bootstrap (Cal → Embed → Inline
// snippet). The previous hand-rolled loader skipped `cal.ns` and set
// `cal.loaded` before embed.js had actually loaded, so cal.com's embed.js threw
// on load and never wired up the inline calendar — the booking widget rendered
// as an empty, stuck spinner. The stub queues commands in `cal.q` and injects
// embed.js on the first call; embed.js then drains the queue. Keep this aligned
// with cal.com's snippet rather than reinventing it.
function ensureCalApi(): CalApi {
  if (window.Cal) return window.Cal;

  const cal = ((...args: CalCommand) => {
    if (!cal.loaded) {
      cal.ns = {};
      cal.q = cal.q ?? [];
      const script = document.createElement("script");
      script.src = calEmbedScriptSrc;
      script.async = true;
      document.head.appendChild(script);
      cal.loaded = true;
    }
    cal.q?.push(args);
  }) as CalApi;

  window.Cal = cal;
  return cal;
}

// cal.com's `bookingSuccessful` event payload isn't strongly typed by the embed
// stub, so read the start time defensively and fall back to a label-less
// confirmation if the shape ever changes.
function readBookingLabel(event: unknown): string | null {
  const data = (event as { detail?: { data?: Record<string, unknown> } } | null)?.detail?.data;
  if (!data) return null;

  const booking = data.booking as { startTime?: unknown } | undefined;
  const rawStart =
    (typeof data.date === "string" && data.date) ||
    (typeof booking?.startTime === "string" && booking.startTime) ||
    null;
  if (!rawStart) return null;

  const parsed = new Date(rawStart);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function OnboardingCallEmbed({ onBooked }: { onBooked: (label: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasQueuedEmbedRef = useRef(false);
  const onBookedRef = useRef(onBooked);
  useEffect(() => {
    onBookedRef.current = onBooked;
  }, [onBooked]);

  useEffect(() => {
    if (hasQueuedEmbedRef.current || !containerRef.current) return;

    hasQueuedEmbedRef.current = true;

    const resolvedTheme =
      document.documentElement.dataset.resolvedTheme === "dark" ? "dark" : "light";

    const cal = ensureCalApi();
    cal("init", { origin: calEmbedOrigin });
    cal("inline", {
      elementOrSelector: containerRef.current,
      calLink: onboardingCallCalLink,
      config: {
        layout: "month_view",
        theme: resolvedTheme,
      },
    });
    cal("ui", {
      hideEventTypeDetails: false,
      theme: resolvedTheme,
      // Blend into the onboarding surface instead of a hard white panel that
      // clashes with the dark theme; cal's own theme handles its inner colors.
      styles: {
        body: {
          background: "transparent",
        },
      },
    });
    // Once the call is actually confirmed (slot picked + booking submitted),
    // there's no reason to keep offering "Skip" — collapse to a single Continue.
    cal("on", {
      action: "bookingSuccessful",
      callback: (event: unknown) => {
        onBookedRef.current(readBookingLabel(event));
      },
    });
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <a
          href={onboardingCallUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-ink-subtle transition-colors hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <span>Open scheduler in new tab</span>
          <ArrowUpRight size={11} strokeWidth={2} />
        </a>
      </div>
      <div
        ref={containerRef}
        aria-label="Book an onboarding call"
        className="max-h-[calc(100vh-345px)] overflow-auto rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(17,17,17,0.04)]"
      />
    </div>
  );
}

function OnboardingCallActions({
  booked,
  bookedLabel,
  onBack,
  onContinue,
  showBack,
}: {
  booked: boolean;
  bookedLabel: string | null;
  onBack: () => void;
  onContinue: () => void;
  showBack: boolean;
}) {
  const backButton = showBack ? (
    <button
      type="button"
      onClick={onBack}
      className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <ArrowLeft size={12} strokeWidth={2} />
      <span>Back</span>
    </button>
  ) : null;

  if (booked) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-md border border-pill-green-text/20 bg-pill-green px-3 py-2 text-[12px] font-medium text-pill-green-text">
          <Check size={14} strokeWidth={2.4} />
          <span>Onboarding call booked{bookedLabel ? ` — ${bookedLabel}` : ""}</span>
        </div>
        <button
          type="button"
          onClick={onContinue}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
        >
          <span>Continue</span>
          <ArrowRight size={12} strokeWidth={2} />
        </button>
        {backButton}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onContinue}
        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
      >
        <span>Continue</span>
        <ArrowRight size={12} strokeWidth={2} />
      </button>
      <div className="relative flex h-7 items-center justify-center">
        {backButton}
        <button
          type="button"
          onClick={onContinue}
          className="absolute right-0 flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function EducationPanel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 px-4 py-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
        <Icon size={17} strokeWidth={1.9} />
      </div>
      <div className="space-y-3 text-[13px] leading-5 text-ink-muted">{children}</div>
    </div>
  );
}

const leoCapabilities = [
  {
    icon: Sparkles,
    title: "Does the work",
    body: "Researches, drafts, and follows through on real tasks — not just chat.",
  },
  {
    icon: Brain,
    title: "Learns you over time",
    body: "Builds a memory of you and your company, getting sharper every day.",
  },
  {
    icon: Plug,
    title: "Any tool you use",
    body: "Bring in Slack, Gmail, Linear, GitHub — or any MCP integration.",
  },
  {
    icon: Cpu,
    title: "Any model",
    body: "Run Leo on whichever model fits the task. Your call.",
  },
] as const;

// "Meet Leo" hero: Leo's mark (capsule eyes, see components/leo/LeoMark.tsx)
// looking around over a soft violet glow, above the four things that make it
// more than a chatbot — it does the work, learns you and your company, plugs
// into any tool, and runs on any model.
function MeetLeoVisual() {
  return (
    <div className="space-y-3">
      <div className="relative flex flex-col items-center overflow-hidden rounded-lg border border-border bg-surface/60 px-4 py-9">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 60% at 50% 32%, rgba(124,92,240,0.12), transparent 70%)",
          }}
        />
        <LeoMark size={60} animated className="relative text-ink" />
        <p className="relative mt-4 text-[15px] font-semibold tracking-[-0.01em] text-ink">Leo</p>
        <p className="relative mt-1 text-[12px] text-ink-muted">
          Your always-on co-founder & operator
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {leoCapabilities.map((capability) => (
          <div
            key={capability.title}
            className="rounded-lg border border-border bg-surface/60 px-3 py-3"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
              <capability.icon size={15} strokeWidth={1.9} />
            </div>
            <p className="mt-2 text-[12.5px] font-medium tracking-[-0.005em] text-ink">
              {capability.title}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-4 text-ink-muted">{capability.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Personal Brain step: lead with what the Brain actually is (a private, persistent knowledge space
// Leo files work into), then make the folder choice explicit — each folder reads as a labeled,
// describable thing the user is opting into, not a bare grid of pills.
function PersonalBrainPanel({
  selectedFolders,
  onToggleFolder,
}: {
  selectedFolders: string[];
  onToggleFolder: (value: string, pressed: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface/60 px-4 py-4">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
          <Brain size={17} strokeWidth={1.9} />
        </div>
        <div className="space-y-2 text-[13px] leading-5 text-ink-muted">
          <p>
            Your Personal Brain is a private knowledge space that stays with you across every
            session. Save notes, research, and decisions here — and everything Leo produces for you
            is filed here too.
          </p>
          <p>
            Because it persists, Leo can build on your context instead of starting from scratch each
            time.
          </p>
        </div>
      </div>

      <div>
        <div className="mb-2 px-0.5">
          <p className="text-[12.5px] font-medium text-ink">Choose your starter folders</p>
          <p className="mt-0.5 text-[11.5px] leading-4 text-ink-muted">
            Leo organizes work into these. You can add, rename, or remove folders anytime.
          </p>
        </div>
        <div className="space-y-1.5">
          {personalBrainFolderOptions.map((folder) => {
            const selected = selectedFolders.includes(folder.value);
            return (
              <Toggle
                key={folder.value}
                type="button"
                aria-label={folder.label}
                pressed={selected}
                onPressedChange={(pressed) => onToggleFolder(folder.value, pressed)}
                className="h-auto w-full items-start justify-start gap-3 px-3 py-2.5 text-left data-[state=on]:border-border-strong data-[state=on]:bg-surface-active data-[state=on]:text-ink data-[state=on]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]"
              >
                <span
                  className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border ${
                    selected
                      ? "border-ink bg-ink text-canvas"
                      : "border-border-strong bg-surface text-transparent"
                  }`}
                >
                  <Check size={11} strokeWidth={2.6} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-ink">{folder.label}</span>
                  <span className="mt-0.5 block text-[11.5px] font-normal leading-4 text-ink-muted">
                    {folder.description}
                  </span>
                </span>
              </Toggle>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OnboardingCapabilitiesPanel({
  connections,
  details,
  toolPolicies,
}: {
  connections?: PersonalIntegrationConnections | undefined;
  details?: PersonalIntegrationDetails | undefined;
  toolPolicies?: WorkspaceToolPolicyOverrides | undefined;
}) {
  const router = useRouter();
  const [connectingId, setConnectingId] = useState<PersonalIntegrationId | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectingRef = useRef<PersonalIntegrationId | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as OnboardingConnectedMessage | undefined;
      if (!data || data.type !== ONBOARDING_CONNECTED_MESSAGE) return;
      setConnectingId(null);
      connectingRef.current = null;
      if (data.status === "connected") router.refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  function openConnectPopup(entry: (typeof onboardingIntegrationOptions)[number]) {
    const width = 520;
    const height = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      personalIntegrationConnectUrl(entry),
      "oc-onboarding-connect",
      `width=${width},height=${height},left=${left},top=${top}`,
    );
    setConnectError(null);
    if (!popup) {
      setConnectError(`Allow pop-ups for this site, then try connecting ${entry.label} again.`);
      return;
    }
    setConnectingId(entry.id);
    connectingRef.current = entry.id;
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        if (connectingRef.current === entry.id) {
          setConnectingId(null);
          connectingRef.current = null;
        }
      }
    }, 500);
  }

  return (
    <div className="space-y-2">
      {connectError ? (
        <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger">
          {connectError}
        </div>
      ) : null}
      {onboardingIntegrationOptions.map((entry) => {
        const connected = Boolean(connections?.[entry.id]);
        const detail = details?.[entry.id];
        const policyProviderKey = connected ? (entry.id === "github" ? "github" : entry.id) : null;
        const Icon = entry.icon;
        return (
          <div key={entry.id} className="rounded-lg border border-border bg-surface/60">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
                <Icon size={15} strokeWidth={1.85} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[13px] font-medium text-ink">{entry.label}</p>
                  {connected ? (
                    <span className="shrink-0 rounded-full border border-success-border bg-success-bg px-1.5 py-px text-[10px] font-medium text-success">
                      Connected
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">
                  {(connected && detail?.summary) || entry.description}
                </p>
              </div>
              {!connected ? (
                <button
                  type="button"
                  onClick={() => openConnectPopup(entry)}
                  disabled={connectingId === entry.id}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-canvas px-2.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-65"
                >
                  {connectingId === entry.id ? (
                    <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
                  ) : null}
                  {connectingId === entry.id ? "Connecting" : "Connect"}
                </button>
              ) : null}
            </div>
            {policyProviderKey ? (
              <div className="border-t border-border/70 px-3.5 py-3">
                <ToolPolicyEditor
                  providerKey={policyProviderKey}
                  overrides={toolPolicies?.[policyProviderKey]}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FirstSessionPanel() {
  return (
    <EducationPanel icon={MessageCircle}>
      <p>
        Based on what you told us, Leo has prepared a first session to gather your context and start
        building your Personal Brain.
      </p>
      <div className="rounded-md border border-border bg-canvas px-3 py-2">
        <p className="text-[11px] font-medium uppercase text-ink-subtle">Prepared prompt</p>
        <p className="mt-1 text-[13px] font-medium text-ink">{ONBOARDING_FIRST_SESSION_PROMPT}</p>
      </div>
      <p>This takes 2 minutes. You&apos;ll see exactly how it works.</p>
    </EducationPanel>
  );
}

function FinalSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
    >
      <span>{pending ? "Starting" : "Start First Session"}</span>
      {pending ? null : <ArrowRight size={12} strokeWidth={2} />}
    </button>
  );
}

function ChoiceButton({
  children,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-8 w-full items-center rounded-md border px-3 py-1.5 text-left text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        selected
          ? "border-border-strong bg-surface-active text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)]"
          : "border-border bg-surface text-ink/85 hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

export default function OnboardingForm({
  userEmail,
  userId,
  workspaceId,
  forceOnboarding = false,
  integrationConnections,
  integrationDetails,
  toolPolicies,
}: {
  userEmail: string;
  userId: string;
  workspaceId: string;
  forceOnboarding?: boolean;
  integrationConnections?: PersonalIntegrationConnections | undefined;
  integrationDetails?: PersonalIntegrationDetails | undefined;
  toolPolicies?: WorkspaceToolPolicyOverrides | undefined;
}) {
  const [serverState, action] = useActionState(completeOnboarding, initialState);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [values, setValues] = useState(initialState.values);
  const [callBooked, setCallBooked] = useState(false);
  const [callBookedLabel, setCallBookedLabel] = useState<string | null>(null);
  const [companyUrlHintVisible, setCompanyUrlHintVisible] = useState(false);

  function handleCallBooked(label: string | null) {
    setCallBooked(true);
    setCallBookedLabel(label);
  }

  const currentStep: StepDefinition = steps[step] ?? (steps[0] as StepDefinition);
  const isLastStep = step === steps.length - 1;
  const isCalendarStep = currentStep.key === "booking";
  const isEducationStep = educationKeys.has(currentStep.key);
  const displayedError = error || firstErrorMessage(serverState.errors);

  useEffect(() => {
    captureEvent("onboarding_started", {
      user_id: userId,
      workspace_id: workspaceId,
    });
  }, [userId, workspaceId]);

  // Warm up the cal.com booking embed as soon as onboarding opens, so the booking
  // step's calendar is already loading (or ready) by the time the user reaches it.
  // Skipped while the booking step is hidden.
  useEffect(() => {
    if (!SHOW_BOOKING_STEP || hasPreloadedCalEmbed) return;
    hasPreloadedCalEmbed = true;
    ensureCalApi()("preload", { calLink: onboardingCallCalLink });
  }, []);

  function updateValue<Key extends keyof typeof values>(key: Key, value: (typeof values)[Key]) {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
    if (key === "companyUrl") {
      setCompanyUrlHintVisible(false);
    }
  }

  function advanceStep() {
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function chooseHeardFrom(value: string) {
    setValues((current) => ({
      ...current,
      heardFrom: value,
      heardFromDetail: value === "other" ? current.heardFromDetail : "",
    }));
    setError("");

    if (value !== "other") {
      advanceStep();
    }
  }

  function chooseAgentExperience(value: string) {
    updateValue("agentExperience", value);
    advanceStep();
  }

  function togglePersonalBrainFolder(value: string, pressed: boolean) {
    setValues((current) => {
      const selected = new Set(current.personalBrainFolders);
      if (pressed) {
        selected.add(value);
      } else {
        selected.delete(value);
      }
      return { ...current, personalBrainFolders: Array.from(selected) };
    });
    setError("");
  }

  // The agent only gets the integrations the user actually connected during onboarding — not a
  // speculative default set. Derived from live connection state (refreshed after each connect),
  // and submitted as the source of truth for which @-mentions land in the agent file.
  const connectedIntegrations = onboardingIntegrationOptions
    .filter((entry) => Boolean(integrationConnections?.[entry.id]))
    .map((entry) => entry.id);

  function validateCurrentStep() {
    if (currentStep.key === "heardFrom" && !values.heardFrom) {
      setError("Choose where you heard about opencompany.");
      return false;
    }
    if (
      currentStep.key === "heardFrom" &&
      values.heardFrom === "other" &&
      !values.heardFromDetail.trim()
    ) {
      setError("Tell us where you heard about opencompany.");
      return false;
    }
    if (currentStep.key === "team") {
      if (!values.role.trim()) {
        setError("Enter your role.");
        return false;
      }
      if (!values.teamSize) {
        setError("Choose your team size.");
        return false;
      }
      if (!values.companyUrl.trim() && !companyUrlHintVisible) {
        setError("");
        setCompanyUrlHintVisible(true);
        return false;
      }
      if (!isValidCompanyUrl(values.companyUrl)) {
        setError("Enter a valid company URL.");
        return false;
      }
    }
    if (currentStep.key === "agentExperience" && !values.agentExperience) {
      setError("Choose your experience level.");
      return false;
    }
    // The goal step is optional — nothing to validate.

    setError("");
    return true;
  }

  function goForward() {
    if (!validateCurrentStep()) return;
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  return (
    <main className="relative flex min-h-screen w-screen bg-canvas px-5">
      <div className="absolute top-6 left-1/2 flex -translate-x-1/2 items-center justify-center gap-2">
        <img
          src="/brand/opencompany-mark-dark.svg"
          alt="OpenCompany"
          className="h-6 w-6 [[data-resolved-theme=dark]_&]:hidden"
        />
        <img
          src="/brand/opencompany-mark-light.svg"
          alt=""
          aria-hidden
          className="hidden h-6 w-6 [[data-resolved-theme=dark]_&]:block"
        />
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">opencompany</span>
      </div>
      <section
        className={`mx-auto flex w-full flex-col pb-8 ${
          isCalendarStep
            ? "max-w-[960px] pt-8"
            : isEducationStep
              ? "min-h-screen max-w-[500px] pt-[16vh]"
              : "min-h-screen max-w-[460px] pt-[16vh]"
        }`}
      >
        <form action={action}>
          <input type="hidden" name="heardFrom" value={values.heardFrom} />
          <input type="hidden" name="heardFromDetail" value={values.heardFromDetail} />
          <input type="hidden" name="role" value={values.role} />
          <input type="hidden" name="teamSize" value={values.teamSize} />
          <input type="hidden" name="companyUrl" value={values.companyUrl} />
          <input type="hidden" name="agentExperience" value={values.agentExperience} />
          <input type="hidden" name="goal" value={values.goal} />
          {forceOnboarding ? <input type="hidden" name="forceOnboarding" value="1" /> : null}
          {values.personalBrainFolders.map((folder) => (
            <input key={folder} type="hidden" name="personalBrainFolders" value={folder} />
          ))}
          {connectedIntegrations.map((integration) => (
            <input
              key={integration}
              type="hidden"
              name="personalIntegrations"
              value={integration}
            />
          ))}

          <div className="text-center">
            <div className="mb-8 flex justify-center gap-1">
              {steps.map((item, index) => (
                <button
                  key={item.title}
                  type="button"
                  aria-label={`Go to step ${index + 1}`}
                  onClick={() => setStep(index)}
                  className={`h-1 rounded-full transition-all ${
                    index === step ? "w-5 bg-ink" : "w-1 bg-border-strong"
                  }`}
                />
              ))}
            </div>

            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
              {currentStep.title}
            </h1>
            <p className="mx-auto mt-1.5 max-w-[360px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
              {currentStep.subtitle}
            </p>
          </div>

          <div className="mt-8">
            {currentStep.key === "heardFrom" ? (
              <div className="space-y-2">
                {heardFromOptions.map((option) => (
                  <ChoiceButton
                    key={option.value}
                    selected={values.heardFrom === option.value}
                    onClick={() => chooseHeardFrom(option.value)}
                  >
                    {option.label}
                  </ChoiceButton>
                ))}
                {values.heardFrom === "other" ? (
                  <label className="block pt-2">
                    <span className="text-[12px] font-medium text-ink-subtle">Source</span>
                    <input
                      type="text"
                      value={values.heardFromDetail}
                      onChange={(event) => updateValue("heardFromDetail", event.target.value)}
                      placeholder="Where did you hear about us?"
                      className="mt-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            {currentStep.key === "team" ? (
              <div className="space-y-5">
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-subtle">Role</span>
                  <input
                    type="text"
                    value={values.role}
                    onChange={(event) => updateValue("role", event.target.value)}
                    placeholder="Founder, PM, engineer..."
                    className="mt-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
                  />
                </label>

                <fieldset>
                  <legend className="text-[12px] font-medium text-ink-subtle">Team size</legend>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {teamSizeOptions.map((option) => (
                      <ChoiceButton
                        key={option.value}
                        selected={values.teamSize === option.value}
                        onClick={() => updateValue("teamSize", option.value)}
                      >
                        {option.label}
                      </ChoiceButton>
                    ))}
                  </div>
                </fieldset>

                <label className="block">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-subtle">
                    <span>Company URL</span>
                    <span className="rounded-[3px] bg-surface-subtle px-1 py-px text-[9px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                      Optional
                    </span>
                  </span>
                  <input
                    type="text"
                    value={values.companyUrl}
                    onChange={(event) => updateValue("companyUrl", event.target.value)}
                    placeholder="Optional"
                    className="mt-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
                  />
                  {companyUrlHintVisible ? (
                    <p className="mt-2 text-[12px] leading-4 text-ink-muted" aria-live="polite">
                      {companyUrlContextHint}
                    </p>
                  ) : null}
                </label>
              </div>
            ) : null}

            {currentStep.key === "agentExperience" ? (
              <div className="space-y-2">
                {agentExperienceOptions.map((option) => (
                  <ChoiceButton
                    key={option.value}
                    selected={values.agentExperience === option.value}
                    onClick={() => chooseAgentExperience(option.value)}
                  >
                    {option.label}
                  </ChoiceButton>
                ))}
              </div>
            ) : null}

            {currentStep.key === "goal" ? (
              <div>
                <textarea
                  value={values.goal}
                  onChange={(event) => updateValue("goal", event.target.value)}
                  rows={4}
                  maxLength={GOAL_MAX_LENGTH}
                  placeholder="e.g. Ship faster, stay on top of customers, win back my time…"
                  className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
                />
              </div>
            ) : null}

            {currentStep.key === "booking" ? (
              <OnboardingCallEmbed onBooked={handleCallBooked} />
            ) : null}

            {currentStep.key === "meetLeo" ? <MeetLeoVisual /> : null}

            {currentStep.key === "personalBrain" ? (
              <PersonalBrainPanel
                selectedFolders={values.personalBrainFolders}
                onToggleFolder={togglePersonalBrainFolder}
              />
            ) : null}

            {currentStep.key === "memory" ? (
              <EducationPanel icon={Database}>
                <p>
                  Every conversation, detail, and preference can build on what came before. Leo gets
                  better the longer you use it, because it actually knows you.
                </p>
              </EducationPanel>
            ) : null}

            {currentStep.key === "capabilities" ? (
              <OnboardingCapabilitiesPanel
                connections={integrationConnections}
                details={integrationDetails}
                toolPolicies={toolPolicies}
              />
            ) : null}

            {currentStep.key === "firstSession" ? <FirstSessionPanel /> : null}

            {displayedError ? (
              <p className="mt-4 text-center text-[12px] leading-4 text-red-700">
                {displayedError}
              </p>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            {isCalendarStep ? (
              <OnboardingCallActions
                booked={callBooked}
                bookedLabel={callBookedLabel}
                showBack={step > 0}
                onContinue={() => {
                  setError("");
                  advanceStep();
                }}
                onBack={() => {
                  setError("");
                  setStep((current) => Math.max(current - 1, 0));
                }}
              />
            ) : isLastStep ? (
              <FinalSubmitButton />
            ) : (
              <button
                type="button"
                onClick={goForward}
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
              >
                <span>
                  {currentStep.key === "team" && companyUrlHintVisible && !values.companyUrl.trim()
                    ? "Continue without URL"
                    : "Continue"}
                </span>
                <ArrowRight size={12} strokeWidth={2} />
              </button>
            )}

            {step > 0 && !isCalendarStep ? (
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setStep((current) => Math.max(current - 1, 0));
                }}
                className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <ArrowLeft size={12} strokeWidth={2} />
                <span>Back</span>
              </button>
            ) : null}
          </div>
        </form>

        {isCalendarStep ? null : (
          <div className="mt-auto pt-8 text-center text-[12.5px] leading-5 text-ink-muted">
            <div>Using {userEmail}</div>
            <a href="/auth/sign-out" className="text-ink-subtle transition-colors hover:text-ink">
              Use a different email
            </a>
          </div>
        )}
      </section>
    </main>
  );
}
