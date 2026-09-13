import { cn } from "@opencompany/ui/lib/utils";
import { Micro, Section } from "./primitives";
import { BODY } from "./tokens";

/*
 * Soft out-of-focus gradients stand in for the reference design's blurred
 * photography. Kept as CSS so the cards cost nothing to load and still give the
 * page its one hit of color.
 *
 * The lightest stop of each gradient is held at or below 0.10 relative
 * luminance so solid white clears 7:1 and the `white/75` footer label clears
 * 4.9:1 — measured at the lightest point, not the average. The reference runs
 * lighter photography here and does not clear AA; matching it exactly would
 * have meant shipping 2.5:1 body copy.
 */
const CARDS = [
  {
    label: "Product",
    statement:
      "We would rather do a few things properly than ship ten that each need a workaround. Every surface in opencompany has to earn its place, and we remove the ones that don't.",
    footer: "Less but better",
    gradient:
      "bg-[radial-gradient(120%_100%_at_10%_0%,#4e5a52_0%,#3f4845_38%,#2a302e_78%,#191d1a_100%)]",
  },
  {
    label: "Pricing",
    statement:
      "opencompany drives the Claude and Codex plans you already pay for. We don't resell agent usage, and usage past your included balance is billed at provider cost with no markup.",
    footer: "Your subscriptions, not ours",
    gradient:
      "bg-[radial-gradient(120%_100%_at_80%_10%,#5a5344_0%,#4a453a_40%,#2e2b25_80%,#1b1917_100%)]",
  },
  {
    label: "Platform",
    statement:
      "The workspace is MIT licensed. Read the code, self-host it, or fork it. The model of how your company works is the last thing that should sit locked inside a vendor's database.",
    footer: "Open source",
    gradient:
      "bg-[radial-gradient(120%_100%_at_20%_90%,#524a63_0%,#403a52_40%,#282433_80%,#1a181f_100%)]",
  },
];

/**
 * Stands in for the reference design's customer-quote carousel. opencompany is in
 * public beta with no customer logos or attributable quotes yet, so this keeps
 * the visual beat and states what we actually commit to instead.
 */
export function V2Principles() {
  return (
    <Section title="What we optimize for" eyebrow="Principles" index="3.0">
      <div className="grid gap-3 sm:grid-cols-3">
        {CARDS.map(({ label, statement, footer, gradient }) => (
          <div
            key={label}
            className={cn(
              "flex min-h-[360px] flex-col rounded-[6px] p-6 sm:min-h-[440px]",
              gradient,
            )}
          >
            <p className={cn(BODY, "text-white/75")}>{label}</p>
            <p className={cn(BODY, "mt-5 text-pretty text-white")}>{statement}</p>
            <Micro className="mt-10 text-white/75 sm:mt-auto">{footer}</Micro>
          </div>
        ))}
      </div>
    </Section>
  );
}
