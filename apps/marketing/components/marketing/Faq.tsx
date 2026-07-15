const FAQS = [
  {
    q: "Do I have to organize anything myself?",
    a: "No. Ingested activity is auto-classified, filed, and cross-linked. You only write when you want to save a thought or decision directly.",
  },
  {
    q: "Which sources can it ingest?",
    a: "GitHub, Gmail, Slack, Linear, meeting notes (Fathom), Google Drive, and direct chat capture. More on request.",
  },
  {
    q: "Does it lock me into one AI model?",
    a: "No — that's the point. Connect Claude, Cursor, Codex, or ChatGPT via one MCP connection. Same brain, any model.",
  },
  {
    q: "What does it cost?",
    a: "Free to start. $15/seat/month for teams, with pooled ingestion.",
  },
  {
    q: "Where does my data actually live?",
    a: "Structured Markdown, yours, exportable. No lock-in.",
  },
];

export function Faq() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto grid max-w-5xl gap-12 px-6 py-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-20">
        <div>
          <span className="font-medium font-mono text-[13px] text-violet-600"># FAQ</span>
          <h2 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="mt-6 max-w-sm font-medium font-mono text-[15px] text-ink-subtle leading-7 opacity-60">
            The practical details about setup, sources, models, pricing, and your data.
          </p>
        </div>

        <div className="border-border border-t">
          {FAQS.map((item, index) => (
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
