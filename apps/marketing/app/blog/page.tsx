import type { Metadata } from "next";
import { BlogIndex } from "@/components/marketing/BlogIndex";
import { BlogShell } from "@/components/marketing/BlogShell";
import { getAllPosts } from "@/lib/blog";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Blog — opencompany";
const description = "Guides, deep dives, and practical advice on running AI agents in production.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/blog",
    types: {
      "application/rss+xml": "/blog/rss.xml",
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/blog",
    siteName: "opencompany",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export default function BlogPage() {
  const posts = getAllPosts().map((post) => ({
    slug: post.slug,
    title: post.title,
    description: post.description,
    cluster: post.cluster,
    date: post.date,
    dateLabel: dateFormatter.format(new Date(`${post.date}T00:00:00Z`)),
  }));

  return (
    <BlogShell>
      <BlogIndex posts={posts} />
    </BlogShell>
  );
}
