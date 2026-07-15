import { Faq } from "@/components/marketing/Faq";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ProductShot } from "@/components/marketing/ProductShot";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { WhySwitch } from "@/components/marketing/WhySwitch";

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
