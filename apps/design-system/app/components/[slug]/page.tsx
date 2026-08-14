import { notFound } from "next/navigation";
import { ComponentShowcase } from "@/components/component-showcase";
import { COMPONENT_SLUGS, COMPONENT_TITLES, type ComponentSlug } from "@/lib/site";

export function generateStaticParams() {
  return COMPONENT_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const title = COMPONENT_TITLES[slug as ComponentSlug];
  return { title: title ? `${title} — opencompany DS` : "opencompany DS" };
}

export default async function ComponentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!COMPONENT_SLUGS.includes(slug as ComponentSlug)) {
    notFound();
  }
  return <ComponentShowcase slug={slug as ComponentSlug} />;
}
