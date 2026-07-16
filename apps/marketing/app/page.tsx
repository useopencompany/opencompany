import type { Metadata } from "next";
import { Faq } from "@/components/marketing/Faq";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ProductShot } from "@/components/marketing/ProductShot";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { WhySwitch } from "@/components/marketing/WhySwitch";

const title = "opencompany — A shared company brain for AI agents";
const description =
  "Give every AI agent the context of your company. OpenCompany turns GitHub, Gmail, Slack, Linear, meetings, and Drive into a shared, living brain.";
const socialImage = {
  url: "/product-brain-overview-v2.png",
  width: 2448,
  height: 1852,
  alt: "OpenCompany brain overview with connected sources, recent activity, and linked knowledge",
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
        <ProductShot />
        <HowItWorks />
        <WhySwitch />
        <Faq />
      </main>
      <SiteFooter />
    </>
  );
}
