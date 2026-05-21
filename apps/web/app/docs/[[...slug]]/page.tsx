import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DocsView from "@/components/DocsView";
import { source } from "@/lib/docs-source";

type DocsPageProps = {
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

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    return {};
  }

  const data = page.data as RenderableDocsData;
  const title = data.title ?? "Documentation";

  return {
    title: `${title} - opencompany docs`,
    description: data.description,
  };
}

export default async function DocsPage({ params }: DocsPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const data = page.data as RenderableDocsData;

  return (
    <DocsView
      title={data.title ?? "Documentation"}
      description={data.description}
      url={page.url}
      tree={source.getPageTree()}
      toc={data.toc ?? []}
      body={data.body}
    />
  );
}
