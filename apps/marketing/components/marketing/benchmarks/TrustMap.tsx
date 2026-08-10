import { TRUST_MAP, type TrustEntry } from "@/lib/benchmarks-data";

const COLUMNS: { key: keyof typeof TRUST_MAP; title: string; accent: string }[] = [
  { key: "discriminative", title: "Still discriminative", accent: "text-success" },
  { key: "caution", title: "Read with caution", accent: "text-warning" },
  { key: "ignore", title: "Ignore", accent: "text-destructive" },
];

function TrustColumn({
  title,
  accent,
  entries,
}: {
  title: string;
  accent: string;
  entries: TrustEntry[];
}) {
  return (
    <div>
      <h3 className={`font-mono font-semibold text-[13px] uppercase tracking-wide ${accent}`}>
        {title}
      </h3>
      <ul className="mt-5 space-y-6">
        {entries.map((entry) => (
          <li key={entry.name} className="border-border border-t pt-5 first:border-0 first:pt-0">
            <p className="font-mono font-semibold text-[14px] text-ink">{entry.name}</p>
            <p className="mt-2 text-[13px] text-ink-muted leading-6">{entry.why}</p>
            <a
              href={entry.source.href}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-mono text-[12px] text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
            >
              {entry.source.label} →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TrustMap() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># The trust map</span>
        <h2 className="mt-4 max-w-2xl text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Which benchmarks still deserve your attention.
        </h2>
        <p className="mt-6 max-w-2xl font-medium text-[15px] text-ink-subtle leading-7 opacity-80">
          Nobody else publishes this part. Coverage is easy — judgment about which numbers are worth
          believing is the hard part, and the whole reason this page exists.
        </p>

        <div className="mt-14 grid gap-12 sm:grid-cols-3 sm:gap-8">
          {COLUMNS.map((column) => (
            <TrustColumn
              key={column.key}
              title={column.title}
              accent={column.accent}
              entries={TRUST_MAP[column.key]}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
