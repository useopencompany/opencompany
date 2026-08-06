type FaqItem = {
  q: string;
  a: string;
};

type FaqProps = {
  eyebrow?: string;
  title?: string;
  description?: string;
  items?: FaqItem[];
};

const DEFAULT_FAQS: FaqItem[] = [
  {
    q: "I'm happy with Codex / I have a sub.",
    a: "Keep it for coding. opencompany is the shared layer Codex doesn't have: wiki context, shareable sessions, workflows across the team.",
  },
  {
    q: "I'll just build it myself.",
    a: "Then you maintain it forever. More time duct-taping than doing real work — and never state of the art.",
  },
  {
    q: "What can I do with it?",
    a: "Any job you do with AI today, in the cloud, with your company's context behind it.",
  },
  {
    q: "What's the first step?",
    a: "Sign up, connect your sources. The wiki builds itself. Start your first task.",
  },
];

export function Faq({
  eyebrow = "# FAQ",
  title = "Questions, answered.",
  description = "The honest answers to the questions we hear most.",
  items = DEFAULT_FAQS,
}: FaqProps) {
  return (
    <section className="border-border border-t">
      <div className="mx-auto grid max-w-5xl gap-12 px-6 py-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-20">
        <div>
          <span className="font-medium font-mono text-[13px] text-violet-600">{eyebrow}</span>
          <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
            {title}
          </h2>
          <p className="mt-6 max-w-sm font-medium font-mono text-[15px] text-ink-subtle leading-7 opacity-60">
            {description}
          </p>
        </div>

        <div className="border-border border-t">
          {items.map((item, index) => (
            <details key={item.q} className="group border-border border-b font-mono">
              <summary className="grid cursor-pointer list-none grid-cols-[2rem_1fr_auto] items-center gap-3 py-5 text-[15px] text-ink leading-6 [&::-webkit-details-marker]:hidden">
                <span className="text-[12px] text-violet-600">0{index + 1}</span>
                <span className="font-medium">{item.q}</span>
                <span className="flex size-6 items-center justify-center border border-violet-500/30 text-violet-600 transition-transform duration-200 group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="grid grid-cols-[2rem_1fr_auto] gap-3">
                <span aria-hidden="true" />
                <p className="pr-4 pb-6 text-[14px] text-ink-muted leading-7">{item.a}</p>
                <span aria-hidden="true" className="size-6" />
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
