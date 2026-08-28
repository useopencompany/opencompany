import { AnthropicIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { Cta } from "./Cta";
import { GridBackdrop } from "./GridBackdrop";

// Small circular brand badge used in the "favorite harness" avatar stack.
function HarnessBadge({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={label}
      className={`inline-flex size-5 items-center justify-center rounded-full border border-border bg-background shadow-sm ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

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
            href="https://my.opencompany.chat/changelog#release-1.20.0"
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 font-medium font-sans text-[13px] text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-violet-500" />
            See what's new in 1.20.0
          </a>

          <h1 className="text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-[-0.05em] sm:text-5xl">
            The open source{" "}
            <span className="text-violet-600 dark:text-violet-400">AI workspace</span>
          </h1>

          <p className="mt-6 max-w-2xl text-pretty font-medium text-[15px] text-muted-foreground leading-7 sm:text-base">
            opencompany is a multiplayer AI workspace that works with any agent or model
            <span className="ml-1.5 inline-flex items-center align-middle">
              <HarnessBadge label="Claude Code">
                <AnthropicIcon className="size-3 text-[#D97757]" />
              </HarnessBadge>
              <HarnessBadge label="Codex" className="-ml-1.5">
                <OpenAIIcon className="size-3 text-foreground" />
              </HarnessBadge>
            </span>{" "}
            to help you get work done across your tools, files, and codebase.
          </p>

          <div className="mt-6 flex items-center justify-center gap-2">
            <Cta
              href="https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding"
              variant="secondary"
              analyticsIntent="demo"
            >
              Get a Demo
            </Cta>
            <Cta href="https://my.opencompany.chat" analyticsIntent="signup">
              Sign up
            </Cta>
          </div>
        </div>
      </div>
    </section>
  );
}
