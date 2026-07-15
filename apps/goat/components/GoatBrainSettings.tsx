"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, PlugZap } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { GoatBrainSummaryView, GoatWorkspaceView } from "@/components/GoatAppDataProvider";
import { GoatBrainImport } from "@/components/GoatBrainImport";
import { GoatBrainOverviewFlow } from "@/components/GoatBrainOverviewFlow";
import { BrainSourcesSection } from "@/components/GoatBrainSourceCards";
import { VisibilityOption } from "@/components/GoatBrainSwitcher";
import {
  type GoatWorkspaceMemberView,
  getGoatBrainAccessDetailsAction,
  getGoatBrainEnrichmentEnabledAction,
  getGoatBrainIntelligenceAction,
  setGoatBrainAccessAction,
  setGoatBrainEnrichmentAction,
  setGoatBrainIntelligenceAction,
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

          <SettingsSection title="Intelligence">
            <IntelligenceSection brainRef={brain.id} />
          </SettingsSection>

          <SettingsSection title="Enrichment">
            <EnrichmentSection brainRef={brain.id} />
          </SettingsSection>

          <SettingsSection title="AI clients">
            <McpSetupLink />
          </SettingsSection>

          <SettingsSection title="Sources">
            <BrainSourcesSection brainRef={brain.id} />
          </SettingsSection>

          <SettingsSection title="Company context">
            <GoatBrainImport brainRef={brain.id} compact />
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

function IntelligenceSection({ brainRef }: { brainRef: string }) {
  const [state, setState] = useState<{
    brainRef: string;
    intelligence: "basic" | "frontier" | null;
  }>(() => ({ brainRef, intelligence: null }));
  const [isPending, startTransition] = useTransition();
  const intelligence = state.brainRef === brainRef ? state.intelligence : null;

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainIntelligenceAction(brainRef)
      .then((details) => {
        if (cancelled) return;
        if (!details) {
          setState({ brainRef, intelligence: "basic" });
          toast.error("Could not load the intelligence setting.");
          return;
        }
        setState({ brainRef, intelligence: details.intelligence });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ brainRef, intelligence: "basic" });
        toast.error("Could not load the intelligence setting.");
      });
    return () => {
      cancelled = true;
    };
  }, [brainRef]);

  const select = (next: "basic" | "frontier") => {
    if (intelligence === null || intelligence === next) return;
    const previous = intelligence;
    setState({ brainRef, intelligence: next });
    startTransition(async () => {
      const result = await setGoatBrainIntelligenceAction({ brainRef, intelligence: next });
      if (!result.ok) {
        setState((current) =>
          current.brainRef === brainRef ? { brainRef, intelligence: previous } : current,
        );
        toast.error(result.error);
        return;
      }
      toast.success(
        next === "frontier" ? "Frontier intelligence enabled." : "Basic intelligence enabled.",
      );
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-ink/10 p-3">
        <input
          type="radio"
          name={`goat-brain-intelligence-${brainRef}`}
          checked={intelligence === "basic"}
          disabled={intelligence === null || isPending}
          onChange={() => select("basic")}
          className="mt-0.5 accent-ink"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-ink">Basic intelligence</span>
          <span className="text-[12px] leading-5 text-ink-subtle">
            Ingestion runs on an open-source model, included in your plan&apos;s monthly allowance
            at no extra cost.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-ink/10 p-3">
        <input
          type="radio"
          name={`goat-brain-intelligence-${brainRef}`}
          checked={intelligence === "frontier"}
          disabled={intelligence === null || isPending}
          onChange={() => select("frontier")}
          className="mt-0.5 accent-ink"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-ink">Frontier intelligence</span>
          <span className="text-[12px] leading-5 text-ink-subtle">
            Ingestion for this brain runs on Claude Sonnet for higher-quality extraction. The model
            cost of each ingestion is billed to your workspace credits.
          </span>
        </span>
      </label>
    </div>
  );
}

function EnrichmentSection({ brainRef }: { brainRef: string }) {
  const [enrichmentState, setEnrichmentState] = useState<{
    brainRef: string;
    enabled: boolean | null;
  }>(() => ({ brainRef, enabled: null }));
  const [isPending, startTransition] = useTransition();
  const enabled = enrichmentState.brainRef === brainRef ? enrichmentState.enabled : null;

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainEnrichmentEnabledAction(brainRef)
      .then((details) => {
        if (cancelled) return;
        if (!details) {
          setEnrichmentState({ brainRef, enabled: false });
          toast.error("Could not load enrichment setting.");
          return;
        }
        setEnrichmentState({ brainRef, enabled: details.enabled });
      })
      .catch(() => {
        if (cancelled) return;
        setEnrichmentState({ brainRef, enabled: false });
        toast.error("Could not load enrichment setting.");
      });
    return () => {
      cancelled = true;
    };
  }, [brainRef]);

  const toggle = () => {
    if (enabled === null) return;
    const next = !enabled;
    setEnrichmentState({ brainRef, enabled: next });
    startTransition(async () => {
      const result = await setGoatBrainEnrichmentAction({
        brainRef,
        enabled: next,
      });
      if (!result.ok) {
        setEnrichmentState((current) =>
          current.brainRef === brainRef ? { brainRef, enabled: !next } : current,
        );
        toast.error(result.error);
        return;
      }
      toast.success(next ? "Enrichment enabled." : "Enrichment disabled.");
    });
  };

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-ink/10 p-3">
      <input
        type="checkbox"
        checked={enabled === true}
        disabled={enabled === null || isPending}
        onChange={toggle}
        className="mt-0.5 accent-ink"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-ink">Web-search enrichment</span>
        <span className="text-[12px] leading-5 text-ink-subtle">
          Let the ingestion agent use web search to enrich people, companies, and projects with
          confidently-identified public info. Facts are cited to their source URLs; ambiguous
          matches are skipped.
        </span>
      </span>
    </label>
  );
}

function McpSetupLink() {
  return (
    <Link
      href="/settings/mcp"
      className="flex items-center gap-3 rounded-md border border-ink/10 p-3 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <PlugZap size={16} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
      <div className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">Connect Goat</span>
        <span className="block text-[12px] leading-5 text-ink-subtle">
          Set up Claude, ChatGPT, or Cursor and verify your first Brain query. One connector covers
          every brain you can access.
        </span>
      </div>
    </Link>
  );
}
