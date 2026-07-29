const FEATURES = [
  { title: "Any trigger", body: "Slack, Linear, email — wherever users report things." },
  { title: "Bring your own agent", body: "Runs on your Codex or Claude Code subscription." },
  { title: "Company context", body: "Your conventions, decisions, and docs in every PR." },
  { title: "You review", body: "Nothing merges without you." },
  { title: "Your whole team", body: "Everyone sees what's shipping and why." },
  { title: "Gets better", body: "Every correction you make is remembered." },
];

export function ShipFeatures() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <p className="max-w-2xl text-balance font-medium font-mono text-2xl text-ink leading-[1.35] tracking-tight sm:text-3xl">
          Ship turns user feedback into code, so your backlog shrinks while you sleep.
        </p>
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
