import { CHANGELOG } from "@/lib/benchmarks-data";

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function Changelog() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600">
          # What changed recently
        </span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          The landscape moves weekly. Here's what moved.
        </h2>

        <ul className="mt-12 space-y-6">
          {CHANGELOG.map((entry) => (
            <li
              key={entry.date}
              className="flex gap-4 border-border border-t pt-6 first:border-0 first:pt-0"
            >
              <span className="w-16 shrink-0 font-mono text-[12px] text-ink-subtle">
                {formatDate(entry.date)}
              </span>
              <p className="font-mono text-[13px] text-ink-muted leading-6">
                {entry.text}{" "}
                <a
                  href={entry.source.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-600 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-500"
                >
                  {entry.source.label}
                </a>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
