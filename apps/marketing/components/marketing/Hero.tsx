import { Cta } from "./Cta";
import { LaunchVideoDialog } from "./LaunchVideoDialog";
import { MindVisual } from "./MindVisual";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto max-w-5xl px-6 pt-24 pb-16 sm:pt-32">
        {/* Square grid, strongest at the top-left and fading out toward the bottom-right. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-12 bg-[linear-gradient(to_right,rgba(17,17,17,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(17,17,17,0.06)_1px,transparent_1px)] bg-[size:56px_56px] [-webkit-mask-image:linear-gradient(to_bottom_right,black,transparent_65%)] [mask-image:linear-gradient(to_bottom_right,black,transparent_65%)]"
        />
        {/* Prominent crosshair marking the grid's top-left corner. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 22 22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="-translate-x-1/2 -translate-y-1/2 absolute top-12 left-0 size-[22px] text-ink/60"
        >
          <path d="M11 0v22M0 11h22" />
        </svg>
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
              Give your AI agents a living company brain.
            </h1>
            <p className="mt-6 max-w-xl text-pretty font-medium text-[15px] text-ink-subtle leading-7 opacity-60">
              Add GitHub, Gmail, Linear, Slack, and meetings as sources. The brain figures out what
              matters, files it, links it to what you already know, and brings it to any agent with
              MCP.
            </p>
            <div className="mt-9 flex items-center gap-2">
              <Cta>Join early beta</Cta>
              <LaunchVideoDialog />
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
