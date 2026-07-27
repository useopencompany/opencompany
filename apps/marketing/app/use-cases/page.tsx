import type { Metadata } from "next";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";

const title = "Use cases — opencompany";
const description =
  "A running list of what OpenCompany is good at — from sorting Slack, Linear, and meeting notes into a shared company brain to answering deep research questions.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/use-cases",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/use-cases",
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

// A minimal, easy-to-edit list of things OpenCompany is good at. Add a one-liner
// here and it renders on the page — this is the source of truth for the asset.
const USE_CASES = [
  "Sort Slack, Linear, CRM updates, meeting notes, and PR merges into a shared company brain that links concepts to one another — and cites them well in the work you do with AI.",
  "Do deep web search and answer hard research questions.",
  'Answer "what did we decide?" — decisions, owners, and reasoning, with citations.',
  "Onboard new hires against the brain instead of interrupting the team.",
  "Catch up after time off with a summary of what changed across every source.",
  "Draft investor updates, standups, and changelogs from what actually happened.",
  "Walk into calls prepared with everything the company knows about an account.",
  "Keep AI coding agents grounded — one MCP connection across Claude, Cursor, Codex, and ChatGPT.",
];

export default function UseCasesPage() {
  return (
    <>
      <TopNav />
      <main>
        <section>
          <div className="mx-auto max-w-3xl px-6 py-24">
            <span className="font-medium font-mono text-[13px] text-violet-600"># Use cases</span>
            <h1 className="mt-4 font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              What OpenCompany is good at.
            </h1>
            <ul className="mt-12 space-y-4 font-mono">
              {USE_CASES.map((useCase) => (
                <li key={useCase} className="flex gap-3 text-[15px] text-ink-muted leading-7">
                  <span aria-hidden="true" className="text-violet-600">
                    –
                  </span>
                  <span>{useCase}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
