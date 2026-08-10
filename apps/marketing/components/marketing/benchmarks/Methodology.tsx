import { METHODOLOGY_SOURCES } from "@/lib/benchmarks-data";

export function Methodology() {
  return (
    <section id="methodology" className="border-border border-t">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Methodology</span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          How to trust this page.
        </h2>

        <div className="mt-8 space-y-5 font-mono text-[13px] text-ink-muted leading-7">
          <p>
            We don't run our own benchmark suite. This page synthesizes results already published by
            independent evaluators — Artificial Analysis, Terminal-Bench, and a handful of others —
            and adds one thing they don't: a verdict on which of those results are still worth
            believing.
          </p>
          <p>
            <span className="font-semibold text-ink">"Independently run"</span> means a third party
            (not the lab selling the model) executed the eval and published the methodology.{" "}
            <span className="font-semibold text-ink">"Not yet reproduced"</span> means the number
            comes from a single source we haven't cross-checked ourselves, or the model is too new
            for anyone to have reproduced it independently. We'd rather label something uncertain
            than round it up to a badge it hasn't earned.
          </p>
          <p>
            Model cards are capped at eight — depth over exhaustiveness. We include a model here
            because it's a genuine top-3 answer to at least one "best for X" question above, not
            because it's new.
          </p>
          <p>
            This page is updated on a weekly, human-reviewed pass, not a live feed — see the
            last-updated date at the top. If a number here looks stale, the sources below are the
            same ones we used; check them directly.
          </p>
        </div>

        <div className="mt-10 border-border border-t pt-8">
          <p className="font-mono text-[12px] text-ink-subtle">Sources</p>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {METHODOLOGY_SOURCES.map((source) => (
              <li key={source.href}>
                <a
                  href={source.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
                >
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
