import type { Metadata } from "next";
import Link from "next/link";
import { BlogShell } from "@/components/marketing/BlogShell";
import { getAllPosts } from "@/lib/blog";

const title = "Blog — opencompany";
const description = "Guides, deep dives, and practical advice on running AI agents in production.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/blog",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/blog",
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

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <BlogShell>
      <section className="mx-auto max-w-3xl px-6 pt-20 pb-8 sm:pt-28">
        <p className="mb-4 font-medium font-mono text-[11px] text-violet-600 uppercase tracking-[0.16em]">
          #blog
        </p>
        <h1 className="font-medium text-4xl text-ink tracking-tight sm:text-5xl">Blog</h1>
        <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7">{description}</p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24">
        <div className="divide-y divide-border border-border border-t">
          {posts.map((post) => (
            <article key={post.slug} className="py-9 sm:py-11">
              <Link href={`/blog/${post.slug}`} className="group block">
                <p className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.1em]">
                  <time dateTime={post.date}>
                    {dateFormatter.format(new Date(`${post.date}T00:00:00Z`))}
                  </time>
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  {post.cluster.replaceAll("-", " ")}
                </p>
                <h2 className="mt-3 font-medium text-2xl text-ink tracking-tight transition-colors group-hover:text-violet-700 sm:text-3xl">
                  {post.title}
                </h2>
                <p className="mt-3 text-[14px] text-ink-muted leading-6 sm:text-[15px] sm:leading-7">
                  {post.description}
                </p>
                <span className="mt-5 inline-block font-medium font-mono text-[12px] text-violet-700">
                  Read article →
                </span>
              </Link>
            </article>
          ))}
        </div>
      </section>
    </BlogShell>
  );
}
