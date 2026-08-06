type UseCase = {
  title: string;
  body: string;
};

const USE_CASES: UseCase[] = [
  {
    title: "Idea → PR.",
    body: "Type the idea. The workflow plans, codes on your coding-agent subscription, and opens the PR. You review.",
  },
  {
    title: "Find me 10 customers.",
    body: "The agent researches, qualifies, and drafts outreach — built on your positioning and past conversations.",
  },
  {
    title: "Catch me up.",
    body: "Ask what happened last week. Get the decisions, shipped work, and open threads — from the wiki, not a Slack scroll.",
  },
];

export function UseCases() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Use cases</span>
        <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Three sessions people run on day one.
        </h2>

        <div className="mt-16 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-3">
          {USE_CASES.map((useCase) => (
            <div key={useCase.title} className="bg-background p-6 font-mono">
              <h3 className="font-semibold text-[15px] text-ink leading-6">{useCase.title}</h3>
              <p className="mt-3 text-[14px] text-ink-muted leading-7">{useCase.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
