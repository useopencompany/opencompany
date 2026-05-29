import type { Node, Root } from "fumadocs-core/page-tree";
import type { TOCItemType } from "fumadocs-core/toc";
import { ArrowUpRight, ChevronRight, FileText, Hash } from "lucide-react";
import type { MDXContent } from "mdx/types";
import Link from "next/link";
import { getMDXComponents } from "@/mdx-components";

type DocsViewProps = {
  title: string;
  description?: string | undefined;
  url: string;
  tree: Root;
  toc: TOCItemType[];
  body: MDXContent;
};

function nodeKey(node: Node) {
  if (node.type === "page") return node.$id ?? node.url;
  return node.$id ?? String(node.name);
}

function TreeNode({ node, activeUrl }: { node: Node; activeUrl: string }) {
  if (node.type === "separator") {
    return (
      <div className="px-3 pb-1 pt-5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {node.name}
      </div>
    );
  }

  if (node.type === "folder") {
    return (
      <div>
        <div className="px-3 pb-1 pt-5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {node.name}
        </div>
        {node.index && <TreeNode node={node.index} activeUrl={activeUrl} />}
        <div>
          {node.children.map((child) => (
            <TreeNode key={nodeKey(child)} node={child} activeUrl={activeUrl} />
          ))}
        </div>
      </div>
    );
  }

  const active = node.url === activeUrl;

  return (
    <Link
      href={node.url}
      className={`group flex w-full items-center gap-2.5 rounded-md px-3 py-[6px] text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-ink text-canvas" : "text-ink/70 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <FileText
        size={13}
        strokeWidth={1.75}
        className={active ? "text-canvas/70" : "text-ink/35 group-hover:text-ink/60"}
      />
      <span className="truncate tracking-[-0.005em]">{node.name}</span>
    </Link>
  );
}

function DocsSidebar({ tree, activeUrl }: { tree: Root; activeUrl: string }) {
  return (
    <aside className="relative hidden h-screen w-[240px] shrink-0 overflow-hidden bg-sidebar after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border md:block">
      <div className="flex h-full w-[240px] flex-col">
        {/* Sidebar header */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <Link
            href="/"
            prefetch={false}
            className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold tracking-[-0.02em] text-ink transition-opacity hover:opacity-70"
          >
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-ink text-[10px] font-bold text-canvas"
            >
              oc
            </span>
            opencompany
          </Link>
          <span className="ml-auto shrink-0 rounded-[4px] bg-surface-active px-1.5 py-0.5 text-[10px] font-medium tracking-tight text-ink-muted">
            docs
          </span>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col px-2 pt-2">
          {tree.children.map((node) => (
            <TreeNode key={nodeKey(node)} node={node} activeUrl={activeUrl} />
          ))}
        </nav>

        {/* Footer */}
        <div className="mt-auto border-t border-border px-4 py-3">
          <Link
            href="/"
            prefetch={false}
            className="flex items-center gap-1.5 text-[12px] text-ink-subtle transition-colors hover:text-ink"
          >
            <span>← Back to app</span>
          </Link>
        </div>
      </div>
    </aside>
  );
}

function DocsTopBar({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-canvas/95 backdrop-blur-md">
      <div className="flex h-[52px] items-center gap-3 px-5">
        {/* Mobile: logo + hamburger hint */}
        <Link
          href="/"
          prefetch={false}
          className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.02em] text-ink md:hidden"
        >
          <span
            aria-hidden
            className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-ink text-[9.5px] font-bold text-canvas"
          >
            oc
          </span>
          Docs
        </Link>

        {/* Desktop breadcrumb */}
        <nav className="hidden items-center gap-1.5 md:flex" aria-label="Breadcrumb">
          <Link
            href="/docs"
            prefetch={false}
            className="text-[13px] text-ink-muted transition-colors hover:text-ink"
          >
            Docs
          </Link>
          <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
          <span className="truncate text-[13px] font-medium text-ink">{title}</span>
        </nav>

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href="/changelog"
            prefetch={false}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink"
          >
            Changelog
            <ArrowUpRight size={11} strokeWidth={2} className="opacity-60" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function TableOfContents({ toc }: { toc: TOCItemType[] }) {
  const items = toc.filter((item) => item.depth >= 2 && item.depth <= 3);

  if (items.length === 0) return null;

  return (
    <aside className="hidden h-full w-[220px] shrink-0 xl:block">
      <div className="sticky top-[52px] overflow-y-auto px-5 py-6">
        <div className="mb-3 flex items-center gap-1.5">
          <Hash size={11} strokeWidth={2.5} className="text-ink-subtle" />
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            On this page
          </span>
        </div>
        <nav className="space-y-0.5">
          {items.map((item) => (
            <a
              key={item.url}
              href={item.url}
              className={`block rounded py-1 text-[12.5px] text-ink-muted transition-colors duration-150 hover:text-ink ${
                item.depth === 3 ? "pl-3.5" : "pl-0"
              }`}
            >
              {item.title}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function DocsFooterNav({ tree, activeUrl }: { tree: Root; activeUrl: string }) {
  // Flatten all page nodes
  const pages: Array<{ url: string; name: string }> = [];
  function collect(nodes: Node[]) {
    for (const n of nodes) {
      if (n.type === "page") pages.push({ url: n.url, name: String(n.name) });
      else if (n.type === "folder") {
        if (n.index) pages.push({ url: n.index.url, name: String(n.index.name) });
        collect(n.children);
      }
    }
  }
  collect(tree.children);

  const idx = pages.findIndex((p) => p.url === activeUrl);
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx >= 0 && idx < pages.length - 1 ? pages[idx + 1] : null;

  if (!prev && !next) return null;

  return (
    <nav
      className="mt-12 flex items-center justify-between border-t border-border-subtle pt-6"
      aria-label="Page navigation"
    >
      <div className="min-w-0 flex-1">
        {prev && (
          <Link
            href={prev.url}
            className="group inline-flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-raised"
          >
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle transition-colors group-hover:text-ink-muted">
              ← Previous
            </span>
            <span className="text-[13px] font-medium tracking-[-0.005em] text-ink">
              {prev.name}
            </span>
          </Link>
        )}
      </div>
      <div className="min-w-0 flex-1 text-right">
        {next && (
          <Link
            href={next.url}
            className="group inline-flex flex-col items-end gap-0.5 rounded-lg border border-border px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-raised"
          >
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle transition-colors group-hover:text-ink-muted">
              Next →
            </span>
            <span className="text-[13px] font-medium tracking-[-0.005em] text-ink">
              {next.name}
            </span>
          </Link>
        )}
      </div>
    </nav>
  );
}

export default function DocsView({ title, description, url, tree, toc, body: MDX }: DocsViewProps) {
  return (
    <div className="flex min-h-screen w-screen bg-canvas">
      <DocsSidebar tree={tree} activeUrl={url} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DocsTopBar title={title} />
        <div className="flex min-h-0 flex-1">
          {/* Main content */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-[720px] px-6 pb-20 pt-10 sm:px-10 lg:px-12">
              {/* Page header */}
              <header className="mb-8">
                <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink sm:text-[36px]">
                  {title}
                </h1>
                {description && (
                  <p className="mt-3 text-[15px] leading-7 tracking-[-0.005em] text-ink-muted">
                    {description}
                  </p>
                )}
              </header>

              {/* Divider */}
              <div className="mb-8 h-px w-full bg-border" />

              {/* MDX content */}
              <div className="docs-prose">
                <MDX components={getMDXComponents()} />
              </div>

              {/* Footer nav */}
              <DocsFooterNav tree={tree} activeUrl={url} />
            </article>
          </main>

          {/* TOC */}
          <TableOfContents toc={toc} />
        </div>
      </div>
    </div>
  );
}
