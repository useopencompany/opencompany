import { EmailCaptureForm } from "./EmailCaptureForm";
import { GridBackdrop } from "./GridBackdrop";

export function ShipHero() {
  return (
    <section className="relative overflow-hidden border-border border-b">
      <GridBackdrop />
      <div className="relative mx-auto max-w-2xl px-6 pt-24 pb-20 text-center sm:pt-32">
        <h1 className="text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-5xl">
          Turn feature ideas into shipped PRs.
        </h1>
        <p className="mx-auto mt-6 max-w-lg text-pretty font-medium text-[15px] text-ink-subtle leading-7 opacity-60">
          Ship runs on the coding agents you already use — Codex and Claude Code — triggered by
          what your users report, with your company's context built in.
        </p>
        <div className="mt-9 flex justify-center">
          <EmailCaptureForm />
        </div>
      </div>
    </section>
  );
}
