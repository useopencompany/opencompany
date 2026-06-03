"use client";

import { captureEvent } from "@opencompany/analytics/client";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { completeOnboarding, type OnboardingActionState } from "@/lib/onboarding/actions";
import {
  agentExperienceOptions,
  heardFromOptions,
  helpAreaOptions,
  teamSizeOptions,
} from "@/lib/onboarding/options";

const initialState: OnboardingActionState = {
  errors: {},
  values: {
    heardFrom: "",
    heardFromDetail: "",
    role: "",
    teamSize: "",
    companyUrl: "",
    agentExperience: "",
    helpAreas: [],
  },
};

const onboardingCallCalLink = "team/opencompany/intro-call";
const onboardingCallUrl = `https://cal.com/${onboardingCallCalLink}?overlayCalendar=true`;
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

const steps = [
  {
    title: "Where did you hear about opencompany?",
    subtitle: "This helps us understand where useful teams are finding us.",
  },
  {
    title: "Tell us about your team",
    subtitle: "Just enough context to make the workspace feel right.",
  },
  {
    title: "How familiar are you with agents?",
    subtitle: "Use the answer that sounds closest to you.",
  },
  {
    title: "Where should agents help first?",
    subtitle: "Choose every area that matters right now.",
  },
  {
    title: "Book your onboarding call",
    subtitle: "Pick a time with the opencompany team — or skip for now and finish setup.",
  },
] as const;

const onboardingCallStepIndex = steps.length - 1;

function firstErrorMessage(errors: OnboardingActionState["errors"]) {
  return (
    errors.heardFrom ??
    errors.heardFromDetail ??
    errors.role ??
    errors.teamSize ??
    errors.companyUrl ??
    errors.agentExperience ??
    errors.helpAreas
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
    // there's no reason to keep offering "Skip" — collapse to a single Finish.
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
        className="min-h-[620px] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(17,17,17,0.04)]"
      />
    </div>
  );
}

// Final-step actions. Before a call is booked, Skip + Finish share one
// segmented control (Skip is the quiet escape hatch, Finish the primary). Once
// a call is booked, Skip disappears and Finish takes the full width under a
// confirmation. Both buttons submit the same form — booking lives in the cal
// iframe, so "skip" and "finish" complete onboarding identically.
function OnboardingCallActions({
  booked,
  bookedLabel,
}: {
  booked: boolean;
  bookedLabel: string | null;
}) {
  const { pending } = useFormStatus();

  if (booked) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-md border border-pill-green-text/20 bg-pill-green px-3 py-2 text-[12px] font-medium text-pill-green-text">
          <Check size={14} strokeWidth={2.4} />
          <span>Onboarding call booked{bookedLabel ? ` — ${bookedLabel}` : ""}</span>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
        >
          <span>{pending ? "Saving" : "Finish onboarding"}</span>
          <ArrowRight size={12} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-9 w-full overflow-hidden rounded-md border border-border-strong shadow-[0_1px_2px_rgba(0,0,0,0.18)]">
      <button
        type="submit"
        disabled={pending}
        className="flex items-center justify-center border-r border-border-strong px-4 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Saving" : "Skip"}
      </button>
      <button
        type="submit"
        disabled={pending}
        className="flex flex-1 items-center justify-center gap-1.5 bg-ink px-3 text-[12px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted"
      >
        <span>{pending ? "Saving" : "Finish onboarding"}</span>
        <ArrowRight size={12} strokeWidth={2} />
      </button>
    </div>
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
}: {
  userEmail: string;
  userId: string;
  workspaceId: string;
}) {
  const [serverState, action] = useActionState(completeOnboarding, initialState);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [values, setValues] = useState(initialState.values);
  const [callBooked, setCallBooked] = useState(false);
  const [callBookedLabel, setCallBookedLabel] = useState<string | null>(null);

  function handleCallBooked(label: string | null) {
    setCallBooked(true);
    setCallBookedLabel(label);
  }

  const currentStep = steps[step] ?? steps[0];
  const isLastStep = step === onboardingCallStepIndex;
  const isCalendarStep = step === onboardingCallStepIndex;
  const displayedError = error || firstErrorMessage(serverState.errors);

  useEffect(() => {
    captureEvent("onboarding_started", {
      user_id: userId,
      workspace_id: workspaceId,
    });
  }, [userId, workspaceId]);

  // Warm up the cal.com booking embed as soon as onboarding opens, so the final
  // step's calendar is already loading (or ready) by the time the user reaches it.
  useEffect(() => {
    if (hasPreloadedCalEmbed) return;
    hasPreloadedCalEmbed = true;
    ensureCalApi()("preload", { calLink: onboardingCallCalLink });
  }, []);

  function updateValue<Key extends keyof typeof values>(key: Key, value: (typeof values)[Key]) {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
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

  function toggleHelpArea(value: string) {
    setValues((current) => {
      const selected = current.helpAreas.includes(value);
      return {
        ...current,
        helpAreas: selected
          ? current.helpAreas.filter((area) => area !== value)
          : [...current.helpAreas, value],
      };
    });
    setError("");
  }

  function validateCurrentStep() {
    if (step === 0 && !values.heardFrom) {
      setError("Choose where you heard about opencompany.");
      return false;
    }
    if (step === 0 && values.heardFrom === "other" && !values.heardFromDetail.trim()) {
      setError("Tell us where you heard about opencompany.");
      return false;
    }
    if (step === 1) {
      if (!values.role.trim()) {
        setError("Enter your role.");
        return false;
      }
      if (!values.teamSize) {
        setError("Choose your team size.");
        return false;
      }
      if (!isValidCompanyUrl(values.companyUrl)) {
        setError("Enter a valid company URL.");
        return false;
      }
    }
    if (step === 2 && !values.agentExperience) {
      setError("Choose your experience level.");
      return false;
    }
    if (step === 3 && values.helpAreas.length === 0) {
      setError("Choose at least one area.");
      return false;
    }

    setError("");
    return true;
  }

  function goForward() {
    if (!validateCurrentStep()) return;
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  return (
    <main className="flex min-h-screen w-screen bg-canvas px-5">
      <section
        className={`mx-auto flex min-h-screen w-full flex-col pb-8 ${
          isCalendarStep ? "max-w-[960px] pt-8" : "max-w-[460px] pt-[13vh]"
        }`}
      >
        <form action={action}>
          <input type="hidden" name="heardFrom" value={values.heardFrom} />
          <input type="hidden" name="heardFromDetail" value={values.heardFromDetail} />
          <input type="hidden" name="role" value={values.role} />
          <input type="hidden" name="teamSize" value={values.teamSize} />
          <input type="hidden" name="companyUrl" value={values.companyUrl} />
          <input type="hidden" name="agentExperience" value={values.agentExperience} />
          {values.helpAreas.map((area) => (
            <input key={area} type="hidden" name="helpAreas" value={area} />
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
            {step === 0 ? (
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

            {step === 1 ? (
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
                </label>
              </div>
            ) : null}

            {step === 2 ? (
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

            {step === 3 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {helpAreaOptions.map((option) => (
                  <ChoiceButton
                    key={option.value}
                    selected={values.helpAreas.includes(option.value)}
                    onClick={() => toggleHelpArea(option.value)}
                  >
                    {option.label}
                  </ChoiceButton>
                ))}
              </div>
            ) : null}

            {step === onboardingCallStepIndex ? (
              <OnboardingCallEmbed onBooked={handleCallBooked} />
            ) : null}

            {displayedError ? (
              <p className="mt-4 text-center text-[12px] leading-4 text-red-700">
                {displayedError}
              </p>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            {isLastStep ? (
              <OnboardingCallActions booked={callBooked} bookedLabel={callBookedLabel} />
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

            {step > 0 && !isLastStep ? (
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
