import { AnthropicIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { Cta } from "./Cta";
import { GridBackdrop } from "./GridBackdrop";

const chipIconClass = "size-3.5 text-muted-foreground";

const TasksIcon = (
  <svg
    className={chipIconClass}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
  >
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 12.5 10.5 14.75 15.75 9.5" />
  </svg>
);

const WikiIcon = (
  <svg
    className={chipIconClass}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13ZM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z"
    />
  </svg>
);

const WorkflowIcon = (
  <svg
    className={chipIconClass}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
  >
    <circle cx="6" cy="6" r="2.25" />
    <circle cx="18" cy="18" r="2.25" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 8.25v4A3.75 3.75 0 0 0 9.75 16H15.5" />
  </svg>
);

// Inline highlight chip for a keyword — a rounded, bordered token with a small
// glyph, matching the reference (eye/Visibility, Position, Sentiment).
function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 align-middle font-medium text-[0.9em] text-foreground leading-none">
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}

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
            href="https://my.opencompany.chat/changelog#release-1.12.0"
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 font-medium font-sans text-[13px] text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-violet-500" />
            See what's new in 1.12.0
          </a>

          <h1 className="text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-[-0.05em] sm:text-5xl">
            Run your company on <span className="text-violet-600 dark:text-violet-400">agents</span>
          </h1>

          <p className="mt-6 max-w-2xl text-pretty font-medium text-[15px] text-muted-foreground leading-7 sm:text-base">
            One agent workspace to get <Chip icon={TasksIcon}>tasks</Chip> done and build agent{" "}
            <Chip icon={WorkflowIcon}>workflows</Chip>. Bring any harness
            <span className="ml-1.5 inline-flex items-center align-middle">
              <HarnessBadge label="Claude Code">
                <AnthropicIcon className="size-3 text-[#D97757]" />
              </HarnessBadge>
              <HarnessBadge label="Codex" className="-ml-1.5">
                <OpenAIIcon className="size-3 text-foreground" />
              </HarnessBadge>
            </span>
            . Multi-player. Self-building <Chip icon={WikiIcon}>wiki</Chip> for realtime context.
          </p>

          <div className="mt-6 flex items-center justify-center gap-2">
            <Cta
              href="https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding"
              variant="secondary"
            >
              Book demo
            </Cta>
            <Cta href="https://my.opencompany.chat">Sign up</Cta>
          </div>
        </div>
      </div>
    </section>
  );
}
