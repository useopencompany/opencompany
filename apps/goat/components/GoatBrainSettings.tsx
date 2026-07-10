"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, Check, Copy } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import type { GoatBrainSummaryView, GoatWorkspaceView } from "@/components/GoatAppDataProvider";
import { GoatBrainOverviewFlow } from "@/components/GoatBrainOverviewFlow";
import { BrainSourcesSection } from "@/components/GoatBrainSourceCards";
import { VisibilityOption } from "@/components/GoatBrainSwitcher";
import { useHydrated } from "@/components/useHydrated";
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
  const [tab, setTab] = useState<"overview" | "settings">("overview");

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-surface-muted text-ink">
          <Brain size={21} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
            {brain.name}
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">Brain settings</p>
        </div>
      </header>

      <nav className="flex items-center gap-5 border-b border-ink/10" role="tablist">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
          Settings
        </TabButton>
      </nav>

      {tab === "overview" ? (
        <GoatBrainOverviewFlow
          brain={brain}
          workspace={workspace}
          onManageAccess={() => setTab("settings")}
        />
      ) : (
        <div className="flex w-full max-w-[640px] flex-col gap-8">
          <SettingsSection title="Access">
            <BrainAccessSection brain={brain} workspace={workspace} />
          </SettingsSection>

          <SettingsSection title="Claude connector">
            <ClaudeConnectorBlock brainRef={brain.id} />
          </SettingsSection>

          <SettingsSection title="Sources">
            <BrainSourcesSection brainRef={brain.id} />
          </SettingsSection>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 pb-2 text-[13px] font-medium transition-colors ${
        active ? "border-ink text-ink" : "border-transparent text-ink-subtle hover:text-ink"
      }`}
    >
      {children}
    </button>
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
        brainRef: brain.id,
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
          description="All current and future members can view."
        />
        <VisibilityOption
          checked={visibility === "restricted"}
          onSelect={() => {
            setVisibility("restricted");
            setDirty(true);
          }}
          title="Only specific members"
          description="Pick who can view this brain."
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

function ClaudeConnectorBlock({ brainRef }: { brainRef: string }) {
  const [copied, setCopied] = useState(false);
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin.replace(/\/+$/, "") : "";
  const connectorPath = `/api/mcp/${encodeURIComponent(brainRef)}/mcp`;
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
