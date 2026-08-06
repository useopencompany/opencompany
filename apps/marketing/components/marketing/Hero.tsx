import { Cta } from "./Cta";
import { GridBackdrop } from "./GridBackdrop";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Grid layer bounded to the top-nav container so its left edge (and the
          crosshair origin) line up with the logo's left edge. The padding lives on
          the outer wrapper, so the grid's inset-x-0 lands on the content edge. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="mx-auto h-full max-w-5xl px-6">
          <div className="relative h-full">
            <GridBackdrop />
          </div>
        </div>
      </div>
      <div className="relative mx-auto max-w-4xl px-6 pt-16 pb-20 text-center sm:pt-24">
        <div className="relative flex flex-col items-center">
          <a
            href="https://my.opencompany.chat/changelog#release-1.0.0"
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 font-medium font-sans text-[13px] text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-violet-500" />
            See what's new in 1.0.0
          </a>

          <h1 className="text-balance font-medium font-mono text-4xl text-ink leading-[1.05] tracking-tight sm:text-6xl">
            Agent workspace
            <br />
            <span className="text-ink-subtle opacity-50">for startups</span>
          </h1>

          <p className="mt-7 max-w-2xl text-pretty font-medium text-[15px] text-muted-foreground leading-8 sm:text-base">
            Get work done with any model, move processes to agentic workflows,
            <br />
            and get better context with a self-building company wiki.
          </p>

          <div className="mt-6 flex items-center justify-center gap-2">
            <Cta
              href="https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding"
              variant="secondary"
            >
              Book demo
            </Cta>
            <Cta href="https://my.opencompany.chat">Signup</Cta>
          </div>
        </div>
      </div>
    </section>
  );
}
