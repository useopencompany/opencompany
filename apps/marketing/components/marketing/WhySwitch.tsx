import { Fragment } from "react";

const ROWS = [
  {
    before: 'Your GitHub-repo "brain" rots — no one keeps feeding it.',
    after: "Auto-ingests Gmail, Linear, Slack, GitHub, and meetings — no manual maintenance.",
  },
  {
    before: "It only works for you, not your team.",
    after: "Built multiplayer from day one — a shared source of truth with proper access.",
  },
  {
    before: "Locked into one AI tool's context window.",
    after: "One MCP connection across Claude, Cursor, Codex, and ChatGPT — bring your own model.",
  },
  {
    before: "Setup takes days of config.",
    after: "~2 minutes to connect your sources. Zero config.",
  },
];

export function WhySwitch() {
  return (
    <section className="relative overflow-hidden border-border border-t">
      <div className="relative mx-auto max-w-5xl px-6 py-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-12 bg-[linear-gradient(to_right,rgba(17,17,17,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(17,17,17,0.06)_1px,transparent_1px)] bg-[size:56px_56px] [-webkit-mask-image:linear-gradient(to_bottom_right,black,transparent_65%)] [mask-image:linear-gradient(to_bottom_right,black,transparent_65%)]"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 22 22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="-translate-x-1/2 -translate-y-1/2 absolute top-12 left-0 size-[22px] text-ink/60"
        >
          <path d="M11 0v22M0 11h22" />
        </svg>

        <div className="relative max-w-2xl">
          <span className="font-medium font-mono text-[13px] text-violet-600"># Why switch</span>
          <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
            Why technical founders switch
          </h2>
        </div>

        <div className="relative mt-16 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-2">
          <div className="bg-background px-6 py-3 font-mono text-[12px] text-ink-muted uppercase tracking-widest">
            Without a brain
          </div>
          <div className="bg-background px-6 py-3 font-mono text-[12px] text-violet-600 uppercase tracking-widest">
            With OpenCompany
          </div>
          {ROWS.map((row) => (
            <Fragment key={row.before}>
              <div className="flex gap-3 bg-background p-6 font-mono text-[14px] text-ink-muted leading-7">
                <span aria-hidden="true" className="text-ink-subtle">
                  ✕
                </span>
                <p>{row.before}</p>
              </div>
              <div className="flex gap-3 bg-background p-6 font-mono text-[14px] text-ink leading-7">
                <span aria-hidden="true" className="text-violet-600">
                  ✓
                </span>
                <p>{row.after}</p>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
