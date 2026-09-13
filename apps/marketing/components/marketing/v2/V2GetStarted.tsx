import { cn } from "@opencompany/ui/lib/utils";
import { Arrow, Button } from "./primitives";
import { BODY, DISPLAY, GRID, SECTION, SHELL } from "./tokens";

const CARDS = [
  {
    title: "Start on your own",
    body: "Sign up, connect a source, and watch the wiki build itself. One seat is free, and your first task can run in the same sitting.",
    cta: { label: "Sign up", href: "https://my.opencompany.chat", variant: "onDark" as const },
    surface:
      "bg-[radial-gradient(130%_110%_at_15%_10%,#9aa79b_0%,#77857c_35%,#454e49_75%,#2b312e_100%)]",
    bodyClass: "text-white/70",
    titleClass: "text-white",
  },
  {
    title: "Bring your team and your context",
    body: "We will connect your sources, shape the wiki around how you actually work, and set up the first workflows with you.",
    cta: { label: "Request demo", href: "/request-demo", variant: "onDark" as const },
    surface: "bg-[#0a0a0a]",
    bodyClass: "text-white/60",
    titleClass: "text-white",
  },
];

/**
 * Closing section: heading in the left gutter, two square cards filling columns
 * 5–12. The buttons sit at the bottom of each card with the label and arrow
 * pushed apart, so they read as a destination rather than a nudge.
 */
export function V2GetStarted() {
  return (
    <section className={SECTION}>
      <div className={SHELL}>
        {/* No eyebrow or section number here: the closing section drops the
            numbering so the sequence reads as finished. */}
        <div className={GRID}>
          <h2 className={cn(DISPLAY, "col-span-12 sm:col-span-4")}>Get started</h2>
          <div className="col-span-12 mt-16 grid gap-3 sm:col-span-8 sm:col-start-5 sm:mt-0 sm:grid-cols-2">
            {CARDS.map(({ title, body, cta, surface, bodyClass, titleClass }) => (
              <div
                key={title}
                className={cn(
                  "flex min-h-[300px] flex-col rounded-[6px] p-6 sm:min-h-[434px]",
                  surface,
                )}
              >
                <h3
                  className={cn(
                    "text-balance text-[21px] leading-[1.25] tracking-[-0.015em]",
                    titleClass,
                  )}
                >
                  {title}
                </h3>
                <p className={cn(BODY, "mt-2.5 text-pretty", bodyClass)}>{body}</p>
                <Button
                  href={cta.href}
                  variant={cta.variant}
                  className="mt-10 w-[165px] justify-between pr-2 pl-3 sm:mt-auto"
                >
                  {cta.label}
                  <Arrow />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
