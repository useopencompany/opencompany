const FEATURES = [
  {
    title: "Shared workspace",
    body: "The whole team works with agents; no credential sharing, no API-key juggling.",
  },
  {
    title: "Workflows",
    body: "Automate full processes, ad-hoc or on triggers.",
  },
  {
    title: "Living company wiki",
    body: "Every agent and human works from the same up-to-date context; learns over time.",
  },
  {
    title: "Model-agnostic sessions",
    body: "Best model per task, auto-optimized for cost.",
  },
  {
    title: "Cloud sandboxes",
    body: "Spin up tasks on the go; no setup, no spinning fans.",
  },
];

export function Features() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Features</span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Everything the workspace runs on.
        </h2>
        <ul className="mt-14 grid gap-x-10 gap-y-8 font-mono sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex gap-3">
              <span aria-hidden="true" className="text-violet-600">
                –
              </span>
              <p className="text-[15px] leading-7">
                <span className="font-semibold text-ink">{feature.title}</span>{" "}
                <span className="text-ink-muted">— {feature.body}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
