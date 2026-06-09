"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import {
  agentExperienceOptions,
  heardFromOptions,
  teamSizeOptions,
} from "@/lib/onboarding/options";
import {
  ONBOARDING_CONNECTED_MESSAGE,
  ONBOARDING_INTEGRATIONS,
  ONBOARDING_SETUPS,
  type OnboardingConnectedMessage,
} from "@/lib/onboarding/setups";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import { personalPaths } from "@/lib/personal/paths";

// V3 onboarding (/onboarding/personal). Same stepper shell as the legacy workspace onboarding —
// progress dots, a centered title/subtitle per step, and a consistent Continue/Back footer — wrapped
// around the personal-agent flow:
//
//   0. Where did you hear about us — attribution (persisted for analytics only).
//   1. About you — role, team size, company URL. The URL is optional but we nudge once if skipped,
//      since it lets the agent research the company.
//   2. Agent familiarity — how much the user has used agents before.
//   3. Name + preset — name the agent and pick a starting point (Co-founder / Executive Assistant /
//      start from scratch). A preset pre-selects its integrations and seeds the first task.
//   4. Integrations — connect tools INLINE: "Connect" opens the OAuth flow in a popup that reports
//      back to this window (see /onboarding/connected), so the page never navigates. The checkbox
//      enables the integration on the agent regardless of whether it's connected yet.
//   5. Launch — a single "set up my agent" CTA. It persists the survey, names the agent, enables the
//      selected integrations, and seeds the first session (which runs the agent's onboarding skill),
//      then drops the user into /personal.
//
// The user no longer types a first task — the seeded session opens with the preset's starter task
// (or a sensible default for "start from scratch").

const SCRATCH = "__scratch__";
const DEFAULT_SCRATCH_TASK =
  "Introduce yourself, then help me figure out the best place to start.";

const SETUP_EYEBROW = "Let's set up your personal agent";

const STEPS = [
  {
    eyebrow: null,
    title: "Where did you hear about us?",
    subtitle: "This helps us understand where useful people are finding us.",
  },
  {
    eyebrow: null,
    title: "Tell us about you",
    subtitle: "Just enough context for your agent to be useful from day one.",
  },
  {
    eyebrow: null,
    title: "How familiar are you with agents?",
    subtitle: "Use the answer that sounds closest to you.",
  },
  {
    eyebrow: SETUP_EYEBROW,
    title: "Name your agent and pick a starting point",
    subtitle: "Give it a name and a role to start from. You can change all of this later.",
  },
  {
    eyebrow: SETUP_EYEBROW,
    title: "Connect what your agent can use",
    subtitle: "Connecting these makes your first session much better — but you can do it later too.",
  },
  {
    eyebrow: SETUP_EYEBROW,
    title: "Ready when you are",
    subtitle: "I'll get myself set up, then start on your first task.",
  },
] as const;

const LAST_STEP = STEPS.length - 1;

function isValidWebsite(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
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

function OnboardingField({
  label,
  value,
  onChange,
  placeholder,
  optional,
  autoFocus,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  optional?: boolean;
  autoFocus?: boolean;
  inputMode?: "url" | "text";
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-subtle">
        <span>{label}</span>
        {optional ? (
          <span className="rounded-[3px] bg-surface-subtle px-1 py-px text-[9px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Optional
          </span>
        ) : null}
      </span>
      <input
        type="text"
        // biome-ignore lint/a11y/noAutofocus: focused single-purpose onboarding step.
        autoFocus={autoFocus}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
      />
    </label>
  );
}

type PersonalOnboardingChatProps = {
  agentId: string;
  defaultName: string;
  userEmail: string;
};

export function PersonalOnboardingChat({
  agentId,
  defaultName,
  userEmail,
}: PersonalOnboardingChatProps) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Step 0 — attribution.
  const [heardFrom, setHeardFrom] = useState("");
  const [heardFromDetail, setHeardFromDetail] = useState("");

  // Step 1 — about you.
  const [role, setRole] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [urlNudged, setUrlNudged] = useState(false);

  // Step 2 — familiarity.
  const [agentExperience, setAgentExperience] = useState("");

  // Step 3 — name + preset.
  const [agentName, setAgentName] = useState("");
  const [presetChoice, setPresetChoice] = useState<string | null>(null);

  // Step 4 — integrations.
  const [selected, setSelected] = useState<Set<PersonalIntegrationId>>(new Set());
  const [connected, setConnected] = useState<Set<PersonalIntegrationId>>(new Set());
  const [connecting, setConnecting] = useState<PersonalIntegrationId | null>(null);
  const connectingRef = useRef<PersonalIntegrationId | null>(null);

  const [isPending, startTransition] = useTransition();

  const meta = STEPS[step] ?? STEPS[0];
  const isWide = step === 3 || step === 4;

  // Listen for the inline-connect popup reporting back (see /onboarding/connected). Only ever from
  // our own origin, and only the connected/error contract.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as OnboardingConnectedMessage | undefined;
      if (!data || data.type !== ONBOARDING_CONNECTED_MESSAGE) return;

      setConnecting(null);
      connectingRef.current = null;

      const provider = data.provider as PersonalIntegrationId | null;
      if (!provider) return;
      if (data.status === "connected") {
        setError(null);
        setConnected((prev) => new Set(prev).add(provider));
        setSelected((prev) => new Set(prev).add(provider));
      } else {
        setError("That connection didn't complete. You can try again or continue without it.");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function goBack() {
    setError(null);
    setStep((current) => Math.max(current - 1, 0));
  }

  function advance() {
    setError(null);
    setStep((current) => Math.min(current + 1, LAST_STEP));
  }

  function chooseHeardFrom(value: string) {
    setHeardFrom(value);
    if (value !== "other") setHeardFromDetail("");
    setError(null);
    if (value !== "other") advance();
  }

  function chooseAgentExperience(value: string) {
    setAgentExperience(value);
    setError(null);
    advance();
  }

  function choosePreset(id: string) {
    setError(null);
    setPresetChoice(id);
    if (id === SCRATCH) return;
    const preset = ONBOARDING_SETUPS.find((p) => p.id === id);
    if (preset) {
      setSelected((prev) => new Set([...prev, ...preset.integrations]));
    }
  }

  function toggleIntegration(id: PersonalIntegrationId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConnect(id: PersonalIntegrationId) {
    const def = ONBOARDING_INTEGRATIONS.find((i) => i.id === id);
    if (!def) return;
    const width = 520;
    const height = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      def.connectHref,
      "oc-onboarding-connect",
      `width=${width},height=${height},left=${left},top=${top}`,
    );
    if (!popup) {
      setError("Allow popups for this site to connect, then try again.");
      return;
    }
    setError(null);
    setConnecting(id);
    connectingRef.current = id;
    // If the user closes the popup without finishing, clear the pending state so the row resets.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        if (connectingRef.current === id) {
          setConnecting(null);
          connectingRef.current = null;
        }
      }
    }, 500);
  }

  function goForward() {
    if (step === 0) {
      if (!heardFrom) return setError("Choose where you heard about us.");
      if (heardFrom === "other" && !heardFromDetail.trim()) {
        return setError("Tell us where you heard about us.");
      }
      return advance();
    }
    if (step === 1) {
      if (!role.trim()) return setError("Enter your role.");
      if (!teamSize) return setError("Choose your team size.");
      if (companyUrl.trim() && !isValidWebsite(companyUrl.trim())) {
        return setError("Enter a valid company URL.");
      }
      // Nudge once if they skip the URL — it makes the agent meaningfully better — then let them by.
      if (!companyUrl.trim() && !urlNudged) {
        setUrlNudged(true);
        setError(null);
        return;
      }
      return advance();
    }
    if (step === 2) {
      if (!agentExperience) return setError("Choose your experience level.");
      return advance();
    }
    if (step === 3) {
      if (!agentName.trim()) return setError("Name your agent.");
      if (!presetChoice) return setError("Pick a starting point.");
      return advance();
    }
    if (step === 4) {
      return advance();
    }
  }

  function submit() {
    if (isPending) return;
    const preset =
      presetChoice && presetChoice !== SCRATCH
        ? ONBOARDING_SETUPS.find((p) => p.id === presetChoice)
        : undefined;
    const prompt = preset?.starterTask ?? DEFAULT_SCRATCH_TASK;
    setError(null);
    startTransition(async () => {
      const result = await createPersonalOnboardingSession(
        agentId,
        {
          name: defaultName.trim(),
          website: companyUrl.trim(),
          role: role.trim(),
          teamSize,
          agentExperience,
        },
        prompt,
        {
          integrations: [...selected],
          agentName: agentName.trim(),
          survey: { heardFrom, heardFromDetail: heardFromDetail.trim() },
          ...(preset
            ? { setup: { id: preset.id, title: preset.title, intent: preset.soulIntent } }
            : {}),
        },
      );
      if (!result.ok) {
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        setError(result.error);
        return;
      }
      seedSessionQueries(queryClient, workspaceId, result.detail);
      router.push(personalPaths.session(result.session.id));
    });
  }

  return (
    <main className="relative flex min-h-screen w-screen flex-col bg-canvas px-5">
      <section
        className={`mx-auto flex min-h-screen w-full flex-col pb-8 pt-[13vh] ${
          isWide ? "max-w-[560px]" : "max-w-[460px]"
        }`}
      >
        <div className="text-center">
          <div className="mb-8 flex justify-center gap-1">
            {STEPS.map((item, index) => (
              <span
                key={item.title}
                aria-hidden
                className={`h-1 rounded-full transition-all ${
                  index === step ? "w-5 bg-ink" : "w-1 bg-border-strong"
                }`}
              />
            ))}
          </div>

          {meta.eyebrow ? (
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
              {meta.eyebrow}
            </p>
          ) : null}
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">{meta.title}</h1>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
            {meta.subtitle}
          </p>
        </div>

        <div className="mt-8">
          {step === 0 ? (
            <div className="space-y-2">
              {heardFromOptions.map((option) => (
                <ChoiceButton
                  key={option.value}
                  selected={heardFrom === option.value}
                  onClick={() => chooseHeardFrom(option.value)}
                >
                  {option.label}
                </ChoiceButton>
              ))}
              {heardFrom === "other" ? (
                <label className="block pt-2">
                  <span className="text-[12px] font-medium text-ink-subtle">Source</span>
                  <input
                    type="text"
                    value={heardFromDetail}
                    onChange={(event) => setHeardFromDetail(event.target.value)}
                    placeholder="Where did you hear about us?"
                    className="mt-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-5">
              <OnboardingField
                label="Your role"
                value={role}
                onChange={setRole}
                placeholder="Founder, PM, engineer..."
                autoFocus
              />
              <fieldset>
                <legend className="text-[12px] font-medium text-ink-subtle">Team size</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {teamSizeOptions.map((option) => (
                    <ChoiceButton
                      key={option.value}
                      selected={teamSize === option.value}
                      onClick={() => {
                        setTeamSize(option.value);
                        setError(null);
                      }}
                    >
                      {option.label}
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>
              <div>
                <OnboardingField
                  label="Company URL"
                  value={companyUrl}
                  onChange={(value) => {
                    setCompanyUrl(value);
                    setError(null);
                  }}
                  placeholder="acme.com"
                  optional
                  inputMode="url"
                />
                {urlNudged && !companyUrl.trim() ? (
                  <p className="mt-2 text-[12px] leading-4 text-ink-muted">
                    Adding your site lets your agent research your company and tailor everything to
                    you — it makes a real difference. Press Continue again to skip.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-2">
              {agentExperienceOptions.map((option) => (
                <ChoiceButton
                  key={option.value}
                  selected={agentExperience === option.value}
                  onClick={() => chooseAgentExperience(option.value)}
                >
                  {option.label}
                </ChoiceButton>
              ))}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-5">
              <OnboardingField
                label="Agent name"
                value={agentName}
                onChange={(value) => {
                  setAgentName(value);
                  setError(null);
                }}
                placeholder="Friday, Ada, Leo..."
                autoFocus
              />
              <div>
                <span className="text-[12px] font-medium text-ink-subtle">Starting point</span>
                <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {ONBOARDING_SETUPS.map((preset) => {
                    const Icon = preset.icon;
                    const isSelected = presetChoice === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => choosePreset(preset.id)}
                        className={`flex flex-col gap-2 rounded-lg border bg-surface/55 px-3.5 py-3 text-left transition-colors duration-150 hover:border-border-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 ${
                          isSelected ? "border-ink/40 bg-surface" : "border-border"
                        }`}
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
                          <Icon size={15} strokeWidth={1.85} />
                        </span>
                        <span className="text-[13px] font-medium text-ink">{preset.title}</span>
                        <span className="text-[12px] leading-4 text-ink-muted">
                          {preset.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => choosePreset(SCRATCH)}
                  className={`mt-2.5 flex w-full items-center justify-between rounded-lg border bg-surface/55 px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-border-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 ${
                    presetChoice === SCRATCH ? "border-ink/40 bg-surface" : "border-border"
                  }`}
                >
                  <span className="text-[13px] font-medium text-ink">Start from scratch</span>
                  <span className="text-[12px] text-ink-muted">I'll set it up myself</span>
                </button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-2">
              {ONBOARDING_INTEGRATIONS.map((integration) => {
                const Icon = integration.icon;
                const isSelected = selected.has(integration.id);
                const isConnected = connected.has(integration.id);
                const isConnecting = connecting === integration.id;
                return (
                  <div
                    key={integration.id}
                    className={`flex min-w-0 items-center gap-3 rounded-lg border bg-surface/55 px-3.5 py-3 transition-colors ${
                      isSelected ? "border-ink/30" : "border-border"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleIntegration(integration.id)}
                      aria-pressed={isSelected}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
                        <Icon size={15} strokeWidth={1.85} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">
                          {integration.label}
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-muted">
                          {integration.description}
                        </span>
                      </span>
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          isSelected
                            ? "border-ink bg-ink text-canvas"
                            : "border-border-strong bg-surface text-transparent"
                        }`}
                      >
                        <Check size={12} strokeWidth={2.5} />
                      </span>
                    </button>
                    {isConnected ? (
                      <span className="flex shrink-0 items-center gap-1 rounded-md border border-pill-green-text/20 bg-pill-green px-2 py-1 text-[11.5px] font-medium text-pill-green-text">
                        <Check size={11} strokeWidth={2.5} />
                        Connected
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleConnect(integration.id)}
                        disabled={isConnecting}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-subtle transition-colors hover:border-border-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
                      >
                        {isConnecting ? (
                          <LoaderCircle size={11} strokeWidth={2} className="animate-spin" />
                        ) : (
                          <ExternalLink size={11} strokeWidth={2} />
                        )}
                        {isConnecting ? "Connecting" : "Connect"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {step === LAST_STEP ? (
            <div className="space-y-2.5 rounded-lg border border-border bg-surface/55 px-4 py-3.5">
              <SummaryRow label="Agent">{agentName.trim() || "Your agent"}</SummaryRow>
              <SummaryRow label="Starting point">
                {presetChoice && presetChoice !== SCRATCH
                  ? (ONBOARDING_SETUPS.find((p) => p.id === presetChoice)?.title ?? "From scratch")
                  : "From scratch"}
              </SummaryRow>
              <SummaryRow label="Integrations">
                {selected.size === 0
                  ? "None yet"
                  : `${selected.size} enabled · ${connected.size} connected`}
              </SummaryRow>
            </div>
          ) : null}

          {error ? (
            <p className="mt-4 text-center text-[12px] leading-4 text-red-700">{error}</p>
          ) : null}
        </div>

        <div className="mt-5 space-y-3">
          {step === LAST_STEP ? (
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
            >
              {isPending ? (
                <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
              ) : null}
              <span>
                {isPending ? "Setting up" : `Set up ${agentName.trim() || "my agent"}`}
              </span>
              {isPending ? null : <ArrowRight size={12} strokeWidth={2} />}
            </button>
          ) : (
            <button
              type="button"
              onClick={goForward}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <span>Continue</span>
              <ArrowRight size={12} strokeWidth={2} />
            </button>
          )}

          {step > 0 ? (
            <button
              type="button"
              onClick={goBack}
              disabled={isPending}
              className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
            >
              <ArrowLeft size={12} strokeWidth={2} />
              <span>Back</span>
            </button>
          ) : null}
        </div>

        <div className="mt-auto pt-8 text-center text-[12.5px] leading-5 text-ink-muted">
          <div>Using {userEmail}</div>
          <a href="/auth/sign-out" className="text-ink-subtle transition-colors hover:text-ink">
            Use a different email
          </a>
        </div>
      </section>
    </main>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="text-ink-subtle">{label}</span>
      <span className="truncate font-medium text-ink">{children}</span>
    </div>
  );
}
