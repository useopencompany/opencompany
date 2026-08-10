import { LAST_UPDATED } from "@/lib/benchmarks-data";
import { GridBackdrop } from "../GridBackdrop";

function formatUpdatedDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function BenchmarksHero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="mx-auto h-full max-w-5xl px-6">
          <div className="relative h-full">
            <GridBackdrop />
          </div>
        </div>
      </div>
      <div className="relative mx-auto max-w-3xl px-6 pt-16 pb-20 text-center sm:pt-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Benchmarks</span>
        <h1 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-[-0.05em] sm:text-5xl">
          Which models are actually good at real work.
        </h1>
        <p className="mt-6 text-pretty font-medium text-[15px] text-ink-muted leading-7 sm:text-base">
          Cross-verified against the benchmarks the community still trusts — not another
          leaderboard, our judgment on which numbers are worth believing.
        </p>
        <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 font-medium font-mono text-[12px] text-ink-subtle shadow-sm">
          <span aria-hidden="true" className="size-2 rounded-full bg-violet-500" />
          Updated {formatUpdatedDate(LAST_UPDATED)}
        </p>
      </div>
    </section>
  );
}
