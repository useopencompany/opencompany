"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { GoatBrainSummaryView, GoatWorkspaceView } from "@/components/GoatAppDataProvider";
import { VisibilityOption } from "@/components/GoatBrainSwitcher";
import { useHydrated } from "@/components/useHydrated";
import {
  type GoatBrainSourcesDetails,
  getGoatBrainSourcesAction,
  setGoatBrainSourceEnabledAction,
} from "@/lib/brain-source-actions";
import {
  GOAT_BRAIN_SOURCE_PROVIDERS,
  type GoatBrainSourceProviderDef,
} from "@/lib/brain-sources/registry";
import {
  type GoatWorkspaceMemberView,
  getGoatBrainAccessDetailsAction,
  setGoatBrainAccessAction,
} from "@/lib/workspace-actions";

export function GoatBrainSettings({
  brain,
  workspace,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
}) {
  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink">
          <Brain size={21} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
            {brain.name}
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">Brain settings</p>
        </div>
      </header>

      <SettingsSection title="Access">
        <BrainAccessSection brain={brain} workspace={workspace} />
      </SettingsSection>

      <SettingsSection title="Claude connector">
        <ClaudeConnectorBlock brainId={brain.id} />
      </SettingsSection>

      <SettingsSection title="Sources">
        <BrainSourcesSection brainId={brain.id} />
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BrainAccessSection({
  brain,
  workspace,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
}) {
  const [visibility, setVisibility] = useState<"workspace" | "restricted">(brain.visibility);
  const [members, setMembers] = useState<GoatWorkspaceMemberView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainAccessDetailsAction(brain.id).then((details) => {
      if (cancelled || !details) return;
      setVisibility(details.visibility);
      setMembers(details.workspaceMembers);
      setSelected(new Set(details.memberWorkosIds));
    });
    return () => {
      cancelled = true;
    };
  }, [brain.id]);

  const toggleMember = (userWorkosId: string) => {
    setDirty(true);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userWorkosId)) {
        next.delete(userWorkosId);
      } else {
        next.add(userWorkosId);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainAccessAction({
        brainId: brain.id,
        visibility,
        memberWorkosIds: [...selected],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Brain access updated.");
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <VisibilityOption
          checked={visibility === "workspace"}
          onSelect={() => {
            setVisibility("workspace");
            setDirty(true);
          }}
          title={`Everyone in ${workspace.name}`}
          description="All current and future members can view and edit."
        />
        <VisibilityOption
          checked={visibility === "restricted"}
          onSelect={() => {
            setVisibility("restricted");
            setDirty(true);
          }}
          title="Only specific members"
          description="Pick who can view and edit this brain."
        />
      </div>
      {visibility === "restricted" ? (
        <div className="flex max-h-[240px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
          {members === null ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-subtle">Loading members…</div>
          ) : (
            members.map((member) => (
              <label
                key={member.userWorkosId}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.has(member.userWorkosId)}
                  onChange={() => toggleMember(member.userWorkosId)}
                  className="accent-ink"
                />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <span className="shrink-0 text-[11px] text-ink-subtle">{member.role}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save access"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ClaudeConnectorBlock({ brainId }: { brainId: string }) {
  const [copied, setCopied] = useState(false);
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin.replace(/\/+$/, "") : "";
  const connectorPath = `/api/mcp/${encodeURIComponent(brainId)}/mcp`;
  const connectorUrl = origin ? `${origin}${connectorPath}` : connectorPath;

  const copyConnectorUrl = async () => {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Could not copy connector URL.");
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-ink">Connect to Claude</span>
          <code className="block truncate text-[12px] leading-5 text-ink-subtle">
            {connectorUrl}
          </code>
        </div>
        <button
          type="button"
          onClick={copyConnectorUrl}
          disabled={!origin}
          aria-label="Copy Claude connector URL"
          title="Copy Claude connector URL"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={2} />}
        </button>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Claude -&gt; Settings -&gt; Connectors -&gt; Add custom connector, then sign in with your
        Goat account.
      </p>
    </div>
  );
}

function BrainSourcesSection({ brainId }: { brainId: string }) {
  const [details, setDetails] = useState<GoatBrainSourcesDetails | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const next = await getGoatBrainSourcesAction(brainId);
    setDetails(next);
    setLoaded(true);
  }, [brainId]);

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainSourcesAction(brainId).then((next) => {
      if (cancelled) return;
      setDetails(next);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [brainId]);

  if (!loaded) {
    return <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading sources…</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-[12px] leading-5 text-ink-subtle">
        Connected sources feed new content into this brain automatically.
      </p>
      {GOAT_BRAIN_SOURCE_PROVIDERS.map((provider) => (
        <SourceProviderCard
          key={provider.id}
          brainId={brainId}
          provider={provider}
          details={details}
          onChanged={reload}
        />
      ))}
    </div>
  );
}

function SourceProviderCard({
  brainId,
  provider,
  details,
  onChanged,
}: {
  brainId: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onChanged: () => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const Icon = provider.icon;
  const source = details?.sources.find((entry) => entry.provider === provider.id) ?? null;

  const jamie = provider.id === "jamie" ? details?.jamie : undefined;
  const connected = provider.id === "jamie" ? Boolean(jamie?.integration.connected) : false;
  // Before any per-brain rows exist, Jamie deliveries follow legacy routing to
  // the user's default brain — surface that as an implicit "on" there.
  const legacyEnabled = Boolean(
    provider.id === "jamie" && !source && jamie?.legacyDefaultDelivery && jamie?.isDefaultBrain,
  );
  const enabled = source ? source.enabled : legacyEnabled;
  const canToggle =
    provider.available && (source ? source.isOwnIntegration : connected) && !isPending;

  const toggle = () => {
    const integrationId = source?.integrationId ?? jamie?.integration.integrationId;
    if (!integrationId) return;
    startTransition(async () => {
      const result = await setGoatBrainSourceEnabledAction({
        brainId,
        provider: provider.id,
        integrationId,
        enabled: !enabled,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onChanged();
    });
  };

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5 ${
        provider.available ? "" : "opacity-55"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
          <Icon size={15} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{provider.name}</span>
            {!provider.available ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                Coming soon
              </span>
            ) : null}
            {source && source.integrationStatus !== "connected" ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                {source.integrationStatus === "needs_reauth" ? "Needs setup" : "Sync issue"}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[11.5px] leading-4 text-ink-subtle">{provider.description}</p>
        </div>
        {provider.available ? (
          connected || source ? (
            <SourceToggle enabled={enabled} disabled={!canToggle} onToggle={toggle} />
          ) : (
            <a
              href={provider.connectHref}
              className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              Connect
            </a>
          )
        ) : null}
      </div>
      {source && !source.isOwnIntegration ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Connected by {source.connectedByName}. Only they can change this source.
        </p>
      ) : null}
      {legacyEnabled ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Delivering here as your default brain. Toggling any brain makes routing explicit.
        </p>
      ) : null}
    </div>
  );
}

function SourceToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? "bg-ink" : "bg-ink/15"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left] duration-150 ${
          enabled ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
