import type { Metadata } from "next";
import { V2Footer } from "@/components/marketing/v2/V2Footer";
import { V2GetStarted } from "@/components/marketing/v2/V2GetStarted";
import { V2Hero } from "@/components/marketing/v2/V2Hero";
import { Manifesto, WorksWith } from "@/components/marketing/v2/V2Intro";
import { V2Nav } from "@/components/marketing/v2/V2Nav";
import { V2Platform } from "@/components/marketing/v2/V2Platform";
import { V2Principles } from "@/components/marketing/v2/V2Principles";
import { V2Solutions } from "@/components/marketing/v2/V2Solutions";
import { V2Teams } from "@/components/marketing/v2/V2Teams";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "opencompany — The workspace where agents run your company";
const description =
  "A landing page variant: opencompany keeps a living model of how your company works, so agents can run real work across your tools, files, and codebase.";

export const metadata: Metadata = {
  title,
  description,
  // Unlisted variant for review. Keeping it out of the index stops it competing
  // with `/` in search and keeps it off the sitemap by omission.
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/v2",
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

/**
 * Landing page variant built in the visual language of lightfield.app: a fixed
 * 28px display size, a 1350px twelve-column grid, 10px mono micro-labels with
 * numbered sections, near-monochrome surfaces, and product mockups cropped
 * against a panel edge instead of centered screenshots.
 *
 * It is a self-contained alternative to `/`, not a replacement — every component
 * lives under `components/marketing/v2/` so the live homepage is untouched and
 * the variant can be deleted in one directory if we don't take it forward.
 */
export default function LandingVariantPage() {
  return (
    <>
      <V2Nav />
      <main>
        <V2Hero />
        <WorksWith />
        <Manifesto />
        <V2Solutions />
        <V2Platform />
        <V2Principles />
        <V2Teams />
        <V2GetStarted />
      </main>
      <V2Footer />
    </>
  );
}
