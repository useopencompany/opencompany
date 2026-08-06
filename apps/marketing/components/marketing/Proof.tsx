export function Proof() {
  return (
    <section className="relative overflow-hidden border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Proof</span>
        <p className="mt-4 max-w-2xl text-balance font-medium font-mono text-2xl text-ink leading-[1.35] tracking-tight sm:text-3xl">
          4× fewer follow-ups to get a task done — vs. vanilla Codex, Claude Code, or ChatGPT.
        </p>

        {/* TODO: swap for a real, attributed customer quote before this ships. */}
        <blockquote className="mt-14 max-w-xl border-violet-500/30 border-l-2 pl-6 font-mono">
          <p className="text-[17px] text-ink leading-8">
            "I stopped re-explaining my company to every AI session."
          </p>
        </blockquote>
      </div>
    </section>
  );
}
