import { Badge } from "@opencompany/ui/components/badge";
import { CAPABILITY_TABLES, type CapabilityTable, VERIFICATION_LABEL } from "@/lib/benchmarks-data";

function VerificationBadge({ status }: { status: "verified" | "unverified" }) {
  return (
    <Badge
      variant={status === "verified" ? "success" : "warning"}
      className="font-mono text-[11px]"
    >
      {status === "verified" ? "✓" : "!"} {VERIFICATION_LABEL[status]}
    </Badge>
  );
}

function CapabilityTableCard({ table }: { table: CapabilityTable }) {
  return (
    <div className="min-w-0 border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-border border-b bg-accent/50 px-4 py-3">
        <h3 className="font-mono font-semibold text-[14px] text-ink">{table.title}</h3>
        <a
          href={table.source.href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 break-words font-mono text-[11px] text-ink-subtle underline decoration-ink-subtle/30 underline-offset-2 hover:text-violet-600 hover:decoration-violet-500"
        >
          {table.metric} · {table.source.label} →
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse font-mono text-[13px]">
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.entry} className="border-border border-b last:border-0">
                <td className="px-4 py-3 align-top text-ink">
                  {row.entry}
                  {row.note ? (
                    <span className="block text-[11px] text-ink-subtle">{row.note}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right align-top font-semibold text-ink">
                  {row.score}
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <VerificationBadge status={row.verification} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.footnote ? (
        <p className="border-border border-t px-4 py-3 text-[12px] text-ink-subtle leading-5">
          {table.footnote}
        </p>
      ) : null}
    </div>
  );
}

export function CapabilityTables() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># By use case</span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Capability, by the work you're actually doing.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-2">
          {CAPABILITY_TABLES.map((table) => (
            <CapabilityTableCard key={table.id} table={table} />
          ))}
        </div>
      </div>
    </section>
  );
}
