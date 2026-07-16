import type { TableOfContentsItem } from "@/lib/table-of-contents";

export function TableOfContents({ headings }: { headings: TableOfContentsItem[] }) {
  const visibleHeadings =
    headings.length > 10 ? headings.filter((heading) => heading.level === 2) : headings;

  if (visibleHeadings.length === 0) return null;

  return (
    <nav aria-label="Table of contents">
      <p className="mb-3 font-medium font-mono text-[10px] text-ink-subtle uppercase tracking-[0.16em]">
        On this page
      </p>
      <ol className="space-y-1 border-border border-l">
        {visibleHeadings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              className={`-ml-px block border-transparent border-l py-1 text-[13px] leading-snug text-ink-subtle transition-colors hover:border-violet-500 hover:text-ink ${
                heading.level === 3 ? "pl-6" : "pl-3"
              }`}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
