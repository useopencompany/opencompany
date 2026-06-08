import { Badge } from "@opencompany/ui/components/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@opencompany/ui/components/card";
import Link from "next/link";
import { PageHeader } from "@/components/docs-primitives";
import { COMPONENT_SLUGS, COMPONENT_TITLES, componentHref, FOUNDATIONS } from "@/lib/site";

export default function IntroductionPage() {
  return (
    <article>
      <PageHeader
        title="OpenCompany Design System"
        description="A shadcn-style component library built on Base UI and Tailwind CSS v4, sharing the OpenCompany palette. Components live in @opencompany/ui and are consumable across the monorepo."
      />

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Base UI</Badge>
        <Badge variant="secondary">Tailwind CSS v4</Badge>
        <Badge variant="secondary">React 19</Badge>
        <Badge variant="secondary">{COMPONENT_SLUGS.length} components</Badge>
      </div>

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Getting started</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Import components directly from the shared package and the design tokens come along for
          the ride:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted p-4 text-[13px] leading-relaxed">
          <code>{`// In any app, load the tokens once (e.g. globals.css)
@import "@opencompany/ui/globals.css";

// Then use components
import { Button } from "@opencompany/ui/components/button";

<Button>Get started</Button>`}</code>
        </pre>
      </section>

      <section className="mt-12">
        <h2 className="mb-4 text-lg font-semibold">Foundations</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {FOUNDATIONS.filter((f) => f.href !== "/").map((item) => (
            <Link key={item.href} href={item.href}>
              <Card className="gap-2 py-4 transition-colors hover:bg-accent">
                <CardHeader>
                  <CardTitle className="text-base">{item.title}</CardTitle>
                  <CardDescription>
                    Explore the {item.title.toLowerCase()} foundation.
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="mb-4 text-lg font-semibold">Components</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {COMPONENT_SLUGS.map((slug) => (
            <Link
              key={slug}
              href={componentHref(slug)}
              className="rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              {COMPONENT_TITLES[slug]}
            </Link>
          ))}
        </div>
      </section>
    </article>
  );
}
