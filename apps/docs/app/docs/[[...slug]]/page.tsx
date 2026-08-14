import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenAPIPage } from "@/components/api-page";
import { openapi } from "@/lib/openapi";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type DocumentationPageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocumentationPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    return {};
  }

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

export default async function DocumentationPage({ params }: DocumentationPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const openApiProps = await openapi.preloadOpenAPIPage(page);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            OpenAPIPage: (props) => <OpenAPIPage {...openApiProps} {...props} />,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}
