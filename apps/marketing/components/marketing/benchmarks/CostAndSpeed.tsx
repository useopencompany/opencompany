import { COST_SOURCE, SPEED_TABLE } from "@/lib/benchmarks-data";

export function CostAndSpeed() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600">
          # Real cost & speed
        </span>
        <h2 className="mt-4 max-w-2xl text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          128x separates the cheapest and most expensive model here.
        </h2>
        <p className="mt-6 max-w-2xl font-medium text-[15px] text-ink-subtle leading-7 opacity-80">
          Claude Fable 5 runs $7.70 per million tokens, blended. DeepSeek V4 Flash 0731 runs $0.06 —
          and still lands in the top tier for open-weight models. Price and intelligence aren't the
          same axis; pick the one your task actually needs.
        </p>

        <div className="mt-12 overflow-x-auto border border-border">
          <table className="w-full min-w-[560px] border-collapse font-mono text-[13px]">
            <thead>
              <tr className="border-border border-b bg-accent/50">
                <th className="px-4 py-3 text-left font-medium text-ink-subtle">Model</th>
                <th className="px-4 py-3 text-right font-medium text-ink-subtle">
                  Blended $/M tokens
                </th>
                <th className="px-4 py-3 text-right font-medium text-ink-subtle">Output speed</th>
                <th className="px-4 py-3 text-right font-medium text-ink-subtle">
                  Time to first token
                </th>
              </tr>
            </thead>
            <tbody>
              {SPEED_TABLE.map((row) => (
                <tr key={row.model} className="border-border border-b last:border-0">
                  <td className="px-4 py-3 align-top text-ink">{row.model}</td>
                  <td className="px-4 py-3 text-right align-top font-semibold text-ink">
                    {row.blendedPrice}
                  </td>
                  <td className="px-4 py-3 text-right align-top text-ink-muted">
                    {row.outputSpeed}
                  </td>
                  <td className="px-4 py-3 text-right align-top text-ink-muted">{row.ttft}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-border border-t px-4 py-3 text-[12px] text-ink-subtle leading-5">
            Source:{" "}
            <a
              href={COST_SOURCE.href}
              target="_blank"
              rel="noreferrer"
              className="text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
            >
              {COST_SOURCE.label}
            </a>
            .
          </p>
        </div>

        <div className="mt-10 border border-border p-6">
          <p className="font-mono font-semibold text-[13px] text-ink">
            The harness matters as much as the model.
          </p>
          <p className="mt-2 text-[13px] text-ink-muted leading-6">
            On Terminal-Bench 2.1, Cursor CLI running Grok 4.5 scored 79.3% for $134.09 to run the
            full suite. Codex running GPT-5.5 scored 83.1% — 4 points higher — for $2,059.19, more
            than 15x the cost. Same class of task, wildly different scaffold efficiency. The model
            you pick matters less than people think; the harness around it often matters more.
          </p>
        </div>
      </div>
    </section>
  );
}
