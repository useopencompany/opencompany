"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import { CheckCircle2, Globe2, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  cancelBrainImportAction,
  confirmBrainImportAction,
  retryBrainImportDiscoveryAction,
  startBrainImportDiscoveryAction,
} from "@/lib/brain-import-actions";
import { getBrainSourcesAction, listGitHubRepositoriesAction } from "@/lib/brain-source-actions";
import {
  getHeadlessBrainCollections,
  type HeadlessBrainImportRunReadModel,
} from "@/lib/headless-knowledge-collections";

const PROVIDERS = [
  ["public_web", "Public web"],
  ["github", "GitHub"],
  ["jamie", "Jamie"],
  ["granola", "Granola"],
  ["fathom", "Fathom"],
  ["gmail", "Gmail"],
  ["linear", "Linear"],
] as const;

export function BrainImport({
  brainRef,
  compact = false,
}: {
  brainRef: string;
  compact?: boolean;
}) {
  const brainCollections = useMemo(() => getHeadlessBrainCollections(brainRef), [brainRef]);
  const { data } = useLiveQuery(
    (q) => q.from({ run: brainCollections.importRuns }),
    [brainCollections],
  );
  const run =
    ((data ?? []) as HeadlessBrainImportRunReadModel[]).toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0] ?? null;
  const [website, setWebsite] = useState("");
  const [focus, setFocus] = useState("");
  const [disclosed, setDisclosed] = useState(false);
  const [selection, setSelection] = useState<
    Record<
      string,
      {
        enabled: boolean;
        integrationId?: string;
        config?: Record<string, unknown>;
      }
    >
  >({ public_web: { enabled: true } });
  const [confirmationOverrides, setConfirmationOverrides] = useState<Record<string, boolean>>({});
  const [startAnother, setStartAnother] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let canceled = false;
    void getBrainSourcesAction(brainRef).then(async (details) => {
      if (canceled || !details) return;
      const next: typeof selection = { public_web: { enabled: true } };
      for (const provider of PROVIDERS.slice(1)) {
        const id = provider[0];
        const source = details.sources.find((entry) => entry.provider === id);
        const integration = integrationFor(details, id);
        const integrationId = source?.integrationId ?? integration?.integrationId;
        if (!integrationId) continue;
        next[id] = {
          enabled: id === "github" || id === "jamie",
          integrationId,
          config: source?.config ?? {},
        };
      }
      const github = next.github;
      const existingRepos = Array.isArray(github?.config?.repos) ? github.config.repos : [];
      if (github?.integrationId && existingRepos.length === 0) {
        const repositories = await listGitHubRepositoriesAction(github.integrationId);
        if (repositories.ok) {
          github.config = {
            ...github.config,
            repos: repositories.repos.slice(0, 5).map((repo) => ({
              id: repo.id,
              fullName: repo.fullName,
            })),
            events: [
              "pull_request_opened",
              "pull_request_merged",
              "pull_request_commented",
              "issue_opened",
              "issue_commented",
            ],
          };
        }
      }
      if (next.gmail) {
        const existingEvents = Array.isArray(next.gmail.config?.events)
          ? next.gmail.config.events
          : [];
        if (existingEvents.length === 0) {
          next.gmail.config = {
            ...next.gmail.config,
            events: [{ id: "email_received" }, { id: "email_sent" }],
          };
        }
      }
      if (canceled) return;
      setSelection(next);
    });
    return () => {
      canceled = true;
    };
  }, [brainRef]);

  const enabledAtConfirm = useMemo(
    () =>
      new Set(
        Object.entries(run?.sourceSelection ?? {})
          .filter(([provider, value]) => confirmationOverrides[provider] ?? value.enabled)
          .map(([provider]) => provider),
      ),
    [confirmationOverrides, run?.sourceSelection],
  );

  const start = () =>
    startTransition(async () => {
      setConfirmationOverrides({});
      const result = await startBrainImportDiscoveryAction({
        brainRef,
        companyUrl: website.trim(),
        focus,
        sourceSelection: selection,
      });
      if (!result.ok) toast.error(result.message);
      else setStartAnother(false);
    });
  const cancel = () =>
    run &&
    startTransition(async () => {
      const result = await cancelBrainImportAction({
        brainRef,
        importRunId: run.id,
      });
      if (!result.ok) toast.error(result.message);
    });
  const confirm = () =>
    run &&
    startTransition(async () => {
      const result = await confirmBrainImportAction({
        brainRef,
        importRunId: run.id,
        enabledProviders: Array.from(enabledAtConfirm) as Array<
          "public_web" | "github" | "jamie" | "granola" | "fathom" | "gmail" | "linear"
        >,
      });
      if (!result.ok) toast.error(result.message);
    });

  const showConfiguration = !run || run.status === "canceled" || startAnother;
  if (showConfiguration) {
    return (
      <section
        className={`w-full rounded-xl border border-border bg-surface p-5 ${compact ? "max-w-[640px]" : "max-w-[680px]"}`}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
            <Globe2 size={18} />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold text-ink">
              {compact ? "Import company context" : "Give opencompany a head start"}
            </h2>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
              Scan first, review the exact workload, then decide whether to run ingestion.
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-3">
          <label className="grid gap-1 text-[12px] font-medium text-ink-muted">
            Company website
            <input
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="acme.com"
              className="h-9 rounded-md border border-border bg-canvas px-3 text-[13px] text-ink outline-none focus:border-border-strong"
            />
          </label>
          <label className="grid gap-1 text-[12px] font-medium text-ink-muted">
            What should opencompany focus on?{" "}
            <span className="font-normal text-ink-subtle">Optional</span>
            <textarea
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              rows={2}
              className="rounded-md border border-border bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-border-strong"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDERS.map(([id, label]) => {
              const available = id === "public_web" || Boolean(selection[id]?.integrationId);
              return (
                <label
                  key={id}
                  className={`flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12.5px] ${available ? "cursor-pointer text-ink" : "text-ink-subtle opacity-60"}`}
                >
                  <input
                    type="checkbox"
                    disabled={!available}
                    checked={Boolean(selection[id]?.enabled)}
                    onChange={(event) =>
                      setSelection((current) => ({
                        ...current,
                        [id]: { ...current[id], enabled: event.target.checked },
                      }))
                    }
                    className="accent-ink"
                  />
                  {label}
                  {!available ? <span className="ml-auto text-[10px]">Not connected</span> : null}
                </label>
              );
            })}
          </div>
          <label className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2.5 text-[11.5px] leading-4 text-ink-muted">
            <input
              type="checkbox"
              checked={disclosed}
              onChange={(event) => setDisclosed(event.target.checked)}
              className="mt-0.5 accent-ink"
            />
            <span>
              Imported private content becomes readable by everyone who has access to this brain.
            </span>
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={isPending || !website.trim() || !disclosed}
              onClick={start}
              className="rounded-md bg-ink px-3.5 py-2 text-[12.5px] font-medium text-canvas disabled:opacity-40"
            >
              {isPending ? "Starting scan…" : "Scan sources"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (run.status === "discovering")
    return (
      <StatusCard
        title="Scanning sources"
        detail="No ingestion models are running. opencompany is counting and ranking candidate entries."
        icon={<Loader2 className="animate-spin" size={18} />}
        action="Cancel"
        onAction={cancel}
        disabled={isPending}
      />
    );

  if (run.status === "awaiting_confirmation") {
    const planned =
      Object.entries(run.discoverySummary).reduce(
        (total, [provider, value]) =>
          total + (enabledAtConfirm.has(provider) ? value.plannedRuns : 0),
        0,
      ) + 1;
    return (
      <section className="w-full max-w-[680px] rounded-xl border border-border bg-surface p-5">
        <h2 className="text-[16px] font-semibold text-ink">Ready to build your brain</h2>
        <p className="mt-1 text-[12px] text-ink-subtle">
          Review the bounded workload before any LLM ingestion starts.
        </p>
        <div className="mt-4 divide-y divide-border-subtle rounded-lg border border-border">
          {PROVIDERS.map(([id, label]) => {
            const value = run.discoverySummary[id];
            if (!value) return null;
            return (
              <label key={id} className="flex items-center gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={enabledAtConfirm.has(id)}
                  disabled={value.plannedRuns === 0}
                  onChange={() =>
                    setConfirmationOverrides((current) => ({
                      ...current,
                      [id]: !enabledAtConfirm.has(id),
                    }))
                  }
                  className="accent-ink"
                />
                <span className="w-24 text-[12.5px] font-medium text-ink">{label}</span>
                <span className="flex-1 text-[11.5px] text-ink-subtle">
                  {value.discoveredEntries} discovered · {value.eligibleEntries} eligible ·{" "}
                  {value.alreadyKnownEntries} known · {value.selectedEntries} selected ·{" "}
                  {value.plannedRuns} runs
                  {value.error ? (
                    <span className="mt-0.5 block text-danger">{value.error}</span>
                  ) : null}
                </span>
                {value.status === "failed" ? <XCircle size={15} className="text-danger" /> : null}
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={cancel}
            disabled={isPending}
            className="text-[12px] text-ink-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={isPending}
            className="rounded-md bg-ink px-4 py-2 text-[12.5px] font-medium text-canvas"
          >
            Build brain · {planned} ingestion runs
          </button>
        </div>
      </section>
    );
  }

  if (run.status === "failed" && run.confirmedAt)
    return (
      <StatusCard
        title="Import failed"
        detail={
          run.lastError ??
          "The import could not finish. Any successfully created documents remain in the brain."
        }
        icon={<XCircle size={18} className="text-danger" />}
      />
    );

  if (run.status === "failed")
    return (
      <StatusCard
        title="Import failed"
        detail={run.lastError ?? "The source scan could not be completed."}
        icon={<XCircle size={18} className="text-danger" />}
        action="Retry scan"
        onAction={() =>
          startTransition(async () => {
            const result = await retryBrainImportDiscoveryAction({
              brainRef,
              importRunId: run.id,
            });
            if (!result.ok) toast.error(result.message);
          })
        }
        disabled={isPending}
      />
    );

  if (run.status === "succeeded" || run.status === "partial")
    return (
      <StatusCard
        title={run.status === "succeeded" ? "Brain built" : "Brain built with some gaps"}
        detail={
          run.status === "succeeded"
            ? "The selected context is imported and organized. Connected sources will keep feeding this brain."
            : "Useful context was imported, but at least one source failed. Successful documents remain available."
        }
        icon={<CheckCircle2 size={18} className="text-emerald-600" />}
        action="Import more context"
        onAction={() => setStartAnother(true)}
      />
    );

  return (
    <StatusCard
      title={run.status === "finalizing" ? "Organizing your brain" : "Building your brain"}
      detail={
        run.status === "finalizing"
          ? "Source jobs are complete. opencompany is deduplicating and repairing links without adding new facts."
          : "Documents will appear here as each selected source finishes."
      }
      icon={<Loader2 className="animate-spin" size={18} />}
      action="Cancel"
      onAction={cancel}
      disabled={isPending}
    />
  );
}

function integrationFor(
  details: Awaited<ReturnType<typeof getBrainSourcesAction>>,
  provider: string,
) {
  if (!details) return null;
  switch (provider) {
    case "github":
      return details.github.integration;
    case "jamie":
      return details.jamie.integration;
    case "granola":
      return details.granola.integration;
    case "fathom":
      return details.fathom.integration;
    case "gmail":
      return details.gmail.integration;
    case "linear":
      return details.linear.integration;
    default:
      return null;
  }
}

function StatusCard({
  title,
  detail,
  icon,
  action,
  onAction,
  disabled,
}: {
  title: string;
  detail: string;
  icon: React.ReactNode;
  action?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <section className="w-full max-w-[680px] rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        {icon}
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-[12px] leading-5 text-ink-subtle">{detail}</p>
        </div>
        {action && onAction ? (
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className="text-[12px] text-ink-muted disabled:opacity-40"
          >
            {action}
          </button>
        ) : null}
      </div>
    </section>
  );
}
