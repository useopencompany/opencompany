import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Braces,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link2,
  ListTree,
  LockKeyhole,
  MoreHorizontal,
  PanelRight,
  Search,
  Sparkles,
  Star,
} from "lucide-react";

type TreeItem = {
  name: string;
  active?: boolean;
  open?: boolean;
  icon?: LucideIcon;
  children?: TreeItem[];
};

const tree: TreeItem[] = [
  {
    name: "docs",
    open: true,
    children: [
      { name: "README.md", active: true, icon: FileText },
      { name: "getting-started.md", icon: FileText },
      { name: "architecture.md", icon: FileText },
      { name: "api-reference.md", icon: FileText },
    ],
  },
  {
    name: "packages",
    open: true,
    children: [
      { name: "web", icon: Folder },
      { name: "cms", icon: Folder },
      { name: "schema.ts", icon: FileCode2 },
    ],
  },
  {
    name: "config",
    open: false,
    children: [
      { name: "next.config.mjs", icon: Braces },
      { name: "tailwind.config.ts", icon: Braces },
    ],
  },
  { name: "CHANGELOG.md", icon: FileText },
  { name: "LICENSE", icon: FileText },
];

const commits = [
  {
    message: "Document local development setup",
    author: "Louis",
    age: "2h",
    sha: "8f4a21c",
  },
  {
    message: "Add content model overview",
    author: "Maya",
    age: "1d",
    sha: "6d91bb0",
  },
  {
    message: "Initial brain import",
    author: "Nora",
    age: "5d",
    sha: "2ac4ef8",
  },
];

const outline = [
  "Overview",
  "Quick start",
  "Repository map",
  "Editing content",
  "Deployment notes",
];

function IconButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-[#ececea] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {children}
    </button>
  );
}

function FileTreeItem({
  item,
  depth = 0,
}: {
  item: TreeItem;
  depth?: number;
}) {
  const Icon = item.icon ?? Folder;
  const hasChildren = !!item.children?.length;

  return (
    <div>
      <button
        className={`group flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          item.active
            ? "bg-[#e7e7e3] text-ink"
            : "text-ink/85 hover:bg-[#ececea] hover:text-ink"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {hasChildren ? (
          item.open ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          )
        ) : (
          <span className="h-[13px] w-[13px] shrink-0" />
        )}
        <Icon
          size={13}
          strokeWidth={1.75}
          className={item.active ? "shrink-0 text-ink" : "shrink-0 text-ink-muted"}
        />
        <span className="min-w-0 truncate tracking-[-0.005em]">{item.name}</span>
      </button>
      {hasChildren && item.open && (
        <div className="mt-px">
          {item.children?.map((child) => (
            <FileTreeItem key={child.name} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function GitSidebar() {
  return (
    <aside className="flex h-full w-[292px] shrink-0 flex-col border-r border-[#e6e6e3] bg-[#f4f4f1]">
      <div className="border-b border-[#e6e6e3] px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
            <BookOpenText size={14} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
                acta-website
              </span>
              <LockKeyhole size={11} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-ink-muted">
              <GitBranch size={11} strokeWidth={1.75} />
              <span>main</span>
              <span className="text-ink-subtle">8f4a21c</span>
            </div>
          </div>
          <IconButton label="Repository actions">
            <MoreHorizontal size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-[#e4e4e0] bg-white px-2.5 text-[12.5px] text-ink-muted shadow-[0_1px_0_rgba(0,0,0,0.02)] focus-within:border-[#d4d4cf] focus-within:ring-2 focus-within:ring-black/[0.03]">
          <Search size={13} strokeWidth={1.75} />
          <input
            placeholder="Search files"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] tracking-[-0.005em] text-ink outline-none placeholder:text-ink-subtle"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Explorer
          </span>
          <IconButton label="Collapse folders">
            <ListTree size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
        <div className="space-y-px">
          {tree.map((item) => (
            <FileTreeItem key={item.name} item={item} />
          ))}
        </div>

        <div className="mt-6 px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Recent commits
        </div>
        <div className="space-y-1">
          {commits.map((commit) => (
            <button
              key={commit.sha}
              className="group flex w-full gap-2 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-[#ececea] focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <GitCommitHorizontal
                size={13}
                strokeWidth={1.75}
                className="mt-[3px] shrink-0 text-ink-muted"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] tracking-[-0.005em] text-ink/90">
                  {commit.message}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-subtle">
                  <span>{commit.author}</span>
                  <span className="h-0.5 w-0.5 rounded-full bg-ink-subtle/70" />
                  <span>{commit.age}</span>
                  <span className="font-mono">{commit.sha}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function MarkdownArticle() {
  return (
    <article className="mx-auto w-full max-w-[760px] px-10 pb-16 pt-9">
      <div className="mb-5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#e8e8e4] bg-white px-2 py-1 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <FileText size={12} strokeWidth={1.75} />
          docs/README.md
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1">
          <Clock3 size={12} strokeWidth={1.75} />
          Updated 2 hours ago
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1">
          <GitCommitHorizontal size={12} strokeWidth={1.75} />
          8f4a21c
        </span>
      </div>

      <header className="border-b border-[#ececea] pb-7">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#ececea] text-ink">
            <BookOpenText size={17} strokeWidth={1.8} />
          </span>
          <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Project brain
          </span>
        </div>
        <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          Acta Website
        </h1>
        <p className="mt-3 max-w-[620px] text-[14px] leading-6 tracking-[-0.005em] text-ink-muted">
          A working map of the app, content model, local setup, and release notes for the website
          repository.
        </p>
      </header>

      <div className="mt-8 space-y-9 text-[14px] leading-[1.75] tracking-[-0.005em] text-ink/90">
        <section id="overview" className="scroll-mt-16">
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            Overview
          </h2>
          <p className="mt-3">
            This repository contains the public Next.js website, Payload CMS admin surface, shared
            schema definitions, and the scripts used to keep local development predictable. The brain
            is versioned with the codebase so product notes and implementation details move through
            review with the changes they describe.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              ["Framework", "Next.js 15"],
              ["CMS", "Payload 3.x"],
              ["Database", "PostgreSQL"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-[#e6e6e3] bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]"
              >
                <div className="text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
                  {label}
                </div>
                <div className="mt-1 text-[13px] font-medium text-ink">{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="quick-start" className="scroll-mt-16">
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            Quick start
          </h2>
          <ol className="mt-3 space-y-2 pl-5 marker:text-ink-subtle">
            <li>Install dependencies with the repo package manager.</li>
            <li>Start PostgreSQL through the local compose file.</li>
            <li>Run the Next.js dev server and open the CMS admin route.</li>
          </ol>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-[#e6e6e3] bg-[#111] px-4 py-3 text-[12px] leading-6 text-[#f5f5f0] shadow-[0_1px_2px_rgba(15,15,15,0.08)]">
            <code>{`bun install
docker compose up -d
bun run dev`}</code>
          </pre>
        </section>

        <section id="repository-map" className="scroll-mt-16">
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            Repository map
          </h2>
          <div className="mt-4 overflow-hidden rounded-lg border border-[#e6e6e3] bg-white">
            {[
              ["apps/web/app/", "Routes, page shells, and server-rendered entry points."],
              ["apps/web/components/", "Reusable UI surfaces and app chrome."],
              ["apps/web/lib/", "Auth, database, WorkOS, and app helpers."],
              ["drizzle/", "Checked-in database migrations."],
            ].map(([path, description], index) => (
              <div
                key={path}
                className={`grid grid-cols-1 gap-1 px-3 py-2.5 text-[13px] sm:grid-cols-[minmax(0,180px)_1fr] sm:gap-4 ${
                  index !== 3 ? "border-b border-[#f0f0ec]" : ""
                }`}
              >
                <code className="font-mono text-[12px] text-ink">{path}</code>
                <span className="text-ink/80">{description}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="editing-content" className="scroll-mt-16">
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            Editing content
          </h2>
          <p className="mt-3">
            Pages and posts are edited in the Payload admin panel. Schema changes should include a
            migration, fixture update, and a short note in this brain when the editor workflow changes
            for content authors.
          </p>
          <blockquote className="mt-4 border-l-2 border-[#c9c9c2] pl-4 text-[13.5px] leading-6 text-ink-muted">
            Keep editorial instructions close to the fields they describe. If a rule is easy to miss
            during review, add it to the relevant collection page.
          </blockquote>
        </section>

        <section id="deployment-notes" className="scroll-mt-16">
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            Deployment notes
          </h2>
          <ul className="mt-3 space-y-2 pl-5 marker:text-ink-subtle">
            <li>Run lint and integration tests before merging content model changes.</li>
            <li>Confirm generated migrations are included with schema updates.</li>
            <li>Verify cache invalidation for routes that depend on published CMS records.</li>
          </ul>
        </section>
      </div>
    </article>
  );
}

function OutlinePanel() {
  return (
    <aside className="hidden w-[232px] shrink-0 border-l border-[#e6e6e3] bg-canvas px-4 py-4 xl:block">
      <div className="sticky top-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Outline
          </span>
          <PanelRight size={13} strokeWidth={1.75} className="text-ink-subtle" />
        </div>
        <nav className="space-y-px">
          {outline.map((item, index) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replaceAll(" ", "-")}`}
              className={`block rounded-md px-2 py-1.5 text-[12.5px] transition-colors duration-150 ${
                index === 0
                  ? "bg-[#ececea] font-medium text-ink"
                  : "text-ink-muted hover:bg-[#ececea] hover:text-ink"
              }`}
            >
              {item}
            </a>
          ))}
        </nav>

        <div className="mt-6 rounded-lg border border-[#e6e6e3] bg-white p-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
            <History size={13} strokeWidth={1.75} className="text-ink-muted" />
            Page history
          </div>
          <div className="mt-2 space-y-2 text-[12px] text-ink-muted">
            <div className="flex items-center justify-between gap-2">
              <span>18 revisions</span>
              <span>main</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>4 contributors</span>
              <span>docs</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function TopBar() {
  return (
    <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-[#eaeae6] bg-canvas/85 px-5 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-muted">
        <span className="truncate">acta-website</span>
        <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <span className="truncate">docs</span>
        <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <span className="truncate font-medium text-ink">README.md</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <IconButton label="Copy link">
          <Link2 size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Star page">
          <Star size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="More actions">
          <MoreHorizontal size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}

function ComingSoonOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-canvas/70 backdrop-blur-[3px]">
      <div className="pointer-events-auto mx-6 max-w-[380px] rounded-xl border border-[#e6e6e3] bg-white/95 px-6 py-5 text-center shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
        <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#ececea] text-ink">
          <Sparkles size={16} strokeWidth={1.8} />
        </div>
        <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
          Coming soon
        </div>
        <h2 className="mt-1.5 text-[18px] font-semibold tracking-[-0.01em] text-ink">
          Brain
        </h2>
        <p className="mt-2 text-[13px] leading-5 text-ink-muted">
          A versioned knowledge base for your repo. Not part of the MVP — check back soon.
        </p>
      </div>
    </div>
  );
}

export default function BrainView() {
  return (
    <main className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-canvas">
      <GitSidebar />
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <MarkdownArticle />
          </div>
          <OutlinePanel />
        </div>
      </section>
      <ComingSoonOverlay />
    </main>
  );
}
