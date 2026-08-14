import { Cta } from "./Cta";

type Plan = {
  name: string;
  price: string;
  priceSuffix?: string;
  description: string;
  ctaVariant: "primary" | "secondary";
  includesNote: string;
  features: string[];
};

const PLANS: Plan[] = [
  {
    name: "Hobby",
    price: "Free",
    description: "One seat, for trying opencompany on real work.",
    ctaVariant: "secondary",
    includesNote: "Includes:",
    features: [
      "1 seat, 1 workspace",
      "$5/mo of included usage, billed at cost",
      "Full product access — agents, workflows, the wiki",
      "Pay-per-use beyond your included balance",
    ],
  },
  {
    name: "Pro",
    price: "$20",
    priceSuffix: "/seat/mo",
    description: "For teams sharing one workspace.",
    ctaVariant: "primary",
    includesNote: "Everything in Hobby, plus:",
    features: [
      "Up to 10 seats on one workspace",
      "$20/mo of included usage per seat",
      "Top-up credit, with optional auto-refill",
      "Centralized billing for the whole team",
    ],
  },
];

export function Pricing() {
  return (
    <section id="pricing">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <span className="font-medium font-mono text-[13px] text-violet-600"># Pricing</span>
        <h1 className="mt-4 text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Simple pricing. Pay for what you use.
        </h1>
        <p className="mt-6 max-w-lg font-medium font-mono text-[15px] text-ink-subtle leading-7 opacity-60">
          Every plan comes with a monthly usage balance billed at exact provider cost — we never add
          a markup.
        </p>

        <div className="mt-14 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
          {PLANS.map((plan) => (
            <div key={plan.name} className="flex flex-col bg-background p-8 font-mono">
              <h2 className="font-semibold text-[17px] text-ink leading-6">{plan.name}</h2>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="font-medium text-3xl text-ink tracking-tight">{plan.price}</span>
                {plan.priceSuffix ? (
                  <span className="text-[13px] text-ink-subtle">{plan.priceSuffix}</span>
                ) : null}
              </p>
              <p className="mt-3 text-[14px] text-ink-muted leading-6">{plan.description}</p>

              <p className="mt-8 text-[13px] text-ink-subtle">{plan.includesNote}</p>
              <ul className="mt-4 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-[13px] text-ink-muted leading-6">
                    <span aria-hidden="true" className="text-violet-600">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>

              <Cta
                href="https://my.opencompany.chat"
                variant={plan.ctaVariant}
                className="mt-8 w-full justify-center px-4 py-2.5 text-[13px]"
                analyticsIntent="signup"
              >
                Sign up
              </Cta>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center font-mono text-[13px] text-ink-subtle leading-6 opacity-70">
          Need more than your included balance? Usage beyond it runs pay-as-you-go, at provider cost
          — no markup, no throttling.
        </p>
      </div>
    </section>
  );
}
