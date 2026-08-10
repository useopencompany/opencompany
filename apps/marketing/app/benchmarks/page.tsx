import type { Metadata } from "next";
import { BenchmarksHero } from "@/components/marketing/benchmarks/BenchmarksHero";
import { CapabilityTables } from "@/components/marketing/benchmarks/CapabilityTables";
import { Changelog } from "@/components/marketing/benchmarks/Changelog";
import { CostAndSpeed } from "@/components/marketing/benchmarks/CostAndSpeed";
import { Methodology } from "@/components/marketing/benchmarks/Methodology";
import { ModelCards } from "@/components/marketing/benchmarks/ModelCards";
import { TldrTable } from "@/components/marketing/benchmarks/TldrTable";
import { TrustMap } from "@/components/marketing/benchmarks/TrustMap";
import { EmailCaptureForm } from "@/components/marketing/EmailCaptureForm";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Benchmarks — which AI models actually work | opencompany";
const description =
  "Cross-verified against the benchmarks the community still trusts. Which models are best for coding, knowledge work, and computer use — updated weekly, with our judgment on which numbers to believe.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/benchmarks",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/benchmarks",
    siteName: "opencompany",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
};

export default function BenchmarksPage() {
  return (
    <>
      <TopNav />
      <main>
        <BenchmarksHero />
        <TldrTable />
        <TrustMap />
        <CapabilityTables />
        <CostAndSpeed />
        <ModelCards />
        <Changelog />
        <Methodology />
        <section className="border-border border-t">
          <div className="mx-auto max-w-2xl px-6 py-24 text-center">
            <h2 className="text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
              Get the update when a ranking flips.
            </h2>
            <p className="mt-4 font-medium text-[15px] text-ink-subtle leading-7 opacity-80">
              Model launches are a monthly drumbeat. We'll email you when our verdicts change.
            </p>
            <div className="mt-8 flex justify-center">
              <EmailCaptureForm source="benchmarks" ctaLabel="Get updates" />
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
