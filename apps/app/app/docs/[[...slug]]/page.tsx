import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import GoatDocsView from "@/components/GoatDocsView";
import { source } from "@/lib/docs-source";

type GoatDocsPageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

type RenderableDocsData = {
  title?: string;
  description?: string;
  toc?: TOCItemType[];
  body: MDXContent;
};

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: GoatDocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    return {};
  }

  const data = page.data as RenderableDocsData;
  const title = data.title ?? "Documentation";

  return {
    title: `${title} - Goat docs`,
    description: data.description,
  };
}

export default async function GoatDocsPage({ params }: GoatDocsPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const data = page.data as RenderableDocsData;

  return (
    <GoatDocsView
      title={data.title ?? "Documentation"}
      description={data.description}
      url={page.url}
      tree={source.getPageTree()}
      toc={data.toc ?? []}
      body={data.body}
    />
  );
}
