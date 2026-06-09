"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ArrowUp, Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Composer } from "@/components/Composer";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { generateOnboardingPills } from "@/lib/onboarding/pills";
import {
  ONBOARDING_INTEGRATIONS,
  ONBOARDING_SETUPS,
  type OnboardingSetup,
} from "@/lib/onboarding/setups";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import { resetPersonalAgent } from "@/lib/personal/actions";
import { personalPaths } from "@/lib/personal/paths";

const TEXTAREA_MAX_HEIGHT_PX = 220;

function isValidWebsite(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

type PersonalOnboardingChatProps = {
  agentId: string;
  defaultName: string;
  devReset: boolean;
};

type Step = "identity" | "setup" | "integrations" | "prompt";

// V2 onboarding (/onboarding/personal): four distraction-free screens, no sidebar/inbox chrome.
//
//  1. Identity — name, website, role. On continue we fire a fast model (server action) in the
//     background to draft example pills tailored to who they are; the identity also rides invisibly
//     into the first message so the onboarding skill starts already knowing them.
//  2. Setup — pick a "what can this agent do for me" pack (or start from scratch). A pack
//     pre-selects its integrations, prefills the first task, and rides (invisibly) into the first
//     message as a mode the onboarding skill tunes the soul to.
//  3. Integrations — the integrations/MCPs we support. Selecting one enables it on the agent (its
//     @mention is written at submit); "Connect" opens the auth flow in a new tab so this screen's
//     state survives the round-trip.
//  4. Prompt — "What do you want to get done today?" (prefilled from the pack) with the tailored
//     pills. Submitting seeds the task into an onboarding session and lands the user in /personal.
//
// Integration mentions are written once, at submit (see createPersonalOnboardingSession →
// enablePersonalAgentIntegrations), not eagerly per toggle — so an abandoned onboarding never
// leaves the agent half-configured. The OAuth "Connect" links are independent of that.
export function PersonalOnboardingChat({
  agentId,
  defaultName,
  devReset,
}: PersonalOnboardingChatProps) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast, showError } = useToast();

  const [step, setStep] = useState<Step>("identity");
  const [name, setName] = useState(defaultName);
  const [website, setWebsite] = useState("");
  const [role, setRole] = useState("");
  const [pills, setPills] = useState<string[]>([]);
  const pillsRequested = useRef(false);

  const [selectedSetupId, setSelectedSetupId] = useState<string | null>(null);
  const [selectedIntegrations, setSelectedIntegrations] = useState<Set<PersonalIntegrationId>>(
    new Set(),
  );

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isResetting, startResetTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = Boolean(input.trim() && !isPending);

  useEffect(() => {
    if (step !== "prompt") return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input, step]);

  // Best-effort, fire-and-forget: kick off pills generation when the user leaves the identity screen
  // so they're ready by the time they reach the prompt screen. The action always resolves with at
  // least the fallback set, and a failure never blocks the flow.
  const kickOffPills = () => {
    if (pillsRequested.current) return;
    pillsRequested.current = true;
    void generateOnboardingPills({
      name: name.trim(),
      website: website.trim(),
      role: role.trim(),
    }).then(({ pills: generated }) => setPills(generated));
  };

  const advanceFromIdentity = () => {
    if (!name.trim()) {
      setError("Add your name to continue.");
      return;
    }
    if (!role.trim()) {
      setError("Add your role to continue.");
      return;
    }
    if (!website.trim()) {
      setError("Add your website to continue.");
      return;
    }
    if (!isValidWebsite(website.trim())) {
      setError("Enter a valid website.");
      return;
    }
    setError(null);
    kickOffPills();
    setStep("setup");
  };

  const selectSetup = (setup: OnboardingSetup) => {
    setSelectedSetupId(setup.id);
    setSelectedIntegrations(new Set(setup.integrations));
    setInput(setup.starterTask);
    setError(null);
    setStep("integrations");
  };

  const skipSetup = () => {
    setSelectedSetupId(null);
    setError(null);
    setStep("integrations");
  };

  const toggleIntegration = (id: PersonalIntegrationId) => {
    setSelectedIntegrations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || isPending) return;
    setError(null);
    const setupPack = selectedSetupId
      ? ONBOARDING_SETUPS.find((setup) => setup.id === selectedSetupId)
      : undefined;
    startTransition(async () => {
      const result = await createPersonalOnboardingSession(
        agentId,
        { name: name.trim(), website: website.trim(), role: role.trim() },
        content,
        {
          integrations: [...selectedIntegrations],
          ...(setupPack
            ? { setup: { id: setupPack.id, title: setupPack.title, intent: setupPack.soulIntent } }
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
  };

  const reset = () => {
    if (isResetting) return;
    startResetTransition(async () => {
      const result = await resetPersonalAgent();
      if (!result.ok) {
        showError(result.error, "Could not reset agent");
        return;
      }
      setStep("identity");
      setWebsite("");
      setRole("");
      setPills([]);
      pillsRequested.current = false;
      setSelectedSetupId(null);
      setSelectedIntegrations(new Set());
      setInput("");
      showToast({ title: "Personal agent reset", tone: "default" });
      // Re-run the server layout/page so ensurePersonalAgent provisions a fresh agent.
      router.refresh();
    });
  };

  const isWide = step === "setup" || step === "integrations";

  return (
    <main className="relative flex h-screen w-screen flex-col items-center justify-center overflow-y-auto bg-canvas px-6 py-10">
      <div className={`flex w-full flex-col gap-6 ${isWide ? "max-w-[560px]" : "max-w-[460px]"}`}>
        {step === "identity" ? (
          <IdentityStep
            name={name}
            website={website}
            role={role}
            onNameChange={setName}
            onWebsiteChange={setWebsite}
            onRoleChange={setRole}
            onContinue={advanceFromIdentity}
            error={error}
          />
        ) : step === "setup" ? (
          <SetupStep
            selectedSetupId={selectedSetupId}
            onSelect={selectSetup}
            onSkip={skipSetup}
            onBack={() => {
              setError(null);
              setStep("identity");
            }}
          />
        ) : step === "integrations" ? (
          <IntegrationsStep
            selected={selectedIntegrations}
            onToggle={toggleIntegration}
            onContinue={() => {
              setError(null);
              setStep("prompt");
            }}
            onBack={() => {
              setError(null);
              setStep("setup");
            }}
          />
        ) : (
          <PromptStep
            input={input}
            error={error}
            isPending={isPending}
            canSubmit={canSubmit}
            pills={pills}
            textareaRef={textareaRef}
            onInputChange={setInput}
            onSubmit={() => submit()}
            onPillSelect={(pill) => submit(pill)}
            onBack={() => {
              setError(null);
              setStep("integrations");
            }}
            showToast={showToast}
          />
        )}
      </div>

      {devReset ? (
        <button
          type="button"
          onClick={reset}
          disabled={isResetting}
          className="fixed bottom-4 right-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-subtle/70 transition-colors duration-150 hover:text-ink disabled:opacity-50"
          aria-label="Reset personal agent (dev only)"
        >
          {isResetting ? <LoaderCircle size={12} strokeWidth={2} className="animate-spin" /> : null}
          Reset agent
        </button>
      ) : null}
    </main>
  );
}

type IdentityStepProps = {
  name: string;
  website: string;
  role: string;
  onNameChange: (value: string) => void;
  onWebsiteChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onContinue: () => void;
  error: string | null;
};

function IdentityStep({
  name,
  website,
  role,
  onNameChange,
  onWebsiteChange,
  onRoleChange,
  onContinue,
  error,
}: IdentityStepProps) {
  const canContinue = Boolean(name.trim() && role.trim() && website.trim());

  return (
    <>
      <div className="text-center">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
          First, tell me about you
        </h1>
        <p className="mx-auto mt-1.5 max-w-[360px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
          A few details so I can tailor what I do for you.
        </p>
      </div>

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <OnboardingField
          label="Your name"
          value={name}
          onChange={onNameChange}
          placeholder="Alex Rivera"
          autoFocus
        />
        <OnboardingField
          label="Your role"
          value={role}
          onChange={onRoleChange}
          placeholder="Head of Growth"
        />
        <OnboardingField
          label="Website"
          value={website}
          onChange={onWebsiteChange}
          placeholder="acme.com"
          inputMode="url"
        />

        {error ? <p className="text-center text-[12px] leading-4 text-red-700">{error}</p> : null}

        <button
          type="submit"
          disabled={!canContinue}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted disabled:opacity-60"
        >
          <span>Continue</span>
          <ArrowRight size={12} strokeWidth={2} />
        </button>
      </form>
    </>
  );
}

type OnboardingFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "url" | "text";
};

function OnboardingField({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  inputMode,
}: OnboardingFieldProps) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-ink-subtle">{label}</span>
      <input
        type="text"
        // biome-ignore lint/a11y/noAutofocus: first field of a focused single-purpose onboarding form.
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

type SetupStepProps = {
  selectedSetupId: string | null;
  onSelect: (setup: OnboardingSetup) => void;
  onSkip: () => void;
  onBack: () => void;
};

// Setup packs: example "modes" that show what the agent can do. Picking one is the blank-box hack —
// the user doesn't invent the use case from scratch, they pick a role and the rest is scaffolded.
function SetupStep({ selectedSetupId, onSelect, onSkip, onBack }: SetupStepProps) {
  return (
    <>
      <div className="text-center">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
          What should I help you with?
        </h1>
        <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
          Pick a starting point and I'll set myself up for it. You can change this anytime.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {ONBOARDING_SETUPS.map((setup) => {
          const Icon = setup.icon;
          const selected = setup.id === selectedSetupId;
          return (
            <button
              key={setup.id}
              type="button"
              onClick={() => onSelect(setup)}
              className={`flex flex-col gap-2 rounded-lg border bg-surface/55 px-3.5 py-3 text-left transition-colors duration-150 hover:border-border-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 ${
                selected ? "border-ink/40 bg-surface" : "border-border"
              }`}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
                <Icon size={15} strokeWidth={1.85} />
              </span>
              <span className="text-[13px] font-medium text-ink">{setup.title}</span>
              <span className="text-[12px] leading-4 text-ink-muted">{setup.description}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          <span>Back</span>
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <span>Start from scratch</span>
          <ArrowRight size={12} strokeWidth={2} />
        </button>
      </div>
    </>
  );
}

type IntegrationsStepProps = {
  selected: Set<PersonalIntegrationId>;
  onToggle: (id: PersonalIntegrationId) => void;
  onContinue: () => void;
  onBack: () => void;
};

// Integrations/MCPs we support. Selecting enables the integration on the agent (the @mention is
// written at submit). "Connect" opens the auth flow in a new tab — the personal agent enables MCPs
// per-agent via the mention, but they're authorized at the workspace level, so connecting is a
// separate, optional step the user can also do later.
function IntegrationsStep({ selected, onToggle, onContinue, onBack }: IntegrationsStepProps) {
  return (
    <>
      <div className="text-center">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
          Connect what I can use
        </h1>
        <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
          Pick the tools I should have access to. Connect now or later — you can manage these in
          settings anytime.
        </p>
      </div>

      <div className="space-y-2">
        {ONBOARDING_INTEGRATIONS.map((integration) => {
          const Icon = integration.icon;
          const isSelected = selected.has(integration.id);
          return (
            <div
              key={integration.id}
              className={`flex min-w-0 items-center gap-3 rounded-lg border bg-surface/55 px-3.5 py-3 transition-colors ${
                isSelected ? "border-ink/30" : "border-border"
              }`}
            >
              <button
                type="button"
                onClick={() => onToggle(integration.id)}
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
              <a
                href={integration.connectHref}
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-subtle transition-colors hover:border-border-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                Connect
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onContinue}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <span>Continue</span>
          <ArrowRight size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onBack}
          className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          <span>Back</span>
        </button>
      </div>
    </>
  );
}

type PromptStepProps = {
  input: string;
  error: string | null;
  isPending: boolean;
  canSubmit: boolean;
  pills: string[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onPillSelect: (pill: string) => void;
  onBack: () => void;
  showToast: ReturnType<typeof useToast>["showToast"];
};

function PromptStep({
  input,
  error,
  isPending,
  canSubmit,
  pills,
  textareaRef,
  onInputChange,
  onSubmit,
  onPillSelect,
  onBack,
  showToast,
}: PromptStepProps) {
  return (
    <>
      <h1 className="text-center text-[18px] font-semibold tracking-[-0.01em] text-ink">
        What do you want to get done today?
      </h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Composer
          variant="expanded"
          error={error}
          input={
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              onPaste={(event) => {
                const items = event.clipboardData?.items;
                if (!items) return;
                const itemArray = Array.from(items);
                const hasImage = itemArray.some(
                  (item) => item.kind === "file" && item.type.startsWith("image/"),
                );
                if (!hasImage) return;
                const hasText = itemArray.some((item) => item.kind === "string");
                if (!hasText) event.preventDefault();
                showToast({
                  title: "Image upload coming soon",
                  description: hasText
                    ? "The text was pasted; the image was ignored."
                    : "Image attachments aren't supported yet.",
                  tone: "default",
                });
              }}
              rows={1}
              placeholder="e.g. Research our top 3 competitors and summarize how we differ"
              className="min-h-9 w-full resize-none content-center bg-transparent text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
              style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
            />
          }
          action={
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={isPending ? "Starting session…" : "Start session"}
            >
              {isPending ? (
                <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <ArrowUp size={13} strokeWidth={2} />
              )}
            </button>
          }
        />
      </form>

      {pills.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {pills.map((pill) => (
            <button
              key={pill}
              type="button"
              disabled={isPending}
              onClick={() => onPillSelect(pill)}
              className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-[13px] tracking-[-0.005em] text-ink-subtle shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-colors duration-150 hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pill}
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onBack}
        disabled={isPending}
        className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
      >
        <ArrowLeft size={12} strokeWidth={2} />
        <span>Back</span>
      </button>
    </>
  );
}
