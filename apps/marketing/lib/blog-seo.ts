import type { BlogPostMetadata } from "@/lib/blog";

export const SITE_URL = "https://www.opencompany.cloud";

export function articleJsonLd(post: BlogPostMetadata) {
  const url = `${SITE_URL}/blog/${post.slug}`;

  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    author: {
      "@type": "Person",
      name: post.author,
    },
    publisher: {
      "@type": "Organization",
      name: "opencompany",
      url: SITE_URL,
    },
    url,
    keywords: post.keywords,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
