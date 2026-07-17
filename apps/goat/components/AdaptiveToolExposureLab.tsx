"use client";

import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  GitBranch,
  Hash,
  Layers3,
  Loader2,
  Mail,
  Play,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type {
  ActivatedIntegration,
  ActivationReason,
  AdaptiveExperimentResponse,
  AdaptiveExposureSnapshot,
  AdaptiveObservedCall,
} from "@/experiments/adaptive-tool-exposure/types";

type ModelOption = { id: string; label: string };

const EXAMPLE_QUERIES = [
  {
    label: "Email → Slack",
    query:
      "Find the latest email from Ada about launch readiness, then post a concise summary to Slack #launch.",
  },
  {
    label: "Linear + GitHub",
    query:
      "List open Linear issues for ENG and list open GitHub pull requests in opencompany/goat that might address them.",
  },
  {
    label: "Calendar",
    query:
      "Find a 30 minute opening with ada@example.com tomorrow afternoon and create a launch review meeting.",
  },
  {
    label: "Lossless recovery",
    query: "Add the eyes reaction to Slack message 1784282400.000100 in channel C_LAUNCH.",
  },
] as const;

const INTEGRATION_ICONS = {
  slack: Hash,
  gmail: Mail,
  linear: CircleDot,
  github: GitBranch,
  notion: FileText,
  calendar: CalendarDays,
} as const;

const SIDE_EFFECT_STYLES = {
  read: "border-border bg-surface-muted text-ink-muted",
  write:
    "border-[#d8d1b5] bg-[#fbf8eb] text-[#756319] dark:border-[#5f5632] dark:bg-[#292616] dark:text-[#d8c77e]",
  destructive: "border-danger-border bg-danger-bg text-danger",
  external_communication:
    "border-[#c5d6e8] bg-[#f2f7fc] text-[#315f88] dark:border-[#344f66] dark:bg-[#17232d] dark:text-[#9ac4e7]",
} as const;

export function AdaptiveToolExposureLab({
  initialQuery,
  initialSnapshot,
  modelOptions,
}: {
  initialQuery: string;
  initialSnapshot: AdaptiveExposureSnapshot;
  modelOptions: ModelOption[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const [model, setModel] = useState(modelOptions[0]?.id ?? "anthropic/claude-sonnet-5");
  const [result, setResult] = useState<AdaptiveExperimentResponse>({
    mode: "analyze",
    snapshot: initialSnapshot,
  });
  const [pendingMode, setPendingMode] = useState<"analyze" | "agent" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(mode: "analyze" | "agent") {
    const trimmed = query.trim();
    if (!trimmed || pendingMode) return;
    setPendingMode(mode);
    setError(null);
    try {
      const response = await fetch("/api/experiments/adaptive-tool-exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, mode, model }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : "The experiment request failed.";
        throw new Error(message);
      }
      setResult(body as AdaptiveExperimentResponse);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "The experiment request failed.",
      );
    } finally {
      setPendingMode(null);
    }
  }

  function chooseExample(example: (typeof EXAMPLE_QUERIES)[number]) {
    setQuery(example.query);
    setError(null);
  }

  const snapshot = result.snapshot;
  const run = result.run;

  return (
    <main className="h-full min-h-0 w-full overflow-y-auto bg-canvas text-ink">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 pb-20 pt-8 sm:px-6 md:px-8 lg:px-10">
        <header className="flex flex-col gap-3 border-b border-border-subtle pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.09em] text-ink-subtle">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 normal-case tracking-normal text-ink-muted">
                <Sparkles size={11} /> Local experiment
              </span>
              Adaptive lossless tool exposure
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink sm:text-[30px]">
              See what enters the model loop
            </h1>
            <p className="mt-2 max-w-2xl text-[13.5px] leading-6 text-ink-muted">
              Test deterministic, request-specific tool activation across 48 simulated Slack, Gmail,
              Linear, GitHub, Notion, and Calendar tools. Simulated tool calls never leave this
              page.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink-subtle">
            <span className="rounded-md border border-border bg-surface px-2 py-1">
              {snapshot.registryVersion}
            </span>
          </div>
        </header>

        <section className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)] sm:p-5">
          <label htmlFor="adaptive-tool-query" className="text-[12px] font-medium text-ink">
            Query
          </label>
          <textarea
            id="adaptive-tool-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={4}
            maxLength={2_000}
            placeholder="Ask for work across one or more simulated integrations…"
            className="mt-2 w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2.5 text-[14px] leading-6 text-ink outline-none transition focus:border-border-strong focus:ring-2 focus:ring-ink/5"
          />

          <div className="mt-3 flex flex-wrap gap-1.5">
            {EXAMPLE_QUERIES.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => chooseExample(example)}
                className="rounded-md border border-border bg-surface-muted px-2 py-1 text-[11.5px] text-ink-muted transition hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
              >
                {example.label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-border-subtle pt-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <label htmlFor="adaptive-model" className="text-[11.5px] text-ink-subtle">
                Agent model
              </label>
              <select
                id="adaptive-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="rounded-md border border-border bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-border-strong"
              >
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => submit("analyze")}
                disabled={Boolean(pendingMode) || !query.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] font-medium text-ink transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
              >
                {pendingMode === "analyze" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Search size={14} />
                )}
                Analyze exposure
              </button>
              <button
                type="button"
                onClick={() => submit("agent")}
                disabled={Boolean(pendingMode) || !query.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-ink px-3 py-2 text-[12.5px] font-medium text-canvas transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
              >
                {pendingMode === "agent" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={13} fill="currentColor" />
                )}
                Run simulated agent
              </button>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12px] text-danger"
            >
              {error}
            </div>
          ) : null}
        </section>

        <MetricGrid snapshot={snapshot} run={run} />

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.85fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <ExposurePanel snapshot={snapshot} />
            <LevelZeroPanel snapshot={snapshot} />
          </div>
          <AgentPanel result={result} />
        </div>
      </div>
    </main>
  );
}

function MetricGrid({
  snapshot,
  run,
}: {
  snapshot: AdaptiveExposureSnapshot;
  run: AdaptiveExperimentResponse["run"];
}) {
  const metrics = [
    {
      label: "Activated",
      value: `${snapshot.activatedIntegrationCount}/${snapshot.integrationCount}`,
      detail: "integrations",
      icon: Zap,
    },
    {
      label: "Candidates",
      value: `${snapshot.candidateToolCount}/${snapshot.registryToolCount}`,
      detail: "tools visible",
      icon: Layers3,
    },
    {
      label: "Estimated context",
      value: formatNumber(snapshot.estimatedAdaptiveTokens),
      detail: `${snapshot.estimatedReductionPercent.toFixed(1)}% below flat`,
      icon: Braces,
    },
    {
      label: run ? "Agent tokens" : "Activation",
      value: run
        ? formatNumber(run.totalInputTokens)
        : `${snapshot.activationLatencyMs.toFixed(2)} ms`,
      detail: run ? `${run.steps.length} model steps` : "deterministic routing",
      icon: run ? Activity : Clock3,
    },
  ];

  return (
    <section aria-label="Experiment metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <div key={metric.label} className="rounded-lg border border-border bg-surface p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              <Icon size={12} /> {metric.label}
            </div>
            <div className="mt-2 text-[20px] font-semibold tracking-[-0.02em] text-ink">
              {metric.value}
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-subtle">{metric.detail}</div>
          </div>
        );
      })}
    </section>
  );
}

function ExposurePanel({ snapshot }: { snapshot: AdaptiveExposureSnapshot }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">Request-specific Level 1</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-subtle">
            Deterministically selected candidates, grouped by activated integration
          </p>
        </div>
        <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] tabular-nums text-ink-muted">
          {snapshot.candidateToolCount} cards
        </span>
      </div>

      <div className="border-b border-border-subtle bg-surface-muted/60 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
          <span className="font-medium text-ink-muted">Clauses</span>
          {snapshot.clauses.map((clause, index) => (
            <span
              key={`${index}-${clause}`}
              className="rounded border border-border bg-surface px-1.5 py-0.5"
            >
              {index + 1}. {clause}
            </span>
          ))}
        </div>
      </div>

      {snapshot.integrations.length > 0 ? (
        <div className="divide-y divide-border-subtle">
          {snapshot.integrations.map((integration) => (
            <IntegrationCandidates key={integration.id} integration={integration} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-10 text-center">
          <Layers3 size={20} className="mx-auto text-ink-faint" />
          <p className="mt-2 text-[12.5px] font-medium text-ink-muted">No automatic activation</p>
          <p className="mx-auto mt-1 max-w-sm text-[11.5px] leading-5 text-ink-subtle">
            The model would still see every Level-0 pointer and could explicitly expand the relevant
            integration.
          </p>
        </div>
      )}
    </section>
  );
}

function IntegrationCandidates({ integration }: { integration: ActivatedIntegration }) {
  const Icon = INTEGRATION_ICONS[integration.id as keyof typeof INTEGRATION_ICONS] ?? Bot;
  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted text-ink-muted">
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">{integration.name}</h3>
            <code className="text-[10.5px] text-ink-subtle">{integration.pointer}</code>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {integration.reasons.map((reason, index) => (
              <ReasonPill key={`${reason.kind}-${reason.matched}-${index}`} reason={reason} />
            ))}
          </div>
        </div>
        <span className="text-[11px] tabular-nums text-ink-subtle">score {integration.score}</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {integration.tools.map((tool) => (
          <article
            key={tool.pointer}
            className="min-w-0 rounded-lg border border-border bg-canvas p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11.5px] font-medium text-ink">
                  {tool.name}({tool.signature})
                </div>
                <p className="mt-1 text-[11.5px] leading-[18px] text-ink-muted">
                  {tool.description}
                </p>
              </div>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">
                {tool.score}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded border px-1.5 py-0.5 text-[9.5px] ${SIDE_EFFECT_STYLES[tool.sideEffect]}`}
              >
                {tool.sideEffect.replaceAll("_", " ")}
              </span>
              <span className="text-[10px] text-ink-subtle">→ {tool.outputKind}</span>
              {tool.matchedClauses.map((clause) => (
                <span
                  key={clause}
                  className="rounded bg-surface px-1 py-0.5 text-[9.5px] text-ink-subtle"
                >
                  clause {clause + 1}
                </span>
              ))}
            </div>
            <div className="mt-2 truncate font-mono text-[9.5px] text-ink-faint">
              {tool.pointer}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ReasonPill({ reason }: { reason: ActivationReason }) {
  return (
    <span className="rounded-full border border-border bg-surface-muted px-1.5 py-0.5 text-[9.5px] text-ink-subtle">
      {reason.kind}: {reason.matched}
    </span>
  );
}

function LevelZeroPanel({ snapshot }: { snapshot: AdaptiveExposureSnapshot }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border-subtle px-4 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Always-visible Level 0</h2>
        <p className="mt-0.5 text-[11.5px] text-ink-subtle">
          Compact capabilities and lossless pointers for every simulated integration
        </p>
      </div>
      <div className="divide-y divide-border-subtle">
        {snapshot.level0.map((integration) => {
          const Icon = INTEGRATION_ICONS[integration.id as keyof typeof INTEGRATION_ICONS] ?? Bot;
          return (
            <div key={integration.id} className="flex items-center gap-3 px-4 py-3">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${integration.activated ? "bg-ink text-canvas" : "bg-surface-muted text-ink-subtle"}`}
              >
                <Icon size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-ink">{integration.name}</span>
                  {integration.activated ? (
                    <span className="inline-flex items-center gap-1 text-[9.5px] font-medium text-success">
                      <Check size={10} /> activated
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-[10.5px] text-ink-subtle">{integration.summary}</p>
              </div>
              <code className="hidden shrink-0 text-[9.5px] text-ink-faint sm:block">
                {integration.pointer}
              </code>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgentPanel({ result }: { result: AdaptiveExperimentResponse }) {
  const run = result.run;
  return (
    <section className="h-fit overflow-hidden rounded-xl border border-border bg-surface xl:sticky xl:top-6">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3.5">
        <div>
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Bot size={14} /> Simulated agent run
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-subtle">
            Real model loop, mock execution only
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[10.5px] ${run ? "bg-[#eef8f0] text-success dark:bg-[#18281c]" : "bg-surface-muted text-ink-subtle"}`}
        >
          {run ? "completed" : "not run"}
        </span>
      </div>

      {run ? (
        <div className="divide-y divide-border-subtle">
          <div className="p-4">
            <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Final answer
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-6 text-ink">{run.finalText}</p>
          </div>

          <div className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Tool calls
              </span>
              <span className="text-[10.5px] text-ink-subtle">{run.calls.length} calls</span>
            </div>
            {run.calls.length > 0 ? (
              <div className="flex flex-col gap-2">
                {run.calls.map((call, index) => (
                  <CallRow key={`${call.pointer}-${index}`} call={call} index={index} />
                ))}
              </div>
            ) : (
              <p className="text-[11.5px] text-ink-subtle">
                The model answered without a tool call.
              </p>
            )}
          </div>

          <div className="p-4">
            <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Loop trace
            </div>
            <div className="space-y-2">
              {run.steps.map((step) => (
                <div
                  key={step.step}
                  className="flex items-center gap-2 text-[10.5px] text-ink-muted"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted font-mono text-[9px]">
                    {step.step + 1}
                  </span>
                  <span>
                    {step.modelToolCalls.length > 0
                      ? step.modelToolCalls.join(", ")
                      : "final response"}
                  </span>
                  <span className="ml-auto tabular-nums text-ink-subtle">
                    {formatNumber(step.inputTokens ?? 0)} in ·{" "}
                    {formatNumber(step.outputTokens ?? 0)} out
                  </span>
                </div>
              ))}
            </div>
            {run.expansions.length > 0 ? (
              <div className="mt-3 rounded-md bg-surface-muted p-2.5">
                <div className="text-[9.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                  Expansions
                </div>
                {run.expansions.map((event) => (
                  <div
                    key={`${event.sequence}-${event.pointer}`}
                    className="mt-1 flex items-center gap-1.5 font-mono text-[9.5px] text-ink-muted"
                  >
                    <ChevronRight size={10} /> L{event.level} {event.reason}: {event.pointer}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-px bg-border-subtle">
            <RunStat label="Input tokens" value={formatNumber(run.totalInputTokens)} />
            <RunStat label="Output tokens" value={formatNumber(run.totalOutputTokens)} />
            <RunStat label="Latency" value={`${(run.durationMs / 1_000).toFixed(2)} s`} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-muted text-ink-subtle">
            <Play size={16} />
          </div>
          <h3 className="mt-3 text-[13px] font-medium text-ink">Run the model-backed simulation</h3>
          <p className="mt-1 max-w-xs text-[11.5px] leading-5 text-ink-subtle">
            The model receives only Level 0, the selected candidate cards, and three generic engine
            tools. Every resulting call and expansion will appear here.
          </p>
        </div>
      )}
    </section>
  );
}

function CallRow({ call, index }: { call: AdaptiveObservedCall; index: number }) {
  return (
    <details className="group rounded-lg border border-border bg-canvas">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] ${call.valid ? "bg-[#eaf6ed] text-success dark:bg-[#1b2c1f]" : "bg-danger-bg text-danger"}`}
        >
          {call.valid ? <Check size={10} /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10.5px] font-medium text-ink">
            {call.pointer}
          </div>
          <div className="text-[9.5px] text-ink-subtle">simulated {call.integrationId}</div>
        </div>
        <ArrowRight size={12} className="text-ink-faint transition group-open:rotate-90" />
      </summary>
      <div className="border-t border-border-subtle px-3 py-2.5">
        <div className="text-[9.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Arguments
        </div>
        <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[9.5px] leading-4 text-ink-muted">
          {JSON.stringify(call.arguments, null, 2)}
        </pre>
        {call.error ? <p className="mt-2 text-[10px] text-danger">{call.error}</p> : null}
      </div>
    </details>
  );
}

function RunStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-3 text-center">
      <div className="text-[9.5px] uppercase tracking-[0.06em] text-ink-subtle">{label}</div>
      <div className="mt-1 text-[12px] font-medium tabular-nums text-ink">{value}</div>
    </div>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
