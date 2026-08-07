import type { Node, Root } from "fumadocs-core/page-tree";
import type { TOCItemType } from "fumadocs-core/toc";
import { ArrowLeft, BookOpenText, ChevronRight, FileText, PanelLeft } from "lucide-react";
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
      <div className="px-2 pb-1 pt-4 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {node.name}
      </div>
    );
  }

  if (node.type === "folder") {
    return (
      <div className="space-y-px">
        <div className="px-2 pb-1 pt-4 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          {node.name}
        </div>
        {node.index && <TreeNode node={node.index} activeUrl={activeUrl} />}
        <div className="space-y-px">
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
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <FileText
        size={14}
        strokeWidth={1.75}
        className={active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}
      />
      <span className="truncate">{node.name}</span>
    </Link>
  );
}

function DocsSidebar({ tree, activeUrl }: { tree: Root; activeUrl: string }) {
  return (
    <aside className="relative hidden h-screen w-[232px] shrink-0 overflow-hidden bg-sidebar after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border md:block">
      <div className="flex h-full w-[232px] flex-col">
        <div className="flex items-center gap-2 px-3 pb-3 pt-3">
          <Link
            href="/"
            prefetch={false}
            aria-label="Back to opencompany"
            title="Back to opencompany"
            className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </Link>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink">opencompany docs</div>
            <div className="text-[11.5px] text-ink-subtle">Living product notes</div>
          </div>
        </div>
        <nav className="flex flex-col gap-px px-2 pt-1">
          {tree.children.map((node) => (
            <TreeNode key={nodeKey(node)} node={node} activeUrl={activeUrl} />
          ))}
        </nav>
      </div>
    </aside>
  );
}

function TopBar({ title }: { title: string }) {
  return (
    <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-border-subtle bg-canvas/85 px-5 backdrop-blur-md">
      <Link
        href="/"
        prefetch={false}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink md:hidden"
      >
        <ArrowLeft size={13} strokeWidth={1.75} />
        Goat
      </Link>
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-muted">
        <span className="hidden truncate md:inline">Documentation</span>
        <ChevronRight
          size={13}
          strokeWidth={1.75}
          className="hidden shrink-0 text-ink-subtle md:inline"
        />
        <span className="truncate font-medium text-ink">{title}</span>
      </div>
    </div>
  );
}

function TableOfContents({ toc }: { toc: TOCItemType[] }) {
  const items = toc.filter((item) => item.depth >= 2 && item.depth <= 3);

  if (items.length === 0) return null;

  return (
    <aside className="hidden h-full w-[232px] shrink-0 overflow-y-auto border-l border-border bg-canvas px-4 py-4 xl:block">
      <div className="sticky top-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            On this page
          </span>
          <BookOpenText size={13} strokeWidth={1.75} className="text-ink-subtle" />
        </div>
        <nav className="space-y-px">
          {items.map((item) => (
            <a
              key={item.url}
              href={item.url}
              className={`block truncate rounded-md py-1.5 pr-2 text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink ${
                item.depth === 3 ? "pl-5" : "pl-2"
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

export default function DocsView({ title, description, url, tree, toc, body: MDX }: DocsViewProps) {
  return (
    <main className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
      <DocsSidebar tree={tree} activeUrl={url} />
      <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar title={title} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-[760px] px-6 pb-16 pt-9 sm:px-10">
              <header className="border-b border-border-subtle pb-7">
                <h1 className="text-[34px] font-semibold leading-tight text-ink">{title}</h1>
                {description && (
                  <p className="mt-3 max-w-[620px] text-[14px] leading-6 text-ink-muted">
                    {description}
                  </p>
                )}
              </header>
              <div className="mt-8">
                <MDX components={getMDXComponents()} />
              </div>
            </article>
          </div>
          <TableOfContents toc={toc} />
        </div>
      </section>
    </main>
  );
}
