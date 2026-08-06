import type { Metadata } from "next";
import { Faq } from "@/components/marketing/Faq";
import { Features } from "@/components/marketing/Features";
import { FinalCta } from "@/components/marketing/FinalCta";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ProductVideo } from "@/components/marketing/ProductVideo";
import { Proof } from "@/components/marketing/Proof";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { UseCases } from "@/components/marketing/UseCases";
import { WhatIsOpenCompany } from "@/components/marketing/WhatIsOpenCompany";

const title = "opencompany — The workspace where agents run your company";
const description =
  "opencompany is the workspace where agents and humans run your company — a living wiki, workflows, and sessions for every team, on the AI subscriptions you already pay for.";
const socialImage = {
  url: "/product-brain-overview-v2.png",
  width: 2448,
  height: 1852,
  alt: "opencompany workspace overview with connected sources, recent activity, and linked knowledge",
};

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "opencompany",
    title,
    description,
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [socialImage],
  },
};

export default function HomePage() {
  return (
    <>
      <TopNav />
      <main>
        <Hero />
        <ProductVideo />
        <WhatIsOpenCompany />
        <HowItWorks />
        <UseCases />
        <Proof />
        <Features />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
