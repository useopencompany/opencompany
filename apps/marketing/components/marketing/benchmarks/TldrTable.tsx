import { TLDR_ROWS } from "@/lib/benchmarks-data";

export function TldrTable() {
  return (
    <section id="tldr" className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600">
          # If you just want the answer
        </span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          The five-second version.
        </h2>

        <div className="mt-12 overflow-x-auto border border-border">
          <table className="w-full min-w-[640px] border-collapse font-mono text-[13px]">
            <thead>
              <tr className="border-border border-b bg-accent/50">
                <th className="px-4 py-3 text-left font-medium text-ink-subtle">Category</th>
                <th className="px-4 py-3 text-left font-medium text-ink-subtle">Winner</th>
                <th className="px-4 py-3 text-left font-medium text-ink-subtle">Why</th>
              </tr>
            </thead>
            <tbody>
              {TLDR_ROWS.map((row) => (
                <tr key={row.category} className="border-border border-b last:border-0">
                  <td className="px-4 py-4 align-top text-ink-muted">{row.category}</td>
                  <td className="px-4 py-4 align-top font-semibold text-ink">{row.model}</td>
                  <td className="px-4 py-4 align-top text-ink-muted leading-6">
                    {row.rationale}{" "}
                    <a
                      href={row.source.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
                    >
                      {row.source.label}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
