import { buttonVariants } from "@opencompany/ui/components/button";
import { cn } from "@opencompany/ui/lib/utils";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

const logo = String.raw`
  ____                            _
 / ___|___  _ __  _ __   ___  ___| |_ ___  _ __
| |   / _ \| '_ \| '_ \ / _ \/ __| __/ _ \| '__|
| |__| (_) | | | | | | |  __/ (__| || (_) | |
 \____\___/|_| |_|_| |_|\___|\___|\__\___/|_|
`;

const steps = [
  {
    n: "01",
    title: "Connect once",
    body: "Sign up as the founder and connect the integrations your team needs — Slack, GitHub, Linear, Notion, any MCP. One place, one time.",
  },
  {
    n: "02",
    title: "Set the rules",
    body: "Choose who gets access to what, and whether they can read or write — per integration. You stay in control.",
  },
  {
    n: "03",
    title: "Invite your team",
    body: "Everyone connects to a single MCP. No tokens, no config files, no pasting JSON into Claude Desktop. They just get the tools you gave them.",
  },
];

const features = [
  {
    title: "One admin setup",
    body: "Connect all your team's integrations, MCPs, and skills in one place, once.",
  },
  {
    title: "Granular permissions",
    body: "Decide who gets what, and read vs. write, per integration.",
  },
  {
    title: "One MCP for your team",
    body: "Every member connects to a single endpoint. We handle the rest.",
  },
  {
    title: "No token chaos",
    body: "No shared secrets in Slack. No revolving keys when someone leaves. No blast radius.",
  },
  {
    title: "Skills, synced",
    body: "Distribute the right skills to the right people automatically.",
  },
];

export default async function HomePage() {
  const { user } = await withAuth();

  if (user) {
    redirect("/setup");
  }

  return (
    <main className="min-h-screen bg-background font-mono">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16 sm:px-8">
        <pre
          aria-label="Connector"
          className="w-full overflow-hidden text-foreground leading-none"
          style={{ fontSize: "clamp(7px, 2.7vw, 18px)" }}
        >
          {logo}
        </pre>

        <h1 className="mt-10 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          One place for your team's integrations, MCPs, and skills.
        </h1>

        <p className="mt-5 max-w-xl text-xs leading-6 text-muted-foreground sm:text-sm">
          Stop sharing API tokens in Slack threads. Connect everything once, decide who gets what,
          and give your whole team a single MCP to plug into. You stay in control. They stay
          productive.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-6">
          <a
            href="/auth/sign-up"
            className={cn(buttonVariants({ size: "lg" }), "rounded-none font-mono")}
          >
            Get started
          </a>
          <a
            href="/auth/sign-in"
            className="inline-flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-muted-foreground"
          >
            Sign in <span aria-hidden>→</span>
          </a>
        </div>
      </section>

      <section
        id="how-it-works"
        className="mx-auto w-full max-w-3xl scroll-mt-16 border-t border-border px-6 py-20 sm:px-8"
      >
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">The problem</p>
        <p className="mt-4 max-w-xl text-sm leading-7 text-foreground sm:text-base">
          Your team wants to use AI with Slack, GitHub, and Linear. So you paste an API token in a
          group chat. Three months later a contractor leaves, and now you're rotating keys for 12
          people — and you don't even know who has access to what. This is how it starts. Connector
          is how it ends.
        </p>

        <div className="mt-16 grid gap-px border border-border bg-border sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.n} className="flex flex-col bg-background p-6">
              <span className="text-xs text-muted-foreground">{step.n}</span>
              <h3 className="mt-4 text-sm font-bold text-foreground">{step.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>

        <dl className="mt-16 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature.title}>
              <dt className="text-sm font-bold text-foreground">
                <span aria-hidden className="text-muted-foreground">
                  ›{" "}
                </span>
                {feature.title}
              </dt>
              <dd className="mt-2 text-sm leading-6 text-muted-foreground">{feature.body}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-16 flex flex-wrap items-center gap-6 border-t border-border pt-12">
          <a
            href="/auth/sign-up"
            className={cn(buttonVariants({ size: "lg" }), "rounded-none font-mono")}
          >
            Get started
          </a>
          <span className="text-sm text-muted-foreground">One key. One click. Just works.</span>
        </div>
      </section>
    </main>
  );
}
