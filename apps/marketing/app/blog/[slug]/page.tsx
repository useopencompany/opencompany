import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { BlogShell } from "@/components/marketing/BlogShell";
import { TableOfContents } from "@/components/marketing/TableOfContents";
import { getAllSlugs, getPostBySlug } from "@/lib/blog";
import { articleJsonLd, breadcrumbJsonLd, SITE_URL, serializeJsonLd } from "@/lib/blog-seo";
import { extractTableOfContents } from "@/lib/table-of-contents";

type BlogPostPageProps = {
  params: Promise<{ slug: string }>;
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  const url = `/blog/${post.slug}`;

  return {
    title: post.title,
    description: post.description,
    keywords: post.keywords,
    authors: [{ name: post.author }],
    alternates: {
      canonical: url,
    },
    openGraph: {
      type: "article",
      locale: "en_US",
      url,
      siteName: "opencompany",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
      modifiedTime: post.date,
      authors: [post.author],
      images: [{ url: `${url}/opengraph-image`, width: 1200, height: 630, alt: post.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: [`${url}/opengraph-image`],
    },
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const headings = extractTableOfContents(post.content);

  return (
    <BlogShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(articleJsonLd(post)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            breadcrumbJsonLd([
              { name: "Home", url: SITE_URL },
              { name: "Blog", url: `${SITE_URL}/blog` },
              { name: post.title, url: `${SITE_URL}/blog/${post.slug}` },
            ]),
          ),
        }}
      />

      <div className="mx-auto max-w-5xl px-6 pt-12 pb-24 sm:pt-16">
        <Link
          href="/blog"
          className="font-mono text-[12px] text-ink-subtle transition-colors hover:text-violet-700"
        >
          ← Blog
        </Link>

        <header className="mt-10 max-w-3xl border-border border-b pb-10 sm:pb-12">
          <p className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.1em]">
            <time dateTime={post.date}>
              {dateFormatter.format(new Date(`${post.date}T00:00:00Z`))}
            </time>
            <span className="mx-2" aria-hidden="true">
              ·
            </span>
            {post.author}
          </p>
          <h1 className="mt-5 font-medium text-4xl text-ink leading-[1.08] tracking-tight sm:text-5xl">
            {post.title}
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7 sm:text-base">
            {post.description}
          </p>
        </header>

        {headings.length > 0 ? (
          <details className="mt-8 border border-border p-4 lg:hidden">
            <summary className="cursor-pointer font-medium font-mono text-[11px] text-ink uppercase tracking-[0.12em]">
              On this page
            </summary>
            <div className="mt-4">
              <TableOfContents headings={headings} />
            </div>
          </details>
        ) : null}

        <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-16">
          <article className="blog-prose min-w-0 max-w-3xl">
            <MDXRemote
              source={post.content}
              options={{
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [rehypeSlug],
                },
              }}
            />
          </article>
          {headings.length > 0 ? (
            <aside className="hidden lg:block">
              <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto">
                <TableOfContents headings={headings} />
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </BlogShell>
  );
}
