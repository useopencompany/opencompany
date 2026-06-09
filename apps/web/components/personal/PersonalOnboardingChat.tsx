"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ArrowUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Composer } from "@/components/Composer";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { generateOnboardingPills } from "@/lib/onboarding/pills";
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

type Step = "identity" | "prompt";

// V2 onboarding (/onboarding/personal): two distraction-free screens, no sidebar/inbox chrome.
//
//  1. Identity — name, website, role. On continue we fire a fast model (server action) to draft
//     example pills tailored to who they are; the identity also rides invisibly into the first
//     message so the onboarding skill starts already knowing them.
//  2. Prompt — "What do you want to get done today?" with the tailored pills. Submitting (typing or
//     tapping a pill) seeds the task into an onboarding session and lands the user in /personal.
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

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdvancing, startAdvanceTransition] = useTransition();
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

  const advanceToPrompt = () => {
    if (isAdvancing) return;
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
    startAdvanceTransition(async () => {
      // Best-effort: the action always resolves with at least the fallback pills, so a model
      // failure never blocks moving to the next screen.
      const { pills: generated } = await generateOnboardingPills({
        name: name.trim(),
        website: website.trim(),
        role: role.trim(),
      });
      setPills(generated);
      setStep("prompt");
    });
  };

  const submit = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await createPersonalOnboardingSession(
        agentId,
        { name: name.trim(), website: website.trim(), role: role.trim() },
        content,
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
      setInput("");
      showToast({ title: "Personal agent reset", tone: "default" });
      // Re-run the server layout/page so ensurePersonalAgent provisions a fresh agent.
      router.refresh();
    });
  };

  return (
    <main className="relative flex h-screen w-screen flex-col items-center justify-center overflow-y-auto bg-canvas px-6 py-10">
      <div className="flex w-full max-w-[460px] flex-col gap-6">
        {step === "identity" ? (
          <IdentityStep
            name={name}
            website={website}
            role={role}
            onNameChange={setName}
            onWebsiteChange={setWebsite}
            onRoleChange={setRole}
            onContinue={advanceToPrompt}
            isAdvancing={isAdvancing}
            error={error}
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
              setStep("identity");
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
  isAdvancing: boolean;
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
  isAdvancing,
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
          disabled={isAdvancing || !canContinue}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-ink-muted disabled:opacity-60"
        >
          {isAdvancing ? (
            <>
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
              <span>Setting things up…</span>
            </>
          ) : (
            <>
              <span>Continue</span>
              <ArrowRight size={12} strokeWidth={2} />
            </>
          )}
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
