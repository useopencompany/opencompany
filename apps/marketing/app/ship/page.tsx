import type { Metadata } from "next";
import { EmailCaptureForm } from "@/components/marketing/EmailCaptureForm";
import { Faq } from "@/components/marketing/Faq";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ShipDemo } from "@/components/marketing/ShipDemo";
import { ShipFeatures } from "@/components/marketing/ShipFeatures";
import { ShipHero } from "@/components/marketing/ShipHero";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";

const title = "Ship — turn feature ideas into shipped PRs | opencompany";
const description =
  "Ship runs on the coding agents you already use — Codex and Claude Code — triggered by what your users report, with your company's context built in.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/ship",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/ship",
    siteName: "opencompany",
    title,
    description,
  },
  twitter: {
    card: "summary",
    title,
    description,
  },
};

const SHIP_STEPS = [
  { title: "Connect where users report bugs and ideas." },
  { title: "Ship builds it with your coding agent and your context." },
  { title: "Review the PR. Merge." },
];

const SHIP_FAQS = [
  {
    q: "Do I need a Codex or Claude Code subscription?",
    a: "Yes — bring it with you. Ship drives the agent subscription you already pay for; we don't resell agent usage on top.",
  },
  {
    q: "Why not just use Claude Code directly?",
    a: "Nothing fires when a bug lands in Slack. Ship is the trigger — it watches where your users report things and hands the ticket to your agent with your company's context already loaded.",
  },
  {
    q: "What does Ship do with my code and data?",
    a: "Your code stays in your repo. Ship opens PRs on branches you control and only reads what it needs to do that — nothing is used to train a model.",
  },
  {
    q: "How much does it cost?",
    a: "Ship is in early access. Pricing will follow OpenCompany's usage-based model — no per-seat licensing. Get early access and we'll confirm details before anything's charged.",
  },
  {
    q: "Is this for non-technical founders?",
    a: "No — Ship is for semi-technical founders and teams. You still review and merge every PR, so you need to be able to read a diff and know your codebase.",
  },
];

export default function ShipPage() {
  return (
    <>
      <TopNav />
      <main>
        <ShipHero />
        <ShipDemo />
        <ShipFeatures />
        <HowItWorks steps={SHIP_STEPS} />
        <section className="border-border border-t">
          <div className="mx-auto max-w-2xl px-6 py-24 text-center">
            <h2 className="text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              Ready to ship the backlog?
            </h2>
            <div className="mt-8 flex justify-center">
              <EmailCaptureForm />
            </div>
          </div>
        </section>
        <Faq eyebrow="# FAQ" title="Before you connect a repo." items={SHIP_FAQS} />
      </main>
      <SiteFooter />
    </>
  );
}
