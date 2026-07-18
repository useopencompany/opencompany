"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type BlogIndexPost = {
  slug: string;
  title: string;
  description: string;
  cluster: string;
  date: string;
  dateLabel: string;
};

const ALL = "all";

function toTitleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

// Deterministic decorative panel per post. We don't ship cover images, so each
// card gets an abstract, violet-tinted motif picked from the slug — keeps the
// grid visually anchored while staying on-brand (mono, squared, minimal).
function BlogCardVisual({ seed }: { seed: string }) {
  const hash = useMemo(() => {
    let value = 0;
    for (let index = 0; index < seed.length; index += 1) {
      value = (value * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return value;
  }, [seed]);

  const variant = hash % 3;

  return (
    <div className="relative aspect-[16/10] overflow-hidden border border-border bg-muted">
      <svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full text-violet-600/70"
        viewBox="0 0 160 100"
        preserveAspectRatio="xMidYMid slice"
      >
        <title>Decorative artwork</title>
        {variant === 0 ? (
          <g fill="none" stroke="currentColor" strokeWidth="0.6">
            {Array.from({ length: 9 }).map((_, row) => (
              <path
                key={row}
                d={`M0 ${12 + row * 9} H160`}
                opacity={0.35}
                strokeDasharray={row % 2 === 0 ? "1 3" : undefined}
              />
            ))}
            {[40, 80, 120].map((cx, index) => (
              <circle
                key={cx}
                cx={cx}
                cy={12 + ((hash >> index) % 8) * 9}
                r="3.4"
                fill="currentColor"
                opacity={0.85}
              />
            ))}
          </g>
        ) : null}
        {variant === 1 ? (
          <g fill="none" stroke="currentColor" strokeWidth="0.7">
            {[10, 22, 34, 46, 58].map((radius, index) => (
              <circle
                key={radius}
                cx={54 + (hash % 12)}
                cy="50"
                r={radius}
                opacity={0.2 + index * 0.14}
              />
            ))}
            <circle cx={54 + (hash % 12)} cy="50" r="2.6" fill="currentColor" />
          </g>
        ) : null}
        {variant === 2 ? (
          <g stroke="currentColor" strokeWidth="0.6">
            {Array.from({ length: 12 }).map((_, column) =>
              Array.from({ length: 7 }).map((__, row) => (
                <circle
                  key={`${column}-${row}`}
                  cx={8 + column * 13}
                  cy={10 + row * 13}
                  r="1"
                  fill="currentColor"
                  stroke="none"
                  opacity={((hash >> (column % 8)) & 1) === row % 2 ? 0.8 : 0.18}
                />
              )),
            )}
          </g>
        ) : null}
      </svg>
    </div>
  );
}

export function BlogIndex({ posts }: { posts: BlogIndexPost[] }) {
  const [activeCategory, setActiveCategory] = useState<string>(ALL);
  const [query, setQuery] = useState<string>("");

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const post of posts) {
      if (!seen.includes(post.cluster)) {
        seen.push(post.cluster);
      }
    }
    return [ALL, ...seen];
  }, [posts]);

  const visiblePosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return posts.filter((post) => {
      const matchesCategory = activeCategory === ALL || post.cluster === activeCategory;
      if (!matchesCategory) {
        return false;
      }
      if (normalizedQuery.length === 0) {
        return true;
      }
      return (
        post.title.toLowerCase().includes(normalizedQuery) ||
        post.description.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [posts, activeCategory, query]);

  return (
    <section className="mx-auto max-w-5xl px-6 pt-16 pb-24 sm:pt-20">
      <h1 className="font-medium text-4xl text-ink tracking-tight sm:text-5xl">Blog</h1>

      <div className="mt-8 flex flex-col gap-5 border-border border-b pb-5 sm:flex-row sm:items-center sm:justify-between">
        <nav
          aria-label="Filter posts by category"
          className="-mx-1 flex items-center gap-1 overflow-x-auto"
        >
          {categories.map((category) => {
            const isActive = category === activeCategory;
            return (
              <button
                key={category}
                type="button"
                onClick={() => setActiveCategory(category)}
                aria-pressed={isActive}
                className={`shrink-0 rounded-none px-3 py-1.5 font-mono text-[13px] tracking-tight transition-colors ${
                  isActive ? "text-ink" : "text-ink-subtle hover:text-ink"
                }`}
              >
                {category === ALL ? "All" : toTitleCase(category)}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          <label className="relative flex items-center">
            <span className="sr-only">Search posts</span>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-3 size-4 text-ink-subtle"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              className="w-full rounded-none border border-border bg-transparent py-1.5 pr-3 pl-9 font-mono text-[13px] text-ink placeholder:text-ink-subtle focus:border-violet-500/50 focus:outline-none sm:w-56"
            />
          </label>
          <a
            href="/blog/rss.xml"
            aria-label="RSS feed"
            className="text-ink-subtle transition-colors hover:text-violet-700"
          >
            <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="6.18" cy="17.82" r="2.18" />
              <path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83C19.56 11.4 12.6 4.44 4 4.44Z" />
              <path d="M4 10.1v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9Z" />
            </svg>
          </a>
        </div>
      </div>

      {visiblePosts.length === 0 ? (
        <p className="mt-16 text-center text-[15px] text-ink-muted">
          No posts found. Try a different search or category.
        </p>
      ) : (
        <div className="mt-10 grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {visiblePosts.map((post) => (
            <article key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="group block">
                <BlogCardVisual seed={post.slug} />
                <h2 className="mt-5 font-medium text-xl text-ink tracking-tight transition-colors group-hover:text-violet-700">
                  {post.title}
                </h2>
                <p className="mt-2.5 text-[14px] text-ink-muted leading-6">{post.description}</p>
                <p className="mt-4 font-mono text-[11px] text-ink-subtle uppercase tracking-[0.1em]">
                  {toTitleCase(post.cluster)}
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  <time dateTime={post.date}>{post.dateLabel}</time>
                </p>
              </Link>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
