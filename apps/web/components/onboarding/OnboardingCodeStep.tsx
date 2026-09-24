"use client";

import type { OnboardingRepositoryScan } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { cn } from "@opencompany/ui/lib/utils";
import { Loader2, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PluginConnections, PluginRow } from "@/components/onboarding/plugin-connections";
import { OFFICIAL_MCP_PLUGINS, type OfficialMcpPluginConfig } from "@/lib/official-plugin-catalog";
import { scanOnboardingRepositoryAction } from "@/lib/onboarding-actions";

const GITHUB = OFFICIAL_MCP_PLUGINS.github;
// Every technical founder's team works somewhere; these are suggested whatever the repo says.
const TEAM_PLUGINS: OfficialMcpPluginConfig[] = [
  OFFICIAL_MCP_PLUGINS.linear,
  OFFICIAL_MCP_PLUGINS.slack,
  OFFICIAL_MCP_PLUGINS.gmail,
];

type ScanState =
  | { status: "checking" }
  | { status: "scanning"; repository: string | null }
  | { status: "failed"; error: string }
  | OnboardingRepositoryScan;

// The technical founder's plugins step: connect GitHub, read the most active repository's setup
// files, and suggest the plugins it points at alongside the team tools.
export function OnboardingCodeStep({
  workspaceName,
  plugins,
  onRepositoryChange,
}: {
  workspaceName: string;
  plugins: PluginConnections;
  onRepositoryChange: (repository: string | null) => void;
}) {
  const [scan, setScan] = useState<ScanState>({ status: "checking" });
  const githubConnected = plugins.connected.has(GITHUB.connectionProvider);
  const { markConnected } = plugins;
  const requestRef = useRef(0);

  // State changes only after the request resolves, so the effects below can start a scan
  // without rendering synchronously; `rescan` is for event handlers and shows progress first.
  const loadScan = useCallback(
    (repository: string | null) => {
      const request = ++requestRef.current;
      return scanOnboardingRepositoryAction(repository ? { repository } : {}).then((result) => {
        if (request !== requestRef.current) return;
        if (!result.ok) {
          setScan({ status: "failed", error: result.error });
          return;
        }
        setScan(result.scan);
        if (result.scan.status !== "not_connected") markConnected(GITHUB.connectionProvider);
        onRepositoryChange(
          result.scan.status === "scanned" ? result.scan.repository.fullName : null,
        );
      });
    },
    [markConnected, onRepositoryChange],
  );
  const rescan = (repository: string | null) => {
    setScan({ status: "scanning", repository });
    void loadScan(repository);
  };

  // The first call doubles as the connection check: a founder who already connected GitHub goes
  // straight to their results, everyone else sees the connect card.
  useEffect(() => {
    void loadScan(null);
  }, [loadScan]);

  // GitHub finished connecting in the popup: read the repository now.
  const awaitingScan = githubConnected && scan.status === "not_connected";
  useEffect(() => {
    if (awaitingScan) void loadScan(null);
  }, [awaitingScan, loadScan]);

  const row = (config: OfficialMcpPluginConfig, detail?: string) => (
    <PluginRow
      key={config.name}
      config={config}
      {...(detail ? { detail } : {})}
      installed={plugins.installed.has(config.name)}
      connected={plugins.connected.has(config.connectionProvider)}
      connecting={plugins.connecting === config.name}
      disabled={plugins.disabled}
      onConnect={plugins.requestConnect}
    />
  );
  const teamSection = (
    <Section label="For your team">{TEAM_PLUGINS.map((config) => row(config))}</Section>
  );

  if (scan.status === "checking") {
    return (
      <div aria-busy="true" className="flex min-h-[220px] items-center justify-center">
        <Loader2 className="size-5 animate-spin text-ink-subtle" />
      </div>
    );
  }

  if (scan.status === "not_connected") {
    return (
      <div>
        <Header
          title="Connect your code"
          subtitle="We'll read your repo's setup files and suggest the tools your agent should work with. Nothing in your code changes."
        />
        <div className="flex flex-col items-start gap-3.5 rounded-xl border border-border bg-surface p-5">
          <span
            className={cn(
              "flex size-10 items-center justify-center rounded-lg border border-border/70",
              GITHUB.iconClassName,
            )}
          >
            <GITHUB.Icon className="size-5" />
          </span>
          <div>
            <div className="text-[14px] font-medium text-ink">GitHub</div>
            <p className="mt-0.5 text-[12.5px] leading-5 text-ink-subtle">
              Your agent reads repos, opens pull requests, and reviews them.
            </p>
          </div>
          <Button
            onClick={() => plugins.requestConnect(GITHUB)}
            disabled={plugins.disabled}
            aria-busy={plugins.connecting === GITHUB.name}
            className="gap-1.5 rounded-full px-5 text-[13px] font-semibold"
          >
            {plugins.connecting === GITHUB.name ? <Loader2 className="animate-spin" /> : null}
            Connect GitHub
          </Button>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
          <Lock size={13} strokeWidth={2} />
          Setup only reads package and config files. You choose which repos GitHub shares.
        </p>
      </div>
    );
  }

  if (scan.status === "scanning" || awaitingScan) {
    const reading = scan.status === "scanning" ? scan.repository : null;
    return (
      <div>
        <Header
          title={reading ? `Reading ${reading}` : "Reading your code"}
          subtitle={`Finding what ${workspaceName || "your company"} runs on. This takes a few seconds.`}
        />
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
          <Loader2 className="size-4 animate-spin text-ink-subtle" />
          <span className="text-[13px] text-ink-muted">
            Reading package manifests and config files…
          </span>
        </div>
      </div>
    );
  }

  if (scan.status === "failed") {
    return (
      <div>
        <Header
          title="Your tools"
          subtitle="We couldn't read your repo just now. You can try again, or connect your tools directly."
        />
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
          <span className="text-[12.5px] text-ink-muted">{scan.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => rescan(null)}
            className="h-8 rounded-full px-3 text-[12px] shadow-none"
          >
            Try again
          </Button>
        </div>
        {teamSection}
      </div>
    );
  }

  if (scan.status === "no_repositories") {
    return (
      <div>
        <Header
          title="Your tools"
          subtitle="GitHub is connected, but it didn't share any repositories with us yet. Connect your team's tools now; plugins for your stack can come later."
        />
        <Section label="Connected">{row(GITHUB)}</Section>
        {teamSection}
      </div>
    );
  }

  const found: { config: OfficialMcpPluginConfig; reason: string }[] = scan.plugins.flatMap(
    ({ plugin, reason }: { plugin: string; reason: string }) => {
      const config = (OFFICIAL_MCP_PLUGINS as Record<string, OfficialMcpPluginConfig | undefined>)[
        plugin
      ];
      return config ? [{ config, reason }] : [];
    },
  );
  return (
    <div>
      <Header
        title={`Here's what ${workspaceName || "your company"} runs on`}
        subtitle="We picked the tools your agent should reach from your repo's setup files. Connect what you want now; the rest can wait."
      />
      <RepositoryPicker
        repository={scan.repository.fullName}
        repositories={scan.repositories}
        onChange={rescan}
      />
      <Section label="Found in your code">
        {row(GITHUB, scan.repository.fullName)}
        {found.map(({ config, reason }) => row(config, reason))}
        {found.length === 0 ? (
          <p className="px-1 text-[12px] text-ink-subtle">
            Nothing else stood out in its setup files.
          </p>
        ) : null}
      </Section>
      {teamSection}
    </div>
  );
}

function RepositoryPicker({
  repository,
  repositories,
  onChange,
}: {
  repository: string;
  repositories: string[];
  onChange: (repository: string) => void;
}) {
  if (repositories.length < 2) return null;
  return (
    <div className="-mt-3 mb-6 flex items-center gap-2 text-[12.5px] text-ink-muted">
      <span>Repository</span>
      <Select
        value={repository}
        onValueChange={(value) => {
          if (typeof value === "string" && value !== repository) onChange(value);
        }}
      >
        <SelectTrigger
          aria-label="Repository to read"
          className="h-7 w-auto min-w-[180px] border-border bg-surface px-2.5 font-mono text-[12px] text-ink shadow-none"
        >
          <SelectValue>{repository}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {repositories.map((candidate) => (
            <SelectItem key={candidate} value={candidate} className="font-mono text-[12px]">
              {candidate}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-7 flex flex-col gap-2">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
      <p className="text-[14px] leading-6 text-ink-muted">{subtitle}</p>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 [&+&]:mt-6">
      <p className="text-[12px] font-medium text-ink">{label}</p>
      {children}
    </section>
  );
}
