type Step = {
  title: string;
  body?: string;
};

type HowItWorksProps = {
  eyebrow?: string;
  steps?: Step[];
};

const DEFAULT_STEPS: Step[] = [
  {
    title: "Connect your sources.",
    body: "GitHub, Gmail, Slack, Linear, meeting notes, Google Drive. Two minutes, no config.",
  },
  {
    title: "It writes itself.",
    body: "A background agent classifies every new thing that happens, files it, and links it to related people, decisions, and projects. You never touch a folder structure.",
  },
  {
    title: "Use it anywhere.",
    body: "One MCP connection. Claude, Cursor, Codex, ChatGPT — whatever you already use — all reading from the same source of truth.",
  },
];

export function HowItWorks({ eyebrow = "# How it works", steps = DEFAULT_STEPS }: HowItWorksProps) {
  return (
    <section id="how-it-works" className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <h2 className="font-medium font-mono text-[13px] text-violet-600">{eyebrow}</h2>
        <ol className="mt-12 space-y-8">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3 font-mono">
              <span className="text-[17px] text-ink-subtle leading-7">{i + 1}.</span>
              <div>
                <h3 className="font-semibold text-[17px] text-ink leading-7">{step.title}</h3>
                {step.body ? (
                  <p className="mt-1 max-w-2xl text-[16px] text-ink-muted leading-7">{step.body}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
