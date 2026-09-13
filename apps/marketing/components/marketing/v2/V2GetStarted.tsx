import { cn } from "@opencompany/ui/lib/utils";
import { Arrow, Section } from "./primitives";
import { BODY, GRID } from "./tokens";
import { Button } from "./V2Button";

const CARDS = [
  {
    title: "Start on your own",
    body: "Sign up, connect a source, and watch the wiki build itself. One seat is free, and your first task can run in the same sitting.",
    cta: {
      label: "Sign up",
      href: "https://my.opencompany.chat",
      intent: "signup" as const,
    },
    surface:
      "bg-[radial-gradient(130%_110%_at_15%_10%,#4f5b52_0%,#414a44_35%,#2b312e_75%,#1a1e1b_100%)]",
    bodyClass: "text-white/75",
    titleClass: "text-white",
  },
  {
    title: "Bring your team and your context",
    body: "We will connect your sources, shape the wiki around how you actually work, and set up the first workflows with you.",
    cta: { label: "Request demo", href: "/request-demo", intent: "demo" as const },
    surface: "bg-[#0a0a0a]",
    bodyClass: "text-white/75",
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
    // No eyebrow or section number: the closing section drops the numbering so
    // the sequence reads as finished.
    <Section title="Get started">
      <div className={GRID}>
        <div className="col-span-12 grid gap-3 sm:col-span-8 sm:col-start-5 sm:grid-cols-2">
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
                variant="onDark"
                analyticsIntent={cta.intent}
                className="mt-10 w-[165px] justify-between pr-2 pl-3 sm:mt-auto"
              >
                {cta.label}
                <Arrow />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
