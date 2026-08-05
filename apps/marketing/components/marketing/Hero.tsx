import { Cta } from "./Cta";
import { GridBackdrop } from "./GridBackdrop";
import { LaunchVideoDialog } from "./LaunchVideoDialog";
import { MindVisual } from "./MindVisual";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto max-w-5xl px-6 pt-24 pb-16 sm:pt-32">
        <GridBackdrop />
        <div className="relative grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-12">
          <div>
            <a
              href="https://my.opencompany.chat/changelog#release-1.0.0"
              className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/5 px-3 py-1 font-mono text-[12px] text-violet-600 transition-colors hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
            >
              See what's new in 1.0.0
              <span aria-hidden="true">→</span>
            </a>
            <h1 className="max-w-3xl text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              Run your company on agents, not duct tape.
            </h1>
            <p className="mt-6 max-w-xl text-pretty font-medium text-[15px] text-ink-subtle leading-7 opacity-60">
              OpenCompany is the workspace where agents and humans run your company — a living
              wiki, workflows, and sessions for every team, on the AI subscriptions you already
              pay for.
            </p>
            <div className="mt-9 flex items-center gap-2">
              <Cta>Start your first task</Cta>
              <LaunchVideoDialog>Watch a feature idea become a PR (60s)</LaunchVideoDialog>
            </div>
          </div>

          {/* Company-brain visualization — hidden on small screens where it crowds the copy. */}
          <div className="relative hidden lg:block">
            <MindVisual />
          </div>
        </div>
      </div>
    </section>
  );
}
