import type { Metadata } from "next";
import Link from "next/link";
import { BarChart, type BarDatum } from "@/components/marketing/benchmarks/charts/BarChart";
import {
  ScatterChart,
  type ScatterPoint,
} from "@/components/marketing/benchmarks/charts/ScatterChart";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import {
  CAPABILITY_TABLES,
  type CapabilityTable,
  COST_SOURCE,
  LAST_UPDATED,
  SPEED_TABLE,
} from "@/lib/benchmarks-data";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Benchmark charts — opencompany";
const description =
  "The /benchmarks data, plotted. Coding, knowledge work, tool-use, and computer-use scores, plus cost and speed, as real charts you can scan in five seconds.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/benchmarks/charts",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/benchmarks/charts",
    siteName: "opencompany",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
};

// Every number below is read straight off lib/benchmarks-data.ts (the same
// source /benchmarks renders as tables) — this page only changes the form,
// never the data. Scores there are stored as display strings ("83.8%",
// "63 (#1/185)"); parseLeadingNumber pulls the value back out for bar/axis scaling.
function parseLeadingNumber(value: string): number {
  const match = value.match(/-?\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : 0;
}

function toBarData(table: CapabilityTable): BarDatum[] {
  return table.rows.map((row, index) => ({
    label: row.entry,
    value: parseLeadingNumber(row.score),
    displayValue: row.score,
    note: row.note,
    emphasized: index === 0 && row.verification === "verified",
    caution: row.verification === "unverified",
  }));
}

function requireCapabilityTable(id: string): CapabilityTable {
  const table = CAPABILITY_TABLES.find((t) => t.id === id);
  if (!table) {
    throw new Error(`benchmarks-data.ts is missing the "${id}" CAPABILITY_TABLES entry`);
  }
  return table;
}

const codingTable = requireCapabilityTable("coding");
const knowledgeTable = requireCapabilityTable("knowledge-work");
const toolUseTable = requireCapabilityTable("tool-use");
const browserUseTable = requireCapabilityTable("browser-use");

const COST_INTELLIGENCE_POINTS: ScatterPoint[] = SPEED_TABLE.map((row) => {
  const knowledgeRow = knowledgeTable.rows.find((r) => r.entry === row.model);
  if (!knowledgeRow) {
    throw new Error(`No Intelligence Index score found for ${row.model}`);
  }
  return {
    label: row.model,
    x: parseLeadingNumber(row.blendedPrice),
    y: parseLeadingNumber(knowledgeRow.score),
    xDisplay: row.blendedPrice,
    yDisplay: knowledgeRow.score,
    // Opus 5 / GPT-5.6 Sol and Gemini / DeepSeek each sit close together on
    // this specific dataset — flip and shift labels so they clear each other.
    labelAbove: row.model === "GPT-5.6 Sol" || row.model === "Gemini 3.6 Flash",
    labelAlign:
      row.model === "Gemini 3.6 Flash" || row.model === "Claude Opus 5"
        ? "left"
        : row.model === "DeepSeek V4 Flash 0731" || row.model === "GPT-5.6 Sol"
          ? "right"
          : undefined,
  };
});

const SPEED_LATENCY_POINTS: ScatterPoint[] = SPEED_TABLE.map((row) => ({
  label: row.model,
  x: parseLeadingNumber(row.outputSpeed),
  y: parseLeadingNumber(row.ttft),
  xDisplay: row.outputSpeed,
  yDisplay: row.ttft,
  // GPT-5.6 Sol/Fable 5 and Qwen/DeepSeek each cluster tightly on this
  // dataset — flip and shift labels so they clear each other and the plot edge.
  labelAbove:
    row.model === "GPT-5.6 Sol" ||
    row.model === "Qwen3.8 Max" ||
    row.model === "DeepSeek V4 Flash 0731",
  labelAlign: row.model === "Qwen3.8 Max" ? "left" : undefined,
}));

function ChartCard({
  eyebrow,
  title: cardTitle,
  metricLabel,
  sourceHref,
  footnote,
  children,
}: {
  eyebrow: string;
  title: string;
  metricLabel: string;
  sourceHref: string;
  footnote?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border">
      <div className="border-border border-b bg-accent/50 px-5 py-4">
        <span className="font-mono text-[11px] text-ink-subtle uppercase tracking-wide">
          {eyebrow}
        </span>
        <h3 className="mt-1 font-mono font-semibold text-[16px] text-ink">{cardTitle}</h3>
      </div>
      <div className="p-5">{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-t px-5 py-3">
        <p className="font-mono text-[11px] text-ink-subtle">{metricLabel}</p>
        <a
          href={sourceHref}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
        >
          Source →
        </a>
      </div>
      {footnote ? (
        <p className="border-border border-t px-5 py-3 font-mono text-[12px] text-ink-subtle leading-5">
          {footnote}
        </p>
      ) : null}
    </div>
  );
}

export default function BenchmarksChartsPage() {
  return (
    <>
      <TopNav />
      <main>
        <section className="border-border border-t">
          <div className="mx-auto max-w-5xl px-6 pt-16 pb-10">
            <Link
              href="/benchmarks"
              className="font-mono text-[13px] text-ink-subtle hover:text-violet-600"
            >
              ← Back to the full breakdown
            </Link>
            <span className="mt-6 block font-medium font-mono text-[13px] text-violet-600">
              # Benchmark charts
            </span>
            <h1 className="mt-4 max-w-2xl text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              The same data. Plotted, not just tabled.
            </h1>
            <p className="mt-6 max-w-2xl font-medium text-[15px] text-ink-subtle leading-7 opacity-80">
              A quick visual reference for every benchmark on this page — same numbers, same
              sources, same last-updated date. The accent color marks our current pick; gray bars
              are context, not a ranking to read into.
            </p>
            <p className="mt-4 font-mono text-[12px] text-ink-subtle">Updated {LAST_UPDATED}</p>
          </div>
        </section>

        <section className="border-border border-t">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <div className="grid gap-8 lg:grid-cols-2">
              <ChartCard
                eyebrow="Coding"
                title="Terminal-Bench 2.1 score"
                metricLabel="Agent + model, % of tasks completed"
                sourceHref={codingTable.source.href}
              >
                <BarChart data={toBarData(codingTable)} maxValue={100} />
              </ChartCard>

              <ChartCard
                eyebrow="Knowledge work"
                title="Artificial Analysis Intelligence Index"
                metricLabel="Composite score across 9 evals — no fixed ceiling, so bars scale to the top score here"
                sourceHref={knowledgeTable.source.href}
              >
                <BarChart data={toBarData(knowledgeTable)} />
              </ChartCard>

              <ChartCard
                eyebrow="Tool-use workflows"
                title="τ³-Banking score"
                metricLabel="% of multi-step banking tasks resolved correctly"
                sourceHref={toolUseTable.source.href}
              >
                <BarChart data={toBarData(toolUseTable)} maxValue={100} />
              </ChartCard>

              <ChartCard
                eyebrow="Browser & computer use"
                title="OSWorld-Verified score"
                metricLabel="% of real desktop/web tasks completed"
                sourceHref={browserUseTable.source.href}
                footnote={browserUseTable.footnote}
              >
                <BarChart data={toBarData(browserUseTable)} maxValue={100} />
              </ChartCard>
            </div>
          </div>
        </section>

        <section className="border-border border-t">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <span className="font-medium font-mono text-[13px] text-violet-600">
              # Cost & speed
            </span>
            <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              Where price, speed, and intelligence actually land.
            </h2>
            <div className="mt-10 grid gap-8 lg:grid-cols-2">
              <ChartCard
                eyebrow="Cost vs. intelligence"
                title="Blended $/M tokens vs. Intelligence Index"
                metricLabel="x: blended $/M tokens · y: Intelligence Index"
                sourceHref={COST_SOURCE.href}
              >
                <ScatterChart
                  data={COST_INTELLIGENCE_POINTS}
                  xDomain={[0, 8.5]}
                  yDomain={[45, 68]}
                  xTicks={[0, 2, 4, 6, 8]}
                  yTicks={[45, 50, 55, 60, 65]}
                  xTickLabel={(v) => `$${v}`}
                  yTickLabel={(v) => `${v}`}
                />
              </ChartCard>

              <ChartCard
                eyebrow="Speed vs. latency"
                title="Output speed vs. time to first token"
                metricLabel="x: output tok/s · y: time to first token (lower is better)"
                sourceHref={COST_SOURCE.href}
                footnote="Bottom-right is the sweet spot: fast output, quick to start responding."
              >
                <ScatterChart
                  data={SPEED_LATENCY_POINTS}
                  xDomain={[0, 250]}
                  yDomain={[0, 145]}
                  xTicks={[0, 50, 100, 150, 200, 250]}
                  yTicks={[0, 25, 50, 75, 100, 125]}
                  xTickLabel={(v) => `${v}`}
                  yTickLabel={(v) => `${v}s`}
                />
              </ChartCard>
            </div>
          </div>
        </section>

        <section className="border-border border-t">
          <div className="mx-auto max-w-3xl px-6 py-16 text-center">
            <p className="font-mono text-[13px] text-ink-subtle leading-6">
              Want the model cards, the trust map, and the methodology behind these numbers?
            </p>
            <Link
              href="/benchmarks"
              className="mt-3 inline-block font-mono text-[13px] text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
            >
              ← Back to the full breakdown
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
