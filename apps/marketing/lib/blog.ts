import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { cache } from "react";

const contentDirectory = path.join(process.cwd(), "content", "blog");
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type BlogPostMetadata = {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
  cluster: string;
  keywords: string[];
};

export type BlogPost = BlogPostMetadata & {
  content: string;
};

function assertString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Blog post ${filePath} has an invalid ${field}`);
  }

  return value;
}

function parsePost(filePath: string, cluster: string): BlogPost {
  const source = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(source);
  const date = assertString(data.date, "date", filePath);
  const parsedDate = new Date(`${date}T00:00:00Z`);

  if (
    !ISO_DATE_PATTERN.test(date) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Blog post ${filePath} has an invalid ISO date`);
  }

  if (
    !Array.isArray(data.keywords) ||
    data.keywords.some((keyword) => typeof keyword !== "string")
  ) {
    throw new Error(`Blog post ${filePath} has invalid keywords`);
  }

  return {
    slug: path.basename(filePath, ".mdx"),
    title: assertString(data.title, "title", filePath),
    description: assertString(data.description, "description", filePath),
    date,
    author: assertString(data.author, "author", filePath),
    cluster,
    keywords: data.keywords,
    content,
  };
}

const loadPosts = cache((): BlogPost[] => {
  const posts = fs
    .readdirSync(contentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const clusterDirectory = path.join(contentDirectory, entry.name);

      return fs
        .readdirSync(clusterDirectory)
        .filter((fileName) => fileName.endsWith(".mdx"))
        .map((fileName) => parsePost(path.join(clusterDirectory, fileName), entry.name));
    })
    .sort((first, second) => second.date.localeCompare(first.date));

  const slugs = new Set<string>();
  for (const post of posts) {
    if (slugs.has(post.slug)) {
      throw new Error(`Duplicate blog slug: ${post.slug}`);
    }
    slugs.add(post.slug);
  }

  return posts;
});

export function getAllPosts(): BlogPostMetadata[] {
  return loadPosts().map(({ slug, title, description, date, author, cluster, keywords }) => ({
    slug,
    title,
    description,
    date,
    author,
    cluster,
    keywords,
  }));
}

export function getPostBySlug(slug: string): BlogPost | null {
  return loadPosts().find((post) => post.slug === slug) ?? null;
}

export function getAllSlugs(): string[] {
  return loadPosts().map((post) => post.slug);
}
