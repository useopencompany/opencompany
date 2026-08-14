import { Cta } from "./Cta";

const features = [
  {
    name: "Multiplayer",
    description: "Humans and agents run your company together in one shared workspace",
  },
  {
    name: "Any model",
    description: "Run tasks on Claude, GPT, Gemini, or any model you already pay for",
  },
  {
    name: "Agentic workflows",
    description: "Move repeatable processes into workflows any harness can run",
  },
  {
    name: "Self-building wiki",
    description: "Agents keep a living company wiki compiled from your connected sources",
  },
  {
    name: "Any harness",
    description: "Bring Codex, Claude Code, or your favorite coding agent",
  },
  {
    name: "Cloud sandboxes",
    description: "Sessions run in isolated cloud sandboxes — no local setup",
  },
  {
    name: "Connected sources",
    description: "Pull context from Slack, GitHub, Linear, Gmail, and more",
  },
];

export function WhatIsProduct() {
  return (
    <section className="border-border border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <h2 className="font-mono font-semibold text-[15px] text-ink tracking-tight">
          What is opencompany?
        </h2>
        <p className="mt-5 max-w-3xl font-mono text-[15px] text-ink-subtle leading-7">
          opencompany is a multiplayer agent workspace that lets you and your team run your company
          with agents.
        </p>

        <ul className="mt-10 flex flex-col gap-4">
          {features.map((feature) => (
            <li key={feature.name} className="flex items-baseline gap-3 font-mono text-[15px]">
              <span aria-hidden="true" className="text-violet-500">
                [*]
              </span>
              <span className="text-pretty">
                <span className="font-medium text-ink">{feature.name}</span>
                <span className="ml-2 text-ink-subtle">{feature.description}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-10">
          <Cta href="https://my.opencompany.chat" analyticsIntent="signup">
            Sign up →
          </Cta>
        </div>
      </div>
    </section>
  );
}
