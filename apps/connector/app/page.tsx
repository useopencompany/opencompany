import { Button } from "@opencompany/ui/components/button";

const logo = String.raw`
  ____                            _
 / ___|___  _ __  _ __   ___  ___| |_ ___  _ __
| |   / _ \| '_ \| '_ \ / _ \/ __| __/ _ \| '__|
| |__| (_) | | | | | | |  __/ (__| || (_) | |
 \____\___/|_| |_|_| |_|\___|\___|\__\___/|_|
`;

export default function HomePage() {
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
          Manage integrations, mcps, and skills for your whole team in one place.
        </h1>

        <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base">
          Setup integrations, mcps, skills once. Control who has access. Give your team one mcp to
          connect to.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-6">
          <Button size="lg" className="rounded-none font-mono">
            Get started
          </Button>
          <a
            href="#how-it-works"
            className="inline-flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-muted-foreground"
          >
            Learn how it works <span aria-hidden>→</span>
          </a>
        </div>
      </section>
    </main>
  );
}
