import { Check } from "@opencompany/ui/icons";
import type { Metadata } from "next";
import { DemoRequestForm } from "@/components/marketing/DemoRequestForm";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Request a demo — opencompany";
const description =
  "See how your team can get work done with agents across your tools, files, and codebase. Get a personal walkthrough of opencompany.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/request-demo" },
  openGraph: {
    type: "website",
    url: "/request-demo",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_SOCIAL_IMAGE] },
};

const benefits = [
  "Give agents the context they need with a shared, living company wiki.",
  "Turn everyday work into tasks and workflows that run across your tools.",
  "Go from a product idea to a pull request with agents working in your codebase.",
  "Keep your team in control with shared conversations and approvals.",
];

export default function RequestDemoPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto grid min-h-[calc(100svh-11rem)] max-w-6xl items-start gap-12 px-6 py-14 sm:py-20 lg:grid-cols-2 lg:gap-16 lg:py-24">
        <section aria-labelledby="demo-heading" className="contents lg:block">
          <div className="order-1">
            <p className="mb-5 font-mono text-xs text-violet-600 uppercase tracking-widest">
              A personal walkthrough
            </p>
            <h1
              id="demo-heading"
              className="text-balance font-medium font-mono text-3xl text-ink leading-[1.15] tracking-[-0.05em] sm:text-[42px]"
            >
              A small team.
              <br />A lot more <span className="text-violet-600">done.</span>
            </h1>
            <p className="mt-6 max-w-md text-base text-muted-foreground leading-7">
              See how opencompany brings your team and agents together to get real work done. We’ll
              show you how we use it to build our own company.
            </p>
          </div>
          <div className="order-3">
            <ul className="space-y-5 lg:mt-9">
              {benefits.map((benefit) => (
                <li
                  key={benefit}
                  className="flex gap-3 text-[15px] text-muted-foreground leading-6"
                >
                  <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-violet-600" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            <p className="mt-10 border-border border-t pt-6 font-mono text-xs text-muted-foreground leading-6">
              Built for founders and small teams.
              <br />
              Open source. Works with the agents and models you already use.
            </p>
          </div>
        </section>
        <section
          aria-labelledby="request-heading"
          className="order-2 border-border border-t pt-10 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-16"
        >
          <h2 id="request-heading" className="font-medium text-2xl tracking-tight">
            Request a demo
          </h2>
          <p className="mt-3 mb-8 text-sm text-muted-foreground leading-6">
            Tell us a little about your team so we can make the walkthrough useful for you.
          </p>
          <DemoRequestForm />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
