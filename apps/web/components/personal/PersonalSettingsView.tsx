"use client";

import { LogOut, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { useState, useTransition } from "react";
import { type BillingData, BillingPanel } from "@/components/billing/BillingPanel";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { ResetPersonalAgentDialog } from "@/components/personal/ResetPersonalAgentDialog";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/ToastProvider";
import { Toggle } from "@/components/ui/toggle";
import { resetPersonalAgent } from "@/lib/personal/actions";
import {
  setCompanySurfaceEnabled as setCompanySurfaceEnabledAction,
  setProMode as setProModeAction,
  setUserTimezone as setUserTimezoneAction,
} from "@/lib/users/actions";

// Lightweight settings for the /personal surface: the Pro mode toggle (DB-backed), appearance,
// read-only account info, and billing. Deliberately minimal — the full workspace settings live at
// /settings. Billing is workspace-scoped and loaded by the route, then passed in here.
export default function PersonalSettingsView({ billing }: { billing: BillingData }) {
  const {
    userName,
    userEmail,
    proMode,
    setProMode,
    companySurfaceEnabled,
    setCompanySurfaceEnabled,
    userTimezone,
    setUserTimezone,
    setConfig,
  } = usePersonalAgent();
  const { showError } = useToast();
  const [isPending, startTransition] = useTransition();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [timezoneDraft, setTimezoneDraft] = useState(userTimezone);
  // Tracked outside useTransition: the pending state must survive until the full-page
  // navigation below lands, not just until the server action resolves.
  const [isResetting, setIsResetting] = useState(false);

  function onConfirmReset() {
    setIsResetting(true);
    void (async () => {
      const result = await resetPersonalAgent();
      if (!result.ok) {
        setIsResetting(false);
        showError(result.error, "Could not reset your agent");
        return;
      }
      // Full navigation (not a client-side transition) so the /personal layout re-runs
      // ensurePersonalAgent — re-scaffolding the default agent — with no stale client state.
      window.location.assign("/personal");
    })();
  }

  function onToggleProMode(next: boolean) {
    // Flip optimistically so the sidebar's Memory row appears/disappears immediately, then persist.
    setProMode(next);
    startTransition(async () => {
      const result = await setProModeAction(next);
      if (!result.ok) {
        setProMode(!next);
        showError(result.error, "Could not update Pro mode");
      }
    });
  }

  function onToggleCompanySurface(next: boolean) {
    // Flip optimistically so the sidebar's space switcher appears/disappears immediately, then persist.
    setCompanySurfaceEnabled(next);
    startTransition(async () => {
      const result = await setCompanySurfaceEnabledAction(next);
      if (!result.ok) {
        setCompanySurfaceEnabled(!next);
        showError(result.error, "Could not update company access");
      }
    });
  }

  function onSaveTimezone(nextValue = timezoneDraft) {
    const next = nextValue.trim();
    if (!next) {
      showError("Timezone is required.", "Could not update timezone");
      return;
    }

    const previous = userTimezone;
    setUserTimezone(next);
    setTimezoneDraft(next);
    startTransition(async () => {
      const result = await setUserTimezoneAction(next);
      if (!result.ok) {
        setUserTimezone(previous);
        setTimezoneDraft(previous);
        showError(result.error, "Could not update timezone");
        return;
      }
      setUserTimezone(result.timezone);
      setTimezoneDraft(result.timezone);
      if (result.config) setConfig(result.config);
    });
  }

  function onUseBrowserTimezone() {
    const next = browserTimezone();
    if (!next) {
      showError("Could not detect your browser timezone.", "Could not update timezone");
      return;
    }
    onSaveTimezone(next);
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-5 pb-16 pt-10 md:px-8">
      <header className="pb-7">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-ink-muted">Personal preferences for your agent.</p>
      </header>

      <Section
        title="Pro mode"
        description="Unlock advanced surfaces, including the read-only agent Memory inspector in the sidebar."
      >
        <div className="flex items-center gap-3">
          <Toggle
            pressed={proMode}
            disabled={isPending}
            aria-label={`${proMode ? "Disable" : "Enable"} Pro mode`}
            onPressedChange={onToggleProMode}
          >
            {proMode ? "On" : "Off"}
          </Toggle>
          <span className="text-[12.5px] text-ink-muted">
            {proMode ? "Advanced surfaces are visible." : "Advanced surfaces are hidden."}
          </span>
        </div>
      </Section>

      <Section
        title="Company workspace"
        description="Bring back the legacy company workspace surface, switchable from the sidebar."
      >
        <div className="flex items-center gap-3">
          <Toggle
            pressed={companySurfaceEnabled}
            disabled={isPending}
            aria-label={`${companySurfaceEnabled ? "Disable" : "Enable"} company workspace access`}
            onPressedChange={onToggleCompanySurface}
          >
            {companySurfaceEnabled ? "On" : "Off"}
          </Toggle>
          <span className="text-[12.5px] text-ink-muted">
            {companySurfaceEnabled
              ? "The company workspace is available from the sidebar."
              : "The company workspace is hidden."}
          </span>
        </div>
      </Section>

      <Section title="Appearance" description="Choose how the interface looks.">
        <Field label="Theme">
          <AppearanceSection />
        </Field>
      </Section>

      <Section title="Routines" description="Choose the timezone used by scheduled routines.">
        <Field label="Timezone">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              aria-label="Timezone"
              value={timezoneDraft}
              onChange={(event) => setTimezoneDraft(event.target.value)}
              onBlur={() => {
                if (timezoneDraft.trim() !== userTimezone) onSaveTimezone();
              }}
              disabled={isPending}
              className="h-8 w-full max-w-[260px] rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink outline-none transition-colors duration-150 focus:border-ink/25 focus:ring-1 focus:ring-ink/15 disabled:cursor-not-allowed disabled:opacity-65"
            />
            <button
              type="button"
              onClick={onUseBrowserTimezone}
              disabled={isPending}
              className="inline-flex h-8 w-fit items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-65"
            >
              Use browser timezone
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Account" description="Your profile details.">
        <Field label="Name">
          <ReadOnly value={userName} />
        </Field>
        <Field label="Email">
          <ReadOnly value={userEmail} />
        </Field>
        <a
          href="/auth/sign-out"
          className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <LogOut size={13} strokeWidth={1.9} />
          Log out
        </a>
      </Section>

      <Section title="Billing" description="Your credit balance, usage, and top-ups.">
        <BillingPanel billing={billing} sessionPathPrefix="/personal" />
      </Section>

      <Section
        title="Reset personal agent"
        description="Start over with a fresh agent on the default setup."
      >
        <p className="text-[12.5px] leading-5 text-ink-muted">
          Permanently deletes your agent&apos;s behavior, files, memory, sessions, connected
          channels, and inbox, then recreates the default agent. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={() => setResetDialogOpen(true)}
          disabled={isResetting}
          className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12.5px] font-medium text-danger transition-colors duration-150 hover:bg-danger-bg focus:outline-none focus-visible:ring-1 focus-visible:ring-danger/30 disabled:cursor-not-allowed disabled:opacity-65"
        >
          <RotateCcw size={13} strokeWidth={1.9} />
          Reset personal agent
        </button>
      </Section>

      <ResetPersonalAgentDialog
        isOpen={resetDialogOpen}
        isPending={isResetting}
        onClose={() => setResetDialogOpen(false)}
        onConfirm={onConfirmReset}
      />
    </div>
  );
}

function browserTimezone() {
  if (typeof window === "undefined") return null;
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border-subtle py-7 first:border-t-0 first:pt-0">
      {/* Stack label over control on mobile; the fixed 200px label column only kicks in at md,
          otherwise the content column collapses and overflows the viewport (clipping both edges). */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr] md:gap-8">
        <div>
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {description && (
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ReadOnly({ value }: { value: string }) {
  return (
    <div className="w-full md:w-fit md:min-w-[220px] rounded-md border border-border bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

const themeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      role="radiogroup"
      aria-label="Theme"
    >
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
