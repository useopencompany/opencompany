import { MODEL_CARDS } from "@/lib/benchmarks-data";

export function ModelCards() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Model cards</span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Eight models worth knowing. Not eight hundred.
        </h2>

        <div className="mt-12 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
          {MODEL_CARDS.map((card) => (
            <div key={card.id} className="flex flex-col bg-background p-6 font-mono">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold text-[15px] text-ink">{card.name}</h3>
                <span className="whitespace-nowrap text-[12px] text-ink-subtle">
                  {card.lab} · {card.released}
                </span>
              </div>
              <p className="mt-3 text-[13px] text-ink-muted leading-6">{card.verdict}</p>
              <a
                href={card.source.href}
                target="_blank"
                rel="noreferrer"
                className="mt-4 text-[12px] text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
              >
                {card.source.label} →
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
