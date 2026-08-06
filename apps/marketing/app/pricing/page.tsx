import type { Metadata } from "next";
import { Faq } from "@/components/marketing/Faq";
import { FinalCta } from "@/components/marketing/FinalCta";
import { Pricing } from "@/components/marketing/Pricing";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";

const title = "Pricing — opencompany";
const description =
  "Hobby is free for one seat. Pro is $20/seat/mo for teams. Usage beyond your included balance is billed at provider cost, with no markup.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/pricing",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/pricing",
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

const PRICING_FAQS = [
  {
    q: "What happens when I go over my included usage?",
    a: "You move to pay-as-you-go, billed at the exact provider cost. We don't add a markup, and we don't throttle you mid-task.",
  },
  {
    q: "What counts as included usage?",
    a: "A monthly balance for agent and model usage — $5 on Hobby, $20 per seat on Pro. It resets every calendar month and doesn't roll over.",
  },
  {
    q: "Can I top up if I'm running low?",
    a: "Pro workspaces can buy extra credit anytime, with optional auto-refill so a task never gets blocked mid-run.",
  },
  {
    q: "Can I add teammates on Hobby?",
    a: "Hobby is one seat on one workspace. Upgrade to Pro to invite teammates — up to 10 seats, billed centrally for the whole team.",
  },
];

export default function PricingPage() {
  return (
    <>
      <TopNav />
      <main>
        <Pricing />
        <Faq
          eyebrow="# Pricing FAQ"
          title="Billing, answered."
          description="The details behind the numbers."
          items={PRICING_FAQS}
        />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
