"use client";

import { Copy, KeyRound, LogOut, Monitor, Moon, RotateCcw, Sun, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { type BillingData, BillingPanel } from "@/components/billing/BillingPanel";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { ResetPersonalAgentDialog } from "@/components/personal/ResetPersonalAgentDialog";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/ToastProvider";
import { Toggle } from "@/components/ui/toggle";
import { resetPersonalAgent } from "@/lib/personal/actions";
import {
  createPersonalMcpTokenAction,
  revokePersonalMcpTokenAction,
} from "@/lib/personal/mcp-actions";
import type { PersonalMcpTokenSummary } from "@/lib/personal/mcp-tokens";
import {
  setCompanySurfaceEnabled as setCompanySurfaceEnabledAction,
  setProMode as setProModeAction,
} from "@/lib/users/actions";

// Lightweight settings for the /personal surface: the Pro mode toggle (DB-backed), appearance,
// read-only account info, MCP access, and billing. Billing is workspace-scoped and loaded by the
// route, then passed in here.
export default function PersonalSettingsView({
  billing,
  mcp,
}: {
  billing: BillingData;
  mcp: { endpointUrl: string; tokens: PersonalMcpTokenSummary[] };
}) {
  const {
    userName,
    userEmail,
    proMode,
    setProMode,
    companySurfaceEnabled,
    setCompanySurfaceEnabled,
  } = usePersonalAgent();
  const { showError, showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [mcpTokens, setMcpTokens] = useState(mcp.tokens);
  const [newMcpToken, setNewMcpToken] = useState<string | null>(null);
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

      <Section
        title="MCP access"
        description="Connect external AI clients to your read-only OpenCompany memory and Personal Brain."
      >
        <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
              <KeyRound size={15} strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                OpenCompany MCP endpoint
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink">
                  {mcp.endpointUrl}
                </code>
                <CopyButton value={mcp.endpointUrl} label="Copy endpoint" />
              </div>
              <p className="mt-2 text-[12px] leading-5 text-ink-muted">
                Use bearer-token auth. The server exposes search and read tools only.
              </p>

              {newMcpToken ? (
                <div className="mt-4 rounded-md border border-warning-border bg-warning-bg p-3">
                  <div className="text-[12px] font-medium text-warning">Copy this token now</div>
                  <div className="mt-2 flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-warning-border/70 bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink">
                      {newMcpToken}
                    </code>
                    <CopyButton value={newMcpToken} label="Copy token" />
                  </div>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    startTransition(async () => {
                      const result = await createPersonalMcpTokenAction("External MCP client");
                      if (!result.ok) {
                        showError(result.error, "Could not create MCP token");
                        return;
                      }
                      setNewMcpToken(result.token);
                      setMcpTokens((current) => [result.summary, ...current]);
                      showToast({ title: "MCP token created" });
                    });
                  }}
                  className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-65"
                >
                  <KeyRound size={13} strokeWidth={1.9} />
                  Create token
                </button>
              </div>

              <div className="mt-4 space-y-2">
                {mcpTokens.length > 0 ? (
                  mcpTokens.map((token) => (
                    <div
                      key={token.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-canvas px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] font-medium text-ink">
                          {token.label}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                          Created {formatDate(token.createdAt)}
                          {token.lastUsedAt ? ` · Last used ${formatDate(token.lastUsedAt)}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await revokePersonalMcpTokenAction(token.id);
                            if (!result.ok) {
                              showError(result.error, "Could not revoke MCP token");
                              return;
                            }
                            setMcpTokens((current) =>
                              current.filter((candidate) => candidate.id !== token.id),
                            );
                            showToast({ title: "MCP token revoked" });
                          });
                        }}
                        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-2.5 text-[12px] font-medium text-danger transition-colors duration-150 hover:bg-danger-bg focus:outline-none focus-visible:ring-1 focus-visible:ring-danger/30 disabled:cursor-not-allowed disabled:opacity-65"
                      >
                        <Trash2 size={12} strokeWidth={1.9} />
                        Revoke
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="text-[12.5px] leading-5 text-ink-muted">
                    No external MCP tokens yet.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
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

function CopyButton({ value, label }: { value: string; label: string }) {
  const { showToast, showError } = useToast();

  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          showToast({ title: "Copied" });
        } catch {
          showError("Your browser did not allow clipboard access.", "Copy failed");
        }
      }}
      className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface px-2.5 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <Copy size={13} strokeWidth={1.9} />
    </button>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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
