"use client";

import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTransition } from "react";
import { type BillingData, BillingPanel } from "@/components/billing/BillingPanel";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/ToastProvider";
import { Toggle } from "@/components/ui/toggle";
import {
  setCompanySurfaceEnabled as setCompanySurfaceEnabledAction,
  setProMode as setProModeAction,
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
  } = usePersonalAgent();
  const { showError } = useToast();
  const [isPending, startTransition] = useTransition();

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

  return (
    <div className="mx-auto w-full max-w-[760px] px-8 pb-16 pt-10">
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
        <BillingPanel billing={billing} />
      </Section>
    </div>
  );
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
      <div className="grid grid-cols-[200px_1fr] gap-8">
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
    <div className="w-fit min-w-[220px] rounded-md border border-border bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink/85">
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
